// ─── Protobuf Encoders ───────────────────────────────────────────────────────
// Raw protobuf encoding for Sentinel v3 chain messages.
// Same pattern as node-tester v3protocol.js — no protobuf.js dependency.

import { Registry } from '@cosmjs/proto-signing';
import { defaultRegistryTypes } from '@cosmjs/stargate';
import * as C from './constants.js';

// ─── Primitive Encoders ──────────────────────────────────────────────────────

function encodeVarint(n) {
  n = BigInt(n);
  const bytes = [];
  while (n > 127n) { bytes.push(Number(n & 0x7fn) | 0x80); n >>= 7n; }
  bytes.push(Number(n));
  return Buffer.from(bytes);
}

function protoString(fieldNum, str) {
  if (!str) return Buffer.alloc(0);
  const b = Buffer.from(str, 'utf8');
  return Buffer.concat([encodeVarint((BigInt(fieldNum) << 3n) | 2n), encodeVarint(b.length), b]);
}

function protoUint64(fieldNum, n) {
  if (!n && n !== 0) return Buffer.alloc(0);
  return Buffer.concat([encodeVarint((BigInt(fieldNum) << 3n) | 0n), encodeVarint(n)]);
}

function protoInt64(fieldNum, n) {
  if (!n && n !== 0) return Buffer.alloc(0);
  return Buffer.concat([encodeVarint((BigInt(fieldNum) << 3n) | 0n), encodeVarint(n)]);
}

function protoEmbedded(fieldNum, buf) {
  if (!buf || buf.length === 0) return Buffer.alloc(0);
  return Buffer.concat([encodeVarint((BigInt(fieldNum) << 3n) | 2n), encodeVarint(buf.length), buf]);
}

function protoBool(fieldNum, val) {
  if (!val) return Buffer.alloc(0);
  return Buffer.concat([encodeVarint((BigInt(fieldNum) << 3n) | 0n), encodeVarint(1)]);
}

// ─── Value Encoders ──────────────────────────────────────────────────────────

/** sdk.Dec → scaled big.Int string (multiply by 10^18) */
function decToScaledInt(decStr) {
  const s = String(decStr).trim();
  const dotIdx = s.indexOf('.');
  if (dotIdx === -1) return s + '0'.repeat(18);
  const intPart = s.slice(0, dotIdx);
  const fracPart = (s.slice(dotIdx + 1) + '0'.repeat(18)).slice(0, 18);
  const combined = (intPart === '' || intPart === '0' ? '' : intPart) + fracPart;
  return combined.replace(/^0+/, '') || '0';
}

function encodeDuration(seconds) {
  return Buffer.concat([protoInt64(1, BigInt(seconds))]);
}

/** Encode a sentinel.types.v1.Price message */
function encodePrice({ denom, base_value, quote_value }) {
  return Buffer.concat([
    protoString(1, denom),
    protoString(2, decToScaledInt(String(base_value))),
    protoString(3, String(quote_value)),
  ]);
}

// ─── Message Encoders ────────────────────────────────────────────────────────

function encodeMsgLinkNode({ from, id, nodeAddress }) {
  return Uint8Array.from(Buffer.concat([protoString(1, from), protoUint64(2, id), protoString(3, nodeAddress)]));
}

function encodeMsgUnlinkNode({ from, id, nodeAddress }) {
  return Uint8Array.from(Buffer.concat([protoString(1, from), protoUint64(2, id), protoString(3, nodeAddress)]));
}

function encodeMsgCreatePlan({ from, bytes, duration, prices, isPrivate }) {
  const parts = [protoString(1, from)];
  if (bytes) parts.push(protoString(2, String(bytes)));
  if (duration) parts.push(protoEmbedded(3, encodeDuration(duration)));
  for (const p of (prices || [])) parts.push(protoEmbedded(4, encodePrice(p)));
  if (isPrivate) parts.push(protoBool(5, true));
  return Uint8Array.from(Buffer.concat(parts));
}

function encodeMsgRegisterProvider({ from, name, identity, website, description }) {
  return Uint8Array.from(Buffer.concat([
    protoString(1, from), protoString(2, name || ''), protoString(3, identity || ''),
    protoString(4, website || ''), protoString(5, description || ''),
  ]));
}

function encodeMsgUpdateProviderDetails({ from, name, identity, website, description }) {
  return Uint8Array.from(Buffer.concat([
    protoString(1, from), protoString(2, name || ''), protoString(3, identity || ''),
    protoString(4, website || ''), protoString(5, description || ''),
  ]));
}

function encodeMsgUpdateProviderStatus({ from, status }) {
  return Uint8Array.from(Buffer.concat([protoString(1, from), protoInt64(2, BigInt(status))]));
}

function encodeMsgStartLease({ from, nodeAddress, hours, maxPrice, renewalPricePolicy }) {
  const parts = [protoString(1, from), protoString(2, nodeAddress), protoInt64(3, BigInt(hours))];
  if (maxPrice) parts.push(protoEmbedded(4, encodePrice(maxPrice)));
  if (renewalPricePolicy) parts.push(protoInt64(5, BigInt(renewalPricePolicy)));
  return Uint8Array.from(Buffer.concat(parts));
}

function encodeMsgEndLease({ from, id }) {
  return Uint8Array.from(Buffer.concat([protoString(1, from), protoUint64(2, id)]));
}

function encodeMsgUpdatePlanStatus({ from, id, status }) {
  return Uint8Array.from(Buffer.concat([protoString(1, from), protoUint64(2, id), protoInt64(3, BigInt(status))]));
}

function encodeMsgStartSubscription({ from, id, denom, renewalPricePolicy }) {
  const parts = [protoString(1, from), protoUint64(2, id), protoString(3, denom || 'udvpn')];
  if (renewalPricePolicy) parts.push(protoInt64(4, BigInt(renewalPricePolicy)));
  return Uint8Array.from(Buffer.concat(parts));
}

function encodeMsgSubStartSession({ from, id, nodeAddress }) {
  return Uint8Array.from(Buffer.concat([protoString(1, from), protoUint64(2, id), protoString(3, nodeAddress)]));
}

function encodeMsgPlanStartSession({ from, id, denom, renewalPricePolicy, nodeAddress }) {
  const parts = [protoString(1, from), protoUint64(2, id), protoString(3, denom || 'udvpn')];
  if (renewalPricePolicy) parts.push(protoInt64(4, BigInt(renewalPricePolicy)));
  if (nodeAddress) parts.push(protoString(5, nodeAddress));
  return Uint8Array.from(Buffer.concat(parts));
}

// ─── Registry Factory ────────────────────────────────────────────────────────

function makeMsgType(encodeFn) {
  return {
    fromPartial: (v) => v,
    encode: (inst) => ({ finish: () => encodeFn(inst) }),
    decode: () => ({}),
  };
}

/**
 * Create a Cosmos SDK registry with all Sentinel v3 message types registered.
 * @returns {Registry}
 */
export function createRegistry() {
  return new Registry([
    ...defaultRegistryTypes,
    [C.MSG_LINK_TYPE, makeMsgType(encodeMsgLinkNode)],
    [C.MSG_UNLINK_TYPE, makeMsgType(encodeMsgUnlinkNode)],
    [C.MSG_CREATE_PLAN_TYPE, makeMsgType(encodeMsgCreatePlan)],
    [C.MSG_REGISTER_PROVIDER_TYPE, makeMsgType(encodeMsgRegisterProvider)],
    [C.MSG_UPDATE_PROVIDER_DETAILS_TYPE, makeMsgType(encodeMsgUpdateProviderDetails)],
    [C.MSG_UPDATE_PROVIDER_STATUS_TYPE, makeMsgType(encodeMsgUpdateProviderStatus)],
    [C.MSG_UPDATE_PLAN_STATUS_TYPE, makeMsgType(encodeMsgUpdatePlanStatus)],
    [C.MSG_START_LEASE_TYPE, makeMsgType(encodeMsgStartLease)],
    [C.MSG_END_LEASE_TYPE, makeMsgType(encodeMsgEndLease)],
    [C.MSG_START_SUBSCRIPTION_TYPE, makeMsgType(encodeMsgStartSubscription)],
    [C.MSG_SUB_START_SESSION_TYPE, makeMsgType(encodeMsgSubStartSession)],
    [C.MSG_PLAN_START_SESSION_TYPE, makeMsgType(encodeMsgPlanStartSession)],
  ]);
}
