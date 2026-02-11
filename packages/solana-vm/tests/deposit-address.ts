import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, LAMPORTS_PER_SOL, Keypair } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAccount,
} from "@solana/spl-token";
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

  // Token accounts
  let mint: PublicKey;
  let mint2022: PublicKey;
  let vaultTokenAccount: PublicKey;
  let vault2022TokenAccount: PublicKey;

  const getDepositAddress = (
    id: number[],
    token: PublicKey = PublicKey.default,
    depositorPubkey: PublicKey = depositor.publicKey
  ): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("deposit_address"),
        Buffer.from(id),
        token.toBuffer(),
        depositorPubkey.toBuffer(),
      ],
      depositAddressProgram.programId
    );
  };

  const getAllowedProgramPDA = (programId: PublicKey): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("allowed_program"), programId.toBuffer()],
      depositAddressProgram.programId
    );
  };

  const getEvents = async (signature: string) => {
    await provider.connection.confirmTransaction(signature);
    let tx: Awaited<ReturnType<typeof provider.connection.getParsedTransaction>> = null;
    for (let i = 0; i < 10; i++) {
      tx = await provider.connection.getParsedTransaction(signature, "confirmed");
      if (tx?.meta?.logMessages) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    let events: anchor.Event[] = [];
    for (const logMessage of tx?.meta?.logMessages || []) {
      if (!logMessage.startsWith("Program data: ")) {
        continue;
      }
      const data = logMessage.slice("Program data: ".length);
      const event =
        depositAddressProgram.coder.events.decode(data) ||
        relayDepositoryProgram.coder.events.decode(data);
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
      provider.connection.requestAirdrop(depositor.publicKey, 2 * LAMPORTS_PER_SOL),
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

    // Create SPL Token mint
    mint = await createMint(
      provider.connection,
      owner,
      owner.publicKey,
      null,
      9
    );

    // Create Token2022 mint
    const mint2022Keypair = Keypair.generate();
    mint2022 = await createMint(
      provider.connection,
      owner,
      owner.publicKey,
      null,
      9,
      mint2022Keypair,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    // Get vault token accounts
    vaultTokenAccount = await getAssociatedTokenAddress(mint, vaultPDA, true);
    vault2022TokenAccount = await getAssociatedTokenAddress(
      mint2022,
      vaultPDA,
      true,
      TOKEN_2022_PROGRAM_ID
    );
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
    const tx = await depositAddressProgram.methods
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

    const events = await getEvents(tx);
    const initEvent = events.find((e) => e.name === "initializeEvent");
    assert.exists(initEvent);
    assert.equal(initEvent?.data.owner.toBase58(), owner.publicKey.toBase58());
    assert.equal(initEvent?.data.relayDepository.toBase58(), relayDepositoryPDA.toBase58());
    assert.equal(initEvent?.data.relayDepositoryProgram.toBase58(), relayDepositoryProgram.programId.toBase58());
    assert.equal(initEvent?.data.vault.toBase58(), vaultPDA.toBase58());
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
    const tx = await depositAddressProgram.methods
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

    const events = await getEvents(tx);
    const setOwnerEvent = events.find((e) => e.name === "setOwnerEvent");
    assert.exists(setOwnerEvent);
    assert.equal(setOwnerEvent?.data.previousOwner.toBase58(), owner.publicKey.toBase58());
    assert.equal(setOwnerEvent?.data.newOwner.toBase58(), newOwner.publicKey.toBase58());

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

  it("Non-owner cannot set depository", async () => {
    try {
      await depositAddressProgram.methods
        .setDepository()
        .accountsPartial({
          config: configPDA,
          owner: fakeOwner.publicKey,
          relayDepository: relayDepositoryPDA,
          relayDepositoryProgram: relayDepositoryProgram.programId,
          vault: vaultPDA,
        })
        .signers([fakeOwner])
        .rpc();
      assert.fail("Should have thrown error");
    } catch (err) {
      assert.include(err.message, "Unauthorized");
    }
  });

  it("Owner can set depository", async () => {
    // Read current config
    const configBefore = await depositAddressProgram.account.depositAddressConfig.fetch(
      configPDA
    );

    // Set depository (same values - just testing the instruction works)
    const tx = await depositAddressProgram.methods
      .setDepository()
      .accountsPartial({
        config: configPDA,
        owner: owner.publicKey,
        relayDepository: relayDepositoryPDA,
        relayDepositoryProgram: relayDepositoryProgram.programId,
        vault: vaultPDA,
      })
      .signers([owner])
      .rpc();

    // Verify config unchanged (same values)
    const configAfter = await depositAddressProgram.account.depositAddressConfig.fetch(
      configPDA
    );
    assert.ok(configAfter.relayDepository.equals(relayDepositoryPDA));
    assert.ok(configAfter.relayDepositoryProgram.equals(relayDepositoryProgram.programId));
    assert.ok(configAfter.vault.equals(vaultPDA));

    // Verify SetDepositoryEvent
    const events = await getEvents(tx);
    const event = events.find((e) => e.name === "setDepositoryEvent");
    assert.exists(event);
    assert.equal(event?.data.previousRelayDepository.toBase58(), configBefore.relayDepository.toBase58());
    assert.equal(event?.data.newRelayDepository.toBase58(), relayDepositoryPDA.toBase58());
    assert.equal(event?.data.previousVault.toBase58(), configBefore.vault.toBase58());
    assert.equal(event?.data.newVault.toBase58(), vaultPDA.toBase58());
  });

  it("Owner can add program to whitelist", async () => {
    const [allowedProgramPDA] = getAllowedProgramPDA(SystemProgram.programId);

    const tx = await depositAddressProgram.methods
      .addAllowedProgram()
      .accountsPartial({
        config: configPDA,
        owner: owner.publicKey,
        programToAdd: SystemProgram.programId,
        allowedProgram: allowedProgramPDA,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    const allowedProgram = await depositAddressProgram.account.allowedProgram.fetch(
      allowedProgramPDA
    );
    assert.ok(allowedProgram.programId.equals(SystemProgram.programId));

    const events = await getEvents(tx);
    const addEvent = events.find((e) => e.name === "addAllowedProgramEvent");
    assert.exists(addEvent);
    assert.equal(addEvent?.data.programId.toBase58(), SystemProgram.programId.toBase58());
  });

  it("Non-owner cannot add program to whitelist", async () => {
    const [allowedProgramPDA] = getAllowedProgramPDA(ASSOCIATED_TOKEN_PROGRAM_ID);

    try {
      await depositAddressProgram.methods
        .addAllowedProgram()
        .accountsPartial({
          config: configPDA,
          owner: fakeOwner.publicKey,
          programToAdd: ASSOCIATED_TOKEN_PROGRAM_ID,
          allowedProgram: allowedProgramPDA,
          systemProgram: SystemProgram.programId,
        })
        .signers([fakeOwner])
        .rpc();
      assert.fail("Should have thrown error");
    } catch (err) {
      assert.include(err.message, "Unauthorized");
    }
  });

  it("Owner can add TOKEN_PROGRAM_ID to whitelist", async () => {
    const [allowedProgramPDA] = getAllowedProgramPDA(TOKEN_PROGRAM_ID);

    await depositAddressProgram.methods
      .addAllowedProgram()
      .accountsPartial({
        config: configPDA,
        owner: owner.publicKey,
        programToAdd: TOKEN_PROGRAM_ID,
        allowedProgram: allowedProgramPDA,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    const allowedProgram = await depositAddressProgram.account.allowedProgram.fetch(
      allowedProgramPDA
    );
    assert.ok(allowedProgram.programId.equals(TOKEN_PROGRAM_ID));
  });

  it("Cannot add same program twice", async () => {
    const [allowedProgramPDA] = getAllowedProgramPDA(SystemProgram.programId);

    try {
      await depositAddressProgram.methods
        .addAllowedProgram()
        .accountsPartial({
          config: configPDA,
          owner: owner.publicKey,
          programToAdd: SystemProgram.programId,
          allowedProgram: allowedProgramPDA,
          systemProgram: SystemProgram.programId,
        })
        .signers([owner])
        .rpc();
      assert.fail("Should have thrown error - program already added");
    } catch (err) {
      // Account already exists
      assert.ok(true);
    }
  });

  it("Owner can remove program from whitelist", async () => {
    // Add a program first (must be executable)
    const testProgram = ASSOCIATED_TOKEN_PROGRAM_ID;
    const [allowedProgramPDA] = getAllowedProgramPDA(testProgram);

    await depositAddressProgram.methods
      .addAllowedProgram()
      .accountsPartial({
        config: configPDA,
        owner: owner.publicKey,
        programToAdd: testProgram,
        allowedProgram: allowedProgramPDA,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    // Verify it was added
    const allowedBefore = await depositAddressProgram.account.allowedProgram.fetch(
      allowedProgramPDA
    );
    assert.ok(allowedBefore.programId.equals(testProgram));

    // Remove it
    const removeTx = await depositAddressProgram.methods
      .removeAllowedProgram()
      .accountsPartial({
        config: configPDA,
        owner: owner.publicKey,
        allowedProgram: allowedProgramPDA,
      })
      .signers([owner])
      .rpc();

    // Verify it was removed
    try {
      await depositAddressProgram.account.allowedProgram.fetch(allowedProgramPDA);
      assert.fail("Account should have been closed");
    } catch (err) {
      assert.ok(true);
    }

    const removeEvents = await getEvents(removeTx);
    const removeEvent = removeEvents.find((e) => e.name === "removeAllowedProgramEvent");
    assert.exists(removeEvent);
    assert.equal(removeEvent?.data.programId.toBase58(), testProgram.toBase58());
  });

  it("Non-owner cannot remove program from whitelist", async () => {
    const [allowedProgramPDA] = getAllowedProgramPDA(SystemProgram.programId);

    try {
      await depositAddressProgram.methods
        .removeAllowedProgram()
        .accountsPartial({
          config: configPDA,
          owner: fakeOwner.publicKey,
          allowedProgram: allowedProgramPDA,
        })
        .signers([fakeOwner])
        .rpc();
      assert.fail("Should have thrown error");
    } catch (err) {
      assert.include(err.message, "Unauthorized");
    }
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

    // Sweep native SOL
    const sweepTx = await depositAddressProgram.methods
      .sweepNative(id)
      .accountsPartial({
        config: configPDA,
        depositor: depositor.publicKey,
        depositAddress,
        relayDepository: relayDepositoryPDA,
        vault: vaultPDA,
        relayDepositoryProgram: relayDepositoryProgram.programId,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Verify vault received full deposit amount
    const vaultBalanceAfter = await provider.connection.getBalance(vaultPDA);
    assert.equal(vaultBalanceAfter - vaultBalanceBefore, depositAmount);

    // Verify deposit address is empty (account may be garbage collected)
    const depositAddressBalance = await provider.connection.getBalance(
      depositAddress
    );
    assert.equal(depositAddressBalance, 0);

    // Verify DepositEvent (from relay_depository CPI)
    const events = await getEvents(sweepTx);
    const depositEvent = events.find((e) => e.name === "depositEvent");
    assert.exists(depositEvent);
    assert.equal(depositEvent?.data.amount.toNumber(), depositAmount);
    assert.equal(
      depositEvent?.data.depositor.toBase58(),
      depositor.publicKey.toBase58()
    );
    assert.equal(depositEvent?.data.id.toString(), id.toString());

    // Verify SweepNativeEvent (from deposit-address)
    const sweepEvent = events.find((e) => e.name === "sweepNativeEvent");
    assert.exists(sweepEvent);
    assert.equal(sweepEvent?.data.amount.toNumber(), depositAmount);
    assert.equal(sweepEvent?.data.depositor.toBase58(), depositor.publicKey.toBase58());
    assert.equal(sweepEvent?.data.depositAddress.toBase58(), depositAddress.toBase58());
    assert.equal(sweepEvent?.data.id.toString(), id.toString());
  });

  it("Should fail sweep native with zero balance", async () => {
    const id = Array.from(Keypair.generate().publicKey.toBytes());
    const [depositAddress] = getDepositAddress(id);

    // Don't fund the deposit address - it has zero balance

    try {
      await depositAddressProgram.methods
        .sweepNative(id)
        .accountsPartial({
          config: configPDA,
          depositor: depositor.publicKey,
          depositAddress,
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

  it("Sweep token", async () => {
    const id = Array.from(Keypair.generate().publicKey.toBytes());
    const [depositAddress] = getDepositAddress(id, mint);

    const depositAmount = 1_000_000_000;

    // Create deposit address token account and fund it
    const depositAddressTokenAccount = await getAssociatedTokenAddress(
      mint,
      depositAddress,
      true
    );

    // Create owner's token account and mint tokens
    const ownerTokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      owner,
      mint,
      owner.publicKey
    );

    await mintTo(
      provider.connection,
      owner,
      mint,
      ownerTokenAccount,
      owner,
      depositAmount
    );

    // Create deposit address ATA and transfer tokens
    await provider.sendAndConfirm(
      new anchor.web3.Transaction()
        .add(
          createAssociatedTokenAccountInstruction(
            owner.publicKey,
            depositAddressTokenAccount,
            depositAddress,
            mint
          )
        )
        .add(
          createTransferInstruction(
            ownerTokenAccount,
            depositAddressTokenAccount,
            owner.publicKey,
            depositAmount
          )
        ),
      [owner]
    );

    // Create vault token account if needed
    try {
      await getAccount(provider.connection, vaultTokenAccount);
    } catch {
      await provider.sendAndConfirm(
        new anchor.web3.Transaction().add(
          createAssociatedTokenAccountInstruction(
            owner.publicKey,
            vaultTokenAccount,
            vaultPDA,
            mint
          )
        ),
        [owner]
      );
    }

    // Get initial balances
    const vaultBalanceBefore = await provider.connection
      .getTokenAccountBalance(vaultTokenAccount)
      .then((res) => Number(res.value.amount))
      .catch(() => 0);

    const depositorBalanceBefore = await provider.connection.getBalance(
      depositor.publicKey
    );

    // Sweep token (depositor receives ATA rent)
    const sweepTx = await depositAddressProgram.methods
      .sweepToken(id)
      .accountsPartial({
        config: configPDA,
        depositor: depositor.publicKey,
        depositAddress,
        mint,
        depositAddressTokenAccount,
        relayDepository: relayDepositoryPDA,
        vault: vaultPDA,
        vaultTokenAccount,
        relayDepositoryProgram: relayDepositoryProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Verify vault received the tokens
    const vaultBalanceAfter = await provider.connection
      .getTokenAccountBalance(vaultTokenAccount)
      .then((res) => Number(res.value.amount));
    assert.equal(vaultBalanceAfter - vaultBalanceBefore, depositAmount);

    // Verify depositor received the ATA rent
    const depositorBalanceAfter = await provider.connection.getBalance(
      depositor.publicKey
    );
    assert.isAbove(depositorBalanceAfter, depositorBalanceBefore);

    // Verify deposit address token account no longer exists
    try {
      await getAccount(provider.connection, depositAddressTokenAccount);
      assert.fail("Token account should have been closed");
    } catch (err) {
      assert.ok(true);
    }

    // Verify DepositEvent (from relay_depository CPI)
    const events = await getEvents(sweepTx);
    const depositEvent = events.find((e) => e.name === "depositEvent");
    assert.exists(depositEvent);
    assert.equal(depositEvent?.data.amount.toNumber(), depositAmount);
    assert.equal(
      depositEvent?.data.depositor.toBase58(),
      depositor.publicKey.toBase58()
    );
    assert.equal(depositEvent?.data.id.toString(), id.toString());
    assert.equal(depositEvent?.data.token.toBase58(), mint.toBase58());

    // Verify SweepTokenEvent (from deposit-address)
    const sweepEvent = events.find((e) => e.name === "sweepTokenEvent");
    assert.exists(sweepEvent);
    assert.equal(sweepEvent?.data.amount.toNumber(), depositAmount);
    assert.equal(sweepEvent?.data.depositor.toBase58(), depositor.publicKey.toBase58());
    assert.equal(sweepEvent?.data.depositAddress.toBase58(), depositAddress.toBase58());
    assert.equal(sweepEvent?.data.mint.toBase58(), mint.toBase58());
    assert.equal(sweepEvent?.data.id.toString(), id.toString());
  });

  it("Sweep token2022", async () => {
    const id = Array.from(Keypair.generate().publicKey.toBytes());
    const [depositAddress] = getDepositAddress(id, mint2022);

    const depositAmount = 1_000_000_000;

    // Create deposit address token account
    const depositAddressTokenAccount = await getAssociatedTokenAddress(
      mint2022,
      depositAddress,
      true,
      TOKEN_2022_PROGRAM_ID
    );

    // Create owner's token account and mint tokens
    const ownerTokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      owner,
      mint2022,
      owner.publicKey,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    await mintTo(
      provider.connection,
      owner,
      mint2022,
      ownerTokenAccount,
      owner,
      depositAmount,
      [],
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    // Create deposit address ATA and transfer tokens
    await provider.sendAndConfirm(
      new anchor.web3.Transaction()
        .add(
          createAssociatedTokenAccountInstruction(
            owner.publicKey,
            depositAddressTokenAccount,
            depositAddress,
            mint2022,
            TOKEN_2022_PROGRAM_ID
          )
        )
        .add(
          createTransferInstruction(
            ownerTokenAccount,
            depositAddressTokenAccount,
            owner.publicKey,
            depositAmount,
            [],
            TOKEN_2022_PROGRAM_ID
          )
        ),
      [owner]
    );

    // Create vault token account if needed
    try {
      await getAccount(provider.connection, vault2022TokenAccount, undefined, TOKEN_2022_PROGRAM_ID);
    } catch {
      await provider.sendAndConfirm(
        new anchor.web3.Transaction().add(
          createAssociatedTokenAccountInstruction(
            owner.publicKey,
            vault2022TokenAccount,
            vaultPDA,
            mint2022,
            TOKEN_2022_PROGRAM_ID
          )
        ),
        [owner]
      );
    }

    // Get initial vault balance
    const vaultBalanceBefore = await provider.connection
      .getTokenAccountBalance(vault2022TokenAccount)
      .then((res) => Number(res.value.amount))
      .catch(() => 0);

    // Sweep token2022
    const sweepTx = await depositAddressProgram.methods
      .sweepToken(id)
      .accountsPartial({
        config: configPDA,
        depositor: depositor.publicKey,
        depositAddress,
        mint: mint2022,
        depositAddressTokenAccount,
        relayDepository: relayDepositoryPDA,
        vault: vaultPDA,
        vaultTokenAccount: vault2022TokenAccount,
        relayDepositoryProgram: relayDepositoryProgram.programId,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Verify vault received the tokens
    const vaultBalanceAfter = await provider.connection
      .getTokenAccountBalance(vault2022TokenAccount)
      .then((res) => Number(res.value.amount));
    assert.equal(vaultBalanceAfter - vaultBalanceBefore, depositAmount);

    // Verify DepositEvent (from relay_depository CPI)
    const events = await getEvents(sweepTx);
    const depositEvent = events.find((e) => e.name === "depositEvent");
    assert.exists(depositEvent);
    assert.equal(depositEvent?.data.amount.toNumber(), depositAmount);
    assert.equal(depositEvent?.data.token.toBase58(), mint2022.toBase58());

    // Verify SweepTokenEvent (from deposit-address)
    const sweepEvent = events.find((e) => e.name === "sweepTokenEvent");
    assert.exists(sweepEvent);
    assert.equal(sweepEvent?.data.amount.toNumber(), depositAmount);
    assert.equal(sweepEvent?.data.mint.toBase58(), mint2022.toBase58());
  });

  it("Should fail sweep token with zero balance", async () => {
    const id = Array.from(Keypair.generate().publicKey.toBytes());
    const [depositAddress] = getDepositAddress(id, mint);

    // Create deposit address token account with zero balance
    const depositAddressTokenAccount = await getAssociatedTokenAddress(
      mint,
      depositAddress,
      true
    );

    await provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        createAssociatedTokenAccountInstruction(
          owner.publicKey,
          depositAddressTokenAccount,
          depositAddress,
          mint
        )
      ),
      [owner]
    );

    try {
      await depositAddressProgram.methods
        .sweepToken(id)
        .accountsPartial({
          config: configPDA,
          depositor: depositor.publicKey,
          depositAddress,
          mint,
          depositAddressTokenAccount,
          relayDepository: relayDepositoryPDA,
          vault: vaultPDA,
          vaultTokenAccount,
          relayDepositoryProgram: relayDepositoryProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      assert.fail("Should have thrown error");
    } catch (err) {
      assert.include(err.message, "Insufficient balance");
    }
  });

  it("Sweep token with different mints produces different deposit addresses", async () => {
    const id = Array.from(Keypair.generate().publicKey.toBytes());
    const [depositAddress1] = getDepositAddress(id, mint);
    const [depositAddress2] = getDepositAddress(id, mint2022);
    const [depositAddressNative] = getDepositAddress(id);

    assert.notEqual(depositAddress1.toBase58(), depositAddress2.toBase58());
    assert.notEqual(depositAddress1.toBase58(), depositAddressNative.toBase58());
    assert.notEqual(depositAddress2.toBase58(), depositAddressNative.toBase58());
  });

  it("Different depositors produce different deposit addresses", async () => {
    const id = Array.from(Keypair.generate().publicKey.toBytes());
    const depositor1 = Keypair.generate();
    const depositor2 = Keypair.generate();

    const [depositAddress1] = getDepositAddress(id, PublicKey.default, depositor1.publicKey);
    const [depositAddress2] = getDepositAddress(id, PublicKey.default, depositor2.publicKey);

    assert.notEqual(depositAddress1.toBase58(), depositAddress2.toBase58());
  });

  it("Should fail sweep native with wrong depositor", async () => {
    const id = Array.from(Keypair.generate().publicKey.toBytes());
    const wrongDepositor = Keypair.generate();
    const [depositAddress] = getDepositAddress(id);

    const depositAmount = 1 * LAMPORTS_PER_SOL;

    // Fund the correct deposit address
    await provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: provider.wallet.publicKey,
          toPubkey: depositAddress,
          lamports: depositAmount,
        })
      )
    );

    // Try to sweep with wrong depositor - should fail PDA verification
    try {
      await depositAddressProgram.methods
        .sweepNative(id)
        .accountsPartial({
          config: configPDA,
          depositor: wrongDepositor.publicKey,
          depositAddress, // This PDA was derived with correct depositor
          relayDepository: relayDepositoryPDA,
          vault: vaultPDA,
          relayDepositoryProgram: relayDepositoryProgram.programId,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      assert.fail("Should have thrown error");
    } catch (err) {
      assert.include(err.message, "ConstraintSeeds");
    }
  });

  it("Should fail sweep token with wrong depositor", async () => {
    const id = Array.from(Keypair.generate().publicKey.toBytes());
    const wrongDepositor = Keypair.generate();
    const [depositAddress] = getDepositAddress(id, mint);

    const depositAmount = 1_000_000_000;

    // Create deposit address token account
    const depositAddressTokenAccount = await getAssociatedTokenAddress(
      mint,
      depositAddress,
      true
    );

    // Create owner's token account and mint tokens
    let ownerTokenAccount: PublicKey;
    try {
      ownerTokenAccount = await createAssociatedTokenAccount(
        provider.connection,
        owner,
        mint,
        owner.publicKey
      );
    } catch {
      ownerTokenAccount = await getAssociatedTokenAddress(mint, owner.publicKey);
    }

    await mintTo(
      provider.connection,
      owner,
      mint,
      ownerTokenAccount,
      owner,
      depositAmount
    );

    // Create deposit address ATA and transfer tokens
    await provider.sendAndConfirm(
      new anchor.web3.Transaction()
        .add(
          createAssociatedTokenAccountInstruction(
            owner.publicKey,
            depositAddressTokenAccount,
            depositAddress,
            mint
          )
        )
        .add(
          createTransferInstruction(
            ownerTokenAccount,
            depositAddressTokenAccount,
            owner.publicKey,
            depositAmount
          )
        ),
      [owner]
    );

    // Try to sweep with wrong depositor - should fail PDA verification
    try {
      await depositAddressProgram.methods
        .sweepToken(id)
        .accountsPartial({
          config: configPDA,
          depositor: wrongDepositor.publicKey,
          depositAddress, // This PDA was derived with correct depositor
          mint,
          depositAddressTokenAccount,
          relayDepository: relayDepositoryPDA,
          vault: vaultPDA,
          vaultTokenAccount,
          relayDepositoryProgram: relayDepositoryProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      assert.fail("Should have thrown error");
    } catch (err) {
      assert.include(err.message, "ConstraintSeeds");
    }
  });

  it("Owner can execute CPI from deposit address", async () => {
    const id = Array.from(Keypair.generate().publicKey.toBytes());
    const token = PublicKey.default;
    const [depositAddress] = getDepositAddress(id, token);
    const [allowedProgramPDA] = getAllowedProgramPDA(SystemProgram.programId);

    const depositAmount = 1 * LAMPORTS_PER_SOL;
    const transferAmount = 0.5 * LAMPORTS_PER_SOL;

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

    // Get initial recipient balance
    const recipient = Keypair.generate();
    const recipientBalanceBefore = await provider.connection.getBalance(
      recipient.publicKey
    );

    // Build transfer instruction data (SystemProgram.transfer)
    // Instruction index 2 = Transfer, followed by u64 amount (little endian)
    const instructionData = Buffer.alloc(12);
    instructionData.writeUInt32LE(2, 0); // Transfer instruction
    instructionData.writeBigUInt64LE(BigInt(transferAmount), 4);

    // Execute transfer via owner (SystemProgram is already whitelisted)
    const executeTx = await depositAddressProgram.methods
      .execute(
        id,
        token,
        depositor.publicKey,
        instructionData
      )
      .accountsPartial({
        config: configPDA,
        owner: owner.publicKey,
        depositAddress,
        allowedProgram: allowedProgramPDA,
        targetProgram: SystemProgram.programId,
      })
      .remainingAccounts([
        { pubkey: depositAddress, isSigner: false, isWritable: true },
        { pubkey: recipient.publicKey, isSigner: false, isWritable: true },
      ])
      .signers([owner])
      .rpc();

    // Verify recipient received the SOL
    const recipientBalanceAfter = await provider.connection.getBalance(
      recipient.publicKey
    );
    assert.equal(recipientBalanceAfter - recipientBalanceBefore, transferAmount);

    // Verify ExecuteEvent
    const events = await getEvents(executeTx);
    const executeEvent = events.find((e) => e.name === "executeEvent");
    assert.exists(executeEvent);
    assert.equal(executeEvent?.data.id.toString(), id.toString());
    assert.equal(executeEvent?.data.token.toBase58(), token.toBase58());
    assert.equal(executeEvent?.data.depositor.toBase58(), depositor.publicKey.toBase58());
    assert.equal(executeEvent?.data.targetProgram.toBase58(), SystemProgram.programId.toBase58());
  });

  it("Non-owner cannot execute CPI", async () => {
    const id = Array.from(Keypair.generate().publicKey.toBytes());
    const token = PublicKey.default;
    const [depositAddress] = getDepositAddress(id, token);
    const [allowedProgramPDA] = getAllowedProgramPDA(SystemProgram.programId);

    // Fund the deposit address PDA with SOL
    await provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: provider.wallet.publicKey,
          toPubkey: depositAddress,
          lamports: 0.1 * LAMPORTS_PER_SOL,
        })
      )
    );

    const instructionData = Buffer.alloc(12);
    instructionData.writeUInt32LE(2, 0);
    instructionData.writeBigUInt64LE(BigInt(0.05 * LAMPORTS_PER_SOL), 4);

    try {
      await depositAddressProgram.methods
        .execute(
          id,
          token,
          depositor.publicKey,
          instructionData
        )
        .accountsPartial({
          config: configPDA,
          owner: fakeOwner.publicKey,
          depositAddress,
          allowedProgram: allowedProgramPDA,
          targetProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: depositAddress, isSigner: false, isWritable: true },
          { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
        ])
        .signers([fakeOwner])
        .rpc();
      assert.fail("Should have thrown error");
    } catch (err) {
      assert.include(err.message, "Unauthorized");
    }
  });

  it("Execute fails with wrong token parameter", async () => {
    const id = Array.from(Keypair.generate().publicKey.toBytes());
    const token = PublicKey.default;
    const wrongToken = mint; // Use SPL token instead of native
    const [depositAddress] = getDepositAddress(id, token);
    const [allowedProgramPDA] = getAllowedProgramPDA(SystemProgram.programId);

    // Fund the deposit address
    await provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: provider.wallet.publicKey,
          toPubkey: depositAddress,
          lamports: 0.1 * LAMPORTS_PER_SOL,
        })
      )
    );

    const instructionData = Buffer.alloc(12);
    instructionData.writeUInt32LE(2, 0);
    instructionData.writeBigUInt64LE(BigInt(0.01 * LAMPORTS_PER_SOL), 4);

    try {
      await depositAddressProgram.methods
        .execute(
          id,
          wrongToken, // Wrong token parameter
          depositor.publicKey,
          instructionData
        )
        .accountsPartial({
          config: configPDA,
          owner: owner.publicKey,
          depositAddress,
          allowedProgram: allowedProgramPDA,
          targetProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: depositAddress, isSigner: false, isWritable: true },
          { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
        ])
        .signers([owner])
        .rpc();
      assert.fail("Should have thrown error");
    } catch (err) {
      assert.include(err.message, "ConstraintSeeds");
    }
  });

  it("Execute fails with wrong depositor parameter", async () => {
    const id = Array.from(Keypair.generate().publicKey.toBytes());
    const token = PublicKey.default;
    const wrongDepositor = Keypair.generate();
    const [depositAddress] = getDepositAddress(id, token);
    const [allowedProgramPDA] = getAllowedProgramPDA(SystemProgram.programId);

    // Fund the deposit address
    await provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: provider.wallet.publicKey,
          toPubkey: depositAddress,
          lamports: 0.1 * LAMPORTS_PER_SOL,
        })
      )
    );

    const instructionData = Buffer.alloc(12);
    instructionData.writeUInt32LE(2, 0);
    instructionData.writeBigUInt64LE(BigInt(0.01 * LAMPORTS_PER_SOL), 4);

    try {
      await depositAddressProgram.methods
        .execute(
          id,
          token,
          wrongDepositor.publicKey, // Wrong depositor parameter
          instructionData
        )
        .accountsPartial({
          config: configPDA,
          owner: owner.publicKey,
          depositAddress,
          allowedProgram: allowedProgramPDA,
          targetProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: depositAddress, isSigner: false, isWritable: true },
          { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
        ])
        .signers([owner])
        .rpc();
      assert.fail("Should have thrown error");
    } catch (err) {
      assert.include(err.message, "ConstraintSeeds");
    }
  });

  it("Execute can transfer SPL tokens", async () => {
    const id = Array.from(Keypair.generate().publicKey.toBytes());
    const [depositAddress] = getDepositAddress(id, mint);
    const [allowedProgramPDA] = getAllowedProgramPDA(TOKEN_PROGRAM_ID);

    const depositAmount = 1_000_000_000;
    const transferAmount = 500_000_000;

    // Create deposit address token account
    const depositAddressTokenAccount = await getAssociatedTokenAddress(
      mint,
      depositAddress,
      true
    );

    // Create owner's token account and mint tokens
    let ownerTokenAccount: PublicKey;
    try {
      ownerTokenAccount = await createAssociatedTokenAccount(
        provider.connection,
        owner,
        mint,
        owner.publicKey
      );
    } catch {
      ownerTokenAccount = await getAssociatedTokenAddress(mint, owner.publicKey);
    }

    await mintTo(
      provider.connection,
      owner,
      mint,
      ownerTokenAccount,
      owner,
      depositAmount
    );

    // Create deposit address ATA and transfer tokens
    await provider.sendAndConfirm(
      new anchor.web3.Transaction()
        .add(
          createAssociatedTokenAccountInstruction(
            owner.publicKey,
            depositAddressTokenAccount,
            depositAddress,
            mint
          )
        )
        .add(
          createTransferInstruction(
            ownerTokenAccount,
            depositAddressTokenAccount,
            owner.publicKey,
            depositAmount
          )
        ),
      [owner]
    );

    // Create recipient token account
    const recipient = Keypair.generate();
    const recipientTokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      owner,
      mint,
      recipient.publicKey
    );

    // Build SPL token transfer instruction data
    // Instruction 3 = Transfer, amount as u64 little endian
    const instructionData = Buffer.alloc(9);
    instructionData.writeUInt8(3, 0); // Transfer instruction
    instructionData.writeBigUInt64LE(BigInt(transferAmount), 1);

    // Execute token transfer (TOKEN_PROGRAM_ID is already whitelisted)
    await depositAddressProgram.methods
      .execute(
        id,
        mint,
        depositor.publicKey,
        instructionData
      )
      .accountsPartial({
        config: configPDA,
        owner: owner.publicKey,
        depositAddress,
        allowedProgram: allowedProgramPDA,
        targetProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts([
        { pubkey: depositAddressTokenAccount, isSigner: false, isWritable: true },
        { pubkey: recipientTokenAccount, isSigner: false, isWritable: true },
        { pubkey: depositAddress, isSigner: false, isWritable: false },
      ])
      .signers([owner])
      .rpc();

    // Verify recipient received the tokens
    const recipientBalance = await provider.connection.getTokenAccountBalance(
      recipientTokenAccount
    );
    assert.equal(Number(recipientBalance.value.amount), transferAmount);
  });

  it("Execute can close token account", async () => {
    const id = Array.from(Keypair.generate().publicKey.toBytes());
    const [depositAddress] = getDepositAddress(id, mint);
    const [allowedProgramPDA] = getAllowedProgramPDA(TOKEN_PROGRAM_ID);

    // Create deposit address token account (empty)
    const depositAddressTokenAccount = await getAssociatedTokenAddress(
      mint,
      depositAddress,
      true
    );

    await provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        createAssociatedTokenAccountInstruction(
          owner.publicKey,
          depositAddressTokenAccount,
          depositAddress,
          mint
        )
      ),
      [owner]
    );

    // Verify token account exists
    const accountBefore = await getAccount(provider.connection, depositAddressTokenAccount);
    assert.ok(accountBefore);

    // Get depositor balance before
    const depositorBalanceBefore = await provider.connection.getBalance(depositor.publicKey);

    // Build close account instruction data
    // Instruction 9 = CloseAccount
    const instructionData = Buffer.alloc(1);
    instructionData.writeUInt8(9, 0);

    // Execute close account (TOKEN_PROGRAM_ID is already whitelisted)
    await depositAddressProgram.methods
      .execute(
        id,
        mint,
        depositor.publicKey,
        instructionData
      )
      .accountsPartial({
        config: configPDA,
        owner: owner.publicKey,
        depositAddress,
        allowedProgram: allowedProgramPDA,
        targetProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts([
        { pubkey: depositAddressTokenAccount, isSigner: false, isWritable: true },
        { pubkey: depositor.publicKey, isSigner: false, isWritable: true },
        { pubkey: depositAddress, isSigner: false, isWritable: false },
      ])
      .signers([owner])
      .rpc();

    // Verify token account is closed
    try {
      await getAccount(provider.connection, depositAddressTokenAccount);
      assert.fail("Token account should have been closed");
    } catch (err) {
      assert.ok(true);
    }

    // Verify depositor received rent
    const depositorBalanceAfter = await provider.connection.getBalance(depositor.publicKey);
    assert.isAbove(depositorBalanceAfter, depositorBalanceBefore);
  });

  it("Execute fails with non-whitelisted program", async () => {
    const id = Array.from(Keypair.generate().publicKey.toBytes());
    const token = PublicKey.default;
    const [depositAddress] = getDepositAddress(id, token);
    const nonWhitelistedProgram = Keypair.generate().publicKey;
    const [invalidAllowedProgramPDA] = getAllowedProgramPDA(nonWhitelistedProgram);

    // Fund the deposit address
    await provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: provider.wallet.publicKey,
          toPubkey: depositAddress,
          lamports: 0.1 * LAMPORTS_PER_SOL,
        })
      )
    );

    const instructionData = Buffer.alloc(12);
    instructionData.writeUInt32LE(2, 0);
    instructionData.writeBigUInt64LE(BigInt(0.01 * LAMPORTS_PER_SOL), 4);

    try {
      await depositAddressProgram.methods
        .execute(
          id,
          token,
          depositor.publicKey,
          instructionData
        )
        .accountsPartial({
          config: configPDA,
          owner: owner.publicKey,
          depositAddress,
          allowedProgram: invalidAllowedProgramPDA,
          targetProgram: nonWhitelistedProgram,
        })
        .remainingAccounts([
          { pubkey: depositAddress, isSigner: false, isWritable: true },
          { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
        ])
        .signers([owner])
        .rpc();
      assert.fail("Should have thrown error - program not whitelisted");
    } catch (err) {
      // The allowed_program PDA doesn't exist, so it will fail with AccountNotInitialized
      assert.ok(err.message.includes("AccountNotInitialized") || err.message.includes("Account does not exist"));
    }
  });
});
