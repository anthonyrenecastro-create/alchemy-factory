/**
 * Anchor tests for alchemy_proofx (Stage 2).
 *
 * Authorization model under test: an attestation is the configured
 * verifier's SIGNATURE on the mint_from_attestation transaction. The verifier
 * co-signs over (attestation_hash, nonce, amount, claimant); the claim-record
 * PDA (one per nonce) makes replay fail at account initialization; revocation
 * is a registry flag that does not burn already-minted tokens.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { assert } from "chai";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
} from "@solana/web3.js";

describe("alchemy_proofx", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = (anchor.workspace as any).AlchemyProofx as Program;
  const payer = provider.wallet.publicKey;
  const payerKeypair = (provider.wallet as any).payer as Keypair;

  const bn = (v: bigint | number) => new anchor.BN(v.toString());

  before(async () => {
    const sig = await provider.connection.requestAirdrop(payer, 100 * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);
  });

  const fund = async (pk: PublicKey, sol = 2) => {
    const sig = await provider.connection.requestAirdrop(pk, sol * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);
  };

  const claimPdaFor = (configPda: PublicKey, nonce: bigint): PublicKey => {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("claim"), configPda.toBuffer(), bn(nonce).toArrayLike(Buffer, "le", 8)],
      program.programId,
    );
    return pda;
  };

  type Setup = {
    mint: Keypair;
    configPda: PublicKey;
    verifier: Keypair;
    revocationAuthority: Keypair;
  };

  /**
   * Create a Token-2022 mint whose mint authority is the proofx-config PDA
   * (unless overridden), then initialize the proofx config for it.
   */
  async function initProofx(
    opts: {
      verifierPk?: PublicKey;
      revocationAuthorityPk?: PublicKey;
      evidenceFormatHash?: number[];
      privacyNoteHash?: number[];
      disputeWindowSeconds?: number;
      mintAuthorityOverride?: PublicKey;
      tokenProgram?: PublicKey;
    } = {},
  ): Promise<Setup> {
    const mint = Keypair.generate();
    const verifier = Keypair.generate();
    const revocationAuthority = Keypair.generate();
    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("proofx"), mint.publicKey.toBuffer()],
      program.programId,
    );
    await createMint(
      provider.connection,
      payerKeypair,
      opts.mintAuthorityOverride ?? configPda,
      null,
      6,
      mint,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    await program.methods
      .initializeProofx(
        opts.verifierPk ?? verifier.publicKey,
        opts.evidenceFormatHash ?? new Array(32).fill(1),
        opts.revocationAuthorityPk ?? revocationAuthority.publicKey,
        bn(opts.disputeWindowSeconds ?? 86400),
        opts.privacyNoteHash ?? new Array(32).fill(2),
      )
      .accounts({
        authority: payer,
        proofxConfig: configPda,
        mint: mint.publicKey,
        tokenProgram: opts.tokenProgram ?? TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    return { mint, configPda, verifier, revocationAuthority };
  }

  /**
   * Submit mint_from_attestation. By default the configured verifier signs
   * (the attestation authorization); pass `verifierSigner: null` to omit the
   * verifier's signature, or `verifierAccount` to pass a different key.
   */
  async function mintFromAttestation(
    setup: Setup,
    opts: {
      claimant?: Keypair;
      verifierSigner?: Keypair | null;
      verifierAccount?: PublicKey;
      nonce?: bigint;
      amount?: bigint;
      attestationHash?: number[];
    } = {},
  ) {
    const claimantPk = opts.claimant ? opts.claimant.publicKey : payer;
    const nonce = opts.nonce ?? 1n;
    const amount = opts.amount ?? 1000n;
    const claimPda = claimPdaFor(setup.configPda, nonce);
    const ata = getAssociatedTokenAddressSync(
      setup.mint.publicKey,
      claimantPk,
      false,
      TOKEN_2022_PROGRAM_ID,
    );
    const signers: Keypair[] = [];
    if (opts.claimant) signers.push(opts.claimant);
    if (opts.verifierSigner !== null) signers.push(opts.verifierSigner ?? setup.verifier);
    await program.methods
      .mintFromAttestation(
        opts.attestationHash ?? new Array(32).fill(7),
        bn(nonce),
        bn(amount),
      )
      .accounts({
        claimant: claimantPk,
        proofxConfig: setup.configPda,
        mint: setup.mint.publicKey,
        claimantTokenAccount: ata,
        claimRecord: claimPda,
        verifier: opts.verifierAccount ?? setup.verifier.publicKey,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        clock: SYSVAR_CLOCK_PUBKEY,
      })
      .signers(signers)
      .rpc();
    return { claimPda, ata };
  }

  async function revokeClaim(setup: Setup, nonce: bigint, authority: Keypair) {
    const claimPda = claimPdaFor(setup.configPda, nonce);
    await program.methods
      .revokeClaim(bn(nonce))
      .accounts({
        revocationAuthority: authority.publicKey,
        proofxConfig: setup.configPda,
        mint: setup.mint.publicKey,
        claimRecord: claimPda,
      })
      .signers([authority])
      .rpc();
    return claimPda;
  }

  async function expectAnchorError(promise: Promise<unknown>, code: string): Promise<void> {
    try {
      await promise;
    } catch (err: any) {
      const actual = err?.error?.errorCode?.code;
      assert.strictEqual(
        actual,
        code,
        `expected Anchor error ${code}, got ${actual}: ${err?.message ?? err}`,
      );
      return;
    }
    assert.fail(`expected Anchor error ${code} but the transaction succeeded`);
  }

  /**
   * For failures that surface outside Anchor error codes (replay at account
   * initialization, missing signatures): any transaction failure is the
   * expected outcome.
   */
  async function expectTxFailure(promise: Promise<unknown>, what: string): Promise<void> {
    try {
      await promise;
    } catch {
      return;
    }
    assert.fail(`expected the transaction to fail (${what}) but it succeeded`);
  }

  const tokenBalance = async (ata: PublicKey): Promise<bigint> => {
    const acc = await getAccount(provider.connection, ata, undefined, TOKEN_2022_PROGRAM_ID);
    return acc.amount;
  };

  // -------------------------------------------------------------------------

  it("initializes the config and stores every field", async () => {
    const setup = await initProofx();
    const config: any = await program.account.proofxConfig.fetch(setup.configPda);
    assert.strictEqual(config.mint.toBase58(), setup.mint.publicKey.toBase58());
    assert.strictEqual(config.authority.toBase58(), payer.toBase58());
    assert.strictEqual(config.verifier.toBase58(), setup.verifier.publicKey.toBase58());
    assert.strictEqual(
      config.revocationAuthority.toBase58(),
      setup.revocationAuthority.publicKey.toBase58(),
    );
    assert.strictEqual(config.disputeWindowSeconds.toString(), "86400");
    assert.strictEqual(config.evidenceFormatHash.length, 32);
    assert.ok(config.evidenceFormatHash.some((b: number) => b !== 0), "evidence hash stored");
    assert.ok(config.privacyNoteHash.some((b: number) => b !== 0), "privacy hash stored");
  });

  it("rejects invalid init params", async () => {
    await expectAnchorError(
      initProofx({ verifierPk: PublicKey.default }),
      "InvalidVerifier",
    );
    await expectAnchorError(
      initProofx({ revocationAuthorityPk: PublicKey.default }),
      "InvalidRevocationAuthority",
    );
    await expectAnchorError(
      initProofx({ evidenceFormatHash: new Array(32).fill(0) }),
      "InvalidEvidenceFormat",
    );
    await expectAnchorError(
      initProofx({ privacyNoteHash: new Array(32).fill(0) }),
      "InvalidPrivacyNote",
    );
    await expectAnchorError(initProofx({ disputeWindowSeconds: -1 }), "InvalidDisputeWindow");
    await expectAnchorError(initProofx({ tokenProgram: TOKEN_PROGRAM_ID }), "NotToken2022");
  });

  it("mints from a verifier-signed attestation and records the claim", async () => {
    const setup = await initProofx();
    const claimant = Keypair.generate();
    await fund(claimant.publicKey);
    const nonce = 42n;
    const amount = 2500n;
    const attestationHash = Array.from({ length: 32 }, (_, i) => (i * 3 + 1) % 256);

    const { claimPda, ata } = await mintFromAttestation(setup, {
      claimant,
      nonce,
      amount,
      attestationHash,
    });

    assert.strictEqual(await tokenBalance(ata), amount);

    const record: any = await program.account.claimRecord.fetch(claimPda);
    assert.strictEqual(record.config.toBase58(), setup.configPda.toBase58());
    assert.strictEqual(BigInt(record.nonce.toString()), nonce);
    assert.strictEqual(record.claimant.toBase58(), claimant.publicKey.toBase58());
    assert.deepStrictEqual([...record.attestationHash], attestationHash);
    assert.strictEqual(BigInt(record.amount.toString()), amount);
    assert.ok(BigInt(record.createdTs.toString()) > 0n, "created_ts set from clock");
    assert.strictEqual(record.revoked, false);
  });

  it("rejects zero amounts and zero attestation hashes", async () => {
    const setup = await initProofx();
    const claimant = Keypair.generate();
    await fund(claimant.publicKey);
    await expectAnchorError(
      mintFromAttestation(setup, { claimant, nonce: 10n, amount: 0n }),
      "ZeroAmount",
    );
    await expectAnchorError(
      mintFromAttestation(setup, {
        claimant,
        nonce: 11n,
        attestationHash: new Array(32).fill(0),
      }),
      "InvalidAttestation",
    );
  });

  it("rejects replay: the same nonce cannot mint twice", async () => {
    const setup = await initProofx();
    const claimant = Keypair.generate();
    await fund(claimant.publicKey);
    await mintFromAttestation(setup, { claimant, nonce: 7n, amount: 100n });
    // Re-submitting the same nonce fails at claim-record account
    // initialization (the PDA already exists).
    await expectTxFailure(
      mintFromAttestation(setup, { claimant, nonce: 7n, amount: 100n }),
      "replay of nonce 7",
    );
  });

  it("rejects minting without the verifier's signature", async () => {
    const setup = await initProofx();
    const claimant = Keypair.generate();
    await fund(claimant.publicKey);
    // The verifier key is passed as an account but does not sign: the
    // attestation authorization is missing.
    await expectTxFailure(
      mintFromAttestation(setup, { claimant, nonce: 8n, verifierSigner: null }),
      "missing verifier signature",
    );
  });

  it("rejects minting with the wrong verifier key", async () => {
    const setup = await initProofx();
    const claimant = Keypair.generate();
    await fund(claimant.publicKey);
    const impostor = Keypair.generate();
    // Impostor signs, but the account is not the configured verifier.
    await expectAnchorError(
      mintFromAttestation(setup, {
        claimant,
        nonce: 9n,
        verifierSigner: impostor,
        verifierAccount: impostor.publicKey,
      }),
      "Unauthorized",
    );
  });

  it("rejects minting when the config PDA is not the mint authority", async () => {
    const attacker = Keypair.generate();
    const setup = await initProofx({ mintAuthorityOverride: attacker.publicKey });
    const claimant = Keypair.generate();
    await fund(claimant.publicKey);
    await expectAnchorError(
      mintFromAttestation(setup, { claimant, nonce: 12n }),
      "InvalidAttestation",
    );
  });

  it("revocation authority can revoke: flag set, tokens not burned, event emitted", async () => {
    const setup = await initProofx();
    const claimant = Keypair.generate();
    await fund(claimant.publicKey);
    const nonce = 13n;
    const { ata } = await mintFromAttestation(setup, { claimant, nonce, amount: 100n });

    const events: any[] = [];
    const listener = await program.addEventListener("claimRevoked", (event: any) => {
      events.push(event);
    });
    const claimPda = await revokeClaim(setup, nonce, setup.revocationAuthority);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await program.removeEventListener(listener);

    const record: any = await program.account.claimRecord.fetch(claimPda);
    assert.strictEqual(record.revoked, true);
    // Revocation is a registry flag: the minted tokens are untouched.
    assert.strictEqual(await tokenBalance(ata), 100n);
    // The ClaimRevoked event was emitted.
    assert.strictEqual(events.length, 1);
    assert.strictEqual(BigInt(events[0].nonce.toString()), nonce);
    assert.strictEqual(
      events[0].revocationAuthority.toBase58(),
      setup.revocationAuthority.publicKey.toBase58(),
    );
  });

  it("rejects revocation by non-authority and double revocation", async () => {
    const setup = await initProofx();
    const claimant = Keypair.generate();
    await fund(claimant.publicKey);
    const nonce = 14n;
    await mintFromAttestation(setup, { claimant, nonce, amount: 100n });

    const impostor = Keypair.generate();
    await expectAnchorError(revokeClaim(setup, nonce, impostor), "Unauthorized");

    await revokeClaim(setup, nonce, setup.revocationAuthority);
    await expectAnchorError(
      revokeClaim(setup, nonce, setup.revocationAuthority),
      "ClaimRevoked",
    );
  });

  it("rotates the verifier: old key locked out, new key works", async () => {
    const setup = await initProofx();
    const claimant = Keypair.generate();
    await fund(claimant.publicKey);
    const successor = Keypair.generate();

    // Non-authority cannot rotate the verifier.
    const impostor = Keypair.generate();
    await expectAnchorError(
      program.methods
        .updateVerifier(successor.publicKey)
        .accounts({
          authority: impostor.publicKey,
          proofxConfig: setup.configPda,
          mint: setup.mint.publicKey,
        })
        .signers([impostor])
        .rpc(),
      "Unauthorized",
    );
    // The default pubkey is rejected as a verifier.
    await expectAnchorError(
      program.methods
        .updateVerifier(PublicKey.default)
        .accounts({
          authority: payer,
          proofxConfig: setup.configPda,
          mint: setup.mint.publicKey,
        })
        .rpc(),
      "InvalidVerifier",
    );

    // The config authority rotates to the successor.
    await program.methods
      .updateVerifier(successor.publicKey)
      .accounts({
        authority: payer,
        proofxConfig: setup.configPda,
        mint: setup.mint.publicKey,
      })
      .rpc();
    const config: any = await program.account.proofxConfig.fetch(setup.configPda);
    assert.strictEqual(config.verifier.toBase58(), successor.publicKey.toBase58());

    // The old verifier's signature is now rejected...
    await expectAnchorError(
      mintFromAttestation(setup, { claimant, nonce: 15n, verifierSigner: setup.verifier }),
      "Unauthorized",
    );
    // ...and the new verifier can attest.
    const { ata } = await mintFromAttestation(setup, {
      claimant,
      nonce: 16n,
      verifierSigner: successor,
      verifierAccount: successor.publicKey,
    });
    assert.strictEqual(await tokenBalance(ata), 1000n);
  });
});
