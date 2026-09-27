import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  simulateDeposit, simulateRedeem, withdrawalLimitAmount, collateralRatioBps,
  validateVaultConfig, U64_MAX,
  type VaultState,
} from '../vault.js';

function fresh(withdrawalLimitBps = 10_000, redeemFeeBps = 30): VaultState {
  validateVaultConfig(withdrawalLimitBps, redeemFeeBps);
  return { totalCollateral: 0n, totalShares: 0n, withdrawalLimitBps, redeemFeeBps };
}

describe('vault deposits', () => {
  it('first deposit mints 1:1', () => {
    const r = simulateDeposit(fresh(), 1_000_000n);
    assert.equal(r.shares, 1_000_000n);
    assert.equal(r.newState.totalCollateral, 1_000_000n);
    assert.equal(r.newState.totalShares, 1_000_000n);
  });

  it('second deposit mints pro-rata with floor', () => {
    let s = simulateDeposit(fresh(), 1000n).newState;
    const r = simulateDeposit(s, 500n);
    assert.equal(r.shares, 500n); // 500*1000/1000
    s = r.newState;
    // Skewed price: 3 collateral per share -> floor(1 * 1000 / 3000) = 0 => dust
    const skewed: VaultState = { ...s, totalCollateral: 3000n, totalShares: 1000n };
    assert.throws(() => simulateDeposit(skewed, 1n), /ZeroAmount/);
  });

  it('floor leaves the remainder with existing holders', () => {
    const s = simulateDeposit(fresh(), 1000n).newState;
    // 1001 collateral at 1000 shares: floor(1*1000/1001) = 0 for 1 unit -> dust;
    // 1002 units -> floor(1002*1000/1000000?) no: shares = 1002*1000/1001 = 1000 (floor)
    const skewed: VaultState = { ...s, totalCollateral: 1001n };
    const r = simulateDeposit(skewed, 1002n);
    assert.equal(r.shares, 1000n); // 1002*1000/1001 = 1000.99... -> 1000
    // Remainder (2 units) stayed in the vault: 1001 + 1002 = 2003 collateral for 2000 shares
    assert.equal(r.newState.totalCollateral, 2003n);
    assert.equal(r.newState.totalShares, 2000n);
  });

  it('deposit of 0 throws ZeroAmount', () => {
    assert.throws(() => simulateDeposit(fresh(), 0n), /ZeroAmount/);
    assert.throws(() => simulateDeposit(fresh(), -1n), /ZeroAmount/);
  });
});

describe('vault redeems', () => {
  it('exact gross/fee/net with a nonzero fee; fee rounds UP', () => {
    // 1000 collateral / 1000 shares, 30 bps fee. Redeem 101 shares:
    // gross = 101*1000/1000 = 101; fee = ceil(101*30/10000) = ceil(0.303) = 1
    let s = simulateDeposit(fresh(10_000, 30), 1000n).newState;
    const r = simulateRedeem(s, 101n);
    assert.equal(r.gross, 101n);
    assert.equal(r.fee, 1n);
    assert.equal(r.net, 100n);
    assert.equal(r.newState.totalCollateral, 899n);
    assert.equal(r.newState.totalShares, 899n);
  });

  it('exact fee: 30 bps on 100000 gross = 300', () => {
    let s = simulateDeposit(fresh(10_000, 30), 1_000_000n).newState;
    const r = simulateRedeem(s, 100_000n);
    assert.equal(r.gross, 100_000n);
    assert.equal(r.fee, 300n); // ceil(100000*30/10000) = 300 exact
    assert.equal(r.net, 99_700n);
  });

  it('fee bps 0 -> fee 0', () => {
    let s = simulateDeposit(fresh(10_000, 0), 1000n).newState;
    const r = simulateRedeem(s, 500n);
    assert.equal(r.fee, 0n);
    assert.equal(r.net, r.gross);
    assert.equal(r.gross, 500n);
  });

  it('gross floors in favor of the vault', () => {
    // 1000 collateral / 3 shares: redeem 1 share -> floor(1000/3) = 333
    const s: VaultState = { totalCollateral: 1000n, totalShares: 3n, withdrawalLimitBps: 10_000, redeemFeeBps: 0 };
    const r = simulateRedeem(s, 1n);
    assert.equal(r.gross, 333n);
    assert.equal(r.newState.totalCollateral, 667n);
    assert.equal(r.newState.totalShares, 2n);
  });

  it('redeeming more shares than outstanding throws', () => {
    const s = simulateDeposit(fresh(), 1000n).newState;
    assert.throws(() => simulateRedeem(s, 1001n), /InsufficientShares/);
    assert.throws(() => simulateRedeem(s, 0n), /ZeroAmount/);
  });
});

describe('withdrawal limit', () => {
  it('withdrawalLimitAmount floors', () => {
    const s: VaultState = { totalCollateral: 1001n, totalShares: 1000n, withdrawalLimitBps: 1000, redeemFeeBps: 0 };
    // 10% of 1001 = 100.1 -> floor 100
    assert.equal(withdrawalLimitAmount(s), 100n);
  });

  it('gross == limit passes; gross == limit+1 throws WithdrawalLimitExceeded', () => {
    const limitBps = 1000; // 10%
    // 1000 collateral / 1000 shares => limit = 100. Redeeming 100 shares => gross exactly 100: passes.
    let s = simulateDeposit(fresh(limitBps, 0), 1000n).newState;
    const ok = simulateRedeem(s, 100n);
    assert.equal(ok.gross, 100n);
    // Redeeming 101 shares => gross 101 > limit 100: throws.
    assert.throws(() => simulateRedeem(s, 101n), /WithdrawalLimitExceeded/);
  });
});

describe('full redeem to zero', () => {
  it('redeeming everything returns state to 0/0', () => {
    let s = simulateDeposit(fresh(10_000, 0), 1000n).newState;
    const r = simulateRedeem(s, 1000n);
    assert.equal(r.gross, 1000n);
    assert.equal(r.newState.totalCollateral, 0n);
    assert.equal(r.newState.totalShares, 0n);
  });

  it('collateral ratio is u64::MAX when claims are 0', () => {
    assert.equal(collateralRatioBps(0n, 0n), U64_MAX);
    assert.equal(U64_MAX, 2n ** 64n - 1n);
  });

  it('collateral ratio floors and detects undercollateralization', () => {
    assert.equal(collateralRatioBps(1000n, 1000n), 10_000n); // 100%
    assert.equal(collateralRatioBps(1001n, 1000n), 10_010n);
    assert.equal(collateralRatioBps(999n, 1000n), 9990n);
    assert.equal(collateralRatioBps(1000n, 3n), 3333333n); // floor(10000000/3)
  });
});

describe('config validation', () => {
  it('bps > 10000 throws InvalidBps', () => {
    assert.throws(() => validateVaultConfig(10_001, 0), /InvalidBps/);
    assert.throws(() => validateVaultConfig(10_000, 10_001), /InvalidBps/);
  });

  it('bps 0 and 10000 are valid', () => {
    assert.doesNotThrow(() => validateVaultConfig(0, 0));
    assert.doesNotThrow(() => validateVaultConfig(10_000, 10_000));
  });
});

describe('adversarial multi-step sequence', () => {
  it('two depositors: pro-rata fairness, vault never negative', () => {
    // Alice deposits 1000 (1:1). Bob deposits 1000 (1:1). Fees 30bps, no limit.
    let s = fresh(10_000, 30);
    const dA1 = simulateDeposit(s, 1000n);
    s = dA1.newState;
    const dB1 = simulateDeposit(s, 1000n);
    s = dB1.newState;

    const alice = { shares: dA1.shares, deposited: 1000n, grossOut: 0n };
    const bob = { shares: dB1.shares, deposited: 1000n, grossOut: 0n };
    assert.equal(alice.shares, 1000n);
    assert.equal(bob.shares, 1000n);

    const checkNonNegative = () => {
      assert.ok(s.totalCollateral >= 0n);
      assert.ok(s.totalShares >= 0n);
    };

    // Alice redeems half her shares: gross = 500*2000/2000 = 500.
    const rA1 = simulateRedeem(s, 500n);
    s = rA1.newState;
    alice.shares -= 500n;
    alice.grossOut += rA1.gross;
    checkNonNegative();

    // Bob deposits again at the new ratio: shares = floor(2000*1500/1500) = 2000.
    const dB2 = simulateDeposit(s, 2000n);
    s = dB2.newState;
    bob.shares += dB2.shares;
    bob.deposited += 2000n;
    assert.equal(dB2.shares, 2000n);
    checkNonNegative();

    // Bob redeems 1000 shares: gross = floor(1000*3500/3500) = 1000.
    const rB1 = simulateRedeem(s, 1000n);
    s = rB1.newState;
    bob.shares -= 1000n;
    bob.grossOut += rB1.gross;
    checkNonNegative();

    // Alice redeems the rest of her shares.
    const rA2 = simulateRedeem(s, alice.shares);
    s = rA2.newState;
    alice.grossOut += rA2.gross;
    alice.shares = 0n;
    checkNonNegative();

    // Pro-rata fairness: in a vault with no yield and no donations, floor
    // rounding means nobody can extract more gross value than they deposited.
    assert.ok(alice.grossOut <= alice.deposited,
      `Alice extracted ${alice.grossOut} > deposited ${alice.deposited}`);
    assert.ok(bob.grossOut <= bob.deposited,
      `Bob extracted ${bob.grossOut} > deposited ${bob.deposited}`);

    // Bob's remaining shares are still backed 1:1: his full exit cannot exceed deposits.
    const sharePrice = s.totalCollateral / s.totalShares;
    const bobImplied = (bob.shares * s.totalCollateral) / s.totalShares;
    assert.ok(bob.grossOut + bobImplied <= bob.deposited,
      `Bob total value ${bob.grossOut + bobImplied} > deposited ${bob.deposited}`);

    // Vault is fully solvent: balance covers all implied claims, ratio >= 100%.
    assert.ok(s.totalCollateral >= 0n);
    const ratio = collateralRatioBps(s.totalCollateral, s.totalShares);
    assert.ok(ratio >= 10_000n, `collateral ratio ${ratio} < 100%`);
    assert.ok(sharePrice >= 0n);
  });
});
