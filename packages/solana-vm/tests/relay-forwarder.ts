import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { RelayForwarder } from "../target/types/relay_forwarder";
import { RelayEscrow } from "../target/types/relay_escrow";
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
} from "@solana/spl-token";
import { assert } from "chai";

describe("relay-forwarder", () => {
  // Configure the client to use the local cluster
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const forwarderProgram = anchor.workspace.RelayForwarder as Program<RelayForwarder>;
  const escrowProgram = anchor.workspace.RelayEscrow as Program<RelayEscrow>;

  const wallet = provider.wallet as anchor.Wallet;
  
  // Test accounts
  const depositor = anchor.web3.Keypair.generate();
  const forwarder = anchor.web3.Keypair.generate();
  let mint: anchor.web3.PublicKey;
  let depositorAta: anchor.web3.PublicKey;
  let forwarderAta: anchor.web3.PublicKey;
  
  // PDAs
  let relayEscrow: anchor.web3.PublicKey;
  let vault: anchor.web3.PublicKey;
  let vaultAta: anchor.web3.PublicKey;

  before(async () => {
    // Airdrop SOL to test accounts
    const airdropPromises = [
      // Airdrop to depositor (original_depositor parameter, doesn't need funds)
      provider.connection.requestAirdrop(
        depositor.publicKey,
        1 * anchor.web3.LAMPORTS_PER_SOL
      ),
      // Airdrop to forwarder (actual account that will handle funds)
      provider.connection.requestAirdrop(
        forwarder.publicKey,
        10 * anchor.web3.LAMPORTS_PER_SOL
      )
    ];

    const signatures = await Promise.all(airdropPromises);
    await Promise.all(signatures.map(sig => provider.connection.confirmTransaction(sig)));

    // Get PDAs for relay-escrow
    [relayEscrow] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("relay_escrow")],
      escrowProgram.programId
    );

    [vault] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault")],
      escrowProgram.programId
    );

    // Initialize relay-escrow
    await escrowProgram.methods
      .initialize()
      .accounts({
        relayEscrow,
        vault,
        owner: wallet.publicKey,
        allocator: wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    // Create test token
    mint = await createMint(
      provider.connection,
      wallet.payer,
      wallet.publicKey,
      null,
      9
    );

    // Create depositor's token account (not used for transfer, just for references)
    depositorAta = await createAssociatedTokenAccount(
      provider.connection,
      wallet.payer,
      mint,
      depositor.publicKey
    );

    // Create forwarder's token account (used for actual transfers)
    forwarderAta = await createAssociatedTokenAccount(
      provider.connection,
      wallet.payer,
      mint,
      forwarder.publicKey
    );

    // Mint some tokens to forwarder
    await mintTo(
      provider.connection,
      wallet.payer,
      mint,
      forwarderAta,
      wallet.publicKey,
      1_000_000_000 // 1 token
    );

    // Get vault's token account address
    vaultAta = await getAssociatedTokenAddress(
      mint,
      vault,
      true
    );

    // Create vault token account if it doesn't exist
    try {
      await getAccount(provider.connection, vaultAta);
    } catch (err) {
      // Create the vault token account
      const tx = new anchor.web3.Transaction().add(
        createAssociatedTokenAccountInstruction(
          wallet.publicKey,  // payer
          vaultAta,          // associated token account address
          vault,             // owner
          mint               // token mint
        )
      );
      await provider.sendAndConfirm(tx);
    }
  });

  it("Forward native SOL successfully", async () => {
    // Get initial balances
    const vaultBalanceBefore = await provider.connection.getBalance(vault);
    const forwarderBalanceBefore = await provider.connection.getBalance(forwarder.publicKey);
    
    const depositAmount = 10 * anchor.web3.LAMPORTS_PER_SOL;
    
    const id = Array.from(anchor.web3.Keypair.generate().publicKey.toBytes());

    const handle = forwarderProgram.methods
      .forwardNative(id, depositor.publicKey)
      .accounts({
        forwarder: forwarder.publicKey,
        relayEscrow,
        relayVault: vault,
        relayEscrowProgram: escrowProgram.programId,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([forwarder]);

    const depositTx = await handle.rpc();

    // Wait for transaction confirmation
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const depositTxTransaction = await provider.connection.getParsedTransaction(depositTx, {
      commitment: "confirmed",
    });
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

    const DepositEvent = events.find(event => event.name === "DepositEvent");
    assert(DepositEvent);
    
    assert.equal(DepositEvent?.data.amount.toNumber(), depositAmount);
    assert.equal(DepositEvent?.data.depositor.toBase58(), depositor.publicKey.toBase58());
    assert.equal(DepositEvent?.data.id.toString(), id.toString());
    
    // Verify balances
    const vaultBalanceAfter = await provider.connection.getBalance(vault);
    const forwarderBalanceAfter = await provider.connection.getBalance(forwarder.publicKey);

    // Check vault received the expected amount
    const vaultChange = vaultBalanceAfter - vaultBalanceBefore;
    assert.isAbove(
      vaultChange,
      0,
      "Vault balance should increase"
    );

    assert.equal(
      vaultChange,
      depositAmount,
      "Vault balance should increase by deposit amount"
    );

    // Check forwarder sent the expected amount (including fees)
    const forwarderChange = forwarderBalanceBefore - forwarderBalanceAfter;
    assert.isAbove(
      forwarderChange,
      0,
      "Forwarder balance should decrease"
    );
  });

  it("Forward SPL token successfully", async () => {
    const id = Array.from(anchor.web3.Keypair.generate().publicKey.toBytes());

    // Get initial balances
    const vaultTokenBalanceBefore = await provider.connection.getTokenAccountBalance(vaultAta)
      .then(res => res.value.amount)
      .catch(() => "0");
    
    const forwarderTokenBalanceBefore = await provider.connection.getTokenAccountBalance(forwarderAta)
      .then(res => res.value.amount);

    const depositAmount = 1_000_000_000;

    const forwardDepositTx = await forwarderProgram.methods
      .forwardToken(id, depositor.publicKey, false)
      .accounts({
        forwarder: forwarder.publicKey,
        relayEscrow,
        relayVault: vault,
        mint,
        forwarderTokenAccount: forwarderAta,
        relayVaultToken: vaultAta,
        relayEscrowProgram: escrowProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([forwarder])
      .rpc();

    
    // Wait for transaction confirmation
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const depositTxTransaction = await provider.connection.getParsedTransaction(forwardDepositTx, {
      commitment: "confirmed",
    });
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

    const DepositEvent = events.find(event => event.name === "DepositEvent");
    assert(DepositEvent);

    assert.equal(DepositEvent?.data.amount.toNumber(), depositAmount);
    assert.equal(DepositEvent?.data.depositor.toBase58(), depositor.publicKey.toBase58());
    assert.equal(DepositEvent?.data.id.toString(), id.toString());
    assert.equal(DepositEvent?.data.token.toBase58(), mint.toBase58());

    // Verify token balances
    const vaultTokenBalanceAfter = await provider.connection.getTokenAccountBalance(vaultAta)
      .then(res => res.value.amount);
    
    const forwarderTokenBalanceAfter = await provider.connection.getTokenAccountBalance(forwarderAta)
      .then(res => res.value.amount);

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

  it("Forward wSOL and close account successfully", async () => {
    // Create new forwarder for this test
    const wsolForwarder = anchor.web3.Keypair.generate();
    
    // Airdrop SOL to wsolForwarder
    const signature = await provider.connection.requestAirdrop(
      wsolForwarder.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(signature);
  
    // Create wSOL account for forwarder
    const wsolForwarderAta = await createAssociatedTokenAccount(
      provider.connection,
      wallet.payer,
      NATIVE_MINT,
      wsolForwarder.publicKey
    );
  
    // Wrap 1 SOL to wSOL
    const wrapAmount = 1 * anchor.web3.LAMPORTS_PER_SOL;
    const wrapIx = anchor.web3.SystemProgram.transfer({
      fromPubkey: wsolForwarder.publicKey,
      toPubkey: wsolForwarderAta,
      lamports: wrapAmount,
    });
    
    const syncNativeIx = createSyncNativeInstruction(wsolForwarderAta);
    
    const wrapTx = new anchor.web3.Transaction()
      .add(wrapIx)
      .add(syncNativeIx);
    
    await provider.sendAndConfirm(wrapTx, [wsolForwarder]);
  
    // Get vault's wSOL account
    const vaultWsolAta = await getAssociatedTokenAddress(
      NATIVE_MINT,
      vault,
      true
    );
  
    // Create vault wSOL account if doesn't exist
    try {
      await getAccount(provider.connection, vaultWsolAta);
    } catch (err) {
      const tx = new anchor.web3.Transaction().add(
        createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          vaultWsolAta,
          vault,
          NATIVE_MINT
        )
      );
      await provider.sendAndConfirm(tx);
    }
  
    // Get initial balances
    const forwarderSolBefore = await provider.connection.getBalance(wsolForwarder.publicKey);
    const forwarderWsolBefore = await provider.connection.getTokenAccountBalance(wsolForwarderAta)
      .then(res => new BN(res.value.amount));
    const vaultWsolBefore = await provider.connection.getTokenAccountBalance(vaultWsolAta)
      .then(res => new BN(res.value.amount))
      .catch(() => new BN(0));
  
    // Calculate expected rent fee to be returned
    const rentExemptBalance = await provider.connection.getMinimumBalanceForRentExemption(165); // Token account size
  
    const id = Array.from(anchor.web3.Keypair.generate().publicKey.toBytes());
  
    // Forward wSOL and close account
    await forwarderProgram.methods
      .forwardToken(id, depositor.publicKey, true) // true to close account
      .accounts({
        forwarder: wsolForwarder.publicKey,
        relayEscrow,
        relayVault: vault,
        mint: NATIVE_MINT,
        forwarderTokenAccount: wsolForwarderAta,
        relayVaultToken: vaultWsolAta,
        relayEscrowProgram: escrowProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wsolForwarder])
      .rpc();
  
    // Get final balances
    const forwarderSolAfter = await provider.connection.getBalance(wsolForwarder.publicKey);
    const vaultWsolAfter = await provider.connection.getTokenAccountBalance(vaultWsolAta)
      .then(res => new BN(res.value.amount));
  
    // Verify wSOL account is closed
    try {
      await getAccount(provider.connection, wsolForwarderAta);
      assert.fail("wSOL account should be closed");
    } catch (err) {
      assert.include(err.toString(), "TokenAccountNotFoundError");
    }
  
    // Verify forwarder received rent fee back
    assert.equal(
      forwarderSolAfter - forwarderSolBefore,
      rentExemptBalance,
      "Forwarder should receive rent fee back"
    );
  
    // Verify vault received all wSOL
    assert.equal(
      vaultWsolAfter.sub(vaultWsolBefore).toString(),
      forwarderWsolBefore.toString(),
      "Vault should receive all wSOL"
    );
  });

  it("Should fail with insufficient balance", async () => {
    const emptyAccount = anchor.web3.Keypair.generate();
    const id = Array.from(anchor.web3.Keypair.generate().publicKey.toBytes());
    const depositorBalanceBefore = await provider.connection.getBalance(emptyAccount.publicKey);
    try {
      await forwarderProgram.methods
        .forwardNative(id, depositor.publicKey)
        .accounts({
          forwarder: emptyAccount.publicKey,
          relayEscrow,
          relayVault: vault,
          relayEscrowProgram: escrowProgram.programId,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([emptyAccount])
        .rpc();
      assert.fail("Expected transaction to fail");
    } catch (err) {
      assert.include(err.message, "Insufficient balance");
    }
  });
});