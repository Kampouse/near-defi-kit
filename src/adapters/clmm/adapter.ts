// adapters/clmm — CLMM v5 protocol adapter.
//
// Quote law (from the live pool3/pool7 deployments): the on-chain `quote`
// verb is THE quote. The Pool twin (pool.ts, byte-parity port of the Lisp
// contract) is advisory-only — its hydrated states have drifted before, so
// twin disagreement never gates execution. Money-safety at execution =
// min-out against the FRESH chain quote, enforced by the contract's `mo`
// msg field (full revert incl. fees on breach).

import { Pool } from "./pool.js";
import type { RpcClient } from "../../core/rpc.js";
import { fnCall, scanReceipts } from "../../core/signer.js";
import type { TxOutcome } from "../../core/signer.js";
import type { ProtocolAdapter, Quote, SwapIntent, TxRequest } from "../../core/adapter.js";
import { ftTransferCall } from "../../core/tokens.js";

export const SWAP_GAS = "300000000000000";
export const ONE_YOCTO = "1";

export type ClmmPoolCfg = {
  id: string;
  tokx: { addr: string; symbol: string; decimals: number };
  toky: { addr: string; symbol: string; decimals: number };
  tag?: string;
};

export class ClmmV5Adapter implements ProtocolAdapter {
  readonly id: string;
  readonly rpc: RpcClient;
  readonly cfgs: ClmmPoolCfg[];
  /**
   * Decimal law: config decimals are display hints, not truth. On the first
   * quote/swap the adapter fetches each token's ft_metadata and THROWS on a
   * mismatch — wrong decimals silently corrupt every human-facing number and
   * min-out conversion (caught live: TOKN is 15 dec, config said 24).
   */
  private decimalsVerified: Promise<void> | null = null;

  constructor(rpc: RpcClient, cfgs: ClmmPoolCfg | ClmmPoolCfg[], adapterId = "clmm-v5") {
    this.id = adapterId;
    this.rpc = rpc;
    this.cfgs = Array.isArray(cfgs) ? cfgs : [cfgs];
    this.decimalsVerified = this.verifyDecimals();
  }

  private async verifyDecimals(): Promise<void> {
    const seen = new Set<string>();
    for (const c of this.cfgs) {
      for (const t of [c.tokx, c.toky]) {
        if (seen.has(t.addr)) continue;
        seen.add(t.addr);
        let meta: { decimals?: number };
        try {
          meta = (await this.rpc.view(t.addr, "ft_metadata", {})) as { decimals?: number };
        } catch (e) {
          throw new Error(
            `clmm-v5: ft_metadata failed for ${t.addr} (${String(e).slice(0, 80)}) — fix the address; decimals cannot be trusted blind`,
          );
        }
        if (typeof meta.decimals !== "number" || meta.decimals !== t.decimals) {
          throw new Error(
            `clmm-v5: decimals mismatch for ${t.symbol} (${t.addr}): config says ${t.decimals}, contract says ${meta.decimals} — fix the config`,
          );
        }
      }
    }
  }

  private async ready(): Promise<void> {
    await this.decimalsVerified;
  }

  cfgFor(from: string, to: string): ClmmPoolCfg | null {
    return (
      this.cfgs.find(
        (c) =>
          (c.tokx.addr === from && c.toky.addr === to) ||
          (c.toky.addr === from && c.tokx.addr === to),
      ) ?? null
    );
  }

  private async fetchState(poolId: string): Promise<{ raw: string; twin: Pool }> {
    const raw = await this.rpc.view(poolId, "get_state", {});
    return { raw, twin: Pool.fromState(raw) };
  }

  /** on-chain quote — THE number. Throws when the wire format breaks. */
  async chainQuote(
    poolId: string,
    amt: bigint,
    dir: "x" | "y",
    shift: bigint,
  ): Promise<{ out: bigint; fee: bigint }> {
    const fee = amt >> shift;
    const v = amt - fee;
    const raw = (
      await this.rpc.view(poolId, "quote", {
        v: dir === "x" ? v.toString() : "-" + v.toString(),
      })
    ).replace(/"/g, "");
    const m = /^q:(\d+):rm:(\d+)$/.exec(raw);
    if (!m) throw new Error(`chain quote unparsable: ${raw.slice(0, 80)}`);
    return { out: BigInt(m[1]), fee };
  }

  async getQuote(intent: SwapIntent): Promise<Quote | null> {
    await this.ready();
    const cfg = this.cfgFor(intent.from, intent.to);
    if (!cfg) return null;
    const dir: "x" | "y" = cfg.tokx.addr === intent.from ? "x" : "y";
    const amt = BigInt(intent.amount);
    if (amt <= 0n) return null;
    const { twin } = await this.fetchState(cfg.id);
    const shift = BigInt(twin.s.get("6|SHIFT") || "8");
    const q = await this.chainQuote(cfg.id, amt, dir, shift);
    return { out: q.out.toString(), fee: q.fee.toString(), route: `clmm-v5:${cfg.id}` };
  }

  async buildSwapTx(intent: SwapIntent, _quote: Quote): Promise<TxRequest[]> {
    await this.ready();
    const cfg = this.cfgFor(intent.from, intent.to);
    if (!cfg) throw new Error(`no clmm pool for ${intent.from}/${intent.to}`);
    // min-out rides in the msg — the contract reverts EVERYTHING (escrow,
    // books, P/S, fee) when out < mo. Contract msg format is JSON:
    // {"a":"swap","mo":"<raw>"} — mo as string for u128 precision; the
    // `mo:<raw>` wire form is receipts/parse law, not the tx msg.
    const msg = JSON.stringify({ a: "swap", mo: intent.minOut ? intent.minOut : "0" });
    return [ftTransferCall(intent.from, cfg.id, intent.amount, msg)];
  }

  /** escrow-custody sanity: escrow slices must equal the pool's token balances. */
  async custodyCheck(poolId: string): Promise<{ x: boolean; y: boolean; escx: bigint; escy: bigint }> {
    const raw = await this.rpc.view(poolId, "get_state", {});
    const escx = BigInt(/ESCX:([0-9]+)/.exec(raw)![1]);
    const escy = BigInt(/ESCY:([0-9]+)/.exec(raw)![1]);
    const cfg = this.cfgs.find((c) => c.id === poolId);
    if (!cfg) throw new Error(`pool ${poolId} not in adapter config`);
    const [bx, by] = await Promise.all([
      this.rpc.ftBalanceOf(cfg.tokx.addr, poolId),
      this.rpc.ftBalanceOf(cfg.toky.addr, poolId),
    ]);
    return { x: escx === bx, y: escy === by, escx, escy };
  }

  /** both one-sided liquidity legs as ONE wallet approval (two txs, one signature) */
  async buildAddLiquidityTx(intent: {
    poolId: string;
    legs: Array<{ token: string; amount: string; msg?: string }>;
  }): Promise<TxRequest[]> {
    return intent.legs.map((l) => ftTransferCall(l.token, intent.poolId, l.amount, l.msg ?? ""));
  }

  /** pool authority ops (burn/collect/register) — public verb exports, NOT `exec` */
  buildPoolOpTx(poolId: string, method: "burn" | "collect" | "register", args: object = {}): TxRequest[] {
    // 300T: burn spawns a deeper receipt chain (escrow + resolve) than the
    // old 150T budget; unused gas refunds, so over-attach is free.
    return [{ receiverId: poolId, actions: [fnCall(method, args, SWAP_GAS, ONE_YOCTO)] }];
  }

  /** pull `used:<kept>` out of a swap/leg outcome (soft-fail law: check, don't trust status) */
  parseSwapUsed(outcome: TxOutcome): string | null {
    return scanReceipts(outcome, /^used:(\d+)$/);
  }
}
