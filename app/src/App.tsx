import { HashRouter, NavLink, Route, Routes, Navigate } from 'react-router-dom';
import { SolanaWalletProviders } from './wallet';
import { RpcProvider } from './rpc';
import { RpcStatus } from './components/RpcStatus';
import { Studio } from './pages/Studio';
import { Holder } from './pages/Holder';
import { TokenDetail } from './pages/TokenDetail';
import { Jubilee } from './pages/Jubilee';
import { Vault } from './pages/Vault';

function HexMark() {
  return (
    <svg className="hex" width="22" height="24" viewBox="0 0 22 24" fill="none" aria-hidden="true">
      <path d="M11 1 L20 6.5 V17.5 L11 23 L2 17.5 V6.5 Z" stroke="#00e5ff" strokeWidth="1.6" />
      <path d="M11 6 L15.5 8.8 V14.2 L11 17 L6.5 14.2 V8.8 Z" stroke="#00e5ff" strokeWidth="1" opacity="0.55" />
      <circle cx="11" cy="11.5" r="1.4" fill="#00e5ff" />
    </svg>
  );
}

function Home() {
  return (
    <div className="page">
      <h1><span className="alchemy">Alchemy Factory</span></h1>
      <p className="lede">
        A Solana-first creator studio and companion holder app for experimental token mechanics.
        Design in the studio, simulate the economics for free, and inspect any token's authorities,
        collateral, and risks before signing. Devnet-first; mainnet always requires explicit confirmation.
        The studio now includes a live devnet test → deploy pipeline — the bonding-curve mechanic is the first live pilot.
      </p>
      <div className="grid cols-3">
        <NavLink to="/studio" style={{ color: 'inherit' }}>
          <div className="card mechanic-card">
            <div className="icon">🧪</div>
            <h3>Creator studio</h3>
            <p>Pick one of five mechanic families, configure in simple or advanced mode, run a live simulation, see costs and compatibility warnings, and review holder rights before devnet deploy.</p>
          </div>
        </NavLink>
        <NavLink to="/holder" style={{ color: 'inherit' }}>
          <div className="card mechanic-card">
            <div className="icon">👛</div>
            <h3>Holder app</h3>
            <p>Connect a wallet, discover tokens, inspect live authorities, collateral, redemption terms, expiry, fees, and risks — all before any signature.</p>
          </div>
        </NavLink>
        <NavLink to="/jubilee" style={{ color: 'inherit' }}>
          <div className="card mechanic-card">
            <div className="icon">🌕</div>
            <h3>Jubilee simulation</h3>
            <p>Illustrative model: a mock-gold-collateralized token whose redeemable claim decreases 1%/month to a named treasury. Exact arithmetic, holder outcomes, failure cases.</p>
          </div>
        </NavLink>
        <NavLink to="/vault" style={{ color: 'inherit' }}>
          <div className="card mechanic-card">
            <div className="icon">🏦</div>
            <h3>Vault simulator</h3>
            <p>Try the stage-3 collateral vault model: deposit MOCK-GOLD for pro-rata shares, redeem with fees and withdrawal limits, watch the collateral ratio, and inspect what the proof account publishes. Simulation only.</p>
          </div>
        </NavLink>
      </div>
      <div className="card mt">
        <h3 style={{ marginTop: 0 }}>What runs where</h3>
        <ul className="small">
          <li><strong>Simulated:</strong> every number in the studio and the Jubilee page — local deterministic engine, no chain.</li>
          <li><strong>Devnet:</strong> Solana programs per <span className="mono">docs/STAGES.md</span> (Stage 1: registry + bonding curve).</li>
          <li><strong>Not claimed:</strong> production readiness, a guaranteed gold floor, automatic yield, regulatory approval, universal wallet/DEX compatibility.</li>
        </ul>
      </div>
    </div>
  );
}

export function App() {
  return (
    <RpcProvider>
      <SolanaWalletProviders>
        <HashRouter>
        <nav className="nav">
          <span className="brand"><HexMark /><span className="alchemy">ALCHEMY</span> FACTORY</span>
          <NavLink className="navlink" to="/studio">Studio</NavLink>
          <NavLink className="navlink" to="/holder">Holder</NavLink>
          <NavLink className="navlink" to="/vault">Vault</NavLink>
          <NavLink className="navlink" to="/jubilee">Jubilee</NavLink>
          <span className="spacer" />
          <RpcStatus />
        </nav>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/studio" element={<Studio />} />
          <Route path="/holder" element={<Holder />} />
          <Route path="/holder/:mint" element={<TokenDetail />} />
          <Route path="/vault" element={<Vault />} />
          <Route path="/jubilee" element={<Jubilee />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </HashRouter>
      </SolanaWalletProviders>
    </RpcProvider>
  );
}
