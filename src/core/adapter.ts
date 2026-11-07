// core/adapter.ts — the plugin contract. A "protocol" is anything that can
// quote a swap and/or manage liquidity. Adapters turn those verbs into
// TxRequests; the frontend decides which adapters to load. Permissionless
// by construction: an adapter is just config (contract addresses) + verbs.

import type { RpcClient } from "./rpc.js";
import type { Signer, TxRequest } from "./signer.js";
export type { TxRequest } from "./signer.js";

export type SwapIntent = {
  /** token the user sells */
  from: string;
  /** token the user buys */
  to: string;
  /** raw amount (BigInt string) */
  amount: string;
  /** min-out floor in raw units — adapters MUST enforce via contract-level mo/slippage */
  minOut?: string;
};

export type Quote = {
  /** raw out amount (BigInt string) */
  out: string;
  /** raw fee amount, when the protocol surfaces one */
  fee?: string;
  /** adapter-defined slug, e.g. "clmm-v5:pool7" */
  route: string;
};

export type LiquidityIntent = {
  poolId: string;
  /** side "x"|"y" or protocol-specific leg descriptors */
  legs: Array<{ token: string; amount: string; msg?: string }>;
};

/**
 * Every protocol adapter implements this. Methods may be unsupported
 * (return null) — a lending adapter implements getQuote via its oracle and
 * returns null for buildAddLiquidity, for example.
 */
export interface ProtocolAdapter {
  readonly id: string;
  /** best-effort quote across the adapter's venues; null = no route */
  getQuote(intent: SwapIntent): Promise<Quote | null>;
  /** executable swap — MUST embed minOut enforcement */
  buildSwapTx(intent: SwapIntent, quote: Quote): Promise<TxRequest[]>;
  /** user's open positions, adapter-shaped (frontend renders generically) */
  getPositions?(account: string): Promise<unknown[]>;
  /** liquidity ops when the venue supports them */
  buildAddLiquidityTx?(intent: LiquidityIntent): Promise<TxRequest[]>;
  buildRemoveLiquidityTx?(intent: { poolId: string; positionId: string; amount?: string }): Promise<TxRequest[]>;
}

export type KitConfig = {
  rpc: RpcClient;
  signer: Signer;
};

/** The kit: inject rpc + signer, register adapters, go. */
export class DefiKit {
  readonly rpc: RpcClient;
  readonly signer: Signer;
  private adapters = new Map<string, ProtocolAdapter>();

  constructor(cfg: KitConfig) {
    this.rpc = cfg.rpc;
    this.signer = cfg.signer;
  }

  register(adapter: ProtocolAdapter): this {
    this.adapters.set(adapter.id, adapter);
    return this;
  }

  adapter(id: string): ProtocolAdapter {
    const a = this.adapters.get(id);
    if (!a) throw new Error(`adapter "${id}" not registered`);
    return a;
  }

  /** best quote across all registered adapters (first non-null wins order) */
  async bestQuote(intent: SwapIntent): Promise<{ adapter: ProtocolAdapter; quote: Quote } | null> {
    for (const a of this.adapters.values()) {
      const q = await a.getQuote(intent);
      if (q) return { adapter: a, quote: q };
    }
    return null;
  }

  /** quote → minOut check → sign+send. THE swap path a frontend should call. */
  async swap(
    intent: SwapIntent,
    adapterId?: string,
  ): Promise<{ txHashes: string[]; quote: Quote }> {
    const pair = adapterId ? { adapter: this.adapter(adapterId) } : await this.bestQuote(intent);
    if (!pair) throw new Error("no route");
    const { adapter, quote } = pair as { adapter: ProtocolAdapter; quote: Quote };
    if (intent.minOut && BigInt(quote.out) < BigInt(intent.minOut)) {
      throw new Error(`quote below min-out: ${quote.out} < ${intent.minOut}`);
    }
    const txs = await adapter.buildSwapTx(intent, quote);
    const outcomes = await this.signer.sendTransactions(txs);
    return { txHashes: outcomes.map((o) => o.transaction_outcome.id), quote };
  }
}
