import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  quoteBuy, quoteSell, spotPrice, protocolFee, stressTest, validateCurveConfig,
  linearFromPerToken, PRICE_SCALE,
  type LinearCurveConfig, type StepCurveConfig, type CurveState,
} from '../curve.js';

// slope of 2 quote units per token == 2 * PRICE_SCALE in on-chain fixed-point.
const linear: LinearCurveConfig = linearFromPerToken(1000n, 2n, 30);
const state0: CurveState = { supply: 0n, reserve: 0n };

describe('linear curve quotes', () => {
  it('first buy: exact integral math, fee rounded up', () => {
    const q = quoteBuy(state0, linear, 100n);
    // gross = 100*1000 + ceil(2e9*(0 + 100^2)/(2*1e9)) = 100000 + 10000 = 110000
    assert.equal(q.gross, 110_000n);
    // fee = ceil(110000*30/10000) = ceil(330) = 330
    assert.equal(q.fee, 330n);
    assert.equal(q.total, 110_330n);
    assert.equal(q.newState.supply, 100n);
    assert.equal(q.newState.reserve, 110_000n);
  });

  it('buy gross rounds UP against the trader (ceil), mirroring on-chain buy_cost', () => {
    // slope = 1 (smallest non-zero): variable part = ceil(1*1/(2*1e9)) = 1
    const tiny = linearFromPerToken(1000n, 0n, 0);
    tiny.slope = 1n;
    const q = quoteBuy(state0, tiny, 1n);
    // gross = 1*1000 + ceil(1*(0 + 1)/(2*1e9)) = 1000 + 1 = 1001 (NOT 1000)
    assert.equal(q.gross, 1001n);
  });

  it('spot price scales by PRICE_SCALE exactly like on-chain spot_price', () => {
    assert.equal(PRICE_SCALE, 1_000_000_000n);
    assert.equal(spotPrice(linear, 0n), 1000n);
    // slope 2/token: at supply 1e9, price = 1000 + 2e9*1e9/1e9 = 2_000_001_000
    assert.equal(spotPrice(linear, 1_000_000_000n), 2_000_001_000n);
  });

  it('rejects a zero curve (both basePrice and slope zero), like on-chain', () => {
    const errs = validateCurveConfig({ kind: 'linear', basePrice: 0n, slope: 0n, feeBps: 0 });
    assert.ok(errs.length > 0);
    assert.deepEqual(validateCurveConfig(linear), []);
  });

  it('buy then sell round-trips supply and reserve', () => {
    const buy = quoteBuy(state0, linear, 100n);
    const sell = quoteSell(buy.newState, linear, 100n);
    assert.equal(sell.newState.supply, 0n);
    assert.equal(sell.newState.reserve, 0n);
    // Seller loses fees both ways: buy.total > sell.total
    assert.ok(sell.total < buy.total);
  });

  it('fee ceil: tiny gross rounds fee up to 1', () => {
    assert.equal(protocolFee(1n, 30), 1n); // ceil(0.003) = 1
    assert.equal(protocolFee(10_000n, 30), 30n); // exact
  });

  it('rejects non-positive and over-supply sells', () => {
    assert.throws(() => quoteBuy(state0, linear, 0n), /BUY_AMOUNT_NON_POSITIVE/);
    assert.throws(() => quoteSell({ supply: 10n, reserve: 100n }, linear, 11n), /SELL_EXCEEDS_SUPPLY/);
  });
});

describe('step curve rounding at boundaries', () => {
  const step: StepCurveConfig = {
    kind: 'step',
    feeBps: 0,
    steps: [
      { supplyUpperBound: 100n, price: 10n },
      { supplyUpperBound: 200n, price: 25n },
    ],
  };
  it('buy crossing a step boundary prices each segment at its own step price', () => {
    const q = quoteBuy(state0, step, 150n);
    // 100 @ 10 + 50 @ 25 = 1000 + 1250 = 2250 (exact, no division)
    assert.equal(q.gross, 2_250n);
    assert.equal(q.avgPrice, 15n); // floored 2250/150
  });

  it('sell walking down crosses steps symmetrically', () => {
    const after = quoteBuy(state0, step, 150n).newState;
    const sell = quoteSell(after, step, 150n);
    assert.equal(sell.gross, 2_250n);
    assert.equal(sell.newState.supply, 0n);
  });

  it('buy past the last step continues at the last price (flat tail)', () => {
    const q = quoteBuy(state0, step, 300n);
    assert.equal(q.gross, 100n * 10n + 100n * 25n + 100n * 25n);
  });

  it('spot price follows steps', () => {
    assert.equal(spotPrice(step, 0n), 10n);
    assert.equal(spotPrice(step, 99n), 10n);
    assert.equal(spotPrice(step, 100n), 25n);
  });

  it('validation catches unsorted bounds and zero prices', () => {
    const bad: StepCurveConfig = {
      kind: 'step', feeBps: 0,
      steps: [{ supplyUpperBound: 200n, price: 10n }, { supplyUpperBound: 100n, price: 5n }],
    };
    assert.ok(validateCurveConfig(bad).length > 0);
  });
});

describe('stress simulation', () => {
  it('flags high-impact large buys and reports sandwich outcome', () => {
    const steep: LinearCurveConfig = linearFromPerToken(1000n, 100n, 0);
    const s: CurveState = { supply: 10_000n, reserve: 50_000_000n };
    const r = stressTest(steep, s);
    assert.equal(r.scenarios.length, 2);
    assert.ok(r.scenarios[0].priceImpactBps > 0n);
    assert.ok(r.warnings.some((w) => w.includes('price impact')));
  });
});

// Security-review regression tests (our own review, not an external audit):
// the SDK step validator must mirror on-chain `validate_curve` EXACTLY, so
// the studio can never accept (or quote) a curve the program would reject.
describe('step validation mirrors on-chain validate_curve', () => {
  const step = (steps: { supplyUpperBound: bigint; price: bigint }[]): StepCurveConfig => ({
    kind: 'step',
    feeBps: 0,
    steps,
  });

  it('accepts a valid step curve', () => {
    assert.deepEqual(
      validateCurveConfig(
        step([
          { supplyUpperBound: 100n, price: 10n },
          { supplyUpperBound: 200n, price: 25n },
        ]),
      ),
      [],
    );
  });

  it('rejects decreasing prices (on-chain monotonicity)', () => {
    // Bounds are fine; prices fall — the program rejects this with InvalidCurve.
    const errs = validateCurveConfig(
      step([
        { supplyUpperBound: 100n, price: 25n },
        { supplyUpperBound: 200n, price: 10n },
      ]),
    );
    assert.ok(errs.some((e) => e.includes('non-decreasing')), errs.join('; '));
  });

  it('rejects a first bound of 0 with 2+ steps (threshold supplies must strictly increase from 0)', () => {
    // Maps to on-chain thresholds (0, P0), (0, P1): supplies not strictly
    // increasing -> the program rejects this with InvalidCurve.
    const errs = validateCurveConfig(
      step([
        { supplyUpperBound: 0n, price: 10n },
        { supplyUpperBound: 200n, price: 25n },
      ]),
    );
    assert.ok(errs.length > 0, 'expected rejection');
  });

  it('a single step with bound 0 is valid (maps to the single on-chain threshold at supply 0)', () => {
    assert.deepEqual(validateCurveConfig(step([{ supplyUpperBound: 0n, price: 10n }])), []);
  });

  it('rejects more than 32 steps (on-chain account-size bound)', () => {
    const steps = Array.from({ length: 33 }, (_, i) => ({
      supplyUpperBound: BigInt(i + 1),
      price: 10n,
    }));
    const errs = validateCurveConfig(step(steps));
    assert.ok(errs.some((e) => e.includes('32')), errs.join('; '));
  });
});
