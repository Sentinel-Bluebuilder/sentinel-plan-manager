// ─── Plan Manager Server ──────────────────────────────────────────────────────
// Express backend for Sentinel dVPN plan management.
// Modules: lib/constants, lib/cache, lib/errors, lib/protobuf, lib/chain, lib/wallet

import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import {
  listNodes,
  registerCleanupHandlers,
  disconnect,
  cached,
  cacheInvalidate,
  cacheClear,
  ErrorCodes,
  isRetryable,
  userMessage,
} from 'blue-js-sdk';

// ─── Module Imports ──────────────────────────────────────────────────────────
import { PORT, LCD_ENDPOINTS, RPC_PROVIDERS, RPC_ENDPOINTS, NODE_CACHE_TTL } from './lib/constants.js';
import * as C from './lib/constants.js';
// Chain error parsing + plan-specific helpers (kept local — SDK's parseChainError lacks plan/lease patterns)
import { parseChainError, isLeaseNotFound, isDuplicateNode, txResponse } from './lib/errors.js';
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
  rpcQuerySessionsForAccount,
  rpcQuerySubscriptionsForPlan,
  rpcQueryFeeGrantsIssued,
} from './lib/chain.js';
import { getAddr, getProvAddr, initWallet, clearWalletState, loadSavedWallet, requireWallet } from './lib/wallet.js';
import {
  initSession, isMultiUser, encryptMnemonic, decryptMnemonic,
  sessionFromMnemonic, runWithSession, parseCookies,
  buildSetCookie, buildClearCookie, COOKIE_NAME,
} from './lib/session.js';

registerCleanupHandlers();

const __dirname = dirname(fileURLToPath(import.meta.url));
// DATA_DIR lets deployments (Docker, etc.) redirect state files to a mounted
// volume. Defaults to the project root — unchanged for local installs.
const DATA_DIR = process.env.DATA_DIR || __dirname;
try { mkdirSync(DATA_DIR, { recursive: true }); } catch {}
initSession(DATA_DIR);

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// ─── Per-Request Session Middleware ───────────────────────────────────────
// Decrypts the httpOnly session cookie (if present) into a wallet and runs
// the rest of the request chain inside that session's AsyncLocalStorage
// context. Handlers call `getAddr()` / `getSigningClient()` as before;
// those helpers automatically resolve to the per-request wallet.
app.use(async (req, res, next) => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[COOKIE_NAME];
  if (!token) return next();
  try {
    const mnemonic = decryptMnemonic(token);
    const session = await sessionFromMnemonic(mnemonic);
    runWithSession(session, () => next());
  } catch (err) {
    // Tampered / stale / key-rotated cookie — clear it and continue.
    console.warn('[session] Rejecting cookie:', err.message);
    res.setHeader('Set-Cookie', buildClearCookie({ secure: req.secure }));
    next();
  }
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
    try { writeFileSync(MY_PLANS_FILE, JSON.stringify(store), 'utf8'); } catch {}
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
    writeFileSync(MY_PLANS_FILE, JSON.stringify(store), 'utf8');
  }
}

// ─── Node Cache (SDK scan) ────────────────────────────────────────────────────
const NODE_CACHE_FILE = join(DATA_DIR, 'nodes-cache.json');
let nodeCache = { nodes: [], ts: 0, scanning: false };
let scanProgress = { total: 0, probed: 0, online: 0 };

function loadNodeCacheFromDisk() {
  try {
    if (!existsSync(NODE_CACHE_FILE)) return;
    const d = JSON.parse(readFileSync(NODE_CACHE_FILE, 'utf8'));
    if (d.nodes && d.nodes.length) {
      const ageMs = Date.now() - (d.ts || 0);
      // Only seed cache if fresh (within TTL). Stale on-disk data is discarded —
      // we'd rather scan fresh than serve stale counts as "on-chain truth".
      if (ageMs < NODE_CACHE_TTL) {
        nodeCache.nodes = d.nodes;
        nodeCache.ts = d.ts || 0;
        console.log(`Seeded node cache from disk: ${d.nodes.length} nodes (age ${Math.round(ageMs / 1000)}s, will refresh in background)`);
      } else {
        console.log(`Disk node cache is stale (age ${Math.round(ageMs / 1000)}s > TTL ${NODE_CACHE_TTL / 1000}s) — discarding, will rescan`);
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

function nodeCacheToAllNodes(raw) {
  return raw.map(n => {
    const gbPrice = (n.gigabytePrices || []).find(p => p.denom === 'udvpn');
    const hrPrice = (n.hourlyPrices || []).find(p => p.denom === 'udvpn');
    return {
      address: n.address,
      remoteUrl: n.remoteUrl || '',
      gbPriceUdvpn: gbPrice ? parseInt(gbPrice.quote_value) : 0,
      hrPriceUdvpn: hrPrice ? parseInt(hrPrice.quote_value) : 0,
      status: 'active',
      protocol: n.serviceType || null,
      country: n.country || null,
      city: n.city || null,
      moniker: n.moniker || null,
      speedMbps: null,
      pass15: false,
      pass10: false,
      peers: n.peers ?? null,
    };
  });
}

async function runNodeScan() {
  if (nodeCache.scanning) return;
  nodeCache.scanning = true;
  scanProgress = { total: 0, probed: 0, online: 0 };
  console.log('Starting node scan via SDK...');
  try {
    const nodes = await listNodes({
      maxNodes: 2000, serviceType: null, concurrency: 30,
      onNodeProbed: (p) => { scanProgress = p; },
    });
    nodeCache = { nodes, ts: Date.now(), scanning: false };
    saveNodeCacheToDisk(nodes);
    console.log(`Node scan complete: ${nodes.length} nodes cached`);
  } catch (e) {
    console.error('Node scan failed:', e.message);
    nodeCache.scanning = false;
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
          .catch(() => {});
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

async function getPlanStats(planId) {
  return cached(`planStats:${planId}`, 120_000, () => _getPlanStatsImpl(planId));
}

async function _getPlanStatsImpl(planId) {
  // Fetch RPC client once for this call — shared by RPC-first paths below.
  let rpc = null;
  try { rpc = await getRpcClient(); } catch (_) { rpc = null; }

  const [subsData, nodesData, latestSubs] = await Promise.all([
    // count_total — LCD is the only way to get pagination.total; keep LCD.
    lcd(`/sentinel/subscription/v3/plans/${planId}/subscriptions?pagination.limit=1&pagination.count_total=true`),
    // Plan nodes — RPC-first, fall back to LCD.
    (async () => {
      if (rpc) {
        try {
          const nodes = await rpcQueryNodesForPlan(rpc, planId, { status: 0, limit: 5000 });
          if (nodes) return { nodes };
        } catch (err) {
          console.log(`[RPC] _getPlanStatsImpl nodes(${planId}) failed: ${err.message} — LCD fallback`);
        }
      }
      return lcd(`/sentinel/node/v3/plans/${planId}/nodes?pagination.limit=500`).catch(() => ({ nodes: [] }));
    })(),
    // RPC doesn't expose reverse pagination — LCD only.
    lcd(`/sentinel/subscription/v3/plans/${planId}/subscriptions?pagination.limit=200&pagination.reverse=true`),
  ]);

  const totalSubs = parseInt(subsData.pagination?.total || '0');
  const totalNodes = (nodesData.nodes || []).length;

  const allSampleSubs = latestSubs.subscriptions || [];
  const sampleSubs = allSampleSubs.filter(s => s.acc_address !== getAddr());
  const sampleWallets = new Set(sampleSubs.map(s => s.acc_address));
  const ownSubs = allSampleSubs.length - sampleSubs.length;

  const sample = sampleSubs[0] || allSampleSubs[0];
  const price = sample?.price || { denom: 'udvpn', quote_value: '0', base_value: '0' };
  const renewalPolicy = sample?.renewal_price_policy || 'unknown';

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

  let durationDays = null;
  if (sample) {
    const start = new Date(sample.start_at);
    const end = new Date(sample.inactive_at);
    durationDays = Math.round((end - start) / (1000 * 60 * 60 * 24));
  }

  return {
    planId,
    totalSubscriptions: Math.max(0, totalSubs - ownSubs),
    totalNodes,
    uniqueWalletsSample: sampleWallets.size,
    price: {
      denom: price.denom,
      quoteValue: price.quote_value,
      baseValue: price.base_value,
      dvpnAmount: price.denom === 'udvpn' ? (parseInt(price.quote_value) / 1e6) : null,
    },
    renewalPolicy,
    activeSubs,
    inactiveSubs,
    sampleSize: sampleSubs.length,
    durationDays,
    earliestStart,
    latestStart,
    estimatedTotalP2p: price.denom === 'udvpn' ? (totalSubs * parseInt(price.quote_value) / 1e6) : null,
  };
}

async function getNodesForPlan(planId) {
  const nodes = [];

  // RPC-first
  try {
    const rpc = await getRpcClient();
    if (rpc) {
      const rpcNodes = await rpcQueryNodesForPlan(rpc, planId, { status: 0, limit: 5000 });
      for (const n of rpcNodes) {
        const rawAddr = (n.remote_addrs || [])[0] || '';
        nodes.push({
          address: n.address,
          remoteUrl: rawAddr ? (rawAddr.startsWith('http') ? rawAddr : `https://${rawAddr}`) : '',
          gigabytePrices: n.gigabyte_prices,
          hourlyPrices: n.hourly_prices,
          status: n.status === 1 ? 'active' : 'inactive',
          inactiveAt: null,
          statusAt: null,
        });
      }
      return nodes;
    }
  } catch (err) {
    console.log(`[RPC] getNodesForPlan(${planId}) failed: ${err.message} — LCD fallback`);
  }

  // LCD fallback
  let nextKey = undefined;
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
  } while (nextKey);

  return nodes;
}

async function getProviders() {
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

async function autoLeaseNode(nodeAddress, hours = 24) {
  // RPC direct lookup: O(1) instead of paginated LCD scan of ALL nodes (O(n)).
  // Falls back to LCD if RPC unavailable.
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
    let allNodesList = [], nextKey = null;
    do {
      let url = '/sentinel/node/v3/nodes?pagination.limit=500&status=1';
      if (nextKey) url += `&pagination.key=${encodeURIComponent(nextKey)}`;
      const page = await lcd(url);
      allNodesList.push(...(page.nodes || []));
      nextKey = page.pagination?.next_key || null;
    } while (nextKey);
    nodeInfo = allNodesList.find(n => n.address === nodeAddress);
  }

  if (!nodeInfo) throw new Error('Node not found on chain');
  const hp = (nodeInfo.hourly_prices || []).find(p => p.denom === 'udvpn');
  if (!hp) throw new Error('Node has no udvpn hourly price');

  const totalCost = (parseInt(hp.quote_value) * hours / 1e6).toFixed(1);
  console.log(`[LEASE] Auto-leasing ${nodeAddress} for ${hours}h (${hp.quote_value} udvpn/hr = ~${totalCost} P2P)...`);

  const leaseMsg = {
    typeUrl: C.MSG_START_LEASE_TYPE,
    value: {
      from: getProvAddr(),
      nodeAddress,
      hours,
      maxPrice: { denom: 'udvpn', base_value: hp.base_value, quote_value: hp.quote_value },
      renewalPricePolicy: 7,
    },
  };

  const leaseResult = await safeBroadcast([leaseMsg]);
  const leaseResp = txResponse(leaseResult);
  if (!leaseResp.ok) {
    console.log(`[LEASE] Failed: ${(leaseResp.rawLog || '').slice(0, 150)}`);
    throw new Error(parseChainError(leaseResp.rawLog));
  }
  console.log(`[LEASE] OK: tx=${leaseResp.txHash}`);
  return leaseResp;
}

async function batchLeaseNodes(addrs, hours = 24) {
  // Parallel RPC lookups: one rpcQueryNode() per address instead of paginated LCD scan.
  // Falls back to LCD if RPC unavailable.
  let rawMap = {};
  try {
    const rpcClient = await getRpcClient();
    const results = await Promise.all(
      addrs.map(addr => rpcQueryNode(rpcClient, addr).then(node => ({ addr, node })))
    );
    for (const { addr, node } of results) {
      if (node) rawMap[addr] = node;
    }
    console.log(`[BATCH-LEASE] RPC lookup: ${Object.keys(rawMap).length}/${addrs.length} nodes found`);
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

  const leaseMsgs = [];
  for (const addr of addrs) {
    const raw = rawMap[addr];
    if (!raw) { console.log(`[BATCH-LEASE] Skipping ${addr} — not found on chain`); continue; }
    const hp = (raw.hourly_prices || []).find(p => p.denom === 'udvpn');
    if (!hp) { console.log(`[BATCH-LEASE] Skipping ${addr} — no udvpn hourly price`); continue; }

    leaseMsgs.push({
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

  if (leaseMsgs.length === 0) throw new Error('No valid nodes to lease');
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

app.get('/api/wallet/status', (req, res) => {
  res.json({ loaded: !!getAddr(), address: getAddr() || null, multiUser: isMultiUser() });
});

app.post('/api/wallet/import', async (req, res) => {
  try {
    const { mnemonic } = req.body;
    if (!mnemonic) return res.status(400).json({ error: 'mnemonic required' });
    const trimmed = mnemonic.trim();
    const words = trimmed.split(/\s+/);
    if (words.length !== 12 && words.length !== 24) {
      return res.status(400).json({ error: 'Mnemonic must be 12 or 24 words' });
    }

    // Derive the wallet now to validate the mnemonic before we ever store it
    // in a cookie.
    const session = await sessionFromMnemonic(trimmed);
    const token = encryptMnemonic(trimmed);
    res.setHeader('Set-Cookie', buildSetCookie(token, { secure: req.secure }));

    // In single-user mode, also set the module-level wallet so the classic
    // local-deploy UX (env MNEMONIC, one shared wallet) keeps working for
    // clients that don't carry the cookie (e.g. the CLI on the same host).
    if (!isMultiUser()) {
      await initWallet(trimmed);
    }

    res.json({ ok: true, address: session.addr, provAddress: session.provAddr });
  } catch (err) {
    console.error('Wallet import error:', err.message);
    res.status(400).json({ error: 'Invalid mnemonic: ' + err.message });
  }
});

app.post('/api/wallet/test-import', async (req, res) => {
  if (isMultiUser()) {
    return res.status(403).json({ error: 'Disabled in multi-user mode — paste your own mnemonic instead.' });
  }
  try {
    const envPath = join(__dirname, '.env');
    if (!existsSync(envPath)) {
      return res.status(404).json({ error: 'No .env file found' });
    }
    const envContent = readFileSync(envPath, 'utf8');
    const match = envContent.match(/^MNEMONIC=(.+)$/m);
    if (!match || !match[1].trim()) {
      return res.status(400).json({ error: 'No MNEMONIC in .env' });
    }
    await initWallet(match[1].trim());
    res.json({ ok: true, address: getAddr(), provAddress: getProvAddr() });
  } catch (err) {
    console.error('Test wallet import error:', err.message);
    res.status(400).json({ error: 'Failed to load test wallet: ' + err.message });
  }
});

app.post('/api/wallet/logout', (req, res) => {
  res.setHeader('Set-Cookie', buildClearCookie({ secure: req.secure }));
  // Only wipe the module-level wallet in single-user mode — in multi-user
  // mode there is no shared state to clear, and doing so would log out
  // everyone who still has a valid cookie.
  if (!isMultiUser()) {
    clearWalletState();
    console.log('Wallet cleared');
  }
  res.json({ ok: true });
});

app.get('/api/wallet', async (req, res) => {
  if (!requireWallet(req, res)) return;
  try {
    const [bal, dvpnPrice, provider] = await Promise.all([
      cached(`balance:${getAddr()}`, 30_000, async () => {
        const client = await getSigningClient();
        return client.getBalance(getAddr(), 'udvpn');
      }),
      getDvpnPrice(),
      cached(`provider:${getAddr()}`, 600_000, async () => {
        try {
          const provs = await lcd('/sentinel/provider/v2/providers?pagination.limit=500');
          return (provs.providers || []).find(p => p.address.includes(getAddr().slice(4, 20))) || null;
        } catch (err) {
          console.error('Failed to lookup provider:', err.message);
          return null;
        }
      }),
    ]);

    res.json({
      address: getAddr(),
      balanceUdvpn: parseInt(bal.amount),
      balanceDvpn: parseFloat((parseInt(bal.amount) / 1e6).toFixed(2)),
      dvpnPriceUsd: dvpnPrice,
      balanceUsd: dvpnPrice ? parseFloat((parseInt(bal.amount) / 1e6 * dvpnPrice).toFixed(4)) : null,
      provider,
      multiUser: isMultiUser(),
    });
  } catch (err) {
    res.status(500).json({ error: parseChainError(err.message) });
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
    console.error('Error fetching plans:', err);
    res.status(500).json({ error: parseChainError(err.message) });
  }
});

app.get('/api/plans/:id', async (req, res) => {
  try {
    const planId = parseInt(req.params.id);
    const [stats, nodes] = await Promise.all([
      getPlanStats(planId),
      getNodesForPlan(planId),
    ]);
    const uniqueWallets = await getUniqueWallets(planId);
    res.json({ ...stats, uniqueWallets, nodes });
  } catch (err) {
    console.error(`Error fetching plan ${req.params.id}:`, err);
    res.status(500).json({ error: parseChainError(err.message) });
  }
});

app.get('/api/plans/:id/subscriptions', async (req, res) => {
  try {
    const planId = parseInt(req.params.id);
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
        console.log(`[RPC] GET /api/plans/${planId}/subscriptions failed: ${err.message} — LCD fallback`);
        d = null;
      }
    }

    if (!d) {
      d = await cached(cacheKey, 60_000, () =>
        lcd(`/sentinel/subscription/v3/plans/${planId}/subscriptions?pagination.limit=${limit}&pagination.reverse=true${keyParam}`)
      );
    }

    if (getAddr() && d.subscriptions) {
      d.subscriptions = d.subscriptions.filter(s => s.acc_address !== getAddr());
    }
    res.json(d);
  } catch (err) {
    res.status(500).json({ error: parseChainError(err.message) });
  }
});

app.get('/api/my-plans', async (req, res) => {
  if (!requireWallet(req, res)) return;
  try {
    const planIds = loadMyPlanIds();

    const [bal, ...myPlans] = await Promise.all([
      cached(`balance:${getAddr()}`, 30_000, async () => {
        const client = await getSigningClient();
        return client.getBalance(getAddr(), 'udvpn');
      }),
      ...planIds.map(id => getPlanStats(id).catch(err => {
        console.error(`Failed to get stats for plan ${id}:`, err.message);
        return null;
      })),
    ]);

    const plans = myPlans.filter(Boolean).sort((a, b) => b.planId - a.planId);
    res.json({
      address: getAddr(),
      balance: (parseInt(bal.amount) / 1e6).toFixed(2),
      plans,
    });
  } catch (err) {
    res.status(500).json({ error: parseChainError(err.message) });
  }
});

app.post('/api/plan/create', async (req, res) => {
  if (!requireWallet(req, res)) return;
  try {
    const { durationSeconds, gigabytes, priceDenom, priceQuoteValue, priceBaseValue, isPrivate } = req.body;
    if (!durationSeconds || !gigabytes) return res.status(400).json({ error: 'durationSeconds and gigabytes required' });

    const bytesStr = String(BigInt(gigabytes) * 1000000000n);

    await getSigningClient();
    const msg = {
      typeUrl: C.MSG_CREATE_PLAN_TYPE,
      value: {
        from: getProvAddr(),
        bytes: bytesStr,
        duration: parseInt(durationSeconds),
        prices: [{
          denom: priceDenom || 'udvpn',
          base_value: priceBaseValue || '0.003000000000000000',
          quote_value: String(priceQuoteValue || '1000000'),
        }],
        isPrivate: isPrivate || false,
      },
    };

    console.log(`Creating plan (v3): ${gigabytes}GB (${bytesStr} bytes), ${durationSeconds}s, quote=${priceQuoteValue} ${priceDenom || 'udvpn'}...`);
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
        console.error('Plan activation error:', err.message);
        resp.activationError = parseChainError(err.message);
      }
    }

    res.json(resp);
  } catch (err) {
    res.status(500).json({ error: parseChainError(err.message) });
  }
});

app.post('/api/plan/status', async (req, res) => {
  if (!requireWallet(req, res)) return;
  try {
    const { planId, status } = req.body;
    if (!planId || !status) return res.status(400).json({ error: 'planId and status required' });

    await getSigningClient();
    const msg = {
      typeUrl: C.MSG_UPDATE_PLAN_STATUS_TYPE,
      value: { from: getProvAddr(), id: BigInt(planId), status: parseInt(status) },
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
    console.error('Plan status error:', err.message);
    res.status(500).json({ error: parseChainError(err.message) });
  }
});

app.post('/api/plan/subscribe', async (req, res) => {
  if (!requireWallet(req, res)) return;
  try {
    const { planId, denom, renewalPolicy } = req.body;
    if (!planId) return res.status(400).json({ error: 'planId required' });

    await getSigningClient();
    const msg = {
      typeUrl: C.MSG_START_SUBSCRIPTION_TYPE,
      value: {
        from: getAddr(),
        id: BigInt(planId),
        denom: denom || 'udvpn',
        renewalPricePolicy: parseInt(renewalPolicy || 0),
      },
    };

    console.log(`Subscribing to plan ${planId} (v3)...`);
    const result = await safeBroadcast([msg]);
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
    console.error('Subscribe error:', err.message);
    res.status(500).json({ error: parseChainError(err.message) });
  }
});

app.post('/api/plan/start-session', async (req, res) => {
  if (!requireWallet(req, res)) return;
  try {
    const { subscriptionId, nodeAddress } = req.body;
    if (!subscriptionId || !nodeAddress) return res.status(400).json({ error: 'subscriptionId and nodeAddress required' });

    await getSigningClient();
    const msg = {
      typeUrl: C.MSG_SUB_START_SESSION_TYPE,
      value: {
        from: getAddr(),
        id: BigInt(subscriptionId),
        nodeAddress,
      },
    };

    console.log(`Starting session on subscription ${subscriptionId} with node ${nodeAddress} (v3)...`);
    const result = await safeBroadcast([msg]);
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
    console.error('Start session error:', err.message);
    res.status(500).json({ error: parseChainError(err.message) });
  }
});

// ─── Routes: Nodes ────────────────────────────────────────────────────────────

app.get('/api/nodes/progress', (req, res) => {
  res.json({ scanning: nodeCache.scanning, ...scanProgress });
});

app.get('/api/all-nodes', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1'));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '50')));
    const search = (req.query.search || '').toLowerCase();
    const planId = req.query.planId ? parseInt(req.query.planId) : null;
    const country = (req.query.country || '').toLowerCase();
    const protocol = (req.query.protocol || '').toLowerCase();
    const inPlanOnly = req.query.inPlanOnly === 'true';

    const all = await fetchAllNodes();

    let planNodeMap = new Map();
    if (planId) {
      try {
        const planNodes = await getNodesForPlan(planId);
        for (const n of planNodes) planNodeMap.set(n.address, n);
      } catch (err) {
        console.error(`Failed to fetch nodes for plan ${planId}:`, err.message);
      }
    }

    let filtered = all;
    if (search) filtered = filtered.filter(n => n.address.toLowerCase().includes(search) || (n.moniker || '').toLowerCase().includes(search));
    if (country) filtered = filtered.filter(n => (n.country || '').toLowerCase().includes(country));
    if (protocol) filtered = filtered.filter(n => (n.protocol || '').toLowerCase() === protocol);
    if (inPlanOnly && planId) {
      const cachedAddrs = new Set(filtered.map(n => n.address));
      filtered = filtered.filter(n => planNodeMap.has(n.address));
      // Add missing plan nodes from chain data
      for (const [addr, pn] of planNodeMap) {
        if (!cachedAddrs.has(addr)) {
          filtered.push({
            address: addr,
            moniker: null,
            country: null,
            city: null,
            protocol: null,
            speedMbps: null,
            hrPriceUdvpn: pn.hourlyPrices?.find(p => p.denom === 'udvpn')?.quote_value ? parseInt(pn.hourlyPrices.find(p => p.denom === 'udvpn').quote_value) : null,
            gbPriceUdvpn: pn.gigabytePrices?.find(p => p.denom === 'udvpn')?.quote_value ? parseInt(pn.gigabytePrices.find(p => p.denom === 'udvpn').quote_value) : null,
            remoteUrl: pn.remoteUrl || null,
            status: pn.status || 'unknown',
            notInCache: true,
          });
        }
      }
    }

    const withStatus = filtered.map(n => {
      const planNode = planNodeMap.get(n.address);
      return { ...n, inPlan: !!planNode, leaseExpiresAt: planNode?.inactiveAt || null };
    });

    const countries = [...new Set(all.map(n => n.country).filter(Boolean))].sort();
    const protocols = [...new Set(all.map(n => n.protocol).filter(Boolean))].sort();

    const start = (page - 1) * limit;
    const paged = withStatus.slice(start, start + limit);

    res.json({
      nodes: paged,
      total: filtered.length,
      page,
      totalPages: Math.ceil(filtered.length / limit),
      planNodesCount: planNodeMap.size,
      countries,
      protocols,
    });
  } catch (err) {
    res.status(500).json({ error: parseChainError(err.message) });
  }
});

app.get('/api/nodes/:addr/sessions', async (req, res) => {
  try {
    const addr = req.params.addr;
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
    res.status(500).json({ error: parseChainError(err.message) });
  }
});

// ─── Routes: Leases ───────────────────────────────────────────────────────────

app.post('/api/plan-manager/link', async (req, res) => {
  if (!requireWallet(req, res)) return;
  try {
    const { planId, nodeAddress, leaseHours: reqLeaseHours } = req.body;
    if (!planId || !nodeAddress) return res.status(400).json({ error: 'Plan ID and node address are required' });

    await getSigningClient();
    const linkMsg = {
      typeUrl: C.MSG_LINK_TYPE,
      value: { from: getProvAddr(), id: BigInt(planId), nodeAddress },
    };

    const hours = parseInt(reqLeaseHours) || 24;
    console.log(`\n[LINK] Node ${nodeAddress} → plan ${planId} (lease: ${hours}h)`);

    let result;
    try {
      console.log(`[LINK] Step 1: Direct link attempt...`);
      result = await safeBroadcast([linkMsg]);
    } catch (err) {
      const msg = err.message || '';
      console.log(`[LINK] Step 1 threw: ${msg.slice(0, 150)}`);
      if (isDuplicateNode(msg)) return res.json({ ok: true, alreadyLinked: true, msg: 'Node is already in this plan' });
      if (!isLeaseNotFound(msg)) return res.status(400).json({ error: parseChainError(msg) });

      try {
        console.log(`[LINK] Step 2: Auto-leasing first...`);
        await autoLeaseNode(nodeAddress, hours);
        console.log(`[LINK] Step 3: Retrying link after lease...`);
      } catch (le) {
        console.log(`[LINK] Auto-lease failed: ${le.message}`);
        return res.status(400).json({ error: `Auto-lease failed: ${le.message}` });
      }
      result = await safeBroadcast([linkMsg]);
    }

    const resp = txResponse(result);

    if (!resp.ok) {
      console.log(`[LINK] TX failed in rawLog: ${(resp.rawLog || '').slice(0, 150)}`);
      if (isDuplicateNode(resp.rawLog)) return res.json({ ok: true, alreadyLinked: true, msg: 'Node is already in this plan' });
      if (isLeaseNotFound(resp.rawLog)) {
        try {
          console.log(`[LINK] Lease not found in rawLog — auto-leasing then retrying...`);
          await autoLeaseNode(nodeAddress, hours);
          const result2 = await safeBroadcast([linkMsg]);
          const resp2 = txResponse(result2);
          if (resp2.ok) { console.log(`[LINK] OK (after auto-lease): tx=${resp2.txHash}`); return res.json(resp2); }
          console.log(`[LINK] Still failed after auto-lease: ${(resp2.rawLog || '').slice(0, 150)}`);
          return res.status(400).json({ error: parseChainError(resp2.rawLog) });
        } catch (le) {
          console.log(`[LINK] Auto-lease failed: ${le.message}`);
          return res.status(400).json({ error: `Auto-lease failed: ${le.message}` });
        }
      }
      return res.status(400).json({ error: parseChainError(resp.rawLog) });
    }

    console.log(`[LINK] OK: tx=${resp.txHash}`);
    res.json(resp);
  } catch (err) {
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
    const hours = parseInt(reqLeaseHours) || 24;
    const addrs = [...new Set(nodeAddresses)];
    console.log(`\n[BATCH-LINK] ${addrs.length} nodes → plan ${planId} (lease: ${hours}h)`);

    await getSigningClient();

    const linkMsgs = addrs.map(addr => ({
      typeUrl: C.MSG_LINK_TYPE,
      value: { from: getProvAddr(), id: BigInt(planId), nodeAddress: addr },
    }));

    console.log(`[BATCH-LINK] Step 1: Attempting ${addrs.length} links in one TX...`);
    let result;
    try {
      result = await safeBroadcast(linkMsgs);
    } catch (err) {
      const msg = err.message || '';
      console.log(`[BATCH-LINK] Step 1 threw: ${msg.slice(0, 200)}`);

      if (isLeaseNotFound(msg)) {
        console.log(`[BATCH-LINK] Step 2: Leasing all nodes first...`);
        try {
          await batchLeaseNodes(addrs, hours);
        } catch (le) {
          console.log(`[BATCH-LINK] Batch lease failed: ${le.message}`);
          return res.status(400).json({ error: `Batch lease failed: ${le.message}` });
        }
        console.log(`[BATCH-LINK] Step 3: Retrying batch link after leases...`);
        result = await safeBroadcast(linkMsgs);
      } else if (isDuplicateNode(msg)) {
        return res.json({ ok: true, linked: 0, alreadyLinked: addrs.length, msg: 'All nodes already in plan' });
      } else {
        return res.status(400).json({ error: parseChainError(msg) });
      }
    }

    const resp = txResponse(result);

    if (!resp.ok) {
      const raw = resp.rawLog || '';
      console.log(`[BATCH-LINK] TX failed: ${raw.slice(0, 200)}`);

      if (isLeaseNotFound(raw)) {
        console.log(`[BATCH-LINK] Lease not found in rawLog — batch leasing then retrying...`);
        try {
          await batchLeaseNodes(addrs, hours);
          const result2 = await safeBroadcast(linkMsgs);
          const resp2 = txResponse(result2);
          if (resp2.ok) {
            console.log(`[BATCH-LINK] OK (after batch lease): tx=${resp2.txHash}`);
            return res.json({ ...resp2, linked: addrs.length });
          }
          console.log(`[BATCH-LINK] Still failed: ${(resp2.rawLog || '').slice(0, 150)}`);
          return res.status(400).json({ error: parseChainError(resp2.rawLog) });
        } catch (le) {
          return res.status(400).json({ error: `Batch lease failed: ${le.message}` });
        }
      }

      if (isDuplicateNode(raw)) {
        return res.json({ ok: true, linked: 0, alreadyLinked: addrs.length, msg: 'Nodes already in plan' });
      }

      return res.status(400).json({ error: parseChainError(raw) });
    }

    console.log(`[BATCH-LINK] OK: ${addrs.length} nodes linked, tx=${resp.txHash}`);
    res.json({ ...resp, linked: addrs.length });
  } catch (err) {
    console.error('[BATCH-LINK] Error:', err.message);
    res.status(500).json({ error: parseChainError(err.message) });
  }
});

app.post('/api/plan-manager/unlink', async (req, res) => {
  if (!requireWallet(req, res)) return;
  try {
    const { planId, nodeAddress } = req.body;
    if (!planId || !nodeAddress) return res.status(400).json({ error: 'Plan ID and node address are required' });

    await getSigningClient();
    const msg = {
      typeUrl: C.MSG_UNLINK_TYPE,
      value: { from: getProvAddr(), id: BigInt(planId), nodeAddress },
    };

    console.log(`Unlinking node ${nodeAddress} from plan ${planId}...`);
    let result;
    try {
      result = await safeBroadcast([msg]);
    } catch (err) {
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
    const addrs = [...new Set(nodeAddresses)];
    console.log(`\n[BATCH-UNLINK] ${addrs.length} nodes from plan ${planId}`);

    await getSigningClient();
    const msgs = addrs.map(addr => ({
      typeUrl: C.MSG_UNLINK_TYPE,
      value: { from: getProvAddr(), id: BigInt(planId), nodeAddress: addr },
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
    console.error('[BATCH-UNLINK] Error:', err.message);
    res.status(500).json({ error: parseChainError(err.message) });
  }
});

app.post('/api/lease/start', async (req, res) => {
  if (!requireWallet(req, res)) return;
  try {
    const { nodeAddress, hours, maxPriceDenom, maxPriceBaseValue, maxPriceQuoteValue, renewalPolicy } = req.body;
    if (!nodeAddress) return res.status(400).json({ error: 'nodeAddress required' });

    await getSigningClient();
    const msg = {
      typeUrl: C.MSG_START_LEASE_TYPE,
      value: {
        from: getProvAddr(),
        nodeAddress,
        hours: parseInt(hours || 720),
        maxPrice: {
          denom: maxPriceDenom || 'udvpn',
          base_value: maxPriceBaseValue || '0.003000000000000000',
          quote_value: String(maxPriceQuoteValue || '40152030'),
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
    console.error('Lease start error:', err.message);
    res.status(500).json({ error: parseChainError(err.message) });
  }
});

app.post('/api/lease/end', async (req, res) => {
  if (!requireWallet(req, res)) return;
  try {
    const { leaseId } = req.body;
    if (!leaseId) return res.status(400).json({ error: 'leaseId required' });

    await getSigningClient();
    const msg = {
      typeUrl: C.MSG_END_LEASE_TYPE,
      value: { from: getProvAddr(), id: BigInt(leaseId) },
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
    res.status(500).json({ error: parseChainError(err.message) });
  }
});

app.post('/api/provider/register', async (req, res) => {
  if (!requireWallet(req, res)) return;
  try {
    const { name, identity, website, description } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    await getSigningClient();

    let alreadyExists = false;
    try {
      const provs = await lcd('/sentinel/provider/v2/providers?pagination.limit=500');
      alreadyExists = (provs.providers || []).some(p => p.address.includes(getAddr().slice(4, 20)));
    } catch (err) {
      console.error('Failed to check existing providers:', err.message);
    }

    const typeUrl = alreadyExists ? C.MSG_UPDATE_PROVIDER_DETAILS_TYPE : C.MSG_REGISTER_PROVIDER_TYPE;
    const fromAddr = alreadyExists ? getProvAddr() : getAddr();
    const action = alreadyExists ? 'Updating' : 'Registering';
    const msg = {
      typeUrl,
      value: { from: fromAddr, name, identity: identity || '', website: website || '', description: description || '' },
    };

    console.log(`${action} provider "${name}" (v3)...`);
    const result = await safeBroadcast([msg]);
    const resp = txResponse(result);
    resp.action = alreadyExists ? 'updated' : 'registered';
    if (!resp.ok) {
      console.log(`Provider ${action} FAIL: code=${resp.code} ${resp.rawLog}`);
      return res.status(400).json({ ...resp, error: parseChainError(resp.rawLog) });
    }

    console.log(`Provider ${resp.action}: tx=${resp.txHash}`);
    cacheInvalidate(`provider:${getAddr()}`);

    // Fresh registrations land on chain with status=inactive; plans cannot
    // be created until the provider is active. Broadcast a follow-up
    // MsgUpdateProviderStatus (status=1) as a separate TX.
    if (!alreadyExists) {
      try {
        const statusMsg = {
          typeUrl: C.MSG_UPDATE_PROVIDER_STATUS_TYPE,
          value: { from: getProvAddr(), status: 1 },
        };
        console.log('Activating provider (status=1, separate TX)...');
        const statusResult = await safeBroadcast([statusMsg]);
        const statusResp = txResponse(statusResult);
        resp.activation = statusResp;
        if (statusResp.ok) {
          console.log(`Provider activated: tx=${statusResp.txHash}`);
          cacheInvalidate(`provider:${getAddr()}`);
        } else {
          console.log(`Provider activation FAIL: code=${statusResp.code} ${statusResp.rawLog}`);
          resp.activationError = parseChainError(statusResp.rawLog);
        }
      } catch (err) {
        console.error('Provider activation error:', err.message);
        resp.activationError = parseChainError(err.message);
      }
    }

    res.json(resp);
  } catch (err) {
    console.error('Provider register/update error:', err.message);
    res.status(500).json({ error: parseChainError(err.message) });
  }
});

app.post('/api/provider/status', async (req, res) => {
  if (!requireWallet(req, res)) return;
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'status required (1=active, 2=inactive_pending, 3=inactive)' });

    await getSigningClient();
    const msg = {
      typeUrl: C.MSG_UPDATE_PROVIDER_STATUS_TYPE,
      value: { from: getProvAddr(), status: parseInt(status) },
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

app.post('/api/feegrant/grant', async (req, res) => {
  if (!getAddr()) return res.status(401).json({ error: 'No wallet loaded' });
  const { grantee, spendLimitDvpn, expirationDays } = req.body;
  if (!grantee) return res.status(400).json({ error: 'grantee address required' });

  try {
    const { MsgGrantAllowance } = await import('cosmjs-types/cosmos/feegrant/v1beta1/tx');
    const { BasicAllowance } = await import('cosmjs-types/cosmos/feegrant/v1beta1/feegrant');
    const { Any } = await import('cosmjs-types/google/protobuf/any');

    const allowanceValue = {};
    if (spendLimitDvpn && spendLimitDvpn > 0) {
      allowanceValue.spendLimit = [{ denom: 'udvpn', amount: String(Math.round(spendLimitDvpn * 1e6)) }];
    }
    if (expirationDays && expirationDays > 0) {
      const exp = new Date(Date.now() + expirationDays * 86400000);
      allowanceValue.expiration = {
        seconds: BigInt(Math.floor(exp.getTime() / 1000)),
        nanos: 0,
      };
    }

    const encodedAllowance = Any.fromPartial({
      typeUrl: '/cosmos.feegrant.v1beta1.BasicAllowance',
      value: BasicAllowance.encode(BasicAllowance.fromPartial(allowanceValue)).finish(),
    });

    const msg = {
      typeUrl: '/cosmos.feegrant.v1beta1.MsgGrantAllowance',
      value: MsgGrantAllowance.fromPartial({
        granter: getAddr(),
        grantee,
        allowance: encodedAllowance,
      }),
    };

    const result = await safeBroadcast([msg], 'Fee grant');
    if (result.code !== 0) throw new Error(result.rawLog || `TX failed code=${result.code}`);
    res.json({ ok: true, txHash: result.transactionHash });
  } catch (e) {
    res.status(500).json({ error: parseChainError(e.message) });
  }
});

// SSE stream: grant fee allowance to all subscribers of a plan
app.get('/api/feegrant/grant-subscribers-stream', async (req, res) => {
  if (!getAddr()) return res.status(401).json({ error: 'No wallet loaded' });
  const { planId, spendLimitDvpn, expirationDays } = req.query;
  if (!planId) return res.status(400).json({ error: 'planId required' });

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
      console.log(`[RPC] rpcQuerySubscriptionsForPlan failed: ${err.message}`);
    }
    if (!subsFromRpc) {
      const subData = await lcd(`/sentinel/subscription/v3/plans/${planId}/subscriptions?pagination.limit=500`);
      subs = subData.subscriptions || [];
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

    const { MsgGrantAllowance } = await import('cosmjs-types/cosmos/feegrant/v1beta1/tx');
    const { BasicAllowance } = await import('cosmjs-types/cosmos/feegrant/v1beta1/feegrant');
    const { Any } = await import('cosmjs-types/google/protobuf/any');

    const allowanceValue = {};
    const limitNum = parseFloat(spendLimitDvpn) || 0;
    const expNum = parseInt(expirationDays) || 0;
    if (limitNum > 0) {
      allowanceValue.spendLimit = [{ denom: 'udvpn', amount: String(Math.round(limitNum * 1e6)) }];
    }
    if (expNum > 0) {
      const exp = new Date(Date.now() + expNum * 86400000);
      allowanceValue.expiration = {
        seconds: BigInt(Math.floor(exp.getTime() / 1000)),
        nanos: 0,
      };
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

      const msgs = batch.map(grantee => ({
        typeUrl: '/cosmos.feegrant.v1beta1.MsgGrantAllowance',
        value: MsgGrantAllowance.fromPartial({
          granter: getAddr(),
          grantee,
          allowance: Any.fromPartial({
            typeUrl: '/cosmos.feegrant.v1beta1.BasicAllowance',
            value: BasicAllowance.encode(BasicAllowance.fromPartial(allowanceValue)).finish(),
          }),
        }),
      }));

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
      console.log(`[RPC] rpcQuerySubscriptionsForPlan failed: ${err.message}`);
    }
    if (!subsFromRpc) {
      const subData = await lcd(`/sentinel/subscription/v3/plans/${planId}/subscriptions?pagination.limit=500`, 60000);
      subs = subData.subscriptions || [];
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

    const { MsgGrantAllowance } = await import('cosmjs-types/cosmos/feegrant/v1beta1/tx');
    const { BasicAllowance } = await import('cosmjs-types/cosmos/feegrant/v1beta1/feegrant');
    const { Any } = await import('cosmjs-types/google/protobuf/any');

    const allowanceValue = {};
    if (spendLimitDvpn && spendLimitDvpn > 0) {
      allowanceValue.spendLimit = [{ denom: 'udvpn', amount: String(Math.round(spendLimitDvpn * 1e6)) }];
    }
    if (expirationDays && expirationDays > 0) {
      const exp = new Date(Date.now() + expirationDays * 86400000);
      allowanceValue.expiration = {
        seconds: BigInt(Math.floor(exp.getTime() / 1000)),
        nanos: 0,
      };
    }

    const BATCH = 5;
    const totalBatches = Math.ceil(needGrant.length / BATCH);
    let granted = 0;
    const errors = [];
    for (let i = 0; i < needGrant.length; i += BATCH) {
      const batchNum = Math.floor(i / BATCH) + 1;
      const batch = needGrant.slice(i, i + BATCH);
      console.log(`[FeeGrant] Batch ${batchNum}/${totalBatches}: ${batch.length} addresses`);
      const msgs = batch.map(grantee => ({
        typeUrl: '/cosmos.feegrant.v1beta1.MsgGrantAllowance',
        value: MsgGrantAllowance.fromPartial({
          granter: getAddr(),
          grantee,
          allowance: Any.fromPartial({
            typeUrl: '/cosmos.feegrant.v1beta1.BasicAllowance',
            value: BasicAllowance.encode(BasicAllowance.fromPartial(allowanceValue)).finish(),
          }),
        }),
      }));
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

  try {
    const { MsgRevokeAllowance } = await import('cosmjs-types/cosmos/feegrant/v1beta1/tx');
    const msg = {
      typeUrl: '/cosmos.feegrant.v1beta1.MsgRevokeAllowance',
      value: MsgRevokeAllowance.fromPartial({
        granter: getAddr(),
        grantee,
      }),
    };
    const result = await safeBroadcast([msg], 'Revoke fee grant');
    if (result.code !== 0) throw new Error(result.rawLog || `TX failed code=${result.code}`);
    res.json({ ok: true, txHash: result.transactionHash });
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
      console.log(`[RPC] rpcQueryFeeGrantsIssued failed: ${err.message}`);
    }
    if (!revokeAllowances.length) {
      const existingData = await lcd(`/cosmos/feegrant/v1beta1/issued/${getAddr()}?pagination.limit=500`);
      revokeAllowances = existingData.allowances || [];
    }
    const grantees = revokeAllowances.map(a => a.grantee);

    if (grantees.length === 0) return res.json({ ok: true, revoked: 0, message: 'No grants to revoke' });

    const { MsgRevokeAllowance } = await import('cosmjs-types/cosmos/feegrant/v1beta1/tx');
    const BATCH = 5;
    let revoked = 0;
    const errors = [];
    for (let i = 0; i < grantees.length; i += BATCH) {
      const batch = grantees.slice(i, i + BATCH);
      const msgs = batch.map(grantee => ({
        typeUrl: '/cosmos.feegrant.v1beta1.MsgRevokeAllowance',
        value: MsgRevokeAllowance.fromPartial({ granter: getAddr(), grantee }),
      }));
      try {
        const result = await safeBroadcast(msgs, `Revoke batch ${Math.floor(i / BATCH) + 1}`);
        if (result.code !== 0) throw new Error(result.rawLog || `TX failed code=${result.code}`);
        revoked += batch.length;
      } catch (e) {
        errors.push(`Batch ${Math.floor(i / BATCH) + 1}: ${parseChainError(e.message)}`);
      }
    }

    res.json({ ok: true, revoked, errors: errors.length ? errors : undefined });
  } catch (e) {
    res.status(500).json({ error: parseChainError(e.message) });
  }
});

// ─── Routes: Analytics ───────────────────────────────────────────────────────

app.get('/api/feegrant/gas-costs', async (req, res) => {
  if (!getAddr()) return res.status(401).json({ error: 'No wallet loaded' });
  const { planId } = req.query;
  if (!planId) return res.status(400).json({ error: 'planId required' });

  try {
    const subData = await cached(`planSubs:${planId}:500:`, 60_000, async () => {
      // RPC-first: returns array directly; wrap to match LCD shape { subscriptions: [...] }.
      try {
        const rpc = await getRpcClient();
        if (rpc) {
          const rpcResult = await rpcQuerySubscriptionsForPlan(rpc, planId, { limit: 10000 });
          if (rpcResult) return { subscriptions: rpcResult };
        }
      } catch (err) {
        console.log(`[RPC] gas-costs subs(${planId}) failed: ${err.message} — LCD fallback`);
      }
      return lcd(`/sentinel/subscription/v3/plans/${planId}/subscriptions?pagination.limit=500`);
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
        console.error(`[GasCosts] ${addr.slice(0, 12)}... failed: ${err.message}`);
      }
    }
    console.log(`[GasCosts] Done: ${totalUdvpn} udvpn across ${txCount} txs from ${Object.keys(byAddress).length} addresses`);

    res.json({ ok: true, totalUdvpn, txCount, byAddress, subscriberCount: subscriberAddrs.length });
  } catch (e) {
    res.status(500).json({ error: parseChainError(e.message) });
  }
});

let _autoGrantSettings = { enabled: false, spendLimitDvpn: 10, expirationDays: 30 };

app.get('/api/feegrant/auto-grant', (req, res) => {
  res.json(_autoGrantSettings);
});

app.post('/api/feegrant/auto-grant', (req, res) => {
  const { enabled, spendLimitDvpn, expirationDays } = req.body;
  if (typeof enabled === 'boolean') _autoGrantSettings.enabled = enabled;
  if (typeof spendLimitDvpn === 'number') _autoGrantSettings.spendLimitDvpn = spendLimitDvpn;
  if (typeof expirationDays === 'number') _autoGrantSettings.expirationDays = expirationDays;
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
    res.status(500).json({ error: parseChainError(err.message) });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ─── Start ────────────────────────────────────────────────────────────────────

const _savedMnemonic = loadSavedWallet();
if (isMultiUser()) {
  console.log('[wallet] MULTI_USER=true — skipping env/disk wallet bootstrap. Each visitor logs in with their own mnemonic.');
} else if (_savedMnemonic) {
  initWallet(_savedMnemonic).then(() => {
    console.log(`Restored wallet: ${getAddr()}`);
  }).catch(err => {
    console.error('Failed to restore wallet:', err.message);
    clearWalletState();
  });
} else {
  const envPath = join(__dirname, '.env');
  const fromProcess = (process.env.MNEMONIC || '').trim();
  const fromFile = existsSync(envPath)
    ? (readFileSync(envPath, 'utf8').match(/^MNEMONIC=(.+)$/m)?.[1] || '').trim()
    : '';
  const envMnemonic = fromProcess || fromFile;
  const source = fromProcess ? 'environment' : '.env';
  const isPlaceholder = /your twelve or twenty four/i.test(envMnemonic);
  if (envMnemonic && !isPlaceholder) {
    initWallet(envMnemonic).then(() => {
      console.log(`[wallet] Loaded from ${source}: ${getAddr()}`);
    }).catch(err => {
      console.error(`[wallet] Failed to load from ${source}: ${err.message}`);
      clearWalletState();
    });
  } else {
    console.warn('[wallet] No wallet loaded. Create one in the UI, set MNEMONIC=... in .env (copy from .env.example), or pass MNEMONIC via the process environment. Chain writes (plans, links, grants) are disabled until a wallet is present.');
  }
}

const server = app.listen(PORT, () => {
  console.log(`Plan Manager running on http://localhost:${PORT}`);
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
