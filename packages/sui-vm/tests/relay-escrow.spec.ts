import { describe, it, before } from 'mocha';
import { expect } from 'chai';
import { getFaucetHost, requestSuiFromFaucetV0 } from '@mysten/sui/faucet';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { getFullnodeUrl, SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { execSync } from 'child_process';
import { bcs } from "@mysten/sui/bcs";
import fs from "fs";
import path from "path";
import { Buffer } from 'buffer';
import { sha256 } from 'js-sha256';

const AllocatorInfoStruct = bcs.struct('AllocatorInfo', {
    addr: bcs.Address,
    pubkey: bcs.vector(bcs.u8())
});

const TransferRequestStruct = bcs.struct('TransferRequest', {
    recipient: bcs.Address,
    amount: bcs.u64(),
    coin_type: bcs.struct('TypeName', {
        name: bcs.string(),
    }),
    nonce: bcs.u64(),
    expiration: bcs.u64()
});

const compiledModuleUsdc = {
    modules: [
      "oRzrCwYAAAAKAQAMAgwkAzA4BGgMBXSGAQf6Ac8BCMkDYAapBAwKtQQFDLoERwAWAQ8CCAITAhQCFQAFAgABAgcBAAACAAwBAAECAQwBAAECAwwBAAEEBAIABQYHAAALAAEAAAwCAQAABwMBAAEOAQYBAAIHERIBAAIJCAkBAgINEAEBAAMQCwEBDAMRDwEBDAQSDA0AAwUFBwcKCA4GBwQHAggABwgFAAQHCwQBCAADBQcIBQIHCwQBCAALAgEIAAILAwEIAAsEAQgAAQgGAQsBAQkAAQgABwkAAgoCCgIKAgsBAQgGBwgFAgsEAQkACwMBCQABCwMBCAABCQABBggFAQUBCwQBCAACCQAFBAcLBAEJAAMFBwgFAgcLBAEJAAsCAQkAAQMEQ29pbgxDb2luTWV0YWRhdGEGT3B0aW9uC1RyZWFzdXJ5Q2FwCVR4Q29udGV4dARVU0RDA1VybARidXJuBGNvaW4PY3JlYXRlX2N1cnJlbmN5C2R1bW15X2ZpZWxkBGluaXQEbWludBFtaW50X2FuZF90cmFuc2ZlcgRub25lBm9wdGlvbhRwdWJsaWNfZnJlZXplX29iamVjdA9wdWJsaWNfdHJhbnNmZXIGc2VuZGVyCHRyYW5zZmVyCnR4X2NvbnRleHQDdXJsBHVzZGMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIKAgUEVVNEQwoCAQAAAgEKAQAAAAAEEgsAMQYHAAcABwE4AAoBOAEMAgwDCwI4AgsDCwEuEQk4AwIBAQQAAQYLAAsBCwILAzgEAgIBBAABBQsACwE4BQECAA==",
    ],
    dependencies: [
      "0x0000000000000000000000000000000000000000000000000000000000000001",
      "0x0000000000000000000000000000000000000000000000000000000000000002",
    ],
    digest: [
      201, 60, 152, 72, 135, 186, 20, 153, 47, 119, 37, 161, 105, 93, 32, 172, 208, 77, 109, 22, 21,
      211, 148, 80, 90, 227, 126, 254, 90, 98, 250, 73,
    ],
};

describe('Relay Escrow', () => {
    const networkType = 'localnet';
    const client = new SuiClient({ url: getFullnodeUrl(networkType) });

    let deployer: Ed25519Keypair;
    let alice: Ed25519Keypair;
    let bob: Ed25519Keypair;
    let allocator: Ed25519Keypair;

    let PACKAGE_ID: string;
    let ESCROW_ID: string;
    let ALLOCATOR_CAP_ID: string;
    let EXECUTED_REQUESTS_ID: string;
    let USDC_PACKAGE_ID: string;
    let USDC_COIN_TYPE: string;
    let USDC_TREASURYCAP_ID: string;

    const DEPOSIT_AMOUNT = 1000n; 
    const WITHDRAW_AMOUNT = 500n; 

    before(async () => {
        deployer = new Ed25519Keypair();
        alice = new Ed25519Keypair();
        bob = new Ed25519Keypair();
        allocator = new Ed25519Keypair();

        await Promise.all([
            deployer.toSuiAddress(),
            alice.toSuiAddress(),
            bob.toSuiAddress(),
            allocator.toSuiAddress(),
        ].map((recipient) => requestSuiFromFaucetV0({ host: getFaucetHost(networkType), recipient })));

        const packageData = await publishPackage(__dirname + '/../relay-escrow');
        PACKAGE_ID = packageData.packageId;
        ESCROW_ID = packageData.escrowId;
        ALLOCATOR_CAP_ID = packageData.allocatorCapId;
        EXECUTED_REQUESTS_ID = packageData.executedRequestId;
        const coinData = await deployCoin();
        USDC_PACKAGE_ID = coinData.packageId;
        USDC_COIN_TYPE = coinData.coinType;
        USDC_TREASURYCAP_ID = coinData.treasuryCapId;
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

            const oldAllocatorInfo = AllocatorInfoStruct.parse(new Uint8Array(response.results![0].returnValues![0][0]));
    
            // Set new allocator
            const tx = new Transaction();
            tx.moveCall({
                target: `${PACKAGE_ID}::escrow::set_allocator`,
                arguments: [
                    tx.object(ESCROW_ID),
                    tx.object(ALLOCATOR_CAP_ID),
                    tx.pure.address(allocator.toSuiAddress()),
                    tx.pure.vector('u8', allocator.getPublicKey().toRawBytes())
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

            const allocatorInfo = AllocatorInfoStruct.parse(new Uint8Array(verifyResponse.results![0].returnValues![0][0]));
    
            expect(allocatorInfo.addr).to.equal(allocator.toSuiAddress());
    
            // Verify event was emitted
            const events = setResponse.events;
            const allocatorChangedEvent = events?.find(
                event => event.type.includes('AllocatorChangedEvent')
            );
            
            expect(allocatorChangedEvent).to.not.be.undefined;
            expect(allocatorChangedEvent?.parsedJson).to.deep.equal({
                old_allocator: oldAllocatorInfo.addr,
                new_allocator: allocator.toSuiAddress()
            });
    
        } catch (error) {
            console.error('Set allocator failed:', error);
            throw error;
        }
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
            const id = Buffer.from(Array(32).fill(1));
            tx.moveCall({
                target: `${PACKAGE_ID}::escrow::deposit_coin`,
                typeArguments: ['0x2::sui::SUI'],
                arguments: [
                    tx.object(ESCROW_ID),
                    tx.object(coin),
                    tx.pure.vector("u8", id),
                ]
            });
            tx.setGasBudget(100000000);

            const balanceBefore = await getBalance('0x2::sui::SUI');
            const response = await client.signAndExecuteTransaction({
                signer: alice,
                transaction: tx,
                requestType: 'WaitForLocalExecution',
                options: { showEffects: true, showEvents: true }
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

    it('should deposit USDC successfully', async () => {
        try {
            // First mint some USDC for Alice
            const mintAmount = 1000000000000n;
    
            // Mint USDC to Alice
            const mintTx = new Transaction();
            mintTx.moveCall({
                target: `${USDC_PACKAGE_ID}::usdc::mint`,
                arguments: [
                    mintTx.object(USDC_TREASURYCAP_ID),
                    mintTx.pure.u64(mintAmount),
                    mintTx.pure.address(alice.toSuiAddress()),
                ],
            });
            mintTx.setGasBudget(100000000);
    
            const mintResponse = await client.signAndExecuteTransaction({
                signer: deployer,
                transaction: mintTx,
                requestType: 'WaitForLocalExecution',
                options: { showEffects: true }
            });
    
            expect(mintResponse.effects?.status.status).to.equal('success');
    
            // Get USDC coins for Alice
            const coins = await client.getCoins({
                owner: alice.toSuiAddress(),
                coinType: USDC_COIN_TYPE
            });
    
            if (coins.data.length === 0) {
                throw new Error('No USDC coins available');
            }
    
            // Deposit USDC
            const depositAmount = DEPOSIT_AMOUNT;
            const tx = new Transaction();
            const [coin] = tx.splitCoins(coins.data[0].coinObjectId, [tx.pure.u64(depositAmount)]);
            const id = Buffer.from(Array(32).fill(2));

            tx.moveCall({
                target: `${PACKAGE_ID}::escrow::deposit_coin`,
                typeArguments: [USDC_COIN_TYPE],
                arguments: [
                    tx.object(ESCROW_ID),
                    tx.object(coin),
                    tx.pure.vector('u8', id)
                ]
            });
            tx.setGasBudget(100000000);
    
            const balanceBefore = await getBalance(USDC_COIN_TYPE);
            const response = await client.signAndExecuteTransaction({
                signer: alice,
                transaction: tx,
                requestType: 'WaitForLocalExecution',
                options: { showEffects: true, showEvents: true }
            });
            expect(response.effects?.status.status).to.equal('success');
    
            const balanceAfter = await getBalance(USDC_COIN_TYPE);
            const depositedAmount = balanceAfter - balanceBefore;
            
            expect(depositedAmount).to.equal(depositAmount);
    
        } catch (error) {
            console.error('USDC Deposit failed:', error);
            throw error;
        }
    });

    it('should execute transfer successfully with valid signature', async () => {
        try {
            // First ensure there are funds in escrow
            const escrowBalance = await getBalance('0x2::sui::SUI');
            expect(escrowBalance > 0n).to.be.true;
    
            // Get current time for expiration
            const expiration = Date.now() + 10 * 60 * 1000;
            
            // Create transfer request parameters
            const recipient = bob.toSuiAddress();
            const amount = WITHDRAW_AMOUNT;
            const nonce = BigInt(Date.now());
    
            // Create transfer request object
            const transferRequest = {
                recipient: recipient,
                amount: amount,
                coin_type: {
                    name: normalizeType('0x2::sui::SUI')
                },
                nonce: nonce,
                expiration: BigInt(expiration)
            };
    
            // Serialize the request
            const serializedData = TransferRequestStruct.serialize(transferRequest).toBytes();

            // Hash the serialized data
            const hashData = sha256.create();
            hashData.update(serializedData);
            const messageHash = new Uint8Array(hashData.array());

            const signature = await allocator.sign(messageHash);
            const bobBalanceBefore = await getCoinBalance(bob.toSuiAddress(), "0x2::sui::SUI");
            
            // Execute transfer
            const tx = new Transaction();
            tx.moveCall({
                target: `${PACKAGE_ID}::escrow::execute_transfer`,
                typeArguments: ['0x2::sui::SUI'],
                arguments: [
                    tx.object(ESCROW_ID),
                    tx.object(EXECUTED_REQUESTS_ID),
                    tx.pure.address(recipient),
                    tx.pure.u64(amount),
                    tx.pure.u64(nonce),
                    tx.pure.u64(expiration),
                    tx.pure.vector("u8", signature),
                    tx.object('0x6'), // SUI_CLOCK_OBJECT_ID
                ]
            });
            tx.setGasBudget(100000000);
    
            const response = await client.signAndExecuteTransaction({
                signer: alice,
                transaction: tx,
                requestType: 'WaitForLocalExecution',
                options: { showEffects: true, showEvents: true }
            });

            expect(response.effects?.status.status).to.equal('success');
    
            // Verify balance changes
            const bobBalanceAfter = await getCoinBalance(bob.toSuiAddress(), '0x2::sui::SUI');
            const escrowBalanceAfter = await getBalance('0x2::sui::SUI');
    
            expect(bobBalanceAfter - bobBalanceBefore === WITHDRAW_AMOUNT).to.be.true;
            expect(escrowBalance - escrowBalanceAfter === WITHDRAW_AMOUNT).to.be.true;
    
            // Verify event was emitted
            const events = response.events;
            const transferEvent = events?.find(
                event => event.type.includes('TransferExecutedEvent')
            );

            expect(transferEvent).to.not.be.undefined;
            expect(transferEvent?.parsedJson?.recipient).to.equal(recipient);
            expect(BigInt(transferEvent?.parsedJson?.amount) === amount).to.be.true;
    
        } catch (error) {
            console.error('Execute transfer failed:', error);
            throw error;
        }
    });

    it('should execute USDC transfer successfully with valid signature', async () => {
        try {
            // First check if there are USDC funds in escrow
            const escrowBalance = await getBalance(USDC_COIN_TYPE);
            expect(escrowBalance > 0n).to.be.true;
    
            // Get current time for expiration
            const expiration = Date.now() + 10 * 60 * 1000;
            
            // Create transfer request parameters for USDC
            const recipient = bob.toSuiAddress();
            const amount = WITHDRAW_AMOUNT;  // Using same amount as SUI tests
            const nonce = BigInt(Date.now());
    
            // Create transfer request object for USDC
            const transferRequest = {
                recipient: recipient,
                amount: amount,
                coin_type: {
                    // Using the deployed USDC coin type
                    name: normalizeType(USDC_COIN_TYPE)
                },
                nonce: nonce,
                expiration: BigInt(expiration)
            };
    
            // Serialize the request
            const serializedData = TransferRequestStruct.serialize(transferRequest).toBytes();
    
            // Hash the serialized data using SHA-256
            const hashData = sha256.create();
            hashData.update(serializedData);
            const messageHash = new Uint8Array(hashData.array());
    
            // Sign the message hash with allocator's key
            const signature = await allocator.sign(messageHash);
    
            // Get Bob's initial USDC balance using getCoinBalance
            const bobBalanceBefore = await getCoinBalance(bob.toSuiAddress(), USDC_COIN_TYPE);
            
            // Execute USDC transfer
            const tx = new Transaction();
            tx.moveCall({
                target: `${PACKAGE_ID}::escrow::execute_transfer`,
                typeArguments: [USDC_COIN_TYPE],  // Using USDC coin type
                arguments: [
                    tx.object(ESCROW_ID),
                    tx.object(EXECUTED_REQUESTS_ID),
                    tx.pure.address(recipient),
                    tx.pure.u64(amount),
                    tx.pure.u64(nonce),
                    tx.pure.u64(expiration),
                    tx.pure.vector("u8", signature),
                    tx.object('0x6'), // SUI_CLOCK_OBJECT_ID
                ]
            });
            tx.setGasBudget(100000000);
    
            const response = await client.signAndExecuteTransaction({
                signer: alice,
                transaction: tx,
                requestType: 'WaitForLocalExecution',
                options: { showEffects: true, showEvents: true }
            });
    
            expect(response.effects?.status.status).to.equal('success');
    
            // Verify balance changes
            const bobBalanceAfter = await getCoinBalance(bob.toSuiAddress(), USDC_COIN_TYPE);
            const escrowBalanceAfter = await getBalance(USDC_COIN_TYPE);
    
            // Verify exact amount was transferred
            expect(bobBalanceAfter - bobBalanceBefore === WITHDRAW_AMOUNT).to.be.true;
            expect(escrowBalance - escrowBalanceAfter === WITHDRAW_AMOUNT).to.be.true;
    
            // Verify transfer event was emitted
            const events = response.events;
            const transferEvent = events?.find(
                event => event.type.includes('TransferExecutedEvent')
            );
    
            expect(transferEvent).to.not.be.undefined;
            expect(transferEvent?.parsedJson?.recipient).to.equal(recipient);
            expect(BigInt(transferEvent?.parsedJson?.amount) === amount).to.be.true;
            expect(transferEvent?.parsedJson?.coin_type.name).to.equal(normalizeType(USDC_COIN_TYPE));
    
        } catch (error) {
            console.error('Execute USDC transfer failed:', error);
            throw error;
        }
    });

    it('should execute multiple transfers in a single transaction', async () => {
        try {
            // Request more SUI from faucet for Alice
            await requestSuiFromFaucetV0({ 
                host: getFaucetHost(networkType), 
                recipient: alice.toSuiAddress() 
            });
    
            // First deposit more SUI to ensure sufficient funds
            const depositAmount = DEPOSIT_AMOUNT * 3n; // Deposit 3000n
            
            // Get all available coins for Alice
            const coins = await client.getCoins({
                owner: alice.toSuiAddress(),
                coinType: '0x2::sui::SUI'
            });
    
            if (coins.data.length === 0) {
                throw new Error('No SUI coins available');
            }
    
            // Find the coin with the largest balance for gas
            const sortedCoins = [...coins.data].sort((a, b) => {
                const balanceA = BigInt(a.balance);
                const balanceB = BigInt(b.balance);
                return balanceB > balanceA ? 1 : balanceB < balanceA ? -1 : 0;
            });
            const primaryCoin = sortedCoins[0];
    
            // Deposit additional funds
            const depositTx = new Transaction();
            const [coin] = depositTx.splitCoins(primaryCoin.coinObjectId, [depositTx.pure.u64(depositAmount)]);
            const id = Buffer.from(Array(32).fill(3));

            depositTx.moveCall({
                target: `${PACKAGE_ID}::escrow::deposit_coin`,
                typeArguments: ['0x2::sui::SUI'],
                arguments: [
                    depositTx.object(ESCROW_ID),
                    depositTx.object(coin),
                    depositTx.pure.vector('u8', id)
                ]
            });
            // Set a lower gas budget for deposit
            depositTx.setGasBudget(50000000);
    
            const depositResponse = await client.signAndExecuteTransaction({
                signer: alice,
                transaction: depositTx,
                requestType: 'WaitForLocalExecution',
                options: { showEffects: true, showEvents: true }
            });

            expect(depositResponse.effects?.status.status).to.equal('success');
    
            // Get initial balances after deposit
            const initialEscrowBalance = await getBalance('0x2::sui::SUI');
            const totalWithdrawAmount = WITHDRAW_AMOUNT * 3n; // Will withdraw 1500n
            expect(initialEscrowBalance >= totalWithdrawAmount).to.be.true;
    
            const expiration = Date.now() + 10 * 60 * 1000;
            
            // Record initial balances
            const bobInitialBalance = await getCoinBalance(bob.toSuiAddress(), '0x2::sui::SUI');
            
            // Create three different transfer requests
            const transfers = Array(3).fill(null).map((_, i) => ({
                recipient: bob.toSuiAddress(),
                amount: WITHDRAW_AMOUNT,
                nonce: BigInt(Date.now() + i), // Different nonce for each transfer
                expiration: BigInt(expiration)
            }));
    
            // Create and sign all transfer requests
            const signedTransfers = await Promise.all(transfers.map(async transfer => {
                const transferRequest = {
                    recipient: transfer.recipient,
                    amount: transfer.amount,
                    coin_type: {
                        name: normalizeType('0x2::sui::SUI')
                    },
                    nonce: transfer.nonce,
                    expiration: transfer.expiration
                };
    
                // Serialize and sign the request
                const serializedData = TransferRequestStruct.serialize(transferRequest).toBytes();
                const hashData = sha256.create();
                hashData.update(serializedData);
                const messageHash = new Uint8Array(hashData.array());
                const signature = await allocator.sign(messageHash);
                return {
                    request: transfer,
                    signature
                };
            }));
    
            // Get updated coins for Alice after deposit
            const updatedCoins = await client.getCoins({
                owner: alice.toSuiAddress(),
                coinType: '0x2::sui::SUI'
            });
    
            // Find a suitable gas coin
            const gasCoin = updatedCoins.data.find(coin => 
                BigInt(coin.balance) >= 150000000n
            );
    
            if (!gasCoin) {
                throw new Error('No suitable gas coin found');
            }
    
            // Create a single transaction with multiple transfer calls
            const tx = new Transaction();
            
            // Add all transfers to the transaction
            signedTransfers.forEach(({ request, signature }) => {
                tx.moveCall({
                    target: `${PACKAGE_ID}::escrow::execute_transfer`,
                    typeArguments: ['0x2::sui::SUI'],
                    arguments: [
                        tx.object(ESCROW_ID),
                        tx.object(EXECUTED_REQUESTS_ID),
                        tx.pure.address(request.recipient),
                        tx.pure.u64(request.amount),
                        tx.pure.u64(request.nonce),
                        tx.pure.u64(request.expiration),
                        tx.pure.vector("u8", signature),
                        tx.object('0x6'), // SUI_CLOCK_OBJECT_ID
                    ]
                });
            });
    
            // Execute the transaction with multiple transfers
            const response = await client.signAndExecuteTransaction({
                signer: alice,
                transaction: tx,
                requestType: 'WaitForLocalExecution',
                options: { showEffects: true, showEvents: true }
            });
    
            expect(response.effects?.status.status).to.equal('success');
    
            // Verify final balances
            const bobFinalBalance = await getCoinBalance(bob.toSuiAddress(), '0x2::sui::SUI');
            const escrowFinalBalance = await getBalance('0x2::sui::SUI');
    
            // Verify total amount transferred
            expect(bobFinalBalance - bobInitialBalance).to.equal(totalWithdrawAmount);
            expect(initialEscrowBalance - escrowFinalBalance).to.equal(totalWithdrawAmount);
    
            // Verify events were emitted for each transfer
            const events = response.events;
            const transferEvents = events?.filter(
                event => event.type.includes('TransferExecutedEvent')
            );
    
            // Should have 3 transfer events
            expect(transferEvents).to.have.lengthOf(3);
    
            // Verify each event
            transferEvents?.forEach((event, index) => {
                expect(event.parsedJson?.recipient).to.equal(transfers[index].recipient);
                expect(BigInt(event.parsedJson?.amount)).to.equal(transfers[index].amount);
            });
    
            // Try to execute one of the transfers again (should fail)
            const retryTx = new Transaction();
            const { request, signature } = signedTransfers[0];
            retryTx.moveCall({
                target: `${PACKAGE_ID}::escrow::execute_transfer`,
                typeArguments: ['0x2::sui::SUI'],
                arguments: [
                    retryTx.object(ESCROW_ID),
                    retryTx.object(EXECUTED_REQUESTS_ID),
                    retryTx.pure.address(request.recipient),
                    retryTx.pure.u64(request.amount),
                    retryTx.pure.u64(request.nonce),
                    retryTx.pure.u64(request.expiration),
                    retryTx.pure.vector("u8", signature),
                    retryTx.object('0x6'), // SUI_CLOCK_OBJECT_ID
                ]
            });
            retryTx.setGasBudget(50000000);
    
            const retryResponse = await client.signAndExecuteTransaction({
                signer: alice,
                transaction: retryTx,
                requestType: 'WaitForLocalExecution',
                options: { showEffects: true }
            });
    
            // Verify retry failed due to already executed request
            expect(retryResponse.effects?.status.status).to.equal('failure');
    
        } catch (error) {
            console.error('Multiple transfers in single transaction test failed:', error);
            throw error;
        }
    });

    it('should fail when transfer request is expired', async () => {
        try {
            // Ensure there are funds in escrow
            const escrowBalance = await getBalance('0x2::sui::SUI');
            expect(escrowBalance > 0n).to.be.true;
    
            // Set expiration time to the past
            const expiration = Date.now() - 1000; // 1 second ago
            
            // Create transfer request parameters 
            const recipient = bob.toSuiAddress();
            const amount = WITHDRAW_AMOUNT;
            const nonce = BigInt(Date.now());
    
            // Create transfer request object
            const transferRequest = {
                recipient: recipient,
                amount: amount,
                coin_type: {
                    name: normalizeType('0x2::sui::SUI')
                },
                nonce: nonce,
                expiration: BigInt(expiration)
            };
    
            // Serialize and sign the request
            const serializedData = TransferRequestStruct.serialize(transferRequest).toBytes();
            const hashData = sha256.create();
            hashData.update(serializedData);
            const messageHash = new Uint8Array(hashData.array());
            const signature = await allocator.sign(messageHash);
    
            // Execute transfer
            const tx = new Transaction();
            tx.moveCall({
                target: `${PACKAGE_ID}::escrow::execute_transfer`,
                typeArguments: ['0x2::sui::SUI'],
                arguments: [
                    tx.object(ESCROW_ID),
                    tx.object(EXECUTED_REQUESTS_ID),
                    tx.pure.address(recipient),
                    tx.pure.u64(amount),
                    tx.pure.u64(nonce),
                    tx.pure.u64(expiration),
                    tx.pure.vector("u8", signature),
                    tx.object('0x6'), // SUI_CLOCK_OBJECT_ID
                ]
            });
            tx.setGasBudget(100000000);
    
            const response = await client.signAndExecuteTransaction({
                signer: alice,
                transaction: tx,
                requestType: 'WaitForLocalExecution',
                options: { showEffects: true }
            });
    
            // Should fail due to expired request
            expect(response.effects?.status.status).to.equal('failure');
    
        } catch (error) {
            // Expected to fail
            expect(error).to.exist;
        }
    });
    
    it('should fail with invalid allocator signature', async () => {
        try {
            // Ensure there are funds in escrow
            const escrowBalance = await getBalance('0x2::sui::SUI');
            expect(escrowBalance > 0n).to.be.true;
    
            const expiration = Date.now() + 10 * 60 * 1000;
            
            // Create transfer request parameters
            const recipient = bob.toSuiAddress();
            const amount = WITHDRAW_AMOUNT;
            const nonce = BigInt(Date.now());
    
            // Create transfer request object
            const transferRequest = {
                recipient: recipient,
                amount: amount,
                coin_type: {
                    name: normalizeType('0x2::sui::SUI')
                },
                nonce: nonce,
                expiration: BigInt(expiration)
            };
    
            // Serialize the request
            const serializedData = TransferRequestStruct.serialize(transferRequest).toBytes();
            const hashData = sha256.create();
            hashData.update(serializedData);
            const messageHash = new Uint8Array(hashData.array());
    
            // Use a different keypair to sign (not the allocator)
            const wrongKeypair = new Ed25519Keypair();
            const invalidSignature = await wrongKeypair.sign(messageHash);
    
            // Execute transfer with invalid signature
            const tx = new Transaction();
            tx.moveCall({
                target: `${PACKAGE_ID}::escrow::execute_transfer`,
                typeArguments: ['0x2::sui::SUI'],
                arguments: [
                    tx.object(ESCROW_ID),
                    tx.object(EXECUTED_REQUESTS_ID),
                    tx.pure.address(recipient),
                    tx.pure.u64(amount),
                    tx.pure.u64(nonce),
                    tx.pure.u64(expiration),
                    tx.pure.vector("u8", invalidSignature),
                    tx.object('0x6'), // SUI_CLOCK_OBJECT_ID
                ]
            });
            tx.setGasBudget(100000000);
    
            const response = await client.signAndExecuteTransaction({
                signer: alice,
                transaction: tx,
                requestType: 'WaitForLocalExecution',
                options: { showEffects: true }
            });
    
            // Should fail due to invalid signature
            expect(response.effects?.status.status).to.equal('failure');
    
        } catch (error) {
            // Expected to fail
            expect(error).to.exist;
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
                    tx.pure.address(alice.toSuiAddress()),
                    tx.pure.vector('u8', alice.getPublicKey().toRawBytes())
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
                    tx.pure.address('0x0'), // Zero address
                    tx.pure.vector('u8', Buffer.from([]))
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
        
    async function getCoinBalance(address: string, coinType: string): Promise<bigint> {
        const coin = await client.getBalance({
            owner: address,
            coinType: coinType
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

    async function deployPackage(packageData: any) {
        const tx = new Transaction();
        const [upgradeCap] = tx.publish({
            modules: packageData.modules,
            dependencies: packageData.dependencies,
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
                    typeRaw: "package",
                    type: 'package',
                    id: item.data?.objectId,
                });
            } else if (!item.data!.type!.includes('SUI')) {
                objects.push({
                    typeRaw: item.data?.type,
                    type: item.data?.type.slice(68),
                    id: item.data?.objectId,
                });
            }
        });
        return objects;
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
    
        const objects = await deployPackage(buildResult);
        const packageId = objects.find(c => c.type === "package").id!;
        const escrowId = objects.find(c => c.type === "escrow::Escrow").id!;
        const allocatorCapId = objects.find(c => c.type === "escrow::AllocatorCap").id!;
        const executedRequestId = objects.find(c => c.type === "escrow::ExecutedRequests").id!;
    
        return {
            packageId,
            escrowId,
            allocatorCapId,
            executedRequestId,
        };
    }

    async function deployCoin() {
        const objects = await deployPackage(compiledModuleUsdc);
        const packageId = objects.find(c => c.type === "package").id!;
        const treasuryCapId = objects.find(c => c.typeRaw.includes('coin::TreasuryCap')).id!;
        return {
            packageId,
            treasuryCapId,
            coinType: `${packageId}::usdc::USDC`
        }
    }

    function normalizeType(type) {
        const parts = type.split('::');
        if (parts.length < 2) {
            throw new Error('Invalid type format');
        }
    
        let address = parts[0].toLowerCase().replace('0x', '');
        if (address.length < 64) {
            address = address.padStart(64, '0');
        } else if (address.length > 64) {
            throw new Error('Invalid address length');
        }
    
        parts[0] = address;
        return parts.join('::');
    }
});