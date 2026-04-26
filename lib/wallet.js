// ─── Wallet Accessors ────────────────────────────────────────────────────────
// Every wallet lives in the per-request session derived from the encrypted
// spm_sess cookie. The server holds no module-level mnemonic, no .wallet.json,
// no .env fallback — keys exist only in the user's browser cookie and in RAM
// for the duration of a request.

import { currentSession } from './session.js';

export function getAddr() {
  const s = currentSession();
  return s ? s.addr : null;
}

export function getProvAddr() {
  const s = currentSession();
  return s ? s.provAddr : null;
}

export function isWalletLoaded() {
  return !!currentSession();
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
  if (isWalletLoaded()) return true;
  res.status(401).json({ error: 'No wallet loaded', needsLogin: true });
  return false;
}
