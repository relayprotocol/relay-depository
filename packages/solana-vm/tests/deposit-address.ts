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
  const executor = Keypair.generate();

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
      provider.connection.requestAirdrop(executor.publicKey, 2 * LAMPORTS_PER_SOL),
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

    // Verify DepositEvent
    const events = await getEvents(sweepTx);
    const depositEvent = events.find((e) => e.name === "depositEvent");
    assert.exists(depositEvent);
    assert.equal(depositEvent?.data.amount.toNumber(), depositAmount);
    assert.equal(
      depositEvent?.data.depositor.toBase58(),
      depositor.publicKey.toBase58()
    );
    assert.equal(depositEvent?.data.id.toString(), id.toString());
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

    // Verify DepositEvent
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

    // Verify DepositEvent
    const events = await getEvents(sweepTx);
    const depositEvent = events.find((e) => e.name === "depositEvent");
    assert.exists(depositEvent);
    assert.equal(depositEvent?.data.amount.toNumber(), depositAmount);
    assert.equal(depositEvent?.data.token.toBase58(), mint2022.toBase58());
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
});
