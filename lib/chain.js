// ─── Chain Interaction ────────────────────────────────────────────────────────
// LCD queries, signing client management, TX broadcast with retry.
// RPC queries via SDK for ~912x faster lookups (LCD as fallback).

import { SigningStargateClient, GasPrice } from '@cosmjs/stargate';
import { LCD_ENDPOINTS, RPC, GAS_PRICE_STR } from './constants.js';
// Re-export SDK's getDvpnPrice (same CoinGecko implementation, avoids duplication)
import { getDvpnPrice as _sdkGetDvpnPrice } from '../../Sentinel SDK/js-sdk/cosmjs-setup.js';
// SDK RPC query functions — protobuf transport, ~912x faster than LCD REST
import {
  createRpcQueryClient,
  rpcQueryNode,
  rpcQueryNodes,
  rpcQueryNodesForPlan,
} from '../../Sentinel SDK/js-sdk/chain/rpc.js';
import { createRegistry } from './protobuf.js';
import { isSequenceError, extractExpectedSeq } from './errors.js';
import { cacheInvalidate } from './cache.js';
import { getAddr } from './wallet.js';

// ─── LCD Fetch with Failover ─────────────────────────────────────────────────

/**
 * Query an LCD endpoint with automatic failover across multiple providers.
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
      const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) { lastErr = new Error(`LCD ${base}${path}: ${res.status}`); continue; }
      const data = await res.json();
      if (data.code && data.code !== 0) { lastErr = new Error(`LCD ${path}: code=${data.code} ${data.message || ''}`); continue; }
      return data;
    } catch (e) {
      lastErr = e;
      console.log(`[LCD] ${base}${path} failed: ${e.message} — trying next`);
    }
  }
  throw lastErr;
}

// ─── P2P Price (delegated to SDK — same CoinGecko implementation) ────────────
export const getDvpnPrice = _sdkGetDvpnPrice;

// ─── RPC Query Client (cached, lazy-init) ───────────────────────────────────

let _rpcClient = null;

/**
 * Get or create a cached RPC query client for fast protobuf-based queries.
 * Uses the SDK's createRpcQueryClient with the RPC endpoint from constants.
 * Falls back gracefully — callers should catch errors and use LCD.
 *
 * @returns {Promise<{ queryClient: import('@cosmjs/stargate').QueryClient, rpc: object, tmClient: object }>}
 */
export async function getRpcClient() {
  if (_rpcClient) return _rpcClient;
  _rpcClient = await createRpcQueryClient(RPC);
  console.log('[RPC] Query client connected');
  return _rpcClient;
}

// Re-export SDK RPC query functions so server.js can import from chain.js
export { rpcQueryNode, rpcQueryNodes, rpcQueryNodesForPlan };

// ─── Signing Client ──────────────────────────────────────────────────────────

let _client = null;
let _wallet = null;
let _registry = null;

/** @returns {import('@cosmjs/proto-signing').DirectSecp256k1HdWallet|null} */
export function getWalletInstance() { return _wallet; }

export function setWalletInstance(w) { _wallet = w; _client = null; _registry = null; }

export function clearClient() { _client = null; }

/**
 * Get or create a signing client (lazy, cached).
 * @returns {Promise<SigningStargateClient>}
 * @throws {Error} If no wallet loaded
 */
export async function getSigningClient() {
  if (!_wallet) throw new Error('No wallet loaded');
  if (_client) return _client;
  if (!_registry) _registry = createRegistry();
  _client = await SigningStargateClient.connectWithSigner(RPC, _wallet, {
    registry: _registry,
    gasPrice: GasPrice.fromString(GAS_PRICE_STR),
  });
  console.log('Signing client connected');
  return _client;
}

/**
 * Reconnect the signing client (resets sequence cache).
 * @returns {Promise<SigningStargateClient>}
 */
export async function resetSigningClient() {
  if (!_registry) _registry = createRegistry();
  _client = await SigningStargateClient.connectWithSigner(RPC, _wallet, {
    registry: _registry,
    gasPrice: GasPrice.fromString(GAS_PRICE_STR),
  });
  console.log('Signing client reconnected (sequence reset)');
  return _client;
}

// ─── Safe Broadcast (mutex + retry) ──────────────────────────────────────────

let _broadcastQueue = Promise.resolve();

/**
 * Broadcast messages with sequence-mismatch retry and mutex serialization.
 * Invalidates balance cache on success.
 *
 * @param {object[]} msgs - Cosmos SDK messages
 * @param {string} [memo] - Optional TX memo
 * @returns {Promise<object>} TX result
 */
export function safeBroadcast(msgs, memo) {
  const p = _broadcastQueue.then(() => _safeBroadcastInner(msgs, memo));
  _broadcastQueue = p.catch(() => {});
  return p;
}

async function _safeBroadcastInner(msgs, memo) {
  const addr = getAddr();
  const typeUrls = msgs.map(m => m.typeUrl.split('.').pop()).join(', ');
  console.log(`\n[TX] Broadcasting: ${typeUrls}`);

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
      const result = await client.signAndBroadcast(addr, msgs, 'auto', memo);
      console.log(`[TX]   Result: code=${result.code}, txHash=${result.transactionHash}`);

      if (result.code !== 0) {
        const raw = result.rawLog || '';
        console.log(`[TX]   rawLog: ${raw.slice(0, 200)}`);
        if (isSequenceError(raw)) {
          console.log(`[TX]   Sequence mismatch — expected ${extractExpectedSeq(raw)}. Retrying...`);
          continue;
        }
      }
      if (result.code === 0 && addr) cacheInvalidate(`balance:${addr}`);
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
  const result = await client.signAndBroadcast(addr, msgs, 'auto', memo);
  console.log(`[TX]   Final result: code=${result.code}, txHash=${result.transactionHash}`);
  if (result.code === 0 && addr) cacheInvalidate(`balance:${addr}`);
  return result;
}
