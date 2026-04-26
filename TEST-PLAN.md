# Plan Manager CLI — End-to-End Test Plan

## Purpose

Exercise every Plan Manager CLI subcommand against a live Sentinel mainnet
backend. The CLI is a thin HTTP client over `server.js`; if a CLI command
works, the matching `/api/*` route works. This document is the canonical
test methodology — the matching results live in `TEST-RESULTS.md`.

## Wallet roles

Three throwaway mnemonics cover the matrix:

| Role         | Address                                            | Used for                                 |
|--------------|----------------------------------------------------|------------------------------------------|
| Operator     | `sent1dvzqs98m50vwwr6n4uvywkn79gkflppva069j8`      | Plan owner, provider, grantor, sender    |
| Subscriber A | `sent1383w6ndmrvk0l0udjvz8u9dyapwtnzfyuuz32r`      | Send recipient, fee-grant recipient      |
| Subscriber B | `sent123vqpcqljarlzqaenyp5zjvty8h73x2ghyjrhj`      | Second grant target, batch-grant member  |

The operator wallet must hold at least 5 P2P before write-path tests run.
Plan creation alone burns ~0.5 P2P in gas; bank sends ~0.03 P2P each;
grants ~0.05 P2P each.

## Environment

- Server: `http://localhost:3003` started via `start.bat` (admin) or
  `node server.js` (dev).
- Chain: Sentinel mainnet, RPC-first (per global `CLAUDE.md` rule).
- CLI: `node C:/Users/Connect/Desktop/plans/cli.js <group> <cmd> [args]`.
- Output mode: append `--json` for machine-readable output. Tests below
  use the default human-readable mode.

## Pre-flight

| # | Command                            | Expected                                     |
|---|------------------------------------|----------------------------------------------|
| 1 | `plans health`                     | `OK uptime: <Ns>`                            |
| 2 | `plans rpc-health`                 | ≥ 30 / 38 LCD endpoints OK                   |
| 3 | `plans rpc-providers`              | ≥ 5 RPC endpoints up, height roughly current |
| 4 | `plans node chain-count`           | non-zero count                                |
| 5 | `plans plan list`                  | one or more plans returned                   |
| 6 | `plans params`                     | subscription/node/session blocks present     |

If any pre-flight fails, abort — the rest of the tests will produce noise.

## Wallet flow

| # | Command                                              | Expected                                    |
|---|------------------------------------------------------|---------------------------------------------|
| 7 | `plans wallet generate`                              | new bech32 + 24-word mnemonic, shown ONCE   |
| 8 | `plans wallet import "<operator mnemonic>"`          | OK with operator address + provAddress      |
| 9 | `plans wallet info`                                  | balance > 0, USD price, provider state       |
|10 | `plans wallet send <subA> --amount 1.0 --memo "t"`   | `OK tx: …  height: …  gas: …` (no BigInt)   |
|11 | `plans wallet logout`                                | clears session cookie + local cookie file    |

## Plan flow

| # | Command                                               | Expected                              |
|---|-------------------------------------------------------|---------------------------------------|
|12 | `plans plan create --gb 50 --days 30 --price-udvpn 100000` | `OK planId: N` (event-extracted) |
|13 | `plans plan get <planId>`                             | plan record matches input             |
|14 | `plans plan status <planId> 1` (1=active, 3=inactive) | `OK tx: …` and plan now active        |
|15 | `plans plan mine`                                     | newly created plan in the list        |
|16 | `plans plan subscribers <planId>`                     | empty list initially                  |

## Provider flow

| # | Command                                                       | Expected                          |
|---|---------------------------------------------------------------|-----------------------------------|
|17 | `plans provider list`                                         | array of providers                |
|18 | `plans provider register --name "Test" --identity "x"`        | `OK tx: …` (or already-registered)|
|19 | `plans provider status`                                       | shows the operator's provider     |

## Node + lease flow

| # | Command                                                                      | Expected            |
|---|------------------------------------------------------------------------------|---------------------|
|20 | `plans node list --limit 5`                                                  | array of nodes      |
|21 | `plans node progress`                                                        | full-scan progress  |
|22 | `plans node sessions <nodeAddr>`                                             | sessions list       |
|23 | `plans node rankings --limit 5`                                              | top nodes           |
|24 | `plans lease start <nodeAddr> --price 100000udvpn`                           | `OK tx: …`          |
|25 | `plans link <planId> <nodeAddr>`                                             | `OK tx: …`          |
|26 | `plans batch-link <planId> <addr1>,<addr2>`                                  | per-address result  |
|27 | `plans unlink <planId> <nodeAddr>`                                           | `OK tx: …`          |
|28 | `plans batch-unlink <planId> <addr1>,<addr2>`                                | per-address result  |
|29 | `plans lease end <nodeAddr>`                                                 | `OK tx: …`          |

## Subscribe + session (sim subscriber)

| # | Command                                                                  | Expected                |
|---|--------------------------------------------------------------------------|-------------------------|
|30 | `plans wallet import "<subA mnemonic>"` (with sub balance > 0)           | OK                      |
|31 | `plans plan subscribe <planId> --denom udvpn`                            | `OK subId: N`           |
|32 | `plans plan start-session <subId> <nodeAddr>`                            | `OK sessionId: N`       |
|33 | `plans wallet logout` then re-import operator                            | OK                      |

## Fee-grant flow (operator side)

| # | Command                                                              | Expected                  |
|---|----------------------------------------------------------------------|---------------------------|
|34 | `plans feegrant gas-costs <planId>`                                  | per-grant cost estimate   |
|35 | `plans feegrant grant <subA> --plan <planId> --limit 0.5 --days 30`  | `OK tx: …`                |
|36 | `plans feegrant list`                                                | grant to subA visible      |
|37 | `plans feegrant grant-subscribers <planId> --limit 0.5 --days 30`    | per-subscriber result     |
|38 | `plans feegrant revoke <subA>`                                       | `OK tx: …` or alreadyGone |
|39 | `plans feegrant revoke-list <subA>,<subB>`                           | revoked / alreadyGone     |
|40 | `plans feegrant auto-grant get`                                      | bool                      |
|41 | `plans feegrant auto-grant set --enabled true`                       | OK                        |
|42 | `plans feegrant revoke-all`                                          | per-grant result          |

## Scoring

A test passes when:
1. The CLI exits 0 and prints `OK …`.
2. The on-chain effect is visible (balance change, plan record, subscriber
   count, grant existence) within one block (~6s).
3. No BigInt or serialization stack traces in `server.log`.

A test is partial-pass when the CLI exits non-zero but the chain accepted
the TX (the prior bug class — `wallet send` had this until the BigInt
patch in `server.js:1030–1036` and `lib/errors.js:txResponse`).

## Known sources of noise

- `LCD /sentinel/plan/v3/plans` returns 501 — the server falls back to RPC
  via `discoverPlans()`. Not a failure.
- `LCD /sentinel/subscription/v3/payouts` returns 501. Not a failure.
- A handful of community RPC endpoints are perpetually down — `rpc-providers`
  is expected to have ≥ 5 up, not 32.
- Plan pricing is immutable in Sentinel v3. Tests #12 always create a new
  plan — they never mutate prices on an existing one.

## Cleanup

After test completion: `plans wallet logout`, then power off any plans
created during the run by reverting their status to inactive (`plan status
<id> --status inactive`). The test plan IDs accumulate in `my-plans.json`
under the operator address — leave them; the on-chain plan records cannot
be deleted, only marked inactive.
