// ─── Wallet Management ───────────────────────────────────────────────────────
// In-memory mnemonic (SDK security pattern), address-only persistence.

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import { fromBech32, toBech32 } from '@cosmjs/encoding';
import { setWalletInstance, clearClient } from './chain.js';
import { cacheClear } from './cache.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// DATA_DIR lets deployments (Docker, etc.) redirect state files to a mounted
// volume. Defaults to the project root — unchanged for local installs.
const DATA_DIR = process.env.DATA_DIR || join(__dirname, '..');
const WALLET_FILE = join(DATA_DIR, '.wallet.json');

// ─── State ───────────────────────────────────────────────────────────────────
let _addr = null;       // sent1... prefix
let _provAddr = null;   // sentprov... prefix

export function getAddr() { return _addr; }
export function getProvAddr() { return _provAddr; }
export function isWalletLoaded() { return !!_addr; }

// ─── Init / Clear ────────────────────────────────────────────────────────────

/**
 * Initialize wallet from mnemonic. Stores address on disk, mnemonic stays in memory only.
 *
 * @param {string} mnemonic - 12 or 24 word BIP39 mnemonic
 * @throws {Error} If mnemonic format is invalid
 */
export async function initWallet(mnemonic) {
  const words = mnemonic.trim().split(/\s+/);
  if (words.length !== 12 && words.length !== 24) {
    throw new Error('Mnemonic must be 12 or 24 words');
  }

  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic.trim(), { prefix: 'sent' });
  const [account] = await wallet.getAccounts();
  _addr = account.address;
  const { data } = fromBech32(_addr);
  _provAddr = toBech32('sentprov', data);

  setWalletInstance(wallet);

  // Persist address only (not mnemonic) for UI display
  writeFileSync(WALLET_FILE, JSON.stringify({ address: _addr }), 'utf8');
  console.log(`Wallet loaded: ${_addr} / ${_provAddr}`);
}

/**
 * Clear wallet state and delete persisted address file.
 */
export function clearWalletState() {
  _addr = null;
  _provAddr = null;
  setWalletInstance(null);
  clearClient();
  cacheClear();
  try { if (existsSync(WALLET_FILE)) unlinkSync(WALLET_FILE); } catch (err) {
    console.error('Failed to delete wallet file:', err.message);
  }
}

/**
 * Load saved wallet from disk (migration support: if old format had mnemonic, returns it).
 * @returns {string|null} Mnemonic if migration needed, null otherwise
 */
export function loadSavedWallet() {
  try {
    if (existsSync(WALLET_FILE)) {
      const d = JSON.parse(readFileSync(WALLET_FILE, 'utf8'));
      if (d.mnemonic) return d.mnemonic;
    }
  } catch (err) {
    console.error('Failed to load saved wallet:', err.message);
  }
  return null;
}

/**
 * Express middleware: require wallet to be loaded.
 * Sends 401 JSON response if not loaded.
 *
 * @param {object} req - Express request
 * @param {object} res - Express response
 * @returns {boolean} true if wallet is loaded
 */
export function requireWallet(req, res) {
  if (!_addr) {
    res.status(401).json({ error: 'No wallet loaded', needsLogin: true });
    return false;
  }
  return true;
}
