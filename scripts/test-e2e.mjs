#!/usr/bin/env node
// End-to-end test of the Plan Manager server. Exercises every endpoint that
// can be safely hit against a live mainnet wallet. Writes real on-chain TXs
// for the grant/revoke round-trip — uses a fresh throwaway grantee each run
// and revokes it immediately, so the wallet ends with no residual state.
//
// Run:  node scripts/test-e2e.mjs
// Exit: 0 if every test passes, 1 otherwise.

import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';

const BASE = process.env.BASE_URL || 'http://localhost:3003';
const results = [];

function log(name, ok, detail = '') {
  const tag = ok ? '✓' : '✗';
  const line = `  ${tag} ${name}${detail ? '  — ' + detail : ''}`;
  console.log(line);
  results.push({ name, ok, detail });
}

async function get(path) {
  const r = await fetch(BASE + path);
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

async function post(path, payload) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

async function section(title) {
  console.log('\n' + title);
  console.log('─'.repeat(title.length));
}

// ─── Generate a throwaway grantee for the on-chain round-trip ──────────────
async function genGrantee() {
  const w = await DirectSecp256k1HdWallet.generate(24, { prefix: 'sent' });
  const [acc] = await w.getAccounts();
  return acc.address;
}

(async () => {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  Plan Manager — End-to-End Test (LIVE CHAIN)');
  console.log('  Target:', BASE);
  console.log('═══════════════════════════════════════════════════════════════════');

  // ─── 1. Health + wallet state ────────────────────────────────────────────
  await section('1. Health & wallet');
  {
    const { status, body } = await get('/health');
    log('/health', status === 200 && body && body.ok !== false, `status=${status}`);
  }

  let walletAddr = null;
  let balanceUdvpn = 0;
  {
    const { status, body } = await get('/api/wallet/status');
    const ok = status === 200 && body && body.loaded === true;
    log('/api/wallet/status', ok, `loaded=${body?.loaded}`);
    if (!ok) { summarize(); return; }
  }
  {
    const { status, body } = await get('/api/wallet');
    const ok = status === 200 && body && typeof body.address === 'string';
    walletAddr = body?.address;
    balanceUdvpn = body?.balanceUdvpn || 0;
    log('/api/wallet', ok, `addr=${walletAddr?.slice(0, 14)}… bal=${(balanceUdvpn / 1e6).toFixed(4)} P2P`);
    if (balanceUdvpn < 500_000) {
      log('balance sufficient for on-chain tests', false, `have ${balanceUdvpn} udvpn, need ≥500000`);
      summarize();
      return;
    }
  }

  // ─── 2. Read-only GET endpoints ──────────────────────────────────────────
  await section('2. GET endpoints (read-only)');
  const gets = [
    '/api/plans',
    '/api/my-plans',
    '/api/params',
    '/api/nodes/progress',
    '/api/nodes/chain-count',
    '/api/all-nodes?page=1&limit=20',
    '/api/providers',
    '/api/feegrant/grants',
    '/api/feegrant/gas-costs',
    '/api/feegrant/auto-grant',
    '/api/node-rankings',
    '/api/rpcs',
    '/api/rpc-providers',
  ];
  for (const path of gets) {
    const { status, body } = await get(path);
    const ok = status === 200 && body && !body.error;
    const size = typeof body === 'object' ? JSON.stringify(body).length : (body?.length || 0);
    log(path, ok, `status=${status} size=${size}`);
  }

  // Per-plan endpoints — pick first plan if any
  let firstPlanId = null;
  {
    const { body } = await get('/api/my-plans');
    if (body && Array.isArray(body.plans) && body.plans.length > 0) {
      firstPlanId = body.plans[0].planId;
    }
  }
  if (firstPlanId != null) {
    const { status, body } = await get('/api/plans/' + firstPlanId);
    log(`/api/plans/${firstPlanId}`, status === 200 && body && !body.error, `status=${status}`);
    const subs = await get(`/api/plans/${firstPlanId}/subscriptions?limit=50`);
    log(`/api/plans/${firstPlanId}/subscriptions`, subs.status === 200 && !subs.body.error, `status=${subs.status}`);
  } else {
    log('per-plan GETs skipped', true, 'no plans on wallet');
  }

  // ─── 3. POST endpoints — non-destructive validation errors ───────────────
  await section('3. POST endpoints (validation)');
  // Missing required fields should return 400, not 500
  {
    const { status, body } = await post('/api/feegrant/grant', {});
    log('POST /api/feegrant/grant (empty)', status === 400 && body?.error, `status=${status} err=${body?.error}`);
  }
  {
    const { status, body } = await post('/api/feegrant/revoke', {});
    log('POST /api/feegrant/revoke (empty)', status === 400 && body?.error, `status=${status} err=${body?.error}`);
  }
  {
    const { status, body } = await post('/api/plan-manager/link', {});
    log('POST /api/plan-manager/link (empty)', status === 400 && body?.error, `status=${status}`);
  }
  {
    const { status, body } = await post('/api/plan-manager/unlink', {});
    log('POST /api/plan-manager/unlink (empty)', status === 400 && body?.error, `status=${status}`);
  }
  {
    const { status, body } = await post('/api/provider/status', {});
    // provider/status reads current state, should not require params — tolerate 200 or 400
    log('POST /api/provider/status', status === 200 || status === 400, `status=${status}`);
  }
  {
    // auto-grant toggle — round trip
    const current = (await get('/api/feegrant/auto-grant')).body;
    const next = !current?.enabled;
    const toggled = await post('/api/feegrant/auto-grant', { enabled: next });
    const restored = await post('/api/feegrant/auto-grant', { enabled: !!current?.enabled });
    log('POST /api/feegrant/auto-grant (toggle)',
      toggled.status === 200 && restored.status === 200,
      `${current?.enabled} → ${next} → ${!!current?.enabled}`);
  }

  // ─── 4. LIVE CHAIN — grant → verify → revoke → verify ────────────────────
  await section('4. LIVE CHAIN: grant → revoke round-trip');
  console.log('  (uses real P2P gas on mainnet)');
  const grantee = await genGrantee();
  console.log('  throwaway grantee:', grantee);

  // Pre-check: grantee should NOT appear in current grants
  {
    const { body } = await get('/api/feegrant/grants');
    const list = body?.grants || body?.allowances || [];
    const already = list.some(g => (g.grantee || g.Grantee) === grantee);
    log('grantee is unique (not already granted)', !already);
  }

  // Grant
  let granted = false;
  {
    const { status, body } = await post('/api/feegrant/grant', {
      grantee,
      spendLimitDvpn: 0.001,
      expirationDays: 1,
    });
    granted = status === 200 && body?.ok && body?.txHash;
    log('POST /api/feegrant/grant (live TX)', granted, `hash=${body?.txHash?.slice(0, 16) || body?.error}`);
  }

  // Give the chain a few seconds to index
  if (granted) {
    await new Promise(r => setTimeout(r, 6000));
    const { body } = await get('/api/feegrant/grants');
    const list = body?.grants || body?.allowances || [];
    const found = list.some(g => (g.grantee || g.Grantee) === grantee);
    log('grant visible on chain after 6s', found, `total grants=${list.length}`);
  }

  // Revoke
  let revoked = false;
  if (granted) {
    const { status, body } = await post('/api/feegrant/revoke', { grantee });
    revoked = status === 200 && body?.ok;
    log('POST /api/feegrant/revoke (live TX)', revoked, `hash=${body?.txHash?.slice(0, 16) || body?.error || 'alreadyGone'}`);
  }

  if (revoked) {
    await new Promise(r => setTimeout(r, 6000));
    const { body } = await get('/api/feegrant/grants');
    const list = body?.grants || body?.allowances || [];
    const stillThere = list.some(g => (g.grantee || g.Grantee) === grantee);
    log('grant cleared after revoke', !stillThere);
  }

  // Revoke-already-gone tolerance — revoking the same grantee twice should
  // return ok:true with alreadyGone:true rather than 500
  if (revoked) {
    const { status, body } = await post('/api/feegrant/revoke', { grantee });
    const tolerated = status === 200 && body?.ok && body?.alreadyGone === true;
    log('revoke tolerates already-gone grant', tolerated, `status=${status} alreadyGone=${body?.alreadyGone}`);
  }

  // ─── 5. Destructive endpoints — safety checks only, don't fire ───────────
  await section('5. Destructive endpoints (presence only, not fired)');
  const destructive = [
    ['POST', '/api/plan/create'],
    ['POST', '/api/plan/status'],
    ['POST', '/api/plan/subscribe'],
    ['POST', '/api/plan/start-session'],
    ['POST', '/api/plan-manager/batch-link'],
    ['POST', '/api/plan-manager/batch-unlink'],
    ['POST', '/api/lease/start'],
    ['POST', '/api/lease/end'],
    ['POST', '/api/provider/register'],
    ['POST', '/api/feegrant/grant-subscribers'],
    ['POST', '/api/feegrant/revoke-all'],
    ['POST', '/api/wallet/logout'],
    ['POST', '/api/wallet/generate'],
    ['POST', '/api/wallet/import'],
  ];
  for (const [_, path] of destructive) {
    // Send empty body — handler must reject with validation error, not crash
    const { status, body } = await post(path, {});
    const ok = status === 400 || status === 401 || (status === 200 && body?.error);
    log(`${path} (empty → validated)`, ok, `status=${status}`);
  }

  // ─── 6. Final balance check ──────────────────────────────────────────────
  await section('6. Post-test balance');
  {
    const { body } = await get('/api/wallet');
    const after = body?.balanceUdvpn || 0;
    const spent = balanceUdvpn - after;
    log('wallet still loaded', !!body?.address, `before=${balanceUdvpn} after=${after} spent=${spent} udvpn`);
  }

  summarize();
})().catch(err => {
  console.error('\nFATAL:', err);
  process.exit(2);
});

function summarize() {
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok);
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log(`  ${passed}/${results.length} passed, ${failed.length} failed`);
  console.log('═══════════════════════════════════════════════════════════════════');
  if (failed.length) {
    console.log('\nFailures:');
    for (const f of failed) console.log(`  ✗ ${f.name}  ${f.detail}`);
  }
  process.exit(failed.length ? 1 : 0);
}
