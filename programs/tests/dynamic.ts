/**
 * Anchor tests for alchemy_dynamic (Stage 2).
 *
 * Covers: init validation, first-update acceptance, the full freshness /
 * monotonicity / frequency / cap rejection matrix (mirroring the SDK's
 * appendUpdate rules in the same order), pause/unpause, append-only history
 * records with correct indices, authority rotation, and non-authority
 * rejection.
 *
 * Timestamps use the real wall clock against the on-chain Clock sysvar, with
 * generous margins so the suite is not timing-flaky.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
} from "@solana/spl-token";
import { assert } from "chai";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
} from "@solana/web3.js";

describe("alchemy_dynamic", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = (anchor.workspace as any).AlchemyDynamic as Program;
  const payer = provider.wallet.publicKey;
  const wallet = provider.wallet as anchor.Wallet;

  const bn = (v: bigint | number) => new anchor.BN(v.toString());
  const nowSec = () => Math.floor(Date.now() / 1000);

  before(async () => {
    const sig = await provider.connection.requestAirdrop(payer, 100 * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);
  });

  async function airdrop(pk: PublicKey, sol = 2) {
    const sig = await provider.connection.requestAirdrop(pk, sol * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);
  }

  interface Dynamic {
    mint: Keypair;
    configPda: PublicKey;
  }

  async function initDynamic(opts: {
    maxSupply?: bigint;
    updateFreq?: number;
    staleThreshold?: number;
    sourceName?: string;
    oracleAdapter?: PublicKey;
    tokenProgram?: PublicKey;
    /** Token program the mint itself is created under (default Token-2022). */
    mintTokenProgram?: PublicKey;
    authority?: Keypair;
  } = {}): Promise<Dynamic> {
    const mint = Keypair.generate();
    await createMint(
      provider.connection,
      wallet.payer,
      payer,
      null,
      6,
      mint,
      undefined,
      opts.mintTokenProgram ?? TOKEN_2022_PROGRAM_ID,
    );
    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("dynamic"), mint.publicKey.toBuffer()],
      program.programId,
    );
    const authority = opts.authority ?? null;
    const authorityPk = authority ? authority.publicKey : payer;
    await program.methods
      .initializeDynamic(
        bn(opts.maxSupply ?? 1_000_000n),
        bn(opts.updateFreq ?? 60),
        bn(opts.staleThreshold ?? 300),
        opts.sourceName ?? "pyth-sim:SOL/USD",
        opts.oracleAdapter ?? Keypair.generate().publicKey,
      )
      .accounts({
        authority: authorityPk,
        dynamicConfig: configPda,
        mint: mint.publicKey,
        tokenProgram: opts.tokenProgram ?? TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        clock: SYSVAR_CLOCK_PUBKEY,
      })
      .signers(authority ? [authority] : [])
      .rpc();
    return { mint, configPda };
  }

  /** Derive the record PDA for the NEXT update (pre-increment update_count). */
  async function nextRecordPda(dyn: Dynamic): Promise<PublicKey> {
    const config: any = await (program.account as any).dynamicConfig.fetch(dyn.configPda);
    const idx = Buffer.alloc(8);
    idx.writeBigUInt64LE(BigInt(config.updateCount.toString()));
    const [recordPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("update"), dyn.configPda.toBuffer(), idx],
      program.programId,
    );
    return recordPda;
  }

  async function ingest(
    dyn: Dynamic,
    opts: {
      value: bigint;
      sourceTs: number;
      sourceHash?: number[];
      authority?: Keypair;
    },
  ): Promise<PublicKey> {
    const recordPda = await nextRecordPda(dyn);
    const authority = opts.authority ?? null;
    const authorityPk = authority ? authority.publicKey : payer;
    await program.methods
      .ingestUpdate(
        bn(opts.value),
        bn(opts.sourceTs),
        opts.sourceHash ?? Array(32).fill(7),
      )
      .accounts({
        updateAuthority: authorityPk,
        dynamicConfig: dyn.configPda,
        mint: dyn.mint.publicKey,
        updateRecord: recordPda,
        systemProgram: SystemProgram.programId,
        clock: SYSVAR_CLOCK_PUBKEY,
      })
      .signers(authority ? [authority] : [])
      .rpc();
    return recordPda;
  }

  const fetchConfig = async (dyn: Dynamic): Promise<any> =>
    (program.account as any).dynamicConfig.fetch(dyn.configPda);

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

  // -------------------------------------------------------------------------

  it("rejects invalid init params", async () => {
    await expectAnchorError(initDynamic({ maxSupply: 0n }), "InvalidMaxSupply");
    await expectAnchorError(initDynamic({ updateFreq: 0 }), "InvalidUpdateFrequency");
    await expectAnchorError(initDynamic({ updateFreq: -5 }), "InvalidUpdateFrequency");
    await expectAnchorError(initDynamic({ staleThreshold: 0 }), "InvalidStaleThreshold");
    await expectAnchorError(
      initDynamic({ sourceName: "x".repeat(65) }),
      "SourceNameTooLong",
    );
    await expectAnchorError(
      initDynamic({ oracleAdapter: PublicKey.default }),
      "InvalidSource",
    );
    // Legacy token program is rejected: Token-2022 only.
    await expectAnchorError(
      initDynamic({ tokenProgram: TOKEN_PROGRAM_ID }),
      "NotToken2022",
    );
    // A legacy SPL Token *mint* is rejected even when the Token-2022 program
    // account is passed: the program checks the mint's actual owner, not
    // just the supplied token_program account.
    await expectAnchorError(
      initDynamic({
        mintTokenProgram: TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      }),
      "NotToken2022",
    );

    // A valid init stores the authority, params, and zeroed first-update state.
    const dyn = await initDynamic({});
    const config = await fetchConfig(dyn);
    assert.strictEqual(config.updateAuthority.toBase58(), payer.toBase58());
    assert.strictEqual(config.dataSourceName, "pyth-sim:SOL/USD");
    assert.strictEqual(BigInt(config.maxSupply.toString()), 1_000_000n);
    assert.strictEqual(BigInt(config.lastValue.toString()), 0n);
    assert.strictEqual(BigInt(config.lastUpdateTs.toString()), 0n);
    assert.strictEqual(BigInt(config.updateCount.toString()), 0n);
    assert.strictEqual(config.paused, false);
  });

  it("accepts the first update and records it in history", async () => {
    const dyn = await initDynamic({});
    const ts = nowSec() - 5;
    const hash = Array.from({ length: 32 }, (_, i) => i);
    const recordPda = await ingest(dyn, { value: 42n, sourceTs: ts, sourceHash: hash });

    const config = await fetchConfig(dyn);
    assert.strictEqual(BigInt(config.lastValue.toString()), 42n);
    assert.strictEqual(BigInt(config.lastUpdateTs.toString()), BigInt(ts));
    assert.strictEqual(BigInt(config.updateCount.toString()), 1n);

    const record: any = await (program.account as any).updateRecord.fetch(recordPda);
    assert.strictEqual(record.config.toBase58(), dyn.configPda.toBase58());
    assert.strictEqual(BigInt(record.index.toString()), 0n);
    assert.strictEqual(BigInt(record.value.toString()), 42n);
    assert.strictEqual(BigInt(record.ts.toString()), BigInt(ts));
    assert.deepStrictEqual(Array.from(record.sourceHash as number[]), hash);
  });

  it("rejects stale-at-arrival updates", async () => {
    const dyn = await initDynamic({ staleThreshold: 300 });
    // 400s old at arrival: older than the 300s threshold -> never written.
    await expectAnchorError(
      ingest(dyn, { value: 1n, sourceTs: nowSec() - 400 }),
      "StaleData",
    );
    const config = await fetchConfig(dyn);
    assert.strictEqual(BigInt(config.updateCount.toString()), 0n, "stale data was not written");
  });

  it("rejects non-monotonic timestamps", async () => {
    const dyn = await initDynamic({});
    const t = nowSec() - 60;
    await ingest(dyn, { value: 1n, sourceTs: t });

    // Equal timestamp: not strictly after the last one.
    await expectAnchorError(
      ingest(dyn, { value: 2n, sourceTs: t }),
      "NonMonotonicUpdate",
    );
    // Earlier timestamp.
    await expectAnchorError(
      ingest(dyn, { value: 2n, sourceTs: t - 1 }),
      "NonMonotonicUpdate",
    );
    const config = await fetchConfig(dyn);
    assert.strictEqual(BigInt(config.updateCount.toString()), 1n);
  });

  it("rejects too-frequent updates, accepts at the exact boundary", async () => {
    const dyn = await initDynamic({ updateFreq: 60 });
    const t0 = nowSec() - 120;
    await ingest(dyn, { value: 1n, sourceTs: t0 });

    // 30s after the last update < 60s minimum spacing.
    await expectAnchorError(
      ingest(dyn, { value: 2n, sourceTs: t0 + 30 }),
      "UpdateTooFrequent",
    );
    // Exactly at the boundary: accepted.
    await ingest(dyn, { value: 3n, sourceTs: t0 + 60 });
    const config = await fetchConfig(dyn);
    assert.strictEqual(BigInt(config.updateCount.toString()), 2n);
    assert.strictEqual(BigInt(config.lastValue.toString()), 3n);
  });

  it("rejects future timestamps", async () => {
    const dyn = await initDynamic({});
    await expectAnchorError(
      ingest(dyn, { value: 1n, sourceTs: nowSec() + 3600 }),
      "FutureUpdate",
    );
    const config = await fetchConfig(dyn);
    assert.strictEqual(BigInt(config.updateCount.toString()), 0n);
  });

  it("rejects values over max_supply", async () => {
    const dyn = await initDynamic({ maxSupply: 1_000_000n });
    await expectAnchorError(
      ingest(dyn, { value: 1_000_001n, sourceTs: nowSec() - 5 }),
      "MaxSupplyExceeded",
    );
    // Exactly at the cap: accepted.
    await ingest(dyn, { value: 1_000_000n, sourceTs: nowSec() - 5 });
    const config = await fetchConfig(dyn);
    assert.strictEqual(BigInt(config.updateCount.toString()), 1n);
  });

  it("pause blocks ingest and unpause restores it", async () => {
    const dyn = await initDynamic({});
    await program.methods
      .pauseDynamic()
      .accounts({
        updateAuthority: payer,
        dynamicConfig: dyn.configPda,
        mint: dyn.mint.publicKey,
      })
      .rpc();
    assert.strictEqual((await fetchConfig(dyn)).paused, true);

    await expectAnchorError(
      ingest(dyn, { value: 1n, sourceTs: nowSec() - 5 }),
      "Paused",
    );

    await program.methods
      .unpauseDynamic()
      .accounts({
        updateAuthority: payer,
        dynamicConfig: dyn.configPda,
        mint: dyn.mint.publicKey,
      })
      .rpc();
    assert.strictEqual((await fetchConfig(dyn)).paused, false);

    await ingest(dyn, { value: 1n, sourceTs: nowSec() - 5 });
    assert.strictEqual(BigInt((await fetchConfig(dyn)).updateCount.toString()), 1n);
  });

  it("appends history records with correct indices and content", async () => {
    const dyn = await initDynamic({ updateFreq: 60 });
    const t0 = nowSec() - 200;
    const r0 = await ingest(dyn, { value: 10n, sourceTs: t0, sourceHash: Array(32).fill(1) });
    const r1 = await ingest(dyn, { value: 20n, sourceTs: t0 + 60, sourceHash: Array(32).fill(2) });
    assert.notStrictEqual(r0.toBase58(), r1.toBase58(), "distinct record PDAs");

    const rec0: any = await (program.account as any).updateRecord.fetch(r0);
    const rec1: any = await (program.account as any).updateRecord.fetch(r1);
    assert.strictEqual(BigInt(rec0.index.toString()), 0n);
    assert.strictEqual(BigInt(rec1.index.toString()), 1n);
    assert.strictEqual(BigInt(rec0.value.toString()), 10n);
    assert.strictEqual(BigInt(rec1.value.toString()), 20n);
    assert.strictEqual(BigInt(rec0.ts.toString()), BigInt(t0));
    assert.strictEqual(BigInt(rec1.ts.toString()), BigInt(t0 + 60));
    assert.strictEqual(rec0.config.toBase58(), dyn.configPda.toBase58());
    assert.strictEqual(rec1.config.toBase58(), dyn.configPda.toBase58());
    assert.deepStrictEqual(Array.from(rec0.sourceHash as number[]), Array(32).fill(1));
    assert.deepStrictEqual(Array.from(rec1.sourceHash as number[]), Array(32).fill(2));

    const config = await fetchConfig(dyn);
    assert.strictEqual(BigInt(config.updateCount.toString()), 2n);
  });

  it("rotates the update authority; the old authority is locked out", async () => {
    const dyn = await initDynamic({});
    const successor = Keypair.generate();
    await airdrop(successor.publicKey);

    await program.methods
      .updateDynamicAuthority(successor.publicKey)
      .accounts({
        updateAuthority: payer,
        dynamicConfig: dyn.configPda,
        mint: dyn.mint.publicKey,
      })
      .rpc();
    const rotated = await fetchConfig(dyn);
    assert.strictEqual(rotated.updateAuthority.toBase58(), successor.publicKey.toBase58());

    // Old authority can no longer ingest or administer.
    await expectAnchorError(
      ingest(dyn, { value: 1n, sourceTs: nowSec() - 5 }),
      "Unauthorized",
    );
    const stalePause = program.methods
      .pauseDynamic()
      .accounts({
        updateAuthority: payer,
        dynamicConfig: dyn.configPda,
        mint: dyn.mint.publicKey,
      })
      .rpc();
    await expectAnchorError(stalePause, "Unauthorized");

    // The new authority can ingest.
    await ingest(dyn, { value: 9n, sourceTs: nowSec() - 5, authority: successor });
    assert.strictEqual(BigInt((await fetchConfig(dyn)).updateCount.toString()), 1n);
  });

  it("rejects rotating the update authority to the default pubkey", async () => {
    // Rotating to the default pubkey would brick admin: pause could never be
    // lifted afterwards, since no key can sign as the default pubkey.
    const dyn = await initDynamic({});
    const brick = program.methods
      .updateDynamicAuthority(PublicKey.default)
      .accounts({
        updateAuthority: payer,
        dynamicConfig: dyn.configPda,
        mint: dyn.mint.publicKey,
      })
      .rpc();
    await expectAnchorError(brick, "InvalidAuthority");
    const config = await fetchConfig(dyn);
    assert.strictEqual(config.updateAuthority.toBase58(), payer.toBase58());
  });

  it("rejects ingest from a non-authority", async () => {
    const dyn = await initDynamic({});
    const evil = Keypair.generate();
    // Fund the signer: ingest inits the update_record PDA with the signer
    // paying rent, so an unfunded signer dies on the system transfer
    // before the program's Unauthorized check can surface.
    await airdrop(evil.publicKey);
    await expectAnchorError(
      ingest(dyn, { value: 1n, sourceTs: nowSec() - 5, authority: evil }),
      "Unauthorized",
    );
    assert.strictEqual(BigInt((await fetchConfig(dyn)).updateCount.toString()), 0n);
  });
});
