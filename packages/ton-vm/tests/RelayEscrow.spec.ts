import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, toNano, fromNano } from '@ton/core';
import { RelayEscrow } from '../wrappers/RelayEscrow';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { JettonMinter, jettonContentToInternal } from "@ton-community/assets-sdk";
import { beginCell, Dictionary } from "@ton/core";
import { sha256_sync } from "@ton/crypto";

/**
 * Convert internal onchain content to Cell format
 * @param internalContent Record containing content key-value pairs
 * @returns Cell containing encoded content
 */
export function convertInternalContentToCell(internalContent: Record<string, string | number | undefined>): Cell {
    const contentDictionary = Dictionary.empty(Dictionary.Keys.Buffer(32), Dictionary.Values.Cell());
    
    for (const key in internalContent) {
        if ((internalContent as any)[key] === undefined) {
            continue;
        }
        
        const contentCell = beginCell();
        if (key === 'image_data') {
            const imageChunks = Dictionary.empty(Dictionary.Keys.Uint(32), Dictionary.Values.Cell());
            const imageBuffer = Buffer.from((internalContent as any)[key], 'base64');
            
            // Split image data into 127-byte chunks
            for (let chunkIndex = 0; chunkIndex * 127 < imageBuffer.length; chunkIndex++) {
                imageChunks.set(
                    chunkIndex, 
                    beginCell()
                        .storeBuffer(imageBuffer.subarray(chunkIndex * 127, (chunkIndex + 1) * 127))
                        .endCell()
                );
            }
            contentCell.storeUint(1, 8).storeDict(imageChunks).endCell();
        } else {
            contentCell.storeUint(0, 8).storeStringTail((internalContent as any)[key].toString());
        }
        contentDictionary.set(sha256_sync(key), contentCell.endCell());
    }
    
    return beginCell().storeUint(0, 8).storeDict(contentDictionary).endCell();
}

describe('RelayEscrow Contract Tests', () => {
    let contractCode: Cell;
    let blockchain: Blockchain;
    let deployerWallet: SandboxContract<TreasuryContract>;
    let escrowContract: SandboxContract<RelayEscrow>;
    let initialAllocatorWallet: SandboxContract<TreasuryContract>;
    let newAllocatorWallet: SandboxContract<TreasuryContract>;
    let usdcMinterContract: SandboxContract<JettonMinter>;
    let depositorWallet: SandboxContract<TreasuryContract>;

    beforeAll(async () => {
        contractCode = await compile('RelayEscrow');
    });

    beforeEach(async () => {
        // Initialize blockchain and accounts
        blockchain = await Blockchain.create();
        deployerWallet = await blockchain.treasury('deployer');
        initialAllocatorWallet = await blockchain.treasury('initial-allocator');
        newAllocatorWallet = await blockchain.treasury('new-allocator');
        depositorWallet = await blockchain.treasury('depositor');

        // Deploy RelayEscrow contract
        escrowContract = blockchain.openContract(
            RelayEscrow.createFromConfig(
                {
                    owner: deployerWallet.address,
                    allocator: initialAllocatorWallet.address,
                },
                contractCode
            )
        );

        // Deploy USDC Jetton contract
        usdcMinterContract = blockchain.openContract(
            JettonMinter.createFromConfig(
                {
                    admin: deployerWallet.address,
                    content: convertInternalContentToCell(
                        jettonContentToInternal({
                            name: "Circle Usdc",
                            decimals: 6,
                            description: "Circle USDC",
                            symbol: "USDC",
                        })
                    )
                },
                JettonMinter.code
            )
        );

        // Deploy escrow contract
        const escrowDeployResult = await escrowContract.sendDeploy(deployerWallet.getSender(), toNano('0.05'));
        expect(escrowDeployResult.transactions).toHaveTransaction({
            from: deployerWallet.address,
            to: escrowContract.address,
            deploy: true,
            success: true,
        });

        // Mint initial USDC to depositor
        const usdcMintResult = await usdcMinterContract.sendMint(
            deployerWallet.getSender(),
            depositorWallet.address, 
            BigInt(10000 * 1e6),
            {
                value: toNano('0.05')
            }
        );
        expect(usdcMintResult.transactions).toHaveTransaction({
            from: deployerWallet.address,
            to: usdcMinterContract.address,
            deploy: true,
            success: true,
        });
    });

    it('should successfully update allocator address', async () => {
        const initialAllocator = await escrowContract.getAllocator();
        const updateResult = await escrowContract.sendSetAllocator(deployerWallet.getSender(), {
            allocator: newAllocatorWallet.address,
            value: toNano('0.05'),
        });

        expect(updateResult.transactions).toHaveTransaction({
            from: deployerWallet.address,
            to: escrowContract.address,
            success: true,
        });

        const updatedAllocator = await escrowContract.getAllocator();
        expect(updatedAllocator.toString()).toBe(newAllocatorWallet.address.toString());
        expect(initialAllocator.toString()).toBe(initialAllocatorWallet.address.toString());
    });

    it("should successfully deposit TON", async() => {
        const depositAmount = toNano('5');
        const initialBalance = await escrowContract.getCurrentBlance();
        
        const depositResult = await escrowContract.sendDeposit(depositorWallet.getSender(), {
            value: depositAmount
        });
        
        const finalBalance = await escrowContract.getCurrentBlance();
        const actualDeposit = BigInt(finalBalance - initialBalance);
        
        expect(depositResult.transactions).toHaveTransaction({
            from: depositorWallet.address,
            to: escrowContract.address,
            success: true,
        });
        expect((depositAmount - actualDeposit) < toNano('0.0005')).toBe(true);
    })

    it("should successfully deposit Jetton tokens", async() => {
        const depositAmount = BigInt(10 * 1e6);
        const escrowJettonWallet = await usdcMinterContract.getWallet(escrowContract.address);
        const initialBalance = await escrowJettonWallet.getData().then(c => c.balance).catch(c => 0n);
        
        const depositorJettonWallet = await usdcMinterContract.getWallet(depositorWallet.address);
        await depositorJettonWallet.send(
            depositorWallet.getSender(),
            escrowContract.address,
            depositAmount,
            {
                value: toNano('0.05')
            }
        );
        
        const finalBalance = await escrowJettonWallet.getData().then(c => c.balance).catch(c => 0n);
        const actualDeposit = BigInt(finalBalance - initialBalance);
        console.log('actualDeposit', {
            depositAmount,
            actualDeposit
        })
        
        expect((depositAmount - actualDeposit) === 0n).toBe(true);
    })
});