// core/tokens.ts — NEP-141 primitives: metadata, wrap/unwrap, transfer builders.

import type { RpcClient } from "./rpc.js";
import type { Signer } from "./signer.js";
import { fnCall } from "./signer.js";

export type TokenMetadata = {
  symbol: string;
  decimals: number;
  name?: string;
};

export const SWAP_GAS = "300000000000000"; // ft_transfer_call leg: ≥285 Tgas measured
export const ONE_YOCTO = "1";

/**
 * NEP-141 metadata with a defensive default: contracts that skip `spec`
 * fields still yield a usable (symbol, decimals) pair.
 */
export async function tokenMetadata(rpc: RpcClient, token: string): Promise<TokenMetadata> {
  try {
    const meta = await rpc.viewJson<{ symbol?: string; decimals?: number; name?: string }>(
      token, "ft_metadata", {},
    );
    return {
      symbol: meta.symbol ?? token.split(".")[0].toUpperCase(),
      decimals: meta.decimals ?? 24,
      name: meta.name,
    };
  } catch {
    return { symbol: token.split(".")[0].toUpperCase(), decimals: 24 };
  }
}

/** ft_transfer_call builder — the universal "move tokens into a protocol" leg. */
export function ftTransferCall(
  token: string,
  receiverId: string,
  amount: string,
  msg: string,
  gas: string = SWAP_GAS,
) {
  return {
    receiverId: token,
    actions: [fnCall("ft_transfer_call", { receiver_id: receiverId, amount, msg }, gas, ONE_YOCTO)],
  };
}

/** plain ft_transfer (wallet-to-wallet; NOT for protocol deposits) */
export function ftTransfer(token: string, receiverId: string, amount: string, memo?: string) {
  return {
    receiverId: token,
    actions: [fnCall("ft_transfer", { receiver_id: receiverId, amount, memo }, "10000000000000", ONE_YOCTO)],
  };
}

/** storage deposit so an account can hold the token (2 Tgas is plenty) */
export function storageDeposit(token: string, accountIdFor: string, amount: string = "1250000000000000000000") {
  return {
    receiverId: token,
    actions: [fnCall("storage_deposit", { account_id: accountIdFor, registration_only: true }, "10000000000000", amount)],
  };
}

export const WRAP_RESERVE = 10000000000000000000000n; // 0.01 Ⓝ kept back for tx fees

/**
 * wrap-if-short: top wNEAR up to `needed` straight from native NEAR.
 * Returns the wrap tx REQUEST for the signer — null when balance already covers it.
 * Throws a human-readable error when native NEAR can't cover the shortfall.
 */
export async function ensureWrapped(
  rpc: RpcClient,
  signer: Signer,
  wnear: string,
  needed: bigint,
): Promise<{ receiverId: string; actions: ReturnType<typeof fnCall>[] } | null> {
  const account = await signer.accountId();
  if (!account) throw new Error("wallet not connected");
  const have = await rpc.ftBalanceOf(wnear, account);
  if (have >= needed) return null;
  const short = needed - have;
  const native = await rpc.nativeBalance(account);
  if (native < short + WRAP_RESERVE) {
    const f = (v: bigint) => (Number(v) / 1e24).toFixed(4);
    throw new Error(`not enough native NEAR to wrap — need ${f(short)} Ⓝ, have ${f(native)} Ⓝ`);
  }
  return wrapNearTx(wnear, short.toString());
}

/** attach NEAR → mint wNEAR */
export function wrapNearTx(wnear: string, amount: string) {
  return {
    receiverId: wnear,
    actions: [fnCall("near_deposit", {}, "10000000000000", amount, )],
  };
}

/** burn wNEAR → native NEAR back */
export function unwrapNearTx(wnear: string, amount: string) {
  return {
    receiverId: wnear,
    actions: [fnCall("near_withdraw", { amount }, "100000000000000", ONE_YOCTO)],
  };
}
