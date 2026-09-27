import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createVesselState, deposit, withdraw, transferOwnership, canDeposit, canWithdraw,
  holdingOf, custodyBalanceOf, applyExternalBalanceChange,
  assertAllowedAssetMintExtensions, adoptStrayAssets,
  updateDepositAuthority, updateWithdrawAuthority,
  type VesselConfig, type VesselState,
} from '../vessel.js';

const OWNER = 'Owner11111111111111111111111111111111111';
const DEPOSITOR = 'Depositor1111111111111111111111111111111';
const WITHDRAWER = 'Withdrawer111111111111111111111111111111';
const ALICE = 'Alice11111111111111111111111111111111111';
const MINT_A = 'AssetMintA1111111111111111111111111111111';
const MINT_B = 'AssetMintB1111111111111111111111111111111';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

const cfg: VesselConfig = {
  custodyProgram: TOKEN_2022,
  depositAuthority: DEPOSITOR,
  withdrawAuthority: WITHDRAWER,
};

const fresh = (): VesselState => createVesselState(cfg, OWNER);

describe('vessel creation', () => {
  it('rejects empty authorities, custody program, or owner', () => {
    assert.throws(() => createVesselState({ ...cfg, depositAuthority: '' }, OWNER), /INVALID_DEPOSIT_AUTHORITY/);
    assert.throws(() => createVesselState({ ...cfg, withdrawAuthority: '' }, OWNER), /INVALID_WITHDRAW_AUTHORITY/);
    assert.throws(() => createVesselState({ ...cfg, custodyProgram: '' }, OWNER), /INVALID_CUSTODY_PROGRAM/);
    assert.throws(() => createVesselState(cfg, ''), /INVALID_OWNER/);
  });

  it('starts empty with zero asset count', () => {
    const v = fresh();
    assert.equal(v.assetCount, 0);
    assert.deepEqual(v.holdings, []);
  });
});

describe('vessel deposits', () => {
  it('only the deposit authority may deposit; amounts must be positive', () => {
    assert.equal(canDeposit(fresh(), DEPOSITOR).allowed, true);
    assert.equal(canDeposit(fresh(), ALICE).allowed, false);
    assert.equal(canDeposit(fresh(), OWNER).allowed, false); // owner has no special flow rights
    assert.throws(() => deposit(fresh(), ALICE, MINT_A, 1n), /DEPOSIT_NOT_PERMITTED/);
    assert.throws(() => deposit(fresh(), DEPOSITOR, MINT_A, 0n), /DEPOSIT_AMOUNT_NON_POSITIVE/);
    assert.throws(() => deposit(fresh(), DEPOSITOR, MINT_A, -5n), /DEPOSIT_AMOUNT_NON_POSITIVE/);
  });

  it('deposit updates the ledger and custody balance in lockstep', () => {
    let v = deposit(fresh(), DEPOSITOR, MINT_A, 500n);
    assert.equal(holdingOf(v, MINT_A), 500n);
    assert.equal(custodyBalanceOf(v, MINT_A), 500n);
    assert.equal(v.assetCount, 1);
    v = deposit(v, DEPOSITOR, MINT_A, 200n);
    assert.equal(holdingOf(v, MINT_A), 700n);
    assert.equal(custodyBalanceOf(v, MINT_A), 700n);
    assert.equal(v.assetCount, 1); // same mint: no new registration
  });

  it('a second asset mint increments the asset count', () => {
    let v = deposit(fresh(), DEPOSITOR, MINT_A, 500n);
    v = deposit(v, DEPOSITOR, MINT_B, 50n);
    assert.equal(v.assetCount, 2);
    assert.equal(holdingOf(v, MINT_A), 500n);
    assert.equal(holdingOf(v, MINT_B), 50n);
  });
});

describe('vessel withdrawals', () => {
  it('only the withdraw authority may withdraw', () => {
    const v = deposit(fresh(), DEPOSITOR, MINT_A, 500n);
    assert.equal(canWithdraw(v, WITHDRAWER).allowed, true);
    assert.equal(canWithdraw(v, ALICE).allowed, false);
    assert.equal(canWithdraw(v, OWNER).allowed, false);
    assert.throws(() => withdraw(v, ALICE, MINT_A, 1n), /WITHDRAW_NOT_PERMITTED/);
    assert.throws(() => withdraw(v, WITHDRAWER, MINT_A, 0n), /WITHDRAW_AMOUNT_NON_POSITIVE/);
  });

  it('cannot withdraw more than held; unknown asset rejected', () => {
    const v = deposit(fresh(), DEPOSITOR, MINT_A, 10n);
    assert.throws(() => withdraw(v, WITHDRAWER, MINT_A, 11n), /INSUFFICIENT_VESSEL_BALANCE/);
    assert.throws(() => withdraw(v, WITHDRAWER, MINT_B, 1n), /ASSET_NOT_HELD/);
  });

  it('withdraw keeps ledger and custody in lockstep; zero record is kept', () => {
    let v = deposit(fresh(), DEPOSITOR, MINT_A, 500n);
    v = withdraw(v, WITHDRAWER, MINT_A, 200n);
    assert.equal(holdingOf(v, MINT_A), 300n);
    assert.equal(custodyBalanceOf(v, MINT_A), 300n);
    v = withdraw(v, WITHDRAWER, MINT_A, 300n);
    assert.equal(holdingOf(v, MINT_A), 0n);
    assert.equal(custodyBalanceOf(v, MINT_A), 0n);
    // zero-balance record is kept, asset count is stable
    assert.equal(v.holdings.length, 1);
    assert.equal(v.assetCount, 1);
    // re-depositing does not re-register the mint
    v = deposit(v, DEPOSITOR, MINT_A, 42n);
    assert.equal(v.assetCount, 1);
    assert.equal(holdingOf(v, MINT_A), 42n);
  });
});

describe('holding invariant', () => {
  it('ledger and custody balance always agree after each operation', () => {
    let v = deposit(fresh(), DEPOSITOR, MINT_A, 100n);
    v = withdraw(v, WITHDRAWER, MINT_A, 40n);
    const h = v.holdings.find((x) => x.mint === MINT_A)!;
    assert.equal(h.amount, h.custodyBalance);
  });

  it('an external balance change desynchronizes the ledger: flows fail HOLDING_MISMATCH', () => {
    let v = deposit(fresh(), DEPOSITOR, MINT_A, 500n);
    // Someone sends tokens straight to the custody PDA, bypassing the program.
    v = applyExternalBalanceChange(v, MINT_A, 50n);
    assert.equal(custodyBalanceOf(v, MINT_A), 550n);
    assert.equal(holdingOf(v, MINT_A), 500n);
    assert.throws(() => deposit(v, DEPOSITOR, MINT_A, 10n), /HOLDING_MISMATCH/);
    assert.throws(() => withdraw(v, WITHDRAWER, MINT_A, 10n), /HOLDING_MISMATCH/);
  });

  it('external change on an unknown asset is rejected', () => {
    assert.throws(() => applyExternalBalanceChange(fresh(), MINT_A, 1n), /ASSET_NOT_HELD/);
  });
});

describe('ownership transfer', () => {
  it('transfers everything; previous owner retains nothing; custody unchanged; authorities not rotated', () => {
    let v = deposit(fresh(), DEPOSITOR, MINT_A, 500n);
    v = deposit(v, DEPOSITOR, MINT_B, 25n);
    const { state: v2, summary } = transferOwnership(v, ALICE);
    assert.equal(v2.owner, ALICE);
    assert.equal(summary.previousOwner, OWNER);
    assert.equal(summary.newOwner, ALICE);
    assert.deepEqual(summary.transferredHoldings, [
      { mint: MINT_A, amount: 500n, custodyBalance: 500n },
      { mint: MINT_B, amount: 25n, custodyBalance: 25n },
    ]);
    assert.deepEqual(summary.retainedByPreviousOwner, []);
    assert.equal(summary.custodyProgramUnchanged, TOKEN_2022);
    // authorities travel with the vessel config, still assigned to the same keys
    assert.deepEqual(summary.carriedAuthorities, {
      depositAuthority: DEPOSITOR,
      withdrawAuthority: WITHDRAWER,
    });
    // holdings ride along with the container
    assert.equal(holdingOf(v2, MINT_A), 500n);
    assert.equal(holdingOf(v2, MINT_B), 25n);
    assert.equal(v2.assetCount, 2);
    // the new owner gains no flow rights from the transfer alone
    assert.equal(canDeposit(v2, ALICE).allowed, false);
    assert.equal(canWithdraw(v2, ALICE).allowed, false);
    // the old owner is fully locked out
    assert.equal(canWithdraw(v2, OWNER).allowed, false);
    // existing authorities keep working under the new owner
    const v3 = withdraw(v2, WITHDRAWER, MINT_A, 100n);
    assert.equal(holdingOf(v3, MINT_A), 400n);
  });

  it('requires a new owner', () => {
    assert.throws(() => transferOwnership(fresh(), ''), /NEW_OWNER_REQUIRED/);
  });
});

describe('asset-mint extension gate (mirrors the on-chain allow-list)', () => {
  it('accepts bare and metadata-only mints; rejects hostile extensions', () => {
    assert.doesNotThrow(() => assertAllowedAssetMintExtensions([]));
    assert.doesNotThrow(() =>
      assertAllowedAssetMintExtensions(['MetadataPointer', 'TokenMetadata', 'MintCloseAuthority']),
    );
    assert.throws(() => assertAllowedAssetMintExtensions(['PermanentDelegate']), /INVALID_ASSET_MINT/);
    assert.throws(() => assertAllowedAssetMintExtensions(['TransferHook']), /INVALID_ASSET_MINT/);
    assert.throws(() => assertAllowedAssetMintExtensions(['TransferFeeConfig']), /INVALID_ASSET_MINT/);
    assert.throws(() => assertAllowedAssetMintExtensions(['NonTransferable']), /INVALID_ASSET_MINT/);
  });

  it('deposit enforces the gate when extensions are supplied', () => {
    assert.throws(
      () => deposit(fresh(), DEPOSITOR, MINT_A, 10n, { mintExtensions: ['PermanentDelegate'] }),
      /INVALID_ASSET_MINT/,
    );
    const v = deposit(fresh(), DEPOSITOR, MINT_A, 10n, { mintExtensions: ['TokenMetadata'] });
    assert.equal(holdingOf(v, MINT_A), 10n);
    // Omitting extensions preserves the old behavior (bare mint passes).
    const v2 = deposit(fresh(), DEPOSITOR, MINT_A, 10n);
    assert.equal(holdingOf(v2, MINT_A), 10n);
  });
});

describe('stray-asset adoption', () => {
  it('either authority can adopt a stray balance; strangers cannot; ledger only moves up', () => {
    let v = deposit(fresh(), DEPOSITOR, MINT_A, 500n);
    v = applyExternalBalanceChange(v, MINT_A, 50n);
    assert.throws(() => adoptStrayAssets(v, ALICE, MINT_A), /ADOPT_NOT_PERMITTED/);
    assert.throws(() => adoptStrayAssets(v, OWNER, MINT_A), /ADOPT_NOT_PERMITTED/); // owner has no flow rights
    v = adoptStrayAssets(v, WITHDRAWER, MINT_A);
    assert.equal(holdingOf(v, MINT_A), 550n);
    assert.equal(custodyBalanceOf(v, MINT_A), 550n);
    // Flows work again after adoption.
    v = withdraw(v, WITHDRAWER, MINT_A, 550n);
    assert.equal(holdingOf(v, MINT_A), 0n);
    // No-op when already in sync; the deposit authority may adopt too.
    v = adoptStrayAssets(v, DEPOSITOR, MINT_A);
    assert.equal(holdingOf(v, MINT_A), 0n);
  });

  it('rejects unknown assets', () => {
    assert.throws(() => adoptStrayAssets(fresh(), WITHDRAWER, MINT_A), /ASSET_NOT_HELD/);
  });
});

describe('authority rotation', () => {
  it('owner rotates authorities; old keys locked out; new keys work; strangers and empty keys rejected', () => {
    let v = deposit(fresh(), DEPOSITOR, MINT_A, 500n);
    assert.throws(() => updateDepositAuthority(v, ALICE, ALICE), /ROTATE_NOT_PERMITTED/);
    assert.throws(() => updateWithdrawAuthority(v, ALICE, ALICE), /ROTATE_NOT_PERMITTED/);
    assert.throws(() => updateDepositAuthority(v, OWNER, ''), /INVALID_DEPOSIT_AUTHORITY/);
    assert.throws(() => updateWithdrawAuthority(v, OWNER, ''), /INVALID_WITHDRAW_AUTHORITY/);

    v = updateDepositAuthority(v, OWNER, ALICE);
    v = updateWithdrawAuthority(v, OWNER, ALICE);
    assert.equal(canDeposit(v, DEPOSITOR).allowed, false);
    assert.equal(canWithdraw(v, WITHDRAWER).allowed, false);
    assert.equal(canDeposit(v, ALICE).allowed, true);
    assert.equal(canWithdraw(v, ALICE).allowed, true);
    assert.throws(() => deposit(v, DEPOSITOR, MINT_A, 1n), /DEPOSIT_NOT_PERMITTED/);
    const v2 = withdraw(v, ALICE, MINT_A, 100n);
    assert.equal(holdingOf(v2, MINT_A), 400n);

    // Rotation survives ownership transfer: the roles are independent of the owner.
    const { state: v3 } = transferOwnership(v, ALICE);
    assert.equal(canDeposit(v3, ALICE).allowed, true);
    assert.equal(canWithdraw(v3, ALICE).allowed, true);
  });
});
