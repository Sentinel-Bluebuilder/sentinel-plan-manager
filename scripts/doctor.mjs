// Diagnostic that runs the same checks the server runs at boot, so contributors
// know whether their setup is broken BEFORE `npm start` and a request stack
// trace. Prints PASS/FAIL with the fix command for each failure.
//
// Exits 0 on all-green, 1 if any check failed. Designed to be safe to run
// against an already-running server (the port check just notes "in use" — it
// doesn't try to bind).

import 'dotenv/config';
import net from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const checks = [];
const ok = (name, detail = '') => checks.push({ name, status: 'PASS', detail });
const fail = (name, detail, fix) => checks.push({ name, status: 'FAIL', detail, fix });
const warn = (name, detail, fix = '') => checks.push({ name, status: 'WARN', detail, fix });

// ─── 1. Node version ──────────────────────────────────────────────────────────
{
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 20) ok('Node version', `v${process.versions.node}`);
  else fail('Node version', `v${process.versions.node} — requires v20+`, 'Install Node 20+ from https://nodejs.org');
}

// ─── 2. node_modules present ─────────────────────────────────────────────────
{
  if (existsSync(join(ROOT, 'node_modules'))) ok('Dependencies installed');
  else fail('Dependencies installed', 'node_modules/ missing', 'Run: npm install');
}

// ─── 3. .env present (warn only — demo mode works without it) ────────────────
{
  if (existsSync(join(ROOT, '.env'))) ok('.env file present');
  else warn('.env file', 'not found — server will only run in DEMO mode', 'cp .env.example .env  &&  edit MNEMONIC');
}

// ─── 4. MNEMONIC validity (only if set) ──────────────────────────────────────
{
  const m = (process.env.MNEMONIC || '').trim();
  if (!m) {
    warn('MNEMONIC', 'not set — only DEMO mode will work', 'Add MNEMONIC=... to .env (12 or 24 words)');
  } else {
    const words = m.split(/\s+/).filter(Boolean);
    if (words.length !== 12 && words.length !== 24) {
      fail('MNEMONIC', `${words.length} words — must be 12 or 24`, 'Fix MNEMONIC in .env');
    } else {
      try {
        const { DirectSecp256k1HdWallet } = await import('@cosmjs/proto-signing');
        const wallet = await DirectSecp256k1HdWallet.fromMnemonic(m, { prefix: 'sent' });
        const [acc] = await wallet.getAccounts();
        ok('MNEMONIC', `derives ${acc.address}`);
      } catch (err) {
        fail('MNEMONIC', `failed to derive: ${err.message}`, 'Verify MNEMONIC is a valid bech32 cosmos mnemonic');
      }
    }
  }
}

// ─── 5. DEMO_ADDR validity (only if set) ─────────────────────────────────────
{
  const d = (process.env.DEMO_ADDR || '').trim();
  if (d) {
    try {
      const { fromBech32 } = await import('@cosmjs/encoding');
      const { prefix } = fromBech32(d);
      if (prefix !== 'sent') fail('DEMO_ADDR', `prefix ${prefix} — must be sent`, 'Use a sent1... address');
      else ok('DEMO_ADDR', d);
    } catch (err) {
      fail('DEMO_ADDR', `invalid bech32: ${err.message}`, 'Check DEMO_ADDR for typos');
    }
  }
}

// ─── 6. Port availability ────────────────────────────────────────────────────
{
  const port = Number(process.env.PORT) || 3003;
  const inUse = await new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', (err) => resolve(err.code === 'EADDRINUSE'));
    s.once('listening', () => s.close(() => resolve(false)));
    s.listen(port, '127.0.0.1');
  });
  if (inUse) warn(`Port ${port}`, 'in use — another process is bound (might be your own server)', `Stop the other process or set PORT in .env`);
  else ok(`Port ${port}`, 'free');
}

// ─── 7. RPC reachability (probe 3 endpoints) ─────────────────────────────────
{
  const endpoints = [
    'https://rpc.sentinel.co',
    'https://sentinel-rpc.publicnode.com',
    'https://sentinel-rpc.polkachu.com',
  ];
  const results = await Promise.all(endpoints.map(async (url) => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      const r = await fetch(`${url}/status`, { signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) return { url, ok: false, detail: `HTTP ${r.status}` };
      const j = await r.json();
      const h = j?.result?.sync_info?.latest_block_height;
      return { url, ok: !!h, detail: h ? `height ${h}` : 'no height' };
    } catch (err) {
      return { url, ok: false, detail: err.message };
    }
  }));
  const reachable = results.filter(r => r.ok).length;
  if (reachable >= 2) ok('Sentinel RPC', `${reachable}/${endpoints.length} reachable`);
  else if (reachable === 1) warn('Sentinel RPC', `only ${reachable}/${endpoints.length} reachable — failover thin`);
  else fail('Sentinel RPC', `0/${endpoints.length} reachable — chain queries will fail`, 'Check internet connection / firewall');
}

// ─── 8. Privy config (only if any var is set — warn on partial) ──────────────
{
  const id = process.env.PRIVY_APP_ID;
  const secret = process.env.PRIVY_APP_SECRET;
  const client = process.env.PRIVY_CLIENT_ID;
  const set = [id, secret, client].filter(Boolean).length;
  if (set === 0) ok('Privy', 'disabled (optional)');
  else if (set === 3) ok('Privy', 'all three vars set');
  else warn('Privy', `${set}/3 vars set — login card will fail to send codes`, 'Set PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_CLIENT_ID together (or unset all)');
}

// ─── Print report ────────────────────────────────────────────────────────────
const symbol = { PASS: '✓', WARN: '!', FAIL: '✗' };
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - s.length));

console.log('\nPlan Manager doctor\n');
let failed = 0;
for (const c of checks) {
  console.log(`  ${symbol[c.status]}  ${pad(c.name, 22)} ${c.detail}`);
  if (c.fix) console.log(`     fix: ${c.fix}`);
  if (c.status === 'FAIL') failed++;
}
console.log();
if (failed === 0) {
  console.log('All checks passed.');
  process.exit(0);
} else {
  console.log(`${failed} check(s) failed.`);
  process.exit(1);
}
