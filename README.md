# Sentinel Plan Manager

**The commerce layer for the Sentinel decentralized VPN.**

A full-stack web studio for creating on-chain subscription plans, curating node pools, managing subscribers, and issuing fee grants — turning the raw Sentinel protocol into a revenue-generating bandwidth business anyone can run from a laptop.

Built on [**blue-js-sdk**](https://github.com/Sentinel-Autonomybuilder/blue-js-sdk).

---

## What It Is

Sentinel gives you a tunnel, nodes, and a blockchain ledger. The Plan Manager turns that infrastructure into a **business studio**:

- **Create plans** — one transaction, immutable pricing (Sentinel v3), your choice of duration, data cap, gigabyte prices.
- **Curate node pools** — browse 900+ live nodes, filter by country/protocol, batch-link them to your plan in a single TX. Auto-leases nodes that need activation.
- **Manage subscribers** — see who subscribed, expiry dates, revenue in P2P + USD. Chain is the database.
- **Fund access with fee grants** — pay gas on behalf of subscribers so they never hold gas tokens. Batch-issue (5 per TX), revoke, auto-grant on new subscriptions.
- **Monitor the network** — 39 RPC endpoints health-checked, node rankings by sessions/bandwidth/unique users.

This is not an admin panel. It's a **blockchain business studio** — every feature exists to lower the gap between *"I want to run a bandwidth business"* and *"I am running one."*

See [`MANIFESTO.md`](./MANIFESTO.md) for the full vision.

---

## How Subscription Plans Work

Plan Manager operates Sentinel v3 subscription plans — the chain-native model where an operator creates a plan (duration + data cap + price), links nodes, and subscribers consume bandwidth across those nodes without paying each node per session. Operators can fee-grant subscribers so end users hold zero P2P tokens.

See [PLANS.md](./PLANS.md) for the full breakdown: plan lifecycle, plan-based vs P2P sessions, fee grants, operator economics, and when to use this dashboard vs the SDK.

---

## Who It's For

| You are… | You get… |
|---|---|
| **An entrepreneur** | A working dVPN business in minutes — no paperwork, no telcos, no servers to host. |
| **A developer** | A reference implementation of every plan-related TX on Sentinel v3, with hand-rolled protobuf encoding you can copy. |
| **A provider** | Batch node management, lease orchestration, fee-grant abstraction — the boring work, automated. |
| **An AI agent** | A complete HTTP API (40+ endpoints) to create plans, link nodes, and grant subscribers programmatically. |

---

## Quick Start

> **This tool operates on Sentinel mainnet. Every transaction costs real P2P tokens. There is no testnet mode.**

### Option A — npm (recommended, one-shot)

```bash
npm install -g sentinel-plan-manager
plans --help                                # verify install
echo "MNEMONIC=word1 word2 ... word24" > .env
npx sentinel-plan-manager                   # or: node $(npm root -g)/sentinel-plan-manager/server.js
```

### Option B — git clone (for contributors)

```bash
git clone https://github.com/Sentinel-Autonomybuilder/sentinel-plan-manager.git
cd sentinel-plan-manager
npm install
cp .env.example .env    # then edit .env and paste your mnemonic
npm start
```

> Windows: `copy .env.example .env`

Open http://localhost:3003.

### Option C — Docker

```bash
# one-liner
docker build -t sentinel-plan-manager .
docker run -d --name plan-manager \
  -p 3003:3003 \
  -e MNEMONIC="word1 word2 ... word24" \
  -v plan-manager-data:/data \
  --restart unless-stopped \
  sentinel-plan-manager

# or with compose (includes named volume + auto-restart)
echo "MNEMONIC=word1 word2 ... word24" > .env
docker compose up -d
```

State (`.wallet.json`, `my-plans.json`, `nodes-cache.json`) lives in the `/data` volume so it survives container recreations. Leave `MNEMONIC` unset to create a wallet from the UI on first boot instead.

**Port in use?** `PORT=4000 npm start` — the server honours the `PORT` env var (default 3003).

**Windows:** `start.bat` auto-elevates to Administrator, kills anything on :3003, and launches the server.

### Requirements
- **Node.js 20+**
- **A Cosmos wallet** — generate with Keplr/Leap browser extension, or any Cosmos SDK key tool. The mnemonic goes into `.env` as `MNEMONIC=...`.
- **P2P (udvpn) tokens on the Sentinel mainnet** — acquire via:
  - [Osmosis DEX](https://app.osmosis.zone) (swap any IBC asset for DVPN, then IBC-transfer to `sentinelhub-2`)
  - Any Cosmos IBC bridge supporting Sentinel
- **Minimum balance for full setup: ~5–10 P2P**, broken down:

| Operation | Approximate P2P cost |
|---|---|
| Register as provider (one-time) | ~0.5 |
| Create a plan | ~0.5 |
| Link one node (includes auto-lease deposit) | ~1–2 |
| Batch-link 5 nodes | ~5–8 |
| Issue one fee grant | ~0.1 |
| Revoke one fee grant | ~0.1 |
| Start a plan session (usually operator-funded) | ~0.2 |

A fresh operator registering, creating one plan, and linking 5 nodes should budget **~8 P2P** to be safe.

`blue-js-sdk` is pulled in via `npm install` — no sibling checkout needed.

### First Run — 0 to Live Plan in 6 Steps

After `npm start`, open http://localhost:3003 and go in order:

1. **Wallet tab** — paste mnemonic (or set `MNEMONIC=` in `.env` before start). Confirm balance shows ≥ 5 P2P.
2. **Provider tab** — click **Register Provider**. One-time. Creates your `sentprov1...` on-chain. ~0.5 P2P.
3. **Plans tab** — click **Create Plan**. Set GB, days, and price per GB. Pricing is immutable (v3). ~0.5 P2P.
4. **Plans tab** — set plan status to `active` (1). Subscribers can't join an inactive plan.
5. **Nodes tab** — filter by country/protocol, select nodes, click **Batch Link to Plan**. Auto-leases any node that needs it. ~1–2 P2P per node.
6. **Fee Grants tab** — once subscribers exist, click **Grant All Subscribers**. Batches 5 per TX so end users pay zero gas.

CLI equivalent:

```bash
plans wallet info
plans provider register
plans plan create --gb 10 --days 30 --price-udvpn 500000
plans plan status <id> 1
plans batch-link <id> sentnode1abc...,sentnode1def...
plans feegrant grant-subscribers <id> --spend-limit-dvpn 10 --expiration-days 30
```

### About npm audit warnings
`npm install` will report 7 low-severity warnings — all from `elliptic` (GHSA-848j-6mx2-7j84), a timing side-channel in ECDSA that has no upstream fix and affects every Cosmos SDK JS client. The criticals (`protobufjs`, `@confio/ics23`) are already pinned to fixed versions via `package.json` `overrides`. Don't run `npm audit fix --force` — it will break the build by downgrading `blue-js-sdk`'s locked cosmjs versions.

### About `.npmrc` (ignore-scripts)
This project ships a `.npmrc` with `ignore-scripts=true`. That's intentional: `blue-js-sdk`'s postinstall downloads V2Ray binaries and (on macOS) tries to run `brew install wireguard-tools` — neither is needed here, and on slow/throttled networks it can make `npm install` hang for minutes. Skipping scripts drops install time from minutes to ~8 s. If you later add a dependency whose postinstall is actually required, remove the flag or run the specific script manually.

---

## CLI

The Plan Manager includes a command-line interface (`cli.js`) that exposes every server endpoint as a subcommand. It is a thin HTTP client — it talks to a running server and requires no extra dependencies beyond Node 20+. AI agents can drive the full plan lifecycle (create plans, link nodes, issue fee grants, query state) from a shell or subprocess without touching the web UI.

### Install

```bash
# Development (symlinks cli.js into your PATH):
npm link

# Global install:
npm install -g .

# Without installing — use npm script:
npm run cli -- <args>

# Windows (no install needed):
plans.cmd <args>
```

### Common commands

```bash
# Server health
plans health

# Wallet
plans wallet info
plans wallet import "word1 word2 ... word12"
plans wallet logout

# Plans
plans plan list
plans plan mine
plans plan get 42
plans plan create --gb 10 --days 30 --price-udvpn 500000
plans plan status 42 1          # 1=active, 3=inactive (2 is chain-set only, never pass it)
plans plan subscribers 42

# Nodes
plans node list --country US --protocol wireguard
plans node list --limit 100 --page 2
plans node progress
plans node rankings

# Linking nodes to a plan
plans link 42 sentnode1abc...
plans batch-link 42 sentnode1abc...,sentnode1def...

# Fee grants
plans feegrant list
plans feegrant grant-subscribers 42 --spend-limit-dvpn 10 --expiration-days 30
plans feegrant revoke-all

# Health checks
plans rpc-health
plans rpc-providers
```

### AI agent usage

Pass `--json` to any command to receive raw JSON on stdout (all errors go to stderr). Exit codes: 0 success, 1 client error, 2 server error, 3 server unreachable.

```bash
plans plan list --json
plans feegrant gas-costs 42 --json
plans status --json
```

Use `--base-url http://host:port` to target a remote server.

For every command and flag, run `plans <group> --help`.

---

## Built On blue-js-sdk

This project is a **consumer app** of [**blue-js-sdk**](https://github.com/Sentinel-Autonomybuilder/blue-js-sdk). It is not a fork — it imports SDK modules directly to handle node discovery, disk caching, chain RPC, error taxonomy, and price lookups.

### Modules Imported

| SDK Export | Used For |
|---|---|
| `listNodes`, `registerCleanupHandlers`, `disconnect` | Full mainnet node scan (concurrency 30, ~900+ nodes) and graceful shutdown. |
| `cached`, `cacheInvalidate`, `cacheClear` | Stale-while-revalidate caching for node scans, subscriptions, fee-grant lookups. |
| `ErrorCodes`, `isRetryable`, `userMessage` | Typed error codes surfaced to the UI with human-readable messages. |
| `getDvpnPrice` | Live P2P → USD pricing from CoinGecko. |
| `createRpcQueryClient`, `rpcQueryNode`, `rpcQueryNodes`, `rpcQueryNodesForPlan` | Direct protobuf node queries (**~912× faster** than LCD for single-node lookups). |

All imported from the top-level `blue-js-sdk` package entry.

Everything outside those imports — plan creation, node linking, lease mechanics, fee-grant batching, the full HTTP API, the SPA frontend — is built on top in this repo.

### SDK Dependency

The SDK is installed from npm as `blue-js-sdk` — `npm install` pulls it automatically, no sibling checkout required.

```
your-workspace/
└── plans/                 ← this repo (blue-js-sdk lives in node_modules)
```

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  index.html (vanilla JS SPA, ~3600 lines)                    │
│  dark/light theme · grid+list views · batch pickers          │
└──────────────────────────────┬───────────────────────────────┘
                               │ fetch
┌──────────────────────────────▼───────────────────────────────┐
│  server.js (Express, ~2300 lines)                            │
│  ├── /api/wallet/*        import · logout · status           │
│  ├── /api/plans/*         create · list · status · subs      │
│  ├── /api/plan-manager/*  (batch) link · unlink              │
│  ├── /api/lease/*         start · end                        │
│  ├── /api/provider/*      register · status                  │
│  ├── /api/feegrant/*      grant · revoke · gas-costs · auto  │
│  ├── /api/nodes/*         all-nodes · progress · sessions    │
│  ├── /api/rpcs            39-endpoint health check           │
│  └── /api/node-rankings   session/bandwidth/UU leaderboards  │
└──────────────────────────────┬───────────────────────────────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        │                      │                      │
┌───────▼────────┐   ┌─────────▼────────┐   ┌─────────▼────────┐
│  blue-js-sdk   │   │  lib/ (local)    │   │ CosmJS + protos  │
│  · listNodes   │   │  · protobuf.js   │   │  · stargate      │
│  · disk-cache  │   │  · chain.js      │   │  · proto-signing │
│  · errors      │   │  · wallet.js     │   │                  │
│  · chain/rpc   │   │  · cache/errors  │   │                  │
└────────────────┘   └──────────────────┘   └──────────────────┘
```

### Key Files

| File | Role |
|---|---|
| `server.js` | Express backend — LCD/RPC queries, TX broadcast, batch operations, analytics. |
| `index.html` | Single-page app — dark/light theme, grid/list, batch pickers, plan switcher. |
| `lib/protobuf.js` | Hand-rolled v3 protobuf encoding (plan, link, lease, fee grants). |
| `lib/chain.js` | LCD/RPC wrappers, signing client lifecycle, broadcast with sequence retry. |
| `lib/wallet.js` | Mnemonic → signer, sentprov address derivation, `.wallet.json` persistence. |
| `lib/constants.js` | Port, endpoints, cache TTLs. |
| `lib/cache.js`, `lib/errors.js` | Local wrappers around SDK primitives. |
| `my-plans.json` | Plan IDs you've created (append-only, gitignored). |
| `nodes-cache.json` | Last node scan (5-minute TTL, gitignored). |

---

## On-Chain Operations

All transactions are Sentinel v3 unless noted.

| Operation | Message | Notes |
|---|---|---|
| Register as provider | `MsgRegisterProviderRequest` | One-time, same key as wallet. |
| Create plan | `MsgCreatePlanRequest` | **Immutable pricing** — create a new plan to change price. |
| Start node lease | `MsgStartLeaseRequest` | Auto-issued before link if needed. |
| Link nodes to plan | `MsgLinkNodeRequest` | **Batched** — single TX for all selected nodes. |
| Unlink nodes | `MsgUnlinkNodeRequest` | Batched. |
| Update plan status | `MsgUpdatePlanStatusRequest` | Activate / deactivate. |
| Subscribe | `MsgStartSubscriptionRequest` | Consumer-side; also used in-app for testing. |
| Start session | `MsgStartSessionRequest` | Plan-based session with handshake. |
| Grant fee allowance | `MsgGrantAllowance` (Cosmos) | **Batched 5 per TX** (gas limit). |
| Revoke allowance | `MsgRevokeAllowance` (Cosmos) | Batched. |

### Critical Sequencing

- **Lease-before-link** — if a node has no active lease, `/api/plan-manager/link` auto-issues the lease TX first.
- **Sequence retry** — 5 attempts, exponential backoff (2s → 6s max), signing client refresh between attempts. Handles mempool lag.
- **Fee grant batch ceiling** — 5 grants per TX to stay under gas limits.

### LCD & RPC

| Query | Endpoint |
|---|---|
| Active nodes (paginated) | `/sentinel/node/v3/nodes?status=1` |
| Plan nodes | `/sentinel/node/v3/plans/{id}/nodes` |
| Plan subscribers | `/sentinel/subscription/v3/plans/{id}/subscriptions` |
| Plan details | `/sentinel/subscription/v3/plans/{id}` |
| Provider | `/sentinel/provider/v2/providers/{sentprov1...}` *(still v2)* |
| Fee grants issued | `/cosmos/feegrant/v1beta1/issued/{sent1...}` |
| Balance | `/cosmos/bank/v1beta1/balances/{sent1...}` |

**LCD failover** (4 endpoints, tried in order): `lcd.sentinel.co` → `api.sentinel.quokkastake.io` → `sentinel-api.polkachu.com` → `sentinel.api.trivium.network:1317`.

**RPC protobuf queries** are used for single-node lookups — ~912× faster than the equivalent LCD path.

---

## HTTP API

The backend exposes 40+ endpoints. A few of the most useful:

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/wallet/import` | Import a mnemonic into the session. |
| GET  | `/api/wallet` | Wallet summary — address, balance, provider status. |
| POST | `/api/plan/create` | Create a new plan (price, duration, GB). |
| GET  | `/api/plans/:id/subscriptions` | Paginated subscribers for a plan. |
| POST | `/api/plan-manager/batch-link` | Link many nodes to a plan in one TX. |
| POST | `/api/plan-manager/batch-unlink` | Unlink many nodes in one TX. |
| POST | `/api/feegrant/grant-subscribers` | Auto-issue fee grants to all current subscribers (batched). |
| GET  | `/api/feegrant/grant-subscribers-stream` | Server-Sent Events progress for the above. |
| POST | `/api/feegrant/revoke-all` | Revoke every outstanding grant. |
| GET  | `/api/node-rankings` | Leaderboard by sessions / bandwidth / unique users. |
| GET  | `/api/rpcs` | 39-endpoint RPC health check. |

Full list: run the server and `GET /health` for status, then grep `server.js` for `app.get\|app.post`.

---

## Configuration

### Environment (`.env`)

```ini
MNEMONIC=your twelve or twenty four word mnemonic here
PORT=3003                    # optional, defaults to 3003
```

The mnemonic stays in memory only; `.wallet.json` persists the address for UI reconnect after restart.

### Token Display
- Chain denom: **`udvpn`**
- Display: **P2P** (1 P2P = 1,000,000 udvpn)

---

## Known Constraints

- **Plan pricing is immutable** in Sentinel v3 — create a new plan to change pricing.
- **Session filtering** is computed in-memory (no per-node session endpoint on chain).
- **LCD fee-grant endpoint is slow** (~15–17s from Node.js). Default timeout is 30s with 4-endpoint failover. Do not lower it.
- **Node scan concurrency is 30** — can saturate connection pools; fee-grant operations use a 60s timeout to compensate.
- **Provider LCD path is still v2** (`/sentinel/provider/v2/...`) — everything else is v3.

---

## Troubleshooting — Errors You'll Hit in Order

| Chain error | What it means | Fix |
|---|---|---|
| `insufficient funds` | Wallet has < gas cost | Send more P2P to the wallet address. See Requirements table for minimums. |
| `status must be one of [active, inactive]` | You passed `status=2` to `plan status` | Use `1` (active) or `3` (inactive). Never `2` — that's chain-managed only. |
| `fee allowance already exists` | Grantee already has an active grant | Call `feegrant revoke <grantee>` first, then re-grant. Or skip — grant still works. |
| `lease already exists for node` | Node is already leased by your provider | Use `lease list` to find it, or skip the lease TX (link will reuse it). |
| `account sequence mismatch` | Two concurrent TXs from same wallet | Built-in sequence retry handles this (5 attempts, exponential backoff). If it still fails, wait 30s and retry manually. |
| `rpcQueryFeeGrantsIssued` returns `[]` | Blue JS SDK bug against Sentinel RPC | Server auto-falls back to LCD. No user action needed. |

---

## Development

```bash
npm start           # start server on :3003
node server.js      # same, without npm
```

### Code Style
- ES Modules only (`import`/`export`)
- Single quotes, semicolons, 2-space indent, LF line endings
- `camelCase` vars, `UPPER_SNAKE` constants, `kebab-case` files
- Typed error classes with `.code`
- Section markers: `// ─── Section Name ───`

---

## Security

- **Never commit `.env`, `.wallet.json`, or `nodes-cache.json`** — they're gitignored.
- Mnemonics are session-scoped; they never touch disk.
- `.wallet.json` stores the **address only** for UI reconnect.
- All broadcasts go through `safeBroadcast` with sequence retry and error normalization.

---

## License & Attribution

- **This project:** MIT — see [LICENSE](./LICENSE).
- **blue-js-sdk:** MIT — https://github.com/Sentinel-Autonomybuilder/blue-js-sdk
- **Sentinel chain:** independent, permissionless — not operated or endorsed by this project.

> *"A protocol without commerce is a library. A protocol with commerce is an economy."* — [MANIFESTO.md](./MANIFESTO.md)
