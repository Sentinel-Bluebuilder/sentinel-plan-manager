// ─── Plan Manager Server ──────────────────────────────────────────────────────
// Express backend for Sentinel dVPN plan management.
// Modules: lib/constants, lib/errors, lib/protobuf, lib/chain, lib/wallet
// Cache (cached/cacheInvalidate/cacheClear) imported from blue-js-sdk.

import 'dotenv/config';
import { randomBytes as _cryptoRandomBytes } from 'crypto';
import express from 'express';
import QRCode from 'qrcode';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs';
import {
  listNodes,
  fetchAllNodes as sdkFetchAllChainNodes,
  enrichNodes as sdkEnrichNodes,
  nodeStatusV3,
  registerCleanupHandlers,
  disconnect,
  cached,
  cacheInvalidate,
  cacheClear,
  buildFeeGrantMsg,
  buildRevokeFeeGrantMsg,
} from 'blue-js-sdk';

// ─── Module Imports ──────────────────────────────────────────────────────────
import { PORT, LCD_ENDPOINTS, RPC_PROVIDERS, RPC_ENDPOINTS, NODE_CACHE_TTL } from './lib/constants.js';
import * as C from './lib/constants.js';
// Chain error parsing + plan-specific helpers (kept local — SDK's parseChainError lacks plan/lease patterns)
import { parseChainError, isDuplicateNode, txResponse, extractEventId } from './lib/errors.js';
import {
  lcd,
  getDvpnPrice,
  getSigningClient,
  resetSigningClient,
  safeBroadcast,
  getRpcClient,
  rpcQueryNode,
  rpcQueryNodes,
  rpcQueryNodesForPlan,
  rpcQueryLeasesForNode,
  rpcQueryLeasesForProvider,
  rpcQuerySessionsForAccount,
  rpcQuerySubscriptionsForPlan,
  rpcQuerySubscriptionsForAccount,
  rpcQuerySubscriptionAllocations,
  rpcQueryFeeGrants,
  rpcQueryFeeGrantsIssued,
  rpcQueryPlan,
  rpcQueryPlansForProvider,
  rpcQueryProvider,
  rpcQueryBalance,
  KeplrSignRequiredError,
  broadcastSignedTx,
} from './lib/chain.js';
import { getAddr, getProvAddr, requireWallet } from './lib/wallet.js';
import {
  initSession, isMultiUser, encryptMnemonic, decryptMnemonic,
  sessionFromMnemonic, runWithSession, currentSession, parseCookies,
  buildSetCookie, buildClearCookie, COOKIE_NAME, dropSessionFromCache,
  KEPLR_COOKIE_NAME, keplrSessionFromAddress, dropKeplrSessionFromCache,
  buildKeplrToken, parseKeplrToken, buildSetKeplrCookie, buildClearKeplrCookie,
} from './lib/session.js';

registerCleanupHandlers();

const __dirname = dirname(fileURLToPath(import.meta.url));
// DATA_DIR lets deployments (Docker, etc.) redirect state files to a mounted
// volume. Defaults to the project root — unchanged for local installs.
const DATA_DIR = process.env.DATA_DIR || __dirname;
try { mkdirSync(DATA_DIR, { recursive: true }); } catch (err) {
  console.error(`[boot] Cannot create DATA_DIR ${DATA_DIR}:`, err.message);
  process.exit(1);
}
initSession(DATA_DIR);

// ─── planSubs cache invalidation ─────────────────────────────────────────────
// The subscriptions cache is keyed `planSubs:<planId>:<limit>:<cursorKey>` — one
// entry per (limit, cursor) variant. The SDK's cacheInvalidate(key) is an
// EXACT-key delete (no prefix match), so invalidating the bare `planSubs:<id>`
// prefix never removed the real entries and operators saw stale subscriber lists
// for up to the 60s TTL after subscribe/unsubscribe. We track every live planSubs
// key per planId and delete them all on invalidation.
const _planSubsKeys = new Map(); // planId(number) → Set<cacheKey>
function registerPlanSubsKey(planId, cacheKey) {
  const id = Number(planId);
  if (!Number.isFinite(id)) return;
  let set = _planSubsKeys.get(id);
  if (!set) { set = new Set(); _planSubsKeys.set(id, set); }
  set.add(cacheKey);
}
function invalidatePlanSubs(planId) {
  const id = Number(planId);
  if (!Number.isFinite(id)) return;
  const set = _planSubsKeys.get(id);
  if (!set) return;
  for (const key of set) cacheInvalidate(key);
  _planSubsKeys.delete(id);
}

// ─── Demo Mode ────────────────────────────────────────────────────────────────
// Read-only browse: any visitor sees the UI mounted on a watch-only address
// without supplying a mnemonic. Every TX-broadcasting endpoint returns 403.
// Set DEMO_ADDR to any sent1... operator address you want visitors to view.
// Curated default operator: owns mainnet plans 36 & 41 (47 active subs, 731
// linked nodes at time of writing). Override with env DEMO_ADDR for any other
// sent1... address. Picked so `DEMO=true npm start` works zero-config and
// shows a populated dashboard, not an empty operator with nothing to render.
const DEFAULT_DEMO_ADDR = 'sent1t0xjyflrah5n36rfkpfeuw6pz6vl2g27x2793l';
const DEMO_MODE = String(process.env.DEMO || '').toLowerCase() === 'true';
const DEMO_ADDR = (process.env.DEMO_ADDR || '').trim() || (DEMO_MODE ? DEFAULT_DEMO_ADDR : '');
if (DEMO_MODE) {
  if (!DEMO_ADDR || !DEMO_ADDR.startsWith('sent1')) {
    console.error('[demo] DEMO=true requires DEMO_ADDR=sent1... (operator address to display).');
    process.exit(1);
  }
  // Validate bech32 checksum so a typo fails fast at boot instead of crashing
  // on first request (keplrSessionFromAddress throws on invalid checksum).
  try {
    const { fromBech32 } = await import('@cosmjs/encoding');
    const { prefix } = fromBech32(DEMO_ADDR);
    if (prefix !== 'sent') throw new Error(`expected sent prefix, got ${prefix}`);
  } catch (err) {
    console.error(`[demo] DEMO_ADDR is not a valid sentinel address: ${err.message}`);
    process.exit(1);
  }
  console.log(`[demo] Read-only mode enabled — mounted on ${DEMO_ADDR}. Writes return 403.`);
}

// ─── Boot Pre-flight ──────────────────────────────────────────────────────────
// Warn about partial Privy config at boot — the email login card mounts but
// /api/wallet/privy-login returns 503, leaving users stuck staring at "send
// code did nothing" with no clue why. Catch it here, in the startup log,
// where ops actually look.
{
  const privyVars = [
    ['PRIVY_APP_ID', process.env.PRIVY_APP_ID],
    ['PRIVY_APP_SECRET', process.env.PRIVY_APP_SECRET],
    ['PRIVY_CLIENT_ID', process.env.PRIVY_CLIENT_ID],
  ];
  const set = privyVars.filter(([, v]) => v && v.trim());
  if (set.length > 0 && set.length < 3) {
    const missing = privyVars.filter(([, v]) => !v || !v.trim()).map(([k]) => k).join(', ');
    console.warn(`[privy] Partial config: ${set.length}/3 vars set. Missing: ${missing}. Email login will fail until all three are set or all three are empty.`);
  }
}

const app = express();
// Batch link / batch subscribe relay a single signDoc carrying many messages
// (bodyBytes/authInfoBytes base64), so the 32kb cap rejected large batches with
// a PayloadTooLargeError — which, without a JSON error handler, surfaced to the
// browser as an HTML error page ("Unexpected token '<'"). 512kb comfortably
// covers the largest batch signDoc while staying well under any abuse concern.
app.use(express.json({ limit: '512kb' }));
// Suppress fingerprinting header.
app.disable('x-powered-by');
// Trust the loopback proxy so req.secure reflects the X-Forwarded-Proto
// header when an HTTPS-terminating reverse proxy fronts us on localhost.
app.set('trust proxy', 'loopback');

// ─── Security Headers (FIX 4) ─────────────────────────────────────────────────
// TODO: Move to nonce-based CSP to eliminate 'unsafe-inline' for script-src.
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; " +
    "connect-src 'self' https://lcd.sentinel.co https://api.sentinel.quokkastake.io https://sentinel-api.polkachu.com https://sentinel.api.trivium.network:1317 https://auth.privy.io https://*.privy.io https://*.rpc.privy.systems; " +
    "object-src 'none'; " +
    "base-uri 'self'; " +
    "frame-ancestors 'none'"
  );
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// ─── CSRF Protection (FIX 3) ─────────────────────────────────────────────────
// Non-GET requests must be same-origin OR carry an allow-listed Origin OR
// include X-Requested-With (impossible to set on a classic cross-site form).
//
// Same-origin is derived from the Host header so the server keeps working
// regardless of the deploy URL (http://localhost:8000, https://my.domain, a
// reverse proxy, etc.) without needing reconfiguration. For cross-origin
// callers (embeds, third-party dashboards) set ALLOWED_ORIGINS as a
// comma-separated list.
const EXTRA_ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

function isSameOrigin(req) {
  const origin = req.headers['origin'];
  const host = req.headers['host'];
  if (!origin || !host) return false;
  try { return new URL(origin).host === host; } catch { return false; }
}

app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.headers['origin'];
  const xrw = req.headers['x-requested-with'];
  if (isSameOrigin(req)) return next();
  if (origin && EXTRA_ALLOWED_ORIGINS.includes(origin)) return next();
  if (!origin && xrw === 'XMLHttpRequest') return next();
  return res.status(403).json({ error: 'CSRF blocked' });
});

// ─── Static Files (FIX 1) — serves only public/ ──────────────────────────────
app.use(express.static(join(__dirname, 'public'), {
  setHeaders(res, path) {
    // Browsers refuse to evaluate .mjs files unless the MIME type says JS.
    if (path.endsWith('.mjs')) res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  },
}));

// ─── Per-Request Session Middleware ───────────────────────────────────────
// Decrypts the httpOnly session cookie (if present) into a wallet and runs
// the rest of the request chain inside that session's AsyncLocalStorage
// context. Handlers call `getAddr()` / `getSigningClient()` as before;
// those helpers automatically resolve to the per-request wallet.
//
// In DEMO_MODE, every request without a real auth cookie is mounted on the
// configured DEMO_ADDR as a watch-only session (kind: 'demo'). The write
// gate below rejects POST/PUT/DELETE before any TX can be broadcast.
app.use(async (req, res, next) => {
  const cookies = parseCookies(req.headers.cookie);
  const mnemonicToken = cookies[COOKIE_NAME];
  const keplrToken = cookies[KEPLR_COOKIE_NAME];

  if (DEMO_MODE && !mnemonicToken && !keplrToken) {
    const session = keplrSessionFromAddress(DEMO_ADDR, null, 'demo');
    return runWithSession(session, () => next());
  }

  if (mnemonicToken) {
    try {
      const mnemonic = decryptMnemonic(mnemonicToken);
      const session = await sessionFromMnemonic(mnemonic);
      return runWithSession(session, () => next());
    } catch (err) {
      // Cookie decrypt + wallet derivation are pure crypto — no broadcast,
      // no KEPLR_SIGN_REQUIRED can surface here. Just clear the bad cookie.
      console.warn('[session] Rejecting mnemonic cookie:', err.message);
      res.setHeader('Set-Cookie', buildClearCookie({ secure: req.secure }));
      // Fall through to Keplr probe (mnemonic and Keplr can't both be active,
      // but a stale mnemonic cookie shouldn't lock out an otherwise-valid
      // Keplr session).
    }
  }

  if (keplrToken) {
    const parsed = parseKeplrToken(keplrToken);
    if (parsed) {
      // Same cookie shape is reused for Privy logins (server-custody cosmos
      // wallet); look the address up in privy-wallets.json to mark the
      // session kind correctly so the UI can show "Privy (email)" instead of
      // "Keplr extension" and so the right signing path is taken later.
      const kind = lookupPrivyWalletByAddr(parsed.addr) ? 'privy' : 'keplr';
      const session = keplrSessionFromAddress(parsed.addr, parsed.pubkeyB64, kind);
      return runWithSession(session, () => next());
    }
    console.warn('[session] Rejecting Keplr cookie (HMAC mismatch)');
    res.setHeader('Set-Cookie', buildClearKeplrCookie({ secure: req.secure }));
  }

  next();
});

// ─── Demo Write Gate ──────────────────────────────────────────────────────────
// Demo sessions can read but not write. Reject any state-changing method
// (POST/PUT/DELETE/PATCH) with a clear 403 so the UI can surface a banner.
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (currentSession()?.kind !== 'demo') return next();
  return res.status(403).json({ error: 'Demo mode is read-only — clone the repo and set MNEMONIC to make transactions.', demo: true });
});

// ─── Plan ID Persistence ──────────────────────────────────────────────────────
// Keyed by wallet address so multi-user deploys keep each operator's plan
// list separate. Legacy flat-array files (single-user installs) are migrated
// to the per-address map on first read.
const MY_PLANS_FILE = join(DATA_DIR, 'my-plans.json');

function readPlanStore() {
  try {
    if (!existsSync(MY_PLANS_FILE)) return {};
    const parsed = JSON.parse(readFileSync(MY_PLANS_FILE, 'utf8'));
    // Legacy shape: flat array. Stash it under the currently-loaded wallet
    // so nothing is lost; if there's no wallet yet, park it under '_legacy'
    // and the first wallet to load gets a merge.
    if (Array.isArray(parsed)) {
      const owner = getAddr() || '_legacy';
      return { [owner]: parsed.map(Number) };
    }
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    // Helper has no `res` in scope — log and return safe default.
    console.error('Failed to load my-plans.json:', err.message);
    return {};
  }
}

function loadMyPlanIds() {
  const store = readPlanStore();
  const addr = getAddr();
  if (!addr) return [];
  const list = store[addr] || [];
  // Opportunistically absorb any legacy-bucket plans the first time this
  // wallet loads them.
  if (store._legacy && store[addr] !== store._legacy) {
    const merged = Array.from(new Set([...list, ...store._legacy]));
    store[addr] = merged;
    delete store._legacy;
    try { writeFileSync(MY_PLANS_FILE, JSON.stringify(store), 'utf8'); }
    catch (err) { console.error('[my-plans] failed to persist legacy merge:', err.message); }
    return merged;
  }
  return list;
}

function saveMyPlanId(id) {
  const addr = getAddr();
  if (!addr) return;
  const store = readPlanStore();
  const list = store[addr] || [];
  if (!list.includes(Number(id))) {
    list.push(Number(id));
    store[addr] = list;
    // A disk write failure here must not surface as a false 500 to a caller
    // whose TX already succeeded on-chain. Log and continue — the ledger is a
    // convenience cache, not the source of truth (the chain is).
    try {
      writeFileSync(MY_PLANS_FILE, JSON.stringify(store), 'utf8');
    } catch (e) {
      console.warn(`[plans] failed to persist plan ${id} to ${MY_PLANS_FILE}: ${e.message}`);
    }
  }
}

/**
 * Drop plan IDs from the per-wallet `my-plans.json` ledger. Used to evict
 * stale entries left over from a different mnemonic — these would otherwise
 * surface in the UI and produce "address … is not authorized" errors when
 * the user tries to link nodes / change status / etc.
 */
function dropMyPlanIds(ids) {
  const addr = getAddr();
  if (!addr || !ids || ids.length === 0) return;
  const drop = new Set(ids.map(Number));
  const store = readPlanStore();
  const list = (store[addr] || []).filter(id => !drop.has(Number(id)));
  store[addr] = list;
  try { writeFileSync(MY_PLANS_FILE, JSON.stringify(store), 'utf8'); }
  catch (err) { console.error('[my-plans] failed to persist drop:', err.message); }
}

/**
 * RPC-first ownership check for the active wallet's plan list. Returns the
 * subset of `planIds` actually owned by `getProvAddr()` and prunes the rest
 * from `my-plans.json` so the UI never offers them again.
 *
 * Cached for 60s under `myPlansOwned:<provAddr>` to avoid hitting RPC on
 * every dashboard refresh.
 */
/**
 * Pre-flight ownership check for any TX that names a `planId`. RPC-first.
 * Returns null on success, or an Express-friendly `{ status, error }` object
 * to short-circuit the handler. Prevents broadcasting a doomed
 * "address … is not authorized" TX (and burning gas) when the user's
 * `my-plans.json` lists a plan they don't actually own.
 */
async function assertPlanOwnership(planId) {
  if (!planId) return { status: 400, error: 'planId is required' };
  const myProv = getProvAddr();
  if (!myProv) return { status: 401, error: 'Wallet not loaded' };

  // Resolve the plan's prov_address with RPC first, LCD fallback when RPC
  // returns null (the SDK's rpcQueryPlan swallows ALL errors as null —
  // transient blip vs missing plan are indistinguishable, so we MUST verify
  // via LCD before allowing the TX, or doomed "is not authorized" broadcasts
  // sneak through and burn gas).
  let provAddress = null;
  try {
    const client = await getRpcClient();
    if (client) {
      const plan = await rpcQueryPlan(client, planId);
      if (plan?.prov_address) provAddress = plan.prov_address;
    }
  } catch (e) {
    console.warn(`[ownership] RPC ownership probe threw for plan ${planId}: ${e.message}`);
  }

  if (!provAddress) {
    try {
      const lcdPlan = await lcd(`/sentinel/plan/v3/plans/${planId}`);
      if (lcdPlan?.plan?.prov_address) provAddress = lcdPlan.plan.prov_address;
    } catch (e) {
      console.warn(`[ownership] LCD ownership probe failed for plan ${planId}: ${e.message} — allowing TX (chain will validate)`);
      return null;
    }
  }

  if (!provAddress) {
    // Both RPC and LCD failed to return a prov_address. Don't block —
    // could be a brand-new plan or a transient outage. Chain will reject
    // if foreign.
    console.warn(`[ownership] No prov_address resolved for plan ${planId} via RPC or LCD — allowing TX`);
    return null;
  }

  if (provAddress !== myProv) {
    dropMyPlanIds([planId]);
    return {
      status: 403,
      error: `Plan ${planId} is owned by ${provAddress}, not your wallet (${myProv}). It has been removed from your plan list.`,
    };
  }
  return null;
}

async function filterOwnedPlanIds(planIds) {
  if (!planIds || planIds.length === 0) return [];
  const myProv = getProvAddr();
  if (!myProv) return [];
  return cached(`myPlansOwned:${myProv}:${planIds.slice().sort().join(',')}`, 60_000, async () => {
    const client = await getRpcClient();
    if (!client) {
      // No RPC — can't make ownership decisions. Return list as-is, do not
      // prune. Better to show possibly-stale plans than to nuke the list on
      // a transient outage.
      return planIds.map(Number).sort((a, b) => a - b);
    }
    const kept = [];
    const foreign = [];
    await Promise.all(planIds.map(async (id) => {
      // RPC first.
      let provAddress = null;
      try {
        const p = await rpcQueryPlan(client, id);
        if (p?.prov_address) provAddress = p.prov_address;
      } catch (err) {
        console.log(`[ownership] RPC plan(${id}) probe failed: ${err.message} — LCD fallback`);
      }

      // LCD fallback when RPC returned null (could be transient OR foreign).
      if (!provAddress) {
        try {
          const lcdPlan = await lcd(`/sentinel/plan/v3/plans/${id}`);
          if (lcdPlan?.plan?.prov_address) provAddress = lcdPlan.plan.prov_address;
        } catch (err) {
          // Both queries failed — indeterminate, keep optimistically.
          console.log(`[ownership] LCD plan(${id}) probe failed: ${err.message} — keeping optimistically`);
          kept.push(Number(id));
          return;
        }
      }

      if (!provAddress) {
        // Both RPC and LCD couldn't resolve — indeterminate, keep.
        kept.push(Number(id));
        return;
      }
      if (provAddress === myProv) kept.push(Number(id));
      else foreign.push(Number(id));
    }));
    if (foreign.length) {
      console.log(`[ownership] Pruning ${foreign.length} confirmed foreign plan(s) from my-plans.json: ${foreign.join(', ')}`);
      dropMyPlanIds(foreign);
    }
    return kept.sort((a, b) => a - b);
  });
}

// ─── Chain-Side Plan Discovery ────────────────────────────────────────────────
// my-plans.json only learns about plans created through THIS app. Plans the
// wallet created elsewhere (CLI, another Plan Manager install) would be
// invisible after login, so on every /api/my-plans read we also ask the chain
// for ALL plans under our provider address (active + inactive — a wallet can
// manage many) and merge any unknown IDs into the local ledger. Linked nodes
// then flow automatically: getPlanStats resolves them per plan ID via
// rpcQueryNodesForPlan. RPC-first, LCD fallback, and never fatal — on total
// failure the route still serves the local ledger.
async function discoverChainPlans() {
  const myProv = getProvAddr();
  if (!myProv) return [];
  return cached(`planDiscovery:${myProv}`, 60_000, async () => {
    let plans = null;
    try {
      const client = await getRpcClient();
      if (client) plans = await rpcQueryPlansForProvider(client, myProv);
    } catch (e) {
      console.warn(`[discovery] RPC plans-for-provider failed: ${e.message}`);
    }
    if (!plans) {
      try {
        const data = await lcd(`/sentinel/plan/v3/providers/${myProv}/plans?pagination.limit=1000`);
        plans = data.plans || [];
      } catch (e) {
        console.warn(`[discovery] LCD plans-for-provider failed: ${e.message} — using local ledger only`);
        return [];
      }
    }
    const ids = plans.map((p) => Number(p.id)).filter(Number.isFinite);
    const known = new Set(loadMyPlanIds().map(Number));
    const fresh = ids.filter((id) => !known.has(id));
    if (fresh.length) {
      console.log(`[discovery] Found ${fresh.length} on-chain plan(s) not in my-plans.json for ${myProv}: ${fresh.join(', ')}`);
      fresh.forEach(saveMyPlanId);
    }
    return ids;
  });
}

// ─── Privy Cosmos Wallet Persistence ──────────────────────────────────────────
// Maps Privy userId → { walletId, pubkeyB64, sent1Addr } so repeat logins from
// the same email reuse the same Privy server-custody cosmos wallet (and
// therefore the same sent1 address) instead of provisioning a fresh one each
// session. Stored on disk via DATA_DIR; safe to commit no secrets here — the
// privkey lives inside Privy's enclave.
const PRIVY_WALLETS_FILE = join(DATA_DIR, 'privy-wallets.json');

function readPrivyWalletStore() {
  try {
    if (!existsSync(PRIVY_WALLETS_FILE)) return {};
    const parsed = JSON.parse(readFileSync(PRIVY_WALLETS_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    console.error('Failed to load privy-wallets.json:', err.message);
    return {};
  }
}

function lookupPrivyWallet(userId) {
  if (!userId) return null;
  const store = readPrivyWalletStore();
  return store[userId] || null;
}

function lookupPrivyWalletByAddr(sent1Addr) {
  if (!sent1Addr) return null;
  const store = readPrivyWalletStore();
  for (const [userId, entry] of Object.entries(store)) {
    if (entry?.sent1Addr === sent1Addr) return { userId, ...entry };
  }
  return null;
}

function savePrivyWallet(userId, entry) {
  if (!userId || !entry?.walletId) return;
  const store = readPrivyWalletStore();
  store[userId] = entry;
  try { writeFileSync(PRIVY_WALLETS_FILE, JSON.stringify(store), 'utf8'); }
  catch (err) { console.error('Failed to save privy-wallets.json:', err.message); }
}

// ─── Node Cache (SDK scan) ────────────────────────────────────────────────────
const NODE_CACHE_FILE = join(DATA_DIR, 'nodes-cache.json');
let nodeCache = { nodes: [], ts: 0, scanning: false };
let scanProgress = { total: 0, probed: 0, online: 0 };
// Declared here (above runNodeScan) — runNodeScan reads it in its re-entrancy
// guard and the initial scan runs during startup/module-eval, so a `let`
// declaration below runNodeScan would hit the temporal dead zone on boot.
let _enrichInflight = false;

function loadNodeCacheFromDisk() {
  try {
    if (!existsSync(NODE_CACHE_FILE)) return;
    const d = JSON.parse(readFileSync(NODE_CACHE_FILE, 'utf8'));
    if (d.nodes && d.nodes.length) {
      const ageMs = Date.now() - (d.ts || 0);
      // Always seed from disk — even when stale. The startup runNodeScan() below
      // immediately overwrites prices/membership with fresh on-chain truth in its
      // phase-1 `seeded` merge (gigabytePrices/hourlyPrices are re-pulled from
      // chain), and only CARRIES FORWARD the probe-only enrichment (country, city,
      // moniker, serviceType). Discarding stale enrichment left every node with
      // country/city = null for the entire multi-minute phase-2 re-probe window —
      // so the Add Nodes country column and filter dropdown rendered empty after
      // every restart. The `ts` is kept stale on purpose so fetchAllNodes() still
      // treats the seed as past-TTL and triggers a background refresh.
      nodeCache.nodes = d.nodes;
      nodeCache.ts = d.ts || 0;
      if (ageMs < NODE_CACHE_TTL) {
        console.log(`Seeded node cache from disk: ${d.nodes.length} nodes (age ${Math.round(ageMs / 1000)}s, will refresh in background)`);
      } else {
        console.log(`Seeded node cache from disk: ${d.nodes.length} nodes (age ${Math.round(ageMs / 1000)}s > TTL ${NODE_CACHE_TTL / 1000}s — enrichment kept, prices refresh on next scan)`);
      }
    }
  } catch (err) {
    console.error('Failed to load node cache from disk:', err.message);
  }
}

function saveNodeCacheToDisk(nodes) {
  try { writeFileSync(NODE_CACHE_FILE, JSON.stringify({ nodes, ts: Date.now() }), 'utf8'); }
  catch (err) { console.error('Failed to save node cache to disk:', err.message); }
}

loadNodeCacheFromDisk();
// Always kick a fresh scan on startup so the disk seed is replaced with on-chain truth ASAP.
runNodeScan().catch(err => console.error('Initial node scan failed:', err.message));

// Adapter: handles both shapes simultaneously —
//   chain catalog (snake_case: gigabyte_prices, remote_url, no country)
//   probe-enriched (camelCase: gigabytePrices, remoteUrl, country, city, etc.)
function nodeCacheToAllNodes(raw) {
  return raw.map(n => {
    const gbPrices = n.gigabytePrices || n.gigabyte_prices || [];
    const hrPrices = n.hourlyPrices || n.hourly_prices || [];
    const gbPrice = gbPrices.find(p => p.denom === 'udvpn');
    const hrPrice = hrPrices.find(p => p.denom === 'udvpn');
    return {
      address: n.address,
      remoteUrl: n.remoteUrl || n.remote_url || '',
      gbPriceUdvpn: gbPrice ? parseInt(gbPrice.quote_value) : 0,
      hrPriceUdvpn: hrPrice ? parseInt(hrPrice.quote_value) : 0,
      status: 'active',
      protocol: n.serviceType || null,
      country: n.country || n.location?.country || null,
      city: n.city || n.location?.city || null,
      moniker: n.moniker || null,
      speedMbps: null,
      pass15: false,
      pass10: false,
      peers: n.peers ?? null,
    };
  });
}

// Two-phase scan:
//   Phase 1 (fast): chain catalog via fetchAllNodes — every active node on chain.
//                   Cache populated with truth immediately. No probe filtering.
//   Phase 2 (background): probe-enrich for country/city/protocol on top of catalog.
//                   Successful probes overlay enrichment fields; failures keep chain entry.
async function runNodeScan() {
  // Bail if a scan is in progress OR if a prior scan's background enrichment is
  // still running — otherwise the phase-1 `nodeCache = {…}` reassignment below
  // swaps the cache object out from under the in-flight phase-2, whose
  // `nodeCache.nodes = merged` would then clobber this scan's fresh catalog
  // with stale enriched data from the previous run.
  if (nodeCache.scanning || _enrichInflight) return;
  nodeCache.scanning = true;
  scanProgress = { total: 0, probed: 0, online: 0 };
  console.log('Starting node scan: phase 1 (chain catalog)...');
  try {
    // Pull the full chain catalog via RPC directly. SDK's fetchAllNodes()
    // hardcodes limit=500 via fetchActiveNodes default — that's why we were
    // missing half the network. Go straight to rpcQueryNodes with limit=10000.
    const rpc = await getRpcClient();
    if (!rpc) {
      // All RPC endpoints failed. rpcQueryNodes(null, ...) would throw an opaque
      // "Cannot read properties of null" deep in the SDK; surface a clear cause
      // and bail cleanly so the next scan can retry once RPC recovers.
      console.warn('[scan] No RPC client available — skipping node catalog refresh, will retry next scan.');
      nodeCache.scanning = false;
      return;
    }
    const rawNodes = await rpcQueryNodes(rpc, { status: 1, limit: 10000 });
    // Resolve remote URLs and filter to nodes that accept udvpn.
    const catalog = rawNodes
      .map(n => {
        const addrs = n.remote_addrs || [];
        const first = addrs[0];
        n.remote_url = first ? (first.startsWith('http') ? first : `https://${first}`) : null;
        return n;
      })
      .filter(n => n.remote_url && (n.gigabyte_prices || []).some(p => p.denom === 'udvpn'));
    // Preserve prior enrichment (country/city/moniker/serviceType) across catalog
    // refreshes — otherwise the country dropdown empties for the duration of phase 2.
    const priorByAddr = new Map((nodeCache.nodes || []).map(n => [n.address, n]));
    const seeded = catalog.map(n => {
      const prior = priorByAddr.get(n.address);
      if (!prior) return n;
      return {
        ...n,
        gigabytePrices: prior.gigabytePrices || prior.gigabyte_prices,
        hourlyPrices: prior.hourlyPrices || prior.hourly_prices,
        serviceType: prior.serviceType,
        country: prior.country,
        city: prior.city,
        moniker: prior.moniker,
        peers: prior.peers,
      };
    });
    nodeCache = { nodes: seeded, ts: Date.now(), scanning: false };
    saveNodeCacheToDisk(seeded);
    console.log(`Phase 1 complete: ${catalog.length} chain nodes cached (truth, unfiltered).`);

    // Phase 2: best-effort enrichment for country/protocol labels.
    // Runs in background; successful probes are merged into the cache as they complete.
    enrichNodeCacheInBackground(catalog).catch(err => {
      console.error('Phase 2 enrichment failed:', err.message);
    });
  } catch (e) {
    console.error('Node scan failed:', e.message);
    nodeCache.scanning = false;
  }
}

async function enrichNodeCacheInBackground(catalog) {
  if (_enrichInflight) return;
  _enrichInflight = true;
  console.log('Starting node scan: phase 2 (background enrichment)...');
  try {
    const enriched = await sdkEnrichNodes(catalog, {
      concurrency: 30,
      onProgress: (p) => { scanProgress = { total: p.total, probed: p.done, online: p.enriched }; },
    });
    // Merge: chain catalog stays as base; enriched entries overlay country/serviceType/etc.
    const enrichedByAddr = new Map(enriched.map(e => [e.address, e]));
    const merged = catalog.map(n => {
      const e = enrichedByAddr.get(n.address);
      if (!e) return n;
      return {
        ...n,
        gigabytePrices: e.gigabytePrices || n.gigabyte_prices,
        hourlyPrices: e.hourlyPrices || n.hourly_prices,
        serviceType: e.serviceType,
        country: e.country,
        city: e.city,
        moniker: e.moniker,
        peers: e.peers,
      };
    });
    nodeCache.nodes = merged;
    nodeCache.ts = Date.now();
    saveNodeCacheToDisk(merged);
    console.log(`Phase 2 complete: ${enriched.length}/${catalog.length} nodes enriched with country/protocol.`);
  } finally {
    _enrichInflight = false;
  }
}

async function fetchAllNodes() {
  const now = Date.now();
  if (nodeCache.nodes.length > 0 && (now - nodeCache.ts) < NODE_CACHE_TTL) {
    return nodeCacheToAllNodes(nodeCache.nodes);
  }
  if (nodeCache.scanning) {
    return nodeCacheToAllNodes(nodeCache.nodes);
  }
  if (nodeCache.nodes.length > 0) {
    runNodeScan(); // background refresh
    return nodeCacheToAllNodes(nodeCache.nodes);
  }
  await runNodeScan();
  return nodeCacheToAllNodes(nodeCache.nodes);
}

// ─── Plan Helpers ─────────────────────────────────────────────────────────────

async function discoverPlanIds() {
  const ids = new Set();
  // Fetch RPC client once outside the loop — reused for every probe.
  let rpc = null;
  try { rpc = await getRpcClient(); } catch (_) { rpc = null; }
  for (let batch = 0; batch < 10; batch++) {
    const checks = [];
    for (let i = batch * 10 + 1; i <= (batch + 1) * 10; i++) {
      checks.push((async (planId) => {
        // RPC-first: if RPC returns a non-empty array the plan exists.
        // Empty array is ambiguous (truly empty OR not-on-chain) — fall back to LCD count_total.
        if (rpc) {
          try {
            const result = await rpcQuerySubscriptionsForPlan(rpc, planId, { limit: 1 });
            if (result && result.length > 0) { ids.add(planId); return; }
          } catch (err) {
            console.log(`[RPC] discoverPlanIds probe ${planId} failed: ${err.message} — LCD fallback`);
          }
        }
        // LCD fallback — count_total is authoritative for empty-vs-nonexistent distinction.
        await lcd(`/sentinel/subscription/v3/plans/${planId}/subscriptions?pagination.limit=1&pagination.count_total=true`)
          .then(d => {
            const total = parseInt(d.pagination?.total || '0');
            if (total > 0) ids.add(planId);
          })
          .catch((err) => { console.log(`[LCD] discoverPlanIds probe ${planId} failed: ${err.message}`); });
      })(i));
    }
    await Promise.all(checks);
  }
  return [...ids].sort((a, b) => a - b);
}

async function getUniqueWallets(planId) {
  const wallets = new Set();

  // RPC-first: single protobuf call returns the full set (~912x faster than paginated LCD).
  try {
    const rpc = await getRpcClient();
    if (rpc) {
      const subs = await rpcQuerySubscriptionsForPlan(rpc, planId, { limit: 10000 });
      for (const s of subs) wallets.add(s.acc_address);
      return wallets.size;
    }
  } catch (err) {
    console.log(`[RPC] getUniqueWallets(${planId}) failed: ${err.message} — LCD fallback`);
  }

  // LCD fallback
  let nextKey = undefined;
  let pages = 0;
  const MAX_PAGES = 20;
  do {
    const keyParam = nextKey ? `&pagination.key=${encodeURIComponent(nextKey)}` : '';
    const d = await lcd(`/sentinel/subscription/v3/plans/${planId}/subscriptions?pagination.limit=500${keyParam}`);
    for (const s of d.subscriptions || []) {
      wallets.add(s.acc_address);
    }
    nextKey = d.pagination?.next_key || null;
    pages++;
  } while (nextKey && pages < MAX_PAGES);

  return wallets.size;
}

// LCD fallback: fetch ALL subscriptions for a plan, following pagination.
// The single-page `?pagination.limit=500` form silently drops every
// subscriber past position 500 — for fee-grant flows that means those
// subscribers never get their gas covered. Always paginate.
async function lcdAllSubscriptions(planId, timeout) {
  const subs = [];
  let nextKey = undefined;
  let pages = 0;
  const MAX_PAGES = 40; // 40 × 500 = 20k subscribers
  do {
    const keyParam = nextKey ? `&pagination.key=${encodeURIComponent(nextKey)}` : '';
    const url = `/sentinel/subscription/v3/plans/${planId}/subscriptions?pagination.limit=500${keyParam}`;
    const d = timeout != null ? await lcd(url, timeout) : await lcd(url);
    for (const s of d.subscriptions || []) subs.push(s);
    nextKey = d.pagination?.next_key || null;
    pages++;
  } while (nextKey && pages < MAX_PAGES);
  return subs;
}

// Retry a thunk up to `attempts` times with exponential backoff.
// Used by getPlanStats so a transient RPC/LCD blip doesn't silently
// drop a plan from the my-plans response.
async function _retry(thunk, { attempts = 3, baseMs = 400, label = 'op' } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await thunk();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        const wait = baseMs * Math.pow(2, i);
        console.log(`[retry] ${label} attempt ${i + 1}/${attempts} failed (${err.message}); retrying in ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

async function getPlanStats(planId) {
  // Cache only successful results — retry transient failures up to 3x before
  // giving up. Otherwise a single RPC blip caches a null for 2 minutes and
  // the plan disappears from the UI even after the chain recovers.
  // Scope the cache key by operator: the subscriber total excludes the
  // operator's OWN self-subscription and folds in the free-access members they
  // shared — both operator-specific — so a session-less fill must not be served
  // to the authenticated operator (and vice-versa).
  const operator = getAddr() || '_anon';
  const stats = await cached(`planStats:${planId}:${operator}`, 120_000, () =>
    _retry(() => _getPlanStatsImpl(planId), { attempts: 3, baseMs: 500, label: `getPlanStats(${planId})` })
  );
  // If the price came back unknown (plan record couldn't be read and there was
  // no subscriber sample to borrow from), don't let the bad read sit in cache
  // for the full 2 minutes — drop it so the very next request re-queries and
  // self-heals once RPC recovers. The UI shows "—" in the meantime, never "0".
  if (stats?.priceUnknown) cacheInvalidate(`planStats:${planId}:${operator}`);
  return stats;
}

async function _getPlanStatsImpl(planId) {
  // Fetch RPC client once for this call — shared by RPC-first paths below.
  let rpc = null;
  try { rpc = await getRpcClient(); } catch (_) { rpc = null; }

  // Single RPC call replaces two LCD calls (count_total + reverse-paginated 200).
  // Pulls up to 10000 subs in one shot; we derive total + sample from that array.
  // Falls back to LCD only if RPC fails or is unavailable.
  const [subsResult, nodesData, planRecord] = await Promise.all([
    (async () => {
      if (rpc) {
        try {
          const subs = await rpcQuerySubscriptionsForPlan(rpc, planId, { limit: 10000 });
          return { source: 'rpc', subs };
        } catch (err) {
          console.log(`[RPC] _getPlanStatsImpl subs(${planId}) failed: ${err.message} — LCD fallback`);
        }
      }
      // LCD fallback: two calls — count_total + reverse sample.
      const [countD, latestD] = await Promise.all([
        lcd(`/sentinel/subscription/v3/plans/${planId}/subscriptions?pagination.limit=1&pagination.count_total=true`).catch(() => ({})),
        lcd(`/sentinel/subscription/v3/plans/${planId}/subscriptions?pagination.limit=200&pagination.reverse=true`).catch(() => ({})),
      ]);
      return { source: 'lcd', countTotal: parseInt(countD.pagination?.total || '0'), subs: latestD.subscriptions || [] };
    })(),
    (async () => {
      if (rpc) {
        try {
          // status:0 (all members) to match the no-filter LCD fallback below and
          // reflect the true plan size — not just active members.
          const nodes = await rpcQueryNodesForPlan(rpc, planId, { status: 0, limit: 5000 });
          if (nodes) return { nodes };
        } catch (err) {
          console.log(`[RPC] _getPlanStatsImpl nodes(${planId}) failed: ${err.message} — LCD fallback`);
        }
      }
      return lcd(`/sentinel/node/v3/plans/${planId}/nodes?pagination.limit=500`).catch(() => ({ nodes: [] }));
    })(),
    (async () => {
      // The plan record is the ONLY authoritative price source (set immutably at
      // creation). LCD's v3 single-plan endpoint returns "Not Implemented" on
      // every provider, so RPC is effectively the sole path — give it its own
      // retry across the failover pool rather than failing over to a dead LCD.
      // Without this, a single RPC blip on a plan with no sampleable subscribers
      // silently renders the price as 0 (and caches it for 2 minutes).
      if (rpc) {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const p = await rpcQueryPlan(rpc, planId);
            if (p) return p;
          } catch (err) {
            console.log(`[RPC] _getPlanStatsImpl plan(${planId}) attempt ${attempt + 1}/3 failed: ${err.message}`);
          }
          if (attempt < 2) await new Promise(r => setTimeout(r, 400 * Math.pow(2, attempt)));
        }
      }
      try {
        const lp = await lcd(`/sentinel/plan/v3/plans/${planId}`);
        return lp?.plan || null;
      } catch (err) {
        console.log(`[LCD] _getPlanStatsImpl plan(${planId}) fallback failed: ${err.message} — price may render as 0`);
        return null;
      }
    })(),
  ]);

  // Normalize RPC sub fields to match LCD-shaped consumers downstream.
  // RPC: status=1 (int, 1=active), renewal_price_policy=int. LCD: 'active' / 'no'|'yes'.
  const normSubs = (subsResult.subs || []).map(s => ({
    ...s,
    status: typeof s.status === 'number' ? (s.status === 1 ? 'active' : 'inactive') : s.status,
    renewal_price_policy: typeof s.renewal_price_policy === 'number'
      ? (s.renewal_price_policy === 1 ? 'no' : s.renewal_price_policy === 2 ? 'yes' : 'unknown')
      : (s.renewal_price_policy || 'unknown'),
  }));
  // Sort newest-first by start_at to mirror reverse-pagination semantics.
  normSubs.sort((a, b) => new Date(b.start_at || 0) - new Date(a.start_at || 0));

  const totalSubs = subsResult.source === 'rpc' ? normSubs.length : (subsResult.countTotal || 0);
  const totalNodes = (nodesData.nodes || []).length;

  const allSampleSubs = normSubs.slice(0, 200);
  const sampleSubs = allSampleSubs.filter(s => s.acc_address !== getAddr());
  const sampleWallets = new Set(sampleSubs.map(s => s.acc_address));
  const ownSubs = allSampleSubs.length - sampleSubs.length;

  const sample = sampleSubs[0] || allSampleSubs[0];
  const renewalPolicy = sample?.renewal_price_policy || 'unknown';

  // Authoritative price comes from the plan record (set at creation, immutable).
  // Subscription samples are only used as a last-resort fallback when the plan
  // record didn't load — pricing must NOT silently fall back to zero just
  // because the plan has no subscribers yet.
  const planPrices = Array.isArray(planRecord?.prices) ? planRecord.prices : [];
  const planPrice = planPrices[0] || null;
  // If the plan record didn't load AND there's no subscriber sample to borrow a
  // price from, the price is genuinely UNKNOWN — never fabricate a 0, which the
  // UI would render as a real "0 P2P" price (the chain has no zero-priced plans;
  // a 0 here always means "we failed to read it", not "it's free").
  const priceUnknown = !planPrice && !sample?.price;
  const price = planPrice
    ? { denom: planPrice.denom, quote_value: planPrice.quote_value, base_value: planPrice.base_value }
    : (sample?.price || { denom: 'udvpn', quote_value: null, base_value: null });

  const now = new Date();
  let activeSubs = 0;
  let inactiveSubs = 0;
  for (const s of sampleSubs) {
    if (s.status === 'active' && new Date(s.inactive_at) > now) activeSubs++;
    else inactiveSubs++;
  }

  const dates = sampleSubs.map(s => new Date(s.start_at)).sort((a, b) => a - b);
  const earliestStart = dates[0]?.toISOString() || null;
  const latestStart = dates[dates.length - 1]?.toISOString() || null;

  // Duration from the plan record (seconds → days). Fall back to the
  // sample-derived duration only when the plan record didn't load.
  let durationDays = null;
  if (planRecord?.duration != null) {
    const durSec = typeof planRecord.duration === 'string'
      ? parseInt(planRecord.duration)
      : Number(planRecord.duration);
    if (Number.isFinite(durSec) && durSec > 0) {
      durationDays = Math.round(durSec / 86400);
    }
  }
  if (durationDays == null && sample) {
    const start = new Date(sample.start_at);
    const end = new Date(sample.inactive_at);
    durationDays = Math.round((end - start) / (1000 * 60 * 60 * 24));
  }

  // Added (free-access) members: wallets the operator granted bandwidth to via
  // subscribe+share. They live as allocation rows on the operator's OWN
  // subscriptions to this plan (acc_address === operator), so they're invisible
  // to the plan-level subscription count above. Count the distinct non-operator
  // wallets across those allocations and fold them into the subscriber total so
  // the plan card reflects everyone with access, not just direct on-chain subs.
  const operator = getAddr();
  let addedMembers = 0;
  let activeAddedMembers = 0;
  if (rpc && operator) {
    try {
      const ownPlanSubs = normSubs.filter(s => s.acc_address === operator);
      const addedAddrs = new Set();
      const activeAddedAddrs = new Set();
      for (const sub of ownPlanSubs) {
        // A shared member is active only while the host subscription is active.
        const hostActive = sub.status === 'active' && new Date(sub.inactive_at) > now;
        let allocs = [];
        try {
          allocs = await rpcQuerySubscriptionAllocations(rpc, sub.id, { limit: 10000 });
        } catch (e) {
          console.log(`[PlanStats] allocations for sub ${sub.id} failed: ${e.message}`);
        }
        for (const a of allocs) {
          if (a.address && a.address !== operator) {
            addedAddrs.add(a.address);
            if (hostActive) activeAddedAddrs.add(a.address);
          }
        }
      }
      addedMembers = addedAddrs.size;
      activeAddedMembers = activeAddedAddrs.size;
    } catch (e) {
      console.log(`[PlanStats] added-members count for plan ${planId} failed: ${e.message}`);
    }
  }
  const onchainSubsCount = Math.max(0, totalSubs - ownSubs);

  // null quote_value => price unknown (read failed); keep dvpnAmount null so the
  // UI shows "—" instead of a fabricated 0. Only a real on-chain value divides.
  const quoteNum = price.quote_value != null ? parseInt(price.quote_value) : null;
  return {
    planId,
    totalSubscriptions: onchainSubsCount + addedMembers,
    onchainSubscriptions: onchainSubsCount,
    addedMembers,
    totalNodes,
    uniqueWalletsSample: sampleWallets.size,
    priceUnknown,
    price: {
      denom: price.denom,
      quoteValue: price.quote_value,
      baseValue: price.base_value,
      dvpnAmount: (price.denom === 'udvpn' && quoteNum != null) ? (quoteNum / 1e6) : null,
    },
    prices: planPrices.map(p => ({
      denom: p.denom,
      quoteValue: p.quote_value,
      baseValue: p.base_value,
      dvpnAmount: p.denom === 'udvpn' ? (parseInt(p.quote_value || '0') / 1e6) : null,
    })),
    renewalPolicy,
    activeSubs: activeSubs + activeAddedMembers,
    onchainActiveSubs: activeSubs,
    activeAddedMembers,
    inactiveSubs,
    sampleSize: sampleSubs.length,
    durationDays,
    earliestStart,
    latestStart,
    estimatedTotalP2p: (price.denom === 'udvpn' && quoteNum != null) ? (totalSubs * quoteNum / 1e6) : null,
  };
}

// Cached wrapper around the (expensive) plan-nodes query. The impl does an RPC
// QueryNodesForPlan PLUS a per-member rpcQueryLeasesForNode fan-out, so re-running
// it on every Add-Nodes keystroke / filter / post-link refetch was the root of the
// "big delay before added nodes show" symptom. Scope the key by provider because the
// per-node lease lookup picks OUR lease (prov_address === getProvAddr()). Short TTL
// (15s) keeps it fresh; link/unlink success paths invalidate it explicitly so a
// just-added node is reflected on the very next refetch (subject to chain indexing).
function invalidatePlanNodes(planId) {
  const prov = getProvAddr() || '_anon';
  cacheInvalidate(`planNodes:${planId}:${prov}`);
}

async function getNodesForPlan(planId) {
  const prov = getProvAddr() || '_anon';
  return cached(`planNodes:${planId}:${prov}`, 15_000, () => _getNodesForPlanImpl(planId));
}

async function _getNodesForPlanImpl(planId) {
  const nodes = [];

  // RPC-first
  try {
    const rpc = await getRpcClient();
    if (rpc) {
      // status:0 (unspecified) = ALL plan members, not just active ones. The
      // LCD fallback below has no status filter, so this aligns RPC with LCD.
      // Critical for Add Nodes exclusion (excludeInPlan) and Your Nodes: a
      // just-linked or temporarily-inactive member must still count as "in plan"
      // or it reappears in the browse list as if it were never added.
      const rpcNodes = await rpcQueryNodesForPlan(rpc, planId, { status: 0, limit: 5000 });
      for (const n of rpcNodes) {
        const rawAddr = (n.remote_addrs || [])[0] || '';
        nodes.push({
          address: n.address,
          remoteUrl: rawAddr ? (rawAddr.startsWith('http') ? rawAddr : `https://${rawAddr}`) : '',
          gigabytePrices: n.gigabyte_prices,
          hourlyPrices: n.hourly_prices,
          status: n.status === 1 ? 'active' : 'inactive',
          inactiveAt: n.inactive_at || null,
          statusAt: n.status_at || null,
        });
      }
      // Attach the REAL lease expiry. The node's `inactive_at` is the node's own
      // ~1h liveness window, NOT the operator's lease term — using it makes a
      // 1-day lease read as "expiring in 1 hour". The true expiry lives in the
      // sentinel.lease.v1 Lease (start_at + hours). A node can hold leases from
      // several providers; we take OUR lease (prov_address === getProvAddr()),
      // preferring the one expiring last. Per-node query, run in parallel.
      const myProv = getProvAddr();
      await Promise.all(nodes.map(async (node) => {
        try {
          const leases = await rpcQueryLeasesForNode(rpc, node.address);
          const mine = leases
            .filter(l => l.prov_address === myProv && l.expires_at)
            .sort((a, b) => new Date(b.expires_at) - new Date(a.expires_at));
          node.leaseExpiresAt = mine[0]?.expires_at || null;
          node.leaseHours = mine[0]?.hours ?? null;
          node.leaseMaxHours = mine[0]?.max_hours ?? null;
        } catch (e) {
          console.log(`[LEASE] leases-for-node ${node.address} failed: ${e.message}`);
          node.leaseExpiresAt = null;
        }
      }));
      return nodes;
    }
  } catch (err) {
    console.log(`[RPC] getNodesForPlan(${planId}) failed: ${err.message} — LCD fallback`);
  }

  // LCD fallback
  let nextKey = undefined, pages = 0;
  const MAX_PAGES = 100; // 100 × 100 = 10k plan members — guards against an unbounded loop
  do {
    const keyParam = nextKey ? `&pagination.key=${encodeURIComponent(nextKey)}` : '';
    const d = await lcd(`/sentinel/node/v3/plans/${planId}/nodes?pagination.limit=100${keyParam}`);
    for (const n of d.nodes || []) {
      const rawAddr = (n.remote_addrs || [])[0] || '';
      nodes.push({
        address: n.address,
        remoteUrl: rawAddr ? (rawAddr.startsWith('http') ? rawAddr : `https://${rawAddr}`) : '',
        gigabytePrices: n.gigabyte_prices,
        hourlyPrices: n.hourly_prices,
        status: n.status === 'active' || n.status === 1 ? 'active' : 'inactive',
        inactiveAt: n.inactive_at || null,
        statusAt: n.status_at || null,
      });
    }
    nextKey = d.pagination?.next_key || null;
    pages++;
  } while (nextKey && pages < MAX_PAGES);

  return nodes;
}

async function getProviders() {
  // RPC-first N/A: blue-js-sdk exposes no list-all-providers RPC query, so this
  // read-only catalog lookup uses LCD by necessity (not a regression).
  const d = await lcd('/sentinel/provider/v2/providers?pagination.limit=100');
  return (d.providers || []).map(p => ({
    address: p.address,
    name: p.name,
    identity: p.identity,
    website: p.website,
    description: p.description,
    status: p.status,
  }));
}

// ─── Analytics Helpers ────────────────────────────────────────────────────────

async function getAllNodeInfo() {
  const nodeMap = {};

  // RPC-first: single call returns full list, no pagination needed.
  try {
    const rpc = await getRpcClient();
    if (rpc) {
      const nodes = await rpcQueryNodes(rpc, { status: 1, limit: 10000 });
      for (const n of nodes) {
        const hourlyPrice = (n.hourly_prices || []).find(p => p.denom === 'udvpn');
        const gbPrice = (n.gigabyte_prices || []).find(p => p.denom === 'udvpn');
        nodeMap[n.address] = {
          hourlyUdvpn: hourlyPrice ? parseInt(hourlyPrice.quote_value) : 0,
          gbUdvpn: gbPrice ? parseInt(gbPrice.quote_value) : 0,
        };
      }
      console.log(`[RPC] getAllNodeInfo: ${Object.keys(nodeMap).length} nodes loaded`);
      return nodeMap;
    }
  } catch (err) {
    console.log(`[RPC] getAllNodeInfo failed (${err.message}), falling back to LCD`);
  }

  // LCD fallback: paginated scan.
  let nextKey = undefined;
  do {
    const keyParam = nextKey ? `&pagination.key=${encodeURIComponent(nextKey)}` : '';
    const d = await lcd(`/sentinel/node/v3/nodes?status=1&pagination.limit=500${keyParam}`);
    for (const n of d.nodes || []) {
      const hourlyPrice = (n.hourly_prices || []).find(p => p.denom === 'udvpn');
      const gbPrice = (n.gigabyte_prices || []).find(p => p.denom === 'udvpn');
      nodeMap[n.address] = {
        hourlyUdvpn: hourlyPrice ? parseInt(hourlyPrice.quote_value) : 0,
        gbUdvpn: gbPrice ? parseInt(gbPrice.quote_value) : 0,
      };
    }
    nextKey = d.pagination?.next_key || null;
  } while (nextKey);
  return nodeMap;
}

async function scanSessions() {
  const nodes = {};
  let nextKey = undefined;
  let pages = 0;
  let totalScanned = 0;

  // No chain-wide RPC sessions query available — LCD is the only path
  do {
    const keyParam = nextKey ? `&pagination.key=${encodeURIComponent(nextKey)}` : '';
    const d = await lcd(`/sentinel/session/v3/sessions?pagination.limit=500${keyParam}`);
    const sessions = d.sessions || [];

    for (const s of sessions) {
      const b = s.base_session || {};
      const nodeAddr = b.node_address;
      if (!nodeAddr) continue;

      if (!nodes[nodeAddr]) {
        nodes[nodeAddr] = { users: new Set(), dlBytes: 0, ulBytes: 0, sessions: 0, totalDurSec: 0 };
      }
      nodes[nodeAddr].users.add(b.acc_address);
      nodes[nodeAddr].dlBytes += parseInt(b.download_bytes || '0');
      nodes[nodeAddr].ulBytes += parseInt(b.upload_bytes || '0');
      nodes[nodeAddr].sessions++;
      nodes[nodeAddr].totalDurSec += parseFloat(b.duration || '0');
    }

    totalScanned += sessions.length;
    nextKey = d.pagination?.next_key || null;
    pages++;
  } while (nextKey && pages < 50);

  return { nodes, totalScanned };
}

// ─── Lease Helpers ────────────────────────────────────────────────────────────

// Build a MsgStartLease for a node WITHOUT broadcasting it. Pure lookup +
// message construction, so the result can be bundled into a multi-message TX
// (e.g. [lease, link]) for a single signature. RPC-first, LCD fallback.
async function buildLeaseMsg(nodeAddress, hours = 24) {
  let nodeInfo = null;
  try {
    const rpcClient = await getRpcClient();
    nodeInfo = await rpcQueryNode(rpcClient, nodeAddress);
    if (nodeInfo) console.log(`[LEASE] Node found via RPC: ${nodeAddress}`);
  } catch (err) {
    console.log(`[LEASE] RPC lookup failed (${err.message}), falling back to LCD`);
  }

  if (!nodeInfo) {
    // LCD fallback: paginated scan (slow but reliable)
    let allNodesList = [], nextKey = null, pages = 0;
    const MAX_PAGES = 60; // 60 × 500 = 30k nodes — guards against an unbounded loop
    do {
      let url = '/sentinel/node/v3/nodes?pagination.limit=500&status=1';
      if (nextKey) url += `&pagination.key=${encodeURIComponent(nextKey)}`;
      const page = await lcd(url);
      allNodesList.push(...(page.nodes || []));
      nextKey = page.pagination?.next_key || null;
      pages++;
    } while (nextKey && pages < MAX_PAGES);
    nodeInfo = allNodesList.find(n => n.address === nodeAddress);
  }

  if (!nodeInfo) throw new Error('Node not found on chain');
  const hp = (nodeInfo.hourly_prices || []).find(p => p.denom === 'udvpn');
  if (!hp) throw new Error('Node has no udvpn hourly price');

  const totalCost = (parseInt(hp.quote_value) * hours / 1e6).toFixed(1);
  console.log(`[LEASE] Lease msg for ${nodeAddress} ${hours}h (${hp.quote_value} udvpn/hr = ~${totalCost} P2P)`);

  return {
    typeUrl: C.MSG_START_LEASE_TYPE,
    value: {
      from: getProvAddr(),
      nodeAddress,
      hours,
      maxPrice: { denom: 'udvpn', base_value: hp.base_value, quote_value: hp.quote_value },
      renewalPricePolicy: 7,
    },
  };
}

async function autoLeaseNode(nodeAddress, hours = 24) {
  const leaseMsg = await buildLeaseMsg(nodeAddress, hours);

  const leaseResult = await safeBroadcast([leaseMsg]);
  const leaseResp = txResponse(leaseResult);
  if (!leaseResp.ok) {
    console.log(`[LEASE] Failed: ${(leaseResp.rawLog || '').slice(0, 150)}`);
    throw new Error(parseChainError(leaseResp.rawLog));
  }
  console.log(`[LEASE] OK: tx=${leaseResp.txHash}`);
  return leaseResp;
}

// Build MsgStartLease for many nodes WITHOUT broadcasting. Pure lookup +
// construction so the result can be bundled with link msgs in one signature.
async function buildLeaseMsgs(addrs, hours = 24) {
  // Parallel RPC lookups: one rpcQueryNode() per address instead of paginated LCD scan.
  // Falls back to LCD if RPC unavailable.
  let rawMap = {};
  try {
    const rpcClient = await getRpcClient();
    if (!rpcClient) throw new Error('no RPC client available');
    // allSettled, not all: a single node's RPC lookup rejecting must NOT discard
    // every other resolved node and force the whole batch onto the slow LCD
    // paginated fallback. A rejected lookup just leaves that node out of rawMap,
    // and the start-msg loop below already treats "not found on chain" as a skip.
    const settled = await Promise.allSettled(
      addrs.map(addr => rpcQueryNode(rpcClient, addr).then(node => ({ addr, node })))
    );
    for (const s of settled) {
      if (s.status === 'fulfilled') {
        if (s.value.node) rawMap[s.value.addr] = s.value.node;
      } else {
        console.log(`[BATCH-LEASE] RPC node lookup failed: ${s.reason?.message || s.reason}`);
      }
    }
    console.log(`[BATCH-LEASE] RPC lookup: ${Object.keys(rawMap).length}/${addrs.length} nodes found`);
    // Only fall through to LCD if RPC produced nothing at all (client down / all rejected).
    if (Object.keys(rawMap).length === 0 && addrs.length > 0) {
      throw new Error('RPC returned no nodes');
    }
  } catch (err) {
    console.log(`[BATCH-LEASE] RPC failed (${err.message}), falling back to LCD`);
    // LCD fallback: paginated scan (slow but reliable)
    let rawNodesList = [], nextKey = null;
    do {
      let url = '/sentinel/node/v3/nodes?pagination.limit=500&status=1';
      if (nextKey) url += `&pagination.key=${encodeURIComponent(nextKey)}`;
      const page = await lcd(url);
      rawNodesList.push(...(page.nodes || []));
      nextKey = page.pagination?.next_key || null;
    } while (nextKey);
    rawMap = Object.fromEntries(rawNodesList.map(n => [n.address, n]));
  }

  // Reconcile each node's EXISTING lease against the requested duration:
  //   • no active lease of ours       → build a fresh MsgStartLease (new lease)
  //   • active lease, hours >= wanted  → SKIP (it already covers the request)
  //   • active lease, hours <  wanted  → END the stale lease, then start a fresh
  //     one for the requested hours
  // The last case is the real bug fix: a node left on an old 1h lease (from the
  // earlier duration bug) could never be upgraded — a second MsgStartLease is
  // rejected with "Lease already exists", and we have no MsgRenewLease in the
  // registry. Ending + re-starting in the SAME atomic TX swaps it cleanly. We
  // emit End msgs ahead of the Start/Link msgs so they execute first.
  //
  // Best-effort: a lease-query failure leaves the node on the default
  // first-time-lease path, so we never block a legitimate new lease.
  const skip = new Set();        // node already covered — no lease msg needed
  const endMsgs = [];            // stale leases to end before re-leasing
  let reconciled = 0;            // nodes we touched the lease state for
  try {
    const rpcClient = await getRpcClient();
    if (rpcClient) {
      const myProv = getProvAddr();
      const now = Date.now();
      const perNode = await Promise.all(addrs.map(async (addr) => {
        try {
          const leases = await rpcQueryLeasesForNode(rpcClient, addr);
          const mine = leases
            .filter(l => l.prov_address === myProv &&
              (!l.expires_at || new Date(l.expires_at).getTime() > now))
            .sort((a, b) => (b.hours || 0) - (a.hours || 0));
          return { addr, lease: mine[0] || null };
        } catch (e) {
          console.log(`[BATCH-LEASE] lease pre-check ${addr} failed: ${e.message}`);
          return { addr, lease: null };
        }
      }));
      for (const { addr, lease } of perNode) {
        if (!lease) continue; // no existing lease → fresh start below
        if ((lease.hours || 0) >= hours) {
          skip.add(addr);
          reconciled++;
        } else {
          // Too short — end it so a fresh full-duration lease can replace it.
          endMsgs.push({ typeUrl: C.MSG_END_LEASE_TYPE, value: { from: myProv, id: BigInt(lease.id) } });
          reconciled++;
          console.log(`[BATCH-LEASE] ${addr}: existing lease ${lease.hours}h < ${hours}h — ending lease ${lease.id} and re-leasing`);
        }
      }
      if (skip.size) console.log(`[BATCH-LEASE] ${skip.size} node(s) already cover ${hours}h — skipping their lease msg`);
    }
  } catch (e) {
    console.log(`[BATCH-LEASE] lease pre-check skipped: ${e.message}`);
  }

  const startMsgs = [];
  for (const addr of addrs) {
    if (skip.has(addr)) continue;
    const raw = rawMap[addr];
    if (!raw) { console.log(`[BATCH-LEASE] Skipping ${addr} — not found on chain`); continue; }
    const hp = (raw.hourly_prices || []).find(p => p.denom === 'udvpn');
    if (!hp) { console.log(`[BATCH-LEASE] Skipping ${addr} — no udvpn hourly price`); continue; }

    startMsgs.push({
      typeUrl: C.MSG_START_LEASE_TYPE,
      value: {
        from: getProvAddr(),
        nodeAddress: addr,
        hours,
        maxPrice: { denom: 'udvpn', base_value: hp.base_value, quote_value: hp.quote_value },
        renewalPricePolicy: 7,
      },
    });
  }

  // End-then-start: stale leases are ended first so the fresh Start for the same
  // node sees no conflicting lease in the atomic TX.
  const leaseMsgs = [...endMsgs, ...startMsgs];

  // Empty is only an error when NO node was leasable for a real reason (not on
  // chain / no price) AND we didn't intentionally skip/replace any existing
  // lease. If every node was already covered, return [] so the caller proceeds
  // links-only instead of failing the add.
  if (leaseMsgs.length === 0 && reconciled === 0) {
    throw new Error('No valid nodes to lease');
  }
  return leaseMsgs;
}

async function batchLeaseNodes(addrs, hours = 24) {
  const leaseMsgs = await buildLeaseMsgs(addrs, hours);
  console.log(`[BATCH-LEASE] Leasing ${leaseMsgs.length} nodes in one TX (${hours}h each)...`);
  const result = await safeBroadcast(leaseMsgs);
  const resp = txResponse(result);
  if (!resp.ok) {
    const raw = resp.rawLog || '';
    if (raw.includes('already exists')) {
      console.log(`[BATCH-LEASE] Some leases already existed — continuing`);
      return resp;
    }
    console.log(`[BATCH-LEASE] Failed: ${raw.slice(0, 200)}`);
    throw new Error(parseChainError(raw));
  }
  console.log(`[BATCH-LEASE] OK: ${leaseMsgs.length} leases created, tx=${resp.txHash}`);
  return resp;
}

// ─── Routes: Wallet ──────────────────────────────────────────────────────────

// ─── Wallet route rate limiter ───────────────────────────────────────────────
// In-memory token bucket. Localhost-only deployment, so this exists primarily
// to slow brute-force or runaway scripts on the same machine — not to defend
// against an external attacker (the bind to 127.0.0.1 already handles that).
const _rl = new Map();
function rateLimit(bucket, max, windowMs) {
  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `${bucket}:${ip}`;
    const now = Date.now();
    const e = _rl.get(key) || { count: 0, reset: now + windowMs };
    if (now > e.reset) { e.count = 0; e.reset = now + windowMs; }
    e.count += 1;
    _rl.set(key, e);
    if (e.count > max) {
      res.setHeader('Retry-After', Math.ceil((e.reset - now) / 1000));
      return res.status(429).json({ error: 'Too many requests' });
    }
    next();
  };
}
// Periodic cleanup of stale buckets.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _rl) if (now > v.reset) _rl.delete(k);
}, 60_000).unref();

app.get('/api/wallet/status', (req, res) => {
  const isDemo = currentSession()?.kind === 'demo';
  res.json({
    loaded: !!getAddr(),
    address: getAddr() || null,
    multiUser: isMultiUser(),
    demo: isDemo,
  });
});

app.post('/api/wallet/generate', rateLimit('wgen', 10, 60_000), async (req, res) => {
  // FIX 5: Mnemonic is returned once so the user can write it down during the
  // wallet-creation flow. The response is marked no-store so intermediaries
  // and the browser disk cache do not retain it.
  try {
    const { DirectSecp256k1HdWallet } = await import('@cosmjs/proto-signing');
    const wallet = await DirectSecp256k1HdWallet.generate(24, { prefix: 'sent' });
    const [account] = await wallet.getAccounts();
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.json({ mnemonic: wallet.mnemonic, address: account.address });
  } catch (err) {
    if (relayKeplrSign(err, res)) return;
    console.error('Wallet generate error:', err.message);
    res.status(500).json({ error: 'Failed to generate wallet: ' + err.message });
  }
});

app.post('/api/wallet/import', rateLimit('wimp', 20, 60_000), async (req, res) => {
  try {
    const { mnemonic } = req.body;
    if (!mnemonic || typeof mnemonic !== 'string') {
      return res.status(400).json({ error: 'mnemonic required' });
    }
    if (mnemonic.length > 1024) {
      return res.status(413).json({ error: 'Mnemonic too long' });
    }
    const trimmed = mnemonic.trim();
    const words = trimmed.split(/\s+/);
    if (words.length !== 12 && words.length !== 24) {
      return res.status(400).json({ error: 'Mnemonic must be 12 or 24 words' });
    }

    // Derive the wallet to validate the mnemonic before encrypting it into
    // the cookie. The mnemonic never leaves this request frame on the server
    // side — it lives in the user's encrypted browser cookie.
    const session = await sessionFromMnemonic(trimmed);
    const token = encryptMnemonic(trimmed);
    res.setHeader('Set-Cookie', buildSetCookie(token, { secure: req.secure }));
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');

    res.json({ ok: true, address: session.addr, provAddress: session.provAddr });
  } catch (err) {
    if (relayKeplrSign(err, res)) return;
    console.error('Wallet import error:', err.message);
    res.status(400).json({ error: 'Invalid mnemonic: ' + err.message });
  }
});

app.post('/api/wallet/logout', (req, res) => {
  // Drop the per-process derived-wallet cache for this mnemonic so a stolen
  // cookie value cannot continue to resolve to the cached wallet. The cookie
  // itself is also cleared on the user's browser.
  try {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[COOKIE_NAME];
    if (token) {
      try {
        const m = decryptMnemonic(token);
        dropSessionFromCache(m);
      } catch (err) {
        console.warn('[logout] could not drop mnemonic session from cache:', err.message);
      }
    }
    const kt = cookies[KEPLR_COOKIE_NAME];
    if (kt) {
      const parsed = parseKeplrToken(kt);
      if (parsed) dropKeplrSessionFromCache(parsed.addr);
    }
  } catch (err) {
    console.warn('[logout] cache cleanup failed:', err.message);
  }
  // Clear both cookies so a Keplr → mnemonic switch (or vice versa) leaves
  // no residual session.
  res.setHeader('Set-Cookie', [
    buildClearCookie({ secure: req.secure }),
    buildClearKeplrCookie({ secure: req.secure }),
  ]);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.json({ ok: true });
});

// ─── Keplr Login ─────────────────────────────────────────────────────────────
// Client flow:
//   1. POST /api/wallet/keplr-challenge           → { nonce }
//   2. window.keplr.signArbitrary(chainId, addr, nonce) → { signature, pub_key }
//   3. POST /api/wallet/keplr-login { addr, pubkey, signature, nonce }
// We verify the ADR-36 signature server-side before issuing the spm_keplr
// cookie. This proves the browser holds the private key for `addr` (defends
// against a malicious page racing the cookie set after a user picks the
// wrong wallet).

const keplrChallenges = new Map(); // nonce -> expiresAt
const KEPLR_CHALLENGE_TTL_MS = 5 * 60 * 1000;

/**
 * If `err` is a Keplr sign-required signal, write the {mode,signDoc} response
 * and return true. Routes' catch blocks call this first so they don't 500 a
 * legitimate client-signs request.
 */
function relayKeplrSign(err, res) {
  if (err && err.code === 'KEPLR_SIGN_REQUIRED' && err.signDoc) {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ mode: 'keplr-sign', signDoc: err.signDoc });
    return true;
  }
  return false;
}

/**
 * True when the active wallet signs in the browser (Keplr extension or Privy
 * enclave) rather than server-side from a mnemonic. For these sessions the
 * server holds no privkey: it can build exactly ONE signDoc per HTTP round-trip
 * and must relay it to the client to sign. Any route that loops safeBroadcast()
 * across multiple chunks for a server-signed wallet must instead BUNDLE all
 * messages into a single signDoc here — otherwise the first chunk throws
 * KEPLR_SIGN_REQUIRED and a per-chunk catch silently swallows it (the bug that
 * made grant-subscribers / revoke-all / revoke-list / add-subscribers dead on
 * Privy + Keplr).
 */
function isClientSigned() {
  const k = currentSession()?.kind;
  return k === 'keplr' || k === 'privy';
}

/**
 * For client-signed sessions: bundle every message into ONE TX and relay the
 * resulting signDoc to the browser. Returns true if it relayed (caller must
 * `return` immediately). Returns false for server-signed sessions so the caller
 * falls through to its normal multi-TX server-side loop. A genuine build error
 * (e.g. missing pubkey) is surfaced as JSON, not swallowed.
 *
 * NOTE: bundling means the whole batch is one atomic TX — all-or-nothing. That
 * removes the per-chunk "retry one-by-one so the rest still go through" fallback
 * the server-signed path has, but a client wallet can only sign once per
 * request anyway, so atomic-batch is the only correct shape here.
 */
async function relayBundledOrNull(msgs, res, memo) {
  if (!isClientSigned()) return false;
  if (!msgs.length) return false;
  try {
    await safeBroadcast(msgs, memo);
    // safeBroadcast on a client-signed session ALWAYS throws KEPLR_SIGN_REQUIRED
    // before touching the chain; reaching here means it unexpectedly didn't.
    return false;
  } catch (err) {
    if (relayKeplrSign(err, res)) return true;
    // Not a sign-required signal — a real build failure (e.g. account not found,
    // missing pubkey). Surface it as JSON instead of letting the caller's loop
    // bury it.
    res.status(400).json({ error: parseChainError(err.message || String(err)) });
    return true;
  }
}

// ADR-36 verification:
//   - signDoc is an amino StdSignDoc with chain_id="", account_number="0",
//     sequence="0", fee={gas:"0",amount:[]}, memo="", and a single
//     {type:"sign/MsgSignData", value:{signer:addr, data:base64(message)}}.
//   - Sorted-keys JSON encoding (amino) → SHA-256 → secp256k1.verify.
//   - Pubkey-derived address must match the claimed bech32.
async function verifyAdr36Signature({ addr, pubkeyB64, signatureB64, message }) {
  try {
    const { Secp256k1, Sha256, ripemd160 } = await import('@cosmjs/crypto');
    const { fromBase64, toBech32: toBech } = await import('@cosmjs/encoding');

    const pubkey = fromBase64(pubkeyB64);
    if (pubkey.length !== 33) return false;
    const signature = fromBase64(signatureB64);
    if (signature.length !== 64) return false;

    // Derive bech32 from pubkey: sha256 → ripemd160 → bech32('sent', ...).
    const sha = new Sha256(pubkey).digest();
    const ripemd = ripemd160(sha);
    const derived = toBech('sent', ripemd);
    if (derived !== addr) return false;

    // Build the canonical amino StdSignDoc Keplr produces for signArbitrary.
    const dataB64 = Buffer.from(message, 'utf8').toString('base64');
    const signDoc = {
      account_number: '0',
      chain_id: '',
      fee: { amount: [], gas: '0' },
      memo: '',
      msgs: [{ type: 'sign/MsgSignData', value: { data: dataB64, signer: addr } }],
      sequence: '0',
    };
    const sortedJson = sortedJsonStringify(signDoc);
    const hash = new Sha256(Buffer.from(sortedJson, 'utf8')).digest();

    return await Secp256k1.verifySignature(
      // Secp256k1Signature.fromFixedLength(signature) — but the lib wants
      // an ExtendedSecp256k1Signature; we pass via the static helper.
      // Use the simpler `.verifySignature` API which accepts the 64-byte sig.
      // Build a Secp256k1Signature from r||s.
      (await import('@cosmjs/crypto')).Secp256k1Signature.fromFixedLength(signature),
      hash,
      pubkey,
    );
  } catch (err) {
    // Helper has no `res` in scope — log and treat as verification failure.
    console.warn('[keplr] ADR-36 verify error:', err.message);
    return false;
  }
}

function sortedJsonStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(sortedJsonStringify).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + sortedJsonStringify(obj[k])).join(',') + '}';
}

function gcKeplrChallenges() {
  const now = Date.now();
  for (const [n, exp] of keplrChallenges) if (exp < now) keplrChallenges.delete(n);
}

app.post('/api/wallet/keplr-challenge', rateLimit('kchal', 30, 60_000), (req, res) => {
  gcKeplrChallenges();
  const nonce = `spm-login-${Date.now()}-${_cryptoRandomBytes(16).toString('hex')}`;
  keplrChallenges.set(nonce, Date.now() + KEPLR_CHALLENGE_TTL_MS);
  res.json({ nonce });
});

app.post('/api/wallet/keplr-login', rateLimit('klogin', 20, 60_000), async (req, res) => {
  try {
    const { addr, pubkey, signature, nonce } = req.body || {};
    if (!addr || !pubkey || !signature || !nonce) {
      return res.status(400).json({ error: 'addr, pubkey, signature, nonce required' });
    }
    if (typeof addr !== 'string' || !addr.startsWith('sent1')) {
      return res.status(400).json({ error: 'Invalid Sentinel address' });
    }
    if (!keplrChallenges.has(nonce)) {
      return res.status(400).json({ error: 'Unknown or expired challenge' });
    }
    keplrChallenges.delete(nonce); // single-use

    // Verify ADR-36 signature manually (no Keplr dep).
    //   1. Rebuild the canonical amino SignDoc Keplr signs for arbitrary text.
    //   2. SHA-256 the JSON bytes.
    //   3. secp256k1.verify(hash, sig, pubkey).
    //   4. Confirm pubkey hash → addr matches the claimed bech32 address
    //      (otherwise an attacker could submit anyone's pubkey + a sig made
    //      with their own key for a different address).
    const ok = await verifyAdr36Signature({ addr, pubkeyB64: pubkey, signatureB64: signature, message: nonce });
    if (!ok) {
      return res.status(401).json({ error: 'Signature verification failed' });
    }

    const session = keplrSessionFromAddress(addr, pubkey);
    const token = buildKeplrToken(session.addr, session.pubkeyB64);
    // Clear any stale mnemonic cookie so the two paths don't fight in the
    // middleware (mnemonic wins if both are set).
    res.setHeader('Set-Cookie', [
      buildClearCookie({ secure: req.secure }),
      buildSetKeplrCookie(token, { secure: req.secure }),
    ]);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.json({ ok: true, address: session.addr, provAddress: session.provAddr, mode: 'keplr' });
  } catch (err) {
    if (relayKeplrSign(err, res)) return;
    console.error('Keplr login error:', err.message);
    res.status(500).json({ error: 'Keplr login failed: ' + err.message });
  }
});

// ─── Privy Login (server-custody Cosmos wallet) ──────────────────────────────
// Privy issues a "Tier 2" Cosmos wallet for the authenticated user; the
// privkey lives inside Privy's enclave, never on this server, never in the
// browser. Flow:
//   1. Browser runs the email + OTP login against Privy and forwards the
//      resulting access token here.
//   2. We verify the token via @privy-io/server-auth, then look up (or
//      provision) a `chain_type: 'cosmos'` wallet for this userId via Privy's
//      REST API. Privy returns a compressed secp256k1 public_key; we re-bech32
//      it with the `sent` prefix to produce the user's sent1 address.
//   3. We persist `userId → {walletId, pubkey, sent1Addr}` so repeat logins
//      reuse the same wallet (same address) and we issue the standard Keplr
//      session cookie. /api/tx/privy-sign-and-broadcast then proxies signing
//      through Privy raw_sign for any TX path.
const PRIVY_APP_ID = process.env.PRIVY_APP_ID || '';
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET || '';
const PRIVY_CLIENT_ID = process.env.PRIVY_CLIENT_ID || '';
const PRIVY_API_BASE = 'https://api.privy.io/v1';
let _privyClientPromise = null;
async function getPrivyClient() {
  if (!PRIVY_APP_ID || !PRIVY_APP_SECRET) return null;
  if (!_privyClientPromise) {
    _privyClientPromise = (async () => {
      const { PrivyClient } = await import('@privy-io/server-auth');
      return new PrivyClient(PRIVY_APP_ID, PRIVY_APP_SECRET);
    })();
  }
  return _privyClientPromise;
}

// HTTP Basic auth header for Privy's REST API. Used by raw_sign and by the
// cosmos wallet create call (the typed walletApi.createWallet only supports
// ethereum/solana; cosmos requires direct REST per Privy's docs).
function privyAuthHeaders() {
  const basic = Buffer.from(`${PRIVY_APP_ID}:${PRIVY_APP_SECRET}`).toString('base64');
  return {
    'Authorization': `Basic ${basic}`,
    'privy-app-id': PRIVY_APP_ID,
    'Content-Type': 'application/json',
  };
}

async function privyCreateCosmosWallet(_userId) {
  // owner_id is omitted: Privy requires a cuid2-shaped id created via its Owners
  // API, not the did:privy:... userId. We persist the userId→walletId binding
  // in privy-wallets.json instead, which is sufficient for our recovery model.
  const r = await fetch(`${PRIVY_API_BASE}/wallets`, {
    method: 'POST',
    headers: privyAuthHeaders(),
    body: JSON.stringify({ chain_type: 'cosmos' }),
  });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!r.ok) {
    throw new Error(`Privy wallet create failed (${r.status}): ${body.error || body.message || text}`);
  }
  return body; // { id, address, public_key, chain_type, ... }
}

async function privyRawSign(walletId, hashHex) {
  const r = await fetch(`${PRIVY_API_BASE}/wallets/${walletId}/rpc`, {
    method: 'POST',
    headers: privyAuthHeaders(),
    body: JSON.stringify({
      method: 'raw_sign',
      params: { hash: hashHex.startsWith('0x') ? hashHex : `0x${hashHex}` },
    }),
  });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!r.ok) {
    throw new Error(`Privy raw_sign failed (${r.status}): ${body.error || body.message || text}`);
  }
  return body?.data?.signature || body?.signature;
}

// Re-derive the sent1 address from a Privy-supplied compressed secp256k1
// pubkey (or fall back to re-bech32-ing the cosmos1 address Privy returns;
// they share the same RIPEMD160 hash, only the HRP differs).
async function deriveSent1FromPrivy({ publicKey, address }) {
  const { fromBech32, fromHex, toBech32: toBech, toBase64 } = await import('@cosmjs/encoding');
  const { Sha256, ripemd160 } = await import('@cosmjs/crypto');
  if (publicKey) {
    const cleaned = publicKey.startsWith('0x') ? publicKey.slice(2) : publicKey;
    const pubkeyBytes = fromHex(cleaned);
    if (pubkeyBytes.length !== 33) {
      throw new Error(`Privy returned non-compressed secp256k1 pubkey (len=${pubkeyBytes.length})`);
    }
    const sha = new Sha256(pubkeyBytes).digest();
    const sent1 = toBech('sent', ripemd160(sha));
    return { sent1, pubkeyB64: toBase64(pubkeyBytes) };
  }
  if (address) {
    const { data } = fromBech32(address);
    return { sent1: toBech('sent', data), pubkeyB64: null };
  }
  throw new Error('Privy wallet response missing public_key and address');
}

app.get('/api/wallet/privy-config', (req, res) => {
  res.json({
    enabled: !!(PRIVY_APP_ID && PRIVY_APP_SECRET),
    appId: PRIVY_APP_ID || null,
    clientId: PRIVY_CLIENT_ID || null,
  });
});

app.post('/api/wallet/privy-login', rateLimit('plogin', 20, 60_000), async (req, res) => {
  try {
    const privy = await getPrivyClient();
    if (!privy) {
      return res.status(503).json({ error: 'Privy not configured. Set PRIVY_APP_ID and PRIVY_APP_SECRET in .env.' });
    }
    const { accessToken } = req.body || {};
    if (!accessToken) {
      return res.status(400).json({ error: 'accessToken required' });
    }

    // Verify the Privy access token. Throws on invalid/expired.
    let verified;
    try {
      verified = await privy.verifyAuthToken(accessToken);
    } catch (verifyErr) {
      return res.status(401).json({ error: 'Privy token verification failed: ' + verifyErr.message });
    }
    if (!verified?.userId) {
      return res.status(401).json({ error: 'Privy token missing userId' });
    }

    // Reuse the user's existing cosmos wallet if we've provisioned one before;
    // otherwise create one bound to this Privy userId. Same userId → same
    // wallet → same sent1 address forever, recoverable via Privy auth alone.
    let entry = lookupPrivyWallet(verified.userId);
    if (!entry?.walletId) {
      let wallet;
      try {
        wallet = await privyCreateCosmosWallet(verified.userId);
      } catch (createErr) {
        console.error('[privy-login] cosmos wallet create failed:', createErr.message);
        return res.status(502).json({ error: 'Privy cosmos wallet creation failed: ' + createErr.message });
      }
      const { sent1, pubkeyB64 } = await deriveSent1FromPrivy({
        publicKey: wallet.public_key,
        address: wallet.address,
      });
      entry = { walletId: wallet.id, pubkeyB64, sent1Addr: sent1, cosmosAddr: wallet.address || null };
      savePrivyWallet(verified.userId, entry);
    }

    const session = keplrSessionFromAddress(entry.sent1Addr, entry.pubkeyB64 || '', 'privy');
    const token = buildKeplrToken(session.addr, session.pubkeyB64);
    res.setHeader('Set-Cookie', [
      buildClearCookie({ secure: req.secure }),
      buildSetKeplrCookie(token, { secure: req.secure }),
    ]);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.json({
      ok: true,
      address: session.addr,
      provAddress: session.provAddr,
      mode: 'privy',
      userId: verified.userId,
    });
  } catch (err) {
    console.error('Privy login error:', err.message);
    res.status(500).json({ error: 'Privy login failed: ' + err.message });
  }
});

// Keplr- and Privy-signed TXs are broadcast through the two generic endpoints
// below, NOT through the inline server-signed routes. The inline routes (e.g.
// /api/provider/register) call cacheInvalidate() AFTER safeBroadcast() returns —
// but for a client-signed wallet safeBroadcast() throws KEPLR_SIGN_REQUIRED and
// the request returns the signDoc before that line ever runs. The real TX then
// lands here, where those per-route invalidations were never replayed. The most
// visible casualty was `provider:<addr>` (10-min TTL): after a successful Keplr
// provider registration /api/wallet kept serving the cached pre-register
// `provider: null`, so the dashboard read "Provider not registered" and even a
// page refresh didn't help until the cache aged out. Decode the signed TxBody and
// clear the same caches the inline route would have, keyed off the message types
// actually in the TX so unrelated TXs (send, subscribe) don't churn caches.
async function invalidateCachesForSignedTxBody(bodyBytesB64) {
  try {
    const { TxBody } = await import('cosmjs-types/cosmos/tx/v1beta1/tx');
    const { fromBase64 } = await import('@cosmjs/encoding');
    const typeUrls = (TxBody.decode(fromBase64(bodyBytesB64)).messages || []).map((m) => m.typeUrl);
    if (typeUrls.some((t) => t === C.MSG_REGISTER_PROVIDER_TYPE
      || t === C.MSG_UPDATE_PROVIDER_DETAILS_TYPE
      || t === C.MSG_UPDATE_PROVIDER_STATUS_TYPE)) {
      cacheInvalidate(`provider:${getAddr()}`);
    }
    // MsgUpdatePlanStatus (deactivate/reactivate) emits no plan_id create event,
    // so the event-based allPlans invalidation below would miss it — cover it here.
    if (typeUrls.some((t) => t === C.MSG_CREATE_PLAN_TYPE || t === C.MSG_UPDATE_PLAN_STATUS_TYPE)) {
      cacheInvalidate('allPlans');
    }
  } catch (e) {
    console.warn('[broadcast] post-broadcast cache invalidation failed:', e.message);
  }
}

// ─── Keplr Broadcast (client-signed TxRaw) ───────────────────────────────────
// The browser POSTs back the result of window.keplr.signDirect packaged as a
// TxRaw (bodyBytes, authInfoBytes, signatures[]) base64-encoded. We broadcast
// it via the existing RPC failover and respond in the same shape mnemonic
// flows return. Cookie middleware already validated the Keplr session.
app.post('/api/tx/broadcast-signed', async (req, res) => {
  if (!requireWallet(req, res)) return;
  try {
    const { bodyBytes, authInfoBytes, signature } = req.body || {};
    if (!bodyBytes || !authInfoBytes || !signature) {
      return res.status(400).json({ error: 'bodyBytes, authInfoBytes, signature required' });
    }
    const { TxRaw, AuthInfo } = await import('cosmjs-types/cosmos/tx/v1beta1/tx');
    const { PubKey } = await import('cosmjs-types/cosmos/crypto/secp256k1/keys');
    const { fromBase64, toBase64, toBech32: toBech } = await import('@cosmjs/encoding');
    const { Sha256, ripemd160 } = await import('@cosmjs/crypto');

    // Assert the signer pubkey inside authInfoBytes derives to the session's
    // bech32 address. Without this, a logged-in Keplr user could POST a TxRaw
    // signed by a different wallet — chain rejects it (sig mismatch) but we
    // still don't want to act as a relay for arbitrary signed payloads.
    const authInfo = AuthInfo.decode(fromBase64(authInfoBytes));
    const signerInfo = authInfo.signerInfos?.[0];
    if (!signerInfo?.publicKey?.value) {
      return res.status(400).json({ error: 'authInfoBytes missing signer publicKey' });
    }
    if (signerInfo.publicKey.typeUrl !== '/cosmos.crypto.secp256k1.PubKey') {
      return res.status(400).json({ error: `Unsupported signer key type: ${signerInfo.publicKey.typeUrl}` });
    }
    const signerPubKey = PubKey.decode(signerInfo.publicKey.value).key;
    if (signerPubKey.length !== 33) {
      return res.status(400).json({ error: 'Invalid secp256k1 pubkey length' });
    }
    const sha = new Sha256(signerPubKey).digest();
    const derivedAddr = toBech('sent', ripemd160(sha));
    if (derivedAddr !== getAddr()) {
      console.warn('[broadcast-signed] addr mismatch: derived=%s session=%s', derivedAddr, getAddr());
      return res.status(403).json({ error: 'Signed TX wallet does not match session wallet' });
    }

    const txRaw = TxRaw.encode(TxRaw.fromPartial({
      bodyBytes: fromBase64(bodyBytes),
      authInfoBytes: fromBase64(authInfoBytes),
      signatures: [fromBase64(signature)],
    })).finish();
    const result = await broadcastSignedTx(toBase64(txRaw));
    if (result.code !== 0) {
      return res.json({ ok: false, error: parseChainError(result.rawLog || 'Broadcast failed'), errorCode: 'tx-failed', txHash: result.transactionHash, code: result.code, rawLog: (result.rawLog || '').slice(0, 600) });
    }
    cacheInvalidate(`balance:${getAddr()}`);
    // Clear the per-message caches the inline server-signed route would have
    // (provider:<addr>, allPlans) — the Keplr path skipped them by returning the
    // signDoc before the inline cacheInvalidate ran. Without this a Keplr provider
    // registration keeps reading "Provider not registered" until the 10-min TTL.
    await invalidateCachesForSignedTxBody(bodyBytes);
    // Surface the same ids the inline (server-signed) path returns, so a
    // Keplr-signed create/subscribe can drive the follow-up activation and the
    // success UX. broadcastSignedTx now returns raw Tendermint result events;
    // extractEventId handles their base64-encoded attrs.
    const events = result.events;
    const planId = extractEventId(events, /plan/i, ['plan_id', 'id']);
    const subscriptionId = extractEventId(events, /subscription/i, ['subscription_id', 'id']);
    if (planId) { saveMyPlanId(planId); cacheInvalidate('allPlans'); }
    return res.json({
      ok: true,
      txHash: result.transactionHash,
      height: result.height,
      gasUsed: result.gasUsed,
      gasWanted: result.gasWanted,
      pending: result.pending || false,
      ...(planId ? { planId } : {}),
      ...(subscriptionId ? { subscriptionId } : {}),
    });
  } catch (err) {
    // No relayKeplrSign here: this endpoint receives an already-signed TxRaw,
    // so broadcastSignedTx() never enters the signing path that throws
    // KEPLR_SIGN_REQUIRED. Any error here is a real broadcast failure.
    console.error('[broadcast-signed] error:', err.message);
    res.status(500).json({ ok: false, error: parseChainError(err.message), errorCode: 'broadcast-error' });
  }
});

// ─── Privy server-side signed broadcast ──────────────────────────────────────
// Browser builds {bodyBytes, authInfoBytes} for the user's TX, POSTs them
// here. We compute SHA256(signDocBytes) per SIGN_MODE_DIRECT, hand the digest
// to Privy raw_sign (the Cosmos privkey lives in Privy's enclave), then wrap
// the returned signature into a TxRaw and broadcast via the standard RPC
// failover. Same custody story as Keplr but the "wallet" is the user's
// server-custody Privy wallet rather than a browser extension.
app.post('/api/tx/privy-sign-and-broadcast', async (req, res) => {
  if (!requireWallet(req, res)) return;
  try {
    const { bodyBytes, authInfoBytes, signDocBytes, accountNumber, chainId } = req.body || {};
    if (!bodyBytes || !authInfoBytes) {
      return res.status(400).json({ error: 'bodyBytes and authInfoBytes required' });
    }

    const entry = lookupPrivyWalletByAddr(getAddr());
    if (!entry?.walletId) {
      return res.status(403).json({ error: 'Active session has no Privy cosmos wallet on file' });
    }

    const { fromBase64, toBase64, toBech32: toBech, fromHex } = await import('@cosmjs/encoding');
    const { Sha256, ripemd160 } = await import('@cosmjs/crypto');
    const { TxRaw, AuthInfo, SignDoc } = await import('cosmjs-types/cosmos/tx/v1beta1/tx');
    const { PubKey } = await import('cosmjs-types/cosmos/crypto/secp256k1/keys');

    // Verify the signer pubkey baked into authInfoBytes derives to the
    // session's bech32 address. Same defense as broadcast-signed: don't relay
    // arbitrary signed payloads even after auth.
    const authInfo = AuthInfo.decode(fromBase64(authInfoBytes));
    const signerInfo = authInfo.signerInfos?.[0];
    if (!signerInfo?.publicKey?.value) {
      return res.status(400).json({ error: 'authInfoBytes missing signer publicKey' });
    }
    if (signerInfo.publicKey.typeUrl !== '/cosmos.crypto.secp256k1.PubKey') {
      return res.status(400).json({ error: `Unsupported signer key type: ${signerInfo.publicKey.typeUrl}` });
    }
    const signerPubKey = PubKey.decode(signerInfo.publicKey.value).key;
    if (signerPubKey.length !== 33) {
      return res.status(400).json({ error: 'Invalid secp256k1 pubkey length' });
    }
    const sha = new Sha256(signerPubKey).digest();
    const derivedAddr = toBech('sent', ripemd160(sha));
    if (derivedAddr !== getAddr()) {
      console.warn('[privy-sign-and-broadcast] addr mismatch: derived=%s session=%s', derivedAddr, getAddr());
      return res.status(403).json({ error: 'Signed TX wallet does not match session wallet' });
    }

    // Build signDocBytes server-side (don't trust browser's framing) when the
    // browser supplied chainId/accountNumber. Falls back to client-supplied
    // signDocBytes only if the explicit fields are absent — useful for tests.
    let signDocBytesBuf;
    if (chainId && (accountNumber !== undefined && accountNumber !== null)) {
      const sd = SignDoc.fromPartial({
        bodyBytes: fromBase64(bodyBytes),
        authInfoBytes: fromBase64(authInfoBytes),
        chainId,
        accountNumber: BigInt(accountNumber),
      });
      signDocBytesBuf = SignDoc.encode(sd).finish();
    } else if (signDocBytes) {
      signDocBytesBuf = fromBase64(signDocBytes);
    } else {
      return res.status(400).json({ error: 'chainId+accountNumber or signDocBytes required' });
    }

    const digest = new Sha256(signDocBytesBuf).digest();
    const digestHex = Buffer.from(digest).toString('hex');

    let signatureHex;
    try {
      signatureHex = await privyRawSign(entry.walletId, digestHex);
    } catch (signErr) {
      console.error('[privy-sign-and-broadcast] raw_sign failed:', signErr.message);
      return res.status(502).json({ error: 'Privy signing failed: ' + signErr.message });
    }
    if (!signatureHex) {
      return res.status(502).json({ error: 'Privy raw_sign returned no signature' });
    }
    const cleaned = signatureHex.startsWith('0x') ? signatureHex.slice(2) : signatureHex;
    let sigBytes = fromHex(cleaned);
    // Cosmos SIGN_MODE_DIRECT expects 64 bytes (R||S, no recovery byte).
    // Privy's raw_sign returns either 64 or 65 (with recovery id) — strip it.
    if (sigBytes.length === 65) sigBytes = sigBytes.slice(0, 64);
    if (sigBytes.length !== 64) {
      return res.status(502).json({ error: `Privy returned unexpected signature length: ${sigBytes.length}` });
    }

    const txRaw = TxRaw.encode(TxRaw.fromPartial({
      bodyBytes: fromBase64(bodyBytes),
      authInfoBytes: fromBase64(authInfoBytes),
      signatures: [sigBytes],
    })).finish();
    const result = await broadcastSignedTx(toBase64(txRaw));
    if (result.code !== 0) {
      return res.json({ ok: false, error: parseChainError(result.rawLog || 'Broadcast failed'), errorCode: 'tx-failed', txHash: result.transactionHash });
    }
    cacheInvalidate(`balance:${getAddr()}`);
    // Same gap as the Keplr broadcast-signed path: Privy sessions also throw
    // KEPLR_SIGN_REQUIRED in the inline route (key lives in Privy's enclave, not
    // on this server), so the inline cacheInvalidate never ran. Clear the
    // per-message caches (provider:<addr>, allPlans) off the signed TxBody here.
    await invalidateCachesForSignedTxBody(bodyBytes);
    return res.json({
      ok: true,
      txHash: result.transactionHash,
      height: result.height,
      gasUsed: result.gasUsed,
      gasWanted: result.gasWanted,
      pending: result.pending || false,
    });
  } catch (err) {
    console.error('[privy-sign-and-broadcast] error:', err.message);
    res.status(500).json({ ok: false, error: parseChainError(err.message), errorCode: 'broadcast-error' });
  }
});

app.get('/api/wallet', async (req, res) => {
  if (!requireWallet(req, res)) return;
  try {
    const [bal, dvpnPrice, provider] = await Promise.all([
      cached(`balance:${getAddr()}`, 30_000, async () => {
        // Read-only — go straight to the RPC query client so Keplr/Privy
        // sessions (which have no signing client; getClient() throws
        // 'client-signs') can still fetch their balance. Falls back to the
        // LCD if RPC is unavailable.
        try {
          const rpc = await getRpcClient();
          if (rpc) return await rpcQueryBalance(rpc, getAddr(), 'udvpn');
        } catch (e) {
          console.log(`[RPC] Balance query failed: ${e.message} — LCD fallback`);
        }
        const data = await lcd(`/cosmos/bank/v1beta1/balances/${getAddr()}`);
        const bal = data.balances?.find(b => b.denom === 'udvpn');
        return { denom: 'udvpn', amount: bal ? bal.amount : '0' };
      }),
      getDvpnPrice(),
      cached(`provider:${getAddr()}`, 600_000, async () => {
        // RPC-first: direct lookup by sentprov address — single round trip vs scanning 500 providers.
        try {
          const rpc = await getRpcClient();
          if (rpc) {
            const prov = await rpcQueryProvider(rpc, getProvAddr());
            if (prov) return prov;
          }
        } catch (err) {
          // Read-only query — never produces KEPLR_SIGN_REQUIRED. Don't write
          // to `res` from inside a cached() callback or we'd double-respond.
          console.log(`[RPC] provider lookup failed: ${err.message} — LCD fallback`);
        }
        // LCD fallback
        try {
          const provs = await lcd('/sentinel/provider/v2/providers?pagination.limit=500');
          return (provs.providers || []).find(p => p.address === getProvAddr()) || null;
        } catch (err) {
          console.error('Failed to lookup provider:', err.message);
          return null;
        }
      }),
    ]);

    // Normalize provider status to the LCD string shape the UI checks against.
    // rpcQueryProvider (the RPC-first path) returns status as a NUMBER
    // (1=active, 2=inactive_pending, 3=inactive); the LCD fallback returns the
    // string already. The UI gates the "Provider is inactive" banner on
    // `provider.status === 'active'`, so an unnormalized numeric 1 reads as
    // !== 'active' and the banner shows (and stays) even for an active provider.
    if (provider && typeof provider.status === 'number') {
      const PROV_STATUS_MAP = { 1: 'active', 2: 'inactive_pending', 3: 'inactive' };
      provider.status = PROV_STATUS_MAP[provider.status] ?? 'inactive';
    }

    res.json({
      address: getAddr(),
      kind: currentSession()?.kind || 'mnemonic',
      balanceUdvpn: parseInt(bal.amount),
      balanceDvpn: parseFloat((parseInt(bal.amount) / 1e6).toFixed(2)),
      dvpnPriceUsd: dvpnPrice,
      balanceUsd: dvpnPrice ? parseFloat((parseInt(bal.amount) / 1e6 * dvpnPrice).toFixed(4)) : null,
      provider,
      multiUser: isMultiUser(),
    });
  } catch (err) {
    if (relayKeplrSign(err, res)) return;
    res.status(500).json({ error: parseChainError(err.message) });
  }
});

// ─── Wallet Send (MsgSend) ───────────────────────────────────────────────────
// POST /api/wallet/send  body: { to, amountDvpn, memo? }
// Broadcasts a Cosmos bank MsgSend from the session wallet. RPC-first via
// the standard signing client. Validates bech32 prefix, positive amount,
// non-self recipient, and sufficient balance (incl. gas) before broadcast.
const SEND_BECH32_RE = /^sent1[0-9a-z]{38,58}$/;

app.post('/api/wallet/send', rateLimit('wsend', 30, 60_000), async (req, res) => {
  if (!requireWallet(req, res)) return;
  try {
    const { to, amountDvpn, memo } = req.body || {};
    const from = getAddr();

    const trimmedTo = typeof to === 'string' ? to.trim() : '';
    if (!SEND_BECH32_RE.test(trimmedTo)) {
      return res.status(400).json({ ok: false, error: 'Recipient address looks malformed.', errorCode: 'invalid-address' });
    }
    if (trimmedTo === from) {
      return res.status(400).json({ ok: false, error: 'Cannot send to your own address.', errorCode: 'invalid-address' });
    }
    const amt = Number(amountDvpn);
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ ok: false, error: 'Amount must be greater than 0.', errorCode: 'invalid-amount' });
    }
    const safeMemo = typeof memo === 'string' ? memo.slice(0, 256) : undefined;
    const amountUdvpn = String(Math.round(amt * 1e6));

    const msg = {
      typeUrl: '/cosmos.bank.v1beta1.MsgSend',
      value: {
        fromAddress: from,
        toAddress: trimmedTo,
        amount: [{ denom: 'udvpn', amount: amountUdvpn }],
      },
    };

    console.log(`[SEND] ${from} → ${trimmedTo} : ${amt} P2P (${amountUdvpn} udvpn)${safeMemo ? ` memo="${safeMemo}"` : ''}`);
    const result = await safeBroadcast([msg], safeMemo);

    if (result.code !== 0) {
      const parsed = parseChainError(result.rawLog || 'Broadcast failed');
      console.log(`[SEND] failed code=${result.code}: ${parsed}`);
      return res.json({ ok: false, error: parsed, errorCode: 'tx-failed', txHash: result.transactionHash });
    }
    cacheInvalidate(`balance:${from}`);
    return res.json({
      ok: true,
      txHash: result.transactionHash,
      height: result.height != null ? Number(result.height) : undefined,
      gasUsed: result.gasUsed != null ? String(result.gasUsed) : undefined,
      gasWanted: result.gasWanted != null ? String(result.gasWanted) : undefined,
    });
  } catch (err) {
    if (relayKeplrSign(err, res)) return;
    console.error('[SEND] error:', err.message);
    res.status(500).json({ ok: false, error: parseChainError(err.message), errorCode: 'broadcast-error' });
  }
});

// GET /api/wallet/qr — returns an SVG QR for the session wallet's address.
app.get('/api/wallet/qr', async (req, res) => {
  if (!requireWallet(req, res)) return;
  try {
    const svg = await QRCode.toString(getAddr(), {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 1,
      color: { dark: '#0156FC', light: '#00000000' },
    });
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(svg);
  } catch (err) {
    if (relayKeplrSign(err, res)) return;
    res.status(500).json({ error: 'QR generation failed: ' + err.message });
  }
});

// ─── Routes: Plans ────────────────────────────────────────────────────────────

app.get('/api/plans', async (req, res) => {
  try {
    const result = await cached('allPlans', 120_000, async () => {
      console.log('Discovering plans...');
      const planIds = await discoverPlanIds();
      console.log(`Found ${planIds.length} plans: ${planIds.join(', ')}`);
      const stats = await Promise.all(planIds.map(id => getPlanStats(id)));
      return { plans: stats, discoveredAt: new Date().toISOString() };
    });
    res.json(result);
  } catch (err) {
    if (relayKeplrSign(err, res)) return;
    console.error('Error fetching plans:', err);
    res.status(500).json({ error: parseChainError(err.message) });
  }
});

app.get('/api/plans/:id', async (req, res) => {
  try {
    const planId = parseInt(req.params.id);
    if (!Number.isFinite(planId)) return res.status(400).json({ error: 'Invalid plan ID' });
    const [stats, nodes] = await Promise.all([
      getPlanStats(planId),
      getNodesForPlan(planId),
    ]);
    const uniqueWallets = await getUniqueWallets(planId);
    res.json({ ...stats, uniqueWallets, nodes });
  } catch (err) {
    if (relayKeplrSign(err, res)) return;
    console.error(`Error fetching plan ${req.params.id}:`, err);
    res.status(500).json({ error: parseChainError(err.message) });
  }
});

app.get('/api/plans/:id/subscriptions', async (req, res) => {
  try {
    const planId = parseInt(req.params.id);
    if (!Number.isFinite(planId)) return res.status(400).json({ error: 'Invalid plan ID' });
    const limit = Math.min(parseInt(req.query.limit || '100'), 500);
    const key = req.query.key || '';
    const keyParam = key ? `&pagination.key=${encodeURIComponent(key)}` : '';
    const cacheKey = `planSubs:${planId}:${limit}:${key}`;

    // RPC-first only when no cursor key and limit ≤ 500 (full page, no pagination needed).
    // RPC doesn't give next_key, so cursor-based pagination must use LCD.
    let d;
    if (!key && limit <= 500) {
      try {
        const rpc = await getRpcClient();
        if (rpc) {
          const rpcResult = await rpcQuerySubscriptionsForPlan(rpc, planId, { limit: 10000 });
          if (rpcResult) {
            // Normalize numeric status → string to match LCD shape ({status:'active'|'inactive_pending'|'inactive'}).
            // Reverse ordering to match LCD pagination.reverse=true behavior (newest first).
            const STATUS_MAP = { 1: 'active', 2: 'inactive_pending', 3: 'inactive' };
            const subs = rpcResult
              .map(s => ({ ...s, status: STATUS_MAP[s.status] ?? s.status }))
              .sort((a, b) => Number(b.id) - Number(a.id))
              .slice(0, limit);
            d = { subscriptions: subs, pagination: { next_key: null, total: rpcResult.length.toString() } };
          }
        }
      } catch (err) {
        // Read-only RPC probe — never produces KEPLR_SIGN_REQUIRED. Outer catch handles user-facing errors.
        console.log(`[RPC] GET /api/plans/${planId}/subscriptions failed: ${err.message} — LCD fallback`);
        d = null;
      }
    }

    if (!d) {
      registerPlanSubsKey(planId, cacheKey);
      d = await cached(cacheKey, 60_000, () =>
        lcd(`/sentinel/subscription/v3/plans/${planId}/subscriptions?pagination.limit=${limit}&pagination.reverse=true${keyParam}`)
      );
    }

    // Filter the operator's own subscriptions out — but on a COPY. `d` may be
    // the shared object returned by cached(); mutating its `subscriptions`
    // array would poison the cache for every later reader (who would then see
    // a permanently self-filtered list).
    if (getAddr() && d.subscriptions) {
      const me = getAddr();
      res.json({ ...d, subscriptions: d.subscriptions.filter(s => s.acc_address !== me) });
      return;
    }
    res.json(d);
  } catch (err) {
    if (relayKeplrSign(err, res)) return;
    res.status(500).json({ error: parseChainError(err.message) });
  }
});

// Members added by the operator via subscribe+share. These are bandwidth
// allocations on the operator's own subscriptions to the plan (acc_address =
// operator), not standalone subscriptions — so they don't appear in
// /subscriptions (which filters the operator out). This surfaces them so the
// dashboard reflects everyone the operator has added.
app.get('/api/plans/:id/members', async (req, res) => {
  if (!requireWallet(req, res)) return;
  try {
    const planId = parseInt(req.params.id);
    if (!Number.isFinite(planId)) return res.status(400).json({ error: 'Invalid plan ID' });
    const operator = getAddr();
    const members = await cached(`planMembers:${planId}:${operator}`, 30_000, async () => {
      const rpc = await getRpcClient();
      if (!rpc) return [];
      // The operator's subscriptions to this specific plan.
      const accSubs = await rpcQuerySubscriptionsForAccount(rpc, operator, { limit: 10000 });
      const planSubs = accSubs.filter(s => Number(s.plan_id ?? s.planId) === planId);
      const out = [];
      for (const sub of planSubs) {
        let allocs = [];
        try {
          allocs = await rpcQuerySubscriptionAllocations(rpc, sub.id, { limit: 10000 });
        } catch (e) {
          console.log(`[Members] allocations for sub ${sub.id} failed: ${e.message}`);
        }
        for (const a of allocs) {
          // Skip the operator's own residual allocation — only shared members.
          if (a.address === operator) continue;
          out.push({
            address: a.address,
            subscriptionId: String(sub.id),
            grantedBytes: String(a.granted_bytes ?? a.grantedBytes ?? '0'),
            utilisedBytes: String(a.utilised_bytes ?? a.utilisedBytes ?? '0'),
            status: typeof sub.status === 'number' ? (sub.status === 1 ? 'active' : 'inactive') : sub.status,
            startAt: sub.start_at || null,
            inactiveAt: sub.inactive_at || null,
          });
        }
      }
      return out;
    });
    res.json({ members, total: members.length });
  } catch (err) {
    if (relayKeplrSign(err, res)) return;
    console.error(`Error fetching members for plan ${req.params.id}:`, err.message);
    res.status(500).json({ error: parseChainError(err.message) });
  }
});

// Whether the operator has subscribed to their OWN plan. Adding a subscriber
// via Free Access (subscribe+share) requires the operator to hold a
// subscription to the plan first — this surfaces that state up front so the
// operator knows whether they're already set up to grant access. Returns the
// operator's subscriptions to this plan with allocation/usage totals.
app.get('/api/plans/:id/own-subscription', async (req, res) => {
  if (!requireWallet(req, res)) return;
  try {
    const planId = parseInt(req.params.id);
    if (!Number.isFinite(planId)) return res.status(400).json({ error: 'Invalid plan ID' });
    const operator = getAddr();
    const result = await cached(`ownSub:${planId}:${operator}`, 30_000, async () => {
      const rpc = await getRpcClient();
      if (!rpc) return { subscribed: false, subscriptions: [], activeCount: 0, inactiveCount: 0 };
      const accSubs = await rpcQuerySubscriptionsForAccount(rpc, operator, { limit: 10000 });
      const planSubs = accSubs.filter(s => Number(s.plan_id ?? s.planId) === planId);
      const subscriptions = [];
      for (const sub of planSubs) {
        const status = typeof sub.status === 'number' ? (sub.status === 1 ? 'active' : 'inactive') : sub.status;
        // Pull the operator's own allocation row for granted/used totals.
        let grantedBytes = '0';
        let utilisedBytes = '0';
        try {
          const allocs = await rpcQuerySubscriptionAllocations(rpc, sub.id, { limit: 10000 });
          const own = allocs.find(a => a.address === operator);
          if (own) {
            grantedBytes = String(own.granted_bytes ?? own.grantedBytes ?? '0');
            utilisedBytes = String(own.utilised_bytes ?? own.utilisedBytes ?? '0');
          }
        } catch (e) {
          console.log(`[OwnSub] allocations for sub ${sub.id} failed: ${e.message}`);
        }
        subscriptions.push({
          subscriptionId: String(sub.id),
          status,
          grantedBytes,
          utilisedBytes,
          startAt: sub.start_at || null,
          inactiveAt: sub.inactive_at || null,
        });
      }
      const activeCount = subscriptions.filter(s => s.status === 'active').length;
      return {
        subscribed: subscriptions.length > 0,
        subscriptions,
        activeCount,
        inactiveCount: subscriptions.length - activeCount,
      };
    });
    res.json(result);
  } catch (err) {
    if (relayKeplrSign(err, res)) return;
    console.error(`Error fetching own subscription for plan ${req.params.id}:`, err.message);
    res.status(500).json({ error: parseChainError(err.message) });
  }
});

app.get('/api/my-plans', async (req, res) => {
  if (!requireWallet(req, res)) return;
  try {
    // Merge plans created outside this app (chain is the source of truth)
    // into my-plans.json before reading the ledger. Cached 60s; never throws.
    await discoverChainPlans();
    const rawPlanIds = loadMyPlanIds();
    // RPC ownership filter: drop any plan whose `prov_address` ≠ our
    // current sentprov address. Stale entries (e.g. plans created from a
    // different mnemonic that ended up under our wallet's bucket) are
    // pruned from `my-plans.json` so the UI never offers them again and
    // we never try to broadcast a doomed link/unlink/status TX.
    const planIds = await filterOwnedPlanIds(rawPlanIds);

    const [bal, ...myPlanResults] = await Promise.all([
      cached(`balance:${getAddr()}`, 30_000, async () => {
        try {
          const rpc = await getRpcClient();
          if (rpc) return await rpcQueryBalance(rpc, getAddr(), 'udvpn');
        } catch (e) {
          console.log(`[RPC] Balance query failed: ${e.message} — LCD fallback`);
        }
        const data = await lcd(`/cosmos/bank/v1beta1/balances/${getAddr()}`);
        const bal = data.balances?.find(b => b.denom === 'udvpn');
        return { denom: 'udvpn', amount: bal ? bal.amount : '0' };
      }),
      // Resolve to {ok, planId, stats?, err?} so we never silently drop a
      // plan when stats fail. The UI gets a stub row with the planId so the
      // user sees the plan exists; a refresh later will fill in details.
      ...planIds.map(async (id) => {
        try {
          const stats = await getPlanStats(id);
          return { ok: true, planId: Number(id), stats };
        } catch (err) {
          console.error(`Failed to get stats for plan ${id} (after retry): ${err.message}`);
          return { ok: false, planId: Number(id), err: err.message };
        }
      }),
    ]);

    // Build the plans array. Successful plans get full stats; failures get
    // a stub so the operator can still see the plan and select it.
    const plans = myPlanResults
      .map(r => {
        if (r.ok && r.stats) return r.stats;
        return {
          planId: r.planId,
          totalSubscriptions: 0,
          totalNodes: 0,
          uniqueWalletsSample: 0,
          // Stats read failed entirely — price is UNKNOWN, not 0. Use null +
          // priceUnknown so the card renders "—" (a fabricated '0' would show
          // a bogus "0 P2P"; the chain has no zero-priced plans).
          priceUnknown: true,
          price: { denom: 'udvpn', quoteValue: null, baseValue: null, dvpnAmount: null },
          renewalPolicy: 'unknown',
          activeSubs: 0,
          inactiveSubs: 0,
          sampleSize: 0,
          durationDays: null,
          earliestStart: null,
          latestStart: null,
          estimatedTotalP2p: null,
          _statsUnavailable: true,
          _error: r.err,
        };
      })
      .sort((a, b) => b.planId - a.planId);

    const failedCount = myPlanResults.filter(r => !r.ok).length;
    res.json({
      address: getAddr(),
      balance: (parseInt(bal.amount) / 1e6).toFixed(2),
      plans,
      ...(failedCount > 0 ? { partialFailures: failedCount } : {}),
    });
  } catch (err) {
    if (relayKeplrSign(err, res)) return;
    res.status(500).json({ error: parseChainError(err.message) });
  }
});

app.post('/api/plan/create', async (req, res) => {
  if (!requireWallet(req, res)) return;
  try {
    const {
      durationSeconds,
      gigabytes,
      // New shape: prices is an array of {denom, amount} in micro units
      prices: pricesIn,
      // Legacy single-denom params (still supported)
      priceDenom, priceQuoteValue, priceBaseValue,
      isPrivate,
    } = req.body;
    if (!durationSeconds || !gigabytes) return res.status(400).json({ error: 'durationSeconds and gigabytes required' });

    // Validate gigabytes/durationSeconds are positive integers BEFORE they reach
    // BigInt()/parseInt() below. BigInt(1.5) throws an opaque RangeError, and
    // parseInt() would silently truncate "10.9d" → 10 — both surface to the user
    // as a confusing chain error instead of a clear 400.
    const gbNum = Number(gigabytes);
    if (!Number.isInteger(gbNum) || gbNum <= 0) {
      return res.status(400).json({ error: 'gigabytes must be a positive whole number' });
    }
    const durNum = Number(durationSeconds);
    if (!Number.isInteger(durNum) || durNum <= 0) {
      return res.status(400).json({ error: 'durationSeconds must be a positive whole number' });
    }

    // Build the Coin array the chain expects:
    //   { denom, base_value, quote_value }
    // base_value is the per-byte rate the chain uses for partial settlements;
    // we keep the v3 default ("0.003…") unless an explicit override is passed.
    const DEFAULT_BASE = '0.003000000000000000';
    let prices;
    if (Array.isArray(pricesIn) && pricesIn.length > 0) {
      prices = pricesIn.map(p => {
        if (!p || !p.denom || p.amount == null) {
          throw new Error('each prices[] entry needs {denom, amount}');
        }
        return {
          denom: String(p.denom),
          base_value: String(p.base_value || DEFAULT_BASE),
          quote_value: String(p.amount),
        };
      });
    } else {
      // Legacy fallback path
      prices = [{
        denom: priceDenom || 'udvpn',
        base_value: priceBaseValue || DEFAULT_BASE,
        quote_value: String(priceQuoteValue || '1000000'),
      }];
    }

    const bytesStr = String(BigInt(gbNum) * 1000000000n);

    const msg = {
      typeUrl: C.MSG_CREATE_PLAN_TYPE,
      value: {
        from: getProvAddr(),
        bytes: bytesStr,
        duration: durNum,
        prices,
        isPrivate: isPrivate || false,
      },
    };

    const priceSummary = prices.map(p => `${p.quote_value}${p.denom}`).join(',');
    console.log(`Creating plan (v3): ${gigabytes}GB (${bytesStr} bytes), ${durationSeconds}s, prices=[${priceSummary}]...`);
    const result = await safeBroadcast([msg]);
    const resp = txResponse(result);
    if (!resp.ok) {
      console.log(`Create plan FAIL: code=${resp.code} ${resp.rawLog}`);
      return res.status(400).json({ ...resp, error: parseChainError(resp.rawLog) });
    }

    console.log(`Plan created: tx=${resp.txHash}`);
    let planId = null;
    for (const event of (resp.events || [])) {
      if (/plan/i.test(event.type)) {
        for (const attr of event.attributes) {
          const k = typeof attr.key === 'string' ? attr.key : Buffer.from(attr.key, 'base64').toString('utf8');
          const v = typeof attr.value === 'string' ? attr.value : Buffer.from(attr.value, 'base64').toString('utf8');
          if (k === 'plan_id' || k === 'id') planId = v.replace(/"/g, '');
        }
      }
    }
    resp.planId = planId;
    if (planId) saveMyPlanId(planId);
    cacheInvalidate('allPlans');

    // Newly-created plans land on chain inactive; activate in a separate TX
    // so subscriptions can be opened without a manual follow-up.
    if (planId) {
      try {
        const statusMsg = {
          typeUrl: C.MSG_UPDATE_PLAN_STATUS_TYPE,
          value: { from: getProvAddr(), id: BigInt(planId), status: 1 },
        };
        console.log(`Activating plan ${planId} (status=1, separate TX)...`);
        const statusResult = await safeBroadcast([statusMsg]);
        const statusResp = txResponse(statusResult);
        resp.activation = statusResp;
        if (statusResp.ok) {
          console.log(`Plan ${planId} activated: tx=${statusResp.txHash}`);
          cacheInvalidate('allPlans');
        } else {
          console.log(`Plan ${planId} activation FAIL: code=${statusResp.code} ${statusResp.rawLog}`);
          resp.activationError = parseChainError(statusResp.rawLog);
        }
      } catch (err) {
        // Plan create TX already succeeded; activation failure is a soft error
        // attached to the response. If the user is on Keplr they'll be prompted
        // to sign the activation TX from a follow-up "Activate plan" button —
        // never relay keplr-sign here or the create result is hidden.
        console.error('Plan activation error:', err.message);
        resp.activationError = err.code === 'KEPLR_SIGN_REQUIRED'
          ? 'Plan was created but activation needs a Keplr signature. Use the Activate button on the plan card.'
          : parseChainError(err.message);
      }
    }

    res.json(resp);
  } catch (err) {
    if (relayKeplrSign(err, res)) return;
    res.status(500).json({ error: parseChainError(err.message) });
  }
});

app.post('/api/plan/status', async (req, res) => {
  if (!requireWallet(req, res)) return;
  try {
    const { planId, status } = req.body;
    if (!planId || !status) return res.status(400).json({ error: 'planId and status required' });

    const planIdNum = parseInt(planId, 10);
    if (!Number.isFinite(planIdNum) || planIdNum <= 0) return res.status(400).json({ error: 'planId must be a positive integer' });
    const statusNum = parseInt(status, 10);
    if (statusNum !== 1 && statusNum !== 3) return res.status(400).json({ error: 'status must be 1 (active) or 3 (inactive)' });

    const ownErr = await assertPlanOwnership(planIdNum);
    if (ownErr) return res.status(ownErr.status).json({ error: ownErr.error });

    const msg = {
      typeUrl: C.MSG_UPDATE_PLAN_STATUS_TYPE,
      value: { from: getProvAddr(), id: BigInt(planIdNum), status: statusNum },
    };

    console.log(`Updating plan ${planId} status to ${status} (v3)...`);
    const result = await safeBroadcast([msg]);
    const resp = txResponse(result);
    if (resp.ok) {
      console.log(`Plan status updated: tx=${resp.txHash}`);
      res.json(resp);
    } else {
      console.log(`Plan status FAIL: code=${resp.code} ${resp.rawLog}`);
      res.status(400).json({ ...resp, error: parseChainError(resp.rawLog) });
    }
  } catch (err) {
    if (relayKeplrSign(err, res)) return;
    console.error('Plan status error:', err.message);
    res.status(500).json({ error: parseChainError(err.message) });
  }
});

// Find an active fee-grant *received* by the current signer. When a grantor
// exists we pass it to safeBroadcast so the chain charges the grantor's
// account for the TX gas — this is what makes the "operator pays subscriber's
// gas" flow actually work (subscribe / start-session). Returns null if no
// usable grant is found, so callers fall back to self-paid gas. RPC-first per
// project rule; LCD is not used here because rpcQueryFeeGrants already has
// SDK-side LCD fallback at the chain client.
async function pickActiveGrantor(grantee) {
  if (!grantee) return null;
  try {
    const rpc = await getRpcClient();
    if (!rpc) return null;
    const grants = await rpcQueryFeeGrants(rpc, grantee);
    if (!grants || !grants.length) return null;
    const now = Date.now();
    const usable = grants.find((g) => {
      const exp = g.allowance?.basic?.expiration || g.allowance?.expiration;
      if (!exp) return true;
      const t = typeof exp === 'string' ? Date.parse(exp) : Number(exp);
      return !isFinite(t) || t > now;
    });
    return usable ? usable.granter : null;
  } catch (e) {
    console.log(`[FeeGrant] pickActiveGrantor failed for ${grantee}: ${e.message}`);
    return null;
  }
}

app.post('/api/plan/subscribe', async (req, res) => {
  if (!requireWallet(req, res)) return;
  try {
    const { planId, denom, renewalPolicy } = req.body;
    if (!planId) return res.status(400).json({ error: 'planId required' });

    const msg = {
      typeUrl: C.MSG_START_SUBSCRIPTION_TYPE,
      value: {
        from: getAddr(),
        id: BigInt(planId),
        denom: denom || 'udvpn',
        renewalPricePolicy: parseInt(renewalPolicy || 0),
      },
    };

    const feeGranter = await pickActiveGrantor(getAddr());
    console.log(`Subscribing to plan ${planId} (v3)${feeGranter ? ` — gas paid by grant from ${feeGranter}` : ''}...`);
    const result = await safeBroadcast([msg], undefined, feeGranter ? { feeGranter } : undefined);
    const resp = txResponse(result);
    if (resp.ok) {
      let subscriptionId = null;
      for (const event of (resp.events || [])) {
        if (/subscription/i.test(event.type)) {
          for (const attr of event.attributes) {
            const k = typeof attr.key === 'string' ? attr.key : Buffer.from(attr.key, 'base64').toString('utf8');
            const v = typeof attr.value === 'string' ? attr.value : Buffer.from(attr.value, 'base64').toString('utf8');
            if (k === 'subscription_id' || k === 'id') subscriptionId = v.replace(/"/g, '');
          }
        }
      }
      resp.subscriptionId = subscriptionId;
      console.log(`Subscribed: subscription_id=${subscriptionId} tx=${resp.txHash}`);
      res.json(resp);
    } else {
      console.log(`Subscribe FAIL: code=${resp.code} ${resp.rawLog}`);
      res.status(400).json({ ...resp, error: parseChainError(resp.rawLog) });
    }
  } catch (err) {
    if (relayKeplrSign(err, res)) return;
    console.error('Subscribe error:', err.message);
    res.status(500).json({ error: parseChainError(err.message) });
  }
});

// ─── Add Subscriber (operator-paid subscription + share) ─────────────────────
// Sentinel has no message that subscribes a third party directly — the signer
// of MsgStartSubscription always becomes the subscriber (proto field `from`).
// The protocol-correct way for an operator to "add" a user is:
//   1. operator signs MsgStartSubscription for the plan (operator pays),
//   2. operator signs MsgShareSubscription, allocating bandwidth to the user.
// The user then holds a real bandwidth allocation on chain (visible via
// QuerySubscriptionAllocations) and can start sessions — without signing.

// Default bandwidth allocation per added subscriber when the caller doesn't
// specify one: 1 TB (1000^4 bytes, decimal — matching plan sizing which uses
// GB = 1e9 bytes at creation, see /api/plans create handler).
const DEFAULT_SHARE_BYTES = 1_000_000_000_000n; // 1 TB

/**
 * Share an allocation of `planId` with `member`. Reuses an existing active
 * operator subscription that holds enough spare bytes; only self-subscribes
 * (paying the full plan price) when no such subscription exists. This lets one
 * paid subscription serve many free-access members instead of re-paying per add.
 * `allocBytes` (BigInt|string|number) caps the share; defaults to 1 TB and is
 * clamped to the subscription's granted bytes (can't share more than it holds).
 * Returns { ok, subscriptionId, bytes, reused, subTx, shareTx } or throws.
 * `reused` is true when no new subscription was paid for; `subTx` is null then.
 */
/**
 * Build ONLY the MsgShareSubscription for `member`, reusing an existing active
 * operator subscription on `planId` that holds enough spare bytes. Returns the
 * proto msg object, or null when no reusable subscription can cover the
 * allocation (i.e. a new paid subscription would be required — not buildable as
 * a single relayable msg). Used by client-signed (Keplr/Privy) bulk add, where
 * the server can't run the subscribe+share loop and must bundle share msgs into
 * one signDoc. Mirrors the reuse-scan in _addSubscriberViaShare.
 */
async function buildReuseShareMsgOrNull(planId, member, { allocBytes } = {}) {
  const operator = getAddr();
  let requestedBytes;
  try {
    requestedBytes = allocBytes != null ? BigInt(allocBytes) : DEFAULT_SHARE_BYTES;
  } catch {
    requestedBytes = DEFAULT_SHARE_BYTES;
  }
  if (requestedBytes <= 0n) requestedBytes = DEFAULT_SHARE_BYTES;

  const rpc = await getRpcClient();
  if (!rpc) return null;
  const accSubs = await rpcQuerySubscriptionsForAccount(rpc, operator, { limit: 10000 });
  const planSubs = accSubs.filter(s =>
    Number(s.plan_id ?? s.planId) === Number(planId) &&
    (typeof s.status === 'number' ? s.status === 1 : s.status === 'active'));
  let best = null;
  let bestBytes = -1n;
  for (const sub of planSubs) {
    try {
      const allocs = await rpcQuerySubscriptionAllocations(rpc, sub.id, { limit: 100 });
      const own = allocs.find(a => a.address === operator);
      if (!own) continue;
      const have = BigInt(own.granted_bytes ?? own.grantedBytes ?? '0');
      if (have > bestBytes) { bestBytes = have; best = sub; }
    } catch (e) {
      console.log(`[ReuseShare] allocations for sub ${sub.id} failed: ${e.message}`);
    }
  }
  if (!best || bestBytes < requestedBytes) return null;
  const shareBytes = requestedBytes > bestBytes ? bestBytes : requestedBytes;
  return {
    typeUrl: C.MSG_SHARE_SUBSCRIPTION_TYPE,
    value: { from: operator, id: BigInt(String(best.id)), accAddress: member, bytes: String(shareBytes) },
  };
}

async function _addSubscriberViaShare(planId, member, { denom = 'udvpn', allocBytes } = {}) {
  const operator = getAddr();
  let requestedBytes;
  try {
    requestedBytes = allocBytes != null ? BigInt(allocBytes) : DEFAULT_SHARE_BYTES;
  } catch (e) {
    console.warn(`[AddSub] invalid allocBytes ${JSON.stringify(allocBytes)} (${e.message}) — using default share`);
    requestedBytes = DEFAULT_SHARE_BYTES;
  }
  if (requestedBytes <= 0n) requestedBytes = DEFAULT_SHARE_BYTES;

  // 1. Try to REUSE an existing active operator subscription to this plan that
  //    still holds enough allocatable bytes on the operator's own row. A single
  //    subscription's allocation can be split across many members, so we don't
  //    need to pay the full plan price for every subscriber — only when no
  //    existing subscription can cover the requested allocation. This both
  //    avoids the "insufficient P2P" failure on expensive plans and matches the
  //    operator's intent ("pay once, share to many").
  let subscriptionId = null;
  let availableBytes = null;
  let reused = false;
  let subTx = null;
  try {
    const rpc = await getRpcClient();
    if (rpc) {
      const accSubs = await rpcQuerySubscriptionsForAccount(rpc, operator, { limit: 10000 });
      const planSubs = accSubs.filter(s =>
        Number(s.plan_id ?? s.planId) === Number(planId) &&
        (typeof s.status === 'number' ? s.status === 1 : s.status === 'active'));
      // Prefer the subscription holding the most spare bytes on the operator row.
      let best = null;
      let bestBytes = -1n;
      for (const sub of planSubs) {
        try {
          const allocs = await rpcQuerySubscriptionAllocations(rpc, sub.id, { limit: 100 });
          const own = allocs.find(a => a.address === operator);
          if (!own) continue;
          const have = BigInt(own.granted_bytes ?? own.grantedBytes ?? '0');
          if (have > bestBytes) { bestBytes = have; best = sub; }
        } catch (e) {
          console.log(`[AddSub] reuse-scan allocations for sub ${sub.id} failed: ${e.message}`);
        }
      }
      if (best && bestBytes >= requestedBytes) {
        subscriptionId = String(best.id);
        availableBytes = bestBytes;
        reused = true;
        console.log(`[AddSub] reusing existing subscription ${subscriptionId} (plan ${planId}, ${bestBytes} spare bytes) — no new subscription needed`);
      }
    }
  } catch (e) {
    console.log(`[AddSub] existing-subscription lookup for plan ${planId} failed, will self-subscribe: ${e.message}`);
  }

  // 2. No reusable subscription — operator self-subscribes (pays the plan price).
  //    Use the operator's own fee-grant grantor for gas if one is configured.
  if (!reused) {
    // Client-signed wallets (Keplr/Privy): the self-subscribe path needs TWO
    // dependent on-chain TXs — MsgStartSubscription, then (after reading the new
    // subscription_id back from its events) MsgShareSubscription. A client wallet
    // can sign exactly one signDoc per HTTP round-trip, so the share could never
    // fire and we'd leave a paid-but-unshared subscription. Fail loudly with an
    // actionable message instead of starting an un-completable flow. The reuse
    // path above is a single share TX and relays fine through the route's catch.
    if (isClientSigned()) {
      const e = new Error(
        `No existing subscription on plan ${planId} can cover this allocation. ` +
        `With a Keplr/Privy wallet, first subscribe to the plan yourself (Subscribe), ` +
        `then add members — sharing from an existing subscription needs only one signature.`
      );
      e.clientSignedTwoTx = true;
      throw e;
    }
    const subMsg = {
      typeUrl: C.MSG_START_SUBSCRIPTION_TYPE,
      value: { from: operator, id: BigInt(planId), denom, renewalPricePolicy: 0 },
    };
    const subGranter = await pickActiveGrantor(operator);
    const subResult = await safeBroadcast([subMsg], undefined, subGranter ? { feeGranter: subGranter } : undefined);
    const subResp = txResponse(subResult);
    if (!subResp.ok) {
      // The chain's rawLog names the exact denom + required-vs-available amount.
      // parseChainError collapses every `insufficient funds` to a generic string,
      // so log the raw line to make the real shortfall (often gas, not P2P)
      // diagnosable instead of guessing.
      console.error(`[AddSub] subscribe failed (plan ${planId}, denom ${denom}, granter ${subGranter || 'none'}): ${subResp.rawLog || `code=${subResp.code}`}`);
      throw new Error(parseChainError(subResp.rawLog) || `subscribe failed code=${subResp.code}`);
    }

    for (const event of (subResp.events || [])) {
      if (/subscription/i.test(event.type)) {
        for (const attr of event.attributes) {
          const k = typeof attr.key === 'string' ? attr.key : Buffer.from(attr.key, 'base64').toString('utf8');
          const v = typeof attr.value === 'string' ? attr.value : Buffer.from(attr.value, 'base64').toString('utf8');
          if (k === 'subscription_id' || k === 'id') subscriptionId = v.replace(/"/g, '');
        }
      }
    }
    if (!subscriptionId) throw new Error('subscribed but could not resolve subscription id from events');
    subTx = subResp.txHash;

    // Read the fresh subscription's granted bytes (the operator's own row).
    try {
      const rpc = await getRpcClient();
      if (rpc) {
        const allocs = await rpcQuerySubscriptionAllocations(rpc, subscriptionId, { limit: 100 });
        const own = allocs.find(a => a.address === operator) || allocs[0];
        if (own) availableBytes = BigInt(own.granted_bytes ?? own.grantedBytes ?? '0');
      }
    } catch (e) {
      console.log(`[AddSub] allocation lookup for sub ${subscriptionId} failed: ${e.message}`);
    }
  }
  if (availableBytes == null || availableBytes <= 0n) {
    throw new Error(`subscription ${subscriptionId} has no allocatable bytes to share`);
  }
  // Share the requested amount, clamped to what the subscription actually holds.
  const shareBytes = requestedBytes > availableBytes ? availableBytes : requestedBytes;
  const bytes = String(shareBytes);

  const shareMsg = {
    typeUrl: C.MSG_SHARE_SUBSCRIPTION_TYPE,
    value: { from: operator, id: BigInt(subscriptionId), accAddress: member, bytes },
  };
  const shareGranter = await pickActiveGrantor(operator);
  const shareResult = await safeBroadcast([shareMsg], undefined, shareGranter ? { feeGranter: shareGranter } : undefined);
  const shareResp = txResponse(shareResult);
  if (!shareResp.ok) {
    console.error(`[AddSub] share failed (sub ${subscriptionId}, ${bytes} bytes, granter ${shareGranter || 'none'}): ${shareResp.rawLog || `code=${shareResp.code}`}`);
    throw new Error(parseChainError(shareResp.rawLog) || `share failed code=${shareResp.code}`);
  }

  return { ok: true, subscriptionId, bytes, reused, subTx, shareTx: shareResp.txHash };
}

app.post('/api/plan/add-subscriber', async (req, res) => {
  if (!requireWallet(req, res)) return;
  try {
    const { planId, address, denom, allocBytes } = req.body;
    if (!planId) return res.status(400).json({ error: 'planId required' });
    if (!address || !String(address).startsWith('sent1')) {
      return res.status(400).json({ error: 'valid sent1... address required' });
    }
    console.log(`Adding subscriber ${address} to plan ${planId} via self-subscribe + share...`);
    const result = await _addSubscriberViaShare(parseInt(planId), address, { denom, allocBytes });
    console.log(`Added ${address}: sub=${result.subscriptionId} subTx=${result.subTx} shareTx=${result.shareTx}`);
    invalidatePlanSubs(parseInt(planId, 10));
    res.json(result);
  } catch (err) {
    if (relayKeplrSign(err, res)) return;
    if (err.clientSignedTwoTx) return res.status(400).json({ error: err.message, needSubscription: true });
    console.error('Add subscriber error:', err.message);
    res.status(500).json({ error: parseChainError(err.message) });
  }
});

app.post('/api/plan/add-subscribers', async (req, res) => {
  if (!requireWallet(req, res)) return;
  try {
    const { planId, addresses, denom, allocBytes } = req.body;
    if (!planId) return res.status(400).json({ error: 'planId required' });
    const list = Array.isArray(addresses)
      ? addresses.map(a => String(a).trim()).filter(a => a.startsWith('sent1'))
      : [];
    if (!list.length) return res.status(400).json({ error: 'addresses[] with valid sent1... entries required' });

    // Client-signed wallets (Keplr/Privy): the server holds no key, so it can't
    // run the per-address subscribe+share loop below (each address needs its own
    // signature, and a self-subscribe needs two dependent TXs). Instead, build a
    // single share msg per address from an EXISTING reusable subscription and
    // bundle them all into ONE signDoc to relay. Any address that would require a
    // new (paid) subscription is reported back so the operator can subscribe
    // first — sharing then needs only one signature.
    if (isClientSigned()) {
      const planNum = parseInt(planId, 10);
      const shareMsgs = [];
      const needSubscription = [];
      for (const addr of list) {
        try {
          const msg = await buildReuseShareMsgOrNull(planNum, addr, { allocBytes });
          if (msg) shareMsgs.push(msg);
          else needSubscription.push(addr);
        } catch (e) {
          needSubscription.push(addr);
          console.log(`[add-subscribers] reuse-share build for ${addr} failed: ${e.message}`);
        }
      }
      if (!shareMsgs.length) {
        return res.status(400).json({
          error: `No existing subscription on plan ${planNum} can cover these allocations. ` +
            `With a Keplr/Privy wallet, subscribe to the plan yourself first, then add members.`,
          needSubscription,
        });
      }
      // Stash the addresses that couldn't be bundled so the relay caller can see
      // them — relayBundledOrNull writes the signDoc response, so attach via a
      // header the frontend ignores but logs surface.
      if (needSubscription.length) {
        console.log(`[add-subscribers] ${needSubscription.length} address(es) need a new subscription, not bundled: ${needSubscription.join(', ')}`);
      }
      if (await relayBundledOrNull(shareMsgs, res, `Share to ${shareMsgs.length} members of plan ${planNum}`)) return;
    }

    const results = [];
    // Sequential — each address needs its own subscribe+share, and back-to-back
    // signing from one wallet must serialize to avoid account-sequence collisions.
    for (const addr of list) {
      try {
        const r = await _addSubscriberViaShare(parseInt(planId), addr, { denom, allocBytes });
        results.push({ address: addr, ok: true, subscriptionId: r.subscriptionId, reused: r.reused, subTx: r.subTx, shareTx: r.shareTx });
      } catch (e) {
        results.push({ address: addr, ok: false, error: parseChainError(e.message) });
      }
    }
    invalidatePlanSubs(parseInt(planId, 10));
    const added = results.filter(r => r.ok).length;
    res.json({ ok: added > 0, added, failed: results.length - added, results });
  } catch (err) {
    if (relayKeplrSign(err, res)) return;
    console.error('Add subscribers (bulk) error:', err.message);
    res.status(500).json({ error: parseChainError(err.message) });
  }
});

app.post('/api/plan/start-session', async (req, res) => {
  if (!requireWallet(req, res)) return;
  try {
    const { subscriptionId, nodeAddress } = req.body;
    if (!subscriptionId || !nodeAddress) return res.status(400).json({ error: 'subscriptionId and nodeAddress required' });

    const subIdNum = parseInt(subscriptionId, 10);
    if (!Number.isFinite(subIdNum) || subIdNum <= 0) return res.status(400).json({ error: 'subscriptionId must be a positive integer' });
    if (!NODE_ADDR_RE.test(nodeAddress)) return res.status(400).json({ error: 'invalid node address' });

    const msg = {
      typeUrl: C.MSG_SUB_START_SESSION_TYPE,
      value: {
        from: getAddr(),
        id: BigInt(subIdNum),
        nodeAddress,
      },
    };

    const feeGranter = await pickActiveGrantor(getAddr());
    console.log(`Starting session on subscription ${subscriptionId} with node ${nodeAddress} (v3)${feeGranter ? ` — gas paid by grant from ${feeGranter}` : ''}...`);
    const result = await safeBroadcast([msg], undefined, feeGranter ? { feeGranter } : undefined);
    const resp = txResponse(result);
    if (resp.ok) {
      let sessionId = null;
      for (const event of (resp.events || [])) {
        if (/session/i.test(event.type)) {
          for (const attr of event.attributes) {
            const k = typeof attr.key === 'string' ? attr.key : Buffer.from(attr.key, 'base64').toString('utf8');
            const v = typeof attr.value === 'string' ? attr.value : Buffer.from(attr.value, 'base64').toString('utf8');
            if (k === 'session_id' || k === 'id') {
              const parsed = v.replace(/"/g, '');
              if (parsed && parseInt(parsed) > 0) sessionId = parsed;
            }
          }
        }
      }
      resp.sessionId = sessionId;
      console.log(`Session started: session_id=${sessionId} tx=${resp.txHash}`);
      res.json(resp);
    } else {
      console.log(`Start session FAIL: code=${resp.code} ${resp.rawLog}`);
      res.status(400).json({ ...resp, error: parseChainError(resp.rawLog) });
    }
  } catch (err) {
    if (relayKeplrSign(err, res)) return;
    console.error('Start session error:', err.message);
    res.status(500).json({ error: parseChainError(err.message) });
  }
});

// ─── Routes: Nodes ────────────────────────────────────────────────────────────

app.get('/api/nodes/progress', (req, res) => {
  res.json({ scanning: nodeCache.scanning, ...scanProgress });
});

// Chain-active node count (status=1). Cached 60s — cheap RPC call, LCD fallback.
let chainCountCache = { count: null, ts: 0 };
const CHAIN_COUNT_TTL = 60_000;

app.get('/api/nodes/chain-count', async (req, res) => {
  const now = Date.now();
  if (chainCountCache.count !== null && (now - chainCountCache.ts) < CHAIN_COUNT_TTL) {
    return res.json({ count: chainCountCache.count, cached: true });
  }
  try {
    const rpc = await getRpcClient();
    if (rpc) {
      const nodes = await rpcQueryNodes(rpc, { status: 1, limit: 10000 });
      chainCountCache = { count: nodes.length, ts: now };
      return res.json({ count: nodes.length, cached: false });
    }
  } catch (err) {
    if (relayKeplrSign(err, res)) return;
    console.log(`[RPC] chain-count failed (${err.message}), falling back to LCD`);
  }
  try {
    const r = await lcd('/sentinel/node/v3/nodes?status=1&pagination.limit=5000');
    const count = (r.nodes || []).length;
    chainCountCache = { count, ts: now };
    res.json({ count, cached: false });
  } catch (err) {
    if (relayKeplrSign(err, res)) return;
    res.status(500).json({ error: err.message });
  }
});

// ─── Node hardware specs (external probe) ────────────────────────────────────
// CPU / download speed / RAM aren't on chain — a NorseLabs webhook returns a
// hardware probe keyed by the sentnode address. On a hit it's
//   { cpu:{brand}, network:{download_speed}, ram:{size}, ... }
// and on a miss it's { error:"notFound" } (still HTTP 200). We surface
// cpu.brand → CPU, network.download_speed → Speed, ram.size → RAM. Results are
// cached per address (hits long, misses short) so paging back and forth and the
// frontend's background revalidation don't re-hit the webhook for every row.
const NODE_SPECS_WEBHOOK = 'https://n8n.norselabs.dev/webhook/cqap';
const NODE_SPECS_TTL = 6 * 60 * 60 * 1000;   // 6h — hardware rarely changes
const NODE_SPECS_MISS_TTL = 30 * 60 * 1000;  // 30m — re-probe a not-yet-probed node soon
const NODE_SPECS_FETCH_TIMEOUT = 4000;       // per-probe ceiling
const NODE_SPECS_BATCH_CEILING = 5000;       // overall enrichment ceiling per page
const _nodeSpecsCache = new Map();           // address → { specs, expires }

// download_speed is bytes/sec (the probe reports data quantities in bytes —
// ram.size is bytes, not bits), so ×8 → bits, /1e6 → Mbps. If the displayed
// speeds ever read ~8× off, this single line is the unit to flip.
function specBytesPerSecToMbps(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round((n * 8) / 1e5) / 10; // Mbps, 1 decimal
}

// "Intel(R) Xeon(R) Gold 6138 CPU @ 2.00GHz" → "Intel Xeon Gold 6138". Strip the
// (R)/(TM) marks, the "CPU @ x.xxGHz" / "Processor" / "NN-Core" filler, collapse
// whitespace — a 60–140px column can't show the raw string, so trim it to the
// model identifier (the full cleaned brand still rides along as a tooltip).
function specCleanCpuBrand(brand) {
  if (typeof brand !== 'string' || !brand.trim()) return null;
  const cleaned = brand
    .replace(/\((?:R|TM)\)/gi, ' ')
    .replace(/\bCPU\b/gi, ' ')
    .replace(/\bProcessor\b/gi, ' ')
    .replace(/@.*$/, ' ')
    .replace(/\b\d+-Core\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || brand.trim();
}

function specFormatRamBytes(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  const gb = n / 1e9;
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1).replace(/\.0$/, '')} GB`;
  return `${Math.round(n / 1e6)} MB`;
}

const EMPTY_SPECS = { cpu: null, speedMbps: null, ram: null, ramBytes: null };

// One webhook probe for a single node. Resolves to { specs, cacheable } so the
// caller can cache real answers (hit/notFound) but NOT transient failures — a
// webhook blip shouldn't blank a node's specs for the full miss TTL.
async function fetchNodeSpecsRaw(address) {
  const url = `${NODE_SPECS_WEBHOOK}?address=${encodeURIComponent(address)}`;
  let data;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(NODE_SPECS_FETCH_TIMEOUT) });
    if (!r.ok) return { specs: EMPTY_SPECS, cacheable: false };
    data = await r.json();
  } catch (e) {
    return { specs: EMPTY_SPECS, cacheable: false }; // timeout / network — don't cache
  }
  if (!data || data.error) return { specs: EMPTY_SPECS, cacheable: true, ttl: NODE_SPECS_MISS_TTL };
  const ramBytes = Number(data.ram?.size);
  return {
    specs: {
      cpu: specCleanCpuBrand(data.cpu?.brand),
      speedMbps: specBytesPerSecToMbps(data.network?.download_speed),
      ram: specFormatRamBytes(data.ram?.size),
      ramBytes: Number.isFinite(ramBytes) && ramBytes > 0 ? ramBytes : null,
    },
    cacheable: true,
    ttl: NODE_SPECS_TTL,
  };
}

// Cached per-address spec lookup. Returns EMPTY_SPECS for anything unknown so
// the UI renders "—" exactly as before.
async function getNodeSpecs(address) {
  if (typeof address !== 'string' || !address.startsWith('sentnode1')) return EMPTY_SPECS;
  const now = Date.now();
  const hit = _nodeSpecsCache.get(address);
  if (hit && hit.expires > now) return hit.specs;
  const { specs, cacheable, ttl } = await fetchNodeSpecsRaw(address);
  if (cacheable) _nodeSpecsCache.set(address, { specs, expires: now + ttl });
  return specs;
}

// Attach specs to the visible page in parallel, best-effort. Bounded by an
// overall ceiling: nodes whose probe is still in flight when the ceiling fires
// keep null specs (UI shows "—") and get filled on the next load once the probe
// has populated the cache. Never throws — enrichment failure must not break the
// node list.
async function enrichNodesWithSpecs(nodes) {
  if (!Array.isArray(nodes) || !nodes.length) return;
  const work = Promise.allSettled(nodes.map(async (n) => {
    const s = await getNodeSpecs(n.address);
    n.cpu = s.cpu;
    n.speedMbps = s.speedMbps;
    n.ram = s.ram;
    n.ramBytes = s.ramBytes;
  }));
  await Promise.race([
    work,
    new Promise((resolve) => setTimeout(resolve, NODE_SPECS_BATCH_CEILING)),
  ]);
}

app.get('/api/all-nodes', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1'));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '50')));
    const search = (req.query.search || '').toLowerCase();
    const planId = req.query.planId ? parseInt(req.query.planId) : null;
    const country = (req.query.country || '').toLowerCase();
    const protocol = (req.query.protocol || '').toLowerCase();
    const inPlanOnly = req.query.inPlanOnly === 'true';
    // Default behaviour for the Add Nodes browser: hide nodes already linked to
    // the current plan so the user never has to scroll past rows they can't act
    // on. The client opts in via excludeInPlan=true; legacy callers (your-nodes,
    // pricing tab) get the old behaviour.
    const excludeInPlan = req.query.excludeInPlan === 'true';

    const all = await fetchAllNodes();

    let planNodeMap = new Map();
    if (planId) {
      try {
        const planNodes = await getNodesForPlan(planId);
        for (const n of planNodes) planNodeMap.set(n.address, n);
      } catch (err) {
        // Read-only chain query — never produces KEPLR_SIGN_REQUIRED. Soft-fail.
        console.error(`Failed to fetch nodes for plan ${planId}:`, err.message);
      }
    }

    // Nodes we already hold an active lease on. Plan membership (planNodeMap)
    // and a lease are SEPARATE on-chain objects: a node we leased but whose
    // link half failed is NOT a plan member, so planNodeMap alone wouldn't hide
    // it and it kept reappearing in Add Nodes (where re-adding fails with "Lease
    // already exists"). One provider-wide lease query (cheap — a provider holds
    // few leases) lets us exclude every node we already lease. Only fetched for
    // the Add Nodes browser (excludeInPlan); legacy callers skip the cost.
    const leasedAddrs = new Set();
    if (excludeInPlan) {
      try {
        const rpc = await getRpcClient();
        if (rpc) {
          const now = Date.now();
          const leases = await rpcQueryLeasesForProvider(rpc, getProvAddr());
          for (const l of leases) {
            if (l.node_address && (!l.expires_at || new Date(l.expires_at).getTime() > now)) {
              leasedAddrs.add(l.node_address);
            }
          }
        }
      } catch (err) {
        // Best-effort: a lease-query failure just falls back to plan-membership
        // exclusion only. Never block the browse list on it.
        console.error('Leases-for-provider exclusion query failed:', err.message);
      }
    }

    let filtered = all;
    // Hide already-linked AND already-leased nodes BEFORE other filters so
    // pagination / counts / country tally all reflect the browseable set the
    // user actually sees. Without this, page 1 could be half-empty after the
    // client strips inPlan rows post-fetch.
    if (excludeInPlan && (planNodeMap.size || leasedAddrs.size)) {
      filtered = filtered.filter(n => !planNodeMap.has(n.address) && !leasedAddrs.has(n.address));
    }
    if (search) filtered = filtered.filter(n => n.address.toLowerCase().includes(search) || (n.moniker || '').toLowerCase().includes(search));
    // Exact country match — `.includes()` matches "Korea" against both Koreas
    // and "Guinea" against "Equatorial Guinea". The dropdown sends full names,
    // so an exact compare is correct and avoids surprise hits.
    if (country) filtered = filtered.filter(n => (n.country || '').toLowerCase() === country);
    if (protocol) filtered = filtered.filter(n => (n.protocol || '').toLowerCase() === protocol);
    if (inPlanOnly && planId) {
      const cachedAddrs = new Set(filtered.map(n => n.address));
      filtered = filtered.filter(n => planNodeMap.has(n.address));
      // For plan-linked nodes missing from the SDK probe cache, probe the
      // node's /status endpoint directly so moniker/country/city/protocol
      // populate immediately instead of showing as null.
      const missing = [];
      for (const [addr, pn] of planNodeMap) {
        if (!cachedAddrs.has(addr)) missing.push([addr, pn]);
      }
      // 3s per probe, 4s overall ceiling — never let a dead node block the tab.
      const probeWithTimeout = (url) => Promise.race([
        nodeStatusV3(url),
        new Promise((_, rej) => setTimeout(() => rej(new Error('probe timeout')), 3000)),
      ]);
      const batch = Promise.allSettled(missing.map(([, pn]) =>
        pn.remoteUrl ? probeWithTimeout(pn.remoteUrl) : Promise.reject(new Error('no remoteUrl'))
      ));
      const probes = await Promise.race([
        batch,
        new Promise((resolve) => setTimeout(() => resolve(missing.map(() => ({ status: 'rejected', reason: 'batch timeout' }))), 4000)),
      ]);
      missing.forEach(([addr, pn], i) => {
        const r = probes[i];
        const ok = r.status === 'fulfilled' && r.value;
        const s = ok ? r.value : null;
        filtered.push({
          address: addr,
          moniker: s?.moniker || null,
          country: s?.location?.country || null,
          city: s?.location?.city || null,
          protocol: s?.type || null,
          speedMbps: null,
          hrPriceUdvpn: pn.hourlyPrices?.find(p => p.denom === 'udvpn')?.quote_value ? parseInt(pn.hourlyPrices.find(p => p.denom === 'udvpn').quote_value) : null,
          gbPriceUdvpn: pn.gigabytePrices?.find(p => p.denom === 'udvpn')?.quote_value ? parseInt(pn.gigabytePrices.find(p => p.denom === 'udvpn').quote_value) : null,
          remoteUrl: pn.remoteUrl || null,
          status: pn.status || 'unknown',
          notInCache: !ok,
        });
      });
    }

    const withStatus = filtered.map(n => {
      const planNode = planNodeMap.get(n.address);
      // leaseExpiresAt is the REAL lease expiry (start_at + hours from the
      // sentinel.lease.v1 lease), not the node's ~1h liveness window.
      return { ...n, inPlan: !!planNode, leaseExpiresAt: planNode?.leaseExpiresAt || null };
    });

    // Country/protocol facets reflect the *browseable* set so the dropdown
    // never offers a country that has zero rows to show. When excludeInPlan is
    // on we drop plan-linked nodes from the facet pool too. Search/country
    // selections are NOT applied here — that would empty the dropdowns once a
    // user picks a value.
    const facetPool = (excludeInPlan && (planNodeMap.size || leasedAddrs.size))
      ? all.filter(n => !planNodeMap.has(n.address) && !leasedAddrs.has(n.address))
      : all;
    const countries = [...new Set(facetPool.map(n => n.country).filter(Boolean))].sort();
    const protocols = [...new Set(facetPool.map(n => n.protocol).filter(Boolean))].sort();
    const countryCounts = {};
    for (const n of facetPool) {
      if (!n.country) continue;
      countryCounts[n.country] = (countryCounts[n.country] || 0) + 1;
    }

    const start = (page - 1) * limit;
    const paged = withStatus.slice(start, start + limit);

    // Fill CPU / Speed / RAM for the rows actually being returned (≤ limit), from
    // the hardware-probe webhook. Best-effort and cached per address — see
    // enrichNodesWithSpecs. paged entries are fresh {...n} objects (from
    // withStatus), so mutating them never touches the underlying node cache.
    await enrichNodesWithSpecs(paged);

    res.json({
      nodes: paged,
      total: filtered.length,
      page,
      totalPages: Math.ceil(filtered.length / limit),
      planNodesCount: planNodeMap.size,
      countries,
      countryCounts,
      protocols,
    });
  } catch (err) {
    if (relayKeplrSign(err, res)) return;
    res.status(500).json({ error: parseChainError(err.message) });
  }
});

app.get('/api/nodes/:addr/sessions', async (req, res) => {
  try {
    const addr = req.params.addr;
    // Validate the node address before scanning. Without this a malformed/empty
    // addr triggers the full 50-page LCD walk below (up to 25k sessions) only to
    // match nothing — a cheap way to hammer the LCD endpoints. Node addresses are
    // bech32 with the `sentnode` prefix (distinct from account `sent1` addresses).
    if (typeof addr !== 'string' || !/^sentnode1[02-9ac-hj-np-z]{38,}$/.test(addr)) {
      return res.status(400).json({ error: 'valid sentnode1... node address required' });
    }
    const allSessions = [];
    let nextKey = undefined;
    let pages = 0;

    do {
      // No chain-wide RPC sessions query — LCD only
      const keyParam = nextKey ? `&pagination.key=${encodeURIComponent(nextKey)}` : '';
      const d = await lcd(`/sentinel/session/v3/sessions?pagination.limit=500${keyParam}`);
      for (const s of d.sessions || []) {
        if (s.base_session?.node_address === addr) {
          allSessions.push(s);
        }
      }
      nextKey = d.pagination?.next_key || null;
      pages++;
    } while (nextKey && pages < 50);

    res.json({ sessions: allSessions, total: allSessions.length });
  } catch (err) {
    if (relayKeplrSign(err, res)) return;
    res.status(500).json({ error: parseChainError(err.message) });
  }
});

// ─── Routes: Leases ───────────────────────────────────────────────────────────

app.post('/api/plan-manager/link', async (req, res) => {
  if (!requireWallet(req, res)) return;
  try {
    const { planId, nodeAddress, leaseHours: reqLeaseHours } = req.body;
    if (!planId || !nodeAddress) return res.status(400).json({ error: 'Plan ID and node address are required' });

    const planIdNum = parseInt(planId, 10);
    if (!Number.isFinite(planIdNum) || planIdNum <= 0) return res.status(400).json({ error: 'planId must be a positive integer' });
    if (!NODE_ADDR_RE.test(nodeAddress)) return res.status(400).json({ error: 'invalid node address' });

    const ownErr = await assertPlanOwnership(planIdNum);
    if (ownErr) return res.status(ownErr.status).json({ error: ownErr.error });
    // Drop the cached plan-nodes snapshot so the next /api/all-nodes refetch
    // re-queries chain truth instead of serving a pre-link cache (TTL 15s).
    invalidatePlanNodes(planIdNum);

    const linkMsg = {
      typeUrl: C.MSG_LINK_TYPE,
      value: { from: getProvAddr(), id: BigInt(planIdNum), nodeAddress },
    };

    const hours = parseInt(reqLeaseHours) || 24;
    console.log(`\n[LINK] Node ${nodeAddress} → plan ${planId} (lease: ${hours}h)`);

    // Linking a node requires an active lease for it first. The old flow tried
    // link → caught "lease not found" → auto-leased → retried link, all as
    // SEPARATE TXs. That only works when the SERVER signs (mnemonic/Privy): on
    // Keplr the very first safeBroadcast throws KEPLR_SIGN_REQUIRED before the
    // chain is ever touched, so the server never learns a lease is missing — it
    // relays the bare link signDoc, the chain rejects it ("No active lease"),
    // and broadcast-signed has no retry. Fix: BUNDLE [lease, link] into ONE TX.
    // Cosmos runs a TX's messages sequentially in one atomic state transition,
    // so the link sees the lease created by the preceding message. One
    // signature, works for every wallet type, no stranding.
    // Reconcile any EXISTING lease against the requested duration before
    // bundling. On Keplr the [lease, link] bundle is signed client-side, so a
    // duplicate lease msg makes the chain reject the WHOLE TX ("Lease already
    // exists") and the link never lands. Three cases:
    //   • no active lease       → bundle [start, link]
    //   • lease, hours >= wanted → bundle [link] only (already covers it)
    //   • lease, hours <  wanted → bundle [end(old), start, link] — the real
    //     fix for nodes stuck on an old 1h lease that could never upgrade
    //     (a 2nd MsgStartLease is rejected; no MsgRenewLease is registered).
    // Best-effort: a query failure falls back to bundling a fresh lease.
    let existingLease = null;      // our active lease, if any
    try {
      const rpcClient = await getRpcClient();
      if (rpcClient) {
        const myProv = getProvAddr();
        const now = Date.now();
        const leases = await rpcQueryLeasesForNode(rpcClient, nodeAddress);
        existingLease = leases
          .filter(l => l.prov_address === myProv &&
            (!l.expires_at || new Date(l.expires_at).getTime() > now))
          .sort((a, b) => (b.hours || 0) - (a.hours || 0))[0] || null;
      }
    } catch (e) {
      console.log(`[LINK] lease pre-check failed: ${e.message} — proceeding with lease msg`);
    }

    const covered = existingLease && (existingLease.hours || 0) >= hours;
    let endMsg = null;
    if (existingLease && !covered) {
      // Existing lease too short — end it so a fresh full-duration lease lands.
      endMsg = { typeUrl: C.MSG_END_LEASE_TYPE, value: { from: getProvAddr(), id: BigInt(existingLease.id) } };
      console.log(`[LINK] existing lease ${existingLease.hours}h < ${hours}h — ending lease ${existingLease.id} and re-leasing`);
    } else if (covered) {
      console.log(`[LINK] existing lease already covers ${hours}h — linking only`);
    }

    let leaseMsg = null;
    if (!covered) {
      try {
        leaseMsg = await buildLeaseMsg(nodeAddress, hours);
      } catch (le) {
        console.log(`[LINK] Lease msg build failed: ${le.message}`);
        return res.status(400).json({ error: `Auto-lease failed: ${le.message}` });
      }
    }

    // Helper: broadcast a msg array, relaying Keplr sign-required to the client.
    const broadcastOrRelay = async (msgs) => {
      try {
        return { result: await safeBroadcast(msgs) };
      } catch (err) {
        if (relayKeplrSign(err, res)) return { relayed: true };
        return { err };
      }
    };

    // Order matters: end stale lease → start fresh → link, all atomic.
    const bundle = [...(endMsg ? [endMsg] : []), ...(leaseMsg ? [leaseMsg] : []), linkMsg];
    console.log(`[LINK] Step 1: Bundled [${endMsg ? 'end, ' : ''}${leaseMsg ? 'lease, ' : ''}link] in one TX...`);
    let out = await broadcastOrRelay(bundle);
    if (out.relayed) return; // Keplr will sign the bundled TX client-side
    if (out.err) {
      const msg = out.err.message || '';
      console.log(`[LINK] Bundled TX threw: ${msg.slice(0, 150)}`);
      if (isDuplicateNode(msg)) return res.json({ ok: true, alreadyLinked: true, msg: 'Node is already in this plan' });
      // A pre-existing lease makes the bundled lease msg fail with "already
      // exists" — fall back to a link-only TX (lease is already there).
      if (msg.includes('already exists')) {
        console.log(`[LINK] Lease already exists — retrying link-only...`);
        out = await broadcastOrRelay([linkMsg]);
        if (out.relayed) return;
        if (out.err) return res.status(400).json({ error: parseChainError(out.err.message) });
      } else {
        return res.status(400).json({ error: parseChainError(msg) });
      }
    }

    let resp = txResponse(out.result);

    if (!resp.ok) {
      const raw = resp.rawLog || '';
      console.log(`[LINK] TX failed in rawLog: ${raw.slice(0, 150)}`);
      if (isDuplicateNode(raw)) return res.json({ ok: true, alreadyLinked: true, msg: 'Node is already in this plan' });
      // Bundled TX rejected because the lease already existed — retry link-only.
      if (raw.includes('already exists')) {
        console.log(`[LINK] Lease already exists (rawLog) — retrying link-only...`);
        const out2 = await broadcastOrRelay([linkMsg]);
        if (out2.relayed) return;
        if (out2.err) return res.status(400).json({ error: parseChainError(out2.err.message) });
        const resp2 = txResponse(out2.result);
        if (resp2.ok) { console.log(`[LINK] OK (link-only): tx=${resp2.txHash}`); return res.json(resp2); }
        if (isDuplicateNode(resp2.rawLog)) return res.json({ ok: true, alreadyLinked: true, msg: 'Node is already in this plan' });
        console.log(`[LINK] Still failed link-only: ${(resp2.rawLog || '').slice(0, 150)}`);
        return res.status(400).json({ error: parseChainError(resp2.rawLog) });
      }
      return res.status(400).json({ error: parseChainError(raw) });
    }

    console.log(`[LINK] OK (bundled lease+link): tx=${resp.txHash}`);
    res.json(resp);
  } catch (err) {
    if (relayKeplrSign(err, res)) return;
    console.error('Link error:', err.message);
    res.status(500).json({ error: parseChainError(err.message) });
  }
});

app.post('/api/plan-manager/batch-link', async (req, res) => {
  if (!requireWallet(req, res)) return;
  try {
    const { planId, nodeAddresses, leaseHours: reqLeaseHours } = req.body;
    if (!planId || !nodeAddresses || !Array.isArray(nodeAddresses) || nodeAddresses.length === 0) {
      return res.status(400).json({ error: 'planId and nodeAddresses[] required' });
    }
    const planIdNum = parseInt(planId, 10);
    if (!Number.isFinite(planIdNum) || planIdNum <= 0) return res.status(400).json({ error: 'planId must be a positive integer' });
    const addrs = [...new Set(nodeAddresses)];
    const badAddr = addrs.find(a => !NODE_ADDR_RE.test(a));
    if (badAddr) return res.status(400).json({ error: `invalid node address: ${badAddr}` });
    const ownErr = await assertPlanOwnership(planIdNum);
    if (ownErr) return res.status(ownErr.status).json({ error: ownErr.error });
    const hours = parseInt(reqLeaseHours) || 24;
    invalidatePlanNodes(planIdNum);
    console.log(`\n[BATCH-LINK] ${addrs.length} nodes → plan ${planId} (lease: ${hours}h)`);


    const linkMsgs = addrs.map(addr => ({
      typeUrl: C.MSG_LINK_TYPE,
      value: { from: getProvAddr(), id: BigInt(planIdNum), nodeAddress: addr },
    }));

    // Same Keplr-safe pattern as single link: BUNDLE [...leases, ...links] into
    // ONE TX so the links see their leases in the same atomic state transition.
    // The server can't do a "try link → lease → retry" dance on Keplr because
    // the first safeBroadcast throws KEPLR_SIGN_REQUIRED before touching chain.
    let leaseMsgs;
    try {
      leaseMsgs = await buildLeaseMsgs(addrs, hours);
    } catch (le) {
      console.log(`[BATCH-LINK] Lease msg build failed: ${le.message}`);
      return res.status(400).json({ error: `Batch lease failed: ${le.message}` });
    }

    const broadcastOrRelay = async (msgs) => {
      try {
        return { result: await safeBroadcast(msgs) };
      } catch (err) {
        if (relayKeplrSign(err, res)) return { relayed: true };
        return { err };
      }
    };

    console.log(`[BATCH-LINK] Step 1: Bundled [${leaseMsgs.length} leases, ${linkMsgs.length} links] in one TX...`);
    let out = await broadcastOrRelay([...leaseMsgs, ...linkMsgs]);
    if (out.relayed) return; // Keplr signs the bundled TX client-side
    if (out.err) {
      const msg = out.err.message || '';
      console.log(`[BATCH-LINK] Bundled TX threw: ${msg.slice(0, 200)}`);
      if (isDuplicateNode(msg)) return res.json({ ok: true, linked: 0, alreadyLinked: addrs.length, msg: 'All nodes already in plan' });
      // Some/all leases already exist — retry links-only.
      if (msg.includes('already exists')) {
        console.log(`[BATCH-LINK] Some leases already exist — retrying links-only...`);
        out = await broadcastOrRelay(linkMsgs);
        if (out.relayed) return;
        if (out.err) return res.status(400).json({ error: parseChainError(out.err.message) });
      } else {
        return res.status(400).json({ error: parseChainError(msg) });
      }
    }

    let resp = txResponse(out.result);

    if (!resp.ok) {
      const raw = resp.rawLog || '';
      console.log(`[BATCH-LINK] TX failed: ${raw.slice(0, 200)}`);
      if (isDuplicateNode(raw)) return res.json({ ok: true, linked: 0, alreadyLinked: addrs.length, msg: 'Nodes already in plan' });
      if (raw.includes('already exists')) {
        console.log(`[BATCH-LINK] Leases already exist (rawLog) — retrying links-only...`);
        const out2 = await broadcastOrRelay(linkMsgs);
        if (out2.relayed) return;
        if (out2.err) return res.status(400).json({ error: parseChainError(out2.err.message) });
        const resp2 = txResponse(out2.result);
        if (resp2.ok) { console.log(`[BATCH-LINK] OK (links-only): tx=${resp2.txHash}`); return res.json({ ...resp2, linked: addrs.length }); }
        if (isDuplicateNode(resp2.rawLog)) return res.json({ ok: true, linked: 0, alreadyLinked: addrs.length, msg: 'Nodes already in plan' });
        console.log(`[BATCH-LINK] Still failed links-only: ${(resp2.rawLog || '').slice(0, 150)}`);
        return res.status(400).json({ error: parseChainError(resp2.rawLog) });
      }
      return res.status(400).json({ error: parseChainError(raw) });
    }

    console.log(`[BATCH-LINK] OK (bundled lease+link): ${addrs.length} nodes linked, tx=${resp.txHash}`);
    res.json({ ...resp, linked: addrs.length });
  } catch (err) {
    if (relayKeplrSign(err, res)) return;
    console.error('[BATCH-LINK] Error:', err.message);
    res.status(500).json({ error: parseChainError(err.message) });
  }
});

app.post('/api/plan-manager/unlink', async (req, res) => {
  if (!requireWallet(req, res)) return;
  try {
    const { planId, nodeAddress } = req.body;
    if (!planId || !nodeAddress) return res.status(400).json({ error: 'Plan ID and node address are required' });

    const planIdNum = parseInt(planId, 10);
    if (!Number.isFinite(planIdNum) || planIdNum <= 0) return res.status(400).json({ error: 'planId must be a positive integer' });
    if (!NODE_ADDR_RE.test(nodeAddress)) return res.status(400).json({ error: 'invalid node address' });

    const ownErr = await assertPlanOwnership(planIdNum);
    if (ownErr) return res.status(ownErr.status).json({ error: ownErr.error });
    invalidatePlanNodes(planIdNum);

    const msg = {
      typeUrl: C.MSG_UNLINK_TYPE,
      value: { from: getProvAddr(), id: BigInt(planIdNum), nodeAddress },
    };

    console.log(`Unlinking node ${nodeAddress} from plan ${planId}...`);
    let result;
    try {
      result = await safeBroadcast([msg]);
    } catch (err) {
      if (relayKeplrSign(err, res)) return;
      const m = err.message || '';
      if (m.includes('does not exist') || m.includes('not found')) {
        return res.json({ ok: true, alreadyUnlinked: true, msg: 'Node was already removed from this plan' });
      }
      return res.status(400).json({ error: parseChainError(m) });
    }

    const resp = txResponse(result);
    if (resp.ok) {
      console.log(`Unlinked OK: tx=${resp.txHash}`);
      res.json(resp);
    } else {
      if (resp.rawLog && (resp.rawLog.includes('does not exist') || resp.rawLog.includes('not found'))) {
        return res.json({ ok: true, alreadyUnlinked: true, msg: 'Node was already removed' });
      }
      res.status(400).json({ error: parseChainError(resp.rawLog) });
    }
  } catch (err) {
    if (relayKeplrSign(err, res)) return;
    console.error('Unlink error:', err.message);
    res.status(500).json({ error: parseChainError(err.message) });
  }
});

app.post('/api/plan-manager/batch-unlink', async (req, res) => {
  if (!requireWallet(req, res)) return;
  try {
    const { planId, nodeAddresses } = req.body;
    if (!planId || !nodeAddresses || !Array.isArray(nodeAddresses) || nodeAddresses.length === 0) {
      return res.status(400).json({ error: 'planId and nodeAddresses[] required' });
    }
    const planIdNum = parseInt(planId, 10);
    if (!Number.isFinite(planIdNum) || planIdNum <= 0) return res.status(400).json({ error: 'planId must be a positive integer' });
    const addrs = [...new Set(nodeAddresses)];
    const badAddr = addrs.find(a => !NODE_ADDR_RE.test(a));
    if (badAddr) return res.status(400).json({ error: `invalid node address: ${badAddr}` });
    const ownErr = await assertPlanOwnership(planIdNum);
    if (ownErr) return res.status(ownErr.status).json({ error: ownErr.error });
    invalidatePlanNodes(planIdNum);
    console.log(`\n[BATCH-UNLINK] ${addrs.length} nodes from plan ${planId}`);

    const msgs = addrs.map(addr => ({
      typeUrl: C.MSG_UNLINK_TYPE,
      value: { from: getProvAddr(), id: BigInt(planIdNum), nodeAddress: addr },
    }));

    const result = await safeBroadcast(msgs);
    const resp = txResponse(result);
    if (!resp.ok) {
      console.log(`[BATCH-UNLINK] Failed: ${(resp.rawLog || '').slice(0, 200)}`);
      return res.status(400).json({ error: parseChainError(resp.rawLog) });
    }
    console.log(`[BATCH-UNLINK] OK: ${addrs.length} nodes removed, tx=${resp.txHash}`);
    res.json({ ...resp, unlinked: addrs.length });
  } catch (err) {
    if (relayKeplrSign(err, res)) return;
    console.error('[BATCH-UNLINK] Error:', err.message);
    res.status(500).json({ error: parseChainError(err.message) });
  }
});

app.post('/api/lease/start', async (req, res) => {
  if (!requireWallet(req, res)) return;
  try {
    const { nodeAddress, hours, maxPriceDenom, maxPriceBaseValue, maxPriceQuoteValue, renewalPolicy } = req.body;
    if (!nodeAddress) return res.status(400).json({ error: 'nodeAddress required' });

    // The chain rejects any maxPrice that doesn't EXACTLY match an entry in the
    // node's hourly_prices array. Look up the node first and pass its current
    // price through verbatim, unless the caller explicitly overrides it.
    // Sentinel lease module rejects a maxPrice that isn't an EXACT match for an
    // entry in the node's hourly_prices array (denom + base_value + quote_value
    // all identical). RPC-first lookup of the node's current price.
    let nodePrice = null;
    try {
      const rpcClient = await getRpcClient();
      const node = await rpcQueryNode(rpcClient, nodeAddress);
      const prices = node?.hourly_prices || node?.hourlyPrices;
      if (Array.isArray(prices) && prices.length) {
        const denom = maxPriceDenom || 'udvpn';
        nodePrice = prices.find((p) => p.denom === denom) || prices[0];
      }
    } catch (err) {
      // Read-only RPC node lookup — never KEPLR_SIGN_REQUIRED. Soft-fail to nodePrice=null.
      console.log(`[LEASE] RPC node price lookup failed: ${err.message}`);
    }

    if (!nodePrice) {
      return res.status(400).json({
        error: 'Could not fetch node price from chain — node may be offline or unreachable',
      });
    }

    const baseValue = nodePrice.base_value ?? nodePrice.baseValue;
    const quoteValue = String(nodePrice.quote_value ?? nodePrice.quoteValue);
    console.log(`[LEASE] Node price: ${nodePrice.denom} base=${baseValue} quote=${quoteValue}`);

    const msg = {
      typeUrl: C.MSG_START_LEASE_TYPE,
      value: {
        from: getProvAddr(),
        nodeAddress,
        hours: parseInt(hours || 720),
        maxPrice: {
          denom: nodePrice.denom,
          base_value: baseValue,
          quote_value: quoteValue,
        },
        renewalPricePolicy: parseInt(renewalPolicy || 7),
      },
    };

    console.log(`Starting lease with ${nodeAddress} for ${hours || 720}h (v1)...`);
    const result = await safeBroadcast([msg]);
    const resp = txResponse(result);
    if (resp.ok) {
      let leaseId = null;
      for (const event of (resp.events || [])) {
        if (/lease/i.test(event.type)) {
          for (const attr of event.attributes) {
            const k = typeof attr.key === 'string' ? attr.key : Buffer.from(attr.key, 'base64').toString('utf8');
            const v = typeof attr.value === 'string' ? attr.value : Buffer.from(attr.value, 'base64').toString('utf8');
            if (k === 'lease_id' || k === 'id') leaseId = v.replace(/"/g, '');
          }
        }
      }
      resp.leaseId = leaseId;
      console.log(`Lease started: id=${leaseId} tx=${resp.txHash}`);
      res.json(resp);
    } else {
      console.log(`Lease start FAIL: code=${resp.code} ${resp.rawLog}`);
      res.status(400).json({ ...resp, error: parseChainError(resp.rawLog) });
    }
  } catch (err) {
    if (relayKeplrSign(err, res)) return;
    console.error('Lease start error:', err.message);
    res.status(500).json({ error: parseChainError(err.message) });
  }
});

app.post('/api/lease/end', async (req, res) => {
  if (!requireWallet(req, res)) return;
  try {
    const { leaseId } = req.body;
    if (!leaseId) return res.status(400).json({ error: 'leaseId required' });

    const leaseIdNum = parseInt(leaseId, 10);
    if (!Number.isFinite(leaseIdNum) || leaseIdNum <= 0) return res.status(400).json({ error: 'leaseId must be a positive integer' });

    const msg = {
      typeUrl: C.MSG_END_LEASE_TYPE,
      value: { from: getProvAddr(), id: BigInt(leaseIdNum) },
    };

    console.log(`Ending lease ${leaseId} (v1)...`);
    const result = await safeBroadcast([msg]);
    const resp = txResponse(result);
    if (resp.ok) {
      console.log(`Lease ended: tx=${resp.txHash}`);
      res.json(resp);
    } else {
      console.log(`Lease end FAIL: code=${resp.code} ${resp.rawLog}`);
      res.status(400).json({ ...resp, error: parseChainError(resp.rawLog) });
    }
  } catch (err) {
    if (relayKeplrSign(err, res)) return;
    console.error('Lease end error:', err.message);
    res.status(500).json({ error: parseChainError(err.message) });
  }
});

// ─── Routes: Provider ─────────────────────────────────────────────────────────

app.get('/api/providers', async (req, res) => {
  try {
    const providers = await cached('providers', 600_000, getProviders);
    res.json({ providers });
  } catch (err) {
    if (relayKeplrSign(err, res)) return;
    res.status(500).json({ error: parseChainError(err.message) });
  }
});

app.post('/api/provider/register', async (req, res) => {
  if (!requireWallet(req, res)) return;
  try {
    const { name, identity, website, description } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });


    let alreadyExists = false;
    // RPC-first: direct lookup by sentprov address — exact match, no substring heuristic.
    try {
      const rpc = await getRpcClient();
      if (rpc) {
        const prov = await rpcQueryProvider(rpc, getProvAddr());
        if (prov) alreadyExists = true;
      }
    } catch (err) {
      // Read-only provider lookup — never KEPLR_SIGN_REQUIRED. Fall through to LCD.
      console.log(`[RPC] provider exists probe failed: ${err.message} — LCD fallback`);
    }
    if (!alreadyExists) {
      try {
        const provs = await lcd('/sentinel/provider/v2/providers?pagination.limit=500');
        alreadyExists = (provs.providers || []).some(p => p.address === getProvAddr());
      } catch (err) {
        // Read-only LCD lookup — never KEPLR_SIGN_REQUIRED. Fall through; treat as not-registered.
        console.error('Failed to check existing providers:', err.message);
      }
    }

    const typeUrl = alreadyExists ? C.MSG_UPDATE_PROVIDER_DETAILS_TYPE : C.MSG_REGISTER_PROVIDER_TYPE;
    const fromAddr = alreadyExists ? getProvAddr() : getAddr();
    const action = alreadyExists ? 'Updating' : 'Registering';
    const msg = {
      typeUrl,
      value: { from: fromAddr, name, identity: identity || '', website: website || '', description: description || '' },
    };

    // Fresh registrations land on chain status=inactive; plans can't be created
    // until the provider is active. BUNDLE the activation into the SAME TX —
    // Cosmos executes a TX's messages sequentially in one atomic state
    // transition, so MsgUpdateProviderStatus(status=1) sees the just-registered
    // provider. getProvAddr() is pure bech32 derivation (no chain query), so
    // the activation msg can be built up-front. One signature, no stranding —
    // this is the ONLY correct shape for the Keplr (client-signs-once) path.
    const msgs = [msg];
    if (!alreadyExists) {
      msgs.push({
        typeUrl: C.MSG_UPDATE_PROVIDER_STATUS_TYPE,
        value: { from: getProvAddr(), status: 1 },
      });
    }

    console.log(`${action} provider "${name}" (v3)${alreadyExists ? '' : ' + activate (bundled)'}...`);
    const result = await safeBroadcast(msgs);
    const resp = txResponse(result);
    resp.action = alreadyExists ? 'updated' : 'registered';
    if (!resp.ok) {
      console.log(`Provider ${action} FAIL: code=${resp.code} ${resp.rawLog}`);
      return res.status(400).json({ ...resp, error: parseChainError(resp.rawLog) });
    }

    // The bundled status msg already activated it (same TX). Mark it so the
    // frontend doesn't try to chain a second activation.
    if (!alreadyExists) {
      resp.activation = { ok: true, txHash: resp.txHash, bundled: true };
      console.log(`Provider registered + activated (bundled): tx=${resp.txHash}`);
    } else {
      console.log(`Provider ${resp.action}: tx=${resp.txHash}`);
    }
    cacheInvalidate(`provider:${getAddr()}`);

    res.json(resp);
  } catch (err) {
    if (relayKeplrSign(err, res)) return;
    console.error('Provider register/update error:', err.message);
    res.status(500).json({ error: parseChainError(err.message) });
  }
});

app.post('/api/provider/status', async (req, res) => {
  if (!requireWallet(req, res)) return;
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'status required (1=active, 2=inactive_pending, 3=inactive)' });

    const statusNum = parseInt(status, 10);
    if (statusNum !== 1 && statusNum !== 2 && statusNum !== 3) return res.status(400).json({ error: 'status must be 1 (active), 2 (inactive_pending), or 3 (inactive)' });

    const msg = {
      typeUrl: C.MSG_UPDATE_PROVIDER_STATUS_TYPE,
      value: { from: getProvAddr(), status: statusNum },
    };

    console.log(`Updating provider status to ${status} (v3)...`);
    const result = await safeBroadcast([msg]);
    const resp = txResponse(result);
    if (resp.ok) {
      console.log(`Provider status updated: tx=${resp.txHash}`);
      cacheInvalidate(`provider:${getAddr()}`);
      res.json(resp);
    } else {
      console.log(`Provider status FAIL: code=${resp.code} ${resp.rawLog}`);
      res.status(400).json({ ...resp, error: parseChainError(resp.rawLog) });
    }
  } catch (err) {
    if (relayKeplrSign(err, res)) return;
    console.error('Provider status error:', err.message);
    res.status(500).json({ error: parseChainError(err.message) });
  }
});

// ─── Routes: Subscriptions ────────────────────────────────────────────────────

app.get('/api/params', async (req, res) => {
  try {
    const result = await cached('chainParams', 1_800_000, async () => {
      const [sub, node, session] = await Promise.all([
        lcd('/sentinel/subscription/v3/params'),
        lcd('/sentinel/node/v3/params'),
        lcd('/sentinel/session/v3/params'),
      ]);
      return { subscription: sub.params, node: node.params, session: session.params };
    });
    res.json(result);
  } catch (err) {
    if (relayKeplrSign(err, res)) return;
    res.status(500).json({ error: parseChainError(err.message) });
  }
});

// ─── Routes: Fee Grants ───────────────────────────────────────────────────────

app.get('/api/feegrant/grants', async (req, res) => {
  if (!getAddr()) return res.status(401).json({ error: 'No wallet loaded' });
  try {
    const d = await cached(`feegrants:${getAddr()}`, 60_000, async () => {
      // RPC-first: rpcQueryFeeGrantsIssued returns the array directly.
      // SDK swallows protobuf decode errors and returns []; we can't distinguish
      // "zero grants" from "decode failed". Fall through to LCD when empty so
      // users see real data if any exists.
      try {
        const rpc = await getRpcClient();
        if (rpc) {
          const rpcResult = await rpcQueryFeeGrantsIssued(rpc, getAddr(), { limit: 10000 });
          if (rpcResult && rpcResult.length > 0) return { allowances: rpcResult };
        }
      } catch (err) {
        // Inside cached() callback — never write to res from here (callers
        // wait on the promise then write). Read-only RPC can't produce
        // KEPLR_SIGN_REQUIRED anyway. Fall through to LCD.
        console.log(`[RPC] feegrant/grants failed: ${err.message} — LCD fallback`);
      }
      return lcd(`/cosmos/feegrant/v1beta1/issued/${getAddr()}?pagination.limit=500`);
    });
    const allowances = (d.allowances || []).map(a => {
      let spendLimit = null, expiration = null, allowanceType = 'unknown';
      const inner = a.allowance || {};
      if (inner['@type']?.includes('BasicAllowance')) {
        allowanceType = 'basic';
        spendLimit = inner.spend_limit || [];
        expiration = inner.expiration || null;
      } else if (inner['@type']?.includes('PeriodicAllowance')) {
        allowanceType = 'periodic';
        spendLimit = inner.basic?.spend_limit || [];
        expiration = inner.basic?.expiration || null;
      } else if (inner['@type']?.includes('AllowedMsgAllowance')) {
        allowanceType = 'allowed_msg';
        const nested = inner.allowance || {};
        spendLimit = nested.spend_limit || nested.basic?.spend_limit || [];
        expiration = nested.expiration || nested.basic?.expiration || null;
      }
      return {
        granter: a.granter,
        grantee: a.grantee,
        allowanceType,
        spendLimit,
        expiration,
        raw: inner,
      };
    });
    res.json({ allowances, total: allowances.length });
  } catch (e) {
    res.status(500).json({ error: parseChainError(e.message) });
  }
});

// Bech32 charset for sent1... addresses (38 chars after prefix).
const SENT_ADDR_RE = /^sent1[02-9ac-hj-np-z]{38}$/i;
// Node operator addresses: sentnode1... (38+ chars after prefix).
const NODE_ADDR_RE = /^sentnode1[02-9ac-hj-np-z]{38,}$/i;
const MAX_GRANT_DVPN = 10; // hard cap per grant

app.post('/api/feegrant/grant', async (req, res) => {
  if (!getAddr()) return res.status(401).json({ error: 'No wallet loaded' });
  const { grantee, spendLimitDvpn, expirationDays } = req.body;
  if (!grantee) return res.status(400).json({ error: 'grantee address required' });
  if (!SENT_ADDR_RE.test(grantee)) return res.status(400).json({ error: 'grantee must be a valid sent1... address' });
  if (spendLimitDvpn !== undefined) {
    if (typeof spendLimitDvpn !== 'number' || !isFinite(spendLimitDvpn) || spendLimitDvpn < 0 || spendLimitDvpn > MAX_GRANT_DVPN) {
      return res.status(400).json({ error: `spendLimitDvpn must be a number between 0 and ${MAX_GRANT_DVPN}` });
    }
  }
  if (expirationDays !== undefined) {
    if (typeof expirationDays !== 'number' || !isFinite(expirationDays) || expirationDays < 0 || expirationDays > 365) {
      return res.status(400).json({ error: 'expirationDays must be a number between 0 and 365' });
    }
  }

  try {
    const opts = {};
    if (spendLimitDvpn && spendLimitDvpn > 0) {
      opts.spendLimit = [{ denom: 'udvpn', amount: String(Math.round(spendLimitDvpn * 1e6)) }];
    }
    if (expirationDays && expirationDays > 0) {
      opts.expiration = new Date(Date.now() + expirationDays * 86400000);
    }
    // Cosmos feegrant rejects MsgGrantAllowance when an allowance for this
    // (granter, grantee) pair already exists ("fee allowance already exists").
    // There is no update message, so re-authorizing means revoke + re-grant.
    // Detect an existing grant and bundle a revoke ahead of the grant in ONE
    // TX so the new spend-limit/expiration replaces the old one atomically.
    let alreadyGranted = false;
    try {
      let existing = [];
      const rpc = await getRpcClient().catch((e) => { console.log(`[grant] rpc client unavailable for grant-check: ${e.message}`); return null; });
      if (rpc) existing = await rpcQueryFeeGrantsIssued(rpc, getAddr(), { limit: 10000 }).catch((e) => { console.log(`[grant] rpc issued-grants check failed: ${e.message}`); return []; });
      if (!existing.length) {
        const d = await lcd(`/cosmos/feegrant/v1beta1/issued/${getAddr()}?pagination.limit=500`).catch((e) => { console.log(`[grant] lcd issued-grants check failed: ${e.message}`); return {}; });
        existing = d.allowances || [];
      }
      alreadyGranted = existing.some(a => a.grantee === grantee);
    } catch (err) {
      // Non-fatal: if the existence check fails, fall through to a plain grant
      // and let the revoke-on-conflict retry below handle a duplicate.
      console.log(`[FeeGrant] existing-grant check failed for ${grantee}: ${err.message}`);
    }

    const grantMsg = buildFeeGrantMsg(getAddr(), grantee, opts);
    const msgs = alreadyGranted
      ? [buildRevokeFeeGrantMsg(getAddr(), grantee), grantMsg]
      : [grantMsg];

    let result;
    try {
      result = await safeBroadcast(msgs, 'Fee grant');
      if (result.code !== 0) throw new Error(result.rawLog || `TX failed code=${result.code}`);
    } catch (e) {
      if (relayKeplrSign(e, res)) return;
      // Race / stale read: grant existed but our check missed it. Retry once as
      // revoke + grant so the operator's re-authorize still succeeds.
      if (!alreadyGranted && /allowance already exists/i.test(e.message || '')) {
        console.log(`[FeeGrant] ${grantee} already granted (raced) — retrying as revoke + grant`);
        result = await safeBroadcast([buildRevokeFeeGrantMsg(getAddr(), grantee), grantMsg], 'Fee grant (re-authorize)');
        if (result.code !== 0) throw new Error(result.rawLog || `TX failed code=${result.code}`);
      } else {
        throw e;
      }
    }
    cacheInvalidate(`feegrants:${getAddr()}`);
    res.json({ ok: true, txHash: result.transactionHash, reauthorized: alreadyGranted });
  } catch (e) {
    // Keplr path: safeBroadcast throws KEPLR_SIGN_REQUIRED before touching the
    // chain — relay the signDoc so the frontend can client-sign, rather than
    // surfacing the raw error to the user.
    if (relayKeplrSign(e, res)) return;
    res.status(500).json({ error: parseChainError(e.message) });
  }
});

// SSE stream: grant fee allowance to all subscribers of a plan
app.get('/api/feegrant/grant-subscribers-stream', async (req, res) => {
  if (!getAddr()) return res.status(401).json({ error: 'No wallet loaded' });
  const { planId, spendLimitDvpn, expirationDays } = req.query;
  if (!planId) return res.status(400).json({ error: 'planId required' });
  const planIdNum = parseInt(planId, 10);
  if (!Number.isFinite(planIdNum) || planIdNum <= 0) {
    return res.status(400).json({ error: 'planId must be a positive integer' });
  }
  // Cap the per-subscriber spend limit BEFORE the SSE stream opens — the POST
  // /api/feegrant/grant path enforces MAX_GRANT_DVPN, but this streaming path
  // bypassed it entirely, letting a crafted query grant an unbounded allowance
  // to every subscriber. Validate here while we can still return a JSON 400.
  if (spendLimitDvpn !== undefined) {
    const lim = parseFloat(spendLimitDvpn);
    if (!Number.isFinite(lim) || lim < 0 || lim > MAX_GRANT_DVPN) {
      return res.status(400).json({ error: `spendLimitDvpn must be a number between 0 and ${MAX_GRANT_DVPN}` });
    }
  }

  // Client-signed wallets (Keplr/Privy) can't use this SSE path: once the
  // stream opens we can no longer return a signDoc for the browser to sign, and
  // an EventSource can't carry a signature back anyway. Refuse here with a JSON
  // 400 (headers not yet written) so the frontend falls back to the POST
  // /api/feegrant/grant-subscribers route, which bundles every grant into one
  // signDoc and relays it for a single client-side signature.
  if (isClientSigned()) {
    return res.status(400).json({
      error: 'Streaming fee-grant is unavailable for Keplr/Privy wallets — use the bundled grant instead.',
      errorCode: 'use-bundled-grant',
    });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const send = (type, data) => {
    const payload = JSON.stringify({ type, ...data });
    res.write(`data: ${payload}\n\n`);
    console.log(`[FeeGrant] ${type}: ${JSON.stringify(data)}`);
  };

  let closed = false;
  req.on('close', () => { closed = true; });

  try {
    send('status', { msg: 'Fetching plan subscribers...' });
    let subs = [];
    let subsFromRpc = false;
    try {
      const rpc = await getRpcClient();
      if (rpc) {
        subs = await rpcQuerySubscriptionsForPlan(rpc, planId, { limit: 10000 });
        subsFromRpc = true;
        console.log(`[RPC] rpcQuerySubscriptionsForPlan plan=${planId} count=${subs.length}`);
      }
    } catch (err) {
      // SSE stream — headers already written; never call relayKeplrSign here.
      // Read-only RPC query also can't produce KEPLR_SIGN_REQUIRED.
      console.log(`[RPC] rpcQuerySubscriptionsForPlan failed: ${err.message}`);
    }
    if (!subsFromRpc) {
      subs = await lcdAllSubscriptions(planId);
    }
    const now = new Date();
    const STATUS_MAP = { 1: 'active', 2: 'inactive_pending', 3: 'inactive' };
    const isActive = s => (s.status === 'active' || s.status === 1 || STATUS_MAP[s.status] === 'active');
    const activeSubs = subs.filter(s => isActive(s) && new Date(s.inactive_at) > now);
    const uniqueAddrs = [...new Set(activeSubs.map(s => s.acc_address))].filter(a => a !== getAddr());

    send('status', { msg: `Found ${activeSubs.length} active subscribers (${uniqueAddrs.length} unique, excl. self)` });

    if (uniqueAddrs.length === 0) {
      send('done', { granted: 0, skipped: 0, msg: 'No active subscribers (excluding self)' });
      res.end();
      return;
    }

    send('status', { msg: 'Checking existing grants...' });
    let existingAllowances = [];
    try {
      const rpc = await getRpcClient();
      if (rpc) {
        existingAllowances = await rpcQueryFeeGrantsIssued(rpc, getAddr(), { limit: 10000 });
        console.log(`[RPC] rpcQueryFeeGrantsIssued granter=${getAddr()} count=${existingAllowances.length}`);
      }
    } catch (err) {
      // SSE stream — headers already written; never call relayKeplrSign here.
      // Read-only RPC query also can't produce KEPLR_SIGN_REQUIRED.
      console.log(`[RPC] rpcQueryFeeGrantsIssued failed: ${err.message}`);
    }
    if (!existingAllowances.length) {
      const existingData = await lcd(`/cosmos/feegrant/v1beta1/issued/${getAddr()}?pagination.limit=500`);
      existingAllowances = existingData.allowances || [];
    }
    const existingGrantees = new Set(existingAllowances.map(a => a.grantee));
    const needGrant = uniqueAddrs.filter(a => !existingGrantees.has(a));
    const skipped = uniqueAddrs.length - needGrant.length;

    send('status', { msg: `${existingGrantees.size} existing grants found. ${needGrant.length} need granting, ${skipped} already covered.` });

    if (needGrant.length === 0) {
      send('done', { granted: 0, skipped, msg: 'All subscribers already have grants' });
      res.end();
      return;
    }

    const opts = {};
    const limitNum = parseFloat(spendLimitDvpn) || 0;
    const expNum = parseInt(expirationDays) || 0;
    if (limitNum > 0) {
      opts.spendLimit = [{ denom: 'udvpn', amount: String(Math.round(limitNum * 1e6)) }];
    }
    if (expNum > 0) {
      opts.expiration = new Date(Date.now() + expNum * 86400000);
    }

    const BATCH = 5;
    const totalBatches = Math.ceil(needGrant.length / BATCH);
    let granted = 0;
    const errors = [];

    for (let i = 0; i < needGrant.length; i += BATCH) {
      if (closed) { console.log('[FeeGrant] Client disconnected, aborting.'); break; }

      const batchNum = Math.floor(i / BATCH) + 1;
      const batch = needGrant.slice(i, i + BATCH);
      const shortAddrs = batch.map(a => a.slice(0, 12) + '...' + a.slice(-6)).join(', ');

      send('batch_start', { batch: batchNum, total: totalBatches, count: batch.length, addresses: shortAddrs });

      const msgs = batch.map(grantee => buildFeeGrantMsg(getAddr(), grantee, opts));

      try {
        const t0 = Date.now();
        const result = await safeBroadcast(msgs, `Fee grant batch ${batchNum}/${totalBatches}`);
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

        if (result.code !== 0) {
          const errMsg = parseChainError(result.rawLog || `TX failed code=${result.code}`);
          send('batch_error', { batch: batchNum, total: totalBatches, error: errMsg, elapsed });
          errors.push(`Batch ${batchNum}: ${errMsg}`);
        } else {
          granted += batch.length;
          send('batch_ok', { batch: batchNum, total: totalBatches, granted: batch.length, totalGranted: granted, txHash: result.transactionHash, elapsed });
        }
      } catch (e) {
        const errMsg = parseChainError(e.message);
        send('batch_error', { batch: batchNum, total: totalBatches, error: errMsg });
        errors.push(`Batch ${batchNum}: ${errMsg}`);
      }
    }

    send('done', { granted, skipped, errors: errors.length ? errors : undefined, total: needGrant.length });
  } catch (e) {
    send('error', { msg: parseChainError(e.message) });
  }
  res.end();
});

// Legacy POST endpoint (kept for simple cases / backwards compat)
app.post('/api/feegrant/grant-subscribers', async (req, res) => {
  if (!getAddr()) return res.status(401).json({ error: 'No wallet loaded' });
  const { planId, spendLimitDvpn, expirationDays } = req.body;
  if (!planId) return res.status(400).json({ error: 'planId required' });
  if (spendLimitDvpn !== undefined) {
    if (typeof spendLimitDvpn !== 'number' || !isFinite(spendLimitDvpn) || spendLimitDvpn < 0 || spendLimitDvpn > MAX_GRANT_DVPN) {
      return res.status(400).json({ error: `spendLimitDvpn must be a number between 0 and ${MAX_GRANT_DVPN}` });
    }
  }
  if (expirationDays !== undefined) {
    if (typeof expirationDays !== 'number' || !isFinite(expirationDays) || expirationDays < 0 || expirationDays > 365) {
      return res.status(400).json({ error: 'expirationDays must be a number between 0 and 365' });
    }
  }

  try {
    console.log(`[FeeGrant] grant-subscribers: plan=${planId}, limit=${spendLimitDvpn}, exp=${expirationDays}d`);

    let t0 = Date.now();
    console.log('[FeeGrant] Step 1: Fetching plan subscriptions...');
    let subs = [];
    let subsFromRpc = false;
    try {
      const rpc = await getRpcClient();
      if (rpc) {
        subs = await rpcQuerySubscriptionsForPlan(rpc, planId, { limit: 10000 });
        subsFromRpc = true;
        console.log(`[RPC] rpcQuerySubscriptionsForPlan plan=${planId} count=${subs.length}`);
      }
    } catch (err) {
      // Read-only RPC subs query — never KEPLR_SIGN_REQUIRED. Fall through to LCD.
      console.log(`[RPC] rpcQuerySubscriptionsForPlan failed: ${err.message}`);
    }
    if (!subsFromRpc) {
      subs = await lcdAllSubscriptions(planId, 60000);
    }
    console.log(`[FeeGrant] Step 1 done (${Date.now() - t0}ms)`);
    const now = new Date();
    const STATUS_MAP = { 1: 'active', 2: 'inactive_pending', 3: 'inactive' };
    const isActive = s => (s.status === 'active' || s.status === 1 || STATUS_MAP[s.status] === 'active');
    const activeSubs = subs.filter(s => isActive(s) && new Date(s.inactive_at) > now);
    const uniqueAddrs = [...new Set(activeSubs.map(s => s.acc_address))].filter(a => a !== getAddr());
    console.log(`[FeeGrant] ${activeSubs.length} active subs, ${uniqueAddrs.length} unique (excl. self)`);

    if (uniqueAddrs.length === 0) return res.json({ ok: true, granted: 0, skipped: 0, message: 'No active subscribers (excluding self)' });

    t0 = Date.now();
    console.log('[FeeGrant] Step 2: Checking existing grants...');
    // SDK rpcQueryFeeGrantsIssued silently returns [] on decode failure against Sentinel RPC;
    // fall through to LCD when empty so we don't miss real grants.
    let existingAllowancesPost = [];
    try {
      const rpc = await getRpcClient();
      if (rpc) {
        existingAllowancesPost = await rpcQueryFeeGrantsIssued(rpc, getAddr(), { limit: 10000 });
        console.log(`[RPC] rpcQueryFeeGrantsIssued granter=${getAddr()} count=${existingAllowancesPost.length}`);
      }
    } catch (err) {
      // Read-only RPC query — never KEPLR_SIGN_REQUIRED. Fall through to LCD.
      console.log(`[RPC] rpcQueryFeeGrantsIssued failed: ${err.message}`);
    }
    if (!existingAllowancesPost.length) {
      const existingData = await lcd(`/cosmos/feegrant/v1beta1/issued/${getAddr()}?pagination.limit=500`, 60000);
      existingAllowancesPost = existingData.allowances || [];
    }
    console.log(`[FeeGrant] Step 2 done (${Date.now() - t0}ms)`);
    const existingGrantees = new Set(existingAllowancesPost.map(a => a.grantee));

    const needGrant = uniqueAddrs.filter(a => !existingGrantees.has(a));
    console.log(`[FeeGrant] ${existingGrantees.size} existing grants, ${needGrant.length} need granting`);
    if (needGrant.length === 0) return res.json({ ok: true, granted: 0, skipped: uniqueAddrs.length, message: 'All subscribers already have grants' });

    const opts = {};
    if (spendLimitDvpn && spendLimitDvpn > 0) {
      opts.spendLimit = [{ denom: 'udvpn', amount: String(Math.round(spendLimitDvpn * 1e6)) }];
    }
    if (expirationDays && expirationDays > 0) {
      opts.expiration = new Date(Date.now() + expirationDays * 86400000);
    }

    // Client-signed wallets (Keplr/Privy) can't run the per-chunk server loop
    // below — the server holds no key. Bundle every grant into ONE signDoc and
    // relay it for a single client-side signature.
    if (isClientSigned()) {
      const allMsgs = needGrant.map(grantee => buildFeeGrantMsg(getAddr(), grantee, opts));
      if (await relayBundledOrNull(allMsgs, res, `Fee grant ${needGrant.length} subscribers`)) return;
    }

    const BATCH = 5;
    const totalBatches = Math.ceil(needGrant.length / BATCH);
    let granted = 0;
    const errors = [];
    for (let i = 0; i < needGrant.length; i += BATCH) {
      const batchNum = Math.floor(i / BATCH) + 1;
      const batch = needGrant.slice(i, i + BATCH);
      console.log(`[FeeGrant] Batch ${batchNum}/${totalBatches}: ${batch.length} addresses`);
      const msgs = batch.map(grantee => buildFeeGrantMsg(getAddr(), grantee, opts));
      try {
        const t0 = Date.now();
        const result = await safeBroadcast(msgs, `Fee grant batch ${batchNum}/${totalBatches}`);
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        if (result.code !== 0) {
          console.log(`[FeeGrant] Batch ${batchNum} FAILED (${elapsed}s): code=${result.code} ${(result.rawLog || '').slice(0, 150)}`);
          throw new Error(result.rawLog || `TX failed code=${result.code}`);
        }
        console.log(`[FeeGrant] Batch ${batchNum} OK (${elapsed}s): txHash=${result.transactionHash}`);
        granted += batch.length;
      } catch (e) {
        console.log(`[FeeGrant] Batch ${batchNum} ERROR: ${e.message.slice(0, 150)}`);
        errors.push(`Batch ${batchNum}: ${parseChainError(e.message)}`);
      }
    }

    console.log(`[FeeGrant] Done: granted=${granted}, skipped=${uniqueAddrs.length - needGrant.length}, errors=${errors.length}`);
    res.json({ ok: true, granted, skipped: uniqueAddrs.length - needGrant.length, errors: errors.length ? errors : undefined });
  } catch (e) {
    console.error(`[FeeGrant] Fatal error: ${e.message}`);
    res.status(500).json({ error: parseChainError(e.message) });
  }
});

app.post('/api/feegrant/revoke', async (req, res) => {
  if (!getAddr()) return res.status(401).json({ error: 'No wallet loaded' });
  const { grantee } = req.body;
  if (!grantee) return res.status(400).json({ error: 'grantee address required' });
  if (!SENT_ADDR_RE.test(grantee)) return res.status(400).json({ error: 'invalid grantee address' });

  try {
    const msg = buildRevokeFeeGrantMsg(getAddr(), grantee);
    const result = await safeBroadcast([msg], 'Revoke fee grant');
    if (result.code !== 0) throw new Error(result.rawLog || `TX failed code=${result.code}`);
    cacheInvalidate(`feegrants:${getAddr()}`);
    res.json({ ok: true, txHash: result.transactionHash });
  } catch (e) {
    // Chain auto-removes allowances when they expire or when the subscription ends.
    // If the revoke target is already gone, treat as success so the UI can clear it.
    const msg = String(e.message || '');
    if (/fee-grant not found|not found.*grant/i.test(msg)) {
      cacheInvalidate(`feegrants:${getAddr()}`);
      return res.json({ ok: true, alreadyGone: true });
    }
    res.status(500).json({ error: parseChainError(msg) });
  }
});

// Batch revoke a specific list of grantees (e.g. "stale cleanup" — grantees
// no longer subscribed to any plan). Uses the same per-grantee fallback as
// revoke-all so partial chain state doesn't abort the whole operation.
app.post('/api/feegrant/revoke-list', async (req, res) => {
  if (!getAddr()) return res.status(401).json({ error: 'No wallet loaded' });
  const { grantees } = req.body || {};
  if (!Array.isArray(grantees) || grantees.length === 0) {
    return res.status(400).json({ error: 'grantees array required' });
  }
  const list = grantees.filter(g => typeof g === 'string' && SENT_ADDR_RE.test(g));
  if (list.length === 0) return res.status(400).json({ error: 'no valid grantees in list' });

  try {
    // Client-signed wallets: bundle all revokes into ONE signDoc to relay.
    if (isClientSigned()) {
      const allMsgs = list.map(grantee => buildRevokeFeeGrantMsg(getAddr(), grantee));
      if (await relayBundledOrNull(allMsgs, res, `Revoke ${list.length} grants`)) return;
    }

    const BATCH = 5;
    let revoked = 0;
    let alreadyGone = 0;
    const errors = [];

    for (let i = 0; i < list.length; i += BATCH) {
      const batch = list.slice(i, i + BATCH);
      const msgs = batch.map(grantee => buildRevokeFeeGrantMsg(getAddr(), grantee));
      try {
        const result = await safeBroadcast(msgs, `Revoke batch ${Math.floor(i / BATCH) + 1}`);
        if (result.code !== 0) throw new Error(result.rawLog || `TX failed code=${result.code}`);
        revoked += batch.length;
      } catch (batchErr) {
        console.log(`[revoke-list] batch ${Math.floor(i / BATCH) + 1} failed, retrying one-by-one: ${batchErr.message}`);
        for (const grantee of batch) {
          try {
            const msg = buildRevokeFeeGrantMsg(getAddr(), grantee);
            const r = await safeBroadcast([msg], `Revoke ${grantee.slice(0, 14)}`);
            if (r.code !== 0) throw new Error(r.rawLog || `TX failed code=${r.code}`);
            revoked += 1;
          } catch (one) {
            const msg = String(one.message || '');
            if (/fee-grant not found|not found.*grant/i.test(msg)) {
              alreadyGone += 1;
            } else {
              errors.push(`${grantee.slice(0, 20)}…: ${parseChainError(msg)}`);
            }
          }
        }
      }
    }

    cacheInvalidate(`feegrants:${getAddr()}`);
    res.json({
      ok: true,
      revoked,
      alreadyGone,
      total: list.length,
      errors: errors.length ? errors : undefined,
    });
  } catch (e) {
    res.status(500).json({ error: parseChainError(e.message) });
  }
});

app.post('/api/feegrant/revoke-all', async (req, res) => {
  if (!getAddr()) return res.status(401).json({ error: 'No wallet loaded' });

  try {
    let revokeAllowances = [];
    try {
      const rpc = await getRpcClient();
      if (rpc) {
        revokeAllowances = await rpcQueryFeeGrantsIssued(rpc, getAddr(), { limit: 10000 });
        console.log(`[RPC] rpcQueryFeeGrantsIssued granter=${getAddr()} count=${revokeAllowances.length}`);
      }
    } catch (err) {
      // Read-only RPC query — never KEPLR_SIGN_REQUIRED. Fall through to LCD.
      console.log(`[RPC] rpcQueryFeeGrantsIssued failed: ${err.message}`);
    }
    if (!revokeAllowances.length) {
      const existingData = await lcd(`/cosmos/feegrant/v1beta1/issued/${getAddr()}?pagination.limit=500`);
      revokeAllowances = existingData.allowances || [];
    }
    const grantees = revokeAllowances.map(a => a.grantee).filter(Boolean);

    if (grantees.length === 0) {
      cacheInvalidate(`feegrants:${getAddr()}`);
      return res.json({ ok: true, revoked: 0, alreadyGone: 0, message: 'No grants to revoke' });
    }

    // Client-signed wallets: bundle all revokes into ONE signDoc to relay.
    if (isClientSigned()) {
      const allMsgs = grantees.map(grantee => buildRevokeFeeGrantMsg(getAddr(), grantee));
      if (await relayBundledOrNull(allMsgs, res, `Revoke ${grantees.length} grants`)) return;
    }

    const BATCH = 5;
    let revoked = 0;
    let alreadyGone = 0;
    const errors = [];

    // Send as small batches, but if any batch fails (e.g. one grantee already
    // gone aborts the whole TX), fall back to per-grantee retry so the other
    // grantees in that batch still get revoked.
    for (let i = 0; i < grantees.length; i += BATCH) {
      const batch = grantees.slice(i, i + BATCH);
      const msgs = batch.map(grantee => buildRevokeFeeGrantMsg(getAddr(), grantee));
      try {
        const result = await safeBroadcast(msgs, `Revoke batch ${Math.floor(i / BATCH) + 1}`);
        if (result.code !== 0) throw new Error(result.rawLog || `TX failed code=${result.code}`);
        revoked += batch.length;
      } catch (batchErr) {
        // Atomic batch failed — retry one grantee at a time so the rest go through.
        console.log(`[revoke-all] batch ${Math.floor(i / BATCH) + 1} failed, retrying one-by-one: ${batchErr.message}`);
        for (const grantee of batch) {
          try {
            const msg = buildRevokeFeeGrantMsg(getAddr(), grantee);
            const r = await safeBroadcast([msg], `Revoke ${grantee.slice(0, 14)}`);
            if (r.code !== 0) throw new Error(r.rawLog || `TX failed code=${r.code}`);
            revoked += 1;
          } catch (one) {
            const msg = String(one.message || '');
            if (/fee-grant not found|not found.*grant/i.test(msg)) {
              alreadyGone += 1;
            } else {
              errors.push(`${grantee.slice(0, 20)}…: ${parseChainError(msg)}`);
            }
          }
        }
      }
    }

    cacheInvalidate(`feegrants:${getAddr()}`);
    res.json({
      ok: true,
      revoked,
      alreadyGone,
      total: grantees.length,
      errors: errors.length ? errors : undefined,
    });
  } catch (e) {
    res.status(500).json({ error: parseChainError(e.message) });
  }
});

// ─── Routes: Analytics ───────────────────────────────────────────────────────

app.get('/api/feegrant/gas-costs', async (req, res) => {
  if (!getAddr()) return res.status(401).json({ error: 'No wallet loaded' });
  const { planId } = req.query;
  if (!planId) return res.status(400).json({ error: 'planId required' });
  const planIdNum = parseInt(planId, 10);
  if (!Number.isFinite(planIdNum) || planIdNum <= 0) return res.status(400).json({ error: 'planId must be a positive integer' });

  try {
    const subsCacheKey = `planSubs:${planId}:500:`;
    registerPlanSubsKey(planId, subsCacheKey);
    const subData = await cached(subsCacheKey, 60_000, async () => {
      // RPC-first: returns array directly; wrap to match LCD shape { subscriptions: [...] }.
      try {
        const rpc = await getRpcClient();
        if (rpc) {
          const rpcResult = await rpcQuerySubscriptionsForPlan(rpc, planId, { limit: 10000 });
          if (rpcResult) return { subscriptions: rpcResult };
        }
      } catch (err) {
        // Inside cached() — never write to res from here. Read-only RPC can't
        // produce KEPLR_SIGN_REQUIRED. Fall through to LCD.
        console.log(`[RPC] gas-costs subs(${planId}) failed: ${err.message} — LCD fallback`);
      }
      return { subscriptions: await lcdAllSubscriptions(planId) };
    });
    const subs = subData.subscriptions || [];
    const subscriberAddrs = [...new Set(subs.map(s => s.acc_address))].filter(a => a !== getAddr());

    if (subscriberAddrs.length === 0) {
      return res.json({ ok: true, totalUdvpn: 0, txCount: 0, byAddress: {}, subscriberCount: 0 });
    }

    let totalUdvpn = 0;
    let txCount = 0;
    const byAddress = {};

    console.log(`[GasCosts] Checking ${subscriberAddrs.length} subscriber addresses...`);
    for (const addr of subscriberAddrs) {
      try {
        const searchUrl = `/cosmos/tx/v1beta1/txs?events=${encodeURIComponent("message.sender='" + addr + "'")}&pagination.limit=100&order_by=2`;
        const txData = await lcd(searchUrl, 30000);
        const rawTxs = txData.txs || [];

        let addrGas = 0;
        let addrTxCount = 0;

        for (let i = 0; i < rawTxs.length; i++) {
          const fee = rawTxs[i]?.auth_info?.fee;
          if (fee?.granter === getAddr()) {
            const udvpnFee = (fee.amount || []).find(f => f.denom === 'udvpn');
            if (udvpnFee) {
              addrGas += parseInt(udvpnFee.amount);
              addrTxCount++;
            }
          }
        }

        if (addrTxCount > 0) {
          byAddress[addr] = { udvpn: addrGas, txCount: addrTxCount };
          totalUdvpn += addrGas;
          txCount += addrTxCount;
        }
        console.log(`[GasCosts] ${addr.slice(0, 12)}...: ${rawTxs.length} txs checked, ${addrTxCount} fee-granted`);
      } catch (err) {
        // Per-address LCD probe inside accumulator loop — never KEPLR_SIGN_REQUIRED.
        // Don't bail the whole loop on a single address failure.
        console.error(`[GasCosts] ${addr.slice(0, 12)}... failed: ${err.message}`);
      }
    }
    console.log(`[GasCosts] Done: ${totalUdvpn} udvpn across ${txCount} txs from ${Object.keys(byAddress).length} addresses`);

    res.json({ ok: true, totalUdvpn, txCount, byAddress, subscriberCount: subscriberAddrs.length });
  } catch (e) {
    res.status(500).json({ error: parseChainError(e.message) });
  }
});

const AUTO_GRANT_FILE = join(DATA_DIR, 'auto-grant.json');
const AUTO_GRANT_DEFAULTS = { enabled: true, spendLimitDvpn: 10, expirationDays: 30 };

function loadAutoGrantSettings() {
  try {
    if (!existsSync(AUTO_GRANT_FILE)) return { ...AUTO_GRANT_DEFAULTS };
    const parsed = JSON.parse(readFileSync(AUTO_GRANT_FILE, 'utf8'));
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : AUTO_GRANT_DEFAULTS.enabled,
      spendLimitDvpn: Number.isFinite(parsed.spendLimitDvpn) && parsed.spendLimitDvpn > 0
        ? parsed.spendLimitDvpn : AUTO_GRANT_DEFAULTS.spendLimitDvpn,
      expirationDays: Number.isInteger(parsed.expirationDays) && parsed.expirationDays > 0
        ? parsed.expirationDays : AUTO_GRANT_DEFAULTS.expirationDays,
    };
  } catch (e) {
    console.warn(`[auto-grant] failed to load ${AUTO_GRANT_FILE} (${e.message}) — using defaults`);
    return { ...AUTO_GRANT_DEFAULTS };
  }
}

let _autoGrantSettings = loadAutoGrantSettings();

function saveAutoGrantSettings() {
  try {
    writeFileSync(AUTO_GRANT_FILE, JSON.stringify(_autoGrantSettings), 'utf8');
  } catch (e) {
    // Non-fatal: settings stay in memory for this process, just won't survive a restart.
    console.warn(`[auto-grant] failed to persist settings: ${e.message}`);
  }
}

app.get('/api/feegrant/auto-grant', (req, res) => {
  res.json(_autoGrantSettings);
});

app.post('/api/feegrant/auto-grant', (req, res) => {
  const { enabled, spendLimitDvpn, expirationDays } = req.body || {};
  // Validate each field before mutating state. typeof NaN === 'number', and a
  // negative/zero spend limit or expiry would later produce an invalid feegrant
  // TX, so reject anything that isn't a sane positive value. Each field is
  // optional; only the ones present are updated.
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be a boolean' });
  }
  if (spendLimitDvpn !== undefined && (!Number.isFinite(spendLimitDvpn) || spendLimitDvpn <= 0)) {
    return res.status(400).json({ error: 'spendLimitDvpn must be a positive number' });
  }
  if (expirationDays !== undefined && (!Number.isInteger(expirationDays) || expirationDays <= 0)) {
    return res.status(400).json({ error: 'expirationDays must be a positive whole number' });
  }
  if (typeof enabled === 'boolean') _autoGrantSettings.enabled = enabled;
  if (Number.isFinite(spendLimitDvpn)) _autoGrantSettings.spendLimitDvpn = spendLimitDvpn;
  if (Number.isInteger(expirationDays)) _autoGrantSettings.expirationDays = expirationDays;
  saveAutoGrantSettings();
  res.json({ ok: true, ..._autoGrantSettings });
});

app.get('/api/node-rankings', async (req, res) => {
  try {
    const result = await cached('nodeRankings', 120_000, async () => {
    console.log('Scanning all active sessions + node pricing...');
    const t0 = Date.now();

    const [sessionData, nodeInfo, dvpnPrice] = await Promise.all([
      scanSessions(),
      getAllNodeInfo(),
      getDvpnPrice(),
    ]);

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const { nodes, totalScanned } = sessionData;

    const ranked = Object.entries(nodes).map(([addr, d]) => {
      const pricing = nodeInfo[addr] || { hourlyUdvpn: 0, gbUdvpn: 0 };
      const dlGB = d.dlBytes / (1024 ** 3);
      const totalHours = d.totalDurSec / 3600;

      const earnByGB = dlGB * pricing.gbUdvpn;
      const earnByHour = totalHours * pricing.hourlyUdvpn;
      const earnUdvpn = Math.max(earnByGB, earnByHour);
      const earnDvpn = earnUdvpn / 1e6;
      const earnUsd = dvpnPrice ? earnDvpn * dvpnPrice : null;

      return {
        address: addr,
        uniqueUsers: d.users.size,
        totalSessions: d.sessions,
        downloadGB: parseFloat(dlGB.toFixed(2)),
        uploadGB: parseFloat((d.ulBytes / (1024 ** 3)).toFixed(2)),
        totalBandwidthGB: parseFloat(((d.dlBytes + d.ulBytes) / (1024 ** 3)).toFixed(2)),
        totalHours: parseFloat(totalHours.toFixed(1)),
        hourlyPriceUdvpn: pricing.hourlyUdvpn,
        gbPriceUdvpn: pricing.gbUdvpn,
        estEarningsDvpn: parseFloat(earnDvpn.toFixed(2)),
        estEarningsUsd: earnUsd !== null ? parseFloat(earnUsd.toFixed(4)) : null,
      };
    });

    ranked.sort((a, b) => b.uniqueUsers - a.uniqueUsers || b.totalBandwidthGB - a.totalBandwidthGB);

    const totalDL = ranked.reduce((s, n) => s + n.downloadGB, 0);
    const totalUL = ranked.reduce((s, n) => s + n.uploadGB, 0);
    const totalEarnDvpn = ranked.reduce((s, n) => s + n.estEarningsDvpn, 0);
    const totalEarnUsd = dvpnPrice ? totalEarnDvpn * dvpnPrice : null;

    console.log(`Scanned ${totalScanned} sessions, ${ranked.length} nodes in ${elapsed}s`);
    return {
      ranked,
      totalSessions: totalScanned,
      totalNodes: ranked.length,
      totalDownloadGB: parseFloat(totalDL.toFixed(2)),
      totalUploadGB: parseFloat(totalUL.toFixed(2)),
      totalEstEarningsDvpn: parseFloat(totalEarnDvpn.toFixed(2)),
      totalEstEarningsUsd: totalEarnUsd !== null ? parseFloat(totalEarnUsd.toFixed(4)) : null,
      dvpnPriceUsd: dvpnPrice,
      scannedAt: new Date().toISOString(),
    };
    }); // end cached()
    res.json(result);
  } catch (err) {
    if (relayKeplrSign(err, res)) return;
    console.error('Error scanning sessions:', err);
    res.status(500).json({ error: parseChainError(err.message) });
  }
});

// ─── Routes: Health / RPC ─────────────────────────────────────────────────────

// LCD primary endpoint (used for raw health check fetches)
const LCD = LCD_ENDPOINTS[0];

app.get('/api/rpcs', async (req, res) => {
  // Parallel endpoint probing: all endpoints probed simultaneously via Promise.allSettled()
  // instead of sequential loop. ~Nx faster where N = number of endpoints.
  const probeOne = async (ep) => {
    const start = Date.now();
    let status = 'error';
    let statusCode = 0;
    let latencyMs = 0;
    let sampleData = null;
    let errorMsg = null;

    try {
      const r = await fetch(`${LCD}${ep.path}`, { signal: AbortSignal.timeout(15000) });
      latencyMs = Date.now() - start;
      statusCode = r.status;

      if (r.status === 200) {
        const json = await r.json();
        if (json.code && json.code !== 0) {
          status = 'fail';
          errorMsg = json.message || `gRPC code ${json.code}`;
        } else {
          status = 'ok';
          const txt = JSON.stringify(json);
          sampleData = txt.length > 300 ? txt.slice(0, 300) + '...' : txt;
        }
      } else if (r.status === 501 || r.status === 404) {
        status = 'not_implemented';
        try { const j = await r.json(); errorMsg = j.message || `HTTP ${r.status}`; } catch { errorMsg = `HTTP ${r.status}`; }
      } else {
        status = 'fail';
        try { const j = await r.json(); errorMsg = j.message || `HTTP ${r.status}`; } catch { errorMsg = `HTTP ${r.status}`; }
      }
    } catch (err) {
      // Inside Promise.allSettled probe — fetch() error, never KEPLR_SIGN_REQUIRED.
      // Writing to res here would race with the outer res.json at the bottom.
      latencyMs = Date.now() - start;
      status = 'timeout';
      errorMsg = err.message;
    }

    return {
      category: ep.category,
      method: ep.method,
      path: ep.path,
      desc: ep.desc,
      status,
      statusCode,
      latencyMs,
      sampleData,
      errorMsg,
    };
  };

  const settled = await Promise.allSettled(RPC_ENDPOINTS.map(ep => probeOne(ep)));
  const results = settled.map((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      : { category: RPC_ENDPOINTS[i].category, method: RPC_ENDPOINTS[i].method, path: RPC_ENDPOINTS[i].path, desc: RPC_ENDPOINTS[i].desc, status: 'error', statusCode: 0, latencyMs: 0, sampleData: null, errorMsg: s.reason?.message || 'Unknown error' }
  );

  const ok = results.filter(r => r.status === 'ok').length;
  const fail = results.filter(r => r.status !== 'ok').length;

  let peerStats = null;
  try {
    const [sessRes, nodeRes] = await Promise.all([
      lcd('/sentinel/session/v3/sessions?pagination.limit=1&pagination.count_total=true'),
      lcd('/sentinel/node/v3/nodes?status=1&pagination.limit=1&pagination.count_total=true'),
    ]);
    const totalSessions = parseInt(sessRes.pagination?.total || '0');
    const totalActiveNodes = parseInt(nodeRes.pagination?.total || '0');

    // No chain-wide RPC sessions query — LCD only
    const sessPage = await lcd('/sentinel/session/v3/sessions?pagination.limit=500&pagination.reverse=true');
    const uniqueAccounts = new Set();
    for (const s of sessPage.sessions || []) {
      if (s.base_session?.acc_address) uniqueAccounts.add(s.base_session.acc_address);
    }

    let explorerActiveSessions = null;
    try {
      const expRes = await fetch('https://api.explorer.sentinel.co/v3/?timeframe=now', {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Referer': 'https://stats.sentinel.co/',
          'Origin': 'https://stats.sentinel.co',
        },
        signal: AbortSignal.timeout(10000),
      });
      const expData = await expRes.json();
      if (expData.success && expData.result?.[0]) {
        explorerActiveSessions = expData.result[0].active_sessions;
      }
    } catch (err) {
      // External explorer fetch — never KEPLR_SIGN_REQUIRED. Soft-fail; explorerActiveSessions stays null.
      console.error('Failed to fetch explorer stats:', err.message);
    }

    peerStats = {
      activeSessions: totalSessions,
      explorerActiveSessions,
      activeNodes: totalActiveNodes,
      uniquePeersInSample: uniqueAccounts.size,
      sampleSize: (sessPage.sessions || []).length,
    };
  } catch (err) {
    // Read-only LCD aggregation — never KEPLR_SIGN_REQUIRED. Soft-fail; peerStats stays null.
    console.error('Failed to compute peer stats:', err.message);
  }

  res.json({ results, summary: { total: results.length, ok, fail }, peerStats, checkedAt: new Date().toISOString() });
});

app.get('/api/rpc-providers', async (req, res) => {
  try {
    console.log('Scanning RPC providers...');
    const results = await Promise.all(RPC_PROVIDERS.map(async (url) => {
      const start = Date.now();
      try {
        const r = await fetch(`${url}/status`, { signal: AbortSignal.timeout(8000) });
        const latency = Date.now() - start;
        if (!r.ok) return { url, status: 'down', latency, error: `HTTP ${r.status}` };
        const d = await r.json();
        const info = d.result?.node_info || {};
        const sync = d.result?.sync_info || {};
        return {
          url,
          status: 'up',
          latency,
          moniker: info.moniker || null,
          network: info.network || null,
          version: info.version || null,
          nodeId: info.id || null,
          latestHeight: parseInt(sync.latest_block_height || '0'),
          latestTime: sync.latest_block_time || null,
          catchingUp: sync.catching_up || false,
        };
      } catch (e) {
        return { url, status: 'down', latency: Date.now() - start, error: e.message };
      }
    }));
    const up = results.filter(r => r.status === 'up');
    const down = results.filter(r => r.status === 'down');
    const maxHeight = Math.max(...up.map(r => r.latestHeight || 0));
    for (const r of up) {
      r.blocksBehind = maxHeight - (r.latestHeight || 0);
      r.synced = r.blocksBehind < 5 && !r.catchingUp;
    }
    up.sort((a, b) => a.latency - b.latency);
    console.log(`RPC scan done: ${up.length} up, ${down.length} down`);
    res.json({
      providers: [...up, ...down],
      summary: { total: results.length, up: up.length, down: down.length, maxHeight },
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    if (relayKeplrSign(err, res)) return;
    res.status(500).json({ error: parseChainError(err.message) });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// SPA fallback — any non-API GET returns index.html so deep-link refreshes work.
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  if (req.path.startsWith('/api/') || req.path === '/health') return next();
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// ─── API 404 (JSON) ───────────────────────────────────────────────────────────
// Any unmatched /api/ request (wrong method, typo, removed endpoint) must return
// JSON — NOT the SPA HTML or Express's default "Cannot POST" page. The frontend
// always calls res.json() on these responses; an HTML body throws
// "Unexpected token '<', "<!DOCTYPE "... is not valid JSON".
app.use((req, res, next) => {
  if (req.path.startsWith('/api/') || req.path === '/health') {
    return res.status(404).json({ error: `No such endpoint: ${req.method} ${req.path}`, errorCode: 'not-found' });
  }
  next();
});

// ─── JSON Error Handler (must be LAST) ────────────────────────────────────────
// Catches body-parser failures (malformed JSON → 400, oversized body → 413) and
// any error thrown by a route's next(err). Express's DEFAULT handler renders an
// HTML page for these, which the JSON-only frontend can't parse — that was the
// "Unexpected token '<'" seen on Privy register and every other TX function.
// Always respond JSON. 4 args is required so Express treats this as an error
// handler.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  let errorCode = 'server-error';
  if (err.type === 'entity.too.large' || status === 413) errorCode = 'payload-too-large';
  else if (err.type === 'entity.parse.failed' || status === 400) errorCode = 'bad-json';
  if (status >= 500) console.error('[error-handler]', req.method, req.path, '-', err.message);
  if (res.headersSent) return next(err);
  res.status(status).json({
    ok: false,
    error: status === 413 ? 'Request too large' : (err.message || 'Internal server error'),
    errorCode,
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

console.log('[wallet] Cookie-mode: each visitor signs in with their own mnemonic, encrypted into an httpOnly browser cookie. No mnemonic env var or .wallet.json is read.');

// ─── FIX 8: .env permissions warning ─────────────────────────────────────────
// Non-fatal check: warn if .env has group/world read bits (Unix only; no-op on Windows).
try {
  const envPath = join(__dirname, '.env');
  if (existsSync(envPath)) {
    const mode = statSync(envPath).mode;
    if (mode & 0o044) {
      process.stderr.write('[security] WARNING: .env has group/world read permissions. Run: chmod 600 .env\n');
    }
  }
} catch (err) {
  console.warn('[security] .env permission check failed:', err.message);
}

// HOST defaults to 0.0.0.0 so Docker / VM / public deploys work out of the
// box. Local-only hardening: set HOST=127.0.0.1 (or unset and run outside a
// container) to restrict the listener to loopback.
const HOST = process.env.HOST || '0.0.0.0';
const server = app.listen(PORT, HOST, () => {
  const displayHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`Plan Manager running on http://${displayHost}:${PORT} (bound to ${HOST})`);
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[boot] Port ${PORT} is already in use.`);
    console.error('       Another Plan Manager (or unrelated process) is bound to that port.');
    console.error(`       Fix: stop the other process, or set PORT=<free port> in .env, then retry.`);
    process.exit(1);
  }
  console.error('[boot] Server failed to start:', err);
  process.exit(1);
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

function shutdown(signal) {
  console.log(`\n${signal} received — shutting down...`);
  server.close(() => {
    disconnect();
    console.log('Server closed.');
    process.exit(0);
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
