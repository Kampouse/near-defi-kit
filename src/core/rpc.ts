// core/rpc.ts — pure RPC layer, no wallet imports. Node 18+ and browser safe.
//
// Permissionless law: everything here talks to public RPC endpoints over
// plain JSON-RPC. No API keys, no backend, no CORS tricks — a static site
// can run the whole kit.

export type RpcOptions = {
  endpoint: string;
  /** finality for view calls — "optimistic" = freshest, may flip under reorg */
  finality?: "optimistic" | "final" | "near-final";
};

export const DEFAULT_RPC: Record<string, string> = {
  mainnet: "https://rpc.mainnet.fastnear.com",
  testnet: "https://rpc.testnet.fastnear.com",
};

export class RpcClient {
  readonly endpoint: string;
  readonly finality: "optimistic" | "final" | "near-final";
  private inflight = new Map<string, Promise<string>>();

  constructor(opts: RpcOptions | string) {
    if (typeof opts === "string") opts = { endpoint: opts };
    this.endpoint = opts.endpoint;
    this.finality = opts.finality ?? "optimistic";
  }

  static forNetwork(network: "mainnet" | "testnet"): RpcClient {
    return new RpcClient(DEFAULT_RPC[network]);
  }

  /**
   * View call returning the RAW result string. Callers parse their own
   * wire formats — the kit never guesses a contract's schema.
   * In-flight dedupe: identical concurrent views share one request.
   */
  view(contract: string, method: string, args: unknown): Promise<string> {
    const key = contract + "|" + method + "|" + JSON.stringify(args);
    const hit = this.inflight.get(key);
    if (hit) return hit;
    const p = this.doView(contract, method, args).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, p);
    return p;
  }

  private async doView(contract: string, method: string, args: unknown): Promise<string> {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "v",
        method: "query",
        params: {
          request_type: "call_function",
          account_id: contract,
          method_name: method,
          args_base64: btoa(JSON.stringify(args)),
          finality: this.finality,
        },
      }),
    });
    const j = await res.json();
    if (j.error) throw new Error(JSON.stringify(j.error));
    return (j.result.result as number[]).map((c) => String.fromCharCode(c)).join("");
  }

  /** Parse a JSON-returning view (contracts that return real JSON). */
  async viewJson<T>(contract: string, method: string, args: unknown): Promise<T> {
    const raw = await this.view(contract, method, args);
    return JSON.parse(raw) as T;
  }

  /** NEP-141 balance as raw BigInt string. */
  async ftBalanceOf(token: string, account: string): Promise<bigint> {
    const raw = await this.view(token, "ft_balance_of", { account_id: account });
    return BigInt(raw.replace(/"/g, "") || "0");
  }

  /** Native NEAR balance (view_account.amount). */
  async nativeBalance(account: string): Promise<bigint> {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "n",
        method: "query",
        params: { request_type: "view_account", account_id: account, finality: this.finality },
      }),
    });
    const j = await res.json();
    return BigInt(j.result?.amount ?? "0");
  }

  /**
   * Raw jsonrpc query passthrough — returns the full envelope so callers can
   * distinguish RPC errors from "not found" responses (global-contract
   * lookups signal absence via HANDLER_ERROR, not a clean null).
   */
  async query(requestType: string, params: Record<string, unknown>): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }> {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "q",
        method: "query",
        params: { request_type: requestType, finality: this.finality, ...params },
      }),
    });
    const j = await res.json();
    if (j.error) return { ok: false, error: JSON.stringify(j.error) };
    return { ok: true, result: j.result };
  }

  /**
   * Pull a SuccessValue string out of a tx's receipt chain.
   * Returns null when the tx failed or produced no string result.
   */
  async findSuccessValue(txHash: string, accountId: string): Promise<string | null> {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // RPC law: never let a receipt scan hang the swap path — bounded like
      // every other network call (10 s; shards answer in well under 1 s).
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "s",
        method: "EXPERIMENTAL_tx_status",
        params: [txHash, accountId],
      }),
    });
    const j = await res.json();
    if (j.error) return null;
    const receipts = (j.result?.receipts_outcome ?? []) as Array<{
      outcome?: { status?: { SuccessValue?: string } };
    }>;
    for (const r of receipts) {
      const sv = r.outcome?.status?.SuccessValue;
      if (typeof sv === "string") {
        try {
          return decodeURIComponent(escape(atob(sv)));
        } catch {
          // non-utf8 success value — skip
        }
      }
    }
    return null;
  }
}

// NOTE: load-balanced RPC shards are eventually consistent — if a quote
// looks stale right after a tx, re-query after the next block instead of
// panicking.
