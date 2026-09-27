/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Chainstack HTTPS RPC endpoint (server-proxied in production). Devnet default when unset. */
  readonly VITE_RPC_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
