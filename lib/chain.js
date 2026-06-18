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
  rpcQueryNodesForPlan as _sdkRpcQueryNodesForPlan,
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
  const attempt = createRpcQueryClientWithFallback()
    .then(client => {
      console.log(`[RPC] Query client connected via ${client.url}`);
      return client;
    })
    .catch(err => {
      console.log(`[RPC] All endpoints failed: ${err.message} — will use LCD`);
      // Only clear the cache if THIS attempt is still the cached one, so a
      // concurrent caller that already replaced the promise isn't nulled out.
      if (_rpcClientPromise === attempt) _rpcClientPromise = null; // allow retry on next call
      return null;
    });
  _rpcClientPromise = attempt;
  return _rpcClientPromise;
}

export function resetRpcClient() {
  _rpcClientPromise = null;
  try {
    disconnectRpc();
  } catch (e) {
    console.warn(`[RPC] disconnectRpc during reset failed: ${e.message}`);
  }
}

// Re-export SDK RPC query helpers so server.js can import from chain.js
export {
  rpcQueryNode,
  rpcQueryNodes,
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

// ─── Nodes-for-Plan Query (local SDK-gap shim) ───────────────────────────────
// blue-js-sdk's rpcQueryNodesForPlan works, but its private `decodeNode` decodes
// only fields 1,2,3,4,6 (address, gigabyte_prices, hourly_prices, remote_addrs,
// status) and DROPS the two timestamp fields. The Plan Manager "Your Nodes" view
// needs the lease expiry, which lives in the node's `inactive_at`. v3 Node proto:
//   1=address, 2=gigabyte_prices, 3=hourly_prices, 4=remote_addrs,
//   5=inactive_at (Timestamp), 6=status (enum), 7=status_at (Timestamp).
// This shim re-decodes the same QueryNodesForPlan response and surfaces fields
// 5 and 7. SDK gap — raise a PR against the SDK so decodeNode keeps the
// timestamps, then swap this shim for the SDK export.

/** Decode an embedded google.protobuf.Timestamp (1=seconds, 2=nanos) → ISO string. */
function pbTimestamp(bytes) {
  if (!bytes || bytes.length === 0) return null;
  const f = pbDecode(bytes);
  const seconds = f[1]?.[0] ? Number(f[1][0].value) : 0;
  const nanos = f[2]?.[0] ? Number(f[2][0].value) : 0;
  if (!seconds && !nanos) return null;
  return new Date(seconds * 1000 + nanos / 1_000_000).toISOString();
}

function pbDecodePrice(bytes) {
  const f = pbDecode(bytes);
  const str = (n) => (f[n]?.[0] ? new TextDecoder().decode(f[n][0].value) : '');
  return { denom: str(1), base_value: str(2) || '0', quote_value: str(3) || '0' };
}

/**
 * Query nodes linked to a plan via RPC, preserving the lease timestamps the SDK
 * drops. Same request shape as the SDK helper (1=id, 2=status, 3=pagination).
 *
 * @param {{ queryClient: import('@cosmjs/stargate').QueryClient }} client
 * @param {number|bigint} planId
 * @param {{ status?: number, limit?: number }} [opts]
 * @returns {Promise<Array<{ address: string, gigabyte_prices: object[], hourly_prices: object[], remote_addrs: string[], status: number, inactive_at: string|null, status_at: string|null }>>}
 */
export async function rpcQueryNodesForPlan(client, planId, { status = 1, limit = 10000 } = {}) {
  const request = pbConcat([
    pbUint64(1, planId),                 // id
    status ? pbUint64(2, status) : new Uint8Array(0), // status enum (0 = unspecified → omit)
    pbEmbedded(3, pbUint64(3, limit)),   // PageRequest{ limit }
  ]);
  const { value } = await client.queryClient.queryAbci(
    '/sentinel.node.v3.QueryService/QueryNodesForPlan',
    request,
  );
  const fields = pbDecode(new Uint8Array(value));
  // Response field 1 = repeated sentinel.node.v3.Node
  return (fields[1] || []).map((entry) => {
    const n = pbDecode(entry.value);
    return {
      address: n[1]?.[0] ? new TextDecoder().decode(n[1][0].value) : '',
      gigabyte_prices: (n[2] || []).map((e) => pbDecodePrice(e.value)),
      hourly_prices: (n[3] || []).map((e) => pbDecodePrice(e.value)),
      remote_addrs: (n[4] || []).map((e) => new TextDecoder().decode(e.value)),
      inactive_at: n[5]?.[0] ? pbTimestamp(n[5][0].value) : null,
      status: n[6]?.[0] ? Number(n[6][0].value) : 0,
      status_at: n[7]?.[0] ? pbTimestamp(n[7][0].value) : null,
    };
  });
}

// ─── Leases-for-Node Query (local SDK-gap shim) ──────────────────────────────
// The SDK exposes MsgStartLease (write) but no lease *query*. The Plan Manager
// "Your Nodes" view needs the real lease expiry — NOT the node's `inactive_at`,
// which is the node's own ~1h liveness/status window and has nothing to do with
// how long the operator leased the node for. The actual lease lives in the
// sentinel.lease.v1 module. v1 Lease proto (CONFIRMED on-chain 2026-06-17):
//   1=id, 2=prov_address, 3=node_address, 4=price,
//   5=inactive_hours (counter — NOT the lease length), 6=hours (DURATION),
//   7=renewal_price_policy, 8=start_at (Timestamp).
// Expiry = start_at + field6. There is no stored expiry timestamp on the lease.
// SDK gap — raise a PR adding a lease query, then swap this shim for the export.

/**
 * Query every lease bound to a node via RPC and compute each lease's expiry
 * (start_at + hours). A node can carry leases from multiple providers; callers
 * filter by prov_address to find their own.
 *
 * @param {{ queryClient: import('@cosmjs/stargate').QueryClient }} client
 * @param {string} nodeAddress
 * @returns {Promise<Array<{ id: string, prov_address: string, node_address: string, hours: number, max_hours: number, start_at: string|null, expires_at: string|null }>>}
 */
export async function rpcQueryLeasesForNode(client, nodeAddress) {
  if (!nodeAddress) return [];
  // Request: field 1 = node_address (string). Pagination omitted → chain default.
  const request = pbString(1, nodeAddress);
  const { value } = await client.queryClient.queryAbci(
    '/sentinel.lease.v1.QueryService/QueryLeasesForNode',
    request,
  );
  const fields = pbDecode(new Uint8Array(value));
  // Response field 1 = repeated sentinel.lease.v1.Lease
  return (fields[1] || []).map(decodeLease);
}

// Decode one sentinel.lease.v1.Lease. CONFIRMED on-chain field layout (probed
// 2026-06-17): 1=id, 2=prov_address, 3=node_address, 4=price,
//   5=inactive_hours (elapsed/inactivity counter — NOT the lease length),
//   6=hours (the operator-chosen lease DURATION),
//   7=renewal_price_policy, 8=start_at (Timestamp).
// Expiry = start_at + field 6. Earlier code read the duration from field 5,
// which is why every lease showed ~1h regardless of the chosen length.
function decodeLease(entry) {
  const l = pbDecode(entry.value);
  const hours = l[6]?.[0] ? Number(l[6][0].value) : 0;
  const startAt = l[8]?.[0] ? pbTimestamp(l[8][0].value) : null;
  const expiresAt = startAt && hours
    ? new Date(new Date(startAt).getTime() + hours * 3_600_000).toISOString()
    : null;
  return {
    id: l[1]?.[0] ? String(l[1][0].value) : '0',
    prov_address: l[2]?.[0] ? new TextDecoder().decode(l[2][0].value) : '',
    node_address: l[3]?.[0] ? new TextDecoder().decode(l[3][0].value) : '',
    hours,
    max_hours: hours,
    inactive_hours: l[5]?.[0] ? Number(l[5][0].value) : 0,
    start_at: startAt,
    expires_at: expiresAt,
  };
}

/**
 * Query every lease held by a provider via RPC, in ONE call. Used by the Add
 * Nodes browser to hide nodes we already lease — probing per-node across the
 * whole network would be far too slow, but the provider holds at most a few
 * hundred leases, so a single QueryLeasesForProvider is cheap.
 *
 * Same v1 Lease proto and expiry math as rpcQueryLeasesForNode.
 * QueryLeasesForProviderRequest: 1=address, 2=pagination.
 *
 * @param {{ queryClient: import('@cosmjs/stargate').QueryClient }} client
 * @param {string} provAddress - sentprov1... address
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<Array<{ id: string, prov_address: string, node_address: string, hours: number, max_hours: number, start_at: string|null, expires_at: string|null }>>}
 */
export async function rpcQueryLeasesForProvider(client, provAddress, { limit = 5000 } = {}) {
  if (!provAddress) return [];
  const request = pbConcat([
    pbString(1, provAddress),
    pbEmbedded(2, pbUint64(3, limit)), // PageRequest{ limit } (field 3 = limit)
  ]);
  const { value } = await client.queryClient.queryAbci(
    '/sentinel.lease.v1.QueryService/QueryLeasesForProvider',
    request,
  );
  const fields = pbDecode(new Uint8Array(value));
  return (fields[1] || []).map(decodeLease);
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
          // Surface the result events so callers (e.g. /api/tx/broadcast-signed)
          // can extract plan_id / subscription_id exactly like the inline
          // safeBroadcast path does — without these, a Keplr-signed create
          // returns no planId and the follow-up activation can't be addressed.
          events: tx.result.events || undefined,
        };
      }
    } catch (e) {
      // A "not found" / "tx not indexed" error is the normal pre-inclusion
      // state — keep polling. Anything else (RPC down, malformed response) is a
      // real fault: log it so a false `pending:true` is traceable.
      if (!/not found|NotFound|not indexed|tx \(.*\) not found/i.test(e.message || '')) {
        console.warn(`[TX] broadcast-signed poll error for ${hashHex}: ${e.message}`);
      }
    }
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
  // Surface a final sequence mismatch explicitly instead of returning a code!=0
  // result that callers might misread — the loop above ate every retry, so this
  // is terminal, but the log makes the cause unambiguous.
  if (result.code !== 0 && isSequenceError(result.rawLog || '')) {
    console.log(`[TX]   Final attempt still a sequence mismatch — expected ${extractExpectedSeq(result.rawLog || '')}`);
  }
  if (result.code === 0 && addr) {
    cacheInvalidate(`balance:${addr}`);
    if (feeGranter) cacheInvalidate(`balance:${feeGranter}`);
  }
  return result;
}
