/**
 * Bonding-curve math for the `curve` mechanic (linear & step templates).
 *
 * SIMULATION ONLY: pure functions, no chain state. These formulas MIRROR the
 * on-chain program in `programs/alchemy_curve/src/math.rs` EXACTLY — same
 * parametrization, same integer arithmetic, same rounding. If the program
 * changes, this file must change with it.
 *
 * BINDING ROUNDING RULE (identical on-chain):
 *  - All amounts are integers (bigint); every division truncates toward zero
 *    unless stated otherwise.
 *  - BUY gross is rounded UP (ceil): the buyer pays at least the exact amount,
 *    so the reserve can never be underpaid.
 *  - SELL gross is rounded DOWN (floor): proceeds favor the reserve, which can
 *    never be overpaid.
 *  - Protocol fees are rounded UP (ceil) in both directions.
 *
 * Linear parametrization (identical on-chain):
 *    price(supply) = basePrice + slope * supply / PRICE_SCALE
 * `slope` is therefore the price increase per PRICE_SCALE token base units.
 * Use `linearFromPerToken()` to build a config from a human-friendly
 * per-token slope.
 *
 * Step-curve mapping (identical on-chain): SDK
 *    steps[i] = { supplyUpperBound, price }
 * is equivalent to on-chain thresholds `(prevBound, price)` with the first at
 * supply 0; the last step's price continues as a flat tail, exactly like the
 * on-chain segment that extends to u128::MAX.
 *
 * Units: token amounts are in token BASE units (amount * 10^decimals);
 * prices are in QUOTE base units per token base unit (e.g. lamports per
 * base-unit token).
 */

/** Fixed-point scale for the linear curve. MUST match the on-chain constant. */
export const PRICE_SCALE = 1_000_000_000n;

/** Maximum number of steps in a step curve. MUST match the on-chain constant. */
export const MAX_STEPS = 32;

export interface LinearCurveConfig {
  kind: 'linear';
  /** Price of the first token base unit, in quote base units (on-chain `intercept`). */
  basePrice: bigint;
  /**
   * Price increase per PRICE_SCALE token base units of supply, in quote base
   * units (on-chain `slope`). Prefer `linearFromPerToken()` for UI input.
   */
  slope: bigint;
  /** Protocol fee in basis points (100 bps = 1%). */
  feeBps: number;
}

/**
 * Build a linear config from a human-friendly per-token slope.
 * slopePerToken = quote base units of price increase per ONE token base unit.
 */
export function linearFromPerToken(
  basePrice: bigint,
  slopePerToken: bigint,
  feeBps: number,
): LinearCurveConfig {
  return { kind: 'linear', basePrice, slope: slopePerToken * PRICE_SCALE, feeBps };
}

export interface CurveStep {
  /** Exclusive supply upper bound (token base units) at which this step ends. */
  supplyUpperBound: bigint;
  /** Price per token base unit while supply is inside this step. */
  price: bigint;
}

export interface StepCurveConfig {
  kind: 'step';
  steps: CurveStep[];
  feeBps: number;
}

export type CurveConfig = LinearCurveConfig | StepCurveConfig;

export interface CurveState {
  /** Current token supply in base units. */
  supply: bigint;
  /** Reserve vault balance in quote base units (excludes collected fees). */
  reserve: bigint;
}

export interface CurveQuote {
  /** Token base units bought/sold. */
  amountIn: bigint;
  /** Quote base units the user pays (buy) or receives (sell). */
  amountOut: bigint;
  /** Pre-fee quote base units. */
  gross: bigint;
  /** Fee in quote base units, rounded UP. */
  fee: bigint;
  /** Total user pays (buy) or net user receives (sell), incl. fee. */
  total: bigint;
  /** Average execution price per token base unit, floored. */
  avgPrice: bigint;
  /** (avg execution price vs spot) in basis points, floored. */
  priceImpactBps: bigint;
  newState: CurveState;
}

/** Validate a curve config. Returns a list of human-readable errors (empty = ok). */
export function validateCurveConfig(config: CurveConfig): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(config.feeBps) || config.feeBps < 0 || config.feeBps > 10_000) {
    errors.push('feeBps must be an integer between 0 and 10000');
  }
  if (config.kind === 'linear') {
    // Mirror on-chain validate_curve: a zero curve would mint tokens for free.
    if (config.basePrice < 0n) errors.push('linear basePrice must be >= 0');
    if (config.slope < 0n) errors.push('linear slope must be >= 0');
    if (config.basePrice === 0n && config.slope === 0n) {
      errors.push('linear curve must have basePrice > 0 or slope > 0');
    }
  } else {
    // Mirror on-chain `validate_curve` EXACTLY. The SDK steps
    //   steps[j] = { supplyUpperBound: U_j, price: P_j }
    // map to on-chain thresholds
    //   T_0 = (0, P_0), T_j = (U_{j-1}, P_j) for j >= 1,
    // which must satisfy: non-empty, at most MAX_STEPS, first threshold at
    // supply 0, supplies strictly increasing, prices strictly positive and
    // non-decreasing. (The last SDK bound U_{n-1} never appears on-chain —
    // the last step's price continues as a flat tail — so it is not
    // constrained here.)
    const steps = config.steps;
    if (steps.length === 0) errors.push('step curve needs at least one step');
    if (steps.length > MAX_STEPS) {
      errors.push(`step curve supports at most ${MAX_STEPS} steps (on-chain limit)`);
    }
    let prevSupply = 0n; // T_0.supply
    let prevPrice = 0n;
    for (const [j, s] of steps.entries()) {
      if (s.supplyUpperBound < 0n) errors.push(`step ${j}: bound must be >= 0`);
      if (s.price <= 0n) errors.push(`step ${j}: price must be > 0`);
      if (s.price < prevPrice) {
        errors.push(`step ${j}: prices must be non-decreasing (on-chain monotonicity)`);
      }
      if (j > 0) {
        // T_j.supply = U_{j-1} must strictly exceed the previous threshold.
        const thresholdSupply = steps[j - 1].supplyUpperBound;
        if (thresholdSupply <= prevSupply) {
          errors.push(
            `step ${j}: on-chain threshold supplies must be strictly increasing ` +
              `(bound ${j - 1} must be > ${prevSupply})`,
          );
        }
        prevSupply = thresholdSupply;
      }
      prevPrice = s.price;
    }
  }
  return errors;
}

/** Ceiling division for non-negative bigints. */
function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/** Protocol fee, always rounded UP (in the protocol's favor). */
export function protocolFee(gross: bigint, feeBps: number): bigint {
  if (gross <= 0n || feeBps <= 0) return 0n;
  return ceilDiv(gross * BigInt(feeBps), 10_000n);
}

/** Spot price (per token base unit) at a given supply. Mirrors on-chain `spot_price` (floored). */
export function spotPrice(config: CurveConfig, supply: bigint): bigint {
  if (config.kind === 'linear') {
    return config.basePrice + (config.slope * supply) / PRICE_SCALE;
  }
  for (const s of config.steps) {
    if (supply < s.supplyUpperBound) return s.price;
  }
  const last = config.steps[config.steps.length - 1];
  return last.price;
}

function linearBuyGross(config: LinearCurveConfig, supply: bigint, amount: bigint): bigint {
  // Mirrors on-chain buy_cost:
  //   amount*basePrice + ceil(slope * (2*supply*amount + amount^2) / (2*PRICE_SCALE))
  const quad = config.slope * (2n * supply * amount + amount * amount);
  return amount * config.basePrice + ceilDiv(quad, 2n * PRICE_SCALE);
}

function linearSellGross(config: LinearCurveConfig, supply: bigint, amount: bigint): bigint {
  // Mirrors on-chain sell_proceeds:
  //   amount*basePrice + floor(slope * (2*start*amount + amount^2) / (2*PRICE_SCALE)),
  // where start = supply - amount.
  const start = supply - amount;
  const quad = config.slope * (2n * start * amount + amount * amount);
  return amount * config.basePrice + quad / (2n * PRICE_SCALE);
}

function stepGross(
  config: StepCurveConfig,
  supply: bigint,
  amount: bigint,
  isBuy: boolean,
): bigint {
  // Walk steps accumulating exact amount*price products — no division involved.
  let remaining = amount;
  let cursor = supply;
  let gross = 0n;
  if (isBuy) {
    for (const s of config.steps) {
      if (remaining === 0n) break;
      if (cursor >= s.supplyUpperBound) continue;
      const inStep = s.supplyUpperBound - cursor < remaining ? s.supplyUpperBound - cursor : remaining;
      gross += inStep * s.price;
      cursor += inStep;
      remaining -= inStep;
    }
    if (remaining > 0n) {
      // Past the last step: the last step's price continues (flat tail).
      gross += remaining * config.steps[config.steps.length - 1].price;
    }
  } else {
    for (let i = config.steps.length - 1; i >= 0; i--) {
      if (remaining === 0n) break;
      const s = config.steps[i];
      const lower = i === 0 ? 0n : config.steps[i - 1].supplyUpperBound;
      if (cursor <= lower) continue;
      const inStep = cursor - lower < remaining ? cursor - lower : remaining;
      gross += inStep * s.price;
      cursor -= inStep;
      remaining -= inStep;
    }
  }
  return gross;
}

/**
 * Price impact in basis points. Mirrors on-chain `impact_bps`:
 * buy  -> avg = ceil(gross/amount), impact = (avg - spot) * 10000 / spot
 * sell -> avg = floor(gross/amount), impact = (spot - avg) * 10000 / spot
 * Negative diffs saturate to 0, exactly like the on-chain saturating_sub.
 */
function impactBps(spot: bigint, gross: bigint, amount: bigint, isBuy: boolean): bigint {
  if (spot <= 0n || amount <= 0n) return 0n;
  const avg = isBuy ? ceilDiv(gross, amount) : gross / amount;
  const high = isBuy ? avg : spot;
  const low = isBuy ? spot : avg;
  if (high < low) return 0n;
  return ((high - low) * 10_000n) / low;
}

/** Quote a BUY of `amount` token base units. Throws on non-positive amount. */
export function quoteBuy(state: CurveState, config: CurveConfig, amount: bigint): CurveQuote {
  if (amount <= 0n) throw new Error('BUY_AMOUNT_NON_POSITIVE');
  const gross =
    config.kind === 'linear'
      ? linearBuyGross(config, state.supply, amount)
      : stepGross(config, state.supply, amount, true);
  const fee = protocolFee(gross, config.feeBps);
  const total = gross + fee;
  const avgPrice = total / amount; // display only; on-chain impact uses ceil(gross/amount)
  const spot = spotPrice(config, state.supply);
  return {
    amountIn: amount,
    amountOut: total,
    gross,
    fee,
    total,
    avgPrice,
    priceImpactBps: impactBps(spot, gross, amount, true),
    newState: { supply: state.supply + amount, reserve: state.reserve + gross },
  };
}

/** Quote a SELL of `amount` token base units back to the reserve. */
export function quoteSell(state: CurveState, config: CurveConfig, amount: bigint): CurveQuote {
  if (amount <= 0n) throw new Error('SELL_AMOUNT_NON_POSITIVE');
  if (amount > state.supply) throw new Error('SELL_EXCEEDS_SUPPLY');
  const gross =
    config.kind === 'linear'
      ? linearSellGross(config, state.supply, amount)
      : stepGross(config, state.supply, amount, false);
  if (gross > state.reserve) throw new Error('RESERVE_INSOLVENT');
  const fee = protocolFee(gross, config.feeBps);
  const net = gross - fee;
  const avgPrice = net / amount; // display only; on-chain impact uses floor(gross/amount)
  // On-chain measures spot at pre-sell supply.
  const spot = spotPrice(config, state.supply);
  return {
    amountIn: amount,
    amountOut: net,
    gross,
    fee,
    total: net,
    avgPrice,
    priceImpactBps: impactBps(spot, gross, amount, false),
    newState: { supply: state.supply - amount, reserve: state.reserve - gross },
  };
}

export interface StressScenario {
  name: string;
  description: string;
  /** Quote base units the actor pays (positive) or receives (negative). */
  actorNet: bigint;
  priceImpactBps: bigint;
  detail: string;
}

export interface StressResult {
  scenarios: StressScenario[];
  warnings: string[];
}

/**
 * Stress simulation: large single buys and a same-slot sandwich attack.
 * SIMULATION — models price mechanics only; real MEV ordering is not modeled.
 */
export function stressTest(config: CurveConfig, state: CurveState): StressResult {
  const scenarios: StressScenario[] = [];
  const warnings: string[] = [];
  const base = state.supply > 0n ? state.supply : 1_000_000n;

  // 1. Large buy: 50% of current supply.
  const large = base / 2n;
  try {
    const q = quoteBuy(state, config, large);
    scenarios.push({
      name: 'large-buy-50pct',
      description: 'Single buy of 50% of current supply',
      actorNet: q.total,
      priceImpactBps: q.priceImpactBps,
      detail: `Pays ${q.total} for ${large} tokens at avg ${q.avgPrice}/token (fee ${q.fee}).`,
    });
    if (q.priceImpactBps > 500n) {
      warnings.push(`Large-buy price impact is ${q.priceImpactBps} bps (>5%): thin effective liquidity.`);
    }
  } catch (e) {
    warnings.push(`large-buy scenario failed: ${(e as Error).message}`);
  }

  // 2. Sandwich: attacker buys A, victim buys V, attacker sells A.
  const A = base / 10n; // attacker size: 10% of supply
  const V = base / 20n; // victim size: 5% of supply
  try {
    const qA = quoteBuy(state, config, A);
    const qV = quoteBuy(qA.newState, config, V);
    const qA2 = quoteSell(qV.newState, config, A);
    const profit = qA2.total - qA.total; // sell net minus buy total (fees included)
    scenarios.push({
      name: 'sandwich-attack',
      description: `Attacker buys ${A}, victim buys ${V}, attacker sells ${A} (same slot ordering)`,
      actorNet: -profit, // negative = attacker receives
      priceImpactBps: qV.priceImpactBps,
      detail: `Attacker profit after fees: ${profit} quote units. ` +
        (profit > 0n
          ? 'Curve is sandwichable at these sizes — disclose to creators.'
          : 'Attacker loses money after fees at these sizes.'),
    });
    if (profit > 0n) warnings.push('Sandwich attack is profitable in simulation: warn holders about front-running risk.');
  } catch (e) {
    warnings.push(`sandwich scenario failed: ${(e as Error).message}`);
  }

  return { scenarios, warnings };
}
