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
//
// Reload law: near-connect (and sandbox/daemon wallets) RELOAD the page
// after signing — kitSwap's in-page promise never resolves post-tx. So
// kitSwap persists {intent, txHashes} to sessionStorage BEFORE awaiting,
// and kitSwapResult() recovers the result after the reload. The swap
// button flow is: call kitSwap (fire it), on next mount call
// kitSwapResult() and clear it.

import { RpcClient } from "../core/rpc.js";
import { DefiKit } from "../core/adapter.js";
import type { Quote, SwapIntent } from "../core/adapter.js";
export type { Quote, SwapIntent } from "../core/adapter.js";
import { ClmmV5Adapter } from "../adapters/clmm/index.js";
import type { ClmmPoolCfg } from "../adapters/clmm/index.js";
import { NearConnectSigner } from "../wallet/near-connect.js";
import { NearKitQwikSigner } from "../wallet/near-kit-qwik-signer.js";
import { parseUsed } from "../core/signer.js";

/** Everything the kit needs, as plain JSON — the only thing you keep in signals/stores. */
export type KitJson = {
  network: "mainnet" | "testnet";
  rpcEndpoint?: string;
  clmmPools?: ClmmPoolCfg[];
  /** register the loopback agent wallet (desktop only) */
  agentWallet?: boolean;
  /**
   * Which wallet layer signs. "near-connect" (default) = @fastnear/
   * near-connect, kit owns the picker. "near-kit-qwik" = sign through an
   * existing near-kit-qwik session (app owns connect/disconnect; the kit
   * never opens a second connector — one wallet library per app).
   */
  signer?: "near-connect" | "near-kit-qwik";
};

const SWAP_STORE_KEY = "defi-kit:swap-in-flight";

function buildRpc(cfg: KitJson): RpcClient {
  return cfg.rpcEndpoint ? new RpcClient(cfg.rpcEndpoint) : RpcClient.forNetwork(cfg.network);
}

export function makeSigner(cfg: KitJson): NearConnectSigner | NearKitQwikSigner {
  if (cfg.signer === "near-kit-qwik") {
    return new NearKitQwikSigner({ cfg: { network: cfg.network } });
  }
  return new NearConnectSigner({
    network: cfg.network,
    ...(cfg.agentWallet !== undefined ? { agentWallet: cfg.agentWallet } : {}),
  });
}

function makeKit(cfg: KitJson): DefiKit {
  const rpc = buildRpc(cfg);
  const kit = new DefiKit({ rpc, signer: makeSigner(cfg) });
  if (cfg.clmmPools) kit.register(new ClmmV5Adapter(rpc, cfg.clmmPools));
  return kit;
}

/** Best quote across the config's adapters. Null = no route. */
export async function kitQuote(cfg: KitJson, intent: SwapIntent): Promise<Quote | null> {
  const kit = makeKit(cfg);
  const best = await kit.bestQuote(intent);
  return best ? best.quote : null;
}

/** Connect the wallet (opens the picker). Returns the accountId — store THAT, not the wallet. */
export async function kitConnect(cfg: KitJson): Promise<string | null> {
  const signer = makeSigner(cfg);
  return signer.connect();
}

/** Restore accountId from a live session (call in useVisibleTask$ on load). */
export async function kitAccountId(cfg: KitJson): Promise<string | null> {
  const signer = makeSigner(cfg);
  return signer.accountId();
}

export async function kitDisconnect(cfg: KitJson): Promise<void> {
  const signer = makeSigner(cfg);
  await signer.disconnect();
}

export type SwapResult = {
  txHashes: string[];
  quote: Quote;
  /** per signed leg — narrow on `status`; "rejected" means the pool refunded everything */
  legs: SwapLeg[];
};

/** Discriminated per-leg outcome. Replaces the old raw `used:<n>` strings. */
export type SwapLeg =
  | { status: "filled"; /** raw u128 the pool consumed */ used: string }
  | { status: "rejected" }
  | { status: "unknown" };

function toLegs(used: Array<string | null>): SwapLeg[] {
  return used.map(u => {
    if (u === null) return { status: "unknown" as const };
    if (u === "0") return { status: "rejected" as const };
    return { status: "filled" as const, used: u };
  });
}

type InFlightSwap = {
  intent: SwapIntent;
  adapterId?: string | undefined;
  quote?: Quote;
  txHashes?: string[];
  startedAt: number;
};

function saveInFlight(s: InFlightSwap): void {
  try {
    sessionStorage.setItem(SWAP_STORE_KEY, JSON.stringify(s));
  } catch {
    // private mode / storage denied — recovery just won't work; swap still runs
  }
}

function loadInFlight(): InFlightSwap | null {
  try {
    const raw = sessionStorage.getItem(SWAP_STORE_KEY);
    return raw ? (JSON.parse(raw) as InFlightSwap) : null;
  } catch {
    return null;
  }
}

/**
 * quote → min-out check → sign + send. THE swap path.
 *
 * The {intent, txHashes} pair is persisted to sessionStorage the moment the
 * tx leaves — when the wallet reloads the page mid-swap (sandbox/daemon
 * wallets do), call kitSwapResult() on the fresh mount to recover.
 * Throws before sending on bad quote.
 */
export async function kitSwap(
  cfg: KitJson,
  /** minOut is REQUIRED here — the compiler, not a convention, enforces the money-safety law */
  intent: SwapIntent & { minOut: string },
  adapterId?: string,
): Promise<SwapResult> {
  saveInFlight({ intent, adapterId, startedAt: Date.now() });
  const kit = makeKit(cfg);
  const { txHashes, quote } = await kit.swap(intent, adapterId);
  saveInFlight({ intent, adapterId, quote, txHashes, startedAt: Date.now() });
  return resolveSwap(cfg, { intent, adapterId, quote, txHashes, startedAt: Date.now() });
}

/**
 * Recover an in-flight swap after the wallet's post-signature page reload.
 * Three outcomes:
 *   - full SwapResult (hashes survived the signer stash) → used parsed
 *   - { status: "submitted", intent } → signed, hash unreachable (sandbox
 *     wallets reload the page faster than the outcome lands; no indexer
 *     dependency is acceptable here) — show "check the explorer"
 *   - null → nothing in flight
 * Clears the store on completion. Call on mount (useVisibleTask$);
 * staleness cutoff 10 minutes.
 */
export type SwapRecovery =
  | ({ status: "completed" } & SwapResult)
  | { status: "submitted"; intent: SwapIntent };

export async function kitSwapResult(cfg: KitJson): Promise<SwapRecovery | null> {
  const s = loadInFlight();
  // hashes may land in the signer's stash even when the reload killed the
  // swap promise before kit.swap() returned — merge both sources
  let hashes = s?.txHashes;
  try {
    const raw = sessionStorage.getItem("defi-kit:last-tx-hashes");
    if (raw) {
      const { hashes: stashed, at } = JSON.parse(raw) as { hashes: string[]; at: number };
      if (Date.now() - at < 10 * 60 * 1000 && stashed.length && (!hashes || !hashes.length)) {
        hashes = stashed;
      }
    }
  } catch {
    // ignore — fall back to in-flight record only
  }
  const clear = () => {
    sessionStorage.removeItem(SWAP_STORE_KEY);
    sessionStorage.removeItem("defi-kit:last-tx-hashes");
  };
  if (!s) return null;
  // NOTE: a mid-swap reload (right after signing) leaves quote AND hashes
  // unset — that is the normal "submitted" case, not garbage. Only
  // staleness clears.
  if (Date.now() - s.startedAt > 10 * 60 * 1000) {
    clear();
    return null;
  }
  if (!hashes) {
    // signed but the hash never landed in-page — do NOT guess it
    const intent = s.intent;
    clear();
    return { status: "submitted", intent };
  }
  const result = await resolveSwap(cfg, { ...s, txHashes: hashes });
  clear();
  return { status: "completed", ...result };
}

async function resolveSwap(cfg: KitJson, s: InFlightSwap): Promise<SwapResult> {
  const kit = makeKit(cfg);
  const account = await makeSigner(cfg).accountId();
  const used: Array<string | null> = [];
  for (const h of s.txHashes ?? []) {
    const sv = account ? await kit.rpc.findSuccessValue(h, account) : null;
    used.push(sv ? (/^used:(\d+)$/.exec(sv.trim())?.[1] ?? null) : null);
  }
  return { txHashes: s.txHashes ?? [], quote: s.quote as Quote, legs: toLegs(used) };
}

export { parseUsed };
