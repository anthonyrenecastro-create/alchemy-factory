# Chainstack — Solana offering (research)

Research date: **2026-09-27**. All claims below were fetched from the sources
cited; anything the sources did not state is marked as such. Nothing in this
file is a live verification of the Chainstack console — endpoint URLs and
limits come from current public documentation, not from an account we own.

Context for Alchemy Factory: Stage 1 uses Chainstack HTTPS/WSS RPC as a
server-side devnet proxy (see `docs/STAGES.md`); Yellowstone gRPC is only an
*optional Stage 4* mainnet indexing candidate.

---

## 1. Dedicated node HTTPS / WSS RPC endpoints

### URL format (current, from docs examples)

- Mainnet HTTPS: `https://solana-mainnet.core.chainstack.com/YOUR_KEY`
- Mainnet WSS: `wss://solana-mainnet.core.chainstack.com/YOUR_KEY`
- Devnet HTTPS: `https://solana-devnet.core.chainstack.com/YOUR_KEY`
- Devnet WSS: `wss://solana-devnet.core.chainstack.com/YOUR_KEY`

These example formats appear verbatim in current Chainstack materials:
the dev-portal tutorials (`solana-zk-proofs.mdx`, `solana-surfpool.mdx`),
the "Solana node types" guide (crawled 1 day ago), and the Node.js Geyser
tutorial (crawled 19 hours ago). The actual endpoint and key are copied from
the console's node **Access and credentials** tab — the host/key shown above
are placeholders; do not treat them as working endpoints.

Sources:
- https://github.com/chainstack/dev-portal/blob/HEAD/docs/solana-zk-proofs.mdx (accessed 2026-09-27)
- https://github.com/chainstack/dev-portal/blob/HEAD/docs/solana-surfpool.mdx (accessed 2026-09-27)
- https://chainstack.com/solana-node-types/ (accessed 2026-09-27)
- https://docs.chainstack.com/docs/solana-listening-to-programs-using-geyser-and-yellowstone-grpc-node-js (accessed 2026-09-27)

### How credentials are passed

**In the URL path (key-protected endpoints).** The API key is embedded as a
path segment of the endpoint URL (`.../YOUR_KEY`), per all current examples.
Chainstack docs also describe a "Password Protected" variant using basic auth
(`user:password@host`) — that variant is documented for EVM tooling pages
(e.g. `monad-tooling.mdx`, crawled 2 days ago) as "your node HTTPS endpoint
protected either with the key or password"; no Solana-specific page documents
the password variant, so for Solana the key-in-path form is the documented
one.

### WSS note

The HTTPS and WSS endpoints are separate URLs — both must be passed to the
Solana `Connection` constructor explicitly. Docs warn that `@solana/web3.js`
derives a WebSocket URL from the HTTPS host if you only pass the HTTPS
endpoint, which "does not match a Chainstack node's separate WSS endpoint"
and causes `sendAndConfirmTransaction` timeouts.

Source: https://docs.chainstack.com/docs/solana-delegate-sol-staking (accessed 2026-09-27)

### What `sendTransaction` does

`sendTransaction` is forwarded over QUIC to the current and next leaders
with no client configuration required. Trader Nodes (Growth plan and up)
route through bloXroute's staked Trader API for higher landing rates.

Source: https://docs.chainstack.com/reference/solana-getting-started (accessed 2026-09-27)

---

## 2. Yellowstone gRPC Geyser

### Availability

- **Mainnet only.** The API reference's mainnet/devnet feature table lists
  "Yellowstone gRPC Geyser: Yes (paid add-on)" for mainnet and "No" for
  devnet. The throughput guidelines page also states explicitly: "this is only
  true for mainnet" for archive methods, and the plugin docs describe
  installation on a **Solana Global Node** only.
- **Plans:** add-on installable from the **Growth plan and up**
  (Growth, Pro, Business, Enterprise). It is **not** available on the free
  Developer plan — the pricing page shows "Yellowstone Geyser gRPC" crossed
  out for Developer.
- **Node type:** Global Nodes (marketplace + install via console
  **Add-ons → Yellowstone gRPC Geyser Plugin → Install**). The plugin docs
  also discuss Dedicated Nodes with customizable filter limits, and the
  from_slot replay buffer (~100 slots) is documented for Global Nodes.
- **Regions:** no region restriction is published in the plugin docs. Regions
  are named in the throughput guidelines only for RPC per-method overrides
  (`global1` global network; Chainstack Cloud `lon1`, `nyc1`, `fra1`, `lax2`,
  `sgp1`). Docs do not state which regions the Geyser add-on is served from.

Sources:
- https://docs.chainstack.com/docs/yellowstone-grpc-geyser-plugin (accessed 2026-09-27)
- https://docs.chainstack.com/reference/solana-getting-started (accessed 2026-09-27)
- https://chainstack.com/pricing/ (accessed 2026-09-27)

### Pricing (public, current)

Per the official plugin docs page:

| Tier | Price | Concurrent streams / account | Accounts per filter |
|---|---|---|---|
| entry | $49/mo | 2 | up to 200 |
| mid | $149/mo | 7 | up to 200 |
| high | $449/mo | 25 | up to 200 |

"Unlimited stream events" on all tiers. Per-request filter caps on Global
Nodes: 5 `accounts`, 5 `slots`, 20 `transactions`, 10 `transactions_status`,
10 `blocks`, 5 `blocks_meta`, 5 `entries` filters; ≤200 keys per pubkey list;
≤2 `accounts_data_slice` entries; SPL Token Program and Kin excluded from
`getProgramAccounts`-style indexing paths; System Program rejected as
`owner`. `from_slot` replay holds ~100 recent slots (reconnection recovery,
not backfill).

Source: https://docs.chainstack.com/docs/yellowstone-grpc-geyser-plugin (accessed 2026-09-27)

Note: a Chainstack blog tutorial (crawled ~1 hour ago) describes the $49
tier as "2 streams, up to 50 accounts" — the official docs page says
"up to 200 accounts per filter" on all tiers. Treating the docs page as
authoritative; the blog may be stale on the account count. The marketplace
page title reads "From $49/mo for 1 stream" while its own body says
"2 streams per account" — another minor internal inconsistency, flagged
rather than resolved.

Sources:
- https://chainstack.com/how-to-use-the-solana-geyser-plugin-to-stream-data-with-yellowstone-grpc/ (accessed 2026-09-27)
- http://chainstack.com/marketplace/featured/yellowstone-grpc-geyser-plugin/ (accessed 2026-09-27)

### Auth and endpoint form

- The gRPC endpoint is **separate** from the HTTPS/WSS endpoints and appears
  in **Access and credentials → Yellowstone gRPC** after install.
- **The x-token is the same value as the node's auth token** (the API key in
  the endpoint URL path); the token travels in **request metadata, not the
  URL**.
- On Global Nodes the console shows the full endpoint
  `https://yellowstone-solana-mainnet.core.chainstack.com:443`
  (host shown here is the docs' example placeholder, not a live credential).
- Client endpoint form **depends on the client library** (not interchangeable):
  - TypeScript `@triton-one/yellowstone-grpc`, Rust
    `yellowstone-grpc-client`: `https://HOST:443` (scheme required).
  - Python `grpc`, `grpc-go`, `grpcurl`: `HOST:443` (host + port only, no
    scheme).
- Geyser listens on port **443 with TLS**.

Source: https://docs.chainstack.com/docs/yellowstone-grpc-geyser-plugin (accessed 2026-09-27)

---

## 3. Devnet support

- **Devnet Global Nodes are supported** — both full and archive modes are
  listed as "Yes" in the API reference feature table, with WebSocket
  subscriptions. The SPL-token-minting tutorial explicitly says to
  "Start for free — no credit card required" and uses a **Solana devnet node**,
  confirming devnet Global Nodes deploy on the free Developer plan.
- **Devnet rate limits are higher than mainnet's:** Developer plan 25 RPS /
  Growth 250 RPS on devnet vs. 5 RPS / 50 RPS on mainnet (Solana-specific
  override in the throughput guidelines).
- **No public shared devnet endpoint** is documented — access requires
  deploying your own node in a project and copying its endpoints.
- **Docs inconsistency flagged:** the API reference table says devnet
  archive nodes are supported, but the throughput guidelines page says
  "Note that this is only true for mainnet as there are no Solana archive
  nodes for Devnet." Both pages are current; Chainstack docs contradict
  themselves on devnet archive availability. Do not rely on devnet archive
  until verified in-console.
- **Yellowstone gRPC is NOT available on devnet** (mainnet only, §2).
- Dedicated-node marketing historically listed "Mainnet, Devnet, and
  Testnet support" (older page, see §5). Chainstack Self-Hosted also supports
  Solana devnet (8 vCPU, 64 GiB RAM, ~2.2 TB; snapshot bootstrap; endpoints
  on ports 8899/8900).

Sources:
- https://docs.chainstack.com/reference/solana-getting-started (accessed 2026-09-27)
- http://docs.chainstack.com/docs/limits (accessed 2026-09-27)
- http://docs.chainstack.com/docs/solana-mint-spl-tokens (accessed 2026-09-27)
- https://chainstack.com/running-your-own-solana-node/ (accessed 2026-09-27)

---

## 4. Rate limits and plan notes (current, official pricing page)

Prices and quotas verified live on https://chainstack.com/pricing/ on
2026-09-27:

| Plan | Price/mo | Included RU/mo | RPS | Nodes | Archive data | Yellowst. add-on | Dedicated nodes |
|---|---|---|---|---|---|---|---|
| Developer | $0 | 3M | 25 | 1 | ✗ | ✗ | ✗ |
| Growth | $49 | 20M | 250 | 10 | ✓ | ✓ | ✗ |
| Pro | $199 | 80M | 400 | 15 | ✓ | ✓ | ✓ |
| Business | $499 | 200M | 600 | 20 | ✓ | ✓ | ✓ |
| Enterprise | $990+ | 400M+ | unlimited | unlimited | ✓ | ✓ | ✓ |

- Overage: $20 / $15 / $12.5 / $10 / $5 per 1M RU (Developer → Enterprise).
- **Solana-specific RPS overrides** (throughput guidelines, live page):
  mainnet Developer **5 RPS**, Growth **50 RPS**; devnet Developer **25 RPS**,
  Growth **250 RPS**. (So the general plan RPS above does not apply to Solana
  mainnet — plan for 5 RPS on the free tier.)
- **Request units:** 1 RU per full request, 2 RUs per archive request on
  Global Nodes. Dedicated Nodes and the Unlimited Node add-on are not
  metered per request (flat/hourly billing; dedicated compute from
  $0.50/hour).
- **Solana archive billing:** applies only to `getTransaction`, `getBlock`,
  `getBlockTime`, `getBlocks`, `getBlocksWithLimit`, `getSignaturesForAddress`,
  `getFirstAvailableBlock`, `getSignatureStatuses`. A request is archive
  (2 RUs) when its target slot is below `firstAvailable + 5,000`
  (full node ledger capped at 400M shreds, `--limit-ledger-size 400000000`);
  `getSignaturesForAddress` and `getFirstAvailableBlock` are **always**
  archive. All other Solana methods are 1 RU regardless of slot.
- **Full node retention:** roughly 1.5 days of recent state; archive nodes
  retain all historical state.
- **Solana per-method RPS limits (mainnet Global Nodes, live page):**
  `getBlockTime` 500, `getBlock` 400, `getTokenSupply` 500,
  `getMultipleAccounts` 300, `getSupply` 300, `getTokenAccountsByOwner` 150;
  `getLargestAccounts` / `getTokenLargestAccounts` 0 — **Dedicated Nodes
  only**; `getProgramAccounts` tiered by program account count
  (under 10K: 20 RPS with filters / 10 without; ≥1M accounts: 3 per 20 s
  with filters / 2 without; unfiltered Token-2022/SPL-Token/Kin scans
  rejected). Scan methods run under a 60-second execution limit; a scan
  dropped from the queue returns `-32012`.
- **Paid-plan-only methods:** `getProgramAccounts`, `getSupply`,
  `getTokenAccountsByOwner` (+ `getLargestAccounts` on Dedicated Nodes only).
- Unlimited Nodes (flat-fee add-on, Growth+): from $149/mo at 25 RPS tier
  per third-party reporting (dysnix, Sept 2026) — **Chainstack's own pricing
  page does not publish the Unlimited Node RPS tiers/prices; flagged as
  not confirmed from official docs.** Dedicated Solana nodes ~$3,577/mo per
  the same third-party source — also not confirmed officially.

Sources:
- https://chainstack.com/pricing/ (accessed 2026-09-27)
- https://docs.chainstack.com/docs/request-units (accessed 2026-09-27)
- http://docs.chainstack.com/docs/limits (accessed 2026-09-27)

---

## 5. What changed vs older documentation

1. **Endpoint URL format.** Older docs/examples used
   `https://nd-123-456-789.p2pify.com/<key>` (key in path, with a
   password-protected `user:pass@nd-...p2pify.com` variant). Current docs use
   `https://<protocol>-<network>.core.chainstack.com/<key>`
   (e.g. `solana-mainnet.core.chainstack.com`, `solana-devnet.core.chainstack.com`,
   `yellowstone-solana-mainnet.core.chainstack.com`). Any code referencing
   `p2pify.com` hosts must be updated. Evidence of old format: a 2023-era
   docs mirror in a public GitHub repo
   (https://github.com/crystalshay2es/docs/blob/HEAD/docs/operations/bsc/tools.md,
   accessed 2026-09-27).
2. **Billing model.** An older Chainstack Solana marketing page promised
   "every API call to your Solana node is **always billed as 1 request**
   irrespective of the type of request" (no method-specific fees). Current
   model is **Request Units**: 1 RU full / 2 RU archive per request on
   Solana, with Solana-specific archive-eligible method list and slot
   boundary. Source: https://chainstack.com/deploy-solana-nodes-with-unbeatable-pricing/
   (accessed 2026-09-27, page ~3.3 years old).
3. **Yellowstone tiers expanded.** The April 2025 launch announcement listed
   only $149 (7 streams) and $449 (25 streams). A **$49/month entry tier
   (2 streams)** was added later — current marketplace + docs both list
   $49/$149/$449. Source: https://chainstack.com/real-time-solana-streaming-yellowstone-grpc-geyser/
   (accessed 2026-09-27, updated Jun 11, 2026).
4. **Per-method limits changed repeatedly.** A search-indexed snapshot of the
   throughput page (~54 days old) listed `getBlock` 400, `getTokenSupply`
   300, `getTokenAccountsByOwner` 80 (20 in select regions), `getSupply` 2.
   The **live** page now lists `getTokenSupply` 500, `getSupply` 300,
   `getTokenAccountsByOwner` 150, and program-size-tiered
   `getProgramAccounts`. Assume Solana per-method limits are volatile and
   re-check before relying on them.
5. **New products since older docs:** Unlimited Nodes (flat-fee RPS tiers),
   Trader Nodes with Warp transactions (bloXroute routing), and **Chainstack
   Self-Hosted now supports Solana** (mainnet + devnet, Agave v4.2.0,
   16 vCPU/256 GiB/3.5 TB mainnet; 8 vCPU/64 GiB/2.2 TB devnet).
   Source: https://chainstack.com/running-your-own-solana-node/
   (accessed 2026-09-27).
6. **Devnet archive contradiction (§3).** Current docs disagree on whether
   Solana devnet archive nodes exist — flagged, not resolved.

---

## Relevance to Alchemy Factory

- **Stage 1 devnet server-side proxy:** Developer (free) plan gives 3M RU/mo
  at **25 RPS on devnet** — adequate for studio/dev reads; the mainnet
  5 RPS free-tier cap does not apply to devnet.
- **No devnet Geyser:** Yellowstone is mainnet-only, so the Stage 1/2 devnet
  path stays on HTTPS/WSS polling and subscriptions — consistent with the
  stage plan (Geyser is a Stage 4 optional candidate).
- **Auth:** server-side proxy must send the API key as a URL path segment
  (`https://solana-devnet.core.chainstack.com/<key>`); never expose that URL
  client-side. Geyser (Stage 4+) would use the same key as an `x-token` in
  gRPC metadata.
- **Watch:** `getProgramAccounts` is paid-plan-only and heavily rate-limited
  on mainnet — if the studio ever needs program scans, Growth ($49/mo) is the
  minimum, or use `getTokenAccountsByOwner`-style alternatives on devnet.
