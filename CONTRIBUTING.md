# Contributing

Thanks for poking at Plan Manager. This file is short on purpose — read it once, then read the code.

## Setup

```bash
git clone https://github.com/Sentinel-Bluebuilder/sentinel-plan-manager.git
cd sentinel-plan-manager
npm install
npm run doctor          # confirms Node 20+, RPC reachability, port 3003 free
npm run demo            # boots read-only on a curated mainnet operator
```

To work against your own wallet instead: `cp .env.example .env`, paste a mnemonic into `MNEMONIC=`, then `npm start`.

## Architecture

- `server.js` — Express backend (~3800 lines). RPC-first via `blue-js-sdk`, LCD fallback. AsyncLocalStorage per-request session model so the server holds no module-level keys.
- `public/index.html` — Vanilla JS SPA. Dark/light theme, no framework.
- `lib/` — chain helpers, session crypto, constants, errors, wallet accessors.
- `cli.js` — same TX paths, terminal-driven.

## Rules of the road

- **RPC-first.** Sentinel LCD plan endpoints return `Not Implemented`. New chain reads must use RPC (`rpcQueryPlan`, `rpcQueryNodesForPlan`, etc.); LCD only as fallback when RPC has no equivalent.
- **No secrets in commits.** `.env`, `.wallet.json`, `privy-wallets.json`, and runtime caches are all in `.gitignore`. Don't bypass.
- **Audit script must stay green.** `node scripts/audit-buttons.mjs` checks every button in `index.html` is wired to a real handler and a real route. Run it before opening a PR.
- **Plan pricing is immutable in Sentinel v3** — don't add a "change price" UI. Create a new plan instead.
- **Mobile is intentionally gated.** Don't make the operator UX responsive — the gate exists because real operator workflows assume desktop.

## Submitting

1. Branch from `master`.
2. Keep diffs small — one feature or fix per PR.
3. Update `PLANS.md` if you add a chain interaction.
4. PR against `Sentinel-Bluebuilder/sentinel-plan-manager`.

If you hit an SDK gap (missing query, type registration miss, etc.), open the SDK PR against `Sentinel-Bluebuilder/blue-js-sdk` and link it from the Plan Manager PR.
