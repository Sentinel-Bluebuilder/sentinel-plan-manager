# Sentinel dVPN Subscription Plans — Deep Dive

A technical reference for entrepreneurs and developers launching a commercial dVPN product on Sentinel's chain-native subscription model.

---

## 1. What is Plan Manager?

Plan Manager is a self-hosted operator dashboard — an Express + vanilla JS single-page app running on port 3003. It is the control panel for anyone who wants to run a commercial dVPN service on top of Sentinel.

It is **not** an end-user app. End users never see it. It talks directly to the Sentinel chain via LCD endpoints and to the Sentinel node network via the WireGuard/V2Ray handshake protocol. You run it on your own machine or server, load your operator wallet, and use it to create plans, link nodes, monitor subscribers, and manage fee grants.

If you are building a white-label VPN product — where your customers subscribe, pay you, and connect through nodes you curate — Plan Manager is your backend ops tool.

---

## 2. Why Plans Exist on Sentinel

Sentinel has two bandwidth-access models baked into the chain. Both are on-chain, both are trustless, but they serve fundamentally different use cases.

### P2P (Per-Session) Access

The user's wallet pays each node directly, per session, at the node's own advertised price. No intermediary. Good for power users, developers testing the protocol, and anyone who already holds P2P tokens and wants direct control.

### Plan-Based (Subscription) Access

An operator creates a plan with a fixed duration and data cap. Subscribers pay the operator once. The operator links nodes to the plan. Subscribers start sessions against any linked node — no per-session payment, because bandwidth is already prepaid via the subscription. The operator can also fee-grant subscribers, meaning end users hold **zero P2P tokens** and pay **zero gas**. This is the model for commercial dVPN products.

### Comparison Table

| Dimension | P2P (Per-Session) | Plan-Based (Subscription) |
|---|---|---|
| Who pays the node | End user's wallet, directly | Operator (prepaid via plan subscription) |
| Who pays gas | End user | End user, or operator via feegrant |
| End user needs P2P tokens | Yes | No (if fee-granted) |
| Node selection | Any active chain node | Only nodes linked to the plan |
| Price set by | Each node operator independently | Plan operator (fixed at plan creation) |
| Pricing flexibility | Per-node, varies | Fixed for plan lifetime; new plan to change |
| Grant model | None | `MsgGrantAllowance` per subscriber |
| Target user | Power users, devs, testers | Consumer VPN customers |
| UX complexity | Requires wallet, token management | Can be fully abstracted by operator app |
| Commercial layer | None — fully direct | Operator runs own payment system on top |

---

## 3. The Plan Lifecycle

### Step 1 — Register as a Provider

One-time operation. Broadcasts `/sentinel.provider.v3.MsgRegisterProviderRequest` from your operator wallet. This creates your `sentprov1...` address on-chain. You must be registered before you can create plans.

```json
{
  "@type": "/sentinel.provider.v3.MsgRegisterProviderRequest",
  "from":  "sent1...",
  "name":  "My dVPN Service",
  "identity": "",
  "website": "https://example.com",
  "description": ""
}
```

### Step 2 — Create a Plan

Broadcasts `/sentinel.plan.v3.MsgCreatePlanRequest`. Specifies duration in seconds, data in gigabytes, price in `udvpn`, and whether the plan is private.

```json
{
  "@type": "/sentinel.plan.v3.MsgCreatePlanRequest",
  "from":        "sentprov1...",
  "duration":    "2592000s",
  "gigabytes":   "100",
  "prices": [
    { "denom": "udvpn", "amount": "5000000" }
  ],
  "private": false
}
```

Price is **immutable** once created. To change pricing, create a new plan and migrate subscribers. Keep old plans active until all existing subscribers' durations expire.

### Step 3 — Link Nodes

Broadcasts `/sentinel.plan.v3.MsgLinkNodeRequest` for each node you want to include. Only linked nodes will honor sessions under this plan. Nodes can be linked and unlinked at any time.

```json
{
  "@type":   "/sentinel.plan.v3.MsgLinkNodeRequest",
  "from":    "sentprov1...",
  "id":      12,
  "address": "sentnode1..."
}
```

`id` is the numeric plan ID returned by the chain when you created the plan.

### Step 4 — Subscriber Purchases

When a user subscribes (triggered by your app's backend), the operator broadcasts `/sentinel.subscription.v3.MsgStartSubscriptionRequest` on behalf of the user's wallet — or the user's wallet broadcasts it directly if they hold P2P.

```json
{
  "@type":  "/sentinel.subscription.v3.MsgStartSubscriptionRequest",
  "from":   "sent1...",
  "id":     12,
  "denom":  "udvpn"
}
```

The chain deducts the plan price from the subscriber's wallet (or the operator's, depending on your flow) and records the subscription. The `subscription_id` returned is what the client uses in every subsequent session request.

### Step 5 — Issue Fee Grants (Optional but Recommended)

For a zero-friction consumer experience, the operator issues a `MsgGrantAllowance` for each subscriber. This lets the subscriber's session-start transactions draw gas from the operator's wallet.

```json
{
  "@type":   "/cosmos.feegrant.v1beta1.MsgGrantAllowance",
  "granter": "sent1...",
  "grantee": "sent1...",
  "allowance": {
    "@type":       "/cosmos.feegrant.v1beta1.BasicAllowance",
    "spend_limit": [{ "denom": "udvpn", "amount": "1000000" }],
    "expiration":  "2026-12-31T00:00:00Z"
  }
}
```

Query existing grants at `/cosmos/feegrant/v1beta1/allowances/{grantee_sent1...}` before issuing to avoid duplicates.

### Step 6 — Subscriber Starts a Session

The subscriber's dVPN client broadcasts `/sentinel.session.v3.MsgStartSessionRequest` (note: the session message lives under the session module, not the plan module). It references the `subscription_id` from Step 4 and a specific node address.

The node returns handshake data. The client verifies, signs, and establishes the WireGuard or V2Ray tunnel.

### Step 7 — Ongoing Operations

- Monitor subscribers: `/sentinel.plan.v3.plans/{planId}/subscribers`
- Renew expiring fee grants before they lapse
- Link additional nodes as your network grows
- Create new plans when pricing needs to change

---

## 4. Core Concepts Glossary

| Term | Definition |
|---|---|
| **Provider** | An entity registered on-chain via `MsgRegisterProviderRequest`. Has a `sentprov1...` address. Required to create plans. |
| **Plan** | An on-chain record with a fixed duration (seconds), data cap (GB), and price (in `udvpn`). Created by a provider. Identified by a numeric ID. |
| **Subscription** | A user's purchase of a plan. Recorded on-chain with a `subscription_id`. Grants the user access to sessions on linked nodes until the plan duration expires or data cap is reached. |
| **Session** | A single active tunnel connection between a subscriber and a linked node. One active session per subscription at a time. Opened with `MsgStartSessionRequest`, closed with `MsgEndSessionRequest`. |
| **Fee Grant** | A `MsgGrantAllowance` from the operator to a subscriber. Allows the subscriber's session transactions to draw gas from the operator's wallet. The subscriber pays zero on-chain fees. |
| **Node Linking** | The act of associating a node (`sentnode1...`) with a plan via `MsgLinkNodeRequest`. Only linked nodes honor plan-based sessions. |
| **`udvpn`** | The base chain denomination. 1,000,000 `udvpn` = 1 P2P. All on-chain amounts are in `udvpn`. Display values are in P2P. |
| **P2P** | The human-readable display denomination for Sentinel's token. Always uppercase in UI and docs. |
| **`service_type`** | Integer indicating tunnel protocol: `1` = WireGuard, `2` = V2Ray. Field name in v3 API (was `type` in v2 — do not use the old field name). |
| **`remote_addrs`** | Array of strings in v3 node records. The node's endpoint addresses. Was a single string (`remote_url`) in v2 — always use the array form with v3. |
| **`acc_address`** | The `sent1...` wallet address field in v3 node and account records. Was `address` in v2. |
| **`base_session`** | In v3 session responses, the session object is nested under `base_session`. The flat structure was v2. Always unwrap `base_session` when parsing v3 session responses. |

---

## 5. What Plan Manager Does For You

Plan Manager exposes the full operator workflow through a browser UI backed by Express API routes. Each tab maps to a category of on-chain operations.

### Wallet Tab
- Load operator wallet from mnemonic (stored in memory only, never persisted to disk by default).
- Display P2P balance and `sent1...` / `sentprov1...` addresses.
- Check LCD connectivity and failover status.

### Plans Tab
- Create a new plan (duration, gigabytes, price in P2P).
- List all plans owned by the loaded provider address.
- Activate or deactivate a plan.
- View nodes currently linked to each plan.

### Nodes Tab
- Scan all active chain nodes (`/sentinel/node/v3/nodes?status=1`).
- Filter by `service_type` (WireGuard only, V2Ray only, both).
- Score and rank nodes by uptime, latency, and price.
- Batch link selected nodes to a plan in a single multi-message transaction.
- Batch unlink nodes.

### Subscriptions Tab
- List all subscribers for a selected plan.
- View each subscriber's `sent1...` address, subscription ID, and expiry.
- Identify subscribers whose fee grants are missing or expired.

### Fee Grants Tab
- Bulk-grant fee allowances to all subscribers who lack one.
- Renew grants approaching expiry.
- Monitor grant coverage: percentage of active subscribers with valid grants.
- Set grant spend limit and expiration in a single form.

### Leases Tab
- Start and end leases for provider-owned nodes (`MsgStartLease` / `MsgEndLease`).
- Applicable when the operator also runs their own Sentinel nodes and wants to manage lease periods directly.

---

## 6. Plan-Based Session vs P2P Session — The Technical Difference

The on-chain message type for both is the same module (`sentinel.session`), but the semantics differ significantly.

### P2P Session

The user pays the node directly, per session. No prior subscription required.

```json
{
  "@type":           "/sentinel.session.v3.MsgStartSessionRequest",
  "from":            "sent1...",
  "node_address":    "sentnode1...",
  "subscription_id": 0
}
```

- `subscription_id = 0` signals a direct P2P session.
- The user's wallet is debited at the node operator's posted price per GB or per hour.
- User pays their own gas.
- Any active chain node can be used.

### Plan-Based Session

The subscription was prepaid. The session references an existing `subscription_id`.

```json
{
  "@type":           "/sentinel.session.v3.MsgStartSessionRequest",
  "from":            "sent1...",
  "node_address":    "sentnode1...",
  "subscription_id": 4821
}
```

- `subscription_id` must match an active subscription held by `from`.
- The node must be linked to the plan that the subscription belongs to.
- No per-session payment is debited. Bandwidth is drawn down from the subscription's data cap.
- If the operator has issued a fee grant to `from`, the gas cost is drawn from the operator's wallet — the user pays nothing on-chain.

### Handshake — Identical for Both

After the session is opened on-chain, the client performs the same handshake regardless of session type:

```
signature = sign( SHA256( BigEndian_uint64(sessionId) || raw_peer_data_json_bytes ) )
```

Key points:
- Sign the **raw bytes** of the peer data, not a base64 or hex-encoded version.
- `sessionId` is encoded as a big-endian 8-byte unsigned integer, prepended to the peer data bytes before hashing.
- The node verifies this signature to authenticate the client before returning WireGuard or V2Ray credentials.

---

## 7. Operator Economics

### What the Operator Pays

| Action | Who Pays | Frequency |
|---|---|---|
| `MsgRegisterProviderRequest` | Operator | Once |
| `MsgCreatePlanRequest` | Operator | Once per plan |
| `MsgLinkNodeRequest` | Operator | Once per node per plan |
| `MsgGrantAllowance` (feegrant) | Operator | Once per subscriber (renewals as needed) |
| Subscriber session gas (if fee-granted) | Operator draws from grant | Every session start |
| Plan subscription payment | Subscriber | Once per subscription period |

### What Subscribers Pay

If the operator fully fee-grants subscribers:
- Subscribers pay the plan price once (in P2P, on-chain) when subscribing.
- All subsequent session transactions are covered by the fee grant.
- Subscribers can hold zero P2P after the initial subscription if the operator wishes to absorb that cost too (by handling the `MsgStartSubscription` broadcast from the operator's backend using the subscriber's key or a delegated mechanism).

### The Commercial Layer

Sentinel plans enforce only one thing: that `MsgStartSubscription` succeeds on-chain. They do not enforce how you charge your end users. Common patterns:

- **Fiat subscription**: User pays via Stripe or similar. Your backend mints a session key for the user, triggers `MsgStartSubscription` from your wallet on their behalf, and fee-grants them. User never interacts with the chain directly.
- **Crypto subscription**: User sends USDC or another token to your payment address off-chain. You trigger the same on-chain flow.
- **Direct P2P**: User holds P2P tokens and broadcasts `MsgStartSubscription` themselves. Your fee grants cover session gas. Simpler backend, more advanced user.

The split is clean: Sentinel handles trustless bandwidth accounting; you handle user identity, payments, and UX.

### Fee Grant Sizing

A typical `MsgStartSessionRequest` costs approximately 20,000–50,000 `udvpn` in gas. For a subscriber who starts 2 sessions per day over a 30-day plan, budget roughly 3,000,000 `udvpn` (3 P2P) in grant allowance per subscriber per month. Adjust based on observed gas prices on the chain.

---

## 8. When NOT To Use Plan Manager

| Situation | Better Tool |
|---|---|
| Building a consumer VPN client app | Use the Sentinel SDK directly in your app. Plan Manager is not an SDK. |
| You are a single end user wanting VPN access | Use the official Sentinel mobile or desktop app — it handles P2P sessions natively. |
| You operate a single node and want to manage it | Use a node operator tool. Plan Manager is for plan operators, not node operators. |
| You want to test individual nodes or protocols | Use the Sentinel Node Tester tool. Plan Manager does not expose raw protocol testing. |
| You want a fully automated backend with no UI | Build directly against the Sentinel SDK's operator functions (`encodeMsgCreatePlan`, `batchStartSessions`, `grantPlanSubscribers`). Plan Manager is a wrapper around those same functions. |

---

## 9. Related Reading

- `README.md` — Plan Manager setup instructions, environment variables, CLI commands, and port configuration.
- `MANIFESTO.md` — The Sentinel network's design philosophy: why purely decentralized P2P bandwidth, why zero external dependencies, and why the chain-native subscription model matters.

---

## Quick Reference — Message Types

| Operation | Message Type |
|---|---|
| Register provider | `/sentinel.provider.v3.MsgRegisterProviderRequest` |
| Create plan | `/sentinel.plan.v3.MsgCreatePlanRequest` |
| Link node to plan | `/sentinel.plan.v3.MsgLinkNodeRequest` |
| Start subscription | `/sentinel.subscription.v3.MsgStartSubscriptionRequest` |
| Start session (plan or P2P) | `/sentinel.session.v3.MsgStartSessionRequest` |
| Issue fee grant | `/cosmos.feegrant.v1beta1.MsgGrantAllowance` |

## Quick Reference — v3 LCD Paths

| Query | Path |
|---|---|
| Active nodes | `/sentinel/node/v3/nodes?status=1&pagination.limit=5000` |
| Plan by ID | `/sentinel/plan/v3/plans/{planId}` |
| Plan's linked nodes | `/sentinel/node/v3/plans/{planId}/nodes` |
| Plan's subscribers | `/sentinel/plan/v3/plans/{planId}/subscribers` |
| Subscriptions for wallet | `/sentinel/subscription/v3/accounts/{sent1...}/subscriptions` |
| Sessions for wallet | `/sentinel/session/v3/accounts/{sent1...}/sessions` |
| Session allocation | `/sentinel/session/v3/sessions/{sessionId}/allocations` |
| Fee grants for wallet | `/cosmos/feegrant/v1beta1/allowances/{sent1...}` |
| Wallet balance | `/cosmos/bank/v1beta1/balances/{sent1...}` |
| Provider record | `/sentinel/provider/v2/providers/{sentprov1...}` |

Note: the provider endpoint remains on v2. All other queries above use v3. Using v2 paths for non-provider resources returns "Not Implemented".
