# Changelog

All notable changes to Sentinel Plan Manager are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Added — Privy email login (browser)

- **`PRIVY_CLIENT_ID` env var.** Required by `@privy-io/js-sdk-core` in the
  browser. Without it, `auth.email.sendCode` fails origin validation on the
  Privy backend and surfaces as a `NetworkError`. Lives alongside
  `PRIVY_APP_ID` / `PRIVY_APP_SECRET`.
- **`/api/wallet/privy-config` now returns `clientId`.** Browser fetches the
  client ID at runtime and passes it into `new Privy({ appId, clientId,
  storage })`. Documented in `.env.example`.
- **Self-hosted Privy + cosmjs bundles under `public/vendor/`.** Built by
  `scripts/bundle-vendor.mjs` (esbuild, browser target, ESM, minified). Runs
  on `npm install` via the `postinstall` hook and on demand via
  `npm run build:vendor`. Eliminates CDN flakiness, ad-blocker breakage, and
  corporate-proxy failures that previously broke `esm.sh` and `jsdelivr`
  imports.
- **Privy `LocalStorage` wrapper used for SDK storage.** SDK expects its own
  `Storage` interface (`get` / `put` / `del` / `getKeys`) — passing raw
  `window.localStorage` produced "Unable to access storage" errors.
- **Server: `Content-Type: application/javascript` on `.mjs`.** Express static
  middleware sets the MIME header so Firefox / Chrome accept the bundles as
  modules.
- **`@privy-io/js-sdk-core@^0.61.1`** added as a direct dep so the bundler can
  resolve the entry point. `--legacy-peer-deps` required in CI / install due
  to a known viem peer-range conflict between `@privy-io/server-auth` and
  `permissionless` (transitive).

### Added — Add Nodes UX

- **Sortable column headers with visual arrow indicators.** Country, City,
  Protocol, Price/mo, Speed, CPU, RAM all clickable. Inactive columns show a
  dim `⇅`; the active column shows an accent-colored `↑` or `↓` matching the
  current sort direction. Hover transitions opacity + color.
- **Country picker popup.** Opens from "Browse by country" with a searchable
  flag-tile grid; keyboard escape closes; pills filter live as you type.
- **Filter chips bar.** Active filters render as removable chips above the
  list; each `×` clears just that filter via `clearOneFilter(key)`.
- **Reset filters button.** Disabled when no filters are active; one click
  clears search + country + protocol + price-sort + sort-key in one shot.
- **Resource columns.** New `has-resource-cols` grid variant adds CPU / RAM
  columns (centered, tabular-nums) on the Add Nodes list view.

### Added — Dashboard / SPA reliability

- **Render coalescing.** New `coalesceRender(key, fn)` helper drops
  duplicate paint requests during fast nav transitions to stop double-loads
  on Add Nodes and Your Nodes.
- **Page navigation epoch + AbortController.** `_currentNavEpoch` /
  `_pageController` / `_navStillCurrent()` short-circuit in-flight fetches
  when the user navigates away mid-load. SSE connections are tracked in
  `_activeSSE` and torn down in `_closeAllSSE()` on page change to stop the
  Dashboard infinite-loader regression.
- **Partial DOM update path on Add Nodes.** When the chrome is already
  mounted and the plan ID matches, only `addNodesFilters` / `addNodesChips` /
  `addNodesContent` are swapped. Search input focus + caret position are
  preserved across the refresh, eliminating the page-flash on every filter
  click.
- **`refetchMyPlans()` retry helper.** Up to 4 attempts with exponential
  backoff on cold-start chain query failures.

### Added — Server (`server.js`)

- **`pickActiveGrantor(grantee)`.** Selects the active fee-grant payer for a
  given grantee from the plan's grantor pool. Used by paid-flow broadcast
  paths so subscribers don't pay gas.
- **`enrichNodeCacheInBackground(catalog)`.** Two-phase node scan: phase 1
  loads the chain catalog, phase 2 enriches with country / city / speed /
  CPU / RAM in the background. Lets the UI render the address list
  immediately instead of waiting for the full enrichment.
- **`_retry(thunk, opts)` helper.** Exponential backoff for
  unreliable LCD endpoints. Default 3 attempts, 400 ms base, label for log
  context.
- **`/api/all-nodes` country counts on unfiltered requests only.** Front-end
  caches the full tally as `S._countryCountsFull` so the country dropdown /
  picker don't collapse when a country filter is active.

### Added — Chain layer (`lib/chain.js`)

- **`safeBroadcast(msgs, memo, { feeGranter })`.** Optional `feeGranter`
  routes the StdFee through `granter:` so the chain charges a third-party
  account. Without `feeGranter` the path is unchanged (`fee: 'auto'` →
  cosmjs simulate-and-multiply).
- **`_resolveFee()` internal helper.** When `feeGranter` is set: simulate
  gas, apply 1.4× multiplier (matches cosmjs `auto`), build StdFee with
  `granter`. Logs the granter address in the broadcast `[TX]` line.

### Changed

- **Browser `loadPrivyClient()` migrated to `/vendor/privy-sdk.mjs`.**
  Previously imported from `https://esm.sh/@privy-io/js-sdk-core@0.x` →
  failed with "error loading dynamically imported module" on adblocker /
  proxied networks. Now self-hosted.
- **Browser `cosmjs` import migrated to `/vendor/cosmjs-proto-signing.mjs`.**
  Same self-hosting rationale as Privy.
- **`renderAddNodes()` default behavior.** Used to re-mount the entire page
  on every state change (filter click, page change, sort). Now does a partial
  swap when the chrome is the same plan; only re-mounts on plan switch /
  cold load.
- **`safeBroadcast()` signature.** Added optional third `opts` parameter.
  All existing callers continue to work without change (parameter is
  optional).

### Fixed

- **"Unable to access storage" on email send.** Caused by passing
  `window.localStorage` (raw browser API) to `new Privy({ storage })` instead
  of the SDK's own `LocalStorage` wrapper class.
- **"NetworkError when attempting to fetch resource" on email send.** Caused
  by missing `clientId` in `new Privy({ appId, storage })`. Fixed by piping
  `PRIVY_CLIENT_ID` through `/api/wallet/privy-config` to the constructor.
- **Page flash when clicking a filter on Add Nodes.** Caused by full-page
  re-render on every state change. Fixed via partial DOM swap with stable
  container IDs.
- **Search input losing focus mid-type.** Active element / selection range
  preserved across the partial swap.
- **Country dropdown / picker going blank when a country filter is active.**
  Server returns counts for the filtered set only; client now caches the
  full tally and reuses it.
- **Dashboard infinite spinner after fast page nav.** Fixed by the SSE
  teardown + page epoch checks.
- **`postinstall` script blocking on slow networks.** `.npmrc` skips
  unrelated postinstalls; only `bundle-vendor.mjs` runs. Install drops from
  minutes back to ~8 s.

### Security

- **`.env` remains gitignored** (no behavior change, audited).
- **No real secrets in tracked files.** `.env.example` ships empty
  placeholders for `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_CLIENT_ID`.
- **Privy `LocalStorage` is per-origin and per-app.** Tokens are scoped to
  the Privy app ID; logging out clears them.

### Build / tooling

- **`scripts/bundle-vendor.mjs`** — new esbuild driver. Targets
  `@privy-io/js-sdk-core` and `@cosmjs/proto-signing`. Browser target,
  ES2020, ESM, minified, no source maps, no legal comments. Aliases Node
  built-ins (`crypto`, `stream`, `buffer`, `path`, `fs`, `os`) to an empty
  CommonJS shim so cosmjs's `require('crypto')` probe falls back to
  `globalThis.crypto.subtle` cleanly. Produces:
  - `public/vendor/privy-sdk.mjs` (~586 KB)
  - `public/vendor/cosmjs-proto-signing.mjs` (~1.4 MB)
- **`scripts/universal-test.mjs`** — new universal test runner. Reads
  `MNEMONIC` from `.env`; exits non-zero on failure for CI gating.
- **`package.json`**: `build:vendor` and `postinstall` scripts; `esbuild`
  added as devDependency; `@privy-io/js-sdk-core` and
  `@cosmjs/proto-signing` added as direct deps so esbuild can resolve them.
