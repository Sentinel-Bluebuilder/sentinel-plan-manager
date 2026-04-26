// ─── Per-User Session ────────────────────────────────────────────────────────
// Multi-user support: the mnemonic rides in an httpOnly AES-256-GCM
// encrypted cookie. Each request derives its wallet from the cookie and
// threads it through the call stack via AsyncLocalStorage, so existing
// helpers like getAddr() / getSigningClient() resolve to the per-request
// wallet without explicit plumbing.

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import { fromBech32, toBech32 } from '@cosmjs/encoding';
import { SigningStargateClient, GasPrice } from '@cosmjs/stargate';
import { RPC, GAS_PRICE_STR, SIGNING_RPC_URLS, SIGNING_RPC_CONNECT_TIMEOUT_MS, RPC_PROVIDERS } from './constants.js';
import { createRegistry } from './protobuf.js';

// ─── Signing RPC Failover ────────────────────────────────────────────────────
// Connect with timeout — CosmJS's connectWithSigner has no native timeout and
// will hang on a dead endpoint until the OS gives up. We race it against a
// timer so a stuck endpoint costs SIGNING_RPC_CONNECT_TIMEOUT_MS, not minutes.
async function connectWithTimeout(url, wallet, opts) {
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`connect timeout: ${url}`)), SIGNING_RPC_CONNECT_TIMEOUT_MS);
  });
  try {
    const client = await Promise.race([
      SigningStargateClient.connectWithSigner(url, wallet, opts),
      timeout,
    ]);
    return client;
  } finally {
    clearTimeout(timer);
  }
}

// Build the candidate URL list. preferred (last-known-good) first, then the
// curated SIGNING_RPC_URLS, then the rest of RPC_PROVIDERS as last resort.
function rpcCandidates(preferred) {
  const seen = new Set();
  const out = [];
  const add = (u) => {
    if (!u) return;
    const norm = u.replace(/\/+$/, '');
    if (seen.has(norm)) return;
    seen.add(norm); out.push(norm);
  };
  add(preferred);
  for (const u of SIGNING_RPC_URLS) add(u);
  // RPC_PROVIDERS entries omit ':443' — append it so CometBFT websocket connects.
  for (const u of RPC_PROVIDERS) add(/:\d+$/.test(u) ? u : `${u}:443`);
  add(RPC);
  return out;
}

async function connectFailover(wallet, opts, preferredUrl) {
  const errors = [];
  for (const url of rpcCandidates(preferredUrl)) {
    try {
      const client = await connectWithTimeout(url, wallet, opts);
      console.log(`[session] signing client connected: ${url}`);
      return { client, url };
    } catch (err) {
      errors.push(`${url}: ${err.message}`);
    }
  }
  throw new Error(`All signing RPC endpoints failed:\n  ${errors.join('\n  ')}`);
}

export const COOKIE_NAME = 'spm_sess';
const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const CACHE_MAX = 100;
// 7 days — cookie Max-Age; re-login prompted after expiry.
export const COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 7;

const als = new AsyncLocalStorage();
let _key = null;

/**
 * Initialize the session subsystem. Called once on boot.
 * Resolves the encryption key in order:
 *   1. SESSION_KEY env var (64-char hex)
 *   2. <dataDir>/.session-key (generated on first boot)
 *   3. Fresh random key (in-memory only; sessions invalidate on restart)
 */
export function initSession(dataDir) {
  if (process.env.SESSION_KEY) {
    const buf = Buffer.from(process.env.SESSION_KEY, 'hex');
    if (buf.length === 32) { _key = buf; console.log('[session] Using SESSION_KEY from env'); return; }
    console.warn('[session] SESSION_KEY must be 32-byte hex (64 chars) — falling back to generated key');
  }

  const keyFile = join(dataDir, '.session-key');
  try {
    if (existsSync(keyFile)) {
      const hex = readFileSync(keyFile, 'utf8').trim();
      const buf = Buffer.from(hex, 'hex');
      if (buf.length === 32) { _key = buf; console.log(`[session] Loaded session key: ${keyFile}`); return; }
    }
  } catch (err) {
    console.warn('[session] Failed to read session key file:', err.message);
  }

  _key = randomBytes(32);
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(keyFile, _key.toString('hex'), { encoding: 'utf8', mode: 0o600 });
    try { chmodSync(keyFile, 0o600); } catch {} // enforce on Linux/macOS; no-op on Windows
    console.log(`[session] Generated session key: ${keyFile}`);
  } catch (err) {
    console.warn('[session] Could not persist session key — sessions will invalidate on restart:', err.message);
  }
}

// Cookie-mode is unconditional; this stays exported so callers/UI that probe
// the mode keep working without a refactor.
export function isMultiUser() { return true; }

// ─── Cookie Crypto ───────────────────────────────────────────────────────────

/** Encrypt a mnemonic for cookie storage. Returns base64url(iv || tag || ct). */
export function encryptMnemonic(mnemonic) {
  if (!_key) throw new Error('Session key not initialized');
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, _key, iv);
  const ct = Buffer.concat([cipher.update(mnemonic, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64url');
}

/** Decrypt a cookie value back into a mnemonic. Throws on tamper/bad key. */
export function decryptMnemonic(token) {
  if (!_key) throw new Error('Session key not initialized');
  const buf = Buffer.from(token, 'base64url');
  if (buf.length < IV_LEN + TAG_LEN + 1) throw new Error('Session cookie too short');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, _key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// ─── Wallet Cache (LRU by mnemonic hash) ─────────────────────────────────────
// DirectSecp256k1HdWallet.fromMnemonic is slow (PBKDF2 w/ 2048 iterations) and
// SigningStargateClient.connectWithSigner does an RPC handshake, so we cache
// both per mnemonic. Keyed by SHA-256 so the raw mnemonic never sits in a Map
// key.

const cache = new Map();

function hashMnemonic(m) {
  return createHash('sha256').update(m.trim()).digest('hex');
}

/**
 * Derive a session object from a mnemonic, caching the wallet + signing
 * client. Returns { addr, provAddr, wallet, getClient(), resetClient(),
 * broadcastQueue }.
 */
export async function sessionFromMnemonic(mnemonic) {
  const key = hashMnemonic(mnemonic);
  let session = cache.get(key);
  if (session) {
    // LRU refresh
    cache.delete(key); cache.set(key, session);
    return session;
  }

  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic.trim(), { prefix: 'sent' });
  const [acc] = await wallet.getAccounts();
  const addr = acc.address;
  const { data } = fromBech32(addr);
  const provAddr = toBech32('sentprov', data);

  session = {
    addr,
    provAddr,
    wallet,
    _client: null,
    _registry: null,
    _rpcUrl: null,
    broadcastQueue: Promise.resolve(),
    async getClient() {
      if (this._client) return this._client;
      if (!this._registry) this._registry = createRegistry();
      const opts = {
        registry: this._registry,
        gasPrice: GasPrice.fromString(GAS_PRICE_STR),
      };
      const { client, url } = await connectFailover(this.wallet, opts, this._rpcUrl);
      this._client = client;
      this._rpcUrl = url;
      return client;
    },
    async resetClient() {
      if (!this._registry) this._registry = createRegistry();
      // Drop the previous URL from the head of the candidate list so we don't
      // immediately reconnect to whatever just failed.
      try { this._client?.disconnect?.(); } catch {}
      const failed = this._rpcUrl;
      this._client = null;
      this._rpcUrl = null;
      const opts = {
        registry: this._registry,
        gasPrice: GasPrice.fromString(GAS_PRICE_STR),
      };
      const candidates = rpcCandidates(null).filter((u) => u !== failed);
      const errors = [];
      for (const url of candidates) {
        try {
          const client = await connectWithTimeout(url, this.wallet, opts);
          console.log(`[session] signing client reconnected: ${url}`);
          this._client = client;
          this._rpcUrl = url;
          return client;
        } catch (err) {
          errors.push(`${url}: ${err.message}`);
        }
      }
      throw new Error(`All signing RPC endpoints failed on reset:\n  ${errors.join('\n  ')}`);
    },
  };

  while (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(key, session);
  return session;
}

// ─── AsyncLocalStorage ───────────────────────────────────────────────────────

export function runWithSession(session, fn) {
  return als.run(session, fn);
}

/** Current request's session, or null if this request runs in legacy/bootstrap mode. */
export function currentSession() {
  return als.getStore() ?? null;
}

// ─── Cookie Parsing Helpers ──────────────────────────────────────────────────

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (name) out[name] = decodeURIComponent(val);
  }
  return out;
}

export function buildSetCookie(token, { secure }) {
  // SameSite=Strict — the cookie carries a derived-key authenticator, never a
  //   third-party bearer token. Strict blocks cross-site GETs that Lax allows
  //   (top-level nav from an attacker page). All login flows are same-origin.
  // __Host- prefix would force Secure+Path=/ implicitly but requires HTTPS,
  //   which we don't have on plain localhost. Use Secure when available.
  const attrs = [
    `${COOKIE_NAME}=${token}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${COOKIE_MAX_AGE_SEC}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function buildClearCookie({ secure }) {
  const attrs = [
    `${COOKIE_NAME}=`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    'Max-Age=0',
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

/**
 * Drop a session from the wallet/client cache. Called on logout so a stolen
 * cookie value (with the same mnemonic) can't continue to resolve to the
 * pre-derived wallet for the rest of the LRU window.
 */
export function dropSessionFromCache(mnemonic) {
  try {
    const key = hashMnemonic(mnemonic);
    cache.delete(key);
  } catch {}
}
