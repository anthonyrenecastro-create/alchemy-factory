import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';

/**
 * Live RPC wiring for Alchemy Factory.
 *
 * The endpoint is user-configurable and persisted in localStorage under
 * `af_rpc_url`. It defaults to `VITE_RPC_URL` (a Chainstack HTTPS endpoint in
 * real deployments) and falls back to the public Solana devnet RPC.
 *
 * NO API keys are ever bundled or committed — the paste box below holds the
 * user's own endpoint, which lives only in their browser's localStorage.
 */

const STORAGE_KEY = 'af_rpc_url';
const FALLBACK = 'https://api.devnet.solana.com';

export function defaultEndpoint(): string {
  const env = import.meta.env.VITE_RPC_URL;
  return typeof env === 'string' && env.length > 0 ? env : FALLBACK;
}

interface RpcState {
  endpoint: string;
  setEndpoint: (url: string) => void;
  resetEndpoint: () => void;
  isChainstack: boolean;
  isDefault: boolean;
}

const RpcContext = createContext<RpcState | null>(null);

function readStored(): string | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export function RpcProvider({ children }: { children: ReactNode }) {
  const [endpoint, setEndpointState] = useState<string>(() => readStored() ?? defaultEndpoint());

  const setEndpoint = useCallback((url: string) => {
    const trimmed = url.trim();
    if (!trimmed) return;
    try {
      localStorage.setItem(STORAGE_KEY, trimmed);
    } catch {
      /* storage unavailable — keep it in memory only */
    }
    setEndpointState(trimmed);
  }, []);

  const resetEndpoint = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    setEndpointState(defaultEndpoint());
  }, []);

  const value = useMemo<RpcState>(
    () => ({
      endpoint,
      setEndpoint,
      resetEndpoint,
      isChainstack: endpoint.toLowerCase().includes('chainstack'),
      isDefault: endpoint === FALLBACK,
    }),
    [endpoint, setEndpoint, resetEndpoint],
  );

  return <RpcContext.Provider value={value}>{children}</RpcContext.Provider>;
}

export function useRpcEndpoint(): RpcState {
  const ctx = useContext(RpcContext);
  if (!ctx) throw new Error('useRpcEndpoint must be used inside <RpcProvider>');
  return ctx;
}

/** Short human label for an endpoint: "Chainstack" or the bare hostname. */
export function endpointLabel(url: string): string {
  if (url.toLowerCase().includes('chainstack')) return 'Chainstack';
  try {
    return new URL(url).hostname;
  } catch {
    return url.length > 28 ? `${url.slice(0, 28)}…` : url;
  }
}

// ---------------------------------------------------------------------------
// Live chain status: getSlot() every 30s with latency + health color.
// ---------------------------------------------------------------------------

export type SlotHealth = 'unknown' | 'ok' | 'slow' | 'down';

export interface SlotStatus {
  health: SlotHealth;
  latencyMs: number | null;
  slot: number | null;
  error: string | null;
  checkedAt: number | null;
}

const POLL_MS = 30_000;

export function useSlotStatus(): SlotStatus {
  const { connection } = useConnection();
  const [status, setStatus] = useState<SlotStatus>({
    health: 'unknown',
    latencyMs: null,
    slot: null,
    error: null,
    checkedAt: null,
  });
  const timer = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      const t0 = performance.now();
      try {
        const slot = await connection.getSlot('processed');
        if (cancelled) return;
        const latencyMs = Math.round(performance.now() - t0);
        setStatus({
          health: latencyMs < 1500 ? 'ok' : latencyMs < 4000 ? 'slow' : 'down',
          latencyMs,
          slot,
          error: null,
          checkedAt: Date.now(),
        });
      } catch (e) {
        if (cancelled) return;
        setStatus({
          health: 'down',
          latencyMs: null,
          slot: null,
          error: (e as Error).message,
          checkedAt: Date.now(),
        });
      }
    };

    void poll();
    timer.current = window.setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      if (timer.current !== null) window.clearInterval(timer.current);
    };
  }, [connection]);

  return status;
}
