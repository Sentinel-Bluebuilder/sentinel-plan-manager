// ─── Constants ───────────────────────────────────────────────────────────────
// Chain config, LCD endpoints, protobuf type URLs, defaults.

export const PORT = 3003;
export const RPC = 'https://rpc.sentinel.co:443';
export const COINGECKO = 'https://api.coingecko.com/api/v3';
export const GAS_PRICE_STR = '0.2udvpn';
export const CHAIN_ID = 'sentinelhub-2';

// ─── LCD Failover Endpoints ──────────────────────────────────────────────────
export const LCD_ENDPOINTS = [
  'https://lcd.sentinel.co',
  'https://api.sentinel.quokkastake.io',
  'https://sentinel-api.polkachu.com',
  'https://sentinel.api.trivium.network:1317',
];

// ─── V3 Protobuf Type URLs ──────────────────────────────────────────────────
export const MSG_LINK_TYPE = '/sentinel.plan.v3.MsgLinkNodeRequest';
export const MSG_UNLINK_TYPE = '/sentinel.plan.v3.MsgUnlinkNodeRequest';
export const MSG_CREATE_PLAN_TYPE = '/sentinel.plan.v3.MsgCreatePlanRequest';
export const MSG_REGISTER_PROVIDER_TYPE = '/sentinel.provider.v3.MsgRegisterProviderRequest';
export const MSG_UPDATE_PROVIDER_DETAILS_TYPE = '/sentinel.provider.v3.MsgUpdateProviderDetailsRequest';
export const MSG_UPDATE_PROVIDER_STATUS_TYPE = '/sentinel.provider.v3.MsgUpdateProviderStatusRequest';
export const MSG_START_LEASE_TYPE = '/sentinel.lease.v1.MsgStartLeaseRequest';
export const MSG_END_LEASE_TYPE = '/sentinel.lease.v1.MsgEndLeaseRequest';
export const MSG_UPDATE_PLAN_STATUS_TYPE = '/sentinel.plan.v3.MsgUpdatePlanStatusRequest';
export const MSG_START_SUBSCRIPTION_TYPE = '/sentinel.subscription.v3.MsgStartSubscriptionRequest';
export const MSG_SUB_START_SESSION_TYPE = '/sentinel.subscription.v3.MsgStartSessionRequest';
export const MSG_PLAN_START_SESSION_TYPE = '/sentinel.plan.v3.MsgStartSessionRequest';

// ─── Node Cache ──────────────────────────────────────────────────────────────
export const NODE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ─── RPC Providers (for health check) ────────────────────────────────────────
export const RPC_PROVIDERS = [
  'https://rpc.sentinel.co',
  'https://sentinel-rpc.polkachu.com',
  'https://sentinel-rpc.publicnode.com',
  'https://rpc.sentinel.quokkastake.io',
  'https://sentinel.rpc.nodeshub.online',
  'https://rpc-sentinel.busurnode.com',
  'https://sentinel-rpc.validatornode.com',
  'https://sentinel-rpc.openbitlab.com',
  'https://rpc-sentinel.whispernode.com',
  'https://sentinel-rpc.badgerbite.io',
  'https://rpc.sentinel.chaintools.tech',
  'https://sentinel-rpc.lavenderfive.com',
  'https://rpc.sentinel.silentvalidator.com',
  'https://sentinel-rpc.staketab.org',
  'https://sentinel-mainnet-rpc.autostake.com',
  'https://rpc.mathnodes.com',
  'https://sentinel-rpc.w3coins.io',
  'https://sentinel-rpc.takeshi.team',
  'https://sentinel-rpc.0base.dev',
  'https://rpc.dvpn.roomit.xyz',
  'https://sentinel-rpc.ibs.team',
  'https://sentinel-rpc.cogwheel.zone',
  'https://rpc.trinityvalidator.com',
  'https://sentinel-rpc.stakeandrelax.net',
  'https://sentinel-rpc.chainflow.io',
  'https://rpc.sentinel.dragonstake.io',
  'https://sentinel-rpc.highstakes.ch',
  'https://rpc-sentinel-ia.cosmosia.com',
  'https://sentinel-rpc.noders.services',
  'https://sentinel-rpc.declab.pro',
  'https://sentinel-rpc.sr20de.xyz',
  'https://rpc.sentinel.bronbro.io',
];

// ─── RPC Health Check Endpoints ──────────────────────────────────────────────
export const RPC_ENDPOINTS = [
  // Sentinel VPN modules
  { category: 'Node', method: 'GET', path: '/sentinel/node/v3/nodes?pagination.limit=1', desc: 'List all nodes' },
  { category: 'Node', method: 'GET', path: '/sentinel/node/v3/nodes?status=1&pagination.limit=1', desc: 'Active nodes' },
  { category: 'Node', method: 'GET', path: '/sentinel/node/v3/nodes?status=2&pagination.limit=1', desc: 'Inactive nodes' },
  { category: 'Node', method: 'GET', path: '/sentinel/node/v3/params', desc: 'Node params' },
  { category: 'Node', method: 'GET', path: '/sentinel/node/v3/plans/36/nodes?pagination.limit=1', desc: 'Nodes for plan' },
  { category: 'Plan', method: 'GET', path: '/sentinel/plan/v3/plans?pagination.limit=1', desc: 'List all plans' },
  { category: 'Plan', method: 'GET', path: '/sentinel/plan/v3/plans/36', desc: 'Single plan by ID' },
  { category: 'Provider', method: 'GET', path: '/sentinel/provider/v2/providers?pagination.limit=1', desc: 'List providers' },
  { category: 'Provider', method: 'GET', path: '/sentinel/provider/v2/params', desc: 'Provider params' },
  { category: 'Subscription', method: 'GET', path: '/sentinel/subscription/v3/subscriptions?pagination.limit=1', desc: 'List subscriptions' },
  { category: 'Subscription', method: 'GET', path: '/sentinel/subscription/v3/params', desc: 'Subscription params' },
  { category: 'Subscription', method: 'GET', path: '/sentinel/subscription/v3/plans/36/subscriptions?pagination.limit=1', desc: 'Subscriptions for plan' },
  { category: 'Session', method: 'GET', path: '/sentinel/session/v3/sessions?pagination.limit=1', desc: 'List sessions' },
  { category: 'Session', method: 'GET', path: '/sentinel/session/v3/params', desc: 'Session params' },
  { category: 'Payout', method: 'GET', path: '/sentinel/subscription/v3/payouts?pagination.limit=1', desc: 'List payouts' },
  // Cosmos SDK standard
  { category: 'Bank', method: 'GET', path: '/cosmos/bank/v1beta1/supply', desc: 'Total supply' },
  { category: 'Bank', method: 'GET', path: '/cosmos/bank/v1beta1/params', desc: 'Bank params' },
  { category: 'Staking', method: 'GET', path: '/cosmos/staking/v1beta1/validators?pagination.limit=1', desc: 'List validators' },
  { category: 'Staking', method: 'GET', path: '/cosmos/staking/v1beta1/pool', desc: 'Staking pool' },
  { category: 'Staking', method: 'GET', path: '/cosmos/staking/v1beta1/params', desc: 'Staking params' },
  { category: 'Distribution', method: 'GET', path: '/cosmos/distribution/v1beta1/params', desc: 'Distribution params' },
  { category: 'Distribution', method: 'GET', path: '/cosmos/distribution/v1beta1/community_pool', desc: 'Community pool' },
  { category: 'Governance', method: 'GET', path: '/cosmos/gov/v1beta1/proposals?pagination.limit=1', desc: 'List proposals' },
  { category: 'Governance', method: 'GET', path: '/cosmos/gov/v1beta1/params/voting', desc: 'Voting params' },
  { category: 'Slashing', method: 'GET', path: '/cosmos/slashing/v1beta1/params', desc: 'Slashing params' },
  { category: 'Mint', method: 'GET', path: '/cosmos/mint/v1beta1/inflation', desc: 'Inflation rate' },
  { category: 'Mint', method: 'GET', path: '/cosmos/mint/v1beta1/params', desc: 'Mint params' },
  { category: 'Auth', method: 'GET', path: '/cosmos/auth/v1beta1/params', desc: 'Auth params' },
  { category: 'IBC', method: 'GET', path: '/ibc/core/channel/v1/channels?pagination.limit=1', desc: 'IBC channels' },
  { category: 'IBC', method: 'GET', path: '/ibc/core/connection/v1/connections?pagination.limit=1', desc: 'IBC connections' },
  { category: 'IBC', method: 'GET', path: '/ibc/apps/transfer/v1/params', desc: 'IBC transfer params' },
  { category: 'IBC', method: 'GET', path: '/ibc/apps/transfer/v1/denom_traces?pagination.limit=5', desc: 'IBC denom traces' },
  { category: 'Base', method: 'GET', path: '/cosmos/base/tendermint/v1beta1/node_info', desc: 'Node info (chain version)' },
  { category: 'Base', method: 'GET', path: '/cosmos/base/tendermint/v1beta1/syncing', desc: 'Sync status' },
  { category: 'Base', method: 'GET', path: '/cosmos/base/tendermint/v1beta1/blocks/latest', desc: 'Latest block' },
  { category: 'Tx', method: 'GET', path: '/cosmos/tx/v1beta1/txs?events=message.module%3D%27vpn%27&pagination.limit=1', desc: 'Search VPN txs' },
  { category: 'Upgrade', method: 'GET', path: '/cosmos/upgrade/v1beta1/current_plan', desc: 'Current upgrade plan' },
  { category: 'Params', method: 'GET', path: '/cosmos/params/v1beta1/params?subspace=vpn&key=deposit', desc: 'VPN deposit param' },
];
