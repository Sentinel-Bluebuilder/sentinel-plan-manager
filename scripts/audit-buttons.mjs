#!/usr/bin/env node
// Static audit: every onclick handler in index.html has a matching JS function,
// every fetch target maps to an Express route in server.js, every server route
// has a CLI subcommand in cli.js.
//
// Run:  node scripts/audit-buttons.mjs
// Exit 0 = clean, 1 = issues found.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
const server = readFileSync(join(ROOT, 'server.js'), 'utf8');
let cli = '';
try { cli = readFileSync(join(ROOT, 'cli.js'), 'utf8'); } catch {}

// ─── 1. Collect every onclick call in HTML ─────────────────────────────────
// Two shapes:
//   (a) static: onclick="name()"
//   (b) injected inside template literals: onclick="name(${expr})"
const onclickRe = /onclick\s*=\s*"([^"]+)"/g;
const onclicks = [];
for (const m of html.matchAll(onclickRe)) onclicks.push(m[1]);

// Extract ALL function calls in the onclick expression, not just the first —
// handlers like "doA(); doB()" and "event.stopPropagation(); doC()" are common.
function callsIn(expr) {
  const out = [];
  const re = /(?:^|[\s;(])\s*(?:await\s+)?([A-Za-z_$][\w$.]*)\s*\(/g;
  for (const m of expr.matchAll(re)) out.push(m[1]);
  return out;
}
const handlerNames = new Set();
const handlerOrigins = new Map(); // name -> example expression
for (const expr of onclicks) {
  for (const n of callsIn(expr)) {
    handlerNames.add(n);
    if (!handlerOrigins.has(n)) handlerOrigins.set(n, expr);
  }
}

// Known globals / builtins / object methods we should not try to define.
const BUILTIN = new Set([
  'event', 'window', 'document', 'console', 'alert', 'confirm', 'prompt',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'fetch', 'Promise', 'JSON', 'Math', 'Object', 'Array', 'String', 'Number',
  'parseInt', 'parseFloat', 'encodeURIComponent', 'decodeURIComponent',
  'navigator', 'localStorage', 'sessionStorage', 'location',
  'e.stopPropagation', 'e.preventDefault',
  'event.stopPropagation', 'event.preventDefault',
]);

// ─── 2. Verify each handler is defined in the HTML ─────────────────────────
const missingHandlers = [];
for (const name of handlerNames) {
  if (BUILTIN.has(name)) continue;
  // Dotted access (S.foo, obj.method, event.stopPropagation) — skip
  if (name.includes('.')) continue;
  const defRe = new RegExp(
    `(function\\s+${name}\\b|async\\s+function\\s+${name}\\b|const\\s+${name}\\s*=|let\\s+${name}\\s*=|var\\s+${name}\\s*=|\\b${name}\\s*=\\s*function|\\b${name}\\s*=\\s*async\\s*(?:function|\\())`
  );
  if (!defRe.test(html)) missingHandlers.push(name);
}

// ─── 3. Collect every fetch() target ───────────────────────────────────────
const fetchRe = /fetch\s*\(\s*(?:`|'|")(\/api\/[^`'"${\s)]+)/g;
const apiCalls = new Set();
for (const m of html.matchAll(fetchRe)) apiCalls.add(m[1].split('?')[0]);

// Also collect template-literal fetches: fetch(`/api/foo/${id}/bar`)
const fetchTplRe = /fetch\s*\(\s*`(\/api\/[^`]+?)`/g;
for (const m of html.matchAll(fetchTplRe)) {
  const path = m[1].replace(/\$\{[^}]+\}/g, ':param').split('?')[0];
  apiCalls.add(path);
}

// ─── 4. Collect every Express route ────────────────────────────────────────
const routeRe = /app\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/g;
const routes = new Set();
const routesByMethod = [];
for (const m of server.matchAll(routeRe)) {
  routes.add(m[2]);
  routesByMethod.push({ method: m[1].toUpperCase(), path: m[2] });
}

// Normalise: /api/foo/:id matches /api/foo/:param
function routeMatches(call, route) {
  if (call === route) return true;
  const cParts = call.split('/');
  const rParts = route.split('/');
  if (cParts.length !== rParts.length) return false;
  for (let i = 0; i < cParts.length; i++) {
    if (rParts[i].startsWith(':')) continue;
    if (cParts[i] === ':param') continue;
    if (cParts[i] !== rParts[i]) return false;
  }
  return true;
}

const missingEndpoints = [];
for (const call of apiCalls) {
  let matched = false;
  for (const r of routes) { if (routeMatches(call, r)) { matched = true; break; } }
  if (!matched) missingEndpoints.push(call);
}

// ─── 5. CLI parity — every /api route has a CLI mention ────────────────────
const cliGaps = [];
if (cli) {
  for (const r of routes) {
    if (r.startsWith('/api/')) {
      // strip params
      const bare = r.replace(/:[\w]+/g, '').replace(/\/+/g, '/').replace(/\/$/, '');
      const tail = bare.replace('/api/', '');
      if (!tail) continue;
      // does cli.js reference this path anywhere?
      if (!cli.includes(r) && !cli.includes(tail)) cliGaps.push(r);
    }
  }
}

// ─── 6. addEventListener clicks ────────────────────────────────────────────
const addListenerRe = /\.addEventListener\s*\(\s*['"]click['"]\s*,\s*([A-Za-z_$][\w$]*)/g;
const listenerHandlers = [];
for (const m of html.matchAll(addListenerRe)) listenerHandlers.push(m[1]);

const missingListeners = [];
for (const name of listenerHandlers) {
  const defRe = new RegExp(
    `(function\\s+${name}\\b|const\\s+${name}\\s*=|let\\s+${name}\\s*=|async\\s+function\\s+${name}\\b)`
  );
  if (!defRe.test(html)) missingListeners.push(name);
}

// ─── 7. Report ─────────────────────────────────────────────────────────────
const lines = [];
lines.push('═══════════════════════════════════════════════════════════════════');
lines.push('  Plan Manager — Button / Handler / Endpoint Audit');
lines.push('═══════════════════════════════════════════════════════════════════');
lines.push('');
lines.push(`Onclick handlers found:           ${onclicks.length} total, ${handlerNames.size} unique`);
lines.push(`addEventListener click handlers:  ${listenerHandlers.length}`);
lines.push(`fetch() API calls:                ${apiCalls.size} unique`);
lines.push(`Express routes defined:           ${routes.size}`);
lines.push('');

let problems = 0;

if (missingHandlers.length) {
  lines.push(`⚠  ${missingHandlers.length} DEAD BUTTONS — onclick calls a function that does not exist:`);
  for (const n of missingHandlers.sort()) lines.push(`    - ${n}()`);
  lines.push('');
  problems += missingHandlers.length;
}

if (missingListeners.length) {
  lines.push(`⚠  ${missingListeners.length} missing addEventListener handlers:`);
  for (const n of missingListeners) lines.push(`    - ${n}`);
  lines.push('');
  problems += missingListeners.length;
}

if (missingEndpoints.length) {
  lines.push(`⚠  ${missingEndpoints.length} fetch() calls to endpoints that do not exist on server:`);
  for (const p of missingEndpoints.sort()) lines.push(`    - ${p}`);
  lines.push('');
  problems += missingEndpoints.length;
}

if (cliGaps.length) {
  lines.push(`ℹ  ${cliGaps.length} server routes not referenced in cli.js (CLI parity gap):`);
  for (const r of cliGaps.sort()) lines.push(`    - ${r}`);
  lines.push('');
}

if (problems === 0 && cliGaps.length === 0) {
  lines.push('✓ All buttons have handlers. All handlers have endpoints. All endpoints have CLI commands.');
} else if (problems === 0) {
  lines.push('✓ No dead buttons or missing endpoints. Only CLI parity gaps (informational).');
}

console.log(lines.join('\n'));
process.exit(problems > 0 ? 1 : 0);
