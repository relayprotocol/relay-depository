import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, toNano, fromNano } from '@ton/core';
import { RelayEscrow } from '../wrappers/RelayEscrow';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { keyPairFromSeed, getSecureRandomBytes, KeyPair } from "@ton/crypto";
import { TonClient, WalletContractV4, internal } from "@ton/ton";

describe('RelayEscrow', () => {
    let code: Cell;

    beforeAll(async () => {
        code = await compile('RelayEscrow');
    });

    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let relayEscrow: SandboxContract<RelayEscrow>;
    let initialAllocator: SandboxContract<TreasuryContract>;
    let allocator: SandboxContract<TreasuryContract>;

    beforeEach(async () => {
        blockchain = await Blockchain.create();

        deployer = await blockchain.treasury('deployer');
        initialAllocator = await blockchain.treasury('initial-allocator');
        allocator = await blockchain.treasury('allocator');

        relayEscrow = blockchain.openContract(
            RelayEscrow.createFromConfig(
                {
                    owner: deployer.address,
                    allocator: initialAllocator.address,
                },
                code
            )
        );

        const deployResult = await relayEscrow.sendDeploy(deployer.getSender(), toNano('0.05'));
        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: relayEscrow.address,
            deploy: true,
            success: true,
        });
    });

    it('should set allocator', async () => {
        const allocatorBefore = await relayEscrow.getAllocator();
        const setResult = await relayEscrow.sendSetAllocator(deployer.getSender(), {
            allocator: allocator.address,
            value: toNano('0.05'),
        });

        expect(setResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: relayEscrow.address,
            success: true,
        });

        const allocatorAfter = await relayEscrow.getAllocator();
        expect(allocatorAfter.toString()).toBe(allocator.address.toString());
        expect(allocatorBefore.toString()).toBe(initialAllocator.address.toString());
    });

    it("should deposit TON", async() => {
        const depositAmount = toNano('5');
        const depositor = await blockchain.treasury('deployer');
        const balanceBefore = await relayEscrow.getCurrentBlance();
        const depositResult = await relayEscrow.sendDeposit(depositor.getSender(), {
            value: depositAmount
        });
        const balanceAfter = await relayEscrow.getCurrentBlance();
        const amountDeposited = BigInt(balanceAfter - balanceBefore);
        expect(depositResult.transactions).toHaveTransaction({
            from: depositor.address,
            to: relayEscrow.address,
            success: true,
        });
        expect((depositAmount - amountDeposited) < toNano('0.0005')).toBe(true);
    })
});
