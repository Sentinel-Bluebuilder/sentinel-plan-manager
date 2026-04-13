# The Plan Manager Manifesto

> *"A protocol without commerce is a library. A protocol with commerce is an economy."*

---

## Why This Exists

The Sentinel SDK gives you the tunnel. The nodes give you the bandwidth. The blockchain gives you the ledger. But none of that becomes a *business* until someone creates a plan, sets a price, links the nodes, and opens the door for subscribers.

That's what this is. The Plan Manager is the **commerce layer** of the decentralized internet.

Without it, Sentinel is infrastructure waiting to be used. With it, Sentinel is an economy — thousands of independent entrepreneurs, in every country, running their own bandwidth businesses on a blockchain that no one controls.

---

## The Vision

Imagine a world where starting an internet service provider takes five minutes and costs nothing but a wallet.

A student in Nairobi creates a plan: 10 GB, 30 days, 5 P2P. She links three nodes — one in Germany, one in Singapore, one in Brazil. She shares the plan ID. People subscribe. She earns tokens. She reinvests in more nodes. She's not asking anyone's permission. She's not filing paperwork. She's not negotiating with telecoms. She's running an ISP on a blockchain from her laptop.

A developer in Bucharest builds a privacy browser. Under the hood, it creates plans dynamically — spinning up node pools per region, adjusting pricing by demand, issuing fee grants so users never touch gas fees. The browser doesn't own the network. It orchestrates it. The infrastructure is the commons. The business logic is his.

A collective in Jakarta runs a censorship-resistance service. They don't advertise. They share plan IDs through encrypted channels. Each plan has different node pools, rotated weekly. The blockchain records the subscriptions but not the intent. The plans are just numbers on a ledger. The freedom they enable is immeasurable.

**This is what the Plan Manager makes possible.** Not just one business model — every business model. Subscriptions, bundles, regional pools, rotating node sets, fee-abstracted frictionless onboarding, provider-funded access for at-risk populations. Every plan is an experiment in decentralized commerce. Every entrepreneur is a test of the thesis that bandwidth can be a peer-to-peer marketplace.

---

## What We Actually Do

This is not an admin panel. This is a **blockchain business studio.**

### Create Plans
One transaction. Immutable pricing (Sentinel v3 design — prices are commitments, not suggestions). Choose duration, data cap, renewal policy. The chain assigns an ID. That ID is your storefront.

### Curate Node Pools
Browse 900+ live nodes. Filter by country, protocol, speed. Link them to your plan in a single batched transaction. Auto-lease nodes that need activation. Your subscribers get the nodes you chose — your curation is your competitive advantage.

### Manage Subscribers
See who subscribed, when they expire, what they're paying. Estimate your monthly revenue in P2P and USD. The chain is the source of truth — no database to maintain, no backend to host.

### Fund Access with Fee Grants
The hardest part of onboarding a new user to crypto is gas fees. Fee grants solve this: you pay the transaction costs for your subscribers. They subscribe without ever holding gas tokens. One click. Batch-issued. Revocable. This is how you build a product that feels like Web2 but runs on Web3.

### Monitor the Network
39 RPC endpoints health-checked. Node rankings by sessions, bandwidth, unique users. Peer statistics from the explorer. You're not flying blind — you know which nodes perform and which don't.

---

## The Deeper Purpose

The Sentinel SDK manifesto says: *"Anyone can build."* The Plan Manager is the proof.

It takes the raw protocol — protobuf messages, sequence numbers, LCD pagination quirks, lease mechanics — and turns it into decisions a human can make: *Which nodes? What price? How long? Who pays the gas?*

Every abstraction in this tool exists to **lower the barrier between "I want to run a bandwidth business" and "I am running one."** The blockchain doesn't care who you are. The protocol doesn't ask for credentials. The Plan Manager doesn't require a business license. You need a wallet and a vision. That's it.

### For Builders Using AI

This project was designed with a specific belief: **the next generation of Sentinel businesses will be built by entrepreneurs working with AI.**

A developer who has never touched Cosmos SDK should be able to sit down with an AI assistant, describe the business they want to build, and have a working plan management system by end of day. The code is readable. The patterns are documented. The on-chain operations are sequenced correctly. The edge cases — sequence mismatches, pagination quirks, lease-before-link ordering — are handled.

This is not just a tool. It is a **reference implementation** for anyone building plan management into their own application. Every pattern here — batch transactions, fee grant workflows, node curation, subscriber analytics — is a pattern that can be extracted, adapted, and redeployed in any context.

---

## Core Principles

### 1. The Chain Is the Database
No external databases. No cloud storage. No user accounts. The blockchain stores plans, subscriptions, sessions, fee grants. The Plan Manager reads from it and writes to it. If this server disappears, every plan still exists. Every subscription still works. The data is sovereign.

### 2. Batch Everything
Gas costs are real. Every unnecessary transaction is money your users or your business loses. Node links are batched. Fee grants are batched (5 per TX for gas limits). Leases are auto-issued only when needed. The goal: minimum transactions for maximum effect.

### 3. Fee Abstraction Is Not Optional
If your subscribers need to buy gas tokens before they can subscribe to your plan, you've already lost them. Fee grants are a first-class feature — not an afterthought, not a power-user option. The settings panel, the batch grant/revoke UI, the per-subscriber grant status — this is the bridge between crypto infrastructure and consumer products.

### 4. Curation Is the Product
900+ nodes exist on the network. Most users don't want to choose between them. They want someone — you, the plan provider — to choose the best ones. Your node selection, your regional coverage, your performance standards — that's your value proposition. The Plan Manager gives you the tools to curate with precision and update with agility.

### 5. Immutable Prices, Mutable Everything Else
Sentinel v3 made plan pricing immutable by design. This is a feature, not a limitation. When a subscriber sees a price, they know it won't change under them. Trust is built into the protocol. If you need different pricing, create a new plan. Plans are cheap. Trust is not.

### 6. Transparency by Default
Show the source: "979 nodes (chain)" vs "860 nodes (cached)". Show the staleness: "Updated 2m ago". Show the economics: P2P amount, USD equivalent, estimated monthly revenue. Never hide the math. Your subscribers trust you because they can verify you.

---

## The Entrepreneur's Toolkit

This is what one person, one wallet, and this tool can build:

| Business Model | How |
|---------------|-----|
| **Regional VPN Service** | Curate nodes in specific countries. Market to expats, travelers, remote workers. |
| **Privacy Bundle** | Premium plan with high-speed nodes. Fee grants included. Charge higher, deliver better. |
| **Censorship Resistance** | Rotating node pools. Shared via secure channels. Funded by donations through fee grants. |
| **Developer API** | Wrap plan creation in your own API. Automate node selection by latency/speed test results. |
| **Community Network** | Cooperative model — members run nodes AND subscribe. Revenue cycles back to operators. |
| **White-Label VPN** | Build your own branded app. Use Plan Manager patterns for backend plan orchestration. |

Each of these is one wallet, a few transactions, and an idea. The blockchain handles the rest.

---

## What We've Proven

- **Plan 42** — created, nodes linked, subscribers onboarded, fee grants issued, revenue tracked. End-to-end on mainnet with real P2P tokens.
- **Batch operations** — 10+ node links in a single transaction. 5 fee grants per TX. Sequence retry with exponential backoff handles chain congestion.
- **Auto-lease** — nodes without active leases are automatically leased before linking. No manual step. No failed transactions.
- **Fee grant lifecycle** — issue, track, revoke. Batch operations. Per-subscriber status. The full lifecycle works.
- **39 RPC health checks** — the tool knows which chain endpoints are healthy before you make your first query.

---

## Build Your Business

The SDK manifesto ends with: *"Build something that matters."*

The Plan Manager says: **"Build something that earns."**

Not because profit is the point — but because sustainable businesses are what keep decentralized networks alive. Node operators need revenue to keep running nodes. Builders need revenue to keep building tools. Users need affordable access to keep using the network. The flywheel runs on commerce.

Every plan you create is a storefront on the decentralized internet. Every subscriber is someone who chose your curation, your pricing, your node selection — over doing it themselves. Every P2P token that flows through your plan is proof that decentralized bandwidth is not just technically possible, but economically viable.

The protocol is open. The blockchain is public. The nodes are running.

**Create your plan. Set your price. Open your doors.**

---

*Plan Manager — The commerce layer of the decentralized internet.*

*One wallet. One plan. One thousand subscribers. No permission required.*

*Bandwidth is infrastructure. Commerce is what makes it sustainable.*
