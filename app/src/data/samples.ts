import type { AuthoritySet, MechanicKind } from '@sdk';

/**
 * Sample tokens for the holder app's discovery list.
 * EVERY entry here is illustrative sample data — clearly labeled SAMPLE in the
 * UI and never presented as a real on-chain token.
 */

export interface SampleTx {
  sig: string;
  kind: string;
  amount: string;
  time: string;
}

export interface SampleToken {
  mint: string;
  name: string;
  symbol: string;
  mechanic: MechanicKind;
  isSample: true;
  description: string;
  whyItBehaves: string;
  authorities: AuthoritySet;
  extensions: string[];
  fees: string;
  risks: string[];
  redemptionTerms: string;
  expiry: string | null;
  collateral: string | null;
  /** Sample wallet balance shown in the UI (not a chain read). */
  sampleBalance: string;
  /** Transfers permitted in this sample? If not, the UI disables the form with `transferBlockReason`. */
  transfersPermitted: boolean;
  transferBlockReason: string | null;
  /** Whether buy/sell is supported in this sample (simulation mode). */
  tradingSupported: boolean;
  vaultHoldings: { mint: string; amount: string }[] | null;
  proofStatus: { attestationId: string; claimType: string; status: string }[] | null;
  txHistory: SampleTx[];
}

/** Obviously-fake but base58-valid mint strings (decode to 32 bytes). */
const fakeMint = (prefix: string) => prefix + '1'.repeat(44 - prefix.length);

export const SAMPLE_TOKENS: SampleToken[] = [
  {
    mint: fakeMint('CurvE'),
    name: 'Sample Linear Coin',
    symbol: 'SLC',
    mechanic: 'curve',
    isSample: true,
    description: 'A bonding-curve token using the audited linear template. Price rises with supply.',
    whyItBehaves: 'Its price is set by a linear bonding curve (base price + slope × supply) held in the curve program\u2019s reserve vault. Every buy raises the price for the next buyer; every sell lowers it. A 0.3% protocol fee is taken on each trade. On-chain, the program mints and burns tokens and holds the reserve — price is a pure function of supply, so no holder can change the formula. Authorities: the curve program is the effective mint authority (it alone can mint/burn); no freeze authority, no permanent delegate, no transfer hook.',
    authorities: {
      mintAuthority: null,
      freezeAuthority: null,
      updateAuthority: null,
      permanentDelegate: null,
      transferHookProgram: null,
    },
    extensions: [],
    fees: '0.30% protocol fee on buys and sells (rounded up). No transfer fee.',
    risks: [
      'Price impact: large trades move the price against you (see slippage in the trade panel).',
      'Sandwich risk: the curve is front-runnable at large sizes — simulated in the studio.',
      'Reserve is denominated in the quote asset; a quote-asset price crash affects redemption value.',
    ],
    redemptionTerms: 'Sell back to the reserve vault at the current curve price at any time; no lockup.',
    expiry: null,
    collateral: 'Reserve vault holds the quote asset backing all outstanding tokens.',
    sampleBalance: '1,250 SLC',
    transfersPermitted: true,
    transferBlockReason: null,
    tradingSupported: true,
    vaultHoldings: null,
    proofStatus: null,
    txHistory: [
      { sig: 'SAMPLE-tx-1', kind: 'Buy', amount: '+500 SLC', time: '2026-09-26 14:02 UTC' },
      { sig: 'SAMPLE-tx-2', kind: 'Sell', amount: '−120 SLC', time: '2026-09-25 09:41 UTC' },
      { sig: 'SAMPLE-tx-3', kind: 'Buy', amount: '+870 SLC', time: '2026-09-24 18:15 UTC' },
    ],
  },
  {
    mint: fakeMint('DecaY'),
    name: 'Sample Fading Ticket',
    symbol: 'SFT',
    mechanic: 'decay',
    isSample: true,
    description: 'A time-decaying admission token: balances shrink 5% per month and transfers stop at expiry.',
    whyItBehaves: 'The decay program is the deterministic schedule authority: it advances decay periods with exact on-chain integer math and discloses the removed-value recipient (here: the creator treasury). It moves no tokens itself — the per-holder decayed balance is derived from the on-chain period counters (the display layer), and the schedule is cranked forward permissionlessly, on a fixed timetable. Authorities: the decay authority owns the schedule; removed value goes to the disclosed recipient, never silently burned. Risks, stated honestly: after expiry, transfers stop and redemption closes 30 days later — but these post-expiry flags are on-chain declarations, not program-enforced (enforcement would require a transfer hook, which this build does not silently enable). Balances shrink deterministically; holding is penalized by design.',
    authorities: {
      mintAuthority: null,
      freezeAuthority: null,
      updateAuthority: null,
      permanentDelegate: null,
      transferHookProgram: null,
    },
    extensions: [],
    fees: 'No protocol fee. Decay removes 5% of balance per 30-day period (floored per period).',
    risks: [
      'Balances shrink over time by design — holding is penalized.',
      'Transfers are disabled after expiry; only redemption remains.',
      'Removed value goes to the creator treasury, not back to holders.',
    ],
    redemptionTerms: 'Redeemable for event access until 30 days after expiry; no cash redemption.',
    expiry: '2027-03-01 (transfers disabled; redemption open until 2027-03-31)',
    collateral: null,
    sampleBalance: '42 SFT',
    transfersPermitted: false,
    transferBlockReason: 'Sample token is past its decay demo expiry in this illustration — transfers are disabled by the experiment config.',
    tradingSupported: false,
    vaultHoldings: null,
    proofStatus: null,
    txHistory: [
      { sig: 'SAMPLE-tx-4', kind: 'Decay', amount: '−5% (monthly)', time: '2026-09-01 00:00 UTC' },
      { sig: 'SAMPLE-tx-5', kind: 'Transfer in', amount: '+44 SFT', time: '2026-08-12 11:20 UTC' },
    ],
  },
  {
    mint: fakeMint('DynAm'),
    name: 'Sample Oracle Share',
    symbol: 'SOS',
    mechanic: 'dynamic',
    isSample: true,
    description: 'Supply tracks an authenticated oracle feed (sample: simulated SOL/USD), capped at 1M tokens.',
    whyItBehaves: 'On-chain, the dynamic program accepts updates ONLY from the update authority and rejects anything else: stale data (older than the max age), non-monotonic or future-dated values, and updates arriving too frequently are all rejected, and every accepted update lands in an append-only history you can audit. Supply is set to value × scale, clamped at the max supply. Authorities: the update authority is a single key — it can push any value within the cap. Risks, stated honestly: the program does not decide what the number MEANS — value semantics are defined by this experiment (sample: simulated SOL/USD). The data source is an off-chain feed, named honestly — writing its result on-chain never makes it decentralized. This sample\u2019s stale-data circuit breaker freezes transfers until a fresh update arrives; that pause is a safety switch, not a malfunction.',
    authorities: {
      mintAuthority: 'UpdateAuth11111111111111111111111111111111',
      freezeAuthority: null,
      updateAuthority: 'UpdateAuth11111111111111111111111111111111',
      permanentDelegate: null,
      transferHookProgram: null,
    },
    extensions: [],
    fees: 'No protocol fee.',
    risks: [
      'Oracle risk: a wrong or manipulated feed value changes supply for everyone.',
      'Staleness freeze: transfers halt if the feed stops updating.',
      'The update authority is a single key — it can push any value within the cap.',
    ],
    redemptionTerms: 'No redemption; supply is informational and tracks the feed.',
    expiry: null,
    collateral: null,
    sampleBalance: '310 SOS',
    transfersPermitted: true,
    transferBlockReason: null,
    tradingSupported: false,
    vaultHoldings: null,
    proofStatus: null,
    txHistory: [
      { sig: 'SAMPLE-tx-6', kind: 'Oracle update', amount: 'supply → 310,000', time: '2026-09-27 05:58 UTC' },
      { sig: 'SAMPLE-tx-7', kind: 'Oracle update', amount: 'supply → 308,500', time: '2026-09-27 05:53 UTC' },
    ],
  },
  {
    mint: fakeMint('VesseL'),
    name: 'Sample Vault Basket',
    symbol: 'SVB',
    mechanic: 'vessel',
    isSample: true,
    description: 'A transferable container holding a defined basket of sample assets.',
    whyItBehaves: 'The token IS the container. On-chain, the vessel PDA custodies the assets in PDA-owned token accounts, and a holding invariant is asserted on every deposit, withdrawal, and ownership transfer. Deposit and withdraw are separately permissioned — in this sample deposits are open and withdrawals are owner-only. Authorities: the container owner (token holder) plus the configured deposit and withdraw authorities. Transferring the token transfers the entire basket AND its permission rules to the new owner; the previous owner keeps nothing. Risk, stated honestly: direct transfers to a custody account bypass the program and desynchronize the on-chain ledger — v1 has no sweep instruction, so only deposit through the program.',
    authorities: {
      mintAuthority: null,
      freezeAuthority: null,
      updateAuthority: null,
      permanentDelegate: null,
      transferHookProgram: null,
    },
    extensions: [],
    fees: 'No protocol fee. Withdrawals are owner-only in this sample.',
    risks: [
      'Basket value floats with the underlying assets.',
      'Only the owner can withdraw; a lost owner key strands the basket.',
      'Ownership transfer moves ALL holdings — verify the ledger before accepting.',
    ],
    redemptionTerms: 'Owner may withdraw underlying assets at any time (sample: owner-only).',
    expiry: null,
    collateral: 'Holdings ledger: 12.5 sample SOL + 4,000 sample USDC (illustrative).',
    sampleBalance: '1 SVB (whole basket)',
    transfersPermitted: true,
    transferBlockReason: null,
    tradingSupported: false,
    vaultHoldings: [
      { mint: fakeMint('SoL'), amount: '12.5 sample SOL' },
      { mint: fakeMint('UsDC'), amount: '4,000 sample USDC' },
    ],
    proofStatus: null,
    txHistory: [
      { sig: 'SAMPLE-tx-8', kind: 'Deposit', amount: '+2.5 sample SOL', time: '2026-09-20 16:00 UTC' },
      { sig: 'SAMPLE-tx-9', kind: 'Ownership transfer', amount: '1 SVB', time: '2026-09-18 10:11 UTC' },
    ],
  },
  {
    mint: fakeMint('ProoF'),
    name: 'Sample Graduate Badge',
    symbol: 'SGB',
    mechanic: 'proofx',
    isSample: true,
    description: 'Mints from a verifiable course-completion attestation. Manual verifier approval — not automatic.',
    whyItBehaves: 'Tokens mint only from an attestation signed by a trusted verifier — the verifier\u2019s co-signature on the mint transaction IS the attestation. Here the verifier is a human reviewer, so these badges are \u201cmanually approved\u201d — never described as automatically verified. Each attestation carries a one-time nonce: replaying it is rejected, so one attestation mints exactly once. Authorities: the trusted verifier (who can issue or withhold badges at will) and the revocation authority. Risk, stated honestly: revocation flags the claim — it does NOT burn tokens already minted. The badge is soulbound (non-transferable) by design: it cannot be sold or sent.',
    authorities: {
      mintAuthority: 'Verifier111111111111111111111111111111111',
      freezeAuthority: null,
      updateAuthority: null,
      permanentDelegate: null,
      transferHookProgram: null,
    },
    extensions: ['non-transferable'],
    fees: 'No protocol fee. Badge is non-transferable (soulbound) in this sample.',
    risks: [
      'Verifier trust: the verifier can issue or withhold badges at will.',
      'Revocation: the revocation authority can revoke your badge.',
      'Non-transferable: you cannot sell or send this badge.',
    ],
    redemptionTerms: 'No redemption; the badge is a credential, not a financial claim.',
    expiry: null,
    collateral: null,
    sampleBalance: '1 SGB',
    transfersPermitted: false,
    transferBlockReason: 'Non-transferable extension: this badge is soulbound to the holder and cannot be sent.',
    tradingSupported: false,
    vaultHoldings: null,
    proofStatus: [
      { attestationId: 'att-sample-1', claimType: 'completed-course:alchemy-101', status: 'valid' },
      { attestationId: 'att-sample-0', claimType: 'completed-course:alchemy-100', status: 'revoked' },
    ],
    txHistory: [
      { sig: 'SAMPLE-tx-10', kind: 'Mint (attested)', amount: '+1 SGB', time: '2026-09-15 13:30 UTC' },
      { sig: 'SAMPLE-tx-11', kind: 'Revocation', amount: 'att-sample-0 revoked', time: '2026-09-10 08:00 UTC' },
    ],
  },
];
