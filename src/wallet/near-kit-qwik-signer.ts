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

import type { Signer, TxRequest, TxOutcome, Action } from "../core/signer.js";
import { fnCall } from "../core/signer.js";

type NearKitQwik = {
  call: (cfg: unknown, contractId: string, method: string, args: object,
    opts: { attachedDeposit?: string; gas?: string }) => Promise<unknown>;
  batch: (cfg: unknown, ops: NearKitQwikOp[]) => Promise<unknown>;
};

/** Mirrors near-kit-qwik's Op union (JSON-safe; bytes ride codeB64). */
type NearKitQwikOp =
  | { kind: "transfer"; to: string; amount: bigint }
  | { kind: "call"; contract: string; method: string; args: object; deposit?: string; gas?: string }
  | { kind: "createAccount"; accountId: string }
  | { kind: "deployContract"; accountId: string; codeB64: string }
  | { kind: "publishContract"; codeB64: string; mode: "hash" | "account" }
  | { kind: "useGlobalContract"; accountId?: string; codeHash?: string }
  | { kind: "addKey"; publicKey: string }
  | { kind: "deleteKey"; publicKey: string };

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
    if (tx.actions.length === 1 && tx.actions[0].type === "FunctionCall") {
      const p = tx.actions[0].params;
      const outcome = (await lib.call(this.cfg, tx.receiverId, p.methodName, p.args,
        { attachedDeposit: p.deposit, gas: tgasOf(p.gas) })) as TxOutcome;
      // near-kit returns a FinalExecutionOutcome — transaction_outcome.id +
      // receipts_outcome ride along, so adapters keep the soft-fail law.
      return outcome;
    }
    // raw-action tx (token factory, faucet pattern) — one batch, JSON ops
    const ops = tx.actions.map((a) => toOp(tx.receiverId, a));
    return (await lib.batch(this.cfg, ops)) as TxOutcome;
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
      const ops: NearKitQwikOp[] = [];
      for (const tx of group) ops.push(...tx.actions.map((a) => toOp(receiverId, a)));
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

/** Serialization law: bytes ride codeB64 — Uint8Array dies over JSON. */
function codeB64Of(params: { code?: Uint8Array; codeB64?: string }): string {
  if (typeof params.codeB64 === "string" && params.codeB64.length > 0) return params.codeB64;
  const code = params.code ?? new Uint8Array(0);
  let bin = "";
  for (const b of code) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** TxRequest action → near-kit-qwik Op (all JSON-safe). */
function toOp(receiverId: string, a: Action): NearKitQwikOp {
  switch (a.type) {
    case "FunctionCall": {
      const p = a.params;
      return { kind: "call", contract: receiverId, method: p.methodName, args: p.args,
        deposit: p.deposit, gas: tgasOf(p.gas) };
    }
    case "Transfer":
      return { kind: "transfer", to: receiverId, amount: BigInt(a.params.deposit) };
    case "CreateAccount":
      return { kind: "createAccount", accountId: receiverId };
    case "DeployContract":
      return { kind: "deployContract", accountId: receiverId, codeB64: codeB64Of(a.params) };
    case "DeployGlobalContract":
      return { kind: "publishContract", codeB64: codeB64Of(a.params),
        mode: a.params.deployMode === "AccountId" ? "account" : "hash" };
    case "UseGlobalContract": {
      const id = a.params.contractIdentifier;
      return "accountId" in id
        ? { kind: "useGlobalContract", accountId: id.accountId }
        : { kind: "useGlobalContract", codeHash: id.codeHash };
    }
    case "AddKey":
      return { kind: "addKey", publicKey: a.params.publicKey };
    case "DeleteKey":
      return { kind: "deleteKey", publicKey: a.params.publicKey };
    default: {
      const _exhaustive: never = a;
      throw new Error(`NearKitQwikSigner: unsupported action ${JSON.stringify(_exhaustive)}`);
    }
  }
}

export { fnCall };
