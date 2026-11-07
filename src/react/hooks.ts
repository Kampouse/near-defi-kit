// react/hooks.ts — thin React glue over the kit. React is a PEER dep:
// core never imports react, this entry does.

import { useEffect, useState, useCallback, type ReactNode, type JSX } from "react";
import { NearConnectSigner } from "../wallet/near-connect.js";
import { DefiKit } from "../core/adapter.js";
import { RpcClient } from "../core/rpc.js";
import { ClmmV5Adapter } from "../adapters/clmm/index.js";
import type { ClmmPoolCfg } from "../adapters/clmm/index.js";
import type { ProtocolAdapter } from "../core/adapter.js";
import type { TxOutcome } from "../core/signer.js";

export type KitProviderProps = {
  network: "mainnet" | "testnet";
  /** rpc endpoint override (defaults to fastnear for the network) */
  rpcEndpoint?: string;
  /** register the loopback agent wallet */
  agentWallet?: boolean;
  /** extra adapters beyond the clmm-v5 default set */
  adapters?: ProtocolAdapter[];
  /** clmm pools to expose; omit = no clmm adapter */
  clmmPools?: ClmmPoolCfg[];
  children: ReactNode;
};

type KitCtx = { kit: DefiKit; signer: NearConnectSigner };

const Ctx = { current: null as KitCtx | null };

/** Create the kit once per app (call in your root component, pass to <KitProvider ctx>). */
export function createKit(opts: {
  network: "mainnet" | "testnet";
  rpcEndpoint?: string;
  agentWallet?: boolean;
  clmmPools?: ClmmPoolCfg[];
  adapters?: ProtocolAdapter[];
}): KitCtx {
  const rpc = opts.rpcEndpoint ? new RpcClient(opts.rpcEndpoint) : RpcClient.forNetwork(opts.network);
  const signer = new NearConnectSigner({ network: opts.network, agentWallet: opts.agentWallet });
  const kit = new DefiKit({ rpc, signer });
  if (opts.clmmPools) kit.register(new ClmmV5Adapter(rpc, opts.clmmPools));
  for (const a of opts.adapters ?? []) kit.register(a);
  return { kit, signer };
}

export function KitProvider({ ctx, children }: { ctx: KitCtx; children: ReactNode }): JSX.Element {
  Ctx.current = ctx;
  return children as JSX.Element;
}

export function useKit(): KitCtx {
  const ctx = Ctx.current;
  if (!ctx) throw new Error("kit not initialized — call createKit() and mount <KitProvider ctx=…>");
  return ctx;
}

export function useAccount(): { account: string | null; loading: boolean; connect: () => Promise<void>; disconnect: () => Promise<void> } {
  const { signer } = useKit();
  const [account, setAccount] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setAccount(await signer.accountId());
    setLoading(false);
  }, [signer]);
  useEffect(() => {
    void refresh();
    signer.onAccountChange(() => void refresh());
  }, [refresh, signer]);
  return {
    account,
    loading,
    connect: async () => {
      await signer.connect();
      await refresh();
    },
    disconnect: async () => {
      await signer.disconnect();
      await refresh();
    },
  };
}

/** poll any async getter — pool state, quotes, balances */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], pollMs = 0): { data: T | null; error: Error | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const run = async () => {
      try {
        const d = await fn();
        if (alive) {
          setData(d);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e : new Error(String(e)));
      }
    };
    void run();
    let timer: ReturnType<typeof setInterval> | null = null;
    if (pollMs > 0) timer = setInterval(run, pollMs);
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps]);
  return { data, error, reload: () => setTick((t) => t + 1) };
}
