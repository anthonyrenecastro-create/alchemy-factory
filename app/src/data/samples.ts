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
    whyItBehaves: 'Its price is set by a linear bonding curve (base price + slope × supply) held in the curve program\u2019s reserve vault. Every buy raises the price for the next buyer; every sell lowers it. A 0.3% protocol fee is taken on each trade.',
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
    whyItBehaves: 'Each month 5% of every balance is removed and routed to the creator treasury — that is the token\u2019s designed decay, not a bug. At the fixed expiry date transfers are disabled entirely, while redemption stays open for 30 days.',
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
    whyItBehaves: 'An update authority posts values from an off-chain price feed; supply is set to value × scale, clamped at the 1M max supply. The feed is an off-chain data source — writing its result on-chain does not make it decentralized. If the feed goes stale (>5 min), transfers freeze until a fresh update arrives.',
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
    whyItBehaves: 'The token is a container: owning it means owning the claim on its holdings ledger (sample SOL and sample USDC), custodied by the vessel program. Transferring the token transfers the entire basket and its permission rules to the new owner; the previous owner keeps nothing.',
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
    whyItBehaves: 'Tokens mint only from an attestation signed by a trusted verifier, and each attestation carries a one-time nonce — replaying it is rejected. Approval here is MANUAL: a human verifier reviews the evidence off-chain. It is never described as automatic verification. The revocation authority can revoke badges.',
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
