/**
 * JUBILEE — SIMULATION ONLY. NOT on-chain. NOT audited. NOT a product.
 *
 * Illustrative model of a PAXG-collateralized token whose redeemable claim
 * decreases by a disclosed 1% per month (100 bps), with the removed amount
 * routed to a NAMED treasury. The collateral modeled here is a MOCK asset —
 * it is never real PAXG and must never be labeled as such.
 *
 * Exact arithmetic: claimPerToken_{m} = floor(claimPerToken_{m-1} * 9999/10000).
 * Monthly treasury sweep = totalClaims_{m-1} - totalClaims_{m} (exact bigint
 * difference; no division, so no rounding dust escapes the treasury).
 *
 * Every export in this module is suffixed `Sim` and documented as simulation.
 */

export const JUBILEE_MONTHLY_REDUCTION_BPS_SIM = 100; // 1% per month
export const JUBILEE_TREASURY_NAME_SIM = 'Alchemy Jubilee Treasury (simulated)';
export const JUBILEE_COLLATERAL_LABEL_SIM = 'MOCK-GOLD (simulated — NOT PAXG, NOT real gold)';

export interface JubileeParamsSim {
  /** Initial mock collateral units backing the token. */
  initialCollateralMockGoldSim: bigint;
  /** Initial token supply in base units. */
  initialSupplySim: bigint;
  /** Months to simulate (e.g. 12). */
  monthsSim: number;
  treasuryNameSim?: string;
}

export interface JubileeMonthSim {
  month: number;
  /** Redeemable mock-gold per token base unit this month (floored). */
  claimPerTokenSim: bigint;
  /** Total outstanding claims = supply * claimPerToken. */
  totalClaimsSim: bigint;
  /** Amount swept to the treasury this month (exact difference). */
  treasurySweptSim: bigint;
  /** Cumulative treasury balance. */
  treasuryCumulativeSim: bigint;
  /** Collateral remaining after this month's sweep. */
  collateralRemainingSim: bigint;
}

export interface JubileeScheduleSim {
  treasuryName: string;
  months: JubileeMonthSim[];
  /** Total swept to treasury over the whole schedule (should equal sum of sweeps). */
  totalSweptSim: bigint;
  finalClaimPerTokenSim: bigint;
}

/** Run the Jubilee simulation. Throws on non-positive inputs. */
export function simulateJubileeSim(params: JubileeParamsSim): JubileeScheduleSim {
  const { initialCollateralMockGoldSim: collateral0, initialSupplySim: supply, monthsSim: months } = params;
  if (collateral0 <= 0n) throw new Error('JUBILEE_COLLATERAL_NON_POSITIVE_SIM');
  if (supply <= 0n) throw new Error('JUBILEE_SUPPLY_NON_POSITIVE_SIM');
  if (!Number.isInteger(months) || months <= 0) throw new Error('JUBILEE_MONTHS_INVALID_SIM');

  const treasuryName = params.treasuryNameSim ?? JUBILEE_TREASURY_NAME_SIM;
  const monthsOut: JubileeMonthSim[] = [];
  let claimPerToken = collateral0 / supply; // month 0 claim, floored
  let collateral = collateral0;
  let treasuryCumulative = 0n;
  const keep = 10_000n - BigInt(JUBILEE_MONTHLY_REDUCTION_BPS_SIM);

  for (let m = 1; m <= months; m++) {
    const prevTotal = supply * claimPerToken;
    claimPerToken = (claimPerToken * keep) / 10_000n; // floored 1% reduction
    const newTotal = supply * claimPerToken;
    const swept = prevTotal - newTotal; // exact: nothing is lost to rounding
    treasuryCumulative += swept;
    collateral -= swept;
    monthsOut.push({
      month: m,
      claimPerTokenSim: claimPerToken,
      totalClaimsSim: newTotal,
      treasurySweptSim: swept,
      treasuryCumulativeSim: treasuryCumulative,
      collateralRemainingSim: collateral,
    });
  }
  return {
    treasuryName,
    months: monthsOut,
    totalSweptSim: treasuryCumulative,
    finalClaimPerTokenSim: claimPerToken,
  };
}

export interface JubileeHolderOutcomeSim {
  holderTokens: bigint;
  redeemMonth: number;
  /** Mock-gold claimable by this holder in the redeem month. */
  claimableSim: bigint;
  /** Claimable at month 0 (for comparison). */
  claimableAtMonth0Sim: bigint;
  /** Value removed from this holder by the Jubilee rule so far. */
  removedFromHolderSim: bigint;
}

/** Per-holder outcome: exact arithmetic, simulation only. */
export function holderOutcomeSim(
  schedule: JubileeScheduleSim,
  initialCollateral: bigint,
  initialSupply: bigint,
  holderTokens: bigint,
  redeemMonth: number,
): JubileeHolderOutcomeSim {
  if (holderTokens <= 0n) throw new Error('HOLDER_TOKENS_NON_POSITIVE_SIM');
  const row = schedule.months.find((m) => m.month === redeemMonth);
  if (!row) throw new Error('REDEEM_MONTH_OUT_OF_RANGE_SIM');
  const month0Claim = initialCollateral / initialSupply;
  const claimable = holderTokens * row.claimPerTokenSim;
  const at0 = holderTokens * month0Claim;
  return {
    holderTokens,
    redeemMonth,
    claimableSim: claimable,
    claimableAtMonth0Sim: at0,
    removedFromHolderSim: at0 - claimable,
  };
}

export interface JubileeSolvencySim {
  solvent: boolean;
  collateral: bigint;
  totalClaims: bigint;
  shortfall: bigint; // > 0 only when insolvent
}

/**
 * Insolvency guard (simulation): actual collateral must cover outstanding
 * contractual claims. collateral < claims => INSOLVENT.
 */
export function insolvencyCheckSim(collateral: bigint, totalClaims: bigint): JubileeSolvencySim {
  const shortfall = totalClaims > collateral ? totalClaims - collateral : 0n;
  return { solvent: shortfall === 0n, collateral, totalClaims, shortfall };
}

export interface JubileeFailureCaseSim {
  name: string;
  /** What goes wrong, in plain English. */
  description: string;
  /** Whether the case is triggered under the given parameters. */
  triggered: boolean;
  detail: string;
}

/**
 * Failure cases for the Jubilee simulation. All labeled; all simulated.
 */
export function jubileeFailureCasesSim(
  schedule: JubileeScheduleSim,
  actualCollateral: bigint,
  missedSweepMonths: number[] = [],
): JubileeFailureCaseSim[] {
  const last = schedule.months[schedule.months.length - 1];
  const solvency = insolvencyCheckSim(actualCollateral, last.totalClaimsSim);

  const cases: JubileeFailureCaseSim[] = [
    {
      name: 'collateral-shortfall',
      description: 'Actual vault collateral is less than outstanding claims — the token is insolvent.',
      triggered: !solvency.solvent,
      detail: !solvency.solvent
        ? `Shortfall of ${solvency.shortfall} mock-gold units: holders cannot all redeem.`
        : 'Collateral covers all outstanding claims in this scenario.',
    },
  ];

  for (const m of missedSweepMonths) {
    const row = schedule.months.find((r) => r.month === m);
    if (!row) continue;
    cases.push({
      name: `missed-treasury-sweep-month-${m}`,
      description: `The month-${m} treasury sweep was not executed: holders are over-credited and the treasury is under-credited.`,
      triggered: true,
      detail: `${row.treasurySweptSim} mock-gold units remain claimable by holders instead of moving to ${schedule.treasuryName}; treasury cumulative is understated by the same amount.`,
    });
  }

  // Dust-exhaustion: if claimPerToken floors to 0, claims vanish entirely.
  const dustRow = schedule.months.find((r) => r.claimPerTokenSim === 0n);
  if (dustRow) {
    cases.push({
      name: 'claim-dust-exhaustion',
      description: 'Monthly flooring drove claim-per-token to exactly 0 — all holder claims vanish.',
      triggered: true,
      detail: `First hits 0 in month ${dustRow.month}. Integer flooring compounds the 1% rule at tiny balances.`,
    });
  } else {
    cases.push({
      name: 'claim-dust-exhaustion',
      description: 'Monthly flooring drove claim-per-token to exactly 0 — all holder claims vanish.',
      triggered: false,
      detail: `Not triggered within ${schedule.months.length} months; final claim/token is ${last.claimPerTokenSim}.`,
    });
  }

  return cases;
}
