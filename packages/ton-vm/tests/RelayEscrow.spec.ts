import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, toNano, Address } from '@ton/core';
import { RelayEscrow, CurrencyType } from '../wrappers/RelayEscrow';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { JettonMinter, jettonContentToInternal } from "@ton-community/assets-sdk";
import { beginCell, Dictionary } from "@ton/core";
import { sha256_sync, KeyPair, keyPairFromSeed, getSecureRandomBytes } from "@ton/crypto";

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
    let usdcMinterContract: SandboxContract<JettonMinter>;
    let depositorWallet: SandboxContract<TreasuryContract>;
    let recipientWallet: SandboxContract<TreasuryContract>;
    let allocatorKey: KeyPair;

    beforeAll(async () => {
        contractCode = await compile('RelayEscrow');
    });

    beforeEach(async () => {
        // Initialize blockchain and accounts
        blockchain = await Blockchain.create();
        deployerWallet = await blockchain.treasury('deployer');
        depositorWallet = await blockchain.treasury('depositor');
        recipientWallet = await blockchain.treasury('recipient');

        const secretKey = await getSecureRandomBytes(32);
        allocatorKey = keyPairFromSeed(secretKey);

        // Deploy RelayEscrow contract
        escrowContract = blockchain.openContract(
            RelayEscrow.createFromConfig(
                {
                    owner: deployerWallet.address,
                    allocator: Address.parse(`0:${allocatorKey.publicKey.toString('hex')}`),
                    nonce: 0n
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

        // Inital
        await escrowContract.sendDeposit(depositorWallet.getSender(), {
            value:  toNano('100')
        });
      
        const depositorJettonWallet = await usdcMinterContract.getWallet(depositorWallet.address);
        await depositorJettonWallet.send(
            depositorWallet.getSender(),
            escrowContract.address,
            BigInt(1000 * 1e6),
            {
                value: toNano('0.05')
            }
        );
        
    });

    it('should successfully update allocator address', async () => {
        const initialAllocator = await escrowContract.getAllocator();
        const inewAllocatorWallet = await blockchain.treasury('new-allocator');
        const updateResult = await escrowContract.sendSetAllocator(deployerWallet.getSender(), {
            allocator: inewAllocatorWallet.address,
            value: toNano('0.05'),
        });

        expect(updateResult.transactions).toHaveTransaction({
            from: deployerWallet.address,
            to: escrowContract.address,
            success: true,
        });

        const updatedAllocator = await escrowContract.getAllocator();
        expect(updatedAllocator.toString()).toBe(inewAllocatorWallet.address.toString());
        expect(initialAllocator.toString()).toBe(Address.parse(`0:${allocatorKey.publicKey.toString('hex')}`).toString());
    });

    it("should reject allocator update from non-owner", async () => {
        const initialAllocator = await escrowContract.getAllocator();
        const newAllocatorWallet = await blockchain.treasury('new-allocator');
        
        // Try to update allocator from non-owner account (using depositor)
        const updateResult = await escrowContract.sendSetAllocator(depositorWallet.getSender(), {
            allocator: newAllocatorWallet.address,
            value: toNano('0.05'),
        });
    
        // Verify transaction failed
        expect(updateResult.transactions).toHaveTransaction({
            from: depositorWallet.address,
            to: escrowContract.address,
            success: false,
            exitCode: 101  // Not owner error code
        });
    
        // Verify allocator remains unchanged
        const currentAllocator = await escrowContract.getAllocator();
        expect(currentAllocator.toString()).toBe(initialAllocator.toString());
    });

    it("should successfully deposit TON", async() => {
        const depositAmount = toNano('100');
        const initialBalance = await escrowContract.getCurrentBalance();
        
        const depositResult = await escrowContract.sendDeposit(depositorWallet.getSender(), {
            value: depositAmount
        });
        
        const finalBalance = await escrowContract.getCurrentBalance();
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
        
        expect((depositAmount - actualDeposit) === 0n).toBe(true);
    })

    it("should reject expired transfer request", async () => {
        const transferAmount = toNano('1');
        
        // Create transfer request with very short expiry
        const request = await escrowContract.createTransferRequest(
            blockchain.provider(escrowContract.address),
            allocatorKey.secretKey,
            {
                currencyType: CurrencyType.TON,
                to: recipientWallet.address,
                amount: transferAmount,
                expiryInSeconds: 1  // 1 second expiry
            }
        );

        await new Promise((resolve) => {
            setTimeout(() => {
                resolve(1)
            }, 2000)
        });
    
        // Try to execute expired transfer
        const transferResult = await escrowContract.sendTransfers(
            depositorWallet.getSender(),
            {
                requests: [request],
                value: toNano('0.5')
            }
        );
    
        // Verify transaction failed
        expect(transferResult.transactions).toHaveTransaction({
            from: depositorWallet.address,
            to: escrowContract.address,
            success: false,
            exitCode: 103  // Expired request error code
        });
    });

    it("should transfer TON with allocator signature", async () => {
        const transferAmount = toNano('1');
        const gasReserve = toNano('0.05');
        const recipientInitialBalance = await recipientWallet.getBalance();

        // Create transfer request with allocator signature
        const request = await escrowContract.createTransferRequest(
            blockchain.provider(escrowContract.address),
            allocatorKey.secretKey,
            {
                currencyType: CurrencyType.TON,
                to: recipientWallet.address,
                amount: transferAmount,
                expiryInSeconds: 3600
            }
        );

        // Send transfer
        const transferResult = await escrowContract.sendTransfers(
            depositorWallet.getSender(),  // anyone can send the transaction
            {
                requests: [request],
                value: toNano('0.5')
            }
        );

        // Verify transaction success
        expect(transferResult.transactions).toHaveTransaction({
            from: escrowContract.address,
            to: recipientWallet.address,
            success: true,
            value: transferAmount
        });

        // Verify balances
        const recipientFinalBalance = await recipientWallet.getBalance();
        const actualTransferred = recipientFinalBalance - recipientInitialBalance;
        expect(actualTransferred).toBeGreaterThan(transferAmount - gasReserve);
        expect(actualTransferred).toBeLessThanOrEqual(transferAmount);
    });

    it("should transfer Jetton with allocator signature", async () => {
        const transferAmount = BigInt(100 * 1e6);  // 100 USDC
        const escrowJettonWallet = await usdcMinterContract.getWallet(escrowContract.address);
        const recipientJettonWallet = await usdcMinterContract.getWallet(recipientWallet.address);

        const initialBalance = await escrowJettonWallet.getData().then(c => c.balance);
        const recipientInitialBalance = await recipientJettonWallet.getData().then(c => c.balance).catch(() => 0n);

        // Create transfer request with allocator signature
        const request = await escrowContract.createTransferRequest(
            blockchain.provider(escrowContract.address),
            allocatorKey.secretKey,
            {
                currencyType: CurrencyType.JETTON,
                to: recipientWallet.address,
                jettonWallet: escrowJettonWallet.address,
                amount: transferAmount,
                expiryInSeconds: 3600
            }
        );

        // Send transfer
        const transferResult = await escrowContract.sendTransfers(
            depositorWallet.getSender(),  // anyone can send the transaction
            {
                requests: [request],
                value: toNano('0.5')  // Need more gas for Jetton transfer
            }
        );  

        // Verify transaction success
        expect(transferResult.transactions).toHaveTransaction({
            from: escrowJettonWallet.address,
            to: recipientJettonWallet.address,
            success: true
        });

        // Verify balances
        const finalBalance = await escrowJettonWallet.getData().then(c => c.balance);
        const recipientFinalBalance = await recipientJettonWallet.getData().then(c => c.balance);

        expect(initialBalance - finalBalance).toBe(transferAmount);
        expect(recipientFinalBalance - recipientInitialBalance).toBe(transferAmount);
    });

    it("should reject transfer with non-allocator signature", async () => {
        const transferAmount = toNano('1');
        
        // Create a different key pair (non-allocator)
        const nonAllocatorKey = keyPairFromSeed(await getSecureRandomBytes(32));
        
        // Create transfer request with non-allocator signature
        const request = await escrowContract.createTransferRequest(
            blockchain.provider(escrowContract.address),
            nonAllocatorKey.secretKey,  // Using non-allocator key to sign
            {
                currencyType: CurrencyType.TON,
                to: recipientWallet.address,
                amount: transferAmount,
                expiryInSeconds: 3600
            }
        );
    
        // Send transfer
        const transferResult = await escrowContract.sendTransfers(
            depositorWallet.getSender(),
            {
                requests: [request],
                value: toNano('0.5')
            }
        );
    
        // Verify transaction failed
        expect(transferResult.transactions).toHaveTransaction({
            from: depositorWallet.address,
            to: escrowContract.address,
            success: false,
            exitCode: 102  // Invalid signature error code
        });
    
        // Verify recipient balance unchanged
        const recipientBalance = await recipientWallet.getBalance();
        const initialBalance = await recipientWallet.getBalance();
        expect(recipientBalance).toBe(initialBalance);
    });

    it("should handle multiple transfers in a single transaction", async () => {
        // Set up initial balances and accounts
        const recipient2 = await blockchain.treasury('recipient2');
        
        const transferAmount1 = toNano('1');
        const transferAmount2 = BigInt(100 * 1e6); // 100 USDC
        
        const escrowJettonWallet = await usdcMinterContract.getWallet(escrowContract.address);
        const recipient1InitialBalance = await recipientWallet.getBalance();
        const recipient2JettonWallet = await usdcMinterContract.getWallet(recipient2.address);
        const recipient2InitialJettonBalance = await recipient2JettonWallet.getData().then(c => c.balance).catch(() => 0n);
        const escrowInitialJettonBalance = await escrowJettonWallet.getData().then(c => c.balance);
        const currentNonce = await escrowContract.getNonce();
    
        // Create multiple transfer requests
        const request1 = await escrowContract.createTransferRequest(
            blockchain.provider(escrowContract.address),
            allocatorKey.secretKey,
            {
                currencyType: CurrencyType.TON,
                to: recipientWallet.address,
                amount: transferAmount1,
                nonce: currentNonce + 1n,
                expiryInSeconds: 3600
            }
        );
    
        const request2 = await escrowContract.createTransferRequest(
            blockchain.provider(escrowContract.address),
            allocatorKey.secretKey,
            {
                currencyType: CurrencyType.JETTON,
                to: recipient2.address,
                jettonWallet: escrowJettonWallet.address,
                amount: transferAmount2,
                expiryInSeconds: 3600,
                nonce: currentNonce + 2n,
            }
        );
    
        // Send multiple transfers
        const transferResult = await escrowContract.sendTransfers(
            depositorWallet.getSender(),
            {
                requests: [request1, request2],
                value: toNano('1')
            }
        );

        // Verify final nonce
        const finalNonce = await escrowContract.getNonce();
        expect(finalNonce).toBe(currentNonce + 2n);

        // Verify TON transfer (using exact match)
        const recipient1FinalBalance = await recipientWallet.getBalance();
        const recipient1Received = recipient1FinalBalance - recipient1InitialBalance;
        const maxDelta = toNano('0.01');  // Maximum acceptable difference
        expect(Math.abs(Number(recipient1Received - transferAmount1))).toBeLessThanOrEqual(Number(maxDelta));

        // Verify Jetton transfer
        const recipient2FinalJettonBalance = await recipient2JettonWallet.getData().then(c => c.balance);
        const escrowFinalJettonBalance = await escrowJettonWallet.getData().then(c => c.balance);
        
        expect(recipient2FinalJettonBalance - recipient2InitialJettonBalance).toBe(transferAmount2);
        expect(escrowInitialJettonBalance - escrowFinalJettonBalance).toBe(transferAmount2);

        // Verify transaction success
        expect(transferResult.transactions).toHaveTransaction({
            from: depositorWallet.address,
            to: escrowContract.address,
            success: true
        });
    });

    it("should prevent replay attacks", async () => {
        const transferAmount = toNano('1');
        
        // Create and execute first transfer
        const request = await escrowContract.createTransferRequest(
            blockchain.provider(escrowContract.address),
            allocatorKey.secretKey,
            {
                currencyType: CurrencyType.TON,
                to: recipientWallet.address,
                amount: transferAmount,
                expiryInSeconds: 3600
            }
        );
    
        // First transfer should succeed
        await escrowContract.sendTransfers(
            depositorWallet.getSender(),
            {
                requests: [request],
                value: toNano('0.5')
            }
        );
    
        // Try to replay the same transfer
        const replayResult = await escrowContract.sendTransfers(
            depositorWallet.getSender(),
            {
                requests: [request],
                value: toNano('0.5')
            }
        );
    
        // Verify replay transaction failed
        expect(replayResult.transactions).toHaveTransaction({
            from: depositorWallet.address,
            to: escrowContract.address,
            success: false,
            exitCode: 104  // Invalid nonce
        });
    });
});