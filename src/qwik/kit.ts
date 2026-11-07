// qwik/kit.ts — Qwik-safe entry: hoisted top-level functions, JSON in,
// JSON out. NO class instances cross a Qwik serialization boundary (they
// die SILENTLY — see the serializer laws). Every function constructs its
// own RpcClient/adapter/signer inside, from the JSON config the component
// stores in a useStore/useSignal.
//
// Usage pattern (in a component):
//   const cfg = useStore<KitJson>({ network: "testnet", clmmPools: [...] });
//   const q = useSignal<Quote | null>(null);
//   const doQuote = $((amount: string) => { q.value = await kitQuote(cfg, intent); });
// Handlers import these hoisted functions; only cfg (JSON) is captured.

import { RpcClient } from "../core/rpc.js";
import { DefiKit } from "../core/adapter.js";
import type { Quote, SwapIntent } from "../core/adapter.js";
import { ClmmV5Adapter } from "../adapters/clmm/index.js";
import type { ClmmPoolCfg } from "../adapters/clmm/index.js";
import { NearConnectSigner } from "../wallet/near-connect.js";
import { parseUsed } from "../core/signer.js";

/** Everything the kit needs, as plain JSON — the only thing you keep in signals/stores. */
export type KitJson = {
  network: "mainnet" | "testnet";
  rpcEndpoint?: string;
  clmmPools?: ClmmPoolCfg[];
  /** register the loopback agent wallet (desktop only) */
  agentWallet?: boolean;
};

function buildRpc(cfg: KitJson): RpcClient {
  return cfg.rpcEndpoint ? new RpcClient(cfg.rpcEndpoint) : RpcClient.forNetwork(cfg.network);
}

/** Best quote across the config's adapters. Null = no route. */
export async function kitQuote(cfg: KitJson, intent: SwapIntent): Promise<Quote | null> {
  const kit = new DefiKit({ rpc: buildRpc(cfg), signer: new NearConnectSigner({ network: cfg.network, agentWallet: cfg.agentWallet }) });
  if (cfg.clmmPools) kit.register(new ClmmV5Adapter(kit.rpc, cfg.clmmPools));
  const best = await kit.bestQuote(intent);
  return best ? best.quote : null;
}

/** Connect the wallet (opens the picker). Returns the accountId — store THAT, not the wallet. */
export async function kitConnect(cfg: KitJson): Promise<string | null> {
  const signer = new NearConnectSigner({ network: cfg.network, agentWallet: cfg.agentWallet });
  return signer.connect();
}

/** Restore accountId from a live session (call in useVisibleTask$ on load). */
export async function kitAccountId(cfg: KitJson): Promise<string | null> {
  const signer = new NearConnectSigner({ network: cfg.network, agentWallet: cfg.agentWallet });
  return signer.accountId();
}

export async function kitDisconnect(cfg: KitJson): Promise<void> {
  const signer = new NearConnectSigner({ network: cfg.network, agentWallet: cfg.agentWallet });
  await signer.disconnect();
}

export type SwapResult = {
  txHashes: string[];
  quote: Quote;
  /** `used:<kept>` values pulled from the receipt chains (null when absent) */
  used: Array<string | null>;
};

/** quote → min-out check → sign + send. THE swap path. Throws before sending on bad quote. */
export async function kitSwap(cfg: KitJson, intent: SwapIntent, adapterId?: string): Promise<SwapResult> {
  const signer = new NearConnectSigner({ network: cfg.network, agentWallet: cfg.agentWallet });
  const kit = new DefiKit({ rpc: buildRpc(cfg), signer });
  if (cfg.clmmPools) kit.register(new ClmmV5Adapter(kit.rpc, cfg.clmmPools));
  const { txHashes, quote } = await kit.swap(intent, adapterId);
  // soft-fail law: pull `used:<kept>` out of each outcome — a "successful"
  // tx can still have been rejected by the pool
  const account = await signer.accountId();
  const used: Array<string | null> = [];
  for (const h of txHashes) {
    const sv = account ? await kit.rpc.findSuccessValue(h, account) : null;
    used.push(sv ? (/^used:(\d+)$/.exec(sv.trim())?.[1] ?? null) : null);
  }
  return { txHashes, quote, used };
}

export { parseUsed };
