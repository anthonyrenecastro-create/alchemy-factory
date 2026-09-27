import { useMemo, type ReactNode } from 'react';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { PhantomWalletAdapter, SolflareWalletAdapter } from '@solana/wallet-adapter-wallets';
import '@solana/wallet-adapter-react-ui/styles.css';

/**
 * RPC endpoint for the app. Read from `VITE_RPC_URL` (a Chainstack HTTPS
 * endpoint in real deployments); defaults to the public Solana devnet RPC.
 * NO API keys are ever bundled — credentials stay server-side per ARCHITECTURE.md.
 */
export const RPC_ENDPOINT: string =
  import.meta.env.VITE_RPC_URL && import.meta.env.VITE_RPC_URL.length > 0
    ? import.meta.env.VITE_RPC_URL
    : 'https://api.devnet.solana.com';

export function isDefaultEndpoint(): boolean {
  return RPC_ENDPOINT === 'https://api.devnet.solana.com';
}

export function SolanaWalletProviders({ children }: { children: ReactNode }) {
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], []);
  return (
    <ConnectionProvider endpoint={RPC_ENDPOINT}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
