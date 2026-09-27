import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkCompatibility, checkVaultCollateral, recommendExtensions,
  type Token2022Extension, type CompatReport,
} from '../compat.js';

function finding(report: CompatReport, subject: string) {
  return report.findings.find((f) => f.subject === subject);
}

describe('metadata-only baseline', () => {
  it('is green, protocol-valid, and nothing requires acknowledgment', () => {
    const r = checkCompatibility(['metadata-pointer', 'token-metadata']);
    assert.equal(r.overall, 'green');
    assert.equal(r.blocked, false);
    assert.equal(r.protocolValid, true);
    assert.ok(r.findings.every((f) => !f.requiresAcknowledgment));
  });

  it('empty extension set is also green', () => {
    const r = checkCompatibility([]);
    assert.equal(r.overall, 'green');
    assert.equal(r.protocolValid, true);
    assert.equal(r.blocked, false);
  });

  it('deduplicates repeated extensions', () => {
    const r = checkCompatibility(['transfer-fee', 'transfer-fee']);
    assert.deepEqual(r.extensions, ['transfer-fee']);
  });
});

describe('transfer-fee alone', () => {
  it('is amber with the four caveats explained', () => {
    const r = checkCompatibility(['metadata-pointer', 'token-metadata', 'transfer-fee']);
    assert.equal(r.overall, 'amber');
    assert.equal(r.blocked, false);
    assert.equal(r.protocolValid, true);
    const f = finding(r, 'transfer-fee');
    assert.ok(f);
    assert.equal(f.severity, 'amber');
    assert.equal(f.requiresAcknowledgment, false);
    const e = f.explanation.toLowerCase();
    assert.ok(e.includes('withheld'), 'caveat 1: withheld on recipient');
    assert.ok(e.includes('fee authority can change the rate'), 'caveat 2: fee authority can change rate');
    assert.ok(e.includes('dca'), 'caveat 3: no Jupiter DCA');
    assert.ok(e.includes('gross'), 'caveat 4: slippage on gross');
    assert.ok(f.venueNotes.some((n) => n.includes('Raydium')), 'Raydium venue note');
  });
});

describe('transfer-hook', () => {
  it('is red and blocks until acknowledged', () => {
    const r = checkCompatibility(['metadata-pointer', 'token-metadata', 'transfer-hook']);
    assert.equal(r.overall, 'red');
    assert.equal(r.blocked, true);
    assert.equal(r.protocolValid, true);
    const f = finding(r, 'transfer-hook');
    assert.ok(f);
    assert.equal(f.severity, 'red');
    assert.equal(f.requiresAcknowledgment, true);
    const e = f.explanation.toLowerCase();
    assert.ok(e.includes('aggregator'), 'aggregator routing breakage');
    assert.ok(e.includes('upgradeable'), 'soft-rug vector named');
  });

  it('stacked with transfer-fee escalates to a single escalated red finding', () => {
    const r = checkCompatibility(['transfer-fee', 'transfer-hook']);
    const f = finding(r, 'transfer-hook + transfer-fee');
    assert.ok(f, 'escalated combined finding present');
    assert.equal(f.severity, 'red');
    assert.equal(f.requiresAcknowledgment, true);
    assert.ok(f.title.toLowerCase().includes('escalated'));
    assert.equal(r.overall, 'red');
    assert.equal(r.blocked, true);
    assert.equal(r.protocolValid, true);
  });
});

describe('permanent-delegate', () => {
  it('is red, blocked, Raydium blocked from pools', () => {
    const r = checkCompatibility(['permanent-delegate']);
    assert.equal(r.overall, 'red');
    assert.equal(r.blocked, true);
    assert.equal(r.protocolValid, true);
    const f = finding(r, 'permanent-delegate');
    assert.ok(f);
    assert.equal(f.requiresAcknowledgment, true);
    assert.ok(f.explanation.toLowerCase().includes('custody'), 'custody red flag');
    assert.ok(f.venueNotes.some((n) => n.includes('Raydium') && n.includes('blocked')));
  });
});

describe('non-transferable', () => {
  it('is red/blocked with Raydium+Orca venue notes, soulbound exception named', () => {
    const r = checkCompatibility(['metadata-pointer', 'token-metadata', 'non-transferable']);
    assert.equal(r.overall, 'red');
    assert.equal(r.blocked, true);
    assert.equal(r.protocolValid, true);
    const f = finding(r, 'non-transferable');
    assert.ok(f);
    assert.equal(f.requiresAcknowledgment, true);
    assert.ok(f.explanation.toLowerCase().includes('soulbound'), 'soulbound exception named');
    assert.ok(f.venueNotes.some((n) => n.includes('Raydium') && n.includes('reject')));
    assert.ok(f.venueNotes.some((n) => n.includes('Orca') && n.includes('not supported')));
  });
});

describe('confidential-transfer', () => {
  it('is red with acknowledgment required', () => {
    const r = checkCompatibility(['confidential-transfer']);
    assert.equal(r.overall, 'red');
    assert.equal(r.blocked, true);
    assert.equal(r.protocolValid, true);
    const f = finding(r, 'confidential-transfer');
    assert.ok(f);
    assert.equal(f.severity, 'red');
    assert.equal(f.requiresAcknowledgment, true);
    assert.ok(f.venueNotes.some((n) => n.includes('Raydium') && n.includes('blocked')));
  });
});

describe('protocol-enforced combination rules', () => {
  it('scaled-ui-amount + interest-bearing is protocol-invalid (mutual exclusion)', () => {
    const r = checkCompatibility(['scaled-ui-amount', 'interest-bearing']);
    assert.equal(r.protocolValid, false);
    assert.equal(r.overall, 'red');
    assert.equal(r.blocked, true);
    const f = finding(r, 'scaled-ui-amount + interest-bearing');
    assert.ok(f);
    assert.ok(f.explanation.includes('InvalidExtensionCombination'));
  });

  it('transfer-fee + confidential-transfer without the fee config is protocol-invalid', () => {
    const r = checkCompatibility(['transfer-fee', 'confidential-transfer']);
    assert.equal(r.protocolValid, false);
    const f = finding(r, 'transfer-fee + confidential-transfer (incomplete set)');
    assert.ok(f);
    assert.equal(f.severity, 'red');
  });

  it('confidential-transfer-fee without the pair is protocol-invalid', () => {
    const r = checkCompatibility(['confidential-transfer-fee']);
    assert.equal(r.protocolValid, false);
    const f = finding(r, 'confidential-transfer-fee (missing dependency)');
    assert.ok(f);
  });

  it('adding the third confidential extension repairs the set (protocol-valid, still red on friction)', () => {
    const r = checkCompatibility(['transfer-fee', 'confidential-transfer', 'confidential-transfer-fee']);
    assert.equal(r.protocolValid, true);
    // never presented as safe: venue friction still red
    assert.equal(r.overall, 'red');
  });

  it('non-transferable + confidential-transfer is protocol-suspect', () => {
    const r = checkCompatibility(['non-transferable', 'confidential-transfer']);
    assert.equal(r.protocolValid, false);
    assert.ok(finding(r, 'non-transferable + confidential-transfer*'));
  });

  it('non-transferable + transfer-fee is an unverified-combination caution, NOT a protocol violation', () => {
    const r = checkCompatibility(['non-transferable', 'transfer-fee']);
    assert.equal(r.protocolValid, true);
    const f = finding(r, 'non-transferable + transfer-fee');
    assert.ok(f);
    assert.equal(f.severity, 'amber');
    assert.equal(f.requiresAcknowledgment, false);
    assert.ok(f.explanation.toLowerCase().includes('devnet'));
  });
});

describe('amber extensions', () => {
  it('interest-bearing alone is amber with display + LP-accrual caveats, not blocking', () => {
    const r = checkCompatibility(['interest-bearing']);
    assert.equal(r.overall, 'amber');
    assert.equal(r.blocked, false);
    const f = finding(r, 'interest-bearing');
    assert.ok(f);
    assert.ok(f.explanation.toLowerCase().includes('raw'), 'raw-balance display caveat');
    assert.ok(f.explanation.toLowerCase().includes('never') && f.explanation.includes('yield'),
      'never presented as yield');
  });

  it('scaled-ui-amount alone is amber: wallet rendering unverified, cosmetic only', () => {
    const r = checkCompatibility(['scaled-ui-amount']);
    assert.equal(r.overall, 'amber');
    const f = finding(r, 'scaled-ui-amount');
    assert.ok(f);
    assert.ok(f.explanation.toLowerCase().includes('unverified'));
    assert.ok(f.explanation.toLowerCase().includes('cosmetic'));
  });

  it('memo-transfer is amber: every transfer needs a memo, wallet enforcement undocumented', () => {
    const r = checkCompatibility(['memo-transfer']);
    assert.equal(r.overall, 'amber');
    assert.equal(r.blocked, false);
    const f = finding(r, 'memo-transfer');
    assert.ok(f);
    assert.ok(f.explanation.toLowerCase().includes('memo'));
  });

  it('permissioned-burn is amber: new extension, program-driven burns only', () => {
    const r = checkCompatibility(['permissioned-burn']);
    assert.equal(r.overall, 'amber');
    assert.equal(r.blocked, false);
    const f = finding(r, 'permissioned-burn');
    assert.ok(f);
    assert.ok(f.explanation.toLowerCase().includes('scoped alternative'));
  });
});

describe('red extensions', () => {
  it('default-account-state-frozen is red/blocked: Raydium blocked, thaw UX', () => {
    const r = checkCompatibility(['default-account-state-frozen']);
    assert.equal(r.overall, 'red');
    assert.equal(r.blocked, true);
    const f = finding(r, 'default-account-state-frozen');
    assert.ok(f);
    assert.equal(f.requiresAcknowledgment, true);
    assert.ok(f.venueNotes.some((n) => n.includes('Raydium') && n.includes('blocked')));
    assert.ok(f.explanation.includes('AccountFrozen'));
  });

  it('pausable is red/blocked: kill-switch trust assumption', () => {
    const r = checkCompatibility(['pausable']);
    assert.equal(r.overall, 'red');
    assert.equal(r.blocked, true);
    const f = finding(r, 'pausable');
    assert.ok(f);
    assert.equal(f.requiresAcknowledgment, true);
    assert.ok(f.explanation.toLowerCase().includes('kill switch'));
  });

  it('mint-close-authority is green (with the Raydium docs-conflict venue note)', () => {
    const r = checkCompatibility(['mint-close-authority']);
    assert.equal(r.overall, 'green');
    assert.equal(r.blocked, false);
    const f = finding(r, 'mint-close-authority');
    assert.ok(f);
    assert.equal(f.severity, 'green');
    assert.ok(f.venueNotes.some((n) => n.includes('conflict')), 'Raydium docs conflict flagged');
  });

  it('cpi-guard is a green note: never enable on program vault accounts', () => {
    const r = checkCompatibility(['cpi-guard']);
    assert.equal(r.overall, 'green');
    const f = finding(r, 'cpi-guard');
    assert.ok(f);
    assert.ok(f.explanation.toLowerCase().includes('vault'));
  });
});

describe('recommendExtensions', () => {
  it('curve: metadata only; notes rule out transfer-fee for curve fees', () => {
    const { recommended, notes } = recommendExtensions('curve');
    assert.deepEqual(recommended, ['metadata-pointer', 'token-metadata']);
    assert.ok(notes.includes('mint-close-authority'));
    assert.ok(notes.toLowerCase().includes('do not use'));
  });

  it('decay: exactly one of scaled-ui-amount XOR interest-bearing; hook red-flagged; permissioned-burn optional', () => {
    const { recommended, notes } = recommendExtensions('decay');
    assert.deepEqual(recommended, ['metadata-pointer', 'token-metadata', 'scaled-ui-amount']);
    assert.ok(!recommended.includes('interest-bearing'), 'XOR: exactly one');
    assert.ok(notes.includes('XOR'));
    assert.ok(notes.includes('interest-bearing'), 'alternative named');
    assert.ok(notes.includes('transfer-hook'), 'red-flagged hook option named');
    assert.ok(notes.includes('permissioned-burn'));
  });

  it('dynamic: metadata only; program-held mint authority is not an extension', () => {
    const { recommended, notes } = recommendExtensions('dynamic');
    assert.deepEqual(recommended, ['metadata-pointer', 'token-metadata']);
    assert.ok(notes.includes('not an extension'));
  });

  it('vessel: metadata only; hook option red-flagged; group pointers warned off', () => {
    const { recommended, notes } = recommendExtensions('vessel');
    assert.deepEqual(recommended, ['metadata-pointer', 'token-metadata']);
    assert.ok(notes.includes('transfer-hook'));
    assert.ok(notes.toLowerCase().includes('orca'), 'Orca group-pointer stance named');
  });

  it('proofx: soulbound set with forced immutable-owner and revocation burn', () => {
    const { recommended, notes } = recommendExtensions('proofx');
    assert.deepEqual(recommended, [
      'metadata-pointer', 'token-metadata', 'non-transferable', 'immutable-owner', 'permissioned-burn',
    ]);
    assert.ok(notes.toLowerCase().includes('soulbound'));
  });

  it('vault: metadata only; collateral mint validation required', () => {
    const { recommended, notes } = recommendExtensions('vault');
    assert.deepEqual(recommended, ['metadata-pointer', 'token-metadata']);
    assert.ok(notes.toLowerCase().includes('collateral'));
  });
});

describe('checker self-consistency', () => {
  it('curve recommendation checks green', () => {
    const r = checkCompatibility(recommendExtensions('curve').recommended);
    assert.equal(r.overall, 'green');
    assert.equal(r.blocked, false);
    assert.equal(r.protocolValid, true);
  });

  it('decay recommendation checks amber via scaled-ui-amount alone, not blocking', () => {
    const r = checkCompatibility(recommendExtensions('decay').recommended);
    assert.equal(r.protocolValid, true);
    assert.equal(r.overall, 'amber');
    assert.equal(r.blocked, false);
  });

  it('proofx recommendation is red by design (soulbound) yet protocol-valid', () => {
    const r = checkCompatibility(recommendExtensions('proofx').recommended);
    assert.equal(r.protocolValid, true);
    assert.equal(r.overall, 'red');
    assert.equal(r.blocked, true);
  });

  it('is deterministic regardless of input order', () => {
    const exts: Token2022Extension[] = ['transfer-fee', 'transfer-hook', 'memo-transfer'];
    const a = checkCompatibility(exts);
    const b = checkCompatibility([...exts].reverse());
    assert.deepEqual(a.findings, b.findings);
    assert.equal(a.overall, b.overall);
    assert.equal(a.blocked, b.blocked);
    assert.equal(a.protocolValid, b.protocolValid);
  });
});

// Security-review regression tests (our own review, not an external audit):
// checkVaultCollateral must mirror the on-chain collateral allow-list in
// alchemy_vault's validate_collateral_mint EXACTLY, so the studio surfaces
// the same accept/reject verdict the program enforces.
describe('checkVaultCollateral (on-chain allow-list mirror)', () => {
  it('accepts empty and metadata-only extension sets', () => {
    assert.deepEqual(checkVaultCollateral([]), { allowed: true, rejected: [] });
    assert.deepEqual(
      checkVaultCollateral(['metadata-pointer', 'token-metadata']),
      { allowed: true, rejected: [] },
    );
  });

  it('accepts mint-close-authority (the third allow-listed extension)', () => {
    const v = checkVaultCollateral(['metadata-pointer', 'token-metadata', 'mint-close-authority']);
    assert.equal(v.allowed, true);
    assert.deepEqual(v.rejected, []);
  });

  it('rejects permanent-delegate, transfer-fee, and transfer-hook exactly like the program', () => {
    const hostile = ['permanent-delegate', 'transfer-fee', 'transfer-hook'] as Token2022Extension[];
    for (const ext of hostile) {
      const v = checkVaultCollateral(['metadata-pointer', ext]);
      assert.equal(v.allowed, false, ext);
      assert.deepEqual(v.rejected, [ext]);
    }
  });

  it('rejects every other known extension', () => {
    const hostile: Token2022Extension[] = [
      'non-transferable', 'confidential-transfer', 'confidential-transfer-fee',
      'interest-bearing', 'scaled-ui-amount', 'default-account-state-frozen',
      'immutable-owner', 'memo-transfer', 'pausable', 'permissioned-burn', 'cpi-guard',
    ];
    const v = checkVaultCollateral(hostile);
    assert.equal(v.allowed, false);
    assert.deepEqual(v.rejected, hostile);
  });

  it('deduplicates repeated extensions', () => {
    const v = checkVaultCollateral(['transfer-fee', 'transfer-fee']);
    assert.deepEqual(v.rejected, ['transfer-fee']);
  });
});
