// ─── Per-User Session ────────────────────────────────────────────────────────
// Multi-user support: the mnemonic rides in an httpOnly AES-256-GCM
// encrypted cookie. Each request derives its wallet from the cookie and
// threads it through the call stack via AsyncLocalStorage, so existing
// helpers like getAddr() / getSigningClient() resolve to the per-request
// wallet without explicit plumbing.

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import { fromBech32, toBech32 } from '@cosmjs/encoding';
import { SigningStargateClient, GasPrice } from '@cosmjs/stargate';
import { RPC, GAS_PRICE_STR } from './constants.js';
import { createRegistry } from './protobuf.js';

export const COOKIE_NAME = 'spm_sess';
const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const CACHE_MAX = 100;
// 7 days — cookie Max-Age; re-login prompted after expiry.
export const COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 7;

const als = new AsyncLocalStorage();
let _key = null;
let _multiUser = false;

/**
 * Initialize the session subsystem. Called once on boot.
 * Resolves the encryption key in order:
 *   1. SESSION_KEY env var (64-char hex)
 *   2. <dataDir>/.session-key (generated on first boot)
 *   3. Fresh random key (in-memory only; sessions invalidate on restart)
 */
export function initSession(dataDir) {
  _multiUser = process.env.MULTI_USER === 'true' || process.env.MULTI_USER === '1';

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
    console.log(`[session] Generated session key: ${keyFile}`);
  } catch (err) {
    console.warn('[session] Could not persist session key — sessions will invalidate on restart:', err.message);
  }
}

export function isMultiUser() { return _multiUser; }

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
    broadcastQueue: Promise.resolve(),
    async getClient() {
      if (this._client) return this._client;
      if (!this._registry) this._registry = createRegistry();
      this._client = await SigningStargateClient.connectWithSigner(RPC, this.wallet, {
        registry: this._registry,
        gasPrice: GasPrice.fromString(GAS_PRICE_STR),
      });
      return this._client;
    },
    async resetClient() {
      if (!this._registry) this._registry = createRegistry();
      this._client = await SigningStargateClient.connectWithSigner(RPC, this.wallet, {
        registry: this._registry,
        gasPrice: GasPrice.fromString(GAS_PRICE_STR),
      });
      return this._client;
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
  const attrs = [
    `${COOKIE_NAME}=${token}`,
    'HttpOnly',
    'SameSite=Lax',
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
    'SameSite=Lax',
    'Path=/',
    'Max-Age=0',
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}
