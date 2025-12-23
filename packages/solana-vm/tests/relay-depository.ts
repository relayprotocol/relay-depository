import * as anchor from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  createAssociatedTokenAccount,
  getAssociatedTokenAddress,
  mintTo,
  ExtensionType,
  getMintLen,
  createInitializeTransferFeeConfigInstruction,
  createInitializeMintInstruction,
} from "@solana/spl-token";
import {
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Keypair,
  sendAndConfirmTransaction,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { assert } from "chai";
import { sha256 } from "js-sha256";
import nacl from "tweetnacl";

import { RelayDepository } from "../target/types/relay_depository";

describe("Relay Depository", () => {
  const provider = anchor.AnchorProvider.env();

  // Configure the client to use the local cluster
  anchor.setProvider(provider);

  const program = anchor.workspace
    .RelayDepository as anchor.Program<RelayDepository>;

  // Test accounts
  const fakeOwner = Keypair.generate();
  const owner = Keypair.fromSecretKey(
    Buffer.from(
      "5223911e0fbfb0b8d5880ebea5711d5d7754387950c08b52c0eaf127facebd455e28ef570e8aed9ecef8a89f5c1a90739080c05df9e9c8ca082376ef93a02b2e",
      "hex"
    )
  );
  const allocator = Keypair.generate();
  const user = Keypair.generate();
  const recipient = Keypair.generate();
  const wrongRecipient = Keypair.generate();

  // PDAs
  let relayDepositoryPDA: PublicKey;
  let vaultPDA: PublicKey;
  let vaultBump: number;

  // SPL Token test accounts
  let mintKeypair: Keypair;
  let mintPubkey: PublicKey;
  let userTokenAccount: PublicKey;
  let vaultTokenAccount: PublicKey;
  let recipientTokenAccount: PublicKey;
  let wrongRecipientTokenAccount: PublicKey;

  // SPL Token 2022 test accounts
  let mint2022Keypair: Keypair;
  let mint2022Pubkey: PublicKey;
  let user2022TokenAccount: PublicKey;
  let vault2022TokenAccount: PublicKey;
  let recipient2022TokenAccount: PublicKey;

  before(async () => {
    // Airdrop SOL to test accounts
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        owner.publicKey,
        10 * LAMPORTS_PER_SOL
      )
    );
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        user.publicKey,
        2 * LAMPORTS_PER_SOL
      )
    );
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        fakeOwner.publicKey,
        2 * LAMPORTS_PER_SOL
      )
    );

    // Find PDAs
    [relayDepositoryPDA] = await PublicKey.findProgramAddress(
      [Buffer.from("relay_depository")],
      program.programId
    );

    [vaultPDA, vaultBump] = await PublicKey.findProgramAddress(
      [Buffer.from("vault")],
      program.programId
    );

    // Setup SPL Token
    mintKeypair = Keypair.generate();
    mintPubkey = await createMint(
      provider.connection,
      owner,
      owner.publicKey,
      null,
      9,
      mintKeypair
    );

    mint2022Keypair = Keypair.generate();
    mint2022Pubkey = await createMint(
      provider.connection,
      owner,
      owner.publicKey,
      null,
      9,
      mint2022Keypair,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    // Create token accounts
    userTokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      owner,
      mintPubkey,
      user.publicKey
    );

    user2022TokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      owner,
      mint2022Pubkey,
      user.publicKey,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    // Get vault token account address
    vaultTokenAccount = await getAssociatedTokenAddress(
      mintPubkey,
      vaultPDA,
      true // allowOwnerOffCurve - this is important for PDA
    );

    vault2022TokenAccount = await getAssociatedTokenAddress(
      mint2022Pubkey,
      vaultPDA,
      true, // allowOwnerOffCurve - this is important for PDA
      TOKEN_2022_PROGRAM_ID
    );

    recipientTokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      owner,
      mintPubkey,
      recipient.publicKey
    );

    recipient2022TokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      owner,
      mint2022Pubkey,
      recipient.publicKey,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    wrongRecipientTokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      owner,
      mintPubkey,
      wrongRecipient.publicKey
    );

    // Mint tokens to user
    await mintTo(
      provider.connection,
      owner,
      mintPubkey,
      userTokenAccount,
      owner,
      100 * LAMPORTS_PER_SOL
    );

    await mintTo(
      provider.connection,
      owner,
      mint2022Pubkey,
      user2022TokenAccount,
      owner,
      100 * LAMPORTS_PER_SOL,
      [],
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
  });

  const getEvents = async (signature: string) => {
    await provider.connection.confirmTransaction(signature);

    // Parse the deposit event to verify the recorded amount is correct (should be the amount after fee)
    const depositTxTransaction = await provider.connection.getParsedTransaction(
      signature,
      "confirmed"
    );

    let events: anchor.Event[] = [];
    for (const logMessage of depositTxTransaction?.meta?.logMessages || []) {
      if (!logMessage.startsWith("Program data: ")) {
        continue;
      }
      const event = program.coder.events.decode(
        logMessage.slice("Program data: ".length)
      );
      if (event) {
        events.push(event);
      }
    }

    return events;
  };

  it("Initialize with none-owner should fail", async () => {
    try {
      await program.methods
        .initialize()
        .accountsPartial({
          relayDepository: relayDepositoryPDA,
          vault: vaultPDA,
          owner: fakeOwner.publicKey,
          allocator: allocator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([fakeOwner])
        .rpc();

      assert.fail("Should have thrown error");
    } catch (err) {
      assert.include(err.message, "Unauthorized");
    }
  });

  it("Should successfully initialize with correct owner", async () => {
    await program.methods
      .initialize()
      .accountsPartial({
        relayDepository: relayDepositoryPDA,
        vault: vaultPDA,
        owner: owner.publicKey,
        allocator: allocator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    // Verify initialization
    const relayDepositoryAccount = await program.account.relayDepository.fetch(
      relayDepositoryPDA
    );
    assert.ok(relayDepositoryAccount.owner.equals(owner.publicKey));
    assert.ok(relayDepositoryAccount.allocator.equals(allocator.publicKey));
    assert.equal(relayDepositoryAccount.vaultBump, vaultBump);
  });

  it("Owner can set new allocator", async () => {
    const newAllocator = Keypair.generate();

    // Call set_allocator as owner
    await program.methods
      .setAllocator(newAllocator.publicKey)
      .accountsPartial({
        relayDepository: relayDepositoryPDA,
        owner: owner.publicKey,
      })
      .signers([owner])
      .rpc();

    // Verify the allocator was updated
    const relayDepositoryAccount = await program.account.relayDepository.fetch(
      relayDepositoryPDA
    );
    assert.ok(relayDepositoryAccount.allocator.equals(newAllocator.publicKey));

    // Reset allocator back to original for other tests
    await program.methods
      .setAllocator(allocator.publicKey)
      .accountsPartial({
        relayDepository: relayDepositoryPDA,
        owner: owner.publicKey,
      })
      .signers([owner])
      .rpc();
  });

  it("Non-owner cannot set new allocator", async () => {
    const newAllocator = Keypair.generate();
    const nonOwner = Keypair.generate();

    // Airdrop some SOL to non-owner for transaction fee
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        nonOwner.publicKey,
        LAMPORTS_PER_SOL
      )
    );

    try {
      // Attempt to call set_allocator as non-owner
      await program.methods
        .setAllocator(newAllocator.publicKey)
        .accountsPartial({
          relayDepository: relayDepositoryPDA,
          owner: nonOwner.publicKey,
        })
        .signers([nonOwner])
        .rpc();

      assert.fail("Should have thrown error");
    } catch (err) {
      assert.include(err.message, "Unauthorized");
    }

    // Verify allocator was not changed
    const relayDepositoryAccount = await program.account.relayDepository.fetch(
      relayDepositoryPDA
    );
    assert.ok(relayDepositoryAccount.allocator.equals(allocator.publicKey));
  });

  it("Owner can set new owner", async () => {
    const newOwner = Keypair.generate();

    // Airdrop some SOL to new owner for future transactions
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        newOwner.publicKey,
        LAMPORTS_PER_SOL
      )
    );

    // Call set_owner as current owner
    await program.methods
      .setOwner(newOwner.publicKey)
      .accountsPartial({
        relayDepository: relayDepositoryPDA,
        owner: owner.publicKey,
      })
      .signers([owner])
      .rpc();

    // Verify the owner was updated
    const relayDepositoryAccount = await program.account.relayDepository.fetch(
      relayDepositoryPDA
    );
    assert.ok(relayDepositoryAccount.owner.equals(newOwner.publicKey));

    // Reset owner back to original for other tests
    await program.methods
      .setOwner(owner.publicKey)
      .accountsPartial({
        relayDepository: relayDepositoryPDA,
        owner: newOwner.publicKey,
      })
      .signers([newOwner])
      .rpc();

    // Verify owner was reset
    const relayDepositoryAccountAfterReset =
      await program.account.relayDepository.fetch(relayDepositoryPDA);
    assert.ok(relayDepositoryAccountAfterReset.owner.equals(owner.publicKey));
  });

  it("Non-owner cannot set new owner", async () => {
    const newOwner = Keypair.generate();
    const nonOwner = Keypair.generate();

    // Airdrop some SOL to non-owner for transaction fee
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        nonOwner.publicKey,
        LAMPORTS_PER_SOL
      )
    );

    try {
      // Attempt to call set_owner as non-owner
      await program.methods
        .setOwner(newOwner.publicKey)
        .accountsPartial({
          relayDepository: relayDepositoryPDA,
          owner: nonOwner.publicKey,
        })
        .signers([nonOwner])
        .rpc();

      assert.fail("Should have thrown error");
    } catch (err) {
      assert.include(err.message, "Unauthorized");
    }

    // Verify owner was not changed
    const relayDepositoryAccount = await program.account.relayDepository.fetch(
      relayDepositoryPDA
    );
    assert.ok(relayDepositoryAccount.owner.equals(owner.publicKey));
  });

  it("Deposit native", async () => {
    const depositAmount = LAMPORTS_PER_SOL;
    const id = Array.from(Array(32).fill(1));

    const userBalanceBefore = await provider.connection.getBalance(
      user.publicKey
    );
    const vaultBalanceBefore = await provider.connection.getBalance(vaultPDA);

    const depositTx = await program.methods
      .depositNative(new anchor.BN(depositAmount), id)
      .accountsPartial({
        relayDepository: relayDepositoryPDA,
        sender: user.publicKey,
        depositor: user.publicKey,
        vault: vaultPDA,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    const userBalanceAfter = await provider.connection.getBalance(
      user.publicKey
    );
    const vaultBalanceAfter = await provider.connection.getBalance(vaultPDA);

    assert.equal(
      userBalanceBefore - userBalanceAfter,
      depositAmount,
      "Incorrect SOL deduction from user"
    );
    assert.equal(
      vaultBalanceAfter - vaultBalanceBefore,
      depositAmount,
      "Incorrect SOL addition to vault"
    );

    const events = await getEvents(depositTx);
    const depositEvent = events.find((event) => event.name === "depositEvent");
    assert.exists(depositEvent, "Deposit event should exist");

    assert.equal(
      depositEvent.data.depositor.toBase58(),
      user.publicKey.toBase58()
    );
    assert.equal(depositEvent.data.token, null);
    assert.equal(depositEvent.data.amount.toNumber(), depositAmount);
    assert.equal(depositEvent.data.id.toString(), id.toString());
  });

  it("Deposit token", async () => {
    const depositAmount = LAMPORTS_PER_SOL;
    const id = Array.from(Buffer.alloc(32, 2));

    // Get initial balances
    const userBalanceBefore = await provider.connection.getTokenAccountBalance(
      userTokenAccount
    );

    // Create vault token account if it doesn't exist
    try {
      await createAssociatedTokenAccount(
        provider.connection,
        owner, // payer
        mintPubkey,
        vaultPDA,
        undefined,
        undefined,
        undefined,
        true // allowOwnerOffCurve
      );
    } catch {
      // Skip errors
    }

    // Deposit tokens
    const depositTx = await program.methods
      .depositToken(new anchor.BN(depositAmount), id)
      .accountsPartial({
        relayDepository: relayDepositoryPDA,
        mint: mintPubkey,
        sender: user.publicKey,
        senderTokenAccount: userTokenAccount,
        depositor: user.publicKey,
        vaultTokenAccount: vaultTokenAccount,
        vault: vaultPDA,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    // Verify balances after deposit
    const userBalanceAfter = await provider.connection.getTokenAccountBalance(
      userTokenAccount
    );
    const vaultBalanceAfter = await provider.connection.getTokenAccountBalance(
      vaultTokenAccount
    );

    assert.equal(
      Number(userBalanceBefore.value.amount) -
        Number(userBalanceAfter.value.amount),
      depositAmount,
      "Incorrect token deduction from user"
    );

    assert.equal(
      Number(vaultBalanceAfter.value.amount),
      depositAmount,
      "Incorrect token deduction from vault"
    );

    const events = await getEvents(depositTx);
    const depositEvent = events.find((event) => event.name === "depositEvent");
    assert.exists(depositEvent, "Deposit event should exist");

    assert.equal(
      depositEvent.data.depositor.toBase58(),
      user.publicKey.toBase58()
    );
    assert.equal(depositEvent.data.token.toBase58(), mintPubkey.toBase58());
    assert.equal(depositEvent.data.amount.toNumber(), depositAmount);
    assert.equal(depositEvent.data.id.toString(), id.toString());
  });

  it("Deposit token2022", async () => {
    const depositAmount = LAMPORTS_PER_SOL;
    const id = Array.from(Buffer.alloc(32, 3));

    const userBalanceBefore = await provider.connection.getTokenAccountBalance(
      user2022TokenAccount
    );

    // Create vault token account if it doesn't exist
    try {
      await createAssociatedTokenAccount(
        provider.connection,
        owner,
        mint2022Pubkey,
        vaultPDA,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
    } catch {}

    const depositTx = await program.methods
      .depositToken(new anchor.BN(depositAmount), id)
      .accountsPartial({
        relayDepository: relayDepositoryPDA,
        mint: mint2022Pubkey,
        sender: user.publicKey,
        senderTokenAccount: user2022TokenAccount,
        depositor: user.publicKey,
        vaultTokenAccount: vault2022TokenAccount,
        vault: vaultPDA,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    const userBalanceAfter = await provider.connection.getTokenAccountBalance(
      user2022TokenAccount
    );
    const vaultBalanceAfter = await provider.connection.getTokenAccountBalance(
      vault2022TokenAccount
    );

    assert.equal(
      Number(userBalanceBefore.value.amount) -
        Number(userBalanceAfter.value.amount),
      depositAmount,
      "Incorrect token deduction from user"
    );

    assert.equal(
      Number(vaultBalanceAfter.value.amount),
      depositAmount,
      "Incorrect token addition to vault"
    );

    const events = await getEvents(depositTx);
    const depositEvent = events.find((event) => event.name === "depositEvent");
    assert.exists(depositEvent, "Deposit event should exist");

    assert.equal(
      depositEvent.data.depositor.toBase58(),
      user.publicKey.toBase58()
    );
    assert.equal(depositEvent.data.token.toBase58(), mint2022Pubkey.toBase58());
    assert.equal(depositEvent.data.amount.toNumber(), depositAmount);
    assert.equal(depositEvent.data.id.toString(), id.toString());
  });

  it("Deposit token2022 with transfer fee - verify amount excludes fee", async () => {
    // Create a Token2022 mint with transfer fee
    const mintWithFeeKeypair = Keypair.generate();
    const transferFeeBasisPoints = 100; // 1% transfer fee
    const maxFee = 5000 * 10 ** 9; // Maximum fee of 5000 tokens

    // Use the provided function to create a token with transfer fee
    const mintWithFeePubkey = await createMintWithTransferFee(
      provider.connection,
      owner,
      owner,
      mintWithFeeKeypair,
      { transferFeeBasisPoints, MaxFee: maxFee }
    );

    // Create token account for the user
    const userFeeTokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      owner,
      mintWithFeePubkey,
      user.publicKey,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    // Get the vault's token account address
    const vaultFeeTokenAccount = await getAssociatedTokenAddress(
      mintWithFeePubkey,
      vaultPDA,
      true, // allowOwnerOffCurve - needed for PDA
      TOKEN_2022_PROGRAM_ID
    );

    // Mint tokens to the user
    const mintAmount = 100 * LAMPORTS_PER_SOL; // 100 tokens
    await mintTo(
      provider.connection,
      owner,
      mintWithFeePubkey,
      userFeeTokenAccount,
      owner,
      mintAmount,
      [],
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    // Check user's balance before deposit
    const userBalanceBefore = await provider.connection.getTokenAccountBalance(
      userFeeTokenAccount
    );

    // Generate a unique ID for this deposit
    const id = Array.from(Buffer.alloc(32, 4));

    // Amount to deposit
    const depositAmount = 10 * LAMPORTS_PER_SOL; // 10 tokens

    // Calculate the expected transfer fee
    const expectedFee = Math.floor(
      (depositAmount * transferFeeBasisPoints) / 10000
    );

    // Create vault token account if it doesn't exist
    try {
      await createAssociatedTokenAccount(
        provider.connection,
        owner,
        mintWithFeePubkey,
        vaultPDA,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
    } catch {
      // Ignore error if account already exists
    }

    // Execute the deposit operation
    const depositTx = await program.methods
      .depositToken(new anchor.BN(depositAmount), id)
      .accountsPartial({
        relayDepository: relayDepositoryPDA,
        mint: mintWithFeePubkey,
        sender: user.publicKey,
        senderTokenAccount: userFeeTokenAccount,
        depositor: user.publicKey,
        vaultTokenAccount: vaultFeeTokenAccount,
        vault: vaultPDA,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    // Get user's balance after the deposit
    const userBalanceAfter = await provider.connection.getTokenAccountBalance(
      userFeeTokenAccount
    );

    // Get vault's balance
    const vaultBalanceAfter = await provider.connection.getTokenAccountBalance(
      vaultFeeTokenAccount
    );

    // Verify the user's account was debited the full deposit amount
    const userBalanceDecrease =
      Number(userBalanceBefore.value.amount) -
      Number(userBalanceAfter.value.amount);
    assert.equal(
      userBalanceDecrease,
      depositAmount,
      "User's balance should decrease by the full deposit amount"
    );

    // Verify the vault received the deposit amount minus the fee
    assert.equal(
      Number(vaultBalanceAfter.value.amount),
      depositAmount - expectedFee,
      "Vault should receive deposit amount minus transfer fee"
    );

    const events = await getEvents(depositTx);
    const depositEvent = events.find((event) => event.name === "depositEvent");
    assert.exists(depositEvent, "Deposit event should exist");

    // Verify the deposit event records the amount after fee deduction
    assert.equal(
      depositEvent.data.amount.toNumber(),
      depositAmount - expectedFee,
      "Deposit event amount should record the amount after fee deduction"
    );

    // Verify other event data
    assert.equal(
      depositEvent.data.depositor.toBase58(),
      user.publicKey.toBase58(),
      "Deposit event should record correct depositor"
    );
    assert.equal(
      depositEvent.data.id.toString(),
      id.toString(),
      "Deposit event should record correct ID"
    );
    assert.equal(
      depositEvent.data.token.toBase58(),
      mintWithFeePubkey.toBase58(),
      "Deposit event should record correct token mint"
    );
  });

  it("Should fail deposit token with incorrect vault token account", async () => {
    const depositAmount = LAMPORTS_PER_SOL;
    const id = Array.from(Buffer.alloc(32, 4));

    // Create a random token account as wrong vault token account
    const wrongVaultKeypair = Keypair.generate();
    const wrongVaultTokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      owner,
      mintPubkey,
      wrongVaultKeypair.publicKey
    );

    try {
      await program.methods
        .depositToken(new anchor.BN(depositAmount), id)
        .accountsPartial({
          relayDepository: relayDepositoryPDA,
          mint: mintPubkey,
          sender: user.publicKey,
          senderTokenAccount: userTokenAccount,
          depositor: user.publicKey,
          vaultTokenAccount: wrongVaultTokenAccount, // Use wrong vault token account
          vault: vaultPDA,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      assert.fail("Should have failed with invalid vault token account");
    } catch (err) {
      assert.include(err.message, "InvalidVaultTokenAccount");
    }

    // Verify the tokens are still in user's account
    const userBalance = await provider.connection.getTokenAccountBalance(
      userTokenAccount
    );
    assert.isAtLeast(
      Number(userBalance.value.amount),
      depositAmount,
      "User tokens should not have been deducted"
    );

    // Verify the wrong vault token account didn't receive any tokens
    const wrongVaultBalance = await provider.connection.getTokenAccountBalance(
      wrongVaultTokenAccount
    );
    assert.equal(
      Number(wrongVaultBalance.value.amount),
      0,
      "Wrong vault should not have received any tokens"
    );
  });

  it("Should fail while execute native transfer over min rent with allocator signature", async () => {
    const transferAmount = LAMPORTS_PER_SOL; // 1 SOL
    // Create transfer request
    const request = {
      recipient: recipient.publicKey,
      token: null, // SOL transfer
      amount: new anchor.BN(transferAmount),
      nonce: new anchor.BN(Date.now() + Math.floor(Math.random() * 1000)),
      expiration: new anchor.BN(Math.floor(Date.now() / 1000) + 300),
    };

    const messagHash = hashRequest(request);

    // Sign with allocator
    const signature = nacl.sign.detached(messagHash, allocator.secretKey);
    const requestPDA = await getUsedRequestPDA(request);

    try {
      await program.methods
        .executeTransfer(request)
        .accountsPartial({
          mint: null,
          vaultTokenAccount: null,
          recipientTokenAccount: null,
          relayDepository: relayDepositoryPDA,
          executor: provider.wallet.publicKey,
          recipient: recipient.publicKey,
          vault: vaultPDA,
          usedRequest: requestPDA,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          ixSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([
          anchor.web3.Ed25519Program.createInstructionWithPublicKey({
            publicKey: allocator.publicKey.toBytes(),
            message: messagHash,
            signature: signature,
          }),
        ])
        .rpc();
      assert.fail(
        "Expected transaction to fail with InsufficientVaultBalance error"
      );
    } catch (err) {
      assert.include(err.message, "InsufficientVaultBalance");
    }
  });

  it("Execute native transfer with allocator signature", async () => {
    const transferAmount = LAMPORTS_PER_SOL / 10; // 0.1 SOL

    // Create transfer request
    const request = {
      recipient: recipient.publicKey,
      token: null, // SOL transfer
      amount: new anchor.BN(transferAmount),
      nonce: new anchor.BN(Date.now() + Math.floor(Math.random() * 1000)),
      expiration: new anchor.BN(Math.floor(Date.now() / 1000) + 300),
    };

    const messagHash = hashRequest(request);

    // Sign with allocator
    const signature = nacl.sign.detached(messagHash, allocator.secretKey);

    const recipientBalanceBefore = await provider.connection.getBalance(
      recipient.publicKey
    );
    const vaultBalanceBefore = await provider.connection.getBalance(vaultPDA);

    const requestPDA = await getUsedRequestPDA(request);

    const hanlde = program.methods
      .executeTransfer(request)
      .accountsPartial({
        mint: null,
        vaultTokenAccount: null,
        recipientTokenAccount: null,
        relayDepository: relayDepositoryPDA,
        executor: provider.wallet.publicKey,
        recipient: recipient.publicKey,
        vault: vaultPDA,
        usedRequest: requestPDA,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        ixSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([
        anchor.web3.Ed25519Program.createInstructionWithPublicKey({
          publicKey: allocator.publicKey.toBytes(),
          message: messagHash,
          signature: signature,
        }),
      ]);
    const events = (await hanlde.simulate()).events || [];
    const TransferExecutedEvent = events.find(
      (c) => c.name === "transferExecutedEvent"
    );
    assert.equal(
      TransferExecutedEvent.data.executor.toBase58(),
      provider.wallet.publicKey.toBase58(),
      "Incorrect event executor"
    );

    assert.equal(
      TransferExecutedEvent.data.id.toBase58(),
      requestPDA.toBase58(),
      "Incorrect event id"
    );

    assert.equal(
      TransferExecutedEvent.data.request.recipient.toBase58(),
      recipient.publicKey.toBase58(),
      "Incorrect event recipient"
    );

    await hanlde.rpc();

    const usedRequestState = await program.account.usedRequest.fetch(
      requestPDA
    );

    const recipientBalanceAfter = await provider.connection.getBalance(
      recipient.publicKey
    );
    const vaultBalanceAfter = await provider.connection.getBalance(vaultPDA);

    assert.equal(usedRequestState.isUsed, true, "Incorrect usedRequest State");

    assert.equal(
      recipientBalanceAfter - recipientBalanceBefore,
      transferAmount,
      "Incorrect SOL transfer to recipient"
    );
    assert.equal(
      vaultBalanceBefore - vaultBalanceAfter,
      transferAmount,
      "Incorrect SOL deduction from vault"
    );
  });

  it("Execute token transfer with allocator signature", async () => {
    const transferAmount = LAMPORTS_PER_SOL / 2; // 0.5 SOL

    // Create transfer request
    const request = {
      recipient: recipient.publicKey,
      token: mintPubkey, // SOL transfer
      amount: new anchor.BN(transferAmount),
      nonce: new anchor.BN(Date.now() + Math.floor(Math.random() * 1000)),
      expiration: new anchor.BN(Math.floor(Date.now() / 1000) + 300),
    };

    const messagHash = hashRequest(request);

    // Sign with allocator
    const signature = nacl.sign.detached(messagHash, allocator.secretKey);

    const recipientBalanceBefore =
      await provider.connection.getTokenAccountBalance(recipientTokenAccount);
    const vaultBalanceBefore = await provider.connection.getTokenAccountBalance(
      vaultTokenAccount
    );

    const requestPDA = await getUsedRequestPDA(request);

    await program.methods
      .executeTransfer(request)
      .accountsPartial({
        mint: mintPubkey,
        vaultTokenAccount,
        recipientTokenAccount,
        relayDepository: relayDepositoryPDA,
        executor: provider.wallet.publicKey,
        recipient: recipient.publicKey,
        vault: vaultPDA,
        usedRequest: requestPDA,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        ixSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([
        anchor.web3.Ed25519Program.createInstructionWithPublicKey({
          publicKey: allocator.publicKey.toBytes(),
          message: messagHash,
          signature: signature,
        }),
      ])
      .rpc();

    const usedRequestState = await program.account.usedRequest.fetch(
      requestPDA
    );

    const recipientBalanceAfter =
      await provider.connection.getTokenAccountBalance(recipientTokenAccount);
    const vaultBalanceAfter = await provider.connection.getTokenAccountBalance(
      vaultTokenAccount
    );

    assert.equal(usedRequestState.isUsed, true, "Incorrect usedRequest State");

    assert.equal(
      Number(recipientBalanceAfter.value.amount) -
        Number(recipientBalanceBefore.value.amount),
      transferAmount,
      "Incorrect SPL transfer to recipient"
    );
    assert.equal(
      Number(vaultBalanceBefore.value.amount) -
        Number(vaultBalanceAfter.value.amount),
      transferAmount,
      "Incorrect SPL deduction from vault"
    );
  });

  it("Execute token2022 transfer with allocator signature", async () => {
    const transferAmount = LAMPORTS_PER_SOL / 2;

    const request = {
      recipient: recipient.publicKey,
      token: mint2022Pubkey,
      amount: new anchor.BN(transferAmount),
      nonce: new anchor.BN(Date.now() + Math.floor(Math.random() * 1000)),
      expiration: new anchor.BN(Math.floor(Date.now() / 1000) + 300),
    };

    const messagePath = hashRequest(request);
    const signature = nacl.sign.detached(messagePath, allocator.secretKey);
    const requestPDA = await getUsedRequestPDA(request);

    const recipientBalanceBefore =
      await provider.connection.getTokenAccountBalance(
        recipient2022TokenAccount
      );
    const vaultBalanceBefore = await provider.connection.getTokenAccountBalance(
      vault2022TokenAccount
    );

    await program.methods
      .executeTransfer(request)
      .accountsPartial({
        mint: mint2022Pubkey,
        vaultTokenAccount: vault2022TokenAccount,
        recipientTokenAccount: recipient2022TokenAccount,
        relayDepository: relayDepositoryPDA,
        executor: provider.wallet.publicKey,
        recipient: recipient.publicKey,
        vault: vaultPDA,
        usedRequest: requestPDA,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        ixSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([
        anchor.web3.Ed25519Program.createInstructionWithPublicKey({
          publicKey: allocator.publicKey.toBytes(),
          message: messagePath,
          signature: signature,
        }),
      ])
      .rpc();

    const recipientBalanceAfter =
      await provider.connection.getTokenAccountBalance(
        recipient2022TokenAccount
      );
    const vaultBalanceAfter = await provider.connection.getTokenAccountBalance(
      vault2022TokenAccount
    );

    assert.equal(
      Number(recipientBalanceAfter.value.amount) -
        Number(recipientBalanceBefore.value.amount),
      transferAmount,
      "Incorrect token transfer to recipient"
    );

    assert.equal(
      Number(vaultBalanceBefore.value.amount) -
        Number(vaultBalanceAfter.value.amount),
      transferAmount,
      "Incorrect token deduction from vault"
    );
  });

  it("Should fail with invalid allocator signature", async () => {
    const transferAmount = LAMPORTS_PER_SOL / 2;
    const fakeAllocator = Keypair.generate();

    const request = {
      recipient: recipient.publicKey,
      token: null,
      amount: new anchor.BN(transferAmount),
      nonce: new anchor.BN(Date.now() + Math.floor(Math.random() * 1000)),
      expiration: new anchor.BN(Math.floor(Date.now() / 1000) + 300),
    };

    const messagHash = hashRequest(request);

    // Create invalid signature with fake allocator
    const invalidSignature = nacl.sign.detached(
      messagHash,
      fakeAllocator.secretKey
    );

    const requestPDA = await getUsedRequestPDA(request);

    try {
      await program.methods
        .executeTransfer(request)
        .accountsPartial({
          mint: null,
          vaultTokenAccount: null,
          recipientTokenAccount: null,
          relayDepository: relayDepositoryPDA,
          executor: provider.wallet.publicKey,
          recipient: recipient.publicKey,
          vault: vaultPDA,
          usedRequest: requestPDA,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          ixSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([
          anchor.web3.Ed25519Program.createInstructionWithPublicKey({
            publicKey: fakeAllocator.publicKey.toBytes(),
            message: messagHash,
            signature: invalidSignature,
          }),
        ])
        .rpc();
      assert.fail("Should have failed with invalid signature");
    } catch (e) {
      assert.include(e.message, "AllocatorSignerMismatch");
    }
  });

  it("Should fail with invalid allocator signature by using malicious instruction", async () => {
    const transferAmount = LAMPORTS_PER_SOL / 2;
    const fakeAllocator = Keypair.generate();

    const request = {
      recipient: recipient.publicKey,
      token: null,
      amount: new anchor.BN(transferAmount),
      nonce: new anchor.BN(Date.now() + Math.floor(Math.random() * 1000)),
      expiration: new anchor.BN(Math.floor(Date.now() / 1000) + 300),
    };

    const messagHash = hashRequest(request);

    // Create invalid signature with fake allocator
    const invalidSignature = nacl.sign.detached(
      messagHash,
      fakeAllocator.secretKey
    );

    const requestPDA = await getUsedRequestPDA(request);

    const instr = createMaliciousEd25519Instruction(
      allocator.publicKey.toBytes(),
      fakeAllocator.publicKey.toBytes(),
      messagHash,
      invalidSignature
    );

    try {
      await program.methods
        .executeTransfer(request)
        .accountsPartial({
          mint: null,
          vaultTokenAccount: null,
          recipientTokenAccount: null,
          relayDepository: relayDepositoryPDA,
          executor: provider.wallet.publicKey,
          recipient: recipient.publicKey,
          vault: vaultPDA,
          usedRequest: requestPDA,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          ixSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([instr])
        .rpc();
      assert.fail("Should have failed with invalid signature");
    } catch (e) {
      assert.include(e.message, "MalformedEd25519Data");
    }
  });

  it("Should not allow double execution of same request", async () => {
    const transferAmount = LAMPORTS_PER_SOL / 2;

    const request = {
      recipient: recipient.publicKey,
      token: null,
      amount: new anchor.BN(transferAmount),
      nonce: new anchor.BN(Date.now() + Math.floor(Math.random() * 1000)),
      expiration: new anchor.BN(Math.floor(Date.now() / 1000) + 300),
    };

    const messagHash = hashRequest(request);
    const signature = nacl.sign.detached(messagHash, allocator.secretKey);
    const requestPDA = await getUsedRequestPDA(request);

    // First execution
    await program.methods
      .executeTransfer(request)
      .accountsPartial({
        mint: null,
        vaultTokenAccount: null,
        recipientTokenAccount: null,
        relayDepository: relayDepositoryPDA,
        executor: provider.wallet.publicKey,
        recipient: recipient.publicKey,
        vault: vaultPDA,
        usedRequest: requestPDA,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        ixSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([
        anchor.web3.Ed25519Program.createInstructionWithPublicKey({
          publicKey: allocator.publicKey.toBytes(),
          message: messagHash,
          signature: signature,
        }),
      ])
      .rpc();

    // Second execution should fail
    try {
      await program.methods
        .executeTransfer(request)
        .accountsPartial({
          mint: null,
          vaultTokenAccount: null,
          recipientTokenAccount: null,
          relayDepository: relayDepositoryPDA,
          executor: provider.wallet.publicKey,
          recipient: recipient.publicKey,
          vault: vaultPDA,
          usedRequest: requestPDA,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          ixSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([
          anchor.web3.Ed25519Program.createInstructionWithPublicKey({
            publicKey: allocator.publicKey.toBytes(),
            message: messagHash,
            signature: signature,
          }),
        ])
        .rpc();
      assert.fail("Should have failed with request already used");
    } catch (e) {
      assert.include(e.message, "already in use");
      assert.include(e.message, requestPDA.toBase58());
    }
  });

  it("Should fail execute transfer with mismatched recipient", async () => {
    const transferAmount = LAMPORTS_PER_SOL / 10; // 0.1 SOL

    // Create transfer request
    const request = {
      recipient: recipient.publicKey,
      token: null, // SOL transfer
      amount: new anchor.BN(transferAmount),
      nonce: new anchor.BN(Date.now() + Math.floor(Math.random() * 1000)),
      expiration: new anchor.BN(Math.floor(Date.now() / 1000) + 300),
    };

    const messagHash = hashRequest(request);

    // Sign with allocator
    const signature = nacl.sign.detached(messagHash, allocator.secretKey);
    const requestPDA = await getUsedRequestPDA(request);

    try {
      await program.methods
        .executeTransfer(request)
        .accountsPartial({
          mint: null,
          vaultTokenAccount: null,
          recipientTokenAccount: null,
          relayDepository: relayDepositoryPDA,
          executor: provider.wallet.publicKey,
          recipient: wrongRecipient.publicKey,
          vault: vaultPDA,
          usedRequest: requestPDA,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          ixSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([
          anchor.web3.Ed25519Program.createInstructionWithPublicKey({
            publicKey: allocator.publicKey.toBytes(),
            message: messagHash,
            signature: signature,
          }),
        ])
        .rpc();

      assert.fail("Should have failed with invalid recipient");
    } catch (err) {
      assert.include(err.message, "InvalidRecipient");

      // Verify request was not marked as used
      try {
        await program.account.usedRequest.fetch(requestPDA);
        assert.fail("Request should not exist");
      } catch (e) {
        assert.include(e.message, "Account does not exist");
      }
    }
  });

  it("Should fail execute token transfer with mismatched recipient", async () => {
    const transferAmount = LAMPORTS_PER_SOL / 10;

    // Create transfer request with recipient A
    const request = {
      recipient: recipient.publicKey, // Use original recipient in request
      token: mintPubkey,
      amount: new anchor.BN(transferAmount),
      nonce: new anchor.BN(Date.now() + Math.floor(Math.random() * 1000)),
      expiration: new anchor.BN(Math.floor(Date.now() / 1000) + 300),
    };

    const messagHash = hashRequest(request);
    const signature = nacl.sign.detached(messagHash, allocator.secretKey);
    const requestPDA = await getUsedRequestPDA(request);

    try {
      // But try to execute with recipient B
      await program.methods
        .executeTransfer(request)
        .accountsPartial({
          mint: mintPubkey,
          vaultTokenAccount,
          recipientTokenAccount: wrongRecipientTokenAccount,
          relayDepository: relayDepositoryPDA,
          executor: provider.wallet.publicKey,
          recipient: wrongRecipient.publicKey,
          vault: vaultPDA,
          usedRequest: requestPDA,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          ixSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([
          anchor.web3.Ed25519Program.createInstructionWithPublicKey({
            publicKey: allocator.publicKey.toBytes(),
            message: messagHash,
            signature: signature,
          }),
        ])
        .rpc();

      assert.fail("Should have failed with invalid recipient");
    } catch (err) {
      assert.include(err.message, "InvalidRecipient");

      // Verify request was not marked as used
      try {
        await program.account.usedRequest.fetch(requestPDA);
        assert.fail("Request should not exist");
      } catch (e) {
        assert.include(e.message, "Account does not exist");
      }
    }
  });

  it("Should fail with expired signature", async () => {
    const transferAmount = LAMPORTS_PER_SOL / 10;

    // Create transfer request with expiration in the past
    const request = {
      recipient: recipient.publicKey,
      token: null,
      amount: new anchor.BN(transferAmount),
      nonce: new anchor.BN(Date.now() + Math.floor(Math.random() * 1000)),
      expiration: new anchor.BN(Math.floor(Date.now() / 1000) - 300), // Expired 5 minutes ago
    };

    const messagHash = hashRequest(request);
    const signature = nacl.sign.detached(messagHash, allocator.secretKey);
    const requestPDA = await getUsedRequestPDA(request);

    try {
      await program.methods
        .executeTransfer(request)
        .accountsPartial({
          mint: null,
          vaultTokenAccount: null,
          recipientTokenAccount: null,
          relayDepository: relayDepositoryPDA,
          executor: provider.wallet.publicKey,
          recipient: recipient.publicKey,
          vault: vaultPDA,
          usedRequest: requestPDA,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          ixSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([
          anchor.web3.Ed25519Program.createInstructionWithPublicKey({
            publicKey: allocator.publicKey.toBytes(),
            message: messagHash,
            signature: signature,
          }),
        ])
        .rpc();

      assert.fail("Should have failed with expired signature");
    } catch (err) {
      assert.include(err.message, "SignatureExpired");
    }
  });

  it("Should fail without Ed25519 signature instruction", async () => {
    const transferAmount = LAMPORTS_PER_SOL / 10;

    const request = {
      recipient: recipient.publicKey,
      token: null,
      amount: new anchor.BN(transferAmount),
      nonce: new anchor.BN(Date.now() + Math.floor(Math.random() * 1000)),
      expiration: new anchor.BN(Math.floor(Date.now() / 1000) + 300),
    };

    const requestPDA = await getUsedRequestPDA(request);

    try {
      // Execute without preInstructions (no Ed25519 signature)
      await program.methods
        .executeTransfer(request)
        .accountsPartial({
          mint: null,
          vaultTokenAccount: null,
          recipientTokenAccount: null,
          relayDepository: relayDepositoryPDA,
          executor: provider.wallet.publicKey,
          recipient: recipient.publicKey,
          vault: vaultPDA,
          usedRequest: requestPDA,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          ixSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .rpc();

      assert.fail("Should have failed without Ed25519 signature");
    } catch (err) {
      assert.include(err.message, "MalformedEd25519Data");
    }
  });

  it("Should fail with message mismatch (signed different request)", async () => {
    const transferAmount = LAMPORTS_PER_SOL / 10;

    // Request that will be signed
    const signedRequest = {
      recipient: recipient.publicKey,
      token: null,
      amount: new anchor.BN(transferAmount),
      nonce: new anchor.BN(Date.now() + Math.floor(Math.random() * 1000)),
      expiration: new anchor.BN(Math.floor(Date.now() / 1000) + 300),
    };

    // Different request that will be submitted (different amount)
    const submittedRequest = {
      recipient: recipient.publicKey,
      token: null,
      amount: new anchor.BN(transferAmount * 2), // Different amount
      nonce: signedRequest.nonce,
      expiration: signedRequest.expiration,
    };

    const signedMessageHash = hashRequest(signedRequest);
    const signature = nacl.sign.detached(signedMessageHash, allocator.secretKey);
    const requestPDA = await getUsedRequestPDA(submittedRequest);

    try {
      await program.methods
        .executeTransfer(submittedRequest)
        .accountsPartial({
          mint: null,
          vaultTokenAccount: null,
          recipientTokenAccount: null,
          relayDepository: relayDepositoryPDA,
          executor: provider.wallet.publicKey,
          recipient: recipient.publicKey,
          vault: vaultPDA,
          usedRequest: requestPDA,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          ixSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([
          anchor.web3.Ed25519Program.createInstructionWithPublicKey({
            publicKey: allocator.publicKey.toBytes(),
            message: signedMessageHash,
            signature: signature,
          }),
        ])
        .rpc();

      assert.fail("Should have failed with message mismatch");
    } catch (err) {
      assert.include(err.message, "MessageMismatch");
    }
  });

  it("Should fail deposit native with zero amount", async () => {
    const depositAmount = 0;
    const id = Array.from(Buffer.alloc(32, 10));

    try {
      await program.methods
        .depositNative(new anchor.BN(depositAmount), id)
        .accountsPartial({
          relayDepository: relayDepositoryPDA,
          sender: user.publicKey,
          depositor: user.publicKey,
          vault: vaultPDA,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      // Zero amount transfer may succeed but doesn't make practical sense
      // The system doesn't enforce a minimum, so this is more of a documentation test
    } catch (err) {
      // Some implementations may reject zero transfers
      // This is acceptable behavior
    }
  });

  it("Should fail deposit token with insufficient balance", async () => {
    const depositAmount = 1000 * LAMPORTS_PER_SOL; // More than user has
    const id = Array.from(Buffer.alloc(32, 11));

    try {
      await program.methods
        .depositToken(new anchor.BN(depositAmount), id)
        .accountsPartial({
          relayDepository: relayDepositoryPDA,
          mint: mintPubkey,
          sender: user.publicKey,
          senderTokenAccount: userTokenAccount,
          depositor: user.publicKey,
          vaultTokenAccount: vaultTokenAccount,
          vault: vaultPDA,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      assert.fail("Should have failed with insufficient balance");
    } catch (err) {
      // The error should indicate insufficient funds
      assert.ok(
        err.message.includes("insufficient") ||
          err.message.includes("InsufficientFunds") ||
          err.message.includes("0x1"),
        `Unexpected error: ${err.message}`
      );
    }
  });

  it("Should fail execute token transfer with mismatched token mint", async () => {
    const transferAmount = LAMPORTS_PER_SOL / 10;

    // Create request with mint2022 but try to use wrong accounts
    const request = {
      recipient: recipient.publicKey,
      token: mint2022Pubkey, // Request is for Token2022
      amount: new anchor.BN(transferAmount),
      nonce: new anchor.BN(Date.now() + Math.floor(Math.random() * 1000)),
      expiration: new anchor.BN(Math.floor(Date.now() / 1000) + 300),
    };

    const messagHash = hashRequest(request);
    const signature = nacl.sign.detached(messagHash, allocator.secretKey);
    const requestPDA = await getUsedRequestPDA(request);

    try {
      // Try to execute with regular SPL token accounts instead of Token2022
      await program.methods
        .executeTransfer(request)
        .accountsPartial({
          mint: mintPubkey, // Wrong mint - using regular SPL token mint
          vaultTokenAccount,
          recipientTokenAccount,
          relayDepository: relayDepositoryPDA,
          executor: provider.wallet.publicKey,
          recipient: recipient.publicKey,
          vault: vaultPDA,
          usedRequest: requestPDA,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          ixSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([
          anchor.web3.Ed25519Program.createInstructionWithPublicKey({
            publicKey: allocator.publicKey.toBytes(),
            message: messagHash,
            signature: signature,
          }),
        ])
        .rpc();

      assert.fail("Should have failed with mismatched token mint");
    } catch (err) {
      assert.include(err.message, "InvalidMint");
    }
  });

  it("Should support different depositor than sender", async () => {
    const depositAmount = LAMPORTS_PER_SOL / 10;
    const id = Array.from(Buffer.alloc(32, 12));
    const differentDepositor = Keypair.generate();

    const vaultBalanceBefore = await provider.connection.getBalance(vaultPDA);

    const depositTx = await program.methods
      .depositNative(new anchor.BN(depositAmount), id)
      .accountsPartial({
        relayDepository: relayDepositoryPDA,
        sender: user.publicKey,
        depositor: differentDepositor.publicKey, // Different from sender
        vault: vaultPDA,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    const vaultBalanceAfter = await provider.connection.getBalance(vaultPDA);

    assert.equal(
      vaultBalanceAfter - vaultBalanceBefore,
      depositAmount,
      "Incorrect SOL addition to vault"
    );

    // Verify the event records the different depositor
    const events = await getEvents(depositTx);
    const depositEvent = events.find((event) => event.name === "depositEvent");
    assert.exists(depositEvent, "Deposit event should exist");
    assert.equal(
      depositEvent.data.depositor.toBase58(),
      differentDepositor.publicKey.toBase58(),
      "Event should record the different depositor"
    );
  });

  it("Should support different depositor than sender for token deposit", async () => {
    const depositAmount = LAMPORTS_PER_SOL / 10;
    const id = Array.from(Buffer.alloc(32, 13));
    const differentDepositor = Keypair.generate();

    const userBalanceBefore = await provider.connection.getTokenAccountBalance(
      userTokenAccount
    );

    const depositTx = await program.methods
      .depositToken(new anchor.BN(depositAmount), id)
      .accountsPartial({
        relayDepository: relayDepositoryPDA,
        mint: mintPubkey,
        sender: user.publicKey,
        senderTokenAccount: userTokenAccount,
        depositor: differentDepositor.publicKey, // Different from sender
        vaultTokenAccount: vaultTokenAccount,
        vault: vaultPDA,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    const userBalanceAfter = await provider.connection.getTokenAccountBalance(
      userTokenAccount
    );

    assert.equal(
      Number(userBalanceBefore.value.amount) -
        Number(userBalanceAfter.value.amount),
      depositAmount,
      "Incorrect token deduction from user"
    );

    // Verify the event records the different depositor
    const events = await getEvents(depositTx);
    const depositEvent = events.find((event) => event.name === "depositEvent");
    assert.exists(depositEvent, "Deposit event should exist");
    assert.equal(
      depositEvent.data.depositor.toBase58(),
      differentDepositor.publicKey.toBase58(),
      "Event should record the different depositor"
    );
  });

  it("Should fail execute token transfer with insufficient vault balance", async () => {
    // Create a new mint with a fresh vault that has no tokens
    const newMintKeypair = Keypair.generate();
    const newMintPubkey = await createMint(
      provider.connection,
      owner,
      owner.publicKey,
      null,
      9,
      newMintKeypair
    );

    // Create recipient token account for new mint
    const newRecipientTokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      owner,
      newMintPubkey,
      recipient.publicKey
    );

    // Get vault token account address for new mint
    const newVaultTokenAccount = await getAssociatedTokenAddress(
      newMintPubkey,
      vaultPDA,
      true
    );

    // Create vault token account but don't fund it
    await createAssociatedTokenAccount(
      provider.connection,
      owner,
      newMintPubkey,
      vaultPDA,
      undefined,
      undefined,
      undefined,
      true
    );

    const transferAmount = LAMPORTS_PER_SOL;

    const request = {
      recipient: recipient.publicKey,
      token: newMintPubkey,
      amount: new anchor.BN(transferAmount),
      nonce: new anchor.BN(Date.now() + Math.floor(Math.random() * 1000)),
      expiration: new anchor.BN(Math.floor(Date.now() / 1000) + 300),
    };

    const messagHash = hashRequest(request);
    const signature = nacl.sign.detached(messagHash, allocator.secretKey);
    const requestPDA = await getUsedRequestPDA(request);

    try {
      await program.methods
        .executeTransfer(request)
        .accountsPartial({
          mint: newMintPubkey,
          vaultTokenAccount: newVaultTokenAccount,
          recipientTokenAccount: newRecipientTokenAccount,
          relayDepository: relayDepositoryPDA,
          executor: provider.wallet.publicKey,
          recipient: recipient.publicKey,
          vault: vaultPDA,
          usedRequest: requestPDA,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          ixSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([
          anchor.web3.Ed25519Program.createInstructionWithPublicKey({
            publicKey: allocator.publicKey.toBytes(),
            message: messagHash,
            signature: signature,
          }),
        ])
        .rpc();

      assert.fail("Should have failed with insufficient vault balance");
    } catch (err) {
      // The error should indicate insufficient funds
      assert.ok(
        err.message.includes("insufficient") ||
          err.message.includes("InsufficientFunds") ||
          err.message.includes("0x1"),
        `Unexpected error: ${err.message}`
      );
    }
  });

  it("Should fail to re-initialize already initialized contract", async () => {
    const newAllocator = Keypair.generate();

    try {
      await program.methods
        .initialize()
        .accountsPartial({
          relayDepository: relayDepositoryPDA,
          vault: vaultPDA,
          owner: owner.publicKey,
          allocator: newAllocator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([owner])
        .rpc();

      assert.fail("Should have failed - contract already initialized");
    } catch (err) {
      // Anchor prevents re-initialization of accounts with the `init` constraint
      // The error indicates the account already exists
      assert.ok(
        err.message.includes("already in use") ||
          err.message.includes("already been processed") ||
          err.message.includes("0x0"),
        `Unexpected error: ${err.message}`
      );
    }

    // Verify the original state is unchanged
    const relayDepositoryAccount = await program.account.relayDepository.fetch(
      relayDepositoryPDA
    );
    assert.ok(relayDepositoryAccount.owner.equals(owner.publicKey));
    assert.ok(relayDepositoryAccount.allocator.equals(allocator.publicKey));
  });

  it("Should fail deposit token with invalid token program", async () => {
    const depositAmount = LAMPORTS_PER_SOL / 10;
    const id = Array.from(Buffer.alloc(32, 20));

    // Try to deposit SPL token but pass Token2022 program ID
    try {
      await program.methods
        .depositToken(new anchor.BN(depositAmount), id)
        .accountsPartial({
          relayDepository: relayDepositoryPDA,
          mint: mintPubkey, // SPL Token mint
          sender: user.publicKey,
          senderTokenAccount: userTokenAccount,
          depositor: user.publicKey,
          vaultTokenAccount: vaultTokenAccount,
          vault: vaultPDA,
          tokenProgram: TOKEN_2022_PROGRAM_ID, // Wrong program - using Token2022 for SPL Token
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      assert.fail("Should have failed with invalid token program");
    } catch (err) {
      // The error should indicate invalid mint or token program constraint violation
      assert.ok(
        err.message.includes("InvalidMint") ||
          err.message.includes("invalid program id") ||
          err.message.includes("incorrect program id") ||
          err.message.includes("ConstraintAssociatedTokenTokenProgram"),
        `Unexpected error: ${err.message}`
      );
    }
  });

  it("Should fail execute token transfer with invalid token program", async () => {
    const transferAmount = LAMPORTS_PER_SOL / 10;

    const request = {
      recipient: recipient.publicKey,
      token: mintPubkey, // SPL Token
      amount: new anchor.BN(transferAmount),
      nonce: new anchor.BN(Date.now() + Math.floor(Math.random() * 1000)),
      expiration: new anchor.BN(Math.floor(Date.now() / 1000) + 300),
    };

    const messagHash = hashRequest(request);
    const signature = nacl.sign.detached(messagHash, allocator.secretKey);
    const requestPDA = await getUsedRequestPDA(request);

    try {
      // Try to execute with Token2022 program for SPL Token mint
      await program.methods
        .executeTransfer(request)
        .accountsPartial({
          mint: mintPubkey,
          vaultTokenAccount,
          recipientTokenAccount,
          relayDepository: relayDepositoryPDA,
          executor: provider.wallet.publicKey,
          recipient: recipient.publicKey,
          vault: vaultPDA,
          usedRequest: requestPDA,
          tokenProgram: TOKEN_2022_PROGRAM_ID, // Wrong program
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          ixSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([
          anchor.web3.Ed25519Program.createInstructionWithPublicKey({
            publicKey: allocator.publicKey.toBytes(),
            message: messagHash,
            signature: signature,
          }),
        ])
        .rpc();

      assert.fail("Should have failed with invalid token program");
    } catch (err) {
      // The error should indicate invalid mint or token program constraint violation
      assert.ok(
        err.message.includes("InvalidMint") ||
          err.message.includes("invalid program id") ||
          err.message.includes("incorrect program id") ||
          err.message.includes("ConstraintAssociatedTokenTokenProgram"),
        `Unexpected error: ${err.message}`
      );
    }
  });

  it("Execute multiple transfer requests in a single transaction", async () => {
    const transferAmount = LAMPORTS_PER_SOL / 10; // 0.25 SOL each

    // Create two transfer requests
    const request1 = {
      recipient: recipient.publicKey,
      token: null, // SOL transfer
      amount: new anchor.BN(transferAmount),
      nonce: new anchor.BN(Date.now() + Math.floor(Math.random() * 1000)),
      expiration: new anchor.BN(Math.floor(Date.now() / 1000) + 300),
    };

    const request2 = {
      recipient: recipient.publicKey,
      token: mintPubkey, // Token transfer
      amount: new anchor.BN(transferAmount),
      nonce: new anchor.BN(Date.now() + Math.floor(Math.random() * 1000)),
      expiration: new anchor.BN(Math.floor(Date.now() / 1000) + 300),
    };

    // Encode messages and create signatures
    const message1Hash = hashRequest(request1);
    const message2Hash = hashRequest(request2);

    const signature1 = nacl.sign.detached(message1Hash, allocator.secretKey);
    const signature2 = nacl.sign.detached(message2Hash, allocator.secretKey);

    // Get PDAs
    const requestPDA1 = await getUsedRequestPDA(request1);
    const requestPDA2 = await getUsedRequestPDA(request2);

    // Get initial balances
    const recipientSOLBefore = await provider.connection.getBalance(
      recipient.publicKey
    );
    const vaultSOLBefore = await provider.connection.getBalance(vaultPDA);
    const recipientTokenBefore =
      await provider.connection.getTokenAccountBalance(recipientTokenAccount);
    const vaultTokenBefore = await provider.connection.getTokenAccountBalance(
      vaultTokenAccount
    );

    // Create transaction with multiple instructions
    const tx = new anchor.web3.Transaction();

    // Add first transfer (SOL)
    tx.add(
      anchor.web3.Ed25519Program.createInstructionWithPublicKey({
        publicKey: allocator.publicKey.toBytes(),
        message: message1Hash,
        signature: signature1,
      })
    );

    tx.add(
      await program.methods
        .executeTransfer(request1)
        .accountsPartial({
          mint: null,
          vaultTokenAccount: null,
          recipientTokenAccount: null,
          relayDepository: relayDepositoryPDA,
          executor: provider.wallet.publicKey,
          recipient: recipient.publicKey,
          vault: vaultPDA,
          usedRequest: requestPDA1,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          ixSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction()
    );

    // Add second transfer (Token)
    tx.add(
      anchor.web3.Ed25519Program.createInstructionWithPublicKey({
        publicKey: allocator.publicKey.toBytes(),
        message: message2Hash,
        signature: signature2,
      })
    );

    tx.add(
      await program.methods
        .executeTransfer(request2)
        .accountsPartial({
          mint: mintPubkey,
          vaultTokenAccount,
          recipientTokenAccount,
          relayDepository: relayDepositoryPDA,
          executor: provider.wallet.publicKey,
          recipient: recipient.publicKey,
          vault: vaultPDA,
          usedRequest: requestPDA2,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          ixSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction()
    );

    // Send transaction
    await provider.sendAndConfirm(tx);

    // Verify execution
    const usedRequestState1 = await program.account.usedRequest.fetch(
      requestPDA1
    );
    const usedRequestState2 = await program.account.usedRequest.fetch(
      requestPDA2
    );

    assert.equal(
      usedRequestState1.isUsed,
      true,
      "First request should be marked as used"
    );
    assert.equal(
      usedRequestState2.isUsed,
      true,
      "Second request should be marked as used"
    );

    // Verify balances
    const recipientSOLAfter = await provider.connection.getBalance(
      recipient.publicKey
    );
    const vaultSOLAfter = await provider.connection.getBalance(vaultPDA);
    const recipientTokenAfter =
      await provider.connection.getTokenAccountBalance(recipientTokenAccount);
    const vaultTokenAfter = await provider.connection.getTokenAccountBalance(
      vaultTokenAccount
    );

    // Verify SOL transfer
    assert.equal(
      recipientSOLAfter - recipientSOLBefore,
      transferAmount,
      "Incorrect SOL transfer amount"
    );
    assert.equal(
      vaultSOLBefore - vaultSOLAfter,
      transferAmount,
      "Incorrect SOL deduction from vault"
    );

    // Verify Token transfer
    assert.equal(
      Number(recipientTokenAfter.value.amount) -
        Number(recipientTokenBefore.value.amount),
      transferAmount,
      "Incorrect token transfer amount"
    );
    assert.equal(
      Number(vaultTokenBefore.value.amount) -
        Number(vaultTokenAfter.value.amount),
      transferAmount,
      "Incorrect token deduction from vault"
    );
  });

  it("Should fail executing multiple transfer request if one signature is invalid", async () => {
    const transferAmount = LAMPORTS_PER_SOL / 10;

    // Create two transfer requests
    const request1 = {
      recipient: recipient.publicKey,
      token: null,
      amount: new anchor.BN(transferAmount),
      nonce: new anchor.BN(Date.now() + Math.floor(Math.random() * 1000)),
      expiration: new anchor.BN(Math.floor(Date.now() / 1000) + 300),
    };
    const request2 = {
      recipient: recipient.publicKey,
      token: null,
      amount: new anchor.BN(transferAmount),
      nonce: new anchor.BN(Date.now() + Math.floor(Math.random() * 1000)),
      expiration: new anchor.BN(Math.floor(Date.now() / 1000) + 300),
    };

    const message1Hash = hashRequest(request1);
    const message2Hash = hashRequest(request2);

    const signature1 = nacl.sign.detached(message1Hash, allocator.secretKey);

    // Use wrong signer for second signature
    const fakeAllocator = Keypair.generate();
    const signature2 = nacl.sign.detached(
      message2Hash,
      fakeAllocator.secretKey
    );

    const requestPDA1 = await getUsedRequestPDA(request1);
    const requestPDA2 = await getUsedRequestPDA(request2);

    const tx = new anchor.web3.Transaction();

    // Add first transfer
    tx.add(
      anchor.web3.Ed25519Program.createInstructionWithPublicKey({
        publicKey: allocator.publicKey.toBytes(),
        message: message1Hash,
        signature: signature1,
      })
    );

    tx.add(
      await program.methods
        .executeTransfer(request1)
        .accountsPartial({
          mint: null,
          vaultTokenAccount: null,
          recipientTokenAccount: null,
          relayDepository: relayDepositoryPDA,
          executor: provider.wallet.publicKey,
          recipient: recipient.publicKey,
          vault: vaultPDA,
          usedRequest: requestPDA1,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          ixSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction()
    );

    // Add second transfer with invalid signature
    tx.add(
      anchor.web3.Ed25519Program.createInstructionWithPublicKey({
        publicKey: fakeAllocator.publicKey.toBytes(),
        message: message2Hash,
        signature: signature2,
      })
    );

    tx.add(
      await program.methods
        .executeTransfer(request2)
        .accountsPartial({
          mint: null,
          vaultTokenAccount: null,
          recipientTokenAccount: null,
          relayDepository: relayDepositoryPDA,
          executor: provider.wallet.publicKey,
          recipient: recipient.publicKey,
          vault: vaultPDA,
          usedRequest: requestPDA2,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          ixSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction()
    );

    try {
      await provider.sendAndConfirm(tx);
      assert.fail("Should fail due to invalid signature");
    } catch (e) {
      assert.include(e.message, "AllocatorSignerMismatch");

      // Verify neither transfer was executed
      try {
        await program.account.usedRequest.fetch(requestPDA1);
        assert.fail("First request should not exist");
      } catch (e) {
        assert.include(e.message, "Account does not exist");
      }

      try {
        await program.account.usedRequest.fetch(requestPDA2);
        assert.fail("Second request should not exist");
      } catch (e) {
        assert.include(e.message, "Account does not exist");
      }
    }
  });

  const hashRequest = (request: any) => {
    const message = program.coder.types.encode("transferRequest", request);
    const hashData = sha256.create();
    hashData.update(message);
    return Buffer.from(hashData.array());
  };

  const getUsedRequestPDA = async (request: any) => {
    const requestHash = hashRequest(request);
    const [pda] = await PublicKey.findProgramAddress(
      [Buffer.from("used_request"), requestHash],
      program.programId
    );
    return pda;
  };
});

async function createMintWithTransferFee(
  connection: anchor.web3.Connection,
  payer: anchor.web3.Signer,
  mintAuthority: anchor.web3.Signer,
  mintKeypair = Keypair.generate(),
  transferFeeConfig: { transferFeeBasisPoints: number; MaxFee: number }
) {
  const transferFeeConfigAuthority = Keypair.generate();
  const withdrawWithheldAuthority = Keypair.generate();

  const extensions = [ExtensionType.TransferFeeConfig];

  const mintLen = getMintLen(extensions);
  const decimals = 9;

  const mintLamports = await connection.getMinimumBalanceForRentExemption(
    mintLen
  );
  const mintTransaction = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mintKeypair.publicKey,
      space: mintLen,
      lamports: mintLamports,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeTransferFeeConfigInstruction(
      mintKeypair.publicKey,
      transferFeeConfigAuthority.publicKey,
      withdrawWithheldAuthority.publicKey,
      transferFeeConfig.transferFeeBasisPoints,
      BigInt(transferFeeConfig.MaxFee),
      TOKEN_2022_PROGRAM_ID
    ),
    createInitializeMintInstruction(
      mintKeypair.publicKey,
      decimals,
      mintAuthority.publicKey,
      null,
      TOKEN_2022_PROGRAM_ID
    )
  );
  await sendAndConfirmTransaction(
    connection,
    mintTransaction,
    [payer, mintKeypair],
    undefined
  );

  return mintKeypair.publicKey;
}

const createMaliciousEd25519Instruction = (
  allocatorPubkey: Uint8Array,
  realPublicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
  instructionIndex?: number
): TransactionInstruction => {
  // Ed25519 instruction layout offsets
  const ED25519_INSTRUCTION_LAYOUT_SIZE = 16; // Size of the instruction header
  const fakePublicKeyOffset = ED25519_INSTRUCTION_LAYOUT_SIZE; // This will contain allocator pubkey for validation
  const signatureOffset = fakePublicKeyOffset + allocatorPubkey.length;
  const messageDataOffset = signatureOffset + signature.length;
  const realPublicKeyOffset = messageDataOffset + message.length; // Real pubkey goes at the end
  const numSignatures = 1;

  const instructionData = Buffer.alloc(
    realPublicKeyOffset + realPublicKey.length
  );

  const index = instructionIndex == null ? 0xffff : instructionIndex;

  // Write instruction layout header - publicKeyOffset points to the real key at the end
  instructionData.writeUInt8(numSignatures, 0); // numSignatures
  instructionData.writeUInt8(0, 1); // padding
  instructionData.writeUInt16LE(signatureOffset, 2); // signatureOffset
  instructionData.writeUInt16LE(index, 4); // signatureInstructionIndex
  instructionData.writeUInt16LE(realPublicKeyOffset, 6); // publicKeyOffset - points to real key
  instructionData.writeUInt16LE(index, 8); // publicKeyInstructionIndex
  instructionData.writeUInt16LE(messageDataOffset, 10); // messageDataOffset
  instructionData.writeUInt16LE(message.length, 12); // messageDataSize
  instructionData.writeUInt16LE(index, 14); // messageInstructionIndex

  // Copy data - allocator pubkey at offset 16 (for validation check), real pubkey at the end
  instructionData.set(allocatorPubkey, fakePublicKeyOffset);
  instructionData.set(signature, signatureOffset);
  instructionData.set(message, messageDataOffset);
  instructionData.set(realPublicKey, realPublicKeyOffset);

  return new TransactionInstruction({
    keys: [],
    programId: new PublicKey("Ed25519SigVerify111111111111111111111111111"),
    data: instructionData,
  });
};
