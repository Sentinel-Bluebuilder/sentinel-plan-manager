// ─── Error Handling ──────────────────────────────────────────────────────────
// Chain/RPC error parsing into user-friendly messages.
// Pattern: match known error patterns → return short human-readable string.

/**
 * Parse raw chain/RPC error into a short user-friendly string.
 * Matches known Sentinel chain error patterns first, then falls back
 * to extracting the desc field from RPC errors.
 *
 * @param {string} raw - Raw error message from chain/RPC
 * @returns {string} Human-readable error (max 150 chars)
 */
export function parseChainError(raw) {
  const s = String(raw || '');

  // ─── Known chain errors ──────────────────────────────────────────────
  if (s.includes('duplicate node for plan')) return 'Node is already in this plan';
  if (s.includes('duplicate provider')) return 'Provider already registered — use Update';
  if (s.includes('lease') && s.includes('not found')) return 'No active lease for this node';
  if (s.includes('lease') && s.includes('already exists')) return 'Lease already exists for this node';
  if (s.includes('insufficient funds')) return 'Insufficient P2P balance';
  if (s.includes('invalid price')) return 'Price mismatch — node may have changed rates';
  if (s.includes('invalid status inactive')) return 'Plan is inactive — activate first';
  if (s.includes('plan') && s.includes('does not exist')) return 'Plan not found on chain';
  if (s.includes('provider') && s.includes('does not exist')) return 'Provider not registered';
  if (s.includes('node') && s.includes('does not exist')) return 'Node not found on chain';
  if (s.includes('node') && s.includes('not active')) return 'Node is inactive';
  if (s.includes('account sequence mismatch') || s.includes('incorrect account sequence')) {
    return 'Chain busy — sequence mismatch after 5 retries. Wait a moment and try again.';
  }
  if (s.includes('out of gas')) return 'Transaction out of gas';
  if (s.includes('timed out')) return 'Transaction timed out';

  // ─── Extract desc from RPC error ─────────────────────────────────────
  const m = s.match(/desc = (.+?)(?:\[|With gas|$)/);
  if (m) return m[1].trim().slice(0, 120);

  return s.slice(0, 150);
}

/**
 * Check if an error message indicates a sequence mismatch.
 * @param {string} s - Error message
 * @returns {boolean}
 */
export function isSequenceError(s) {
  if (!s) return false;
  // SDK pattern: error objects from broadcast may carry code === 32 directly.
  if (typeof s === 'object' && s.code === 32) return true;
  const str = String(s);
  return str.includes('account sequence mismatch') || str.includes('incorrect account sequence');
}

/**
 * Extract the expected sequence number from a mismatch error.
 * @param {string} s - Error message containing "expected N"
 * @returns {number|null}
 */
export function extractExpectedSeq(s) {
  const m = String(s).match(/expected\s+(\d+)/);
  return m ? parseInt(m[1]) : null;
}

/**
 * Check if error indicates lease not found.
 * @param {string} s - Error message
 * @returns {boolean}
 */
export function isLeaseNotFound(s) {
  return !!s && s.includes('lease') && s.includes('not found');
}

/**
 * Check if error indicates duplicate node in plan.
 * @param {string} s - Error message
 * @returns {boolean}
 */
export function isDuplicateNode(s) {
  return !!s && s.includes('duplicate node for plan');
}

/**
 * Safely serialize a TX result (handles BigInt → Number conversion).
 * @param {object} result - Raw cosmos TX result
 * @returns {object} Serializable response
 */
export function txResponse(result) {
  return {
    ok: result.code === 0,
    txHash: result.transactionHash,
    height: result.height != null ? Number(result.height) : undefined,
    gasUsed: result.gasUsed != null ? Number(result.gasUsed) : undefined,
    gasWanted: result.gasWanted != null ? Number(result.gasWanted) : undefined,
    code: result.code,
    rawLog: result.rawLog,
    // events can contain BigInt block heights — strip them by JSON-roundtrip via toJSON
    events: result.events ? safeEvents(result.events) : undefined,
  };
}

function safeEvents(events) {
  try {
    return JSON.parse(JSON.stringify(events, (_k, v) => typeof v === 'bigint' ? v.toString() : v));
  } catch {
    return undefined;
  }
}
