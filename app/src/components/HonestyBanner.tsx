import type { ReactNode } from 'react';

export type HonestyMode = 'simulation' | 'devnet' | 'mixed';

const COPY: Record<HonestyMode, { tag: string; body: string }> = {
  simulation: {
    tag: 'Simulation',
    body: 'Nothing on this page touches the blockchain. All numbers are produced by the local deterministic simulation engine — no wallet, purchase, or fee is required.',
  },
  devnet: {
    tag: 'Devnet',
    body: 'Devnet programs and valueless test tokens. Nothing here is mainnet, audited, or production-ready.',
  },
  mixed: {
    tag: 'Simulated + Devnet',
    body: 'This page mixes live devnet reads with local simulation. Every panel is labeled with which one it is — simulated values never represent chain state.',
  },
};

/**
 * HonestyBanner — rendered on every page. Marks content as simulated vs
 * on-chain so a simulation is never mistaken for chain state.
 */
export function HonestyBanner({ mode, children }: { mode: HonestyMode; children?: ReactNode }) {
  const c = COPY[mode];
  return (
    <div className={`honesty ${mode}`} role="note">
      <span className="tag">{c.tag}</span>
      {c.body} {children}
    </div>
  );
}
