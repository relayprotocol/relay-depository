import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  createAssociatedTokenAccount,
  getAssociatedTokenAddress,
  mintTo,
} from "@solana/spl-token";
import {
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Keypair,
} from "@solana/web3.js";
import { assert } from "chai";
import { sha256 } from "js-sha256";
import nacl from "tweetnacl";

import { RelayEscrow } from "../target/types/relay_escrow";

describe("Relay Escrow", () => {
  const provider = anchor.AnchorProvider.env();

  // Configure the client to use the local cluster
  anchor.setProvider(provider);

  const program = anchor.workspace.RelayEscrow as Program<RelayEscrow>;

  // Test accounts
  const owner = Keypair.generate();
  const allocator = Keypair.generate();
  const user = Keypair.generate();
  const recipient = Keypair.generate();

  // PDAs
  let relayEscrowPDA: PublicKey;
  let vaultPDA: PublicKey;
  let vaultBump: number;

  // SPL Token test accounts
  let mintKeypair: Keypair;
  let mintPubkey: PublicKey;
  let userTokenAccount: PublicKey;
  let vaultTokenAccount: PublicKey;
  let recipientTokenAccount: PublicKey;

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

    // Find PDAs
    [relayEscrowPDA] = await PublicKey.findProgramAddress(
      [Buffer.from("relay_escrow")],
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

    // Create token accounts
    userTokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      owner,
      mintPubkey,
      user.publicKey
    );

    // Get vault token account address
    vaultTokenAccount = await getAssociatedTokenAddress(
      mintPubkey,
      vaultPDA,
      true // allowOwnerOffCurve - this is important for PDA
    );

    recipientTokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      owner,
      mintPubkey,
      recipient.publicKey
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
  });

  it("Initialize RelayEscrow", async () => {
    try {
      await program.methods
        .initialize()
        .accounts({
          relayEscrow: relayEscrowPDA,
          vault: vaultPDA,
          owner: owner.publicKey,
          allocator: allocator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([owner])
        .rpc();

      // Verify initialization
      const relayEscrowAccount = await program.account.relayEscrow.fetch(
        relayEscrowPDA
      );
      assert.ok(relayEscrowAccount.owner.equals(owner.publicKey));
      assert.ok(relayEscrowAccount.allocator.equals(allocator.publicKey));
      assert.equal(relayEscrowAccount.vaultBump, vaultBump);
    } catch (error) {
      console.error("Error during initialization:", error);
      throw error;
    }
  });

  it("Owner can set new allocator", async () => {
    const newAllocator = Keypair.generate();

    // Call set_allocator as owner
    await program.methods
      .setAllocator(newAllocator.publicKey)
      .accounts({
        relayEscrow: relayEscrowPDA,
        owner: owner.publicKey,
      })
      .signers([owner])
      .rpc();

    // Verify the allocator was updated
    const relayEscrowAccount = await program.account.relayEscrow.fetch(
      relayEscrowPDA
    );
    assert.ok(relayEscrowAccount.allocator.equals(newAllocator.publicKey));

    // Reset allocator back to original for other tests
    await program.methods
      .setAllocator(allocator.publicKey)
      .accounts({
        relayEscrow: relayEscrowPDA,
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
        .accounts({
          relayEscrow: relayEscrowPDA,
          owner: nonOwner.publicKey,
        })
        .signers([nonOwner])
        .rpc();

      assert.fail("Should have thrown error");
    } catch (err) {
      assert.include(err.message, "Unauthorized");
    }

    // Verify allocator was not changed
    const relayEscrowAccount = await program.account.relayEscrow.fetch(
      relayEscrowPDA
    );
    assert.ok(relayEscrowAccount.allocator.equals(allocator.publicKey));
  });

  it("Deposit native", async () => {
    const depositAmount = LAMPORTS_PER_SOL; // 1 SOL
    const id = Buffer.from(Array(32).fill(1)); // Example ID

    const userBalanceBefore = await provider.connection.getBalance(
      user.publicKey
    );
    const vaultBalanceBefore = await provider.connection.getBalance(vaultPDA);

    await program.methods
      .depositNative(new anchor.BN(depositAmount), id)
      .accounts({
        relayEscrow: relayEscrowPDA,
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
  });

  it("Deposit Token", async () => {
    const depositAmount = LAMPORTS_PER_SOL; // 1 token
    const id = Array.from(Buffer.alloc(32, 2)); // Example ID

    try {
      // Get initial balances
      const userBalanceBefore =
        await provider.connection.getTokenAccountBalance(userTokenAccount);
      // const vaultBalanceBefore = await provider.connection.getTokenAccountBalance(vaultTokenAccount);

      // Create vault token account if it doesn't exist
      try {
        await createAssociatedTokenAccount(
          provider.connection,
          owner, // payer
          mintPubkey,
          vaultPDA,
          true // allowOwnerOffCurve
        );
      } catch (e) {
        // Skip errors
      }

      // Deposit tokens
      await program.methods
        .depositToken(new anchor.BN(depositAmount), id)
        .accounts({
          relayEscrow: relayEscrowPDA,
          depositor: user.publicKey,
          mint: mintPubkey,
          depositorTokenAccount: userTokenAccount,
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
      const vaultBalanceAfter =
        await provider.connection.getTokenAccountBalance(vaultTokenAccount);

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
    } catch (error) {
      console.error("Error during token deposit:", error);
      throw error;
    }
  });

  it("Execute transfer with allocator signature", async () => {
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
      .accounts({
        mint: null,
        vaultTokenAccount: null,
        recipientTokenAccount: null,
        relayEscrow: relayEscrowPDA,
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
      (c) => c.name === "TransferExecutedEvent"
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

  it("Execute SPL token transfer with allocator signature", async () => {
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
      .accounts({
        mint: mintPubkey,
        vaultTokenAccount,
        recipientTokenAccount,
        relayEscrow: relayEscrowPDA,
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
        .accounts({
          mint: null,
          vaultTokenAccount: null,
          recipientTokenAccount: null,
          relayEscrow: relayEscrowPDA,
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
      .accounts({
        mint: null,
        vaultTokenAccount: null,
        recipientTokenAccount: null,
        relayEscrow: relayEscrowPDA,
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
        .accounts({
          mint: null,
          vaultTokenAccount: null,
          recipientTokenAccount: null,
          relayEscrow: relayEscrowPDA,
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

  it("Execute multiple transfers in single transaction", async () => {
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
        .accounts({
          mint: null,
          vaultTokenAccount: null,
          recipientTokenAccount: null,
          relayEscrow: relayEscrowPDA,
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
        .accounts({
          mint: mintPubkey,
          vaultTokenAccount,
          recipientTokenAccount,
          relayEscrow: relayEscrowPDA,
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

  it("Should fail batch transfer if one signature is invalid", async () => {
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
    const signature2 = nacl.sign.detached(message2Hash, fakeAllocator.secretKey);

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
        .accounts({
          mint: null,
          vaultTokenAccount: null,
          recipientTokenAccount: null,
          relayEscrow: relayEscrowPDA,
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
        .accounts({
          mint: null,
          vaultTokenAccount: null,
          recipientTokenAccount: null,
          relayEscrow: relayEscrowPDA,
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

  const hashRequest = (request) => {
    const message = program.coder.types.encode("TransferRequest", request);
    const hashData = sha256.create();
    hashData.update(message);
    return Buffer.from(hashData.array());
  };

  const getUsedRequestPDA = async (request) => {
    const requestHash = hashRequest(request);
    const [pda] = await PublicKey.findProgramAddress(
      [Buffer.from("used_request"), requestHash],
      program.programId
    );
    return pda;
  };
});
