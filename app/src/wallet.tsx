import { useMemo, type ReactNode } from 'react';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { PhantomWalletAdapter, SolflareWalletAdapter } from '@solana/wallet-adapter-wallets';
import '@solana/wallet-adapter-react-ui/styles.css';
import { useRpcEndpoint } from './rpc';

/**
 * Wallet + connection providers. The RPC endpoint is dynamic: it comes from
 * `useRpcEndpoint()` (localStorage `af_rpc_url`, else VITE_RPC_URL, else the
 * public devnet RPC) and the ConnectionProvider is keyed on it so the
 * connection — and every `useConnection()` consumer — reconnects when the
 * user switches endpoints. NO API keys are bundled; credentials stay
 * server-side per ARCHITECTURE.md.
 */
export function SolanaWalletProviders({ children }: { children: ReactNode }) {
  const { endpoint } = useRpcEndpoint();
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], []);
  return (
    <ConnectionProvider key={endpoint} endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
