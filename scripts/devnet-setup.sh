#!/usr/bin/env bash
# Reproducible devnet setup for Alchemy Factory.
# Generates keypairs, funds them from the devnet faucet, and writes a gitignored
# .env with RPC configuration. Chainstack credentials stay in .env (server-side).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"

echo "==> Alchemy Factory devnet setup"

require() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1" >&2; exit 1; }; }
require solana
require solana-keygen

mkdir -p "$ROOT/.keys"

if [ ! -f "$ROOT/.keys/deployer.json" ]; then
  solana-keygen new --no-bip39-passphrase -o "$ROOT/.keys/deployer.json" --silent
  echo "generated deployer keypair"
fi
DEPLOYER="$(solana-keygen pubkey "$ROOT/.keys/deployer.json")"
echo "deployer: $DEPLOYER"

solana config set --url devnet >/dev/null
BAL="$(solana balance "$DEPLOYER" 2>/dev/null | awk '{print $1}')"
if [ "$(printf '%.2f' "$BAL")" = "0.00" ]; then
  echo "requesting devnet airdrop..."
  solana airdrop 2 "$DEPLOYER" || echo "airdrop failed (rate-limited?) — fund $DEPLOYER manually"
fi

if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<EOF
# Alchemy Factory devnet environment — DO NOT COMMIT
SOLANA_CLUSTER=devnet
DEPLOYER_KEYPAIR=$ROOT/.keys/deployer.json
# Chainstack endpoints (server-side only; never ship in the frontend bundle)
# API key is a URL path segment: https://solana-devnet.core.chainstack.com/YOUR_KEY
CHAINSTACK_HTTPS=https://solana-devnet.core.chainstack.com/YOUR_KEY
CHAINSTACK_WSS=wss://solana-devnet.core.chainstack.com/YOUR_KEY
EOF
  echo "wrote $ENV_FILE — fill in your Chainstack endpoint"
else
  echo "$ENV_FILE already exists; leaving untouched"
fi

echo "==> done"
