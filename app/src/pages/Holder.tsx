import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import { MECHANIC_LABELS } from '@sdk';
import { HonestyBanner } from '../components/HonestyBanner';
import { SAMPLE_TOKENS } from '../data/samples';

/**
 * Holder app — discovery. All listings are SAMPLE data, labeled as such.
 * Import-by-mint validates the base58 address; manually entered mints get an
 * UNVERIFIED badge and are never trusted.
 */
export function Holder() {
  const [mintInput, setMintInput] = useState('');
  const [importResult, setImportResult] = useState<{ mint: string; known: boolean; error?: string } | null>(null);

  const importMint = () => {
    const raw = mintInput.trim();
    if (!raw) return;
    try {
      const pk = new PublicKey(raw); // validates base58 + 32 bytes; throws otherwise
      const known = SAMPLE_TOKENS.some((t) => t.mint === pk.toBase58());
      setImportResult({ mint: pk.toBase58(), known });
    } catch {
      setImportResult({ mint: raw, known: false, error: 'Not a valid Solana address (must be base58, 32 bytes).' });
    }
  };

  return (
    <div className="page">
      <h1>Holder app</h1>
      <p className="lede">Discover tokens, inspect their authorities, collateral, terms, and risks <em>before</em> you sign anything. Simulation-first: no wallet needed to explore.</p>
      <HonestyBanner mode="mixed">
        Listings below are <strong>sample data</strong>, not real tokens. Trade and transfer actions run in simulation unless a wallet is connected on devnet.
      </HonestyBanner>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Import by mint address</h3>
        <div className="row">
          <div className="field" style={{ flex: 1, margin: 0 }}>
            <input className="mono" value={mintInput} onChange={(e) => setMintInput(e.target.value)} placeholder="Base58 mint address" />
          </div>
          <button className="btn primary" onClick={importMint}>Verify &amp; import</button>
        </div>
        {importResult && !importResult.error && (
          <div className="warn info mt">
            <span className="sev">Address valid</span><br />
            <span className="mono small">{importResult.mint}</span><br />
            {importResult.known ? (
              <span><span className="badge verified">Verified sample</span> <span className="small">Matches a known sample token — <Link to={`/holder/${importResult.mint}`}>open detail</Link>.</span></span>
            ) : (
              <span><span className="badge unverified">Unverified</span> <span className="small">Manually entered address. It is syntactically valid but <strong>never trusted</strong>: verify the mint identity and network before interacting.</span></span>
            )}
          </div>
        )}
        {importResult?.error && (
          <div className="warn blocking mt"><span className="sev">Invalid</span><br />{importResult.error}</div>
        )}
      </div>

      <h2 className="section-title">Vault simulator <span className="badge sim">simulation</span></h2>
      <Link to="/vault" style={{ color: 'inherit' }}>
        <div className="card mechanic-card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <strong>🏦 Collateral vault</strong>
            <span className="badge sim">Simulation</span>
          </div>
          <p className="small">Deposit MOCK-GOLD for pro-rata shares, redeem with fees and withdrawal limits, and inspect the proof account — all in the deterministic simulator. No wallet, no chain.</p>
        </div>
      </Link>

      <h2 className="section-title">Discover <span className="badge sample">sample data</span></h2>
      <div className="grid cols-3">
        {SAMPLE_TOKENS.map((t) => (
          <Link key={t.mint} to={`/holder/${t.mint}`} style={{ color: 'inherit' }}>
            <div className="card mechanic-card">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <strong>{t.name} ({t.symbol})</strong>
                <span className="badge sample">Sample</span>
              </div>
              <p className="muted small">{MECHANIC_LABELS[t.mechanic]}</p>
              <p className="small">{t.description}</p>
              <p className="mono small muted">{t.mint.slice(0, 12)}…{t.mint.slice(-6)}</p>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
