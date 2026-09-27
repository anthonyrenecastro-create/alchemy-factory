/**
 * Devnet cost estimator.
 *
 * SIMULATION of costs: estimates only, not quotes. Devnet SOL comes from the
 * faucet (free), so these numbers are a MAINNET-REFERENCE estimate shown
 * BEFORE launch so creators see realistic costs. Rent and fees change with
 * network conditions; actuals may differ.
 *
 * Rent math: rent-exempt minimum (lamports) = (128 + dataBytes) * 6960.
 * Transaction fee: 5,000 lamports per signature (base fee; priority fees extra).
 */

import type { CostEstimate, CostLineItem, ExperimentConfig, MechanicKind } from './types.js';

export const LAMPORTS_PER_SIGNATURE = 5_000n;
export const LAMPORTS_PER_SOL = 1_000_000_000n;

/** Rent-exempt minimum for an account holding `dataBytes` bytes. */
export function rentExemptMinimum(dataBytes: number): bigint {
  return BigInt(128 + dataBytes) * 6_960n;
}

/** Approximate extra mint-account bytes per Token-2022 extension. */
export const EXTENSION_EXTRA_BYTES: Record<string, number> = {
  'transfer-hook': 96,
  'permanent-delegate': 36,
  'metadata-pointer': 64,
  'default-account-state': 8,
  'immutable-owner': 0,
  'non-transferable': 0,
};

/** Extra on-chain accounts created per mechanic (name + data bytes), devnet stage. */
const MECHANIC_ACCOUNTS: Record<MechanicKind, { label: string; bytes: number }[]> = {
  curve: [
    { label: 'Curve state account', bytes: 256 },
    { label: 'Reserve vault (token account)', bytes: 165 },
    { label: 'Fee collector account', bytes: 165 },
  ],
  decay: [{ label: 'Decay config account', bytes: 128 }],
  dynamic: [
    { label: 'Dynamic config account', bytes: 192 },
    { label: 'Update history account (initial)', bytes: 1024 },
  ],
  vessel: [
    { label: 'Vessel state account', bytes: 256 },
    { label: 'Vessel holdings account', bytes: 1024 },
  ],
  proofx: [
    { label: 'ProofX config account', bytes: 256 },
    { label: 'Nonce registry account', bytes: 2048 },
    { label: 'Revocation registry account', bytes: 512 },
  ],
  // VaultConfig::SPACE (224) + VaultProof::SPACE (137) per the on-chain structs.
  vault: [
    { label: 'Vault config account', bytes: 224 },
    { label: 'Vault proof account', bytes: 137 },
    { label: 'Share mint', bytes: 82 },
    { label: 'Vault collateral token account', bytes: 165 },
  ],
};

/** Estimated signatures (transactions) per mechanic setup flow. */
const MECHANIC_TX_COUNT: Record<MechanicKind, number> = {
  curve: 8,
  decay: 5,
  dynamic: 6,
  vessel: 7,
  proofx: 8,
  vault: 9,
};

export function formatSol(lamports: bigint): string {
  const whole = lamports / LAMPORTS_PER_SOL;
  const frac = lamports % LAMPORTS_PER_SOL;
  return `${whole}.${frac.toString().padStart(9, '0').replace(/0+$/, '') || '0'}`;
}

/**
 * Estimate the cost of creating an experiment on devnet.
 * `opts.accountCount` scales vault/ATA-style accounts (default 1).
 */
export function estimateExperimentCost(
  experiment: ExperimentConfig,
  opts: { accountCount?: number } = {},
): CostEstimate {
  const items: CostLineItem[] = [];
  const accountCount = opts.accountCount ?? 1;

  // Mint account: base 82 bytes + per-extension extras.
  let mintBytes = 82;
  for (const ext of experiment.extensions) {
    mintBytes += EXTENSION_EXTRA_BYTES[ext] ?? 32; // unknown extension: conservative guess, disclosed
  }
  const mintRent = rentExemptMinimum(mintBytes);
  items.push({
    label: 'Mint account rent (rent-exempt)',
    lamports: mintRent,
    detail: `Token-2022 mint, ${mintBytes} bytes incl. extensions [${experiment.extensions.join(', ') || 'none'}].`,
  });

  // Metaplex-style metadata account (Token Metadata program).
  const metadataRent = rentExemptMinimum(512);
  items.push({
    label: 'Token metadata account rent',
    lamports: metadataRent,
    detail: '512 bytes: name, symbol, URI pointer.',
  });

  // Mechanic accounts.
  for (const acct of MECHANIC_ACCOUNTS[experiment.mechanic]) {
    items.push({
      label: `${acct.label} rent`,
      lamports: rentExemptMinimum(acct.bytes),
      detail: `${acct.bytes} bytes, rent-exempt.`,
    });
  }

  // Creator-associated token accounts.
  for (let i = 0; i < accountCount; i++) {
    items.push({
      label: 'Associated token account rent',
      lamports: rentExemptMinimum(165),
      detail: '165-byte ATA for the creator (x1).',
    });
  }

  // Transaction fees for the setup flow.
  const txCount = MECHANIC_TX_COUNT[experiment.mechanic];
  items.push({
    label: 'Setup transaction fees',
    lamports: BigInt(txCount) * LAMPORTS_PER_SIGNATURE,
    detail: `~${txCount} signatures at 5,000 lamports each (base fee; priority fees not included).`,
  });

  const totalLamports = items.reduce((sum, i) => sum + i.lamports, 0n);
  return {
    items,
    totalLamports,
    totalSol: formatSol(totalLamports),
    network: 'devnet',
    note:
      'Estimate only — devnet SOL is free from the faucet. Shown as a mainnet-reference ' +
      'so creators see realistic costs before launch. Rent depends on account sizes; ' +
      'fees depend on network congestion and priority fees.',
  };
}
