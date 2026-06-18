import { decodeWithdrawal } from "@reservoir0x/relay-protocol-sdk";
import axios from "axios";
import { ethers } from "ethers";

const getEnv = (key) => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Environment variable ${key} is not set`);
  }
  return value;
};

const main = async () => {
  const rpcUrl = getEnv("RPC_URL");
  const protocolChainId = getEnv("PROTOCOL_CHAIN_ID");
  const relayProtocolOracleBaseUrl = getEnv("RELAY_PROTOCOL_ORACLE_BASE_URL");
  const relayProtocolHubBaseUrl = getEnv("RELAY_PROTOCOL_HUB_BASE_URL");
  const deployerPk = getEnv("DEPLOYER_PK");
  const depository = getEnv("DEPOSITORY");
  const depositAmount = getEnv("DEPOSIT_AMOUNT");

  const rpc = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(deployerPk).connect(rpc);

  // Trigger deposit deposit
  const depositTx = await wallet.sendTransaction({
    to: depository,
    value: ethers.parseEther(depositAmount),
    data: new ethers.Interface([
      "function depositNative(address,bytes32)",
    ]).encodeFunctionData("depositNative", [
      wallet.address,
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    ]),
  });
  console.log(`Deposit transaction sent: ${depositTx.hash}`);

  // Wait for finality
  await new Promise((resolve) => setTimeout(resolve, 70000));

  // Get oracle attestation
  const oracleResponse = await axios.post(
    `${relayProtocolOracleBaseUrl}/attestations/depository-deposits/v1`,
    {
      chainId: protocolChainId,
      transactionId: depositTx.hash,
    }
  );
  const message = oracleResponse.data.messages[0];
  console.log(
    `Received oracle attestation: ${message.data.chainId} - ${message.data.transactionId}`
  );

  // Forward attestation to hub
  await axios.post(
    `${relayProtocolHubBaseUrl}/actions/depository-deposits/v1`,
    {
      message: {
        data: message.data,
        result: message.result,
        signatures: [message.signature],
      },
    }
  );
  console.log(
    `Forwarded attestation to hub: ${message.data.chainId} - ${message.data.transactionId}`
  );

  // Request withdrawal
  const withdrawalRequest = await axios
    .post(`${relayProtocolHubBaseUrl}/requests/withdrawals/v1`, {
      ownerChainId: message.data.chainId,
      owner: message.result.depositor,
      chainId: message.data.chainId,
      currency: message.result.currency,
      amount: message.result.amount,
      recipient: message.result.depositor,
    })
    .then((response) => response.data);
  console.log(
    `Withdrawal request created: ${withdrawalRequest.encodedData} ${withdrawalRequest.signature}`
  );

  // Submit withdrawal
  const decodedWithdrawal = decodeWithdrawal(
    withdrawalRequest.encodedData,
    "ethereum-vm"
  );
  const withdrawalTx = await wallet.sendTransaction({
    to: depository,
    data: new ethers.Interface([
      "function execute(((address to, bytes data, uint256 value, bool allowFailure)[] calls, uint256 nonce, uint256 expiration) callRequest, bytes signature)",
    ]).encodeFunctionData("execute", [
      decodedWithdrawal.withdrawal,
      withdrawalRequest.signature,
    ]),
    value: "0",
  });
  console.log(`Withdrawal transaction sent: ${withdrawalTx.hash}`);
};
main();
