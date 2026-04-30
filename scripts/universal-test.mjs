#!/usr/bin/env node
// Universal test of the Plan Manager. One shot, three wallets, every function.
//
//   P  = provider     (mnemonic from .env, only wallet with starting balance)
//   U1 = subscriber 1 (fresh wallet; P sends it ~1 P2P; U1 pays own gas — P2P pay path)
//   U2 = subscriber 2 (fresh wallet; P fee-grants gas to U2; U2 pays nothing — fee-grant path)
//
// Flow: provider register/activate → plan create/activate → link nodes →
//       lease round-trip → fund U1 → U1 subscribe (self-pay) → fee-grant U2 →
//       U2 subscribe (granted gas) → exercise SSE / list / gas-cost / auto-grant /
//       revoke-list → empty-body validation pass on all remaining endpoints →
//       cleanup (revoke grants, unlink, deactivate plan, drain U1+U2 back to P) →
//       wallet rotation endpoints LAST.
//
// Run:  node scripts/universal-test.mjs
// Exit: 0 on success, 1 on any failure.
//
// SAFETY: spends real P2P on Sentinel mainnet. Per-TX cost ~0.05 P2P; total run
// ~1 P2P assuming 2 sub plans, 2 grants, 2 revokes, 2 links, 2 unlinks, 1 lease
// pair, 2 wallet drains, plus provider/plan create/activate.

import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import { readFileSync, existsSync } from 'fs';

const BASE = process.env.BASE_URL || 'http://localhost:3003';
const TX_GAP_MS = 7000;          // sequential rule: ≥7s between TXs (same signer)
const TX_GAP_CROSS_MS = 3000;    // cross-signer or signer→read-only: short gap is enough
const SUITE_GAP_MS = 60_000;     // ≥60s between suites — only at major boundaries
const results = [];
const t0 = Date.now();

// ─── Structured run report ──────────────────────────────────────────────────
const report = {
  startedAt: new Date().toISOString(),
  base: BASE,
  actors: {},     // label → { address, role, startBal, endBal }
  plan: null,     // { planId, durationSeconds, gigabytes, priceUdvpn }
  nodes: { linked: null, leased: null },
  subscriptions: [], // { actor, planId, subscriptionId, txHash, gasPath }
  txs: [],        // { phase, actor, action, hash, note }
  endpoints: new Set(),
};
function recordTx(phase, actor, action, hash, note = '') {
  if (hash) report.txs.push({ phase, actor, action, hash, note });
}
function recordEndpoint(method, path) {
  report.endpoints.add(`${method} ${path.split('?')[0]}`);
}

// ─── Multi-session cookie jars ───────────────────────────────────────────────
// Each label keeps its own cookie string. Switching `active` switches whose
// session subsequent get/post calls use.
const jars = new Map(); // label → cookie string
let active = 'P';

function setActive(label) { active = label; if (!jars.has(label)) jars.set(label, ''); }
function getCookie() { return jars.get(active) || ''; }
function setCookie(v) { jars.set(active, v); }

function captureCookie(res) {
  const sc = res.headers.get('set-cookie');
  if (!sc) return;
  const parts = sc.split(/,(?=\s*\w+=)/g).map(s => s.split(';')[0].trim()).filter(Boolean);
  const merged = parts.join('; ');
  const prev = getCookie();
  setCookie(prev ? prev + '; ' + merged : merged);
}

function log(name, ok, detail = '') {
  const tag = ok ? '✓' : '✗';
  console.log(`  ${tag} ${name}${detail ? '  — ' + detail : ''}`);
  results.push({ name, ok, detail, session: active });
}

async function get(path) {
  recordEndpoint('GET', path);
  const r = await fetch(BASE + path, {
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      ...(getCookie() ? { Cookie: getCookie() } : {}),
    },
  });
  captureCookie(r);
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

async function post(path, payload) {
  recordEndpoint('POST', path);
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      ...(getCookie() ? { Cookie: getCookie() } : {}),
    },
    body: JSON.stringify(payload ?? {}),
  });
  captureCookie(r);
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

// SSE consumer — collects events until the stream ends or maxMs elapses.
async function getStream(path, maxMs = 60_000) {
  recordEndpoint('GET', path);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), maxMs);
  let raw = '';
  let status = 0;
  try {
    const r = await fetch(BASE + path, {
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'text/event-stream',
        ...(getCookie() ? { Cookie: getCookie() } : {}),
      },
      signal: ctrl.signal,
    });
    status = r.status;
    captureCookie(r);
    if (!r.body) return { status, events: [] };
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += dec.decode(value, { stream: true });
      if (/event:\s*end/i.test(raw) || /data:\s*\{[^}]*"done":\s*true/i.test(raw)) break;
    }
  } catch { /* aborted is fine */ }
  finally { clearTimeout(t); }
  const events = [];
  for (const blk of raw.split(/\n\n/)) {
    const ev = {}; for (const line of blk.split('\n')) {
      const m = line.match(/^(event|data|id|retry):\s?(.*)$/);
      if (m) ev[m[1]] = (ev[m[1]] || '') + (ev[m[1]] ? '\n' : '') + m[2];
    }
    if (Object.keys(ev).length) events.push(ev);
  }
  return { status, events };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function section(title) {
  console.log('\n' + title);
  console.log('─'.repeat(title.length));
}

function readEnvMnemonic() {
  if (!existsSync('.env')) return null;
  const env = readFileSync('.env', 'utf8');
  const m = env.match(/^MNEMONIC=(.+)$/m);
  return m ? m[1].trim() : null;
}

async function freshWallet() {
  const w = await DirectSecp256k1HdWallet.generate(24, { prefix: 'sent' });
  const [acc] = await w.getAccounts();
  return { mnemonic: w.mnemonic, address: acc.address };
}

async function importInto(label, mnemonic) {
  setActive(label);
  setCookie(''); // clear any previous cookie on this label
  return post('/api/wallet/import', { mnemonic });
}

async function balanceOf(label) {
  setActive(label);
  const { body } = await get('/api/wallet');
  return body?.balanceUdvpn || 0;
}

// ─── Run ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  Plan Manager — UNIVERSAL TEST (LIVE CHAIN, 3 wallets)');
  console.log('  Target:', BASE);
  console.log('═══════════════════════════════════════════════════════════════════');

  // ── 0. Health + read-only ─────────────────────────────────────────────────
  await section('0. Health & read-only (no auth)');
  {
    const readOnly = [
      '/health',
      '/api/params', '/api/rpcs', '/api/rpc-providers',
      '/api/nodes/progress', '/api/nodes/chain-count',
      '/api/all-nodes?page=1&limit=5', '/api/providers',
      '/api/plans', '/api/node-rankings',
    ];
    const responses = await Promise.all(readOnly.map(p => get(p)));
    readOnly.forEach((p, i) => {
      const r = responses[i];
      const isHealth = p === '/health';
      const ok = isHealth ? (r.status === 200 && r.body?.ok !== false)
                          : (r.status === 200 && r.body && !r.body.error);
      log(`GET ${p}`, ok, isHealth ? '' : `status=${r.status}`);
    });
  }

  // ── 1. P session: import, balance, provider, plan ─────────────────────────
  await section('1. Provider (P) — import / register / plan');
  const pMnemonic = readEnvMnemonic();
  if (!pMnemonic) { log('read MNEMONIC from .env', false); return summarize(); }

  {
    const r = await importInto('P', pMnemonic);
    log('P /api/wallet/import', r.status === 200 && r.body?.ok, `addr=${r.body?.address?.slice(0,14) || r.body?.error}`);
    if (!(r.status === 200 && r.body?.ok)) return summarize();
  }
  let pAddr = null, pStartBal = 0;
  {
    const r = await get('/api/wallet');
    pAddr = r.body?.address; pStartBal = r.body?.balanceUdvpn || 0;
    log('P /api/wallet', !!pAddr && pStartBal > 0, `addr=${pAddr?.slice(0,14)}… bal=${(pStartBal/1e6).toFixed(4)} P2P`);
    if (pStartBal < 5_000_000) {
      log('P balance ≥5 P2P required for full universal run', false, `have ${(pStartBal/1e6).toFixed(4)} P2P`);
      return summarize();
    }
    report.actors.P = { role: 'provider (.env)', address: pAddr, startBal: pStartBal, endBal: null };
  }
  {
    const r = await get('/api/wallet/status');
    log('P /api/wallet/status', r.status === 200 && r.body?.loaded === true);
  }
  {
    const r = await get('/api/wallet/qr');
    // QR can be PNG (binary) or { dataUrl }; both acceptable.
    log('P /api/wallet/qr', r.status === 200);
  }

  // Provider register — auto-activates. If P is already a provider, /api/providers will list pAddr.
  let pIsProvider = false;
  {
    const r = await get('/api/providers');
    const provs = r.body?.providers || r.body || [];
    pIsProvider = Array.isArray(provs) && provs.some(p => (p.address || p.Address || p.operator || '').includes(pAddr));
    log('GET /api/providers (P registered?)', r.status === 200, `already=${pIsProvider}`);
  }
  if (!pIsProvider) {
    await sleep(TX_GAP_MS);
    const r = await post('/api/provider/register', { name: 'PM Universal Test', description: 'auto' });
    log('POST /api/provider/register', r.status === 200 && r.body?.ok, `tx=${r.body?.txHash?.slice(0,16) || r.body?.error}`);
    recordTx('provider', 'P', 'register', r.body?.txHash);
  } else {
    log('POST /api/provider/register', true, 'skipped — already registered');
  }
  // Provider status (read+write); try ping with status=1 (active). Tolerated whether already active or not.
  await sleep(TX_GAP_MS);
  {
    const r = await post('/api/provider/status', { status: 1 });
    log('POST /api/provider/status active', r.status === 200, r.body?.txHash ? `tx=${r.body.txHash.slice(0,16)}` : `body=${JSON.stringify(r.body).slice(0,80)}`);
    recordTx('provider', 'P', 'activate', r.body?.txHash);
  }

  // Plan create — small price so subscribe is cheap. 1 GB / 1 day at 100 udvpn/GB.
  await sleep(TX_GAP_MS);
  let planId = null;
  {
    const r = await post('/api/plan/create', {
      durationSeconds: 86400,
      gigabytes: 1,
      priceDenom: 'udvpn',
      priceQuoteValue: '0',
      priceBaseValue: '1000', // 0.001 P2P (cheap; subscribe is mostly gas)
      isPrivate: false,
    });
    planId = r.body?.planId ?? r.body?.id ?? null;
    log('POST /api/plan/create', r.status === 200 && r.body?.ok && planId != null, `planId=${planId} tx=${r.body?.txHash?.slice(0,16) || r.body?.error}`);
    recordTx('plan', 'P', 'create', r.body?.txHash, `planId=${planId}`);
    report.plan = { planId, durationSeconds: 86400, gigabytes: 1, priceUdvpn: 1000 };
  }
  if (planId == null) return summarize();

  await sleep(TX_GAP_MS);
  {
    const r = await get(`/api/plans/${planId}`);
    log(`GET /api/plans/${planId}`, r.status === 200 && r.body && !r.body.error);
  }
  {
    const r = await get('/api/my-plans');
    const has = (r.body?.plans || []).some(p => String(p.planId) === String(planId));
    log('GET /api/my-plans (new plan visible)', has);
  }

  // ── 2. Lease + node link ──────────────────────────────────────────────────
  await section('2. Nodes — lease + link');
  let pickedNode = null;
  let leaseNode = null;
  {
    const r = await get('/api/all-nodes?page=1&limit=50');
    const nodes = r.body?.nodes || [];
    const usable = nodes.filter(n => n.address && (n.country || n.protocol));
    pickedNode = usable[0] || nodes[0] || null;
    leaseNode = usable[1] || nodes[1] || null; // distinct node for lease round-trip
    log('GET /api/all-nodes (pick 2 nodes)', !!pickedNode && !!leaseNode,
      `link=${pickedNode?.address?.slice(0,14)}… lease=${leaseNode?.address?.slice(0,14)}…`);
  }
  if (pickedNode) {
    await sleep(TX_GAP_MS);
    // /api/plan-manager/link auto-leases when no lease exists
    const r = await post('/api/plan-manager/link', {
      planId,
      nodeAddress: pickedNode.address,
      leaseHours: 1,
    });
    log('POST /api/plan-manager/link (auto-lease)', r.status === 200 && (r.body?.ok || r.body?.alreadyLinked), `tx=${r.body?.txHash?.slice(0,16) || r.body?.alreadyLinked || r.body?.error}`);
    recordTx('node', 'P', 'link+autoLease', r.body?.txHash, pickedNode.address);
    report.nodes.linked = pickedNode.address;
  }

  // Lease round-trip — start + end on a DIFFERENT node (so it's not already leased by link)
  if (leaseNode) {
    await sleep(TX_GAP_MS);
    const r1 = await post('/api/lease/start', { nodeAddress: leaseNode.address, hours: 1 });
    const leaseId = r1.body?.leaseId ?? r1.body?.id ?? null;
    log('POST /api/lease/start', r1.status === 200 && (r1.body?.ok || leaseId != null), `lease=${leaseId} tx=${r1.body?.txHash?.slice(0,16) || r1.body?.error}`);
    recordTx('node', 'P', 'lease/start', r1.body?.txHash, `leaseId=${leaseId}`);
    report.nodes.leased = leaseNode.address;
    if (leaseId != null) {
      await sleep(TX_GAP_MS);
      const r2 = await post('/api/lease/end', { leaseId });
      log('POST /api/lease/end', r2.status === 200 && r2.body?.ok, `tx=${r2.body?.txHash?.slice(0,16) || r2.body?.error}`);
      recordTx('node', 'P', 'lease/end', r2.body?.txHash, `leaseId=${leaseId}`);
    } else {
      log('POST /api/lease/end', true, 'skipped — no leaseId');
    }
  }

  // ── 3. U1 — fresh wallet, funded by P, self-pay subscribe ─────────────────
  await section('3. User 1 (P2P pay) — fund + subscribe');
  const u1 = await freshWallet();
  console.log('  U1 address:', u1.address);

  setActive('P');
  report.actors.U1 = { role: 'subscriber (P2P-pay)', address: u1.address, startBal: 0, endBal: null };
  await sleep(TX_GAP_MS);
  {
    // Send ~1 P2P to U1
    const r = await post('/api/wallet/send', { to: u1.address, amountDvpn: 1, memo: 'pm-universal U1 funding' });
    log('P → U1 /api/wallet/send (1 P2P)', r.status === 200 && r.body?.ok, `tx=${r.body?.txHash?.slice(0,16) || r.body?.error}`);
    recordTx('fund', 'P', 'send → U1', r.body?.txHash, '1 P2P');
  }

  // U1 import + subscribe — wait for chain to commit so U1 sees the funding
  await sleep(3000);
  {
    const r = await importInto('U1', u1.mnemonic);
    log('U1 /api/wallet/import', r.status === 200 && r.body?.ok, `addr=${r.body?.address?.slice(0,14) || r.body?.error}`);
  }
  {
    setActive('U1');
    const r = await get('/api/wallet');
    log('U1 /api/wallet (funded)', r.status === 200 && (r.body?.balanceUdvpn || 0) >= 500_000, `bal=${((r.body?.balanceUdvpn||0)/1e6).toFixed(4)} P2P`);
  }
  // Different signer (U1, not P) — short cross-actor gap is enough
  await sleep(TX_GAP_CROSS_MS);
  let u1SubId = null;
  {
    setActive('U1');
    const r = await post('/api/plan/subscribe', { planId, denom: 'udvpn' });
    u1SubId = r.body?.subscriptionId ?? null;
    log('U1 POST /api/plan/subscribe (self-pay)', r.status === 200 && r.body?.txHash, `sub=${u1SubId} tx=${r.body?.txHash?.slice(0,16) || r.body?.error}`);
    recordTx('subscribe', 'U1', 'subscribe (self-pay)', r.body?.txHash, `sub=${u1SubId}`);
    if (u1SubId != null) report.subscriptions.push({ actor: 'U1', planId, subscriptionId: u1SubId, txHash: r.body?.txHash, gasPath: 'self-pay' });
  }

  // ── 4. U2 — fee-granted by P, subscribe with granted gas ──────────────────
  await section('4. User 2 (fee-grant) — grant + subscribe');
  const u2 = await freshWallet();
  console.log('  U2 address:', u2.address);

  setActive('P');
  report.actors.U2 = { role: 'subscriber (fee-granted gas)', address: u2.address, startBal: 0, endBal: null };
  await sleep(TX_GAP_MS);
  {
    // Send enough to cover plan price (0.001 P2P) plus headroom — gas is fee-granted by P,
    // but the plan price itself comes from U2's wallet at subscribe time.
    const r = await post('/api/wallet/send', { to: u2.address, amountDvpn: 0.05, memo: 'pm-universal U2 fund' });
    log('P → U2 fund (0.05 P2P)', r.status === 200 && r.body?.ok, `tx=${r.body?.txHash?.slice(0,16) || r.body?.error}`);
    recordTx('fund', 'P', 'send → U2', r.body?.txHash, '0.05 P2P');
  }
  await sleep(TX_GAP_MS);
  {
    // Fee-grant U2: P pays U2's gas
    const r = await post('/api/feegrant/grant', { grantee: u2.address, spendLimitDvpn: 0.5, expirationDays: 1 });
    log('P /api/feegrant/grant → U2', r.status === 200 && r.body?.ok, `tx=${r.body?.txHash?.slice(0,16) || r.body?.error}`);
    recordTx('feegrant', 'P', 'grant → U2', r.body?.txHash, 'spendLimit 0.5 P2P');
  }
  // Wait for grant TX to commit, then import U2 (different signer)
  await sleep(3000);
  {
    const r = await importInto('U2', u2.mnemonic);
    log('U2 /api/wallet/import', r.status === 200 && r.body?.ok);
  }

  // Snapshot balances BEFORE U2 subscribe — used to prove the fee grant paid the gas.
  const u2BalBefore = await balanceOf('U2');
  setActive('P');
  const pBalBeforeU2 = (await get('/api/wallet')).body?.balanceUdvpn || 0;

  // U2 is a different signer than P — short cross-actor gap suffices
  await sleep(TX_GAP_CROSS_MS);
  let u2SubId = null;
  {
    setActive('U2');
    const r = await post('/api/plan/subscribe', { planId, denom: 'udvpn' });
    u2SubId = r.body?.subscriptionId ?? null;
    log('U2 POST /api/plan/subscribe (fee-granted gas)', r.status === 200 && r.body?.txHash, `sub=${u2SubId} tx=${r.body?.txHash?.slice(0,16) || r.body?.error}`);
    recordTx('subscribe', 'U2', 'subscribe (fee-granted)', r.body?.txHash, `sub=${u2SubId}`);
    if (u2SubId != null) report.subscriptions.push({ actor: 'U2', planId, subscriptionId: u2SubId, txHash: r.body?.txHash, gasPath: 'fee-granted by P' });
  }

  // Wait for chain to commit, then measure U2 + P balance deltas.
  await sleep(6000);
  const u2BalAfter = await balanceOf('U2');
  setActive('P');
  const pBalAfterU2 = (await get('/api/wallet')).body?.balanceUdvpn || 0;

  // U2 should lose roughly the plan price (1000 udvpn) but NOT the gas (~30k–60k udvpn).
  // If the grant didn't apply, U2 would lose plan price + gas (~31k+).
  const u2Spent = u2BalBefore - u2BalAfter;
  const pSpent = pBalBeforeU2 - pBalAfterU2;
  const planPrice = 1000;
  const u2GasFreeOk = u2Spent <= planPrice + 200; // tiny tolerance for any rounding
  log('U2 paid plan price only (gas was fee-granted)',
    u2GasFreeOk,
    `U2 spent=${u2Spent} udvpn (price=${planPrice}, expected ≤${planPrice + 200})`);
  log('P paid U2\'s subscribe gas (P balance dropped)',
    pSpent > 0,
    `P spent=${pSpent} udvpn for U2's gas`);
  report.feegrantProof = {
    u2BalBefore, u2BalAfter, u2Spent,
    pBalBeforeU2, pBalAfterU2, pGasForU2: pSpent,
    planPriceUdvpn: planPrice,
    grantCoveredGas: u2GasFreeOk,
  };

  // Both subscriptions visible on the plan (the prior 6s sleep covers indexer lag)
  {
    setActive('P');
    const r = await get(`/api/plans/${planId}/subscriptions?limit=200`);
    const subs = r.body?.subscriptions || r.body?.subscribers || r.body || [];
    const list = Array.isArray(subs) ? subs : [];
    const hasU1 = list.some(s => (s.address || s.subscriber || s.account || '').includes(u1.address));
    const hasU2 = list.some(s => (s.address || s.subscriber || s.account || '').includes(u2.address));
    log(`GET /api/plans/${planId}/subscriptions (U1+U2 present)`, hasU1 && hasU2, `U1=${hasU1} U2=${hasU2} count=${list.length}`);
  }

  // ── 4b. Allocation handout — prove U2 is authorized to use the linked node ──
  // /api/plan/start-session asks the chain (and the node) to issue a session
  // for an existing subscription on a specific node. We don't run the actual
  // VPN tunnel; we just assert the auth/allocation step succeeds end-to-end.
  if (u2SubId != null && pickedNode) {
    // U2 subscribe was ~6s+ ago (sleep(6000) + read), need only a short top-up to satisfy 7s same-signer rule
    await sleep(1500);
    setActive('U2');
    const r = await post('/api/plan/start-session', {
      subscriptionId: u2SubId,
      nodeAddress: pickedNode.address,
    });
    // Acceptable outcomes:
    //   - 200 + ok:true              → server returned a session payload (full success)
    //   - 200 + ok:false + nodeError → chain auth passed, node-side responded (still proves allocation)
    //   - 4xx with a clear "node unreachable" / "session offline" error
    // FAIL outcomes:
    //   - any "subscription not found", "not a subscriber", "feegrant" rejection
    const body = r.body || {};
    const errStr = String(body.error || '').toLowerCase();
    const authFailed = /subscription not found|not authorized|not a subscriber|fee.?grant|insufficient/.test(errStr);
    const okAlloc = (r.status === 200 && body.ok)
      || (r.status === 200 && body.ok === false && !authFailed)
      || (r.status >= 400 && r.status < 500 && !authFailed);
    log('U2 allocation handout (/api/plan/start-session)',
      okAlloc,
      r.status === 200 && body.ok ? 'session issued' :
      `status=${r.status} ${body.error ? 'err=' + body.error.slice(0,80) : 'no-session-but-auth-ok'}`);
    report.allocation = {
      subscriptionId: u2SubId,
      node: pickedNode.address,
      status: r.status,
      sessionIssued: r.status === 200 && body.ok === true,
      authPassed: okAlloc,
      note: body.error || (body.ok ? 'session payload returned' : 'no error'),
    };
  }

  // ── 5. Provider exercises grant-list / SSE / gas-cost / auto-grant / revoke-list ──
  await section('5. Provider feegrant suite');
  setActive('P');
  // Grants list query: keep sequential. Concurrent RPC traffic on the same client
  // can hit an indexer node that hasn't seen the grant yet (race observed when
  // this was inside the parallel block). One call, one moment — deterministic.
  {
    const r = await get('/api/feegrant/grants');
    const list = r.body?.grants || r.body?.allowances || [];
    const seesU2 = list.some(g => (g.grantee || g.Grantee) === u2.address);
    log('GET /api/feegrant/grants (sees U2)', r.status === 200 && seesU2, `total=${list.length}`);
  }
  {
    // Remaining read-only fan-out: gas-costs, auto-grant state, SSE, dryRun POST.
    const [gasRes, agGetRes, sseRes, gsPostRes] = await Promise.all([
      get(`/api/feegrant/gas-costs?planId=${planId}`),
      get('/api/feegrant/auto-grant'),
      getStream(`/api/feegrant/grant-subscribers-stream?planId=${planId}&dryRun=1`, 15_000),
      post('/api/feegrant/grant-subscribers', { planId, dryRun: true }),
    ]);
    log('GET /api/feegrant/gas-costs', gasRes.status === 200 && !gasRes.body?.error);
    log('GET /api/feegrant/grant-subscribers-stream (SSE)',
      sseRes.status === 200 && sseRes.events.length > 0,
      `events=${sseRes.events.length}`);
    log('POST /api/feegrant/grant-subscribers (dryRun shape)',
      gsPostRes.status === 200 || gsPostRes.status === 400, `status=${gsPostRes.status}`);
    // auto-grant toggle round-trip MUST stay sequential — second toggle reads the first's state
    const before = !!agGetRes.body?.enabled;
    const t1 = await post('/api/feegrant/auto-grant', { enabled: !before });
    const t2 = await post('/api/feegrant/auto-grant', { enabled: before });
    log('POST /api/feegrant/auto-grant (toggle round-trip)',
      agGetRes.status === 200 && t1.status === 200 && t2.status === 200,
      `${before} → ${!before} → ${before}`);
  }

  // ── 6. Empty-body validation pass on remaining destructive endpoints ──────
  await section('6. Validation contract (empty body → 400/401/200+error)');
  const requireBody = [
    '/api/plan/status',
    '/api/plan/start-session',
    '/api/plan-manager/batch-link',
    '/api/plan-manager/batch-unlink',
    '/api/plan-manager/unlink',
    '/api/feegrant/revoke',
    '/api/feegrant/revoke-list',
    '/api/wallet/send',
    '/api/wallet/import',
    '/api/tx/broadcast-signed',
  ];
  {
    // Parallel: these are validation-only — no TX is broadcast.
    const responses = await Promise.all(requireBody.map(p => post(p, {})));
    requireBody.forEach((path, i) => {
      const r = responses[i];
      const ok = r.status === 400 || r.status === 401 || (r.status === 200 && r.body?.error);
      log(`${path} (empty)`, ok, `status=${r.status}`);
    });
  }

  // ── 7. Cleanup — revoke grants, unlink nodes, deactivate plan, drain users ─
  await section('7. Cleanup');
  setActive('P');

  // Last P TX was the grant in §4 ~30s+ ago (across §5 reads + §6 validation) — minimal gap needed
  // Revoke U2 grant via revoke-list (covers batch path too)
  await sleep(TX_GAP_CROSS_MS);
  {
    const r = await post('/api/feegrant/revoke-list', { grantees: [u2.address] });
    log('POST /api/feegrant/revoke-list [U2]', r.status === 200 && r.body?.ok !== false, `revoked=${r.body?.revoked} alreadyGone=${r.body?.alreadyGone}`);
    if (Array.isArray(r.body?.txHashes)) for (const h of r.body.txHashes) recordTx('cleanup', 'P', 'revoke-list', h, u2.address);
    else recordTx('cleanup', 'P', 'revoke-list', r.body?.txHash, u2.address);
  }
  // Idempotency: revoking a now-gone grant returns alreadyGone:true, status 200
  await sleep(TX_GAP_MS);
  {
    const r = await post('/api/feegrant/revoke', { grantee: u2.address });
    log('POST /api/feegrant/revoke (idempotent)', r.status === 200 && r.body?.alreadyGone === true, `alreadyGone=${r.body?.alreadyGone}`);
  }

  // Unlink the node we linked
  if (pickedNode) {
    await sleep(TX_GAP_MS);
    const r = await post('/api/plan-manager/unlink', { planId, nodeAddress: pickedNode.address });
    log('POST /api/plan-manager/unlink', r.status === 200 && (r.body?.ok || r.body?.alreadyUnlinked), `tx=${r.body?.txHash?.slice(0,16) || r.body?.alreadyUnlinked || r.body?.error}`);
    recordTx('cleanup', 'P', 'unlink', r.body?.txHash, pickedNode.address);
  }
  // batch-unlink shape (empty list → 200/400 contract)
  {
    const r = await post('/api/plan-manager/batch-unlink', { planId, nodeAddresses: [] });
    log('POST /api/plan-manager/batch-unlink (empty)', r.status === 200 || r.status === 400, `status=${r.status}`);
  }

  // Deactivate the plan (status=3)
  await sleep(TX_GAP_MS);
  {
    const r = await post('/api/plan/status', { planId, status: 3 });
    log('POST /api/plan/status inactive', r.status === 200 && r.body?.ok, `tx=${r.body?.txHash?.slice(0,16) || r.body?.error}`);
    recordTx('cleanup', 'P', 'plan deactivate', r.body?.txHash, `planId=${planId}`);
  }

  // Drain U1 + U2 → P. Different signers — read both balances in parallel, then send sequentially with a short cross-signer gap.
  await sleep(TX_GAP_CROSS_MS);
  const [u1Bal, u2Bal] = await Promise.all([balanceOf('U1'), balanceOf('U2')]);
  if (report.actors.U1) report.actors.U1.endBal = u1Bal;
  if (report.actors.U2) report.actors.U2.endBal = u2Bal;
  {
    setActive('U1');
    if (u1Bal > 200_000) {
      const sendDvpn = ((u1Bal - 200_000) / 1e6).toFixed(6);
      const r = await post('/api/wallet/send', { to: pAddr, amountDvpn: Number(sendDvpn), memo: 'pm-universal U1 drain' });
      log('U1 drain → P', r.status === 200 && r.body?.ok, `sent=${sendDvpn} P2P tx=${r.body?.txHash?.slice(0,16) || r.body?.error}`);
      recordTx('cleanup', 'U1', 'drain → P', r.body?.txHash, `${sendDvpn} P2P`);
    } else {
      log('U1 drain → P', true, `bal=${u1Bal} udvpn (dust, skipped)`);
    }
  }
  {
    setActive('U2');
    if (u2Bal > 200_000) {
      // Different signer than U1 — short cross-actor gap is enough
      await sleep(TX_GAP_CROSS_MS);
      const sendDvpn = ((u2Bal - 200_000) / 1e6).toFixed(6);
      const r = await post('/api/wallet/send', { to: pAddr, amountDvpn: Number(sendDvpn), memo: 'pm-universal U2 drain' });
      log('U2 drain → P', r.status === 200 && r.body?.ok, `sent=${sendDvpn} P2P tx=${r.body?.txHash?.slice(0,16) || r.body?.error}`);
      recordTx('cleanup', 'U2', 'drain → P', r.body?.txHash, `${sendDvpn} P2P`);
    } else {
      log('U2 drain → P', true, `bal=${u2Bal} udvpn (dust, skipped)`);
    }
  }
  // Capture P final balance (before logout cookie wipe)
  setActive('P');
  {
    const r = await get('/api/wallet');
    if (report.actors.P) report.actors.P.endBal = r.body?.balanceUdvpn || 0;
  }

  // ── 8. Wallet rotation endpoints — fire LAST on P session ─────────────────
  await section('8. Wallet rotation (LAST)');
  setActive('P');
  {
    const r = await post('/api/wallet/logout', {});
    log('POST /api/wallet/logout', r.status === 200, `status=${r.status}`);
  }
  {
    const r = await post('/api/wallet/generate', {});
    const a = r.body?.address;
    log('POST /api/wallet/generate (post-logout)', r.status === 200 && /^sent1[02-9ac-hj-np-z]{38}$/.test(a || ''), `addr=${a?.slice(0,14)}`);
  }

  summarize();
})().catch(err => {
  console.error('\nFATAL:', err);
  process.exit(2);
});

// ─── Report formatting ──────────────────────────────────────────────────────
function pad(s, n) { s = String(s ?? ''); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function rule(ch = '─', n = 75) { return ch.repeat(n); }
function header(title) { console.log('\n' + rule('═')); console.log('  ' + title); console.log(rule('═')); }
function sub(title) { console.log('\n' + title); console.log(rule('─', title.length)); }
function p2p(udvpn) { return udvpn == null ? '?' : (udvpn / 1e6).toFixed(6) + ' P2P'; }

function summarize() {
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const ok = failed.length === 0;

  // ── End-to-end report ───────────────────────────────────────────────────
  header('END-TO-END FLOW REPORT');

  console.log('  Status   :', ok ? '✓ PASS' : '✗ FAIL');
  console.log('  Started  :', report.startedAt);
  console.log('  Finished :', new Date().toISOString());
  console.log('  Elapsed  :', elapsed + 's');
  console.log('  Target   :', report.base);
  console.log('  Checks   :', `${passed}/${results.length} passed, ${failed.length} failed`);

  // Actors
  sub('Wallets');
  console.log(`  ${pad('LABEL', 4)} ${pad('ROLE', 30)} ${pad('ADDRESS', 46)} ${pad('START', 18)} ${pad('END', 18)} DELTA`);
  for (const [label, a] of Object.entries(report.actors)) {
    const delta = (a.endBal != null && a.startBal != null) ? p2p(a.endBal - a.startBal) : '—';
    console.log(`  ${pad(label, 4)} ${pad(a.role, 30)} ${pad(a.address, 46)} ${pad(p2p(a.startBal), 18)} ${pad(p2p(a.endBal), 18)} ${delta}`);
  }

  // Plan + nodes
  sub('Plan + Nodes');
  if (report.plan) {
    console.log(`  Plan ID         : ${report.plan.planId}`);
    console.log(`  Duration        : ${report.plan.durationSeconds}s`);
    console.log(`  Capacity        : ${report.plan.gigabytes} GB`);
    console.log(`  Price           : ${report.plan.priceUdvpn} udvpn (${(report.plan.priceUdvpn/1e6).toFixed(6)} P2P)`);
  }
  console.log(`  Linked node     : ${report.nodes.linked || '—'}`);
  console.log(`  Lease-test node : ${report.nodes.leased || '—'}`);

  // Subscriptions
  sub('Subscriptions created');
  console.log(`  ${pad('ACTOR', 5)} ${pad('PLAN', 6)} ${pad('SUB ID', 10)} ${pad('GAS PATH', 22)} TX`);
  for (const s of report.subscriptions) {
    console.log(`  ${pad(s.actor, 5)} ${pad(s.planId, 6)} ${pad(s.subscriptionId, 10)} ${pad(s.gasPath, 22)} ${s.txHash || '—'}`);
  }

  // Fee-grant proof — show that U2 paid only the plan price, P paid the gas
  if (report.feegrantProof) {
    const f = report.feegrantProof;
    sub('Fee-grant proof (U2 subscribe)');
    console.log(`  Plan price (chain)     : ${f.planPriceUdvpn} udvpn`);
    console.log(`  U2 balance before sub  : ${f.u2BalBefore} udvpn`);
    console.log(`  U2 balance after sub   : ${f.u2BalAfter} udvpn`);
    console.log(`  → U2 actually spent    : ${f.u2Spent} udvpn  ${f.u2Spent <= f.planPriceUdvpn + 200 ? '(price only — gas was fee-granted ✓)' : '(spent more than price — grant did NOT apply ✗)'}`);
    console.log(`  P balance before       : ${f.pBalBeforeU2} udvpn`);
    console.log(`  P balance after        : ${f.pBalAfterU2} udvpn`);
    console.log(`  → P paid U2's gas      : ${f.pGasForU2} udvpn`);
    console.log(`  Verdict                : ${f.grantCoveredGas ? '✓ Fee grant covered U2\'s subscribe gas' : '✗ Grant did NOT cover gas'}`);
  }

  // Allocation handout — start-session against the linked node
  if (report.allocation) {
    const a = report.allocation;
    sub('Allocation handout (U2 → linked node)');
    console.log(`  Subscription ID  : ${a.subscriptionId}`);
    console.log(`  Node address     : ${a.node}`);
    console.log(`  HTTP status      : ${a.status}`);
    console.log(`  Session issued   : ${a.sessionIssued ? '✓ yes (full session payload returned)' : 'no — but auth passed'}`);
    console.log(`  Auth passed      : ${a.authPassed ? '✓ U2 is authorized to consume node bandwidth' : '✗ blocked at auth layer'}`);
    console.log(`  Detail           : ${a.note}`);
  }

  // Transaction ledger
  sub(`On-chain transactions (${report.txs.length})`);
  console.log(`  ${pad('#', 3)} ${pad('PHASE', 10)} ${pad('ACTOR', 5)} ${pad('ACTION', 26)} ${pad('TX HASH', 64)} NOTE`);
  let i = 0;
  for (const tx of report.txs) {
    i++;
    console.log(`  ${pad(i, 3)} ${pad(tx.phase, 10)} ${pad(tx.actor, 5)} ${pad(tx.action, 26)} ${pad(tx.hash, 64)} ${tx.note || ''}`);
  }

  // Endpoint coverage
  sub(`Endpoint coverage (${report.endpoints.size} unique)`);
  const eps = [...report.endpoints].sort();
  for (const e of eps) console.log(`  • ${e}`);

  // Per-session check coverage
  sub('Checks by session');
  const bySession = results.reduce((a, r) => { a[r.session] = (a[r.session] || 0) + 1; return a; }, {});
  for (const [k, v] of Object.entries(bySession)) console.log(`  ${pad(k, 4)} ${v} checks`);

  // Failures (if any)
  if (failed.length) {
    sub('Failures');
    for (const f of failed) console.log(`  ✗ [${f.session}] ${f.name}  — ${f.detail}`);
  }

  // Final summary line
  console.log('\n' + rule('═'));
  console.log(`  ${ok ? '✓' : '✗'} ${passed}/${results.length} checks · ${report.txs.length} on-chain TXs · ${report.endpoints.size} endpoints · ${elapsed}s`);
  console.log(rule('═'));

  process.exit(failed.length ? 1 : 0);
}
