import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { RelayEscrow } from "../target/types/relay_escrow";
import {
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Keypair,
} from "@solana/web3.js";

import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  createAssociatedTokenAccount,
  getAssociatedTokenAddress,
  mintTo,
} from "@solana/spl-token";
import { assert } from "chai";

import * as nacl from "tweetnacl";
import { sha256 } from 'js-sha256';

describe("Relay Escrow", () => {
  const provider = anchor.AnchorProvider.env();

  // Configure the client to use the local cluster.
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
      await provider.connection.requestAirdrop(owner.publicKey, 10 * LAMPORTS_PER_SOL)
    );
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(user.publicKey, 2 * LAMPORTS_PER_SOL)
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
      await provider.connection.requestAirdrop(nonOwner.publicKey, LAMPORTS_PER_SOL)
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

  it("Deposit SOL", async () => {
    const depositAmount = LAMPORTS_PER_SOL; // 1 SOL
    const id = Buffer.from(Array(32).fill(1)); // Example ID

    const userBalanceBefore = await provider.connection.getBalance(user.publicKey);
    const vaultBalanceBefore = await provider.connection.getBalance(vaultPDA);

    await program.methods
      .depositSol(new anchor.BN(depositAmount), id)
      .accounts({
        relayEscrow: relayEscrowPDA,
        depositor: user.publicKey,
        vault: vaultPDA,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    const userBalanceAfter = await provider.connection.getBalance(user.publicKey);
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

  it("Deposit SPL Token", async () => {
    const depositAmount = LAMPORTS_PER_SOL; // 1 token
    const id = Array.from(Buffer.alloc(32, 2)); // Example ID

    try {
      // Get initial balances
      const userBalanceBefore = await provider.connection.getTokenAccountBalance(userTokenAccount);
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
      const userBalanceAfter = await provider.connection.getTokenAccountBalance(userTokenAccount);
      const vaultBalanceAfter = await provider.connection.getTokenAccountBalance(vaultTokenAccount);

      assert.equal(
        Number(userBalanceBefore.value.amount) - Number(userBalanceAfter.value.amount),
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
    const transferAmount = LAMPORTS_PER_SOL / 2; // 0.5 SOL
    
    // Create transfer request
    const request = {
      recipient: recipient.publicKey,
      token: null, // SOL transfer
      amount: new anchor.BN(transferAmount),
      nonce: new anchor.BN(Date.now() + Math.floor(Math.random() * 1000)),
      expiration: new anchor.BN(Math.floor(( Date.now() / 1000)) + 300)
    };

    const message = program.coder.types.encode(
      'TransferRequest',
      request
    );

    // Sign with allocator
    const signature = nacl.sign.detached(message, allocator.secretKey);

    const recipientBalanceBefore = await provider.connection.getBalance(recipient.publicKey);
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
      .preInstructions(
        [
          anchor.web3.Ed25519Program.createInstructionWithPublicKey({
            publicKey: allocator.publicKey.toBytes(),
            message: message,
            signature: signature,
          }),
        ]
      );

    const events = (await hanlde.simulate()).events || [];
    const TransferExecutedEvent = events.find(c => c.name === "TransferExecutedEvent");
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

    const recipientBalanceAfter = await provider.connection.getBalance(recipient.publicKey);
    const vaultBalanceAfter = await provider.connection.getBalance(vaultPDA);

    assert.equal(
      usedRequestState.isUsed,
      true,
      "Incorrect usedRequest State"
    );

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
      expiration: new anchor.BN(Math.floor(( Date.now() / 1000)) + 300)
    };

    const message = program.coder.types.encode(
      'TransferRequest',
      request
    );

    // Sign with allocator
    const signature = nacl.sign.detached(message, allocator.secretKey);

    const recipientBalanceBefore = await provider.connection.getTokenAccountBalance(recipientTokenAccount);
    const vaultBalanceBefore = await provider.connection.getTokenAccountBalance(vaultTokenAccount);

    const requestPDA = await getUsedRequestPDA(request);

    const txSignature = await program.methods
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
      .preInstructions(
       [
          anchor.web3.Ed25519Program.createInstructionWithPublicKey({
            publicKey: allocator.publicKey.toBytes(),
            message: message,
            signature: signature,
          }),
       ]
      )
      .rpc();

    const usedRequestState = await program.account.usedRequest.fetch(
      requestPDA
    );

    const recipientBalanceAfter = await provider.connection.getTokenAccountBalance(recipientTokenAccount);
    const vaultBalanceAfter = await provider.connection.getTokenAccountBalance(vaultTokenAccount);

    assert.equal(
      usedRequestState.isUsed,
      true,
      "Incorrect usedRequest State"
    );

    assert.equal(
      Number(recipientBalanceAfter.value.amount) - Number(recipientBalanceBefore.value.amount),
      transferAmount,
      "Incorrect SPL transfer to recipient"
    );
    assert.equal(
      Number(vaultBalanceBefore.value.amount) - Number(vaultBalanceAfter.value.amount),
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
      expiration: new anchor.BN(Math.floor(( Date.now() / 1000)) + 300)
    };
  
    const message = program.coder.types.encode(
      'TransferRequest',
      request
    );
  
    // Create invalid signature with fake allocator
    const invalidSignature = nacl.sign.detached(message, fakeAllocator.secretKey);
  
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
        .preInstructions(
          [
            anchor.web3.Ed25519Program.createInstructionWithPublicKey({
              publicKey: fakeAllocator.publicKey.toBytes(),
              message: message,
              signature: invalidSignature,
            }),
          ]
        )
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
      expiration: new anchor.BN(Math.floor(( Date.now() / 1000)) + 300)
    };
  
    const message = program.coder.types.encode(
      'TransferRequest',
      request
    );
    
    const signature = nacl.sign.detached(message, allocator.secretKey);
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
      .preInstructions(
        [
          anchor.web3.Ed25519Program.createInstructionWithPublicKey({
            publicKey: allocator.publicKey.toBytes(),
            message: message,
            signature: signature,
          }),
        ]
      )
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
        .preInstructions(
          [
            anchor.web3.Ed25519Program.createInstructionWithPublicKey({
              publicKey: allocator.publicKey.toBytes(),
              message: message,
              signature: signature,
            }),
          ]
        )
        .rpc();
      assert.fail("Should have failed with request already used");
    } catch (e) {
      assert.include(e.message, "already in use");
      assert.include(e.message, requestPDA.toBase58());
    }
  });

  const getUsedRequestPDA = async (request) => {
    const message = program.coder.types.encode(
      'TransferRequest',
      request
    );
    
    const hashData = sha256.create();
    hashData.update(message);
    const requestHash = Buffer.from(hashData.array());
    const [pda] = await PublicKey.findProgramAddress(
      [
        Buffer.from("used_request"),
        requestHash
      ],
      program.programId
    );
    return pda;
  };
});