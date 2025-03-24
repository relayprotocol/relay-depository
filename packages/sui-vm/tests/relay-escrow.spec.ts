import { describe, it, before } from 'mocha';
import { expect } from 'chai';
import { getFaucetHost, requestSuiFromFaucetV0 } from '@mysten/sui/faucet';
import { Ed25519Keypair, Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519';
import { getFullnodeUrl, SuiClient, SuiObjectRef } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { execSync } from 'child_process';
import { bcs } from "@mysten/sui/bcs";
import fs from "fs";
import path from "path";

describe('Relay Escrow', () => {
    const networkType = 'localnet';
    const client = new SuiClient({ url: getFullnodeUrl(networkType) });

    let deployer: Ed25519Keypair;
    let alice: Ed25519Keypair;
    let bob: Ed25519Keypair;

    let PACKAGE_ID: string;
    let ESCROW_ID: string;
    let ALLOCATOR_CAP_ID: string;

    const DEPOSIT_AMOUNT = 1000n; 
    const WITHDRAW_AMOUNT = 500n; 

    before(async () => {
        deployer = new Ed25519Keypair();
        alice = new Ed25519Keypair();
        bob = new Ed25519Keypair();

        await Promise.all([
            deployer.toSuiAddress(),
            alice.toSuiAddress(),
            bob.toSuiAddress(),
        ].map((recipient) => requestSuiFromFaucetV0({ host: getFaucetHost(networkType), recipient })));

        const packageData = await publishPackage(__dirname + '/../relay-escrow');
        PACKAGE_ID = packageData.packageId;
        ESCROW_ID = packageData.escrowId;
        ALLOCATOR_CAP_ID = packageData.allocatorCapId;
    });

    it('should deposit SUI successfully', async () => {
        try {
            const coins = await client.getCoins({
                owner: alice.toSuiAddress(),
                coinType: '0x2::sui::SUI'
            });

            if (coins.data.length === 0) {
                throw new Error('No SUI coins available');
            }

            const tx = new Transaction();
            const [coin] = tx.splitCoins(coins.data[0].coinObjectId, [tx.pure.u64(DEPOSIT_AMOUNT)]);
            tx.moveCall({
                target: `${PACKAGE_ID}::escrow::deposit_coin`,
                typeArguments: ['0x2::sui::SUI'],
                arguments: [
                    tx.object(ESCROW_ID),
                    tx.object(coin),
                ]
            });
            tx.setGasBudget(100000000);

            const balanceBefore = await getBalance('0x2::sui::SUI');
            const response = await client.signAndExecuteTransaction({
                signer: alice,
                transaction: tx,
                requestType: 'WaitForLocalExecution',
                options: { showEffects: true }
            });

            expect(response.effects?.status.status).to.equal('success');

            const balanceAfter = await getBalance('0x2::sui::SUI');
            const depositAmount = balanceAfter - balanceBefore;
            
            expect(depositAmount).to.equal(DEPOSIT_AMOUNT);

        } catch (error) {
            console.error('Deposit failed:', error);
            throw error;
        }
    });

    it('should withdraw SUI successfully', async () => {
        try {
            // Get initial balances
            const recipientInitialBalance = await getSuiBalance(bob.toSuiAddress());
            const escrowInitialBalance = await getBalance('0x2::sui::SUI');

            // Verify we have enough balance to withdraw
            expect(Number(escrowInitialBalance)).to.be.gt(Number(WITHDRAW_AMOUNT));

            // Get current allocator
            const getTx = new Transaction();
            getTx.moveCall({
                target: `${PACKAGE_ID}::escrow::get_allocator`,
                arguments: [
                    getTx.object(ESCROW_ID)
                ]
            });

            const allocatorResponse = await client.devInspectTransactionBlock({
                transactionBlock: getTx,
                sender: deployer.toSuiAddress()
            });

            // const currentAllocator = bcs.Address.parse(new Uint8Array(allocatorResponse.results![0].returnValues![0][0]));

            // Withdraw
            const withdrawTx = new Transaction();
            withdrawTx.moveCall({
                target: `${PACKAGE_ID}::escrow::withdraw_coin`,
                typeArguments: ['0x2::sui::SUI'],
                arguments: [
                    withdrawTx.object(ESCROW_ID),
                    withdrawTx.object(ALLOCATOR_CAP_ID),
                    withdrawTx.pure.u64(WITHDRAW_AMOUNT),
                    withdrawTx.pure.address(bob.toSuiAddress())
                ]
            });
            withdrawTx.setGasBudget(100000000);

            const withdrawResponse = await client.signAndExecuteTransaction({
                signer: deployer,
                transaction: withdrawTx,
                requestType: 'WaitForLocalExecution',
                options: { showEffects: true }
            });

            expect(withdrawResponse.effects?.status.status).to.equal('success');

            // Verify final balances
            const recipientFinalBalance = await getSuiBalance(bob.toSuiAddress());
            const escrowFinalBalance = await getBalance('0x2::sui::SUI');

            // Check recipient received correct amount
            expect(recipientFinalBalance - recipientInitialBalance).to.equal(WITHDRAW_AMOUNT);
            
            // Check escrow balance decreased correctly
            expect(escrowInitialBalance - escrowFinalBalance).to.equal(WITHDRAW_AMOUNT);

        } catch (error) {
            console.error('Withdraw failed:', error);
            console.error('Error details:', error);
            throw error;
        }
    });
    
    it('should fail when non-allocator tries to withdraw', async () => {
        try {
            const tx = new Transaction();
            tx.moveCall({
                target: `${PACKAGE_ID}::escrow::withdraw_coin`,
                typeArguments: ['0x2::sui::SUI'],
                arguments: [
                    tx.object(ESCROW_ID),
                    tx.object(ALLOCATOR_CAP_ID),
                    tx.pure.u64(100),
                    tx.pure.address(alice.toSuiAddress())
                ]
            });
            tx.setGasBudget(100000000);
    
            const response = await client.signAndExecuteTransaction({
                signer: alice, // Alice is not the allocator
                transaction: tx,
                requestType: 'WaitForLocalExecution',
                options: { showEffects: true }
            });
    
            expect(response.effects?.status.status).to.equal('failure');
        } catch (error) {
            // Expected to fail
            expect(error).to.exist;
        }
    });
    
    it('should fail when trying to withdraw more than available balance', async () => {
        try {
            const currentBalance = await getBalance('0x2::sui::SUI');
            const withdrawAmount = Number(currentBalance) + 1000; // Try to withdraw more than available
    
            const tx = new Transaction();
            tx.moveCall({
                target: `${PACKAGE_ID}::escrow::withdraw_coin`,
                typeArguments: ['0x2::sui::SUI'],
                arguments: [
                    tx.object(ESCROW_ID),
                    tx.object(ALLOCATOR_CAP_ID),
                    tx.pure.u64(withdrawAmount),
                    tx.pure.address(bob.toSuiAddress())
                ]
            });
            tx.setGasBudget(100000000);
    
            const response = await client.signAndExecuteTransaction({
                signer: deployer,
                transaction: tx,
                requestType: 'WaitForLocalExecution',
                options: { showEffects: true }
            });
    
            expect(response.effects?.status.status).to.equal('failure');
        } catch (error) {
            // Expected to fail
            expect(error).to.exist;
        }
    });

    it('should set new allocator successfully', async () => {
        try {
            // Get current allocator
            const getTx = new Transaction();
            getTx.moveCall({
                target: `${PACKAGE_ID}::escrow::get_allocator`,
                arguments: [
                    getTx.object(ESCROW_ID)
                ]
            });
    
            const response = await client.devInspectTransactionBlock({
                transactionBlock: getTx,
                sender: deployer.toSuiAddress()
            });
    
            const oldAllocator = bcs.Address.parse(new Uint8Array(response.results![0].returnValues![0][0]));
    
            // Set new allocator
            const tx = new Transaction();
            tx.moveCall({
                target: `${PACKAGE_ID}::escrow::set_allocator`,
                arguments: [
                    tx.object(ESCROW_ID),
                    tx.object(ALLOCATOR_CAP_ID),
                    tx.pure.address(bob.toSuiAddress())
                ]
            });
            tx.setGasBudget(100000000);
    
            const setResponse = await client.signAndExecuteTransaction({
                signer: deployer,
                transaction: tx,
                requestType: 'WaitForLocalExecution',
                options: { showEffects: true, showEvents: true }
            });
    
            expect(setResponse.effects?.status.status).to.equal('success');
    
            // Verify allocator has been changed
            const verifyTx = new Transaction();
            verifyTx.moveCall({
                target: `${PACKAGE_ID}::escrow::get_allocator`,
                arguments: [
                    verifyTx.object(ESCROW_ID)
                ]
            });
    
            const verifyResponse = await client.devInspectTransactionBlock({
                transactionBlock: verifyTx,
                sender: deployer.toSuiAddress()
            });
    
            const newAllocator = bcs.Address.parse(new Uint8Array(verifyResponse.results![0].returnValues![0][0]));
            
            expect(newAllocator).to.equal(bob.toSuiAddress());
    
            // Verify event was emitted
            const events = setResponse.events;
            const allocatorChangedEvent = events?.find(
                event => event.type.includes('AllocatorChangedEvent')
            );
            
            expect(allocatorChangedEvent).to.not.be.undefined;
            expect(allocatorChangedEvent?.parsedJson).to.deep.equal({
                old_allocator: oldAllocator,
                new_allocator: bob.toSuiAddress()
            });
    
        } catch (error) {
            console.error('Set allocator failed:', error);
            throw error;
        }
    });
    
    it('should fail when non-allocator tries to set new allocator', async () => {
        try {
            const tx = new Transaction();
            tx.moveCall({
                target: `${PACKAGE_ID}::escrow::set_allocator`,
                arguments: [
                    tx.object(ESCROW_ID),
                    tx.object(ALLOCATOR_CAP_ID),
                    tx.pure.address(alice.toSuiAddress())
                ]
            });
            tx.setGasBudget(100000000);
    
            const response = await client.signAndExecuteTransaction({
                signer: alice, // Alice is not the allocator
                transaction: tx,
                requestType: 'WaitForLocalExecution',
                options: { showEffects: true }
            });
    
            expect(response.effects?.status.status).to.equal('failure');
        } catch (error) {
            // Expected to fail
            expect(error).to.exist;
        }
    });
    
    it('should fail when trying to set zero address as allocator', async () => {
        try {
            const tx = new Transaction();
            tx.moveCall({
                target: `${PACKAGE_ID}::escrow::set_allocator`,
                arguments: [
                    tx.object(ESCROW_ID),
                    tx.object(ALLOCATOR_CAP_ID),
                    tx.pure.address('0x0') // Zero address
                ]
            });
            tx.setGasBudget(100000000);
    
            const response = await client.signAndExecuteTransaction({
                signer: deployer,
                transaction: tx,
                requestType: 'WaitForLocalExecution',
                options: { showEffects: true }
            });
    
            expect(response.effects?.status.status).to.equal('failure');
        } catch (error) {
            // Expected to fail
            expect(error).to.exist;
        }
    });
    
    async function getSuiBalance(address: string): Promise<bigint> {
        const coin = await client.getBalance({
            owner: address,
            coinType: '0x2::sui::SUI'
        });
        return BigInt(coin.totalBalance);
    }


    async function getBalance(coinType: string): Promise<bigint> {
        try {
            const tx = new Transaction();
            tx.moveCall({
                target: `${PACKAGE_ID}::escrow::get_balance`,
                typeArguments: [coinType],
                arguments: [
                    tx.object(ESCROW_ID)
                ]
            });

            const response = await client.devInspectTransactionBlock({
                transactionBlock: tx,
                sender: deployer.toSuiAddress()
            });

            if (!response.results?.[0]?.returnValues?.[0]?.[0]) {
                throw new Error('Failed to get balance');
            }

            const returnedValue = bcs.U64.parse(new Uint8Array(response.results[0].returnValues[0][0]));
            return BigInt(returnedValue);
        } catch (error) {
            console.error('Get balance failed:', error);
            throw error;
        }
    }

    async function publishPackage(packagePath: string) {
        const cacheFile = `${packagePath}/.build_cache.json`;
        const getLastModified = (dir: string): number => {
            let lastModified = 0;
            const items = fs.readdirSync(dir, { withFileTypes: true });
            
            for (const item of items) {
                const fullPath = path.join(dir, item.name);
                if (item.isDirectory() && !item.name.startsWith('.')) {
                    lastModified = Math.max(lastModified, getLastModified(fullPath));
                } else {
                    const stats = fs.statSync(fullPath);
                    lastModified = Math.max(lastModified, stats.mtimeMs);
                }
            } 
            return lastModified;
        };
    
        // Check Cache
        let buildResult;
        const currentLastModified = getLastModified(
            path.join(packagePath, 'sources'));

        if (fs.existsSync(cacheFile)) {
            const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
            if (cache.lastModified >= currentLastModified) {
                console.log('Using cached build result');
                buildResult = { modules: cache.modules, dependencies: cache.dependencies };
            }
        }
    
        // Buil if cache not exists
        if (!buildResult) {
            console.log('Building package...');
            buildResult = JSON.parse(
                execSync(`sui move build --dump-bytecode-as-base64 --path ${packagePath}`, {
                    encoding: 'utf-8',
                })
            );
            
            // Save cache
            fs.writeFileSync(cacheFile, JSON.stringify({
                lastModified: currentLastModified,
                modules: buildResult.modules,
                dependencies: buildResult.dependencies
            }));
        }
    
        const tx = new Transaction();
        const [upgradeCap] = tx.publish({
            modules: buildResult.modules,
            dependencies: buildResult.dependencies,
        });
    
        tx.transferObjects([upgradeCap], deployer.toSuiAddress());
        const result = await client.signAndExecuteTransaction({
            signer: deployer,
            transaction: tx,
            options: {
                showEffects: true,
                showEvents: true,
            },
            requestType: "WaitForLocalExecution"
        });
    
        const createdObjectIds = result!.effects.created!.map((item) => item.reference.objectId);
        const createdObjects = await client.multiGetObjects({
            ids: createdObjectIds,
            options: { showContent: true, showType: true, showOwner: true },
        });
    
        const objects: any[] = [];
        createdObjects.forEach((item) => {
            if (item.data?.type === 'package') {
                objects.push({
                    type: 'package',
                    id: item.data?.objectId,
                });
            } else if (!item.data!.type!.includes('SUI')) {
                objects.push({
                    type: item.data?.type!.slice(68),
                    id: item.data?.objectId,
                });
            }
        });
    
        const packageId = objects.find(c => c.type === "package").id!;
        const escrowId = objects.find(c => c.type === "escrow::Escrow").id!;
        const allocatorCapId = objects.find(c => c.type === "escrow::AllocatorCap").id!;
    
        return {
            packageId,
            escrowId,
            allocatorCapId,
        };
    }
});