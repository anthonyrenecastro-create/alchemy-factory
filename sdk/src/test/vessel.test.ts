import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createVesselState, deposit, withdraw, transferOwnership, canDeposit, canWithdraw,
  holdingOf, type VesselConfig,
} from '../vessel.js';

const OWNER = 'Owner11111111111111111111111111111111111';
const ALICE = 'Alice11111111111111111111111111111111111';
const MINT = 'AssetMint11111111111111111111111111111111';

const cfg: VesselConfig = {
  custodyProgram: 'CustodyProg1111111111111111111111111111111',
  depositPermission: 'open',
  withdrawPermission: 'owner-only',
  authorizedDepositors: [],
  authorizedWithdrawers: [],
};

describe('vessel holdings ledger', () => {
  it('open deposits accepted; owner-only withdrawals enforced', () => {
    let v = createVesselState(cfg, OWNER);
    assert.equal(canDeposit(v, ALICE).allowed, true);
    v = deposit(v, ALICE, MINT, 500n);
    assert.equal(holdingOf(v, MINT), 500n);
    assert.equal(canWithdraw(v, ALICE).allowed, false);
    assert.throws(() => withdraw(v, ALICE, MINT, 1n), /WITHDRAW_NOT_PERMITTED/);
    v = withdraw(v, OWNER, MINT, 200n);
    assert.equal(holdingOf(v, MINT), 300n);
  });

  it('cannot withdraw more than held', () => {
    const v = deposit(createVesselState(cfg, OWNER), ALICE, MINT, 10n);
    assert.throws(() => withdraw(v, OWNER, MINT, 11n), /INSUFFICIENT_VESSEL_BALANCE/);
  });
});

describe('ownership transfer', () => {
  it('transfers everything; previous owner retains nothing; custody unchanged', () => {
    let v = deposit(createVesselState(cfg, OWNER), ALICE, MINT, 500n);
    const { state: v2, summary } = transferOwnership(v, ALICE);
    assert.equal(v2.owner, ALICE);
    assert.equal(summary.previousOwner, OWNER);
    assert.equal(summary.newOwner, ALICE);
    assert.deepEqual(summary.transferredHoldings, [{ mint: MINT, amount: 500n }]);
    assert.deepEqual(summary.retainedByPreviousOwner, []);
    assert.equal(summary.custodyProgramUnchanged, cfg.custodyProgram);
    // holdings ride along with the container
    assert.equal(holdingOf(v2, MINT), 500n);
  });
});
