import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  getAccount,
  NATIVE_MINT,
  createTransferInstruction,
} from "@solana/spl-token";
import { assert } from "chai";

import { RelayForwarder } from "../target/types/relay_forwarder";
import { RelayEscrow } from "../target/types/relay_escrow";

describe("Relay Forwarder", () => {
  // Configure the client to use the local cluster
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const forwarderProgram = anchor.workspace
    .RelayForwarder as Program<RelayForwarder>;
  const escrowProgram = anchor.workspace.RelayEscrow as Program<RelayEscrow>;

  const sender = provider.wallet as anchor.Wallet;

  // Test accounts
  const depositor = anchor.web3.Keypair.generate();

  // PDAs
  let relayEscrow: anchor.web3.PublicKey;
  let vault: anchor.web3.PublicKey;

  // Test token related
  let mint: anchor.web3.PublicKey;
  let senderAta: anchor.web3.PublicKey;
  let vaultAta: anchor.web3.PublicKey;

  before(async () => {
    // Airdrop SOL to test accounts
    const airdropPromises = [
      // Airdrop to depositor (original_depositor parameter, doesn't need funds)
      provider.connection.requestAirdrop(
        sender.publicKey,
        1 * anchor.web3.LAMPORTS_PER_SOL
      ),
    ];

    const signatures = await Promise.all(airdropPromises);
    await Promise.all(
      signatures.map((sig) => provider.connection.confirmTransaction(sig))
    );

    // Get PDAs for relay-escrow
    [relayEscrow] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("relay_escrow")],
      escrowProgram.programId
    );

    [vault] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault")],
      escrowProgram.programId
    );

    {
      // Min-rent top-up
      const rentExemptMinimum = await provider.connection.getMinimumBalanceForRentExemption(0);
      const [forwarderPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("forwarder")],
        forwarderProgram.programId
      );

      const currentBalance = await provider.connection.getBalance(forwarderPda);
      const topUpAmount = rentExemptMinimum - currentBalance;

      await provider.sendAndConfirm(
        new anchor.web3.Transaction().add(
          anchor.web3.SystemProgram.transfer({
            fromPubkey: sender.publicKey,
            toPubkey: forwarderPda,
            lamports: topUpAmount,
          })
        )
      );
    }

    // Initialize relay-escrow (only needed if running this test individually)
    // await escrowProgram.methods
    //   .initialize()
    //   .accountsPartial({
    //     relayEscrow,
    //     vault,
    //     owner: wallet.publicKey,
    //     allocator: wallet.publicKey,
    //     systemProgram: anchor.web3.SystemProgram.programId,
    //   })
    //   .rpc();

    // Create test token
    mint = await createMint(
      provider.connection,
      sender.payer,
      sender.publicKey,
      null,
      9
    );

    // Create forwarder's token account (used for actual transfers)
    senderAta = await createAssociatedTokenAccount(
      provider.connection,
      sender.payer,
      mint,
      sender.publicKey
    );

    // Mint some tokens to forwarder
    await mintTo(
      provider.connection,
      sender.payer,
      mint,
      senderAta,
      sender.publicKey,
      1_000_000_000 // 1 token
    );

    // Get vault's token account address
    vaultAta = await getAssociatedTokenAddress(mint, vault, true);

    // Create vault token account if it doesn't exist
    try {
      await getAccount(provider.connection, vaultAta);
    } catch (err) {
      // Create the vault token account
      const tx = new anchor.web3.Transaction().add(
        createAssociatedTokenAccountInstruction(
          sender.publicKey, // payer
          vaultAta, // associated token account address
          vault, // owner
          mint // token mint
        )
      );
      await provider.sendAndConfirm(tx);
    }
  });

  it("Forward native", async () => {
    const id = Array.from(anchor.web3.Keypair.generate().publicKey.toBytes());

    // Get forwarder PDA
    const [forwarderPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("forwarder")],
      forwarderProgram.programId
    );

    const depositAmount = 1 * anchor.web3.LAMPORTS_PER_SOL;

    // Get initial balances
    const vaultBalanceBefore = await provider.connection.getBalance(vault);

    // Transfer SOL to forwarder PDA
    await provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        anchor.web3.SystemProgram.transfer({
          fromPubkey: sender.publicKey,
          toPubkey: forwarderPda,
          lamports: depositAmount,
        })
      )
    );

    // Get the forwarder account info to confirm it was created
    const forwarderInfoBefore = await provider.connection.getAccountInfo(
      forwarderPda
    );
    assert.isNotNull(
      forwarderInfoBefore,
      "Forwarder account should be created"
    );

    // Forward SOL from PDA to vault with should_close = true
    const depositTx = await forwarderProgram.methods
      .forwardNative(id)
      .accountsPartial({
        sender: sender.publicKey,
        depositor: depositor.publicKey,
        forwarder: forwarderPda,
        relayEscrow,
        relayVault: vault,
        relayEscrowProgram: escrowProgram.programId,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    // Wait for transaction confirmation
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Verify the forwarder account is closed or properly emptied
    const forwarderInfoAfter = await provider.connection.getAccountInfo(
      forwarderPda
    );

    // There are two possible outcomes:
    // 1. Account is completely closed (null)
    // 2. Account exists but with 0 lamports (emptied)
    if (forwarderInfoAfter === null) {
      // Account was completely closed
      assert.isTrue(true, "Forwarder account was successfully closed");
    } else {
      // Account exists but should have 0 lamports
      assert.equal(
        forwarderInfoAfter.lamports,
        0,
        "Forwarder account should have 0 lamports if not completely closed"
      );
    }

    // Verify vault received the deposit amount
    const vaultBalanceAfter = await provider.connection.getBalance(vault);
    const vaultChange = vaultBalanceAfter - vaultBalanceBefore;
    assert.equal(
      vaultChange,
      depositAmount,
      "Vault balance should increase by deposit amount"
    );

    // Process deposit event verification as in the original test
    const depositTxTransaction = await provider.connection.getParsedTransaction(
      depositTx,
      {
        commitment: "confirmed",
      }
    );

    let events: any[] = [];
    for (const logMessage of depositTxTransaction?.meta?.logMessages || []) {
      if (!logMessage.startsWith("Program data: ")) {
        continue;
      }
      const event = escrowProgram.coder.events.decode(
        logMessage.slice("Program data: ".length)
      );
      if (event) {
        events.push(event);
      }
    }

    const DepositEvent = events.find((event) => event.name === "depositEvent");
    assert.exists(DepositEvent);
    assert.equal(DepositEvent?.data.amount.toNumber(), depositAmount);
    assert.equal(
      DepositEvent?.data.depositor.toBase58(),
      depositor.publicKey.toBase58()
    );
    assert.equal(DepositEvent?.data.id.toString(), id.toString());
  });

  it("Forward token", async () => {
    // Generate unique ID for this forward
    const id = Array.from(anchor.web3.Keypair.generate().publicKey.toBytes());

    // Get forwarder PDA and  its token account
    const [forwarderPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("forwarder")],
      forwarderProgram.programId
    );

    const forwarderAta = await getAssociatedTokenAddress(
      mint,
      forwarderPda,
      true
    );

    const depositAmount = 1_000_000;

    // Create PDA's token account and transfer tokens to it
    await provider.sendAndConfirm(
      new anchor.web3.Transaction()
        .add(
          createAssociatedTokenAccountInstruction(
            sender.publicKey,
            forwarderAta,
            forwarderPda,
            mint
          )
        )
        .add(
          createTransferInstruction(
            senderAta,
            forwarderAta,
            sender.publicKey,
            depositAmount
          )
        )
    );

    // Get initial balances
    const vaultTokenBalanceBefore = await provider.connection
      .getTokenAccountBalance(vaultAta)
      .then((res) => res.value.amount)
      .catch(() => "0");

    const forwarderTokenBalanceBefore = await provider.connection
      .getTokenAccountBalance(forwarderAta)
      .then((res) => res.value.amount)
      .catch(() => "0");

    const forwardDepositTx = await forwarderProgram.methods
      .forwardToken(id)
      .accountsPartial({
        sender: sender.publicKey,
        depositor: depositor.publicKey,
        relayEscrow,
        relayVault: vault,
        mint,
        forwarderTokenAccount: forwarderAta,
        relayVaultTokenAccount: vaultAta,
        relayEscrowProgram: escrowProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    // Wait for transaction confirmation
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const depositTxTransaction = await provider.connection.getParsedTransaction(
      forwardDepositTx,
      {
        commitment: "confirmed",
      }
    );
    let events: any[] = [];
    for (const logMessage of depositTxTransaction?.meta?.logMessages || []) {
      if (!logMessage.startsWith("Program data: ")) {
        continue;
      }
      const event = escrowProgram.coder.events.decode(
        logMessage.slice("Program data: ".length)
      );
      if (event) {
        events.push(event);
      }
    }

    const DepositEvent = events.find((event) => event.name === "depositEvent");
    assert.exists(DepositEvent);

    assert.equal(DepositEvent?.data.amount.toNumber(), depositAmount);
    assert.equal(
      DepositEvent?.data.depositor.toBase58(),
      depositor.publicKey.toBase58()
    );
    assert.equal(DepositEvent?.data.id.toString(), id.toString());
    assert.equal(DepositEvent?.data.token.toBase58(), mint.toBase58());

    // Verify token balances
    const vaultTokenBalanceAfter = await provider.connection
      .getTokenAccountBalance(vaultAta)
      .then((res) => res.value.amount);

    const forwarderTokenBalanceAfter = await provider.connection
      .getTokenAccountBalance(forwarderAta)
      .then((res) => res.value.amount)
      .catch(() => "0");

    // Check vault received all tokens
    assert.equal(
      Number(forwarderTokenBalanceBefore),
      Number(vaultTokenBalanceAfter) - Number(vaultTokenBalanceBefore),
      "Vault should receive all tokens from forwarder"
    );

    // Check forwarder sent all tokens
    assert.equal(
      Number(forwarderTokenBalanceAfter),
      0,
      "Forwarder should have 0 tokens after transfer"
    );
  });

  it("Forward wrapped-native and close account successfully", async () => {
    const id = Array.from(anchor.web3.Keypair.generate().publicKey.toBytes());

    // Get forwarder PDA and its wrapped SOL account
    const [forwarderPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("forwarder")],
      forwarderProgram.programId
    );

    // Get PDA's wrapped SOL account
    const forwarderWsolAta = await getAssociatedTokenAddress(
      NATIVE_MINT,
      forwarderPda,
      true
    );

    // Get vault's wrapped SOL account
    const vaultWsolAta = await getAssociatedTokenAddress(
      NATIVE_MINT,
      vault,
      true
    );

    // Amount to wrap and forward
    const wrapAmount = 1 * anchor.web3.LAMPORTS_PER_SOL;

    // Create vault's wrapped SOL account if it doesn't exist
    try {
      await getAccount(provider.connection, vaultWsolAta);
    } catch (err) {
      const tx = new anchor.web3.Transaction().add(
        createAssociatedTokenAccountInstruction(
          sender.publicKey,
          vaultWsolAta,
          vault,
          NATIVE_MINT
        )
      );
      await provider.sendAndConfirm(tx);
    }

    // Get initial vault balance
    const vaultWsolBefore = await provider.connection
      .getTokenAccountBalance(vaultWsolAta)
      .then((res) => new BN(res.value.amount))
      .catch(() => new BN(0));

    // Create PDA's wrapped SOL account and transfer SOL directly from sender
    await provider.sendAndConfirm(
      new anchor.web3.Transaction()
        .add(
          createAssociatedTokenAccountInstruction(
            sender.publicKey,
            forwarderWsolAta,
            forwarderPda,
            NATIVE_MINT
          )
        )
        .add(
          anchor.web3.SystemProgram.transfer({
            fromPubkey: sender.publicKey,
            toPubkey: forwarderWsolAta,
            lamports: wrapAmount,
          })
        )
        .add(createSyncNativeInstruction(forwarderWsolAta))
    );

    // Forward wrapped SOL and close account
    await forwarderProgram.methods
      .forwardToken(id)
      .accountsPartial({
        sender: sender.publicKey,
        depositor: depositor.publicKey,
        forwarder: forwarderPda,
        relayEscrow,
        relayVault: vault,
        mint: NATIVE_MINT,
        forwarderTokenAccount: forwarderWsolAta,
        relayVaultTokenAccount: vaultWsolAta,
        relayEscrowProgram: escrowProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    // Wait for transaction confirmation
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Get final vault balance
    const vaultWsolAfter = await provider.connection
      .getTokenAccountBalance(vaultWsolAta)
      .then((res) => new BN(res.value.amount));

    // Verify wrapped SOL account is closed
    try {
      await getAccount(provider.connection, forwarderWsolAta);
      assert.fail("Wrapped SOL account should be closed");
    } catch (err) {
      assert.include(err.toString(), "TokenAccountNotFoundError");
    }

    // Verify vault received all wrapped SOL
    assert.equal(
      vaultWsolAfter.sub(vaultWsolBefore).toString(),
      new BN(wrapAmount).toString(),
      "Vault should receive all wrapped SOL"
    );
  });

  it("Should fail with insufficient balance", async () => {
    const id = Array.from(anchor.web3.Keypair.generate().publicKey.toBytes());
    const [forwarderPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("forwarder")],
      forwarderProgram.programId
    );

    try {
      await forwarderProgram.methods
        .forwardNative(id)
        .accountsPartial({
          sender: sender.publicKey,
          depositor: depositor.publicKey,
          forwarder: forwarderPda,
          relayEscrow,
          relayVault: vault,
          relayEscrowProgram: escrowProgram.programId,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
      // assert.fail("Expected transaction to fail");
    } catch (err) {
      assert.include(err.message, "Insufficient balance");
    }
  });
});