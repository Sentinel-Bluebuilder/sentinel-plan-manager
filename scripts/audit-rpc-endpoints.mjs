// ─── Audit Sentinel RPC endpoints ────────────────────────────────────────────
// Probes every candidate RPC for: connect health, sync status (catching_up=false),
// and correctness (returns expected balance for a known funded address).
// Output is consumed when proposing the blue-js-sdk RPC_ENDPOINTS list.
//
// usage: node scripts/audit-rpc-endpoints.mjs [funded-address] [expected-udvpn]

import { Tendermint37Client } from '@cosmjs/tendermint-rpc';
import { QueryClient, setupBankExtension } from '@cosmjs/stargate';

const FUNDED_ADDR = process.argv[2] || 'sent1uav3z70yynp4jnt39c6pg3d6ujw78m52v2h7gs';
const EXPECTED_UDVPN = process.argv[3] || '10000000000';

const CANDIDATES = [
  ['https://rpc.sentinel.co:443', 'Sentinel Official'],
  ['https://sentinel-rpc.polkachu.com', 'Polkachu'],
  ['https://rpc.mathnodes.com', 'MathNodes'],
  ['https://sentinel-rpc.publicnode.com', 'PublicNode (Allnodes)'],
  ['https://rpc.sentinel.quokkastake.io', 'QuokkaStake'],
  ['https://rpc-sentinel.busurnode.com', 'Busurnode'],
  ['https://rpc-sentinel-ia.cosmosia.notional.ventures', 'Notional'],
  ['https://rpc.sentinel.chaintools.tech', 'ChainTools'],
  ['https://rpc.dvpn.roomit.xyz', 'Roomit'],
  ['https://sentinel-rpc.badgerbite.io', 'BadgerBite'],
  ['https://sentinel-rpc.validatornode.com', 'ValidatorNode'],
  ['https://rpc.trinitystake.io', 'Trinity Stake'],
  ['https://rpc.sentineldao.com', 'Sentinel Growth DAO'],
  ['https://public.stakewolle.com/cosmos/sentinel/rpc', 'Stakewolle'],
  ['https://sentinel.declab.pro:26628', 'Decloud Nodes Lab'],
  ['https://rpc.dvpn.me:443', 'MathNodes China'],
  ['https://rpc.ro.mathnodes.com:443', 'MathNodes Romania'],
  ['https://rpc.noncompliant.network:443', 'Noncompliant'],
  ['https://rpc-sentinel.chainvibes.com:443', 'ChainVibes'],
  ['https://sentinel.rpc.quasarstaking.ai:443', 'Quasar'],
  ['https://rpc.sentinel.validatus.com', 'Validatus'],
  ['https://rpc.sentinel.suchnode.net', 'SuchNode'],
];

async function audit(url, name) {
  const t0 = Date.now();
  let tm = null;
  try {
    tm = await Promise.race([
      Tendermint37Client.connect(url),
      new Promise((_, rej) => setTimeout(() => rej(new Error('connect timeout 8s')), 8000)),
    ]);
    const status = await Promise.race([
      tm.status(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('status timeout 8s')), 8000)),
    ]);
    const height = Number(status.syncInfo.latestBlockHeight);
    const catchingUp = !!status.syncInfo.catchingUp;
    const q = QueryClient.withExtensions(tm, setupBankExtension);
    const bal = await Promise.race([
      q.bank.balance(FUNDED_ADDR, 'udvpn'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('balance timeout 10s')), 10000)),
    ]);
    const ms = Date.now() - t0;
    const balanceOk = bal.amount === EXPECTED_UDVPN;
    return { url, name, ok: !catchingUp && balanceOk, height, catchingUp, balance: bal.amount, balanceOk, ms };
  } catch (e) {
    const ms = Date.now() - t0;
    return { url, name, ok: false, error: e.message, ms };
  } finally {
    // Disconnect best-effort: a probe that already failed shouldn't crash the
    // audit on a teardown error, but we log it rather than swallow silently.
    try { tm && tm.disconnect(); } catch (e) { console.warn(`[audit] disconnect ${url} failed: ${e.message}`); }
  }
}

const results = [];
for (const [url, name] of CANDIDATES) {
  process.stdout.write(`testing ${name.padEnd(24)} ${url.padEnd(55)} ... `);
  const r = await audit(url, name);
  results.push(r);
  if (r.ok) console.log(`OK   h=${r.height} bal=${r.balance} ${r.ms}ms`);
  else if (r.error) console.log(`FAIL ${r.error} (${r.ms}ms)`);
  else console.log(`STALE catching=${r.catchingUp} balOk=${r.balanceOk} h=${r.height} bal=${r.balance}`);
}

console.log('\n=== TIER 1 (sync + correct balance, sorted by latency) ===');
const tier1 = results.filter(r => r.ok).sort((a, b) => a.ms - b.ms);
for (const r of tier1) console.log(`  ${String(r.ms).padStart(5)}ms  ${r.url.padEnd(55)} ${r.name}`);

console.log('\n=== TIER 2 (failed/stale/wrong) ===');
for (const r of results.filter(r => !r.ok)) {
  const reason = r.error || (r.catchingUp ? 'catching_up=true' : !r.balanceOk ? `wrong balance ${r.balance}` : 'unknown');
  console.log(`  ${r.url.padEnd(55)} ${reason}`);
}

console.log(`\n${tier1.length}/${results.length} healthy`);
process.exit(0);
