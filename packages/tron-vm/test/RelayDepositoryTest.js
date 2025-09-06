const RelayDepository = artifacts.require("RelayDepository");
const MockTRC20 = artifacts.require("test/MockTRC20");
const { TronWeb, Trx, utils } = require('tronweb');
const crypto = require('crypto');

contract("RelayDepository", (accounts) => {
    const owner = accounts[0];
    const user = accounts[1];
    const recipient = accounts[2];

    const allocatorPrivateKey = crypto.randomBytes(32).toString('hex');
    const allocator = utils.address.fromPrivateKey(allocatorPrivateKey);

    let relayDepository;
    let mockUSDT;
    let tronWeb;

    const depositAmount = 1 * 1e5; // 1 TRX in sun (18 decimals)
    const withdrawAmount = "0"; // 0.5 TRX in sun (18 decimals)

    const tronboxConfig = require('../tronbox-config');

    before(async () => {
        // Initialize TronWeb
        const fullHost = tronboxConfig.networks.development.fullHost;
        tronWeb = new TronWeb({
            fullHost: fullHost,
            privateKey: allocatorPrivateKey
        });

        // Deploy RelayDepository contract
        relayDepository = await RelayDepository.new(owner, allocator);

        // Deploy mock USDT contract
        mockUSDT = await MockTRC20.new("Tether USD", "USDT", 6);

        // Mint some USDT to the user (1000 USDT with 6 decimals)
        await mockUSDT.mint(user, "1000000000");

        // Log allocator address to verify it matches the private key
        console.log("Allocator address:", allocator);
        console.log("Address from private key:", tronWeb.address.fromPrivateKey(allocatorPrivateKey));
        // console.log("Block chainId:", await relayDepository.getBoth());
    });

    describe("Native token deposit tests", () => {
        it("should deposit native tokens and increase contract balance", async () => {
            // Generate a proper bytes32 ID (64 hex characters = 32 bytes)
            const depositId = '0x' + Array(64).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('');
            const contractBalanceBefore = await tronWeb.trx.getBalance(relayDepository.address);
            const userBalanceBefore = await tronWeb.trx.getBalance(user);

            // Deposit native tokens
            const tx = await relayDepository.depositNative(user, depositId, {
                callValue: depositAmount,
            });

            await new Promise(resolve => setTimeout(resolve, 8000));

            const receipt = await tronWeb.trx.getTransactionInfo(tx);
            const RelayNativeDepositLog = receipt.log.find(c => c.topics.includes('8032066556caf3967d8fec4ad22a2d9e1e9576556b2903a0fcd5b1fd201e3477'));
            assert.ok(RelayNativeDepositLog, "Transaction should include RelayNativeDeposit event");

            const contractBalanceAfter = await tronWeb.trx.getBalance(relayDepository.address);
            const userBalanceAfter = await tronWeb.trx.getBalance(user);
          
            assert.ok(tx, "Transaction should be successful");

            const balanceBefore = BigInt(contractBalanceBefore);
            const balanceAfter = BigInt(contractBalanceAfter);
            const balanceDiff = balanceAfter - balanceBefore;

            assert.equal(balanceDiff.toString(), depositAmount, "Contract balance should increase by the deposit amount");
        });
    });

    describe("USDT eip712 signature withdraw tests", () => {
        it("should execute USDT withdraw operation with allocator signature", async () => {
            // First deposit some USDT to the contract for withdrawal
            const depositId = '0x' + Array(64).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('');
            const depositUsdtAmount = "1000000"; // 1 USDT (considering 6 decimals)
            const withdrawUsdtAmount = "500000"; // 0.5 USDT (considering 6 decimals)

            // Approve and deposit USDT to the contract
            await mockUSDT.approve(relayDepository.address, depositUsdtAmount, { from: user });
            await relayDepository['depositErc20(address,address,uint256,bytes32)'](
                user,
                mockUSDT.address,
                depositUsdtAmount,
                depositId,
                { from: user }
            );

            await new Promise(resolve => setTimeout(resolve, 8000));

            // Verify the contract has the USDT balance
            const contractBalance = await mockUSDT.balanceOf(relayDepository.address);
            assert.equal(contractBalance.toString(), depositUsdtAmount, "Contract should have the deposited USDT");

            // Record recipient balance before execution
            const recipientBalanceBefore = await mockUSDT.balanceOf(recipient);

            // EIP-712 signing payload for USDT transfer
            const callRequest = {
                calls: [
                    {
                        to: utils.address.toHex(mockUSDT.address),
                        data: '0xa9059cbb' + (utils.abi.encodeParamsV2ByABI(
                            {
                                "inputs": [
                                    {
                                        "internalType": "address",
                                        "name": "to",
                                        "type": "address"
                                    },
                                    {
                                        "internalType": "uint256",
                                        "name": "amount",
                                        "type": "uint256"
                                    }
                                ],
                                "name": "transfer",
                                "outputs": [
                                    {
                                        "internalType": "bool",
                                        "name": "",
                                        "type": "bool"
                                    }
                                ],
                                "stateMutability": "nonpayable",
                                "type": "function"
                            },
                            [recipient, withdrawUsdtAmount]
                        ).slice(2)),
                        value: 0, // No native token value for ERC20 transfers
                        allowFailure: false
                    }
                ],
                nonce: BigInt(Date.now()), // BigInt
                expiration: BigInt(Math.floor(Date.now() / 1000) + 8600) // BigInt
            };

            const domain = {
                name: 'RelayDepository',
                version: '1',
                // should read it from contract/rpc
                // chainId of tronbox/tre is 4934220514680046270111006746656907585893695859948601597743n,
                chainId: '0xC93BAA76A4A508F798A96F59156D9EB17ECEDE8EC845DF2F',
                verifyingContract: relayDepository.address
            };

            const types = {
                CallRequest: [
                    { name: 'calls', type: 'Call[]' },
                    { name: 'nonce', type: 'uint256' },
                    { name: 'expiration', type: 'uint256' }
                ],
                Call: [
                    { name: 'to', type: 'address' },
                    { name: 'data', type: 'bytes' },
                    { name: 'value', type: 'uint256' },
                    { name: 'allowFailure', type: 'bool' }
                ]
            };

            // Sign the request with allocator's private key
            const signature = await Trx._signTypedData(domain, types, callRequest, allocatorPrivateKey);
            console.log("Generated signature for USDT withdrawal:", signature);

            const isVerified = Trx.verifyTypedData(domain, types, callRequest, signature, allocator);
            console.log("isVerified:", isVerified);

            try {
                const tx = await relayDepository.execute(
                    [
                        // calls
                        callRequest.calls.map(c => [
                            c.to,
                            c.data,
                            c.value.toString(),
                            c.allowFailure
                        ]),
                        // nonce
                        callRequest.nonce.toString(),
                        // expiration
                        callRequest.expiration.toString()
                    ],
                    signature,
                    { from: user }
                );

                await new Promise(resolve => setTimeout(resolve, 8000));

                const receipt = await tronWeb.trx.getTransactionInfo(tx);

                // Verify transaction was successful
                assert.ok(receipt, "Transaction should be successful");

                // Verify recipient balance increase
                const recipientBalanceAfter = await mockUSDT.balanceOf(recipient);

                // Convert string balances to BigInt for comparison
                const balanceBefore = BigInt(recipientBalanceBefore);
                const balanceAfter = BigInt(recipientBalanceAfter);
                const balanceDiff = balanceAfter - balanceBefore;

                assert.equal(balanceDiff.toString(), withdrawUsdtAmount, "Recipient USDT balance should increase by the correct amount");

                // Verify contract balance decrease
                const contractBalanceAfter = await mockUSDT.balanceOf(relayDepository.address);
                const contractBalanceDiff = BigInt(contractBalance) - BigInt(contractBalanceAfter);
                assert.equal(contractBalanceDiff.toString(), withdrawUsdtAmount, "Contract USDT balance should decrease by the withdrawal amount");
            } catch (error) {
                console.error(error);
                assert.fail("USDT withdrawal should not fail");
            }

        });
    });
});
