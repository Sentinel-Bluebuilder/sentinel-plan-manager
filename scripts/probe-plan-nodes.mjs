// Read-only RPC probe: confirm on-chain node-link counts for the plans tied to
// the bundled lease+link e2e verification. RPC-first, no signing, no wallet.
import { getRpcClient, rpcQueryNodesForPlan } from '../lib/chain.js';

const ids = (process.argv.slice(2).map(Number).filter(Number.isFinite));
const PLANS = ids.length ? ids : [36, 262, 264];

const rpc = await getRpcClient();
if (!rpc) {
  console.error('No RPC client');
  process.exit(1);
}

for (const id of PLANS) {
  try {
    // status:0 = ALL plan members (matches the committed server fix), status:1 = active only
    const all = await rpcQueryNodesForPlan(rpc, id, { status: 0, limit: 5000 });
    const active = await rpcQueryNodesForPlan(rpc, id, { status: 1, limit: 5000 });
    console.log(`plan ${id} -> linkedNodes(all)=${all.length} active=${active.length}`);
  } catch (e) {
    console.log(`plan ${id} -> ERR ${e.message}`);
  }
}
process.exit(0);
