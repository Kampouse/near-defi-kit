// wallet/near-kit-qwik-signer.ts — Signer implementation over the
// near-kit-qwik wrapper (github.com/Kampouse/near-kit-qwik, @hot-labs/
// near-connect + near-kit stack).
//
// Use this when your Qwik app ALREADY owns its wallet session through
// near-kit-qwik (connect/getSession/disconnect) — the defi-kit adapters
// then sign through THAT session instead of spawning a second connector
// (two connector libs in one app = dual pickers, split session state).
// Peer dep: near-kit-qwik (loaded lazily; core never imports it).
//
// near-kit-qwik is required ≥ 0.3.1 for the gas passthrough on call ops —
// ft_transfer_call legs need ≥285 Tgas and near-kit's default is lower.

import type { Signer, TxRequest, TxOutcome } from "../core/signer.js";
import { fnCall } from "../core/signer.js";

type NearKitQwik = {
  call: (cfg: unknown, contractId: string, method: string, args: object,
    opts: { attachedDeposit?: string; gas?: string }) => Promise<unknown>;
  batch: (cfg: unknown, ops: Array<{ kind: "call"; contract: string; method: string;
    args: object; deposit?: string; gas?: string }>) => Promise<unknown>;
};

export type NearKitQwikSignerOptions = {
  /** near-kit-qwik NearConfig — JSON, stored by your component */
  cfg: { network: unknown; accountId?: string };
};

export class NearKitQwikSigner implements Signer {
  private cfg: { network: unknown; accountId?: string };
  private mod: NearKitQwik | null = null;

  constructor(opts: NearKitQwikSignerOptions) {
    this.cfg = opts.cfg;
  }

  private async lib(): Promise<NearKitQwik> {
    if (!this.mod) {
      this.mod = (await import(
        /* @vite-ignore */ "near-kit-qwik"
      )) as unknown as NearKitQwik;
    }
    return this.mod;
  }

  async accountId(): Promise<string | null> {
    const { getSession } = (await import(
      /* @vite-ignore */ "near-kit-qwik"
    )) as unknown as { getSession: (cfg: unknown) => Promise<string | null> };
    return getSession(this.cfg);
  }

  /** Delegates to near-kit-qwik's connect — the wrapper owns the picker. */
  async connect(): Promise<string | null> {
    const { connect } = (await import(
      /* @vite-ignore */ "near-kit-qwik"
    )) as unknown as { connect: (cfg: unknown) => Promise<string> };
    return connect(this.cfg);
  }

  async disconnect(): Promise<void> {
    const { disconnect } = (await import(
      /* @vite-ignore */ "near-kit-qwik"
    )) as unknown as { disconnect: (cfg: unknown) => Promise<boolean> };
    await disconnect(this.cfg);
  }

  async sendTransaction(tx: TxRequest): Promise<TxOutcome> {
    const lib = await this.lib();
    if (tx.actions.length !== 1 || tx.actions[0].type !== "FunctionCall") {
      throw new Error("NearKitQwikSigner: one FunctionCall action per tx (batch multi-action ops via core batch semantics)");
    }
    const p = tx.actions[0].params;
    const outcome = (await lib.call(this.cfg, tx.receiverId, p.methodName, p.args,
      { attachedDeposit: p.deposit, gas: tgasOf(p.gas) })) as TxOutcome;
    // near-kit returns a FinalExecutionOutcome — transaction_outcome.id +
    // receipts_outcome ride along, so adapters keep the soft-fail law.
    return outcome;
  }

  async sendTransactions(txs: TxRequest[]): Promise<TxOutcome[]> {
    const lib = await this.lib();
    const groups = new Map<string, TxRequest[]>();
    for (const tx of txs) groups.set(tx.receiverId, [...(groups.get(tx.receiverId) ?? []), tx]);
    const outcomes: TxOutcome[] = [];
    for (const [receiverId, group] of groups) {
      if (group.length === 1) {
        outcomes.push(await this.sendTransaction(group[0]));
        continue;
      }
      // same receiver → ONE atomic batch (near.tx is single-receiver)
      const ops = group.map((tx) => {
        if (tx.actions.length !== 1 || tx.actions[0].type !== "FunctionCall")
          throw new Error("NearKitQwikSigner: non-FunctionCall action");
        const p = tx.actions[0].params;
        return { kind: "call" as const, contract: receiverId, method: p.methodName,
          args: p.args, deposit: p.deposit, gas: tgasOf(p.gas) };
      });
      const outcome = (await lib.batch(this.cfg, ops)) as TxOutcome;
      outcomes.push(outcome);
    }
    return outcomes;
  }
}

/** "300000000000000" (yocto-gas units) → "300 Tgas" for near-kit's Gas parser */
function tgasOf(gas: string): string {
  const t = BigInt(gas) / 1_000_000_000_000n;
  return `${t} Tgas`;
}

export { fnCall };
