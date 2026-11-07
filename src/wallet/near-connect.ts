// wallet/near-connect.ts — Signer implementation over @fastnear/near-connect.
// Peer dep: load dynamically so apps that only READ never pull the SDK.

import type { Signer, TxRequest, TxOutcome } from "../core/signer.js";
import { fnCall } from "../core/signer.js";

// minimal structural types — avoid importing the lib at module scope
type NearWalletBase = {
  getAccounts(): Promise<Array<{ accountId: string }>>;
  signAndSendTransaction(tx: TxRequest): Promise<TxOutcome>;
  signAndSendTransactions(txs: { transactions: TxRequest[] }): Promise<TxOutcome[]>;
};
type NearConnectorLike = {
  connect(): Promise<NearWalletBase>;
  getConnectedWallet(): Promise<{ wallet: NearWalletBase }>;
  disconnect(): Promise<void>;
  registerWallet(cfg: unknown): Promise<unknown>;
  on(ev: string, cb: () => void): void;
};

export type NearConnectSignerOptions = {
  network: "mainnet" | "testnet";
  /** register the local agent-wallet daemon (loopback) for machine-driven txs */
  agentWallet?: boolean;
};

export class NearConnectSigner implements Signer {
  private network: string;
  private agentWallet: boolean;
  private connector: NearConnectorLike | null = null;

  constructor(opts: NearConnectSignerOptions) {
    this.network = opts.network;
    this.agentWallet = opts.agentWallet ?? false;
  }

  async getConnector(): Promise<NearConnectorLike> {
    if (!this.connector) {
      const mod = (await import(
        /* @vite-ignore */ "@fastnear/near-connect"
      )) as unknown as {
        NearConnector: new (o: { network: string }) => NearConnectorLike;
      };
      this.connector = new mod.NearConnector({ network: this.network });
      if (this.agentWallet) await this.registerAgentWallet(this.connector);
    }
    return this.connector;
  }

  // local-keys agent wallet: registers ONLY when the daemon is reachable —
  // a wallet row that silently no-ops is worse than no row. On phones/remote
  // origins loopback is wrong/blocked, and that's exactly when it skips.
  private async registerAgentWallet(connector: NearConnectorLike): Promise<void> {
    const origin =
      location.protocol === "https:" ? "https://127.0.0.1:8392" : "http://127.0.0.1:8391";
    let ok = false;
    for (let i = 0; i < 2 && !ok; i++) {
      try {
        const res = await fetch(`${origin}/executor.js`, { signal: AbortSignal.timeout(5000) });
        ok = res.ok;
      } catch {
        ok = false;
      }
    }
    if (!ok) {
      console.warn("[local-keys] daemon unreachable at", origin, "— wallet not registered");
      return;
    }
    await connector
      .registerWallet({
        id: "local-keys",
        name: "Local Keys (agent)",
        description: "Signs with keys on this machine via the local agent wallet daemon",
        version: "1.0.0",
        type: "sandbox",
        platform: [],
        executor: `${origin}/executor.js`,
        permissions: { storage: true, allowsOpen: ["http://127.0.0.1:8391", "https://127.0.0.1:8392"] },
        features: {
          signMessage: false,
          signTransaction: true,
          signAndSendTransaction: true,
          signAndSendTransactions: true,
          signInWithoutAddKey: true,
          signDelegateActions: false,
          addFunctionCallKey: false,
          mainnet: false,
          testnet: true,
        },
      })
      .catch(() => {});
  }

  private async wallet(): Promise<NearWalletBase> {
    const { wallet } = await (await this.getConnector()).getConnectedWallet();
    return wallet;
  }

  async accountId(): Promise<string | null> {
    try {
      const wallet = await this.wallet();
      const accounts = await wallet.getAccounts();
      return accounts[0]?.accountId ?? null;
    } catch {
      return null;
    }
  }

  /** opens the wallet picker; resolves with the account id */
  async connect(): Promise<string | null> {
    const wallet = await (await this.getConnector()).connect();
    const accounts = await wallet.getAccounts();
    return accounts[0]?.accountId ?? null;
  }

  async disconnect(): Promise<void> {
    await (await this.getConnector()).disconnect();
  }

  onAccountChange(cb: () => void): void {
    void this.getConnector().then((c) => {
      c.on("wallet:signIn", cb);
      c.on("wallet:signOut", cb);
    });
  }

  async sendTransaction(tx: TxRequest): Promise<TxOutcome> {
    const wallet = await this.wallet();
    return wallet.signAndSendTransaction(tx);
  }

  async sendTransactions(txs: TxRequest[]): Promise<TxOutcome[]> {
    const wallet = await this.wallet();
    if (txs.length === 1) return [await wallet.signAndSendTransaction(txs[0])];
    return wallet.signAndSendTransactions({ transactions: txs });
  }
}

export { fnCall };
