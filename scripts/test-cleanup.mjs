#!/usr/bin/env node
// Live test: grant 2 throwaway grantees, then call revoke-list to clean them
// all up in one shot. Verifies the "Clean up" button path actually revokes.
//
// Run:  node scripts/test-cleanup.mjs

import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';

const BASE = 'http://localhost:3003';

async function gen() {
  const w = await DirectSecp256k1HdWallet.generate(24, { prefix: 'sent' });
  const [a] = await w.getAccounts();
  return a.address;
}

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}
async function get(path) {
  const r = await fetch(BASE + path);
  return { status: r.status, body: await r.json() };
}

(async () => {
  console.log('─── revoke-list E2E against live chain ───\n');

  const w = await get('/api/wallet');
  console.log('wallet:', w.body.address, '· bal:', (w.body.balanceUdvpn / 1e6).toFixed(4), 'P2P');

  const g1 = await gen();
  const g2 = await gen();
  console.log('grantee 1:', g1);
  console.log('grantee 2:', g2);

  console.log('\nStep 1: grant both');
  for (const g of [g1, g2]) {
    const { status, body } = await post('/api/feegrant/grant', {
      grantee: g, spendLimitDvpn: 0.001, expirationDays: 1,
    });
    console.log(`  grant ${g.slice(0, 14)}…: status=${status} ${body.ok ? 'hash=' + body.txHash.slice(0, 16) : 'ERR=' + body.error}`);
    if (!body.ok) process.exit(1);
  }

  console.log('\nStep 2: wait 8s for chain indexing');
  await new Promise(r => setTimeout(r, 8000));

  console.log('\nStep 3: verify both visible');
  {
    const { body } = await get('/api/feegrant/grants');
    const list = body.grants || body.allowances || [];
    const found1 = list.some(x => (x.grantee || x.Grantee) === g1);
    const found2 = list.some(x => (x.grantee || x.Grantee) === g2);
    console.log(`  grantee 1 present: ${found1}`);
    console.log(`  grantee 2 present: ${found2}`);
    if (!found1 || !found2) {
      console.log('  ⚠  one or both missing; proceeding anyway to test already-gone tolerance');
    }
  }

  console.log('\nStep 4: call revoke-list with both grantees');
  const { status, body } = await post('/api/feegrant/revoke-list', {
    grantees: [g1, g2],
  });
  console.log(`  status=${status}`);
  console.log(`  response:`, JSON.stringify(body, null, 2));
  if (!body.ok) { console.log('FAIL: revoke-list did not return ok'); process.exit(1); }

  console.log('\nStep 5: wait 8s for chain indexing');
  await new Promise(r => setTimeout(r, 8000));

  console.log('\nStep 6: verify both gone');
  {
    const { body } = await get('/api/feegrant/grants');
    const list = body.grants || body.allowances || [];
    const found1 = list.some(x => (x.grantee || x.Grantee) === g1);
    const found2 = list.some(x => (x.grantee || x.Grantee) === g2);
    console.log(`  grantee 1 still present: ${found1}`);
    console.log(`  grantee 2 still present: ${found2}`);
    if (found1 || found2) {
      console.log('\n✗ FAIL: cleanup did NOT remove grants from chain');
      process.exit(1);
    }
  }

  console.log('\n✓ PASS: revoke-list removed both grants from chain');
  process.exit(0);
})().catch(e => { console.error('FATAL:', e); process.exit(2); });
