// qwik/token.ts — token creation through the Qwik serialization boundary.
//
// Qwik serializer law: only JSON crosses the boundary — every entry here is
// a hoisted pure function taking JSON in and returning JSON out.
//
// How it works (global-contract law, zero raw signing):
//   1. kitEnsureTokenCode — wallet-signs ONE DeployGlobalContract tx if the
//      stock ft2 code is not global yet (one-time ~3N burn for 30KB; every
//      later token reuses it for bytes-scale cost).
//   2. kitCreateToken   — wallet-signs TWO transactions:
//        tx1 [CreateAccount, UseGlobalContract, Transfer] → the token
//            account comes into existence carrying the global code. Keyless
//            by design: it never signs anything (owner = caller).
//        tx2 [new, set_metadata, mint] → ft2 sets owner = predecessor, so
//            calling from the connected wallet makes THAT account the
//            mint authority. Mint amount optional (skip = claim-only token).
//
// Money-safety: the sub name is validated ([a-z0-9-], ≤32 chars + .owner);
// init is idempotent-guarded on-contract (double-init traps); no secret
// material ever exists outside the wallet.

import type { TxRequest } from "../core/signer.js";
import { fnCall } from "../core/signer.js";
import type { KitJson } from "./kit.js";
import { makeSigner } from "./kit.js";
import { ft2WasmBytes, sha256Base58 } from "../core/token-code.js";

export type TokenSpec = {
  /** subaccount label under the connected owner — [a-z0-9-], ≤32 chars */
  name: string;
  symbol: string;
  displayName: string;
  decimals: number;
  icon?: string;
  /** raw u128 units to mint to the owner at creation ("" = skip mint) */
  mintAmount?: string;
  /** NEAR deposit (yocto) funding the new account's storage; default 0.2 N */
  initialNear?: string;
};

export type TokenCreated = {
  accountId: string;
  codeHash: string;
  hashes: string[];
};

const ACCOUNT_RE = /^[a-z0-9-]{1,32}$/;
const INIT_GAS = "50000000000000";
const MINT_GAS = "120000000000000";
const CREATE_GAS = "80000000000000";

async function ownerOf(cfg: KitJson): Promise<string> {
  const owner = await makeSigner(cfg).accountId();
  if (!owner) throw new Error("token-create: wallet not connected — connect before creating a token");
  return owner;
}

/**
 * Serialization law: Uint8Array does not survive the JSON trip from the page
 * to a sandbox executor — every code-carrying action carries BOTH `code`
 * (wallet-native) and `codeB64` (the reliable JSON channel). Executors that
 * understand neither will fail loudly, never silently deploy empty code
 * (caught live: an empty wasm registered a junk global hash).
 */
function codeParams(bytes: Uint8Array): {
  code: Uint8Array;
  codeB64: string;
} {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return { code: bytes, codeB64: btoa(bin) };
}

type CodeMode = { mode: "global"; hash: string } | { mode: "inline" };

/**
 * Is the stock ft2 code already registered as a global contract?
 * Returns the base58 hash when it is, null when it isn't. We never deploy
 * the global code ourselves from the create path — that's a ~3N one-time
 * burn the caller must opt into (kitPublishTokenCode); the create path
 * falls back to an inline per-account deploy instead.
 */
export async function kitEnsureTokenCode(cfg: KitJson): Promise<string | null> {
  const bytes = ft2WasmBytes();
  const hash = await sha256Base58(bytes);
  const { RpcClient } = await import("../core/rpc.js");
  const rpc = new RpcClient(cfg.rpcEndpoint ?? "https://rpc.testnet.fastnear.com");
  const look = await rpc.query("view_global_contract_code", { code_hash: hash });
  if (look.ok) return hash;
  if (!look.error?.includes("NO_GLOBAL_CONTRACT_CODE")) {
    throw new Error("token-create: global-code lookup failed — refusing to guess: " + look.error?.slice(0, 120));
  }
  return null;
}

/**
 * One-time opt-in: wallet-signs the DeployGlobalContract tx for the stock
 * ft2 code (~3N burn for 30KB). After this, every kitCreateToken costs
 * bytes instead of code storage.
 */
export async function kitPublishTokenCode(cfg: KitJson): Promise<string> {
  const bytes = ft2WasmBytes();
  const hash = await sha256Base58(bytes);
  const signer = makeSigner(cfg);
  const owner = await ownerOf(cfg);
  await signer.sendTransactions([
    {
      receiverId: owner,
      actions: [
        { type: "DeployGlobalContract", params: { ...codeParams(bytes), deployMode: "CodeHash" } },
      ],
    },
  ]);
  return hash;
}

/**
 * Create a token subaccount of the connected wallet: code attach + init +
 * metadata + optional mint. Two wallet-signed transactions total. Code mode
 * is automatic: global contract when registered, inline per-account deploy
 * otherwise (~0.6N extra storage on the new account, covered by
 * spec.initialNear — default 0.8 N in inline mode).
 */
export async function kitCreateToken(cfg: KitJson, spec: TokenSpec): Promise<TokenCreated> {
  const name = spec.name.trim().toLowerCase();
  if (!ACCOUNT_RE.test(name)) {
    throw new Error(`token-create: bad name "${spec.name}" — use [a-z0-9-], max 32 chars`);
  }
  if (!spec.symbol || spec.symbol.length > 10) throw new Error("token-create: symbol 1-10 chars");
  const owner = await ownerOf(cfg);
  const accountId = `${name}.${owner}`;
  const signer = makeSigner(cfg);
  const bytes = ft2WasmBytes();
  const globalHash = await kitEnsureTokenCode(cfg);
  const mode: CodeMode = globalHash ? { mode: "global", hash: globalHash } : { mode: "inline" };

  // tx1 — birth: create + attach code + fund storage
  const createActions: TxRequest["actions"] = [{ type: "CreateAccount" }];
  let initial = spec.initialNear ?? "200000000000000000000000";
  if (mode.mode === "global") {
    createActions.push({ type: "UseGlobalContract", params: { contractIdentifier: { codeHash: mode.hash } } });
  } else {
    // inline deploy rides the same batch (faucet pattern) — the new account
    // must carry the full code storage, hence the richer default funding
    if (!spec.initialNear) initial = "800000000000000000000000";
    createActions.push({ type: "DeployContract", params: codeParams(bytes) });
  }
  createActions.push({ type: "Transfer", params: { deposit: initial } });
  const createTx: TxRequest = { receiverId: accountId, actions: createActions };
  await signer.sendTransactions([createTx]);

  // tx2 — init from the wallet: ft2 owner = predecessor = the wallet account
  const initActions = [
    fnCall("new", {}, INIT_GAS, "0"),
    fnCall(
      "set_metadata",
      { spec: "ft-1.0.0", name: spec.displayName, symbol: spec.symbol, decimals: spec.decimals, icon: spec.icon ?? "" },
      INIT_GAS,
      "0",
    ),
  ];
  if (spec.mintAmount && spec.mintAmount !== "0") {
    initActions.push(fnCall("mint", { to: owner, amt: spec.mintAmount }, MINT_GAS, "0"));
  }
  const initTx: TxRequest = { receiverId: accountId, actions: initActions };
  const outcomes = await signer.sendTransactions([initTx]);
  const hashes = outcomes.map((o) => o.transaction_outcome?.id ?? "").filter(Boolean);
  const codeHash = await sha256Base58(bytes);
  return { accountId, codeHash, hashes };
}

export { FT2_WASM_B64 } from "../core/token-code.js";
