// ─── Chain Interaction ────────────────────────────────────────────────────────
// LCD queries, signing client management, TX broadcast with retry.
// RPC queries via SDK for ~912x faster lookups (LCD as fallback).

import { SigningStargateClient, GasPrice, calculateFee, QueryClient, setupAuthExtension, accountFromAny } from '@cosmjs/stargate';
import { makeAuthInfoBytes, encodePubkey } from '@cosmjs/proto-signing';
import { fromBase64, toBase64 } from '@cosmjs/encoding';
import { TxRaw, TxBody } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
import { Int53 } from '@cosmjs/math';
import { LCD_ENDPOINTS, RPC, GAS_PRICE_STR, CHAIN_ID } from './constants.js';
// SDK: P2P price (CoinGecko) + RPC query functions (protobuf transport, ~912x faster than LCD REST)
// SDK 2.7.2 ships a consensus-audited RPC pool — no runtime patching needed.
import {
  getDvpnPrice as _sdkGetDvpnPrice,
  createRpcQueryClientWithFallback,
  disconnectRpc,
  lcdQuery as _sdkLcdQuery,
  rpcQueryNode,
  rpcQueryNodes,
  rpcQueryNodesForPlan,
  rpcQuerySession,
  rpcQuerySessionsForAccount,
  rpcQuerySubscription,
  rpcQuerySubscriptionsForAccount,
  rpcQuerySubscriptionsForPlan,
  rpcQuerySubscriptionAllocations,
  rpcQueryPlan,
  rpcQueryBalance,
  rpcQueryFeeGrant,
  rpcQueryFeeGrants,
  rpcQueryFeeGrantsIssued,
  rpcQueryProvider,
  addRpcEndpoint,
} from 'blue-js-sdk';

import { createRegistry } from './protobuf.js';
import { isSequenceError, extractExpectedSeq } from './errors.js';
import { cacheInvalidate } from 'blue-js-sdk';
import { getAddr } from './wallet.js';
import { currentSession } from './session.js';

// Primary RPC per operator directive (2026-06-11). The SDK's failover pool
// (createRpcQueryClientWithFallback, listNodes, every rpcQuery*) tries
// endpoints in order, so prepending makes rpc-fast-1 the first attempt for
// all chain interaction while keeping the audited pool as fallback.
addRpcEndpoint(RPC, 'Sentinel Fast 1', true);

// ─── LCD Fetch with Failover ─────────────────────────────────────────────────

/**
 * Query an LCD endpoint with automatic failover across multiple providers.
 *
 * Delegates per-endpoint requests to the SDK's lcdQuery, which adds a single
 * network-error retry (ECONNREFUSED / ENOTFOUND / timeout) before failing
 * over. We still iterate Plan Manager's local LCD_ENDPOINTS so trivium
 * (not in the SDK list) stays in the rotation.
 *
 * @param {string} path - LCD query path (e.g., '/sentinel/node/v3/nodes?status=1')
 * @param {number} [timeoutMs=30000] - Request timeout
 * @returns {Promise<object>} Parsed JSON response
 * @throws {Error} Last error if all endpoints fail
 */
export async function lcd(path, timeoutMs = 30000) {
  let lastErr;
  for (const base of LCD_ENDPOINTS) {
    try {
      return await _sdkLcdQuery(path, { lcdUrl: base, timeout: timeoutMs });
    } catch (e) {
      lastErr = e;
      console.log(`[LCD] ${base}${path} failed: ${e.message} — trying next`);
    }
  }
  throw lastErr;
}

// ─── P2P Price (delegated to SDK — same CoinGecko implementation) ────────────
export const getDvpnPrice = _sdkGetDvpnPrice;

// ─── RPC Query Client (cached, lazy-init, multi-endpoint fallback) ──────────

let _rpcClientPromise = null;

/**
 * Get or create a cached RPC query client with automatic endpoint failover.
 * Mirrors the blue-js-sdk@2.4.0 pattern: tries every RPC_ENDPOINTS in order,
 * caches the promise so concurrent callers share one connection attempt.
 * Returns null if every endpoint fails (callers fall back to LCD).
 *
 * @returns {Promise<{ queryClient: import('@cosmjs/stargate').QueryClient, rpc: object, tmClient: object, url: string }|null>}
 */
export async function getRpcClient() {
  if (_rpcClientPromise) return _rpcClientPromise;
  _rpcClientPromise = createRpcQueryClientWithFallback()
    .then(client => {
      console.log(`[RPC] Query client connected via ${client.url}`);
      return client;
    })
    .catch(err => {
      console.log(`[RPC] All endpoints failed: ${err.message} — will use LCD`);
      _rpcClientPromise = null; // allow retry on next call
      return null;
    });
  return _rpcClientPromise;
}

export function resetRpcClient() {
  _rpcClientPromise = null;
  try { disconnectRpc(); } catch {}
}

// Re-export SDK RPC query helpers so server.js can import from chain.js
export {
  rpcQueryNode,
  rpcQueryNodes,
  rpcQueryNodesForPlan,
  rpcQuerySession,
  rpcQuerySessionsForAccount,
  rpcQuerySubscription,
  rpcQuerySubscriptionsForAccount,
  rpcQuerySubscriptionsForPlan,
  rpcQuerySubscriptionAllocations,
  rpcQueryPlan,
  rpcQueryBalance,
  rpcQueryFeeGrant,
  rpcQueryFeeGrants,
  rpcQueryFeeGrantsIssued,
  rpcQueryProvider,
};

// ─── Plans-for-Provider Query (local SDK-gap shim) ───────────────────────────
// The chain exposes `sentinel.plan.v3.QueryService/QueryPlansForProvider`
// (LCD: /sentinel/plan/v3/providers/{address}/plans) but blue-js-sdk has no
// wrapper for it yet. Minimal protobuf encode/decode for just this query,
// mirroring the SDK's private helpers in chain/rpc.js. SDK gap — raise a PR
// against the SDK repo and swap this shim for the SDK export when it lands.

function pbVarint(value) {
  let n = BigInt(value);
  const bytes = [];
  do {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if (n > 0n) b |= 0x80;
    bytes.push(b);
  } while (n > 0n);
  return new Uint8Array(bytes);
}

function pbConcat(arrays) {
  const out = new Uint8Array(arrays.reduce((sum, a) => sum + a.length, 0));
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

function pbString(fieldNum, str) {
  if (!str) return new Uint8Array(0);
  const b = new TextEncoder().encode(str);
  return pbConcat([pbVarint((BigInt(fieldNum) << 3n) | 2n), pbVarint(b.length), b]);
}

function pbUint64(fieldNum, value) {
  if (!value) return new Uint8Array(0);
  return pbConcat([pbVarint((BigInt(fieldNum) << 3n) | 0n), pbVarint(value)]);
}

function pbEmbedded(fieldNum, bytes) {
  if (!bytes || bytes.length === 0) return new Uint8Array(0);
  return pbConcat([pbVarint((BigInt(fieldNum) << 3n) | 2n), pbVarint(bytes.length), bytes]);
}

// Generic proto reader: { fieldNum: [{ wireType, value }] }. Varint values are
// BigInt; length-delimited values are Uint8Array slices.
function pbDecode(buf) {
  const fields = {};
  let i = 0;
  while (i < buf.length) {
    let tag = 0n, shift = 0n;
    while (i < buf.length) {
      const b = buf[i++];
      tag |= BigInt(b & 0x7f) << shift;
      shift += 7n;
      if (!(b & 0x80)) break;
    }
    const fieldNum = Number(tag >> 3n);
    const wireType = Number(tag & 0x7n);
    if (wireType === 0) {
      let val = 0n, s = 0n;
      while (i < buf.length) {
        const b = buf[i++];
        val |= BigInt(b & 0x7f) << s;
        s += 7n;
        if (!(b & 0x80)) break;
      }
      (fields[fieldNum] ||= []).push({ wireType, value: val });
    } else if (wireType === 2) {
      let len = 0n, s = 0n;
      while (i < buf.length) {
        const b = buf[i++];
        len |= BigInt(b & 0x7f) << s;
        s += 7n;
        if (!(b & 0x80)) break;
      }
      const numLen = Number(len);
      (fields[fieldNum] ||= []).push({ wireType, value: buf.slice(i, i + numLen) });
      i += numLen;
    } else if (wireType === 5) {
      i += 4;
    } else if (wireType === 1) {
      i += 8;
    }
  }
  return fields;
}

/**
 * Query every plan owned by a provider address via RPC.
 *
 * QueryPlansForProviderRequest: 1=address, 2=status, 3=pagination. The status
 * field is omitted (= unspecified) so the chain returns active AND inactive
 * plans — discovery must surface plans the operator deactivated elsewhere.
 *
 * @param {{ queryClient: import('@cosmjs/stargate').QueryClient }} client
 * @param {string} provAddress - sentprov1... address
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<Array<{ id: string, prov_address: string, status: number }>>}
 */
export async function rpcQueryPlansForProvider(client, provAddress, { limit = 1000 } = {}) {
  const request = pbConcat([
    pbString(1, provAddress),
    pbEmbedded(3, pbUint64(3, limit)), // PageRequest{ limit } (field 3 = limit)
  ]);
  const { value } = await client.queryClient.queryAbci(
    '/sentinel.plan.v3.QueryService/QueryPlansForProvider',
    request,
  );
  const fields = pbDecode(new Uint8Array(value));
  // Response field 1 = repeated sentinel.plan.v3.Plan (1=id, 2=prov_address, 7=status)
  return (fields[1] || []).map((entry) => {
    const p = pbDecode(entry.value);
    return {
      id: p[1]?.[0] ? String(p[1][0].value) : '0',
      prov_address: p[2]?.[0] ? new TextDecoder().decode(p[2][0].value) : '',
      status: p[7]?.[0] ? Number(p[7][0].value) : 0,
    };
  });
}

// ─── Signing Client ──────────────────────────────────────────────────────────
// All signing state lives on the per-request session (lib/session.js). The
// server holds no module-level wallet — every TX must run inside an
// AsyncLocalStorage context populated by the cookie middleware.

/**
 * Get or create a signing client for the current request's session.
 * @returns {Promise<SigningStargateClient>}
 * @throws {Error} If no session is active (no cookie / no wallet)
 */
export async function getSigningClient() {
  const s = currentSession();
  if (!s) throw new Error('No wallet loaded');
  return s.getClient();
}

/**
 * Reconnect the current session's signing client (resets sequence cache).
 * @returns {Promise<SigningStargateClient>}
 */
export async function resetSigningClient() {
  const s = currentSession();
  if (!s) throw new Error('No wallet loaded');
  return s.resetClient();
}

// ─── Safe Broadcast (mutex + retry) ──────────────────────────────────────────

/**
 * Broadcast messages with sequence-mismatch retry and mutex serialization.
 * Invalidates balance cache on success.
 *
 * Each session has its own broadcastQueue so different users don't block each
 * other; the same user's concurrent broadcasts still serialize (required for
 * correct sequence numbers).
 *
 * @param {object[]} msgs - Cosmos SDK messages
 * @param {string} [memo] - Optional TX memo
 * @param {{ feeGranter?: string }} [opts] - Pass `feeGranter` to charge fees to a third party who has issued an active fee grant to the signer.
 * @returns {Promise<object>} TX result
 */
export function safeBroadcast(msgs, memo, opts) {
  const s = currentSession();
  if (!s) throw new Error('No wallet loaded');
  const p = s.broadcastQueue.then(() => _safeBroadcastInner(msgs, memo, opts));
  s.broadcastQueue = p.catch(() => {});
  return p;
}

// ─── Broadcast Pre-Signed TX (Keplr return path) ─────────────────────────────
// The browser sends back a fully-signed TxRaw (base64). Broadcast it via the
// existing RPC failover; we don't need a SigningStargateClient because the
// signature is already present.
export async function broadcastSignedTx(txBytesB64) {
  const c = await getRpcClient();
  if (!c) throw new Error('No RPC client for broadcast');
  const txBytes = fromBase64(txBytesB64);
  const result = await c.tmClient.broadcastTxSync({ tx: txBytes });
  if (result.code !== 0) {
    return {
      code: result.code,
      transactionHash: Buffer.from(result.hash).toString('hex').toUpperCase(),
      rawLog: result.log || result.codespace || 'broadcast failed',
    };
  }
  // Wait for inclusion via tx_search-by-hash polling. Cap at ~12s (typical 6s block).
  const hashHex = Buffer.from(result.hash).toString('hex').toUpperCase();
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const tx = await c.tmClient.tx({ hash: result.hash });
      if (tx) {
        return {
          code: tx.result.code ?? 0,
          transactionHash: hashHex,
          height: Number(tx.height),
          gasUsed: String(tx.result.gasUsed ?? ''),
          gasWanted: String(tx.result.gasWanted ?? ''),
          rawLog: tx.result.log || '',
        };
      }
    } catch { /* not yet indexed */ }
  }
  return { code: 0, transactionHash: hashHex, rawLog: 'pending', pending: true };
}

// ─── Keplr (client-signs) Branching ──────────────────────────────────────────
// Exception thrown when the active session is a Keplr session: the browser
// must build the signature, so we package every input the browser needs into
// the error. Express route catches detect `err.code === 'KEPLR_SIGN_REQUIRED'`
// and forward the embedded payload as `{ mode: 'keplr-sign', signDoc }`.
export class KeplrSignRequiredError extends Error {
  constructor(signDoc) {
    super('KEPLR_SIGN_REQUIRED');
    this.code = 'KEPLR_SIGN_REQUIRED';
    this.signDoc = signDoc;
  }
}

// Build the unsigned SignDoc payload (Direct/proto sign mode) the browser
// needs to call window.keplr.signDirect with. Returns base64 byte strings so
// the JSON survives the wire intact.
async function buildKeplrSignDoc(session, msgs, memo) {
  const registry = createRegistry();

  // Encode the message bodies. Registry.encode wraps each in Any.
  const anyMsgs = msgs.map((m) => registry.encodeAsAny(m));
  const bodyBytes = TxBody.encode(
    TxBody.fromPartial({ messages: anyMsgs, memo: memo || '' }),
  ).finish();

  // Account lookup must use a SigningStargateClient-like call. We don't have
  // a wallet for Keplr sessions, so use a read-only StargateClient from the
  // RPC failover candidates.
  const accountInfo = await fetchAccountInfo(session.addr);
  if (!accountInfo) {
    throw new Error(`Keplr account not found on chain: ${session.addr}`);
  }
  const { accountNumber, sequence } = accountInfo;

  if (!session.pubkeyB64) {
    throw new Error('Keplr session missing pubkey — re-login required');
  }
  const pubkey = encodePubkey({ type: 'tendermint/PubKeySecp256k1', value: session.pubkeyB64 });

  // Conservative gas estimate. signDirect requires a fixed fee/gas before
  // signing — we can't simulate without a signer. 250k gas covers a Send /
  // Subscribe; batch routes can override via the Keplr session-specific path
  // later. GAS_PRICE_STR is "0.1udvpn".
  const gasLimit = estimateGasFor(msgs);
  const fee = calculateFee(gasLimit, GasPrice.fromString(GAS_PRICE_STR));

  const authInfoBytes = makeAuthInfoBytes(
    [{ pubkey, sequence: Int53.fromString(String(sequence)).toNumber() }],
    fee.amount,
    Int53.fromString(String(fee.gas)).toNumber(),
    undefined,
    undefined,
  );

  return {
    chainId: CHAIN_ID,
    accountNumber: String(accountNumber),
    bodyBytes: toBase64(bodyBytes),
    authInfoBytes: toBase64(authInfoBytes),
    // Hint for the browser-side bundler so it can show meaningful UI.
    msgTypes: msgs.map((m) => m.typeUrl),
  };
}

/**
 * Build the StdFee passed to signAndBroadcast.
 *
 * Without `feeGranter` we return the string 'auto' so cosmjs handles its
 * standard simulate → multiplier → calculateFee path (identical to the
 * pre-feegrant behavior, no regression).
 *
 * With `feeGranter` we have to build the fee ourselves: there is no way to
 * pass `granter` through the 'auto' path. We simulate, apply the same 1.4×
 * multiplier cosmjs uses, then build a StdFee with `granter` set so the chain
 * charges the grantor's account instead of the signer's.
 */
async function _resolveFee(client, addr, msgs, memo, feeGranter) {
  if (!feeGranter) return 'auto';
  const gasUsed = await client.simulate(addr, msgs, memo);
  const gasLimit = Math.ceil(gasUsed * 1.4);
  const fee = calculateFee(gasLimit, GasPrice.fromString(GAS_PRICE_STR));
  return { ...fee, granter: feeGranter };
}

function estimateGasFor(msgs) {
  // Per-message gas budget. Sentinel TXs are small but lease/link/subscribe
  // do non-trivial state. 200k base + 80k per message handles batches up to
  // ~20 messages within the 5M cap a public RPC will accept.
  const base = 200_000;
  const perMsg = 80_000;
  return base + perMsg * msgs.length;
}

async function fetchAccountInfo(addr) {
  // The SDK's RPC client builds QueryClient.withExtensions(tmClient) with NO
  // extensions, so `c.queryClient.auth` does not exist (SDK ≥2.7 issues raw
  // protobuf requests instead). Compose the auth extension locally over the
  // shared Tendermint client — pure object setup, no extra connection.
  const c = await getRpcClient();
  if (!c) throw new Error('No RPC client for account lookup');
  let anyAcc;
  try {
    const authQuery = QueryClient.withExtensions(c.tmClient, setupAuthExtension);
    anyAcc = await authQuery.auth.account(addr);
  } catch (err) {
    // Chain reports unknown addresses as a NotFound query error, not null.
    if (/not found|NotFound|key not found/i.test(err.message)) return null;
    throw err;
  }
  if (!anyAcc) return null;
  const acc = accountFromAny(anyAcc);
  return { accountNumber: Number(acc.accountNumber), sequence: Number(acc.sequence) };
}

async function _safeBroadcastInner(msgs, memo, opts) {
  const session = currentSession();
  if (!session) throw new Error('No wallet loaded');

  // Keplr/Privy branch: short-circuit before getSigningClient — the server
  // holds no privkey for either kind. The route relays the signDoc to the
  // browser, which signs it via the Keplr extension (signDirect →
  // /api/tx/broadcast-signed) or via Privy's enclave
  // (/api/tx/privy-sign-and-broadcast). Privy previously fell through to
  // getClient() and surfaced as a 500 {"error":"client-signs"}.
  if (session.kind === 'keplr' || session.kind === 'privy') {
    const signDoc = await buildKeplrSignDoc(session, msgs, memo);
    console.log(`[TX] ${session.kind} sign requested for ${session.addr} — ${msgs.length} msg(s)`);
    throw new KeplrSignRequiredError(signDoc);
  }

  const addr = getAddr();
  const typeUrls = msgs.map(m => m.typeUrl.split('.').pop()).join(', ');
  const feeGranter = opts && opts.feeGranter;
  if (feeGranter) {
    console.log(`\n[TX] Broadcasting: ${typeUrls} (fee paid by grant from ${feeGranter})`);
  } else {
    console.log(`\n[TX] Broadcasting: ${typeUrls}`);
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    let client;
    if (attempt === 0) {
      client = await getSigningClient();
    } else {
      const delay = Math.min(2000 * attempt, 6000);
      console.log(`[TX]   Waiting ${delay}ms before retry...`);
      await new Promise(r => setTimeout(r, delay));
      client = await resetSigningClient();
    }

    let chainSeq = '?';
    try {
      const acc = await client.getAccount(addr);
      chainSeq = acc?.sequence ?? '?';
      console.log(`[TX]   Attempt ${attempt + 1}/5 — chain sequence: ${chainSeq}`);
    } catch (e) {
      const cause = e.cause ? ` | cause: ${e.cause.message || e.cause}` : '';
      console.log(`[TX]   Attempt ${attempt + 1}/5 — could not fetch sequence: ${e.message}${cause}`);
    }

    try {
      const fee = await _resolveFee(client, addr, msgs, memo, feeGranter);
      const result = await client.signAndBroadcast(addr, msgs, fee, memo);
      console.log(`[TX]   Result: code=${result.code}, txHash=${result.transactionHash}`);

      if (result.code !== 0) {
        const raw = result.rawLog || '';
        console.log(`[TX]   rawLog: ${raw.slice(0, 200)}`);
        if (isSequenceError(raw)) {
          console.log(`[TX]   Sequence mismatch — expected ${extractExpectedSeq(raw)}. Retrying...`);
          continue;
        }
      }
      if (result.code === 0 && addr) {
        cacheInvalidate(`balance:${addr}`);
        // When a third-party paid via fee grant, the grantor's balance also changed.
        if (feeGranter) cacheInvalidate(`balance:${feeGranter}`);
      }
      return result;
    } catch (err) {
      const msg = err.message || '';
      const cause = err.cause ? ` | cause: ${err.cause.message || err.cause}` : '';
      console.log(`[TX]   Error: ${msg.slice(0, 300)}${cause}`);
      if (err.stack) console.log(`[TX]   Stack: ${err.stack.split('\n').slice(0, 4).join(' <- ')}`);

      if (isSequenceError(msg)) {
        console.log(`[TX]   Sequence mismatch (thrown) — expected ${extractExpectedSeq(msg)}. Retrying...`);
        continue;
      }
      if (msg.includes('fetch failed') || msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT') || msg.includes('socket hang up')) {
        console.log(`[TX]   Network error — will retry (attempt ${attempt + 1}/5)`);
        continue;
      }
      throw err;
    }
  }

  // Final attempt
  console.log(`[TX]   All retries exhausted — final attempt with fresh client`);
  await new Promise(r => setTimeout(r, 4000));
  const client = await resetSigningClient();
  const fee = await _resolveFee(client, addr, msgs, memo, feeGranter);
  const result = await client.signAndBroadcast(addr, msgs, fee, memo);
  console.log(`[TX]   Final result: code=${result.code}, txHash=${result.transactionHash}`);
  if (result.code === 0 && addr) {
    cacheInvalidate(`balance:${addr}`);
    if (feeGranter) cacheInvalidate(`balance:${feeGranter}`);
  }
  return result;
}
