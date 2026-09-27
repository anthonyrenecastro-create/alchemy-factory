import { useState } from 'react';
import { endpointLabel, useRpcEndpoint, useSlotStatus } from '../rpc';

/**
 * Live RPC status in the nav: health dot (getSlot every 30s, latency in ms),
 * endpoint label ("Chainstack" or hostname), and a small settings popover to
 * paste a Chainstack endpoint URL or reset to the default.
 */
export function RpcStatus() {
  const { endpoint, setEndpoint, resetEndpoint, isDefault } = useRpcEndpoint();
  const status = useSlotStatus();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(endpoint);

  const dotClass =
    status.health === 'ok' ? 'ok' : status.health === 'slow' ? 'slow' : status.health === 'down' ? 'down' : 'unknown';

  const tooltip =
    status.health === 'unknown'
      ? `Checking ${endpoint}…`
      : status.error
        ? `RPC error: ${status.error}`
        : `slot ${status.slot} · ${status.latencyMs}ms · ${endpoint}`;

  const save = () => {
    const v = draft.trim();
    if (!v) return;
    try {
      // Validate it parses as a URL before accepting.
      new URL(v);
    } catch {
      return;
    }
    setEndpoint(v);
    setOpen(false);
  };

  return (
    <span className="rpc-settings">
      <span
        className="rpc-badge mono"
        title={tooltip}
        style={{ cursor: 'pointer' }}
        onClick={() => {
          setDraft(endpoint);
          setOpen((o) => !o);
        }}
      >
        <span className={`rpc-dot ${dotClass}`} />
        {status.health === 'ok' && status.latencyMs !== null ? `${status.latencyMs}ms` : status.health === 'down' ? 'offline' : '…'}
        <span style={{ opacity: 0.7 }}>·</span>
        {endpointLabel(endpoint)}
      </span>
      {open && (
        <div className="rpc-pop" onClick={(e) => e.stopPropagation()}>
          <div className="field" style={{ marginBottom: '0.6rem' }}>
            <label>RPC endpoint (devnet)</label>
            <input
              className="mono"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="https://…chainstack…"
              spellCheck={false}
            />
            <span className="hint">
              Paste your own Chainstack HTTPS endpoint. It is stored only in this browser's localStorage —
              never bundled, never committed.
            </span>
          </div>
          <div className="row">
            <button className="btn primary" onClick={save}>Use endpoint</button>
            <button
              className="btn ghost"
              disabled={isDefault}
              onClick={() => {
                resetEndpoint();
                setDraft('');
                setOpen(false);
              }}
            >
              Reset to default
            </button>
            <button className="btn ghost" onClick={() => setOpen(false)}>Close</button>
          </div>
          {status.error && <p className="small mt" style={{ color: 'var(--danger)' }}>Last error: {status.error}</p>}
        </div>
      )}
    </span>
  );
}
