// ─── Protobuf Registry (SDK-backed) ──────────────────────────────────────────
// All Sentinel v3 message encoders live in blue-js-sdk. We re-export
// buildRegistry as createRegistry to keep existing call sites stable.
// Byte-equivalent output verified against the previous hand-rolled encoders
// for all 12 message types Plan Manager broadcasts.

import { buildRegistry } from 'blue-js-sdk';

export const createRegistry = buildRegistry;
