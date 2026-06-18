import { Tendermint37Client } from '@cosmjs/tendermint-rpc';
import { QueryClient, setupBankExtension } from '@cosmjs/stargate';

const ADDR = process.argv[2];
const RPC_URL = process.argv[3] || 'https://sentinel-rpc.publicnode.com:443';
if (!ADDR) { console.error('usage: node scripts/check-bal.mjs <sent1...> [rpc-url]'); process.exit(1); }

const tmClient = await Tendermint37Client.connect(RPC_URL);
const qClient = QueryClient.withExtensions(tmClient, setupBankExtension);
const bal = await qClient.bank.balance(ADDR, 'udvpn');
console.log(`[via ${RPC_URL}]`);
console.log(JSON.stringify({
  address: ADDR,
  udvpn: bal.amount,
  P2P: (parseInt(bal.amount, 10) / 1e6).toFixed(6),
}, null, 2));
process.exit(0);
