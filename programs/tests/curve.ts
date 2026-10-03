/**
 * Anchor tests for alchemy_curve (Stage 1).
 *
 * Every quote asserted here is hand-computed (see comments) AND mirrored by
 * independent BigInt math below, so a math bug must evade two implementations.
 *
 * Rounding rule under test: buys round against the trader (ceil), sells round
 * for the reserve (floor), fees round up in both directions.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { assert } from "chai";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";

// ---------------------------------------------------------------------------
// Independent BigInt mirror of the on-chain math (math.rs)
// ---------------------------------------------------------------------------

const SCALE = 10n ** 9n;
const BPS_DENOMINATOR = 10_000n;

const linearBuyCost = (
  slope: bigint,
  intercept: bigint,
  supply: bigint,
  amount: bigint,
): bigint => {
  const base = amount * intercept;
  const quad = slope * (2n * supply * amount + amount * amount);
  const den = 2n * SCALE;
  return base + quad / den + (quad % den > 0n ? 1n : 0n); // ceil: against trader
};

const linearSellProceeds = (
  slope: bigint,
  intercept: bigint,
  supply: bigint,
  amount: bigint,
): bigint => {
  assert(amount <= supply, "test bug: amount > supply");
  const base = amount * intercept;
  const quad = slope * (2n * supply * amount - amount * amount);
  return base + quad / (2n * SCALE); // floor: for the reserve
};

type Step = { supply: bigint; price: bigint };

const stepIntegral = (steps: Step[], supply: bigint, amount: bigint): bigint => {
  const end = supply + amount;
  let cost = 0n;
  let cursor = supply;
  for (let i = 0; i < steps.length && cursor < end; i++) {
    const segStart = steps[i].supply > cursor ? steps[i].supply : cursor;
    const next = i + 1 < steps.length ? steps[i + 1].supply : null;
    const segEnd = next === null ? end : next < end ? next : end;
    if (segEnd > segStart) {
      cost += (segEnd - segStart) * steps[i].price;
      cursor = segEnd;
    }
  }
  return cost;
};

const feeFor = (quote: bigint, bps: bigint): bigint =>
  quote === 0n || bps === 0n ? 0n : (quote * bps + BPS_DENOMINATOR - 1n) / BPS_DENOMINATOR;

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe("alchemy_curve", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = (anchor.workspace as any).AlchemyCurve as Program;
  const payer = provider.wallet.publicKey;

  const SLOPE = 1_000_000_000n; // price rises 1 lamport/base-unit per unit of supply
  const INTERCEPT = 500n; // lamports per base unit at supply 0
  const FEE_BPS = 100n; // 1%

  before(async () => {
    const sig = await provider.connection.requestAirdrop(payer, 100 * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);
  });

  const bn = (v: bigint | number) => new anchor.BN(v.toString());

  async function initCurve(opts: {
    curve: any;
    feeBps: number;
    maxSlippageBps: number;
    decimals?: number;
  }) {
    const mint = Keypair.generate();
    const treasury = Keypair.generate();
    // Pre-fund the treasury above the rent-exempt minimum: fee transfers as
    // small as a few hundred lamports would otherwise leave a fresh system
    // account below rent and fail the whole transaction at simulation.
    const treasurySig = await provider.connection.requestAirdrop(
      treasury.publicKey,
      LAMPORTS_PER_SOL,
    );
    await provider.connection.confirmTransaction(treasurySig);
    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("curve"), mint.publicKey.toBuffer()],
      program.programId,
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), mint.publicKey.toBuffer()],
      program.programId,
    );
    await program.methods
      .initializeCurve(opts.decimals ?? 6, opts.curve, opts.feeBps, opts.maxSlippageBps)
      .accounts({
        authority: payer,
        curveConfig: configPda,
        mint: mint.publicKey,
        vault: vaultPda,
        treasury: treasury.publicKey,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([mint])
      .rpc();
    return { mint, treasury, configPda, vaultPda };
  }

  const linearCurve = () => ({
    linear: { slope: bn(SLOPE), intercept: bn(INTERCEPT) },
  });

  async function doBuy(
    curve: { mint: Keypair; treasury: Keypair; configPda: PublicKey; vaultPda: PublicKey },
    buyer: Keypair | null, // null = provider wallet
    amount: bigint,
    maxCost: bigint,
  ) {
    const buyerPk = buyer ? buyer.publicKey : payer;
    const ata = getAssociatedTokenAddressSync(
      curve.mint.publicKey,
      buyerPk,
      false,
      TOKEN_2022_PROGRAM_ID,
    );
    await program.methods
      .buy(bn(amount), bn(maxCost))
      .accounts({
        buyer: buyerPk,
        curveConfig: curve.configPda,
        mint: curve.mint.publicKey,
        vault: curve.vaultPda,
        buyerTokenAccount: ata,
        treasury: curve.treasury.publicKey,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers(buyer ? [buyer] : [])
      .rpc();
    return ata;
  }

  async function doSell(
    curve: { mint: Keypair; treasury: Keypair; configPda: PublicKey; vaultPda: PublicKey },
    seller: Keypair | null,
    amount: bigint,
    minProceeds: bigint,
  ) {
    const sellerPk = seller ? seller.publicKey : payer;
    const ata = getAssociatedTokenAddressSync(
      curve.mint.publicKey,
      sellerPk,
      false,
      TOKEN_2022_PROGRAM_ID,
    );
    await program.methods
      .sell(bn(amount), bn(minProceeds))
      .accounts({
        seller: sellerPk,
        curveConfig: curve.configPda,
        mint: curve.mint.publicKey,
        vault: curve.vaultPda,
        sellerTokenAccount: ata,
        treasury: curve.treasury.publicKey,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers(seller ? [seller] : [])
      .rpc();
    return ata;
  }

  const tokenBalance = async (mint: PublicKey, owner: PublicKey): Promise<bigint> => {
    const ata = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);
    const acc = await getAccount(provider.connection, ata, undefined, TOKEN_2022_PROGRAM_ID);
    return acc.amount;
  };

  const solBalance = async (pk: PublicKey): Promise<bigint> =>
    BigInt(await provider.connection.getBalance(pk));

  const fetchConfig = async (configPda: PublicKey) =>
    (program.account as any).curveConfig.fetch(configPda);

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

  it("buys with exact hand-computed quote math (ceil against trader)", async () => {
    const curve = await initCurve({ curve: linearCurve(), feeBps: 100, maxSlippageBps: 10_000 });

    // Hand computation: buy 1_000 base units @ supply 0.
    // cost = 1_000*500 + 1e9*(0 + 1_000^2)/(2e9) = 500_000 + 500_000 = 1_000_000
    // fee = ceil(1_000_000 * 100 / 10_000) = 10_000 ; total = 1_010_000
    // (Trade size keeps the average price 1_000 vs spot 500, i.e. exactly
    // the 10_000 bps impact rail — larger sizes breach it by construction.)
    const amount = 1_000n;
    const cost = linearBuyCost(SLOPE, INTERCEPT, 0n, amount);
    assert.strictEqual(cost, 1_000_000n, "hand-computed buy cost");
    const fee = feeFor(cost, FEE_BPS);
    assert.strictEqual(fee, 10_000n, "hand-computed fee");
    const total = cost + fee;

    const vaultBefore = await solBalance(curve.vaultPda);
    const treasuryBefore = await solBalance(curve.treasury.publicKey);
    await doBuy(curve, null, amount, total);
    const vaultAfter = await solBalance(curve.vaultPda);
    const treasuryAfter = await solBalance(curve.treasury.publicKey);

    assert.strictEqual(await tokenBalance(curve.mint.publicKey, payer), amount);
    assert.strictEqual(vaultAfter - vaultBefore, cost, "reserve_delta == quote");
    assert.strictEqual(treasuryAfter - treasuryBefore, fee, "treasury got exactly the fee");

    const config: any = await fetchConfig(curve.configPda);
    assert.strictEqual(BigInt(config.reserveLamports.toString()), cost);
    assert.strictEqual(BigInt(config.totalFeesCollected.toString()), fee);
  });

  it("sells with exact hand-computed quote math (floor for the reserve)", async () => {
    const curve = await initCurve({ curve: linearCurve(), feeBps: 100, maxSlippageBps: 10_000 });
    await doBuy(curve, null, 1_000n, 1_010_000n);

    // Hand computation: sell 500 @ supply 1_000.
    // proceeds = 500*500 + 1e9*(2*1_000*500 - 500^2)/(2e9)
    //          = 250_000 + 375_000 = 625_000
    // fee = 6_250 ; seller receives 618_750
    const proceeds = linearSellProceeds(SLOPE, INTERCEPT, 1_000n, 500n);
    assert.strictEqual(proceeds, 625_000n, "hand-computed sell proceeds");
    const fee = feeFor(proceeds, FEE_BPS);
    const userGets = proceeds - fee;
    assert.strictEqual(userGets, 618_750n, "hand-computed seller payout");

    const vaultBefore = await solBalance(curve.vaultPda);
    await doSell(curve, null, 500n, userGets);
    const vaultAfter = await solBalance(curve.vaultPda);

    assert.strictEqual(await tokenBalance(curve.mint.publicKey, payer), 500n);
    assert.strictEqual(vaultBefore - vaultAfter, proceeds, "reserve_delta == quote");
    const config: any = await fetchConfig(curve.configPda);
    assert.strictEqual(BigInt(config.reserveLamports.toString()), 1_000_000n - proceeds);
    assert.strictEqual(BigInt(config.totalFeesCollected.toString()), 10_000n + fee);
  });

  it("rejects invalid curves and fees at init", async () => {
    const badLinear = { linear: { slope: bn(0), intercept: bn(0) } };
    await expectAnchorError(
      initCurve({ curve: badLinear, feeBps: 100, maxSlippageBps: 10_000 }),
      "InvalidCurve",
    );

    // Decreasing step prices violate monotonicity.
    const decreasing = {
      step: {
        thresholds: [
          { supply: bn(0), price: bn(2000) },
          { supply: bn(1_000_000), price: bn(1000) },
        ],
      },
    };
    await expectAnchorError(
      initCurve({ curve: decreasing, feeBps: 0, maxSlippageBps: 10_000 }),
      "InvalidCurve",
    );

    // First threshold must start at supply 0.
    const offsetStart = {
      step: { thresholds: [{ supply: bn(100), price: bn(1000) }] },
    };
    await expectAnchorError(
      initCurve({ curve: offsetStart, feeBps: 0, maxSlippageBps: 10_000 }),
      "InvalidCurve",
    );

    // fee_bps > 10_000 is rejected.
    await expectAnchorError(
      initCurve({ curve: linearCurve(), feeBps: 10_001, maxSlippageBps: 10_000 }),
      "InvalidFeeBps",
    );

    // Zero amounts are rejected on both sides.
    const curve = await initCurve({ curve: linearCurve(), feeBps: 0, maxSlippageBps: 10_000 });
    await expectAnchorError(doBuy(curve, null, 0n, 1_000_000n), "ZeroAmount");
  });

  it("rejects a trade whose quote moved past the trader limit (slippage)", async () => {
    const curve = await initCurve({ curve: linearCurve(), feeBps: 100, maxSlippageBps: 10_000 });

    // Victim quotes 10_000 units @ supply 0 and sets a tight limit: 55_550_000.
    const victimLimit = 55_550_000n;

    // Attacker buys 100 units first, moving the price.
    // cost = 100*500 + 1e9*(10_000)/(2e9) = 50_000 + 5_000 = 55_000 (impact 1000bps <= 10_000)
    const attacker = Keypair.generate();
    const fundSig = await provider.connection.requestAirdrop(attacker.publicKey, LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(fundSig);
    await doBuy(curve, attacker, 100n, 1_000_000n);

    // Victim's transaction now executes @ supply 100: cost would be 56_000_000
    // > limit, so the slippage guard fires.
    const movedCost = linearBuyCost(SLOPE, INTERCEPT, 100n, 10_000n);
    assert(movedCost > 55_000_000n, "test bug: price did not move");
    await expectAnchorError(doBuy(curve, null, 10_000n, victimLimit), "SlippageExceeded");
  });

  it("enforces the price-impact rail (max_slippage_bps)", async () => {
    const curve = await initCurve({ curve: linearCurve(), feeBps: 0, maxSlippageBps: 50 });

    // Buy 10_000 @ supply 0: avg price 5_500 vs spot 500 -> impact 100_000 bps,
    // far above the 50 bps rail, even with an infinite limit.
    await expectAnchorError(
      doBuy(curve, null, 10_000n, BigInt("18446744073709551615")),
      "PriceImpactExceeded",
    );
  });

  it("rejects rotating the authority to the all-zero address (permanent lockout)", async () => {
    const curve = await initCurve({ curve: linearCurve(), feeBps: 100, maxSlippageBps: 10_000 });

    // A typo or malicious rotation to PublicKey.default would permanently
    // lock out every admin instruction; the program must fail closed.
    await expectAnchorError(
      program.methods
        .updateAuthority(PublicKey.default)
        .accounts({ authority: payer, curveConfig: curve.configPda, mint: curve.mint.publicKey })
        .rpc(),
      "InvalidPubkey",
    );

    // The authority is unchanged and still functional.
    const config: any = await fetchConfig(curve.configPda);
    assert.strictEqual(config.authority.toBase58(), payer.toBase58());
    await program.methods
      .updateParams(150, null, null)
      .accounts({ authority: payer, curveConfig: curve.configPda, mint: curve.mint.publicKey })
      .rpc();
    const updated: any = await fetchConfig(curve.configPda);
    assert.strictEqual(updated.feeBps, 150);
  });

  it("rejects admin actions from non-authorities, honors the real authority", async () => {
    const curve = await initCurve({ curve: linearCurve(), feeBps: 100, maxSlippageBps: 10_000 });
    const evil = Keypair.generate();

    const evilParams = program.methods
      .updateParams(200, null, null)
      .accounts({ authority: evil.publicKey, curveConfig: curve.configPda, mint: curve.mint.publicKey })
      .signers([evil])
      .rpc();
    await expectAnchorError(evilParams, "Unauthorized");

    const evilWithdraw = program.methods
      .withdrawReserve(bn(1))
      .accounts({
        authority: evil.publicKey,
        curveConfig: curve.configPda,
        mint: curve.mint.publicKey,
        vault: curve.vaultPda,
        destination: Keypair.generate().publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([evil])
      .rpc();
    await expectAnchorError(evilWithdraw, "Unauthorized");

    // The real authority can update params.
    await program.methods
      .updateParams(200, null, null)
      .accounts({ authority: payer, curveConfig: curve.configPda, mint: curve.mint.publicKey })
      .rpc();
    const config: any = await fetchConfig(curve.configPda);
    assert.strictEqual(config.feeBps, 200);

    // Authority rotation: old authority loses power, new one gains it.
    const successor = Keypair.generate();
    await program.methods
      .updateAuthority(successor.publicKey)
      .accounts({ authority: payer, curveConfig: curve.configPda, mint: curve.mint.publicKey })
      .rpc();
    const rotated: any = await fetchConfig(curve.configPda);
    assert.strictEqual(rotated.authority.toBase58(), successor.publicKey.toBase58());
    const staleAuth = program.methods
      .updateParams(300, null, null)
      .accounts({ authority: payer, curveConfig: curve.configPda, mint: curve.mint.publicKey })
      .rpc();
    await expectAnchorError(staleAuth, "Unauthorized");
  });

  it("rejects a sell whose proceeds round to zero (fail closed, no burn-for-nothing)", async () => {
    // intercept 0, minimal slope: prices are sub-lamport at small supplies.
    const dustCurve = { linear: { slope: bn(1), intercept: bn(0) } };
    const curve = await initCurve({ curve: dustCurve, feeBps: 0, maxSlippageBps: 10_000 });

    // Buy 1_000 base units @ supply 0:
    // cost = ceil(1 * (0 + 1_000^2) / (2 * 1e9)) = ceil(1e6 / 2e9) = 1 lamport.
    // (Spot at supply 0 is 0, so the impact rail is skipped — same regime as
    // the sell below.)
    await doBuy(curve, null, 1_000n, 10n);
    assert.strictEqual(await tokenBalance(curve.mint.publicKey, payer), 1_000n);

    // Sell 1_000 @ supply 1_000:
    // proceeds = floor(1 * (2*1_000*1_000 - 1_000^2) / (2 * 1e9))
    //          = floor(1e6 / 2e9) = 0.
    // Without the guard the trader would burn 1_000 tokens and receive
    // nothing (the impact rail is also skipped when the floored average
    // price is zero). The program must fail closed with ZeroAmount.
    await expectAnchorError(doSell(curve, null, 1_000n, 0n), "ZeroAmount");

    // No tokens were burned and the reserve is untouched.
    assert.strictEqual(await tokenBalance(curve.mint.publicKey, payer), 1_000n);
    const config: any = await fetchConfig(curve.configPda);
    assert.strictEqual(BigInt(config.reserveLamports.toString()), 1n);
  });

  it("prices step curves exactly across thresholds", async () => {
    const steps: Step[] = [
      { supply: 0n, price: 1_000n },
      { supply: 1_000_000n, price: 2_000n },
      { supply: 5_000_000n, price: 5_000n },
    ];
    const stepCurve = {
      step: {
        thresholds: steps.map((s) => ({ supply: bn(s.supply), price: bn(s.price) })),
      },
    };
    const curve = await initCurve({ curve: stepCurve, feeBps: 0, maxSlippageBps: 10_000 });

    // Hand computation: buy 2_000_000 @ supply 0 crosses the first threshold.
    // 1_000_000 * 1_000 + 1_000_000 * 2_000 = 3_000_000_000
    const buyAmount = 2_000_000n;
    const cost = stepIntegral(steps, 0n, buyAmount);
    assert.strictEqual(cost, 3_000_000_000n, "hand-computed step buy cost");
    const vaultBefore = await solBalance(curve.vaultPda);
    await doBuy(curve, null, buyAmount, cost);
    assert.strictEqual((await solBalance(curve.vaultPda)) - vaultBefore, cost);
    assert.strictEqual(await tokenBalance(curve.mint.publicKey, payer), buyAmount);

    // Hand computation: sell 1_500_000 @ supply 2_000_000 walks back down.
    // 500_000 * 1_000 + 1_000_000 * 2_000 = 2_500_000_000
    const sellAmount = 1_500_000n;
    const proceeds = stepIntegral(steps, buyAmount - sellAmount, sellAmount);
    assert.strictEqual(proceeds, 2_500_000_000n, "hand-computed step sell proceeds");
    const vaultBeforeSell = await solBalance(curve.vaultPda);
    await doSell(curve, null, sellAmount, proceeds);
    assert.strictEqual(vaultBeforeSell - (await solBalance(curve.vaultPda)), proceeds);
    assert.strictEqual(await tokenBalance(curve.mint.publicKey, payer), buyAmount - sellAmount);
  });

  it("makes sandwich round-trips unprofitable (fee + spread)", async () => {
    const curve = await initCurve({ curve: linearCurve(), feeBps: 100, maxSlippageBps: 10_000 });
    const attacker = Keypair.generate();
    const fundSig = await provider.connection.requestAirdrop(attacker.publicKey, LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(fundSig);

    // Buy 100 @ supply 0: cost 55_000, fee 550 -> total 55_550.
    const before = await solBalance(attacker.publicKey);
    await doBuy(curve, attacker, 100n, 1_000_000n);
    // Sell 100 @ supply 100: proceeds 55_000, fee 550 -> receives 54_450.
    await doSell(curve, attacker, 100n, 0n);
    const after = await solBalance(attacker.publicKey);

    // Lost 2x fee (1_100) plus transaction fees: manipulation has negative EV.
    assert(after < before, "test bug: round-trip was profitable");
    const loss = before - after;
    assert(loss >= 1_100n, `expected loss of at least 1_100 lamports in fees, got ${loss}`);
  });

  it("holds the reserve invariant and guards withdrawals with solvency", async () => {
    const curve = await initCurve({ curve: linearCurve(), feeBps: 0, maxSlippageBps: 10_000 });

    // Buy 3 @ supply 0: cost = 3*500 + ceil(1e9*9 / 2e9) = 1_500 + 5 = 1_505.
    // The +1 lamport of ceil dust is exactly the withdrawable excess.
    const cost = linearBuyCost(SLOPE, INTERCEPT, 0n, 3n);
    assert.strictEqual(cost, 1_505n, "hand-computed dust-generating buy");
    await doBuy(curve, null, 3n, 2_000n);

    const rentExempt = BigInt(
      await provider.connection.getMinimumBalanceForRentExemption(0),
    );
    const vaultBalance = await solBalance(curve.vaultPda);
    const config: any = await fetchConfig(curve.configPda);
    const reserve = BigInt(config.reserveLamports.toString());
    assert.strictEqual(vaultBalance - rentExempt, reserve, "on-chain reserve == vault - rent");

    // Full-redemption cover @ supply 3: 3*500 + floor(1e9*9/2e9) = 1_504.
    // Withdrawing 1 leaves 1_504 == cover: allowed.
    // Pre-fund the destination above rent-exemption: a bare 1-lamport
    // transfer to a fresh account would fail the transaction rent check.
    const destinationKp = Keypair.generate();
    const destSig = await provider.connection.requestAirdrop(
      destinationKp.publicKey,
      LAMPORTS_PER_SOL,
    );
    await provider.connection.confirmTransaction(destSig);
    const destination = destinationKp.publicKey;
    await program.methods
      .withdrawReserve(bn(1))
      .accounts({
        authority: payer,
        curveConfig: curve.configPda,
        mint: curve.mint.publicKey,
        vault: curve.vaultPda,
        destination,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    const afterWithdraw: any = await fetchConfig(curve.configPda);
    assert.strictEqual(BigInt(afterWithdraw.reserveLamports.toString()), 1_504n);

    // Withdrawing 1 more would leave 1_503 < cover 1_504: insolvent -> rejected.
    const overWithdraw = program.methods
      .withdrawReserve(bn(1))
      .accounts({
        authority: payer,
        curveConfig: curve.configPda,
        mint: curve.mint.publicKey,
        vault: curve.vaultPda,
        destination,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    await expectAnchorError(overWithdraw, "InsolvencyViolation");

    // Invariant still holds after everything.
    const finalVault = await solBalance(curve.vaultPda);
    const finalConfig: any = await fetchConfig(curve.configPda);
    assert.strictEqual(
      finalVault - rentExempt,
      BigInt(finalConfig.reserveLamports.toString()),
      "reserve invariant holds after withdrawals",
    );
  });
});
