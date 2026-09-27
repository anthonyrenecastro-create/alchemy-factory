//! Pure quote math for the bonding-curve mechanic.
//!
//! # Rounding rule (documented, reserve-favoring)
//!
//! - **Buys** round *against the trader*: the cost is rounded UP (ceil), so the
//!   reserve can never be underpaid.
//! - **Sells** round *for the reserve*: the proceeds are rounded DOWN (floor),
//!   so the reserve can never be overpaid.
//! - Fees are rounded UP in both directions (against the trader on buys, for
//!   the reserve on sells).
//!
//! All intermediate arithmetic is done in `u128` with checked operations; any
//! overflow aborts the instruction.

use anchor_lang::prelude::*;

use crate::{CurveError, CurveKind, StepPoint, BPS_DENOMINATOR, MAX_STEPS, PRICE_SCALE};

/// Integer ceiling division.
pub fn ceil_div(a: u128, b: u128) -> Result<u128> {
    require!(b > 0, CurveError::MathOverflow);
    Ok(a / b + u128::from(a % b > 0))
}

/// Validate curve parameters at initialization.
///
/// - Linear: at least one of `slope` / `intercept` must be non-zero (a zero
///   curve would mint tokens for free). Linear curves are trivially
///   non-decreasing in supply.
/// - Step: non-empty (capped at [`MAX_STEPS`]), first threshold must start at
///   supply 0, supplies strictly increasing, prices strictly positive and
///   **non-decreasing** (monotonicity). A decreasing step would break the
///   reserve-coverage proof used by `withdraw_reserve`.
pub fn validate_curve(curve: &CurveKind) -> Result<()> {
    match curve {
        CurveKind::Linear { slope, intercept } => {
            require!(
                *slope > 0 || *intercept > 0,
                CurveError::InvalidCurve
            );
            Ok(())
        }
        CurveKind::Step { thresholds } => {
            require!(
                !thresholds.is_empty() && thresholds.len() <= MAX_STEPS,
                CurveError::InvalidCurve
            );
            let mut prev_supply: Option<u128> = None;
            let mut prev_price: u128 = 0;
            for (i, t) in thresholds.iter().enumerate() {
                require!(t.price > 0, CurveError::InvalidCurve);
                match prev_supply {
                    None => require!(t.supply == 0, CurveError::InvalidCurve),
                    Some(prev) => require!(t.supply > prev, CurveError::InvalidCurve),
                }
                require!(t.price >= prev_price, CurveError::InvalidCurve);
                prev_supply = Some(t.supply);
                prev_price = t.price;
            }
            Ok(())
        }
    }
}

/// Spot price in lamports per base unit at `supply` (floored).
pub fn spot_price(curve: &CurveKind, supply: u128) -> Result<u128> {
    match curve {
        CurveKind::Linear { slope, intercept } => {
            let scaled = slope
                .checked_mul(supply)
                .ok_or(CurveError::MathOverflow)?;
            Ok(intercept
                .checked_add(scaled / PRICE_SCALE)
                .ok_or(CurveError::MathOverflow)?)
        }
        CurveKind::Step { thresholds } => Ok(step_price_at(thresholds, supply)),
    }
}

/// Price per base unit for a step curve: the price of the last threshold whose
/// `supply` is `<= supply`. Callers must have run [`validate_curve`].
fn step_price_at(thresholds: &[StepPoint], supply: u128) -> u128 {
    let mut price = thresholds[0].price;
    for t in thresholds.iter() {
        if t.supply <= supply {
            price = t.price;
        } else {
            break;
        }
    }
    price
}

/// Exact integral of a step curve from `supply` to `supply + amount`.
/// All terms are integers, so no rounding is needed.
fn step_integral(thresholds: &[StepPoint], supply: u128, amount: u128) -> Result<u128> {
    let end = supply
        .checked_add(amount)
        .ok_or(CurveError::MathOverflow)?;
    let mut cost: u128 = 0;
    let mut cursor = supply;
    for i in 0..thresholds.len() {
        if cursor >= end {
            break;
        }
        let seg_start = thresholds[i].supply.max(cursor);
        let seg_end = if i + 1 < thresholds.len() {
            thresholds[i + 1].supply
        } else {
            u128::MAX
        }
        .min(end);
        if seg_end > seg_start {
            let take = seg_end - seg_start;
            let add = take
                .checked_mul(thresholds[i].price)
                .ok_or(CurveError::MathOverflow)?;
            cost = cost.checked_add(add).ok_or(CurveError::MathOverflow)?;
            cursor = seg_end;
        }
    }
    Ok(cost)
}

/// Cost in lamports to buy `amount` base units at `supply`.
/// Rounded UP (against the trader).
pub fn buy_cost(curve: &CurveKind, supply: u128, amount: u128) -> Result<u128> {
    match curve {
        CurveKind::Linear { slope, intercept } => {
            let base = amount
                .checked_mul(*intercept)
                .ok_or(CurveError::MathOverflow)?;
            // slope * (2*s*a + a^2) / (2 * SCALE), rounded up.
            let two_sa = supply
                .checked_mul(amount)
                .ok_or(CurveError::MathOverflow)?
                .checked_mul(2)
                .ok_or(CurveError::MathOverflow)?;
            let a2 = amount
                .checked_mul(amount)
                .ok_or(CurveError::MathOverflow)?;
            let quad = slope
                .checked_mul(
                    two_sa
                        .checked_add(a2)
                        .ok_or(CurveError::MathOverflow)?,
                )
                .ok_or(CurveError::MathOverflow)?;
            let den = 2 * PRICE_SCALE;
            let curve_part = ceil_div(quad, den)?;
            base.checked_add(curve_part)
                .ok_or(CurveError::MathOverflow.into())
        }
        CurveKind::Step { thresholds } => step_integral(thresholds, supply, amount),
    }
}

/// Proceeds in lamports from selling `amount` base units at `supply`.
/// Rounded DOWN (for the reserve).
pub fn sell_proceeds(curve: &CurveKind, supply: u128, amount: u128) -> Result<u128> {
    require!(amount <= supply, CurveError::AmountExceedsSupply);
    match curve {
        CurveKind::Linear { slope, intercept } => {
            let base = amount
                .checked_mul(*intercept)
                .ok_or(CurveError::MathOverflow)?;
            // slope * (2*s*a - a^2) / (2 * SCALE), rounded down.
            // (2*s*a - a^2) >= 0 because a <= s.
            let two_sa = supply
                .checked_mul(amount)
                .ok_or(CurveError::MathOverflow)?
                .checked_mul(2)
                .ok_or(CurveError::MathOverflow)?;
            let a2 = amount
                .checked_mul(amount)
                .ok_or(CurveError::MathOverflow)?;
            let diff = two_sa
                .checked_sub(a2)
                .ok_or(CurveError::MathOverflow)?;
            let quad = slope
                .checked_mul(diff)
                .ok_or(CurveError::MathOverflow)?;
            let curve_part = quad / (2 * PRICE_SCALE); // floor: for the reserve
            base.checked_add(curve_part)
                .ok_or(CurveError::MathOverflow.into())
        }
        // Integral over [supply - amount, supply): same segment math as buys.
        CurveKind::Step { thresholds } => {
            let start = supply - amount; // amount <= supply checked above
            step_integral(thresholds, start, amount)
        }
    }
}

/// Fee in lamports on a gross `quote`, rounded UP (against the trader on buys,
/// for the reserve on sells).
pub fn fee_for(quote: u128, fee_bps: u16) -> Result<u128> {
    if fee_bps == 0 || quote == 0 {
        return Ok(0);
    }
    let num = quote
        .checked_mul(fee_bps as u128)
        .ok_or(CurveError::MathOverflow)?;
    ceil_div(num, BPS_DENOMINATOR)
}

/// Price impact of a trade in basis points: `(high - low) * 10000 / low`.
/// Returns `None` when `low == 0` (impact is undefined; the caller skips the
/// check). Callers pass `(avg_execution_price, spot)` for buys and
/// `(spot, avg_execution_price)` for sells.
pub fn impact_bps(high: u128, low: u128) -> Result<Option<u128>> {
    if low == 0 {
        return Ok(None);
    }
    let diff = high.saturating_sub(low);
    let bps = diff
        .checked_mul(BPS_DENOMINATOR)
        .ok_or(CurveError::MathOverflow)?
        .checked_div(low)
        .ok_or(CurveError::MathOverflow)?;
    Ok(Some(bps))
}
