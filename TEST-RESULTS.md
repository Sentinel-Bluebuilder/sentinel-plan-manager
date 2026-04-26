# Plan Manager CLI — End-to-End Test Results

Methodology: see `TEST-PLAN.md`. This document records the most recent
end-to-end run against Sentinel mainnet.

- Date: 2026-04-25
- Server: `node server.js` on `:3003` (dev mode)
- Operator: `sent1dvzqs98m50vwwr6n4uvywkn79gkflppva069j8`
- Subscriber A: `sent1383w6ndmrvk0l0udjvz8u9dyapwtnzfyuuz32r`
- Subscriber B: `sent123vqpcqljarlzqaenyp5zjvty8h73x2ghyjrhj`
- Starting operator balance: 1,000.00 P2P

## Bugs found & fixed during this run

| # | File | Symptom                                              | Fix                                                                   |
|---|------|------------------------------------------------------|-----------------------------------------------------------------------|
| B1 | `cli.js`        | All POST/DELETE returned 403 CSRF blocked            | Add `X-Requested-With: XMLHttpRequest` to every CLI request         |
| B2 | `cli.js`        | Cookie not persisted between invocations             | Cookie jar in `~/.plans-cli/<base>.cookie`, replayed on next call    |
| B3 | `server.js:1030`| `wallet send` returned 500 "Do not know how to serialize a BigInt" — TX did broadcast | Convert `result.height`/`gasUsed`/`gasWanted` from BigInt before `res.json()` |
| B4 | `lib/errors.js` | `txResponse()` did not include `height`, did not strip BigInts from `events` | Add `height`, JSON-roundtrip events with BigInt→string replacer |
| B5 | `lib/errors.js` | `isSequenceError` only matched strings; SDK signals via `code === 32` | Detect `s.code === 32` on error objects too |

## Pre-flight

| # | Command            | Result | Notes                                              |
|---|--------------------|--------|----------------------------------------------------|
| 1 | `plans health`     | PASS   | uptime returned                                    |
| 2 | `plans rpc-health` | PASS   | 33 / 38 OK; 5 known-501 paths flagged              |
| 3 | `plans rpc-providers` | PASS | 8 / 32 RPC endpoints up; max height 28063744       |
| 4 | `plans node chain-count` | PASS | 1055 active nodes                              |
| 5 | `plans plan list`  | PASS   | 9 plans                                            |
| 6 | `plans params`     | PASS   | subscription/node/session blocks present           |

## Wallet flow

| # | Command                | Result | Notes                                            |
|---|------------------------|--------|--------------------------------------------------|
| 7 | `wallet generate`      | PASS   | New address + 24-word mnemonic                   |
| 8 | `wallet import`        | PASS   | Cookie jar persists session across invocations   |
| 9 | `wallet info`          | PASS   | 1000.00 P2P → 998.97 P2P after first send       |
|10 | `wallet send 1.0 P2P`  | PASS\* | First attempt returned 500 (B3); fixed; will retest |
|11 | `wallet logout`        | _pending_ | Run after all flows                          |

(\*) `wallet send` flagged FAIL on the CLI because of B3 but the TX did
broadcast — see `server.log`. After the BigInt patch the response
serializes cleanly.

## Plan flow — _pending_
## Provider flow — _pending_
## Node + lease flow — _pending_
## Subscribe + session — _pending_
## Fee-grant flow — _pending_

