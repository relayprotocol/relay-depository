import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, LAMPORTS_PER_SOL, Keypair } from "@solana/web3.js";
import { assert } from "chai";

import { DepositAddress } from "../target/types/deposit_address";
import { RelayDepository } from "../target/types/relay_depository";

describe("Deposit Address", () => {
  // Configure the client to use the local cluster
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const depositAddressProgram = anchor.workspace
    .DepositAddress as Program<DepositAddress>;
  const relayDepositoryProgram = anchor.workspace
    .RelayDepository as Program<RelayDepository>;

  // Test accounts - owner must match AUTHORIZED_PUBKEY in the contract
  const owner = Keypair.fromSecretKey(
    Buffer.from(
      "5223911e0fbfb0b8d5880ebea5711d5d7754387950c08b52c0eaf127facebd455e28ef570e8aed9ecef8a89f5c1a90739080c05df9e9c8ca082376ef93a02b2e",
      "hex"
    )
  );
  const fakeOwner = Keypair.generate();
  const newOwner = Keypair.generate();
  const depositor = Keypair.generate();

  // PDAs
  let configPDA: PublicKey;
  let relayDepositoryPDA: PublicKey;
  let vaultPDA: PublicKey;

  const getDepositAddress = (
    id: number[],
    token: PublicKey = PublicKey.default
  ): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("deposit_address"),
        Buffer.from(id),
        token.toBuffer(),
      ],
      depositAddressProgram.programId
    );
  };

  const getEvents = async (signature: string) => {
    await provider.connection.confirmTransaction(signature);
    const tx = await provider.connection.getParsedTransaction(
      signature,
      "confirmed"
    );

    let events: anchor.Event[] = [];
    for (const logMessage of tx?.meta?.logMessages || []) {
      if (!logMessage.startsWith("Program data: ")) {
        continue;
      }
      const event = relayDepositoryProgram.coder.events.decode(
        logMessage.slice("Program data: ".length)
      );
      if (event) {
        events.push(event);
      }
    }
    return events;
  };

  before(async () => {
    // Airdrop SOL to test accounts
    const airdropPromises = [
      provider.connection.requestAirdrop(owner.publicKey, 10 * LAMPORTS_PER_SOL),
      provider.connection.requestAirdrop(fakeOwner.publicKey, 2 * LAMPORTS_PER_SOL),
      provider.connection.requestAirdrop(newOwner.publicKey, 2 * LAMPORTS_PER_SOL),
    ];

    const signatures = await Promise.all(airdropPromises);
    await Promise.all(
      signatures.map((sig) => provider.connection.confirmTransaction(sig))
    );

    // Find PDAs for deposit_address program
    [configPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      depositAddressProgram.programId
    );

    // Find PDAs for relay_depository program
    [relayDepositoryPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("relay_depository")],
      relayDepositoryProgram.programId
    );

    [vaultPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault")],
      relayDepositoryProgram.programId
    );

    // Initialize relay_depository first (required dependency)
    try {
      await relayDepositoryProgram.methods
        .initialize("solana-mainnet")
        .accountsPartial({
          relayDepository: relayDepositoryPDA,
          owner: owner.publicKey,
          allocator: owner.publicKey,
          vault: vaultPDA,
          systemProgram: SystemProgram.programId,
        })
        .signers([owner])
        .rpc();
    } catch (err) {
      // Already initialized
    }
  });

  it("Should fail to initialize with non-authorized owner", async () => {
    try {
      await depositAddressProgram.methods
        .initialize()
        .accountsPartial({
          config: configPDA,
          owner: fakeOwner.publicKey,
          relayDepository: relayDepositoryPDA,
          relayDepositoryProgram: relayDepositoryProgram.programId,
          vault: vaultPDA,
          systemProgram: SystemProgram.programId,
        })
        .signers([fakeOwner])
        .rpc();
      assert.fail("Should have thrown error");
    } catch (err) {
      assert.include(err.message, "Unauthorized");
    }
  });

  it("Should initialize config successfully", async () => {
    await depositAddressProgram.methods
      .initialize()
      .accountsPartial({
        config: configPDA,
        owner: owner.publicKey,
        relayDepository: relayDepositoryPDA,
        relayDepositoryProgram: relayDepositoryProgram.programId,
        vault: vaultPDA,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    const config = await depositAddressProgram.account.depositAddressConfig.fetch(
      configPDA
    );

    assert.ok(config.owner.equals(owner.publicKey));
    assert.ok(config.relayDepository.equals(relayDepositoryPDA));
    assert.ok(config.relayDepositoryProgram.equals(relayDepositoryProgram.programId));
    assert.ok(config.vault.equals(vaultPDA));
  });

  it("Should fail to re-initialize already initialized contract", async () => {
    try {
      await depositAddressProgram.methods
        .initialize()
        .accountsPartial({
          config: configPDA,
          owner: owner.publicKey,
          relayDepository: relayDepositoryPDA,
          relayDepositoryProgram: relayDepositoryProgram.programId,
          vault: vaultPDA,
          systemProgram: SystemProgram.programId,
        })
        .signers([owner])
        .rpc();
      assert.fail("Should have failed - contract already initialized");
    } catch (err) {
      assert.ok(true);
    }
  });

  it("Non-owner cannot set new owner", async () => {
    try {
      await depositAddressProgram.methods
        .setOwner(newOwner.publicKey)
        .accountsPartial({
          config: configPDA,
          owner: fakeOwner.publicKey,
        })
        .signers([fakeOwner])
        .rpc();
      assert.fail("Should have thrown error");
    } catch (err) {
      assert.include(err.message, "Unauthorized");
    }

    // Verify owner was not changed
    const config = await depositAddressProgram.account.depositAddressConfig.fetch(
      configPDA
    );
    assert.ok(config.owner.equals(owner.publicKey));
  });

  it("Owner can set new owner", async () => {
    await depositAddressProgram.methods
      .setOwner(newOwner.publicKey)
      .accountsPartial({
        config: configPDA,
        owner: owner.publicKey,
      })
      .signers([owner])
      .rpc();

    const config = await depositAddressProgram.account.depositAddressConfig.fetch(
      configPDA
    );
    assert.ok(config.owner.equals(newOwner.publicKey));

    // Transfer back
    await depositAddressProgram.methods
      .setOwner(owner.publicKey)
      .accountsPartial({
        config: configPDA,
        owner: newOwner.publicKey,
      })
      .signers([newOwner])
      .rpc();

    const configAfterReset = await depositAddressProgram.account.depositAddressConfig.fetch(
      configPDA
    );
    assert.ok(configAfterReset.owner.equals(owner.publicKey));
  });

  it("Sweep native", async () => {
    const id = Array.from(Keypair.generate().publicKey.toBytes());
    const [depositAddress] = getDepositAddress(id);

    const depositAmount = 1 * LAMPORTS_PER_SOL;

    // Fund the deposit address PDA with SOL
    await provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: provider.wallet.publicKey,
          toPubkey: depositAddress,
          lamports: depositAmount,
        })
      )
    );

    // Get initial vault balance
    const vaultBalanceBefore = await provider.connection.getBalance(vaultPDA);

    // Get rent-exempt minimum for the deposit address
    const rentExemptMinimum =
      await provider.connection.getMinimumBalanceForRentExemption(0);

    // Sweep native SOL
    const sweepTx = await depositAddressProgram.methods
      .sweepNative(id)
      .accountsPartial({
        config: configPDA,
        depositAddress,
        depositor: depositor.publicKey,
        relayDepository: relayDepositoryPDA,
        vault: vaultPDA,
        relayDepositoryProgram: relayDepositoryProgram.programId,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Verify vault received the SOL
    const vaultBalanceAfter = await provider.connection.getBalance(vaultPDA);
    const expectedAmount = depositAmount - rentExemptMinimum;
    assert.equal(
      vaultBalanceAfter - vaultBalanceBefore,
      expectedAmount
    );

    // Verify deposit address has only rent remaining
    const depositAddressBalance = await provider.connection.getBalance(
      depositAddress
    );
    assert.equal(depositAddressBalance, rentExemptMinimum);

    // Verify DepositEvent
    const events = await getEvents(sweepTx);
    const depositEvent = events.find((e) => e.name === "depositEvent");
    assert.exists(depositEvent);
    assert.equal(depositEvent?.data.amount.toNumber(), expectedAmount);
    assert.equal(
      depositEvent?.data.depositor.toBase58(),
      depositor.publicKey.toBase58()
    );
    assert.equal(depositEvent?.data.id.toString(), id.toString());
  });

  it("Should fail sweep native with insufficient balance", async () => {
    const id = Array.from(Keypair.generate().publicKey.toBytes());
    const [depositAddress] = getDepositAddress(id);

    // Fund deposit address with only rent-exempt minimum
    const rentExemptMinimum =
      await provider.connection.getMinimumBalanceForRentExemption(0);

    await provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: provider.wallet.publicKey,
          toPubkey: depositAddress,
          lamports: rentExemptMinimum,
        })
      )
    );

    try {
      await depositAddressProgram.methods
        .sweepNative(id)
        .accountsPartial({
          config: configPDA,
          depositAddress,
          depositor: depositor.publicKey,
          relayDepository: relayDepositoryPDA,
          vault: vaultPDA,
          relayDepositoryProgram: relayDepositoryProgram.programId,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      assert.fail("Should have thrown error");
    } catch (err) {
      assert.include(err.message, "Insufficient balance");
    }
  });

  it("Sweep native with different IDs produces different deposit addresses", async () => {
    const id1 = Array.from(Keypair.generate().publicKey.toBytes());
    const id2 = Array.from(Keypair.generate().publicKey.toBytes());
    const [depositAddress1] = getDepositAddress(id1);
    const [depositAddress2] = getDepositAddress(id2);

    assert.notEqual(
      depositAddress1.toBase58(),
      depositAddress2.toBase58()
    );
  });
});
