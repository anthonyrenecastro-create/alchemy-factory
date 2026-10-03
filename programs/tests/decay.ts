/**
 * Anchor tests for alchemy_decay (Stage 2).
 *
 * The program is the deterministic *schedule authority*: it never moves
 * holder tokens, so these tests assert schedule validation, exact period
 * counting (including the expiry cap), recipient disclosure, and authority
 * rules — not token balance changes.
 *
 * On-chain period counting under test:
 *   periods = floor((min(now, expiry_ts) - last_decay_ts) / period_seconds)
 * mirrored by `periodsElapsed` in sdk/src/decay.ts.
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

describe("alchemy_decay", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = (anchor.workspace as any).AlchemyDecay as Program;
  const payer = provider.wallet.publicKey;
  const payerKp = (provider.wallet as any).payer as Keypair;

  const bn = (v: bigint | number) => new anchor.BN(v.toString());
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  before(async () => {
    const sig = await provider.connection.requestAirdrop(payer, 100 * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);
  });

  /** Current chain unix time (seconds). Uses "confirmed" rather than
   * "finalized": on the local validator the finalized block time can lag
   * the chain clock by >10s, which made short-expiry fixtures already
   * expired at init. */
  async function chainNow(): Promise<number> {
    const slot = await provider.connection.getSlot("confirmed");
    const t = await provider.connection.getBlockTime(slot);
    if (t === null) throw new Error("test bug: could not read chain time");
    return t;
  }

  /** Block until the chain clock passes `ts` (for expiry-gated tests). */
  async function waitUntilChainTime(ts: number, timeoutMs = 180_000): Promise<void> {
    const start = Date.now();
    for (;;) {
      if ((await chainNow()) > ts) return;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`test bug: chain clock did not pass ${ts} in time`);
      }
      await sleep(1000);
    }
  }

  interface DecayFixture {
    mint: Keypair;
    configPda: PublicKey;
    authorityPk: PublicKey;
  }

  async function initDecay(opts: {
    expiryTs: number;
    decayBps: number;
    periodSeconds: number;
    recipient: PublicKey;
    transfersAllowed?: boolean;
    redemptionAllowed?: boolean;
    authority?: Keypair;
    tokenProgram?: PublicKey;
  }): Promise<DecayFixture> {
    const authorityKp = opts.authority ?? null;
    const authorityPk = authorityKp ? authorityKp.publicKey : payer;
    const tokenProgram = opts.tokenProgram ?? TOKEN_2022_PROGRAM_ID;
    const mint = Keypair.generate();
    await createMint(
      provider.connection,
      payerKp,
      payer, // mint authority (irrelevant to decay; the program never mints)
      null, // no freeze authority, matching the honest scope
      6,
      mint,
      undefined,
      tokenProgram,
    );
    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("decay"), mint.publicKey.toBuffer()],
      program.programId,
    );
    await program.methods
      .initializeDecay(
        bn(opts.expiryTs),
        opts.decayBps,
        bn(opts.periodSeconds),
        opts.recipient,
        opts.transfersAllowed ?? false,
        opts.redemptionAllowed ?? false,
      )
      .accounts({
        authority: authorityPk,
        decayConfig: configPda,
        mint: mint.publicKey,
        tokenProgram,
        systemProgram: SystemProgram.programId,
        clock: SYSVAR_CLOCK_PUBKEY,
      })
      .signers(authorityKp ? [authorityKp] : [])
      .rpc();
    return { mint, configPda, authorityPk };
  }

  async function doCrank(
    decay: DecayFixture,
    recipient: PublicKey,
    crankerPk?: PublicKey,
    signers: Keypair[] = [],
  ): Promise<void> {
    await program.methods
      .applyDecay()
      .accounts({
        cranker: crankerPk ?? payer,
        decayConfig: decay.configPda,
        mint: decay.mint.publicKey,
        recipient,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        clock: SYSVAR_CLOCK_PUBKEY,
      })
      .signers(signers)
      .rpc();
  }

  async function doClose(
    decay: DecayFixture,
    recipient: PublicKey,
    authorityPk?: PublicKey,
    signers: Keypair[] = [],
  ): Promise<void> {
    await program.methods
      .closeDecay()
      .accounts({
        authority: authorityPk ?? payer,
        decayConfig: decay.configPda,
        mint: decay.mint.publicKey,
        recipient,
        clock: SYSVAR_CLOCK_PUBKEY,
      })
      .signers(signers)
      .rpc();
  }

  const fetchConfig = async (configPda: PublicKey): Promise<any> =>
    (program.account as any).decayConfig.fetch(configPda);

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

  /** Subscribe to an event, run `action`, resolve with the first event received. */
  async function captureEvent<T>(
    eventName: string,
    action: () => Promise<unknown>,
    timeoutMs = 30_000,
  ): Promise<T> {
    let id: number | undefined;
    try {
      return await new Promise<T>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for event ${eventName}`)),
          timeoutMs,
        );
        (async () => {
          id = await program.addEventListener(eventName, (event: any) => {
            clearTimeout(timer);
            resolve(event as T);
          });
          try {
            await action();
          } catch (e) {
            clearTimeout(timer);
            reject(e);
          }
        })();
      });
    } finally {
      if (id !== undefined) {
        await program.removeEventListener(id).catch(() => {});
      }
    }
  }

  // -------------------------------------------------------------------------

  it("rejects invalid schedules at init", async () => {
    const now = await chainNow();
    const recipient = Keypair.generate().publicKey;

    // Expiry must be in the future.
    await expectAnchorError(
      initDecay({ expiryTs: now - 10, decayBps: 100, periodSeconds: 60, recipient }),
      "InvalidSchedule",
    );
    // Period must be positive.
    await expectAnchorError(
      initDecay({ expiryTs: now + 3600, decayBps: 100, periodSeconds: 0, recipient }),
      "InvalidSchedule",
    );
    // decay_bps_per_period must not exceed 10_000.
    await expectAnchorError(
      initDecay({ expiryTs: now + 3600, decayBps: 10_001, periodSeconds: 60, recipient }),
      "InvalidSchedule",
    );
    // Recipient must not be the default pubkey.
    await expectAnchorError(
      initDecay({
        expiryTs: now + 3600,
        decayBps: 100,
        periodSeconds: 60,
        recipient: PublicKey.default,
      }),
      "InvalidSchedule",
    );
    // Token-2022 only.
    await expectAnchorError(
      initDecay({
        expiryTs: now + 3600,
        decayBps: 100,
        periodSeconds: 60,
        recipient,
        tokenProgram: TOKEN_PROGRAM_ID,
      }),
      "NotToken2022",
    );
  });

  it("records the schedule and discloses the recipient in events", async () => {
    const now = await chainNow();
    const recipient = Keypair.generate().publicKey;
    const expiry = now + 3600;

    let decay: DecayFixture | undefined;
    const event = await captureEvent<any>("decayInitialized", async () => {
      decay = await initDecay({
        expiryTs: expiry,
        decayBps: 250,
        periodSeconds: 60,
        recipient,
        transfersAllowed: true,
        redemptionAllowed: false,
      });
    });

    assert.strictEqual(event.recipient.toBase58(), recipient.toBase58());
    assert.strictEqual(event.decayBpsPerPeriod, 250);
    assert.strictEqual(event.periodSeconds.toString(), "60");
    assert.strictEqual(event.expiryTs.toString(), expiry.toString());
    assert.strictEqual(event.transfersAllowedAfterExpiry, true);
    assert.strictEqual(event.redemptionAllowedAfterExpiry, false);

    const config = await fetchConfig(decay!.configPda);
    assert.strictEqual(config.mint.toBase58(), decay!.mint.publicKey.toBase58());
    assert.strictEqual(config.authority.toBase58(), payer.toBase58());
    assert.strictEqual(config.recipient.toBase58(), recipient.toBase58());
    assert.strictEqual(config.decayBpsPerPeriod, 250);
    assert.strictEqual(config.periodSeconds.toString(), "60");
    assert.strictEqual(config.expiryTs.toString(), expiry.toString());
    assert.strictEqual(config.totalPeriodsApplied.toString(), "0");
    // last_decay_ts is stamped at init time.
    const lastDecay = Number(config.lastDecayTs.toString());
    assert(
      lastDecay >= now - 120 && lastDecay <= now + 120,
      `last_decay_ts ${lastDecay} not near init time ${now}`,
    );
  });

  it("crank applies multiple elapsed periods in one call (permissionless)", async () => {
    const now = await chainNow();
    const recipient = Keypair.generate().publicKey;
    const decay = await initDecay({
      expiryTs: now + 3600,
      decayBps: 100,
      periodSeconds: 2,
      recipient,
    });
    const before: any = await fetchConfig(decay.configPda);
    const lastDecayBefore = Number(before.lastDecayTs.toString());

    // A third party (not the authority) may crank.
    const cranker = Keypair.generate();
    const fundSig = await provider.connection.requestAirdrop(cranker.publicKey, LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(fundSig);

    await waitUntilChainTime(lastDecayBefore + 5);
    const event = await captureEvent<any>("decayApplied", () =>
      doCrank(decay, recipient, cranker.publicKey, [cranker]),
    );

    const periods = event.periodsApplied.toNumber();
    assert(periods >= 2, `expected >= 2 periods batched in one crank, got ${periods}`);
    assert.strictEqual(event.recipient.toBase58(), recipient.toBase58());

    const after: any = await fetchConfig(decay.configPda);
    assert.strictEqual(
      after.totalPeriodsApplied.toString(),
      event.periodsApplied.toString(),
      "total_periods_applied tracks the crank",
    );
    assert.strictEqual(
      Number(after.lastDecayTs.toString()) - lastDecayBefore,
      periods * 2,
      "last_decay_ts advanced by periods * period_seconds",
    );
    assert.strictEqual(
      after.lastDecayTs.toString(),
      event.lastDecayTs.toString(),
      "event discloses the new last_decay_ts",
    );
  });

  it("partial period fails with DecayNotDue", async () => {
    const now = await chainNow();
    const recipient = Keypair.generate().publicKey;
    const decay = await initDecay({
      expiryTs: now + 86_400 * 30,
      decayBps: 100,
      periodSeconds: 86_400, // a full day: an immediate crank cannot be due
      recipient,
    });
    await expectAnchorError(doCrank(decay, recipient), "DecayNotDue");
  });

  it("caps decay at expiry and accrues nothing after", async () => {
    const now = await chainNow();
    const recipient = Keypair.generate().publicKey;
    const expiry = now + 30;
    const periodSeconds = 2;
    const decay = await initDecay({
      expiryTs: expiry,
      decayBps: 100,
      periodSeconds,
      recipient,
    });
    const before: any = await fetchConfig(decay.configPda);
    const lastDecay = Number(before.lastDecayTs.toString());

    await waitUntilChainTime(expiry);
    const event = await captureEvent<any>("decayApplied", () => doCrank(decay, recipient));

    // Deterministic: effective = min(now, expiry) = expiry exactly.
    const expected = Math.floor((expiry - lastDecay) / periodSeconds);
    assert(expected >= 1, "test bug: no full period elapsed before expiry");
    assert.strictEqual(
      event.periodsApplied.toNumber(),
      expected,
      "crank applied exactly the periods up to expiry",
    );

    const after: any = await fetchConfig(decay.configPda);
    assert(
      Number(after.lastDecayTs.toString()) <= expiry,
      "last_decay_ts never advances past expiry",
    );

    // A second crank accrues nothing: the schedule is fully capped.
    await expectAnchorError(doCrank(decay, recipient), "DecayNotDue");
  });

  it("rejects a crank naming the wrong recipient", async () => {
    const now = await chainNow();
    const recipient = Keypair.generate().publicKey;
    const impostor = Keypair.generate().publicKey;
    const decay = await initDecay({
      expiryTs: now + 3600,
      decayBps: 100,
      periodSeconds: 1,
      recipient,
    });
    await waitUntilChainTime(Number((await fetchConfig(decay.configPda)).lastDecayTs.toString()) + 2);
    await expectAnchorError(doCrank(decay, impostor), "RecipientMismatch");
    // The real recipient still works.
    await doCrank(decay, recipient);
    const after: any = await fetchConfig(decay.configPda);
    assert(BigInt(after.totalPeriodsApplied.toString()) >= 1n);
  });

  it("rejects close before expiry; closes after expiry paying rent to the recipient", async () => {
    const now = await chainNow();
    const recipient = Keypair.generate();
    const early = await initDecay({
      expiryTs: now + 1_000_000,
      decayBps: 100,
      periodSeconds: 60,
      recipient: recipient.publicKey,
    });
    await expectAnchorError(doClose(early, recipient.publicKey), "NotExpired");

    const expiry = now + 30;
    const decay = await initDecay({
      expiryTs: expiry,
      decayBps: 100,
      periodSeconds: 2,
      recipient: recipient.publicKey,
    });
    await waitUntilChainTime(expiry);

    // Close requires a fully settled schedule: crank the tail periods first.
    await doCrank(decay, recipient.publicKey);

    const recipientBefore = await provider.connection.getBalance(recipient.publicKey);
    const closedEvent = await captureEvent<any>("decayClosed", () =>
      doClose(decay, recipient.publicKey),
    );
    assert.strictEqual(closedEvent.recipient.toBase58(), recipient.publicKey.toBase58());
    assert.strictEqual(
      closedEvent.mint.toBase58(),
      decay.mint.publicKey.toBase58(),
      "close event names the mint",
    );

    const recipientAfter = await provider.connection.getBalance(recipient.publicKey);
    assert(
      recipientAfter > recipientBefore,
      "recipient received the reclaimed rent lamports",
    );

    // The config account is gone.
    try {
      await fetchConfig(decay.configPda);
      assert.fail("expected the closed decay config account to be gone");
    } catch (err: any) {
      assert(
        /Account does not exist|failed to get account/i.test(err?.message ?? ""),
        `unexpected error after close: ${err?.message ?? err}`,
      );
    }
  });

  it("rejects close while the schedule has unsettled periods (anti-truncation)", async () => {
    // Regression: close_decay must refuse to delete the config while a tail
    // of unapplied periods remains between last_decay_ts and expiry_ts —
    // otherwise total_periods_applied would permanently undercount the true
    // schedule, stranding disclosure of the removed-value tail.
    const now = await chainNow();
    const recipient = Keypair.generate().publicKey;
    const expiry = now + 30;
    const decay = await initDecay({
      expiryTs: expiry,
      decayBps: 100,
      periodSeconds: 2,
      recipient,
    });
    const lastDecay = Number((await fetchConfig(decay.configPda)).lastDecayTs.toString());
    await waitUntilChainTime(expiry);
    assert(
      Math.floor((expiry - lastDecay) / 2) >= 1,
      "test bug: no full period elapsed before expiry",
    );

    // No crank has run since init: the tail is unsettled.
    await expectAnchorError(doClose(decay, recipient), "ScheduleNotSettled");

    // A final crank settles the schedule; close then succeeds.
    await doCrank(decay, recipient);
    const settled: any = await fetchConfig(decay.configPda);
    const remaining = Math.floor(
      (expiry - Number(settled.lastDecayTs.toString())) / 2,
    );
    assert.strictEqual(remaining, 0, "crank settled every period up to expiry");
    await doClose(decay, recipient);
    try {
      await fetchConfig(decay.configPda);
      assert.fail("expected the closed decay config account to be gone");
    } catch (err: any) {
      assert(
        /Account does not exist|failed to get account/i.test(err?.message ?? ""),
        `unexpected error after close: ${err?.message ?? err}`,
      );
    }
  });

  it("rejects close paying rent to the wrong recipient", async () => {
    // The close=recipient reclaim must go to the configured removed-value
    // recipient and nowhere else.
    const now = await chainNow();
    const recipient = Keypair.generate().publicKey;
    const impostor = Keypair.generate().publicKey;
    const expiry = now + 30;
    const decay = await initDecay({
      expiryTs: expiry,
      decayBps: 100,
      periodSeconds: 2,
      recipient,
    });
    await waitUntilChainTime(expiry);
    await doCrank(decay, recipient); // settle so only the recipient check can fail

    await expectAnchorError(doClose(decay, impostor), "RecipientMismatch");

    // The configured recipient still closes fine.
    await doClose(decay, recipient);
    try {
      await fetchConfig(decay.configPda);
      assert.fail("expected the closed decay config account to be gone");
    } catch (err: any) {
      assert(
        /Account does not exist|failed to get account/i.test(err?.message ?? ""),
        `unexpected error after close: ${err?.message ?? err}`,
      );
    }
  });

  it("rejects rotating the decay authority to the default pubkey", async () => {
    const now = await chainNow();
    const recipient = Keypair.generate().publicKey;
    const decay = await initDecay({
      expiryTs: now + 3600,
      decayBps: 100,
      periodSeconds: 60,
      recipient,
    });
    const brick = program.methods
      .updateDecayAuthority(PublicKey.default)
      .accounts({
        authority: payer,
        decayConfig: decay.configPda,
        mint: decay.mint.publicKey,
      })
      .rpc();
    await expectAnchorError(brick, "InvalidAuthority");

    const config = await fetchConfig(decay.configPda);
    assert.strictEqual(config.authority.toBase58(), payer.toBase58());
  });

  it("rejects authority abuse: non-authority cannot close or rotate authority", async () => {
    const now = await chainNow();
    const recipient = Keypair.generate().publicKey;
    const decay = await initDecay({
      expiryTs: now + 30,
      decayBps: 100,
      periodSeconds: 1,
      recipient,
    });
    const evil = Keypair.generate();
    const fundSig = await provider.connection.requestAirdrop(evil.publicKey, LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(fundSig);

    // Rotate authority as a non-authority.
    const evilRotate = program.methods
      .updateDecayAuthority(evil.publicKey)
      .accounts({
        authority: evil.publicKey,
        decayConfig: decay.configPda,
        mint: decay.mint.publicKey,
      })
      .signers([evil])
      .rpc();
    await expectAnchorError(evilRotate, "Unauthorized");

    // Close as a non-authority (after expiry so only auth can fail).
    await waitUntilChainTime(now + 30);
    const evilClose = program.methods
      .closeDecay()
      .accounts({
        authority: evil.publicKey,
        decayConfig: decay.configPda,
        mint: decay.mint.publicKey,
        recipient,
        clock: SYSVAR_CLOCK_PUBKEY,
      })
      .signers([evil])
      .rpc();
    await expectAnchorError(evilClose, "Unauthorized");

    // The real authority can rotate; the old authority then loses power.
    const successor = Keypair.generate();
    const rotatedEvent = await captureEvent<any>("decayAuthorityUpdated", () =>
      program.methods
        .updateDecayAuthority(successor.publicKey)
        .accounts({
          authority: payer,
          decayConfig: decay.configPda,
          mint: decay.mint.publicKey,
        })
        .rpc(),
    );
    assert.strictEqual(rotatedEvent.newAuthority.toBase58(), successor.publicKey.toBase58());
    const rotated: any = await fetchConfig(decay.configPda);
    assert.strictEqual(rotated.authority.toBase58(), successor.publicKey.toBase58());

    const staleRotate = program.methods
      .updateDecayAuthority(evil.publicKey)
      .accounts({
        authority: payer,
        decayConfig: decay.configPda,
        mint: decay.mint.publicKey,
      })
      .rpc();
    await expectAnchorError(staleRotate, "Unauthorized");
  });
});
