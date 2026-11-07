// core/signer.ts — the transaction side of the kit.
//
// Adapters NEVER import a wallet library. They receive a `Signer` and build
// plain action objects. This is what makes the kit generic: near-connect,
// a CLI keychain, an iframe wallet — anything implementing Signer works.

export type FunctionCallAction = {
  type: "FunctionCall";
  params: { methodName: string; args: object; gas: string; deposit: string };
};
export type CreateAccountAction = { type: "CreateAccount" };
export type TransferAction = { type: "Transfer"; params: { deposit: string } };
export type DeployContractAction = {
  type: "DeployContract";
  params: { code: Uint8Array; codeB64?: string };
};
export type DeployGlobalContractAction = {
  type: "DeployGlobalContract";
  params: { code: Uint8Array; codeB64?: string; deployMode: "CodeHash" | "AccountId" };
};
export type UseGlobalContractAction = {
  type: "UseGlobalContract";
  params: { contractIdentifier: { accountId: string } | { codeHash: string } };
};
export type AddKeyAction = {
  type: "AddKey";
  params: { publicKey: string; accessKey: { permission: "FullAccess" } };
};
export type DeleteKeyAction = {
  type: "DeleteKey";
  params: { publicKey: string };
};

export type Action =
  | FunctionCallAction
  | CreateAccountAction
  | TransferAction
  | DeployContractAction
  | DeployGlobalContractAction
  | UseGlobalContractAction
  | AddKeyAction
  | DeleteKeyAction;

export type TxRequest = {
  receiverId: string;
  actions: Action[];
};

export type TxOutcome = {
  transaction_outcome: { id: string; outcome: { status?: Record<string, unknown>; gas_burnt?: number } };
  status?: { SuccessValue?: string };
  receipts_outcome?: Array<{ outcome?: { status?: { SuccessValue?: string } } }>;
};

export interface Signer {
  /** null when nothing is connected */
  accountId(): Promise<string | null>;
  sendTransaction(tx: TxRequest): Promise<TxOutcome>;
  sendTransactions(txs: TxRequest[]): Promise<TxOutcome[]>;
}

/** Convenience builder — deposit defaults to 1 yocto (NEP-141 law). */
export function fnCall(
  methodName: string,
  args: object,
  gas: string,
  deposit: string = "1",
): FunctionCallAction {
  return { type: "FunctionCall", params: { methodName, args, gas, deposit } };
}

/** Decode a soft-fail SuccessValue string from an outcome. */
export function decodeResult(outcome: TxOutcome): string {
  const sv =
    outcome.status?.SuccessValue ??
    outcome.receipts_outcome?.map((r) => r.outcome?.status?.SuccessValue).find(
      (v): v is string => typeof v === "string",
    );
  if (!sv) return "";
  try {
    return b64ToUtf8(sv);
  } catch {
    return "";
  }
}

/** Scan the whole receipt chain for a base64 SuccessValue matching `re`. */
export function scanReceipts(outcome: TxOutcome, re: RegExp): string | null {
  const candidates = [
    outcome.status?.SuccessValue,
    ...(outcome.receipts_outcome ?? []).map((r) => r.outcome?.status?.SuccessValue),
  ].filter((v): v is string => typeof v === "string");
  for (const sv of candidates) {
    try {
      const decoded = b64ToUtf8(sv);
      const m = re.exec(decoded.trim());
      if (m) return m[1] ?? null;
    } catch {
      // non-utf8 success value — skip
    }
  }
  return null;
}

/** base64 SuccessValue → utf8. TextDecoder, not the deprecated `escape`. */
export function b64ToUtf8(b64: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}

/** Extract the `used:<kept>` value a ft_transfer_call resolve leg returns. */
export function parseUsed(outcome: TxOutcome): string | null {
  return scanReceipts(outcome, /^used:(\d+)$/);
}
