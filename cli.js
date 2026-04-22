#!/usr/bin/env node
// ─── Plan Manager CLI ─────────────────────────────────────────────────────────
// Thin HTTP client for the Plan Manager server (port 3003).
// Maps every server.js endpoint to a CLI subcommand.
// Uses only Node built-ins (fetch, process). No external deps.
//
// Usage:  plans <group> <cmd> [args] [flags]
// Flags:  --json         emit raw JSON (AI-agent mode)
//         --base-url X   override base URL
//         -h / --help    show help

// ─── Arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const flags = {};
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') {
      flags.json = true;
    } else if (a === '--base-url') {
      flags.baseUrl = argv[++i];
    } else if (a === '-h' || a === '--help') {
      flags.help = true;
    } else if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

const { flags, positional } = parseArgs(process.argv.slice(2));
const BASE_URL = (flags.baseUrl || process.env.BASE_URL || `http://localhost:${process.env.PORT || 3003}`).replace(/\/$/, '');
const JSON_MODE = !!flags.json;

// ─── Output helpers ───────────────────────────────────────────────────────────

function out(str) { process.stdout.write(str + '\n'); }
function err(str) { process.stderr.write(str + '\n'); }
function scanning(msg) { process.stderr.write(msg + '\n'); }

function printJson(data) { out(JSON.stringify(data, null, 2)); }

function printKv(obj, indent = '') {
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) {
      out(`${indent}${k}: --`);
    } else if (typeof v === 'object' && !Array.isArray(v)) {
      out(`${indent}${k}:`);
      printKv(v, indent + '  ');
    } else if (Array.isArray(v)) {
      out(`${indent}${k}: [${v.length} items]`);
    } else {
      out(`${indent}${k}: ${v}`);
    }
  }
}

function txLine(resp) {
  if (resp.ok) {
    out(`OK  tx: ${resp.txHash || resp.transactionHash}  height: ${resp.height || '--'}  gas: ${resp.gasUsed || '--'}/${resp.gasWanted || '--'}`);
  } else {
    out(`FAIL  code: ${resp.code}  ${resp.error || resp.rawLog || ''}`);
  }
}

function fmtP2P(udvpn) {
  if (udvpn === null || udvpn === undefined) return '--';
  return (parseInt(udvpn) / 1e6).toFixed(2) + ' P2P';
}

function fmtUdvpn(udvpn) {
  if (udvpn === null || udvpn === undefined) return '--';
  return parseInt(udvpn).toLocaleString() + ' udvpn';
}

// ─── Table printer ────────────────────────────────────────────────────────────

function table(rows, cols) {
  // cols: [{key, label, width?, fmt?}]
  const widths = cols.map(c => {
    const maxData = rows.reduce((m, r) => {
      const v = c.fmt ? c.fmt(r[c.key], r) : String(r[c.key] ?? '--');
      return Math.max(m, v.length);
    }, 0);
    return Math.max(c.label.length, maxData, c.width || 0);
  });

  const header = cols.map((c, i) => c.label.padEnd(widths[i])).join('  ');
  const sep = widths.map(w => '-'.repeat(w)).join('  ');
  out(header);
  out(sep);

  for (const row of rows) {
    const line = cols.map((c, i) => {
      const v = c.fmt ? c.fmt(row[c.key], row) : String(row[c.key] ?? '--');
      return v.padEnd(widths[i]);
    }).join('  ');
    out(line);
  }
}

// ─── HTTP client ──────────────────────────────────────────────────────────────

async function request(method, path, body) {
  const url = BASE_URL + path;
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);

  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    err(`ERROR: Plan Manager server not running at ${BASE_URL}. Start it with: npm start`);
    err(`  (${e.message})`);
    process.exit(3);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    data = { error: `Non-JSON response (HTTP ${res.status})` };
  }

  if (!res.ok) {
    if (JSON_MODE) {
      process.stderr.write(JSON.stringify({ httpStatus: res.status, ...data }) + '\n');
    } else {
      err(`FAIL  HTTP ${res.status}: ${data.error || JSON.stringify(data)}`);
    }
    process.exit(res.status >= 500 ? 2 : 1);
  }

  return data;
}

async function GET(path) { return request('GET', path); }
async function POST(path, body) { return request('POST', path, body); }

// ─── Help text ────────────────────────────────────────────────────────────────

const HELP_ROOT = `
Sentinel Plan Manager CLI
  Thin HTTP client for the Plan Manager server (default: ${BASE_URL})

Usage:
  plans <group> <command> [args] [flags]

Global flags:
  --json            Emit raw JSON (for AI agents). Errors go to stderr.
  --base-url <url>  Override server URL (default: http://localhost:3003)
  -h, --help        Show help for any command group

Command groups:
  health            Server health check
  status            Node scan progress + wallet loaded state
  wallet            Wallet management (import, info, status, logout)
  plan              Plan CRUD, status, subscribe, start-session
  node              Node list, progress, sessions, rankings
  link              Link / batch-link a node to a plan
  unlink            Unlink / batch-unlink nodes from a plan
  batch-link        Link multiple nodes to a plan in one TX
  batch-unlink      Unlink multiple nodes from a plan in one TX
  lease             Start and end node leases
  provider          List and register providers
  params            Query chain params
  feegrant          Fee grant management
  rpc-health        39-endpoint LCD/RPC health check
  rpc-providers     RPC provider status

Examples:
  plans health
  plans wallet info
  plans plan list
  plans plan create --gb 10 --days 30 --price-udvpn 500000
  plans feegrant grant-subscribers 42

Run 'plans <group> --help' for per-group details.
`;

const HELP = {
  wallet: `
plans wallet status           GET /api/wallet/status — is a wallet loaded?
plans wallet info             GET /api/wallet      — address, balance, provider
plans wallet import <mnemo>   POST /api/wallet/import
plans wallet test-import      POST /api/wallet/test-import — load wallet from .env
plans wallet logout           POST /api/wallet/logout
`,
  plan: `
plans plan list               GET /api/plans
plans plan get <id>           GET /api/plans/:id
plans plan subscribers <id>   GET /api/plans/:id/subscriptions
plans plan mine               GET /api/my-plans
plans plan create             POST /api/plan/create
  --gb N           Data cap in gigabytes (required)
  --days N         Duration in days (required)
  --price-udvpn N  Price per GB in udvpn (required)
  --private        Mark plan as private
plans plan status <id> <n>   POST /api/plan/status (1=active, 2=inactive_pending, 3=inactive)
plans plan subscribe <id>    POST /api/plan/subscribe
  [--denom udvpn]
plans plan start-session <subId> <nodeAddr>  POST /api/plan/start-session
`,
  node: `
plans node list               GET /api/all-nodes
  [--limit N]       Results per page (default 50, max 100)
  [--page N]        Page number
  [--country XX]    Filter by country code
  [--protocol wireguard|v2ray]
plans node progress           GET /api/nodes/progress
plans node sessions <addr>    GET /api/nodes/:addr/sessions
plans node rankings           GET /api/node-rankings
`,
  link: `
plans link <planId> <nodeAddr>           POST /api/plan-manager/link
  [--lease-hours N]   Lease hours if auto-lease needed (default 24)
`,
  'batch-link': `
plans batch-link <planId> <n1,n2,...>    POST /api/plan-manager/batch-link
  [--lease-hours N]
`,
  unlink: `
plans unlink <planId> <nodeAddr>         POST /api/plan-manager/unlink
`,
  'batch-unlink': `
plans batch-unlink <planId> <n1,n2,...>  POST /api/plan-manager/batch-unlink
`,
  lease: `
plans lease start <nodeAddr>   POST /api/lease/start
  [--hours N]              Lease duration (default 720)
  [--max-price-udvpn N]    Max quote_value (default 40152030)
plans lease end <leaseId>      POST /api/lease/end
`,
  provider: `
plans provider list            GET /api/providers
plans provider register        POST /api/provider/register
  --name X          Provider name (required)
  [--identity X]
  [--website X]
  [--description X]
plans provider status <n>      POST /api/provider/status (1=active, 2=inactive_pending, 3=inactive)
`,
  params: `
plans params                   GET /api/params — subscription, node, session params
`,
  feegrant: `
plans feegrant list                       GET /api/feegrant/grants
plans feegrant gas-costs <planId>         GET /api/feegrant/gas-costs?planId=X
plans feegrant grant <grantee>            POST /api/feegrant/grant
  [--spend-limit-dvpn N]
  [--expiration-days N]
plans feegrant grant-subscribers <planId> POST /api/feegrant/grant-subscribers
  [--spend-limit-dvpn N]
  [--expiration-days N]
plans feegrant revoke <grantee>           POST /api/feegrant/revoke
plans feegrant revoke-all                 POST /api/feegrant/revoke-all
plans feegrant auto-grant get             GET /api/feegrant/auto-grant
plans feegrant auto-grant set <true|false>  POST /api/feegrant/auto-grant
  [--spend-limit-dvpn N]
  [--expiration-days N]
`,
  'rpc-health': `
plans rpc-health               GET /api/rpcs — probe all 39 LCD/RPC endpoints
`,
  'rpc-providers': `
plans rpc-providers            GET /api/rpc-providers — Tendermint RPC provider status
`,
};

// ─── Command: health ─────────────────────────────────────────────────────────

async function cmdHealth() {
  const d = await GET('/health');
  if (JSON_MODE) { printJson(d); return; }
  out(`OK  uptime: ${d.uptime ? d.uptime.toFixed(1) + 's' : '--'}`);
}

// ─── Command: status ─────────────────────────────────────────────────────────

async function cmdStatus() {
  const [progress, walletStatus] = await Promise.all([
    GET('/api/nodes/progress'),
    GET('/api/wallet/status'),
  ]);
  if (JSON_MODE) { printJson({ progress, walletStatus }); return; }
  out(`Wallet:  ${walletStatus.loaded ? 'loaded  ' + walletStatus.address : 'not loaded'}`);
  out(`Nodes:   scanning=${progress.scanning}  total=${progress.total}  probed=${progress.probed}  online=${progress.online}`);
}

// ─── Commands: wallet ─────────────────────────────────────────────────────────

async function cmdWalletStatus() {
  const d = await GET('/api/wallet/status');
  if (JSON_MODE) { printJson(d); return; }
  out(d.loaded ? `OK  loaded  ${d.address}` : 'NONE  no wallet loaded');
}

async function cmdWalletImport(mnemonic) {
  if (!mnemonic) { err('Usage: plans wallet import <mnemonic>'); process.exit(1); }
  const d = await POST('/api/wallet/import', { mnemonic });
  if (JSON_MODE) { printJson(d); return; }
  out(`OK  address: ${d.address}  provAddress: ${d.provAddress}`);
}

async function cmdWalletTestImport() {
  const d = await POST('/api/wallet/test-import', {});
  if (JSON_MODE) { printJson(d); return; }
  out(`OK  address: ${d.address}  provAddress: ${d.provAddress}`);
}

async function cmdWalletInfo() {
  const d = await GET('/api/wallet');
  if (JSON_MODE) { printJson(d); return; }
  out(`address:   ${d.address}`);
  out(`balance:   ${fmtP2P(d.balanceUdvpn)}  (${fmtUdvpn(d.balanceUdvpn)})`);
  out(`usd:       ${d.balanceUsd != null ? '$' + d.balanceUsd : '--'}`);
  out(`P2P price: ${d.dvpnPriceUsd != null ? '$' + d.dvpnPriceUsd : '--'}`);
  if (d.provider) {
    out(`provider:  ${d.provider.name || '--'}  (${d.provider.address || '--'})`);
  } else {
    out('provider:  not registered');
  }
}

async function cmdWalletLogout() {
  const d = await POST('/api/wallet/logout', {});
  if (JSON_MODE) { printJson(d); return; }
  out('OK  wallet cleared');
}

// ─── Commands: plan ───────────────────────────────────────────────────────────

async function cmdPlanList() {
  const d = await GET('/api/plans');
  if (JSON_MODE) { printJson(d); return; }
  const plans = d.plans || [];
  if (plans.length === 0) { out('No plans found.'); return; }
  table(plans, [
    { key: 'planId', label: 'ID', width: 6 },
    { key: 'subscribers', label: 'Subs', width: 6, fmt: v => String(v ?? '--') },
    { key: 'nodeCount', label: 'Nodes', width: 7, fmt: v => String(v ?? '--') },
    { key: 'gigabytes', label: 'GB', width: 8, fmt: v => String(v ?? '--') },
    { key: 'durationDays', label: 'Days', width: 6, fmt: v => String(v ?? '--') },
    { key: 'priceUdvpn', label: 'Price (udvpn/GB)', width: 18, fmt: v => String(v ?? '--') },
    { key: 'status', label: 'Status', width: 10, fmt: v => String(v ?? '--') },
  ]);
  out(`\nTotal: ${plans.length} plan(s)  discovered: ${d.discoveredAt || '--'}`);
}

async function cmdPlanGet(id) {
  if (!id) { err('Usage: plans plan get <id>'); process.exit(1); }
  const d = await GET(`/api/plans/${id}`);
  if (JSON_MODE) { printJson(d); return; }
  printKv({
    planId: d.planId,
    status: d.status,
    gigabytes: d.gigabytes,
    durationDays: d.durationDays,
    priceUdvpn: fmtUdvpn(d.priceUdvpn),
    subscribers: d.subscribers,
    uniqueWallets: d.uniqueWallets,
    nodeCount: d.nodeCount || (d.nodes ? d.nodes.length : '--'),
  });
}

async function cmdPlanSubscribers(id) {
  if (!id) { err('Usage: plans plan subscribers <id>'); process.exit(1); }
  const d = await GET(`/api/plans/${id}/subscriptions`);
  if (JSON_MODE) { printJson(d); return; }
  const subs = d.subscriptions || [];
  if (subs.length === 0) { out('No subscriptions.'); return; }
  table(subs, [
    { key: 'id', label: 'Sub ID', width: 8 },
    { key: 'acc_address', label: 'Address', width: 45 },
    { key: 'status', label: 'Status', width: 10 },
    { key: 'inactive_at', label: 'Expires', width: 28, fmt: v => v ? new Date(v).toISOString().slice(0, 16) : '--' },
  ]);
  out(`\nTotal shown: ${subs.length}`);
}

async function cmdPlanMine() {
  const d = await GET('/api/my-plans');
  if (JSON_MODE) { printJson(d); return; }
  out(`address: ${d.address}`);
  out(`balance: ${d.balance} P2P`);
  const plans = d.plans || [];
  if (plans.length === 0) { out('No plans.'); return; }
  out('');
  table(plans, [
    { key: 'planId', label: 'ID', width: 6 },
    { key: 'subscribers', label: 'Subs', width: 6, fmt: v => String(v ?? '--') },
    { key: 'nodeCount', label: 'Nodes', width: 7, fmt: v => String(v ?? '--') },
    { key: 'gigabytes', label: 'GB', width: 8, fmt: v => String(v ?? '--') },
    { key: 'durationDays', label: 'Days', width: 6, fmt: v => String(v ?? '--') },
    { key: 'priceUdvpn', label: 'Price (udvpn/GB)', width: 18, fmt: v => String(v ?? '--') },
    { key: 'status', label: 'Status', width: 10, fmt: v => String(v ?? '--') },
  ]);
}

async function cmdPlanCreate(f) {
  const gb = parseInt(f.gb);
  const days = parseInt(f.days);
  const priceUdvpn = parseInt(f['price-udvpn']);
  if (!gb || !days || !priceUdvpn) {
    err('Usage: plans plan create --gb N --days N --price-udvpn N [--private]');
    err('  --gb N           Data cap in gigabytes');
    err('  --days N         Duration in days');
    err('  --price-udvpn N  Price per GB in udvpn (e.g. 500000 = 0.5 P2P/GB)');
    process.exit(1);
  }
  const body = {
    gigabytes: gb,
    durationSeconds: days * 86400,
    priceDenom: 'udvpn',
    priceQuoteValue: String(priceUdvpn),
    isPrivate: f.private === true || f.private === 'true',
  };
  const d = await POST('/api/plan/create', body);
  if (JSON_MODE) { printJson(d); return; }
  txLine(d);
  if (d.planId) out(`planId: ${d.planId}`);
}

async function cmdPlanStatus(id, status) {
  if (!id || !status) { err('Usage: plans plan status <id> <status>  (1=active, 2=inactive_pending, 3=inactive)'); process.exit(1); }
  const d = await POST('/api/plan/status', { planId: parseInt(id), status: parseInt(status) });
  if (JSON_MODE) { printJson(d); return; }
  txLine(d);
}

async function cmdPlanSubscribe(planId, f) {
  if (!planId) { err('Usage: plans plan subscribe <planId> [--denom udvpn]'); process.exit(1); }
  const d = await POST('/api/plan/subscribe', { planId: parseInt(planId), denom: f.denom || 'udvpn' });
  if (JSON_MODE) { printJson(d); return; }
  txLine(d);
  if (d.subscriptionId) out(`subscriptionId: ${d.subscriptionId}`);
}

async function cmdPlanStartSession(subId, nodeAddr) {
  if (!subId || !nodeAddr) { err('Usage: plans plan start-session <subId> <nodeAddr>'); process.exit(1); }
  const d = await POST('/api/plan/start-session', { subscriptionId: subId, nodeAddress: nodeAddr });
  if (JSON_MODE) { printJson(d); return; }
  txLine(d);
  if (d.sessionId) out(`sessionId: ${d.sessionId}`);
}

// ─── Commands: node ───────────────────────────────────────────────────────────

async function cmdNodeList(f) {
  scanning('scanning...');
  const params = new URLSearchParams();
  if (f.limit) params.set('limit', f.limit);
  if (f.page) params.set('page', f.page);
  if (f.country) params.set('country', f.country);
  if (f.protocol) params.set('protocol', f.protocol);
  const qs = params.toString() ? '?' + params.toString() : '';
  const d = await GET('/api/all-nodes' + qs);
  if (JSON_MODE) { printJson(d); return; }
  const nodes = d.nodes || [];
  if (nodes.length === 0) { out('No nodes.'); return; }
  table(nodes, [
    { key: 'address', label: 'Address', width: 50 },
    { key: 'country', label: 'Country', width: 8, fmt: v => v || '--' },
    { key: 'protocol', label: 'Protocol', width: 12, fmt: v => v || '--' },
    { key: 'gbPriceUdvpn', label: 'GB Price (udvpn)', width: 17, fmt: v => v != null ? String(v) : '--' },
    { key: 'moniker', label: 'Moniker', width: 20, fmt: v => v || '--' },
  ]);
  out(`\nShowing ${nodes.length} of ${d.total || '?'} (page ${d.page || 1}/${d.totalPages || '?'})`);
  if (d.countries && d.countries.length) out(`Countries: ${d.countries.slice(0, 10).join(', ')}${d.countries.length > 10 ? ' ...' : ''}`);
}

async function cmdNodeProgress() {
  const d = await GET('/api/nodes/progress');
  if (JSON_MODE) { printJson(d); return; }
  out(`scanning: ${d.scanning}  total: ${d.total}  probed: ${d.probed}  online: ${d.online}`);
}

async function cmdNodeSessions(addr) {
  if (!addr) { err('Usage: plans node sessions <nodeAddress>'); process.exit(1); }
  scanning('fetching sessions...');
  const d = await GET(`/api/nodes/${addr}/sessions`);
  if (JSON_MODE) { printJson(d); return; }
  const sessions = d.sessions || [];
  out(`Total sessions for ${addr}: ${d.total}`);
  if (sessions.length === 0) return;
  table(sessions.slice(0, 20), [
    { key: 'id', label: 'Session ID', width: 12, fmt: (v, r) => String(r.base_session?.id || v || '--') },
    { key: 'acc_address', label: 'Account', width: 45, fmt: (v, r) => r.base_session?.acc_address || '--' },
    { key: 'status', label: 'Status', width: 10, fmt: (v, r) => r.base_session?.status || '--' },
  ]);
  if (sessions.length > 20) out(`... and ${sessions.length - 20} more`);
}

async function cmdNodeRankings() {
  scanning('computing rankings...');
  const d = await GET('/api/node-rankings');
  if (JSON_MODE) { printJson(d); return; }
  const ranked = d.ranked || [];
  if (ranked.length === 0) { out('No ranking data.'); return; }
  table(ranked.slice(0, 20), [
    { key: 'address', label: 'Address', width: 50 },
    { key: 'uniqueUsers', label: 'UU', width: 6 },
    { key: 'totalSessions', label: 'Sessions', width: 10 },
    { key: 'totalBandwidthGB', label: 'Bandwidth(GB)', width: 14 },
    { key: 'estEarningsDvpn', label: 'Est P2P', width: 10 },
  ]);
  out(`\nTotal: ${d.totalNodes} nodes  ${d.totalSessions} sessions`);
  out(`Total DL: ${d.totalDownloadGB} GB  UL: ${d.totalUploadGB} GB`);
  out(`P2P price: ${d.dvpnPriceUsd != null ? '$' + d.dvpnPriceUsd : '--'}`);
  out(`Scanned: ${d.scannedAt || '--'}`);
}

// ─── Commands: link / unlink ──────────────────────────────────────────────────

async function cmdLink(planId, nodeAddr, f) {
  if (!planId || !nodeAddr) { err('Usage: plans link <planId> <nodeAddr> [--lease-hours N]'); process.exit(1); }
  const body = { planId: parseInt(planId), nodeAddress: nodeAddr };
  if (f['lease-hours']) body.leaseHours = parseInt(f['lease-hours']);
  const d = await POST('/api/plan-manager/link', body);
  if (JSON_MODE) { printJson(d); return; }
  if (d.alreadyLinked) { out(`OK  already linked: ${d.msg}`); return; }
  txLine(d);
}

async function cmdBatchLink(planId, nodeList, f) {
  if (!planId || !nodeList) {
    err('Usage: plans batch-link <planId> <node1,node2,...> [--lease-hours N]');
    process.exit(1);
  }
  const nodeAddresses = nodeList.split(',').map(s => s.trim()).filter(Boolean);
  const body = { planId: parseInt(planId), nodeAddresses };
  if (f['lease-hours']) body.leaseHours = parseInt(f['lease-hours']);
  const d = await POST('/api/plan-manager/batch-link', body);
  if (JSON_MODE) { printJson(d); return; }
  if (d.alreadyLinked) { out(`OK  all already linked (${d.alreadyLinked})`); return; }
  txLine(d);
  if (d.linked != null) out(`linked: ${d.linked}`);
}

async function cmdUnlink(planId, nodeAddr) {
  if (!planId || !nodeAddr) { err('Usage: plans unlink <planId> <nodeAddr>'); process.exit(1); }
  const d = await POST('/api/plan-manager/unlink', { planId: parseInt(planId), nodeAddress: nodeAddr });
  if (JSON_MODE) { printJson(d); return; }
  if (d.alreadyUnlinked) { out(`OK  already unlinked: ${d.msg}`); return; }
  txLine(d);
}

async function cmdBatchUnlink(planId, nodeList) {
  if (!planId || !nodeList) {
    err('Usage: plans batch-unlink <planId> <node1,node2,...>');
    process.exit(1);
  }
  const nodeAddresses = nodeList.split(',').map(s => s.trim()).filter(Boolean);
  const d = await POST('/api/plan-manager/batch-unlink', { planId: parseInt(planId), nodeAddresses });
  if (JSON_MODE) { printJson(d); return; }
  txLine(d);
  if (d.unlinked != null) out(`unlinked: ${d.unlinked}`);
}

// ─── Commands: lease ──────────────────────────────────────────────────────────

async function cmdLeaseStart(nodeAddr, f) {
  if (!nodeAddr) { err('Usage: plans lease start <nodeAddr> [--hours N] [--max-price-udvpn N]'); process.exit(1); }
  const body = { nodeAddress: nodeAddr };
  if (f.hours) body.hours = parseInt(f.hours);
  if (f['max-price-udvpn']) body.maxPriceQuoteValue = f['max-price-udvpn'];
  const d = await POST('/api/lease/start', body);
  if (JSON_MODE) { printJson(d); return; }
  txLine(d);
  if (d.leaseId) out(`leaseId: ${d.leaseId}`);
}

async function cmdLeaseEnd(leaseId) {
  if (!leaseId) { err('Usage: plans lease end <leaseId>'); process.exit(1); }
  const d = await POST('/api/lease/end', { leaseId });
  if (JSON_MODE) { printJson(d); return; }
  txLine(d);
}

// ─── Commands: provider ───────────────────────────────────────────────────────

async function cmdProviderList() {
  const d = await GET('/api/providers');
  if (JSON_MODE) { printJson(d); return; }
  const providers = d.providers || [];
  if (providers.length === 0) { out('No providers.'); return; }
  table(providers, [
    { key: 'address', label: 'Address', width: 50 },
    { key: 'name', label: 'Name', width: 24, fmt: v => v || '--' },
    { key: 'website', label: 'Website', width: 30, fmt: v => v || '--' },
    { key: 'status', label: 'Status', width: 10, fmt: v => String(v ?? '--') },
  ]);
  out(`\nTotal: ${providers.length}`);
}

async function cmdProviderRegister(f) {
  if (!f.name) {
    err('Usage: plans provider register --name X [--identity X --website X --description X]');
    process.exit(1);
  }
  const body = {
    name: f.name,
    identity: f.identity || '',
    website: f.website || '',
    description: f.description || '',
  };
  const d = await POST('/api/provider/register', body);
  if (JSON_MODE) { printJson(d); return; }
  out(`OK  action: ${d.action}`);
  txLine(d);
}

async function cmdProviderStatus(status) {
  if (!status) { err('Usage: plans provider status <n>  (1=active, 2=inactive_pending, 3=inactive)'); process.exit(1); }
  const d = await POST('/api/provider/status', { status: parseInt(status) });
  if (JSON_MODE) { printJson(d); return; }
  txLine(d);
}

// ─── Commands: params ─────────────────────────────────────────────────────────

async function cmdParams() {
  const d = await GET('/api/params');
  if (JSON_MODE) { printJson(d); return; }
  for (const [section, params] of Object.entries(d)) {
    out(`\n[${section}]`);
    if (params && typeof params === 'object') {
      printKv(params, '  ');
    } else {
      out(`  ${params}`);
    }
  }
}

// ─── Commands: feegrant ───────────────────────────────────────────────────────

async function cmdFeegrantList() {
  const d = await GET('/api/feegrant/grants');
  if (JSON_MODE) { printJson(d); return; }
  const allows = d.allowances || [];
  if (allows.length === 0) { out('No fee grants issued.'); return; }
  table(allows, [
    { key: 'grantee', label: 'Grantee', width: 45 },
    { key: 'allowanceType', label: 'Type', width: 14 },
    { key: 'expiration', label: 'Expires', width: 28, fmt: v => v ? new Date(v).toISOString().slice(0, 16) : '--' },
    {
      key: 'spendLimit', label: 'Spend Limit', width: 20,
      fmt: v => {
        if (!v || !Array.isArray(v) || v.length === 0) return 'unlimited';
        const udvpn = v.find(x => x.denom === 'udvpn');
        return udvpn ? fmtP2P(udvpn.amount) : JSON.stringify(v);
      },
    },
  ]);
  out(`\nTotal: ${d.total}`);
}

async function cmdFeegrantGasCosts(planId) {
  if (!planId) { err('Usage: plans feegrant gas-costs <planId>'); process.exit(1); }
  scanning('scanning gas costs (may take a while)...');
  const d = await GET(`/api/feegrant/gas-costs?planId=${planId}`);
  if (JSON_MODE) { printJson(d); return; }
  out(`subscribers: ${d.subscriberCount}`);
  out(`total gas:   ${fmtP2P(d.totalUdvpn)}  (${fmtUdvpn(d.totalUdvpn)})`);
  out(`tx count:    ${d.txCount}`);
  const by = d.byAddress || {};
  const addrs = Object.keys(by);
  if (addrs.length > 0) {
    out('');
    out('Per address (fee-granted TXs only):');
    for (const addr of addrs) {
      out(`  ${addr}  ${fmtP2P(by[addr].udvpn)}  (${by[addr].txCount} txs)`);
    }
  }
}

async function cmdFeegrantGrant(grantee, f) {
  if (!grantee) {
    err('Usage: plans feegrant grant <grantee> [--spend-limit-dvpn N] [--expiration-days N]');
    process.exit(1);
  }
  const body = { grantee };
  if (f['spend-limit-dvpn']) body.spendLimitDvpn = parseFloat(f['spend-limit-dvpn']);
  if (f['expiration-days']) body.expirationDays = parseInt(f['expiration-days']);
  const d = await POST('/api/feegrant/grant', body);
  if (JSON_MODE) { printJson(d); return; }
  out(`OK  txHash: ${d.txHash}`);
}

async function cmdFeegrantGrantSubscribers(planId, f) {
  if (!planId) {
    err('Usage: plans feegrant grant-subscribers <planId> [--spend-limit-dvpn N] [--expiration-days N]');
    process.exit(1);
  }
  scanning('granting fee allowances to plan subscribers (this may take minutes)...');
  const body = { planId: parseInt(planId) };
  if (f['spend-limit-dvpn']) body.spendLimitDvpn = parseFloat(f['spend-limit-dvpn']);
  if (f['expiration-days']) body.expirationDays = parseInt(f['expiration-days']);
  const d = await POST('/api/feegrant/grant-subscribers', body);
  if (JSON_MODE) { printJson(d); return; }
  out(`OK  granted: ${d.granted}  skipped: ${d.skipped}`);
  if (d.errors && d.errors.length) {
    out(`Errors (${d.errors.length}):`);
    for (const e of d.errors) out(`  - ${e}`);
  }
  if (d.message) out(d.message);
}

async function cmdFeegrantRevoke(grantee) {
  if (!grantee) { err('Usage: plans feegrant revoke <grantee>'); process.exit(1); }
  const d = await POST('/api/feegrant/revoke', { grantee });
  if (JSON_MODE) { printJson(d); return; }
  out(`OK  txHash: ${d.txHash}`);
}

async function cmdFeegrantRevokeAll() {
  const d = await POST('/api/feegrant/revoke-all', {});
  if (JSON_MODE) { printJson(d); return; }
  out(`OK  revoked: ${d.revoked}`);
  if (d.errors && d.errors.length) {
    out(`Errors (${d.errors.length}):`);
    for (const e of d.errors) out(`  - ${e}`);
  }
  if (d.message) out(d.message);
}

async function cmdFeegrantAutoGrantGet() {
  const d = await GET('/api/feegrant/auto-grant');
  if (JSON_MODE) { printJson(d); return; }
  out(`enabled:       ${d.enabled}`);
  out(`spendLimitDvpn: ${d.spendLimitDvpn}`);
  out(`expirationDays: ${d.expirationDays}`);
}

async function cmdFeegrantAutoGrantSet(enabled, f) {
  if (enabled === undefined || enabled === null) {
    err('Usage: plans feegrant auto-grant set <true|false> [--spend-limit-dvpn N] [--expiration-days N]');
    process.exit(1);
  }
  const body = { enabled: enabled === 'true' || enabled === true };
  if (f['spend-limit-dvpn']) body.spendLimitDvpn = parseFloat(f['spend-limit-dvpn']);
  if (f['expiration-days']) body.expirationDays = parseInt(f['expiration-days']);
  const d = await POST('/api/feegrant/auto-grant', body);
  if (JSON_MODE) { printJson(d); return; }
  out(`OK  enabled=${d.enabled}  spendLimitDvpn=${d.spendLimitDvpn}  expirationDays=${d.expirationDays}`);
}

// ─── Commands: rpc-health / rpc-providers ────────────────────────────────────

async function cmdRpcHealth() {
  scanning('probing endpoints...');
  const d = await GET('/api/rpcs');
  if (JSON_MODE) { printJson(d); return; }
  const results = d.results || [];
  out(`Summary: ${d.summary?.ok} ok  ${d.summary?.fail} fail  total: ${d.summary?.total}  checked: ${d.checkedAt}`);
  out('');
  table(results, [
    { key: 'method', label: 'Method', width: 6 },
    { key: 'status', label: 'Status', width: 16 },
    { key: 'latencyMs', label: 'Latency(ms)', width: 12, fmt: v => v != null ? String(v) : '--' },
    { key: 'path', label: 'Path', width: 60 },
    { key: 'errorMsg', label: 'Error', width: 40, fmt: v => v || '' },
  ]);
  if (d.peerStats) {
    out('');
    out('Peer stats:');
    printKv(d.peerStats, '  ');
  }
}

async function cmdRpcProviders() {
  scanning('scanning RPC providers...');
  const d = await GET('/api/rpc-providers');
  if (JSON_MODE) { printJson(d); return; }
  const providers = d.providers || [];
  out(`Summary: ${d.summary?.up} up  ${d.summary?.down} down  maxHeight: ${d.summary?.maxHeight}  checked: ${d.checkedAt}`);
  out('');
  table(providers, [
    { key: 'url', label: 'URL', width: 50 },
    { key: 'status', label: 'Status', width: 6 },
    { key: 'latency', label: 'ms', width: 6, fmt: v => v != null ? String(v) : '--' },
    { key: 'latestHeight', label: 'Height', width: 10, fmt: v => v != null ? String(v) : '--' },
    { key: 'blocksBehind', label: 'Behind', width: 8, fmt: v => v != null ? String(v) : '--' },
    { key: 'moniker', label: 'Moniker', width: 24, fmt: v => v || '--' },
    { key: 'error', label: 'Error', width: 40, fmt: v => v || '' },
  ]);
}

// ─── Router ───────────────────────────────────────────────────────────────────

async function main() {
  const [group, sub, ...rest] = positional;

  if (!group || group === 'help' || flags.help) {
    if (group && group !== 'help' && HELP[group]) {
      out(HELP[group]);
    } else {
      out(HELP_ROOT);
    }
    return;
  }

  // Sub-group help
  if (sub === '--help' || sub === '-h') {
    if (HELP[group]) { out(HELP[group]); } else { out(HELP_ROOT); }
    return;
  }

  switch (group) {

    // ─── health / status ───────────────────────────────────────────────────
    case 'health':
      await cmdHealth();
      break;

    case 'status':
      await cmdStatus();
      break;

    // ─── wallet ────────────────────────────────────────────────────────────
    case 'wallet':
      if (!sub || sub === 'help' || sub === '--help') { out(HELP.wallet); break; }
      switch (sub) {
        case 'status':      await cmdWalletStatus(); break;
        case 'import':      await cmdWalletImport(rest[0] || flags.mnemonic); break;
        case 'test-import': await cmdWalletTestImport(); break;
        case 'info':        await cmdWalletInfo(); break;
        case 'logout':      await cmdWalletLogout(); break;
        default:
          err(`Unknown wallet subcommand: ${sub}`);
          out(HELP.wallet);
          process.exit(1);
      }
      break;

    // ─── plan ──────────────────────────────────────────────────────────────
    case 'plan':
      if (!sub || sub === 'help' || sub === '--help') { out(HELP.plan); break; }
      switch (sub) {
        case 'list':          await cmdPlanList(); break;
        case 'get':           await cmdPlanGet(rest[0]); break;
        case 'subscribers':   await cmdPlanSubscribers(rest[0]); break;
        case 'mine':          await cmdPlanMine(); break;
        case 'create':        await cmdPlanCreate(flags); break;
        case 'status':        await cmdPlanStatus(rest[0], rest[1]); break;
        case 'subscribe':     await cmdPlanSubscribe(rest[0], flags); break;
        case 'start-session': await cmdPlanStartSession(rest[0], rest[1]); break;
        default:
          err(`Unknown plan subcommand: ${sub}`);
          out(HELP.plan);
          process.exit(1);
      }
      break;

    // ─── node ──────────────────────────────────────────────────────────────
    case 'node':
      if (!sub || sub === 'help' || sub === '--help') { out(HELP.node); break; }
      switch (sub) {
        case 'list':      await cmdNodeList(flags); break;
        case 'progress':  await cmdNodeProgress(); break;
        case 'sessions':  await cmdNodeSessions(rest[0]); break;
        case 'rankings':  await cmdNodeRankings(); break;
        default:
          err(`Unknown node subcommand: ${sub}`);
          out(HELP.node);
          process.exit(1);
      }
      break;

    // ─── link / unlink ─────────────────────────────────────────────────────
    case 'link':
      await cmdLink(sub, rest[0], flags);
      break;

    case 'batch-link':
      await cmdBatchLink(sub, rest[0], flags);
      break;

    case 'unlink':
      await cmdUnlink(sub, rest[0]);
      break;

    case 'batch-unlink':
      await cmdBatchUnlink(sub, rest[0]);
      break;

    // ─── lease ─────────────────────────────────────────────────────────────
    case 'lease':
      if (!sub || sub === 'help' || sub === '--help') { out(HELP.lease); break; }
      switch (sub) {
        case 'start': await cmdLeaseStart(rest[0], flags); break;
        case 'end':   await cmdLeaseEnd(rest[0]); break;
        default:
          err(`Unknown lease subcommand: ${sub}`);
          out(HELP.lease);
          process.exit(1);
      }
      break;

    // ─── provider ──────────────────────────────────────────────────────────
    case 'provider':
      if (!sub || sub === 'help' || sub === '--help') { out(HELP.provider); break; }
      switch (sub) {
        case 'list':     await cmdProviderList(); break;
        case 'register': await cmdProviderRegister(flags); break;
        case 'status':   await cmdProviderStatus(rest[0]); break;
        default:
          err(`Unknown provider subcommand: ${sub}`);
          out(HELP.provider);
          process.exit(1);
      }
      break;

    // ─── params ────────────────────────────────────────────────────────────
    case 'params':
      await cmdParams();
      break;

    // ─── feegrant ──────────────────────────────────────────────────────────
    case 'feegrant':
      if (!sub || sub === 'help' || sub === '--help') { out(HELP.feegrant); break; }
      switch (sub) {
        case 'list':               await cmdFeegrantList(); break;
        case 'gas-costs':          await cmdFeegrantGasCosts(rest[0]); break;
        case 'grant':              await cmdFeegrantGrant(rest[0], flags); break;
        case 'grant-subscribers':  await cmdFeegrantGrantSubscribers(rest[0], flags); break;
        case 'revoke':             await cmdFeegrantRevoke(rest[0]); break;
        case 'revoke-all':         await cmdFeegrantRevokeAll(); break;
        case 'auto-grant': {
          const ag = rest[0];
          if (!ag || ag === '--help') { out(HELP.feegrant); break; }
          if (ag === 'get') { await cmdFeegrantAutoGrantGet(); break; }
          if (ag === 'set') { await cmdFeegrantAutoGrantSet(rest[1], flags); break; }
          err(`Unknown auto-grant subcommand: ${ag}  (use: get | set <true|false>)`);
          process.exit(1);
        }
        default:
          err(`Unknown feegrant subcommand: ${sub}`);
          out(HELP.feegrant);
          process.exit(1);
      }
      break;

    // ─── rpc-health / rpc-providers ────────────────────────────────────────
    case 'rpc-health':
      await cmdRpcHealth();
      break;

    case 'rpc-providers':
      await cmdRpcProviders();
      break;

    default:
      err(`Unknown command group: ${group}`);
      out(HELP_ROOT);
      process.exit(1);
  }
}

main().catch(e => {
  err(`FATAL: ${e.message}`);
  if (!JSON_MODE) err(e.stack || '');
  process.exit(2);
});
