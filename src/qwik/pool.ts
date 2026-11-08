// qwik/pool.ts — CLMM v5 pool factory: spawn a fresh pool subaccount of the
// connected wallet via the GLOBAL pool code (already registered once — the
// per-pool cost is a 0.2-0.3 N account + a few bytes of reference, no burn).
//
// Tx plan (all wallet-signed, zero raw signing):
//   tx1 [CreateAccount, UseGlobalContract(poolCodeHash), Transfer] — the pool
//       account is born keyless, carrying the global pool code.
//   tx2 init fnCall {toka, tokb, curve:"", fee_shift, s0, lock_secs} — the
//       creator calls init directly (first caller wins; p5-init guards on
//       6|TOKX unset). Defaults: fee 1/256 (shift 8), boot price 2^64 (1:1).
//
// Seeding is separate (kitPoolSeed + kitPoolSeedQuoteLegs): swap liquidity
// requires an LP mint through the pool's custody law — seed float via
// msg "seed" transfers, then the two-leg mint (leg 1 attaches EXACTLY its
// side's req, leg 2 ≥ req, excess refunded by the pool). Reqs come from the
// live position_requirements view — the chain quote is THE quote.
//
// Serialization law: code rides codeB64; every entry is a hoisted pure
// function with JSON in/out.

import type { KitJson } from "./kit.js";
import { makeSigner } from "./kit.js";
import type { TxRequest, TxOutcome } from "../core/signer.js";
import { ownerOf } from "./token.js";

/** Global code hash of the stock CLMM v5 pool wasm — NOT registered yet
 * (verified live: NO_GLOBAL_CONTRACT_CODE). Registering would burn ~16 N
 * (159 KB); until someone funds that, new pools inline-deploy the embedded
 * code (~1.6 N storage on the pool account). */
export const POOL_CODE_HASH = "5oPU5mvJJS8Hjf5bP4zqg7VqrfobrCpDFiMWt89GJjcs";

const ACCOUNT_RE = /^[a-z0-9-]{1,32}$/;
const DEFAULT_POOL_NEAR = "2000000000000000000000000";

type CodeMode = { mode: "global"; hash: string } | { mode: "inline" };

/** Serialization law: bytes ride codeB64 — Uint8Array dies over JSON. */
function codeParams(bytes: Uint8Array): { code: Uint8Array; codeB64: string } {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return { code: bytes, codeB64: btoa(bin) };
}

/**
 * Is the stock pool code registered globally? Hash (global mode) or null
 * (inline mode). Never deploys from the create path — the global burn is
 * ~16 N and belongs to an explicit, funded decision.
 */
async function poolCodeMode(cfg: KitJson): Promise<CodeMode> {
  const { RpcClient } = await import("../core/rpc.js");
  const rpc = new RpcClient(cfg.rpcEndpoint ?? "https://rpc.testnet.fastnear.com");
  const look = await rpc.query("view_global_contract_code", { code_hash: POOL_CODE_HASH });
  if (look.ok) return { mode: "global", hash: POOL_CODE_HASH };
  if (!look.error?.includes("NO_GLOBAL_CONTRACT_CODE")) {
    throw new Error("pool-create: global-code lookup failed — refusing to guess: " + look.error?.slice(0, 120));
  }
  return { mode: "inline" };
}

export type PoolSpec = {
  name: string;
  /** token on the X side of the book */
  tokx: string;
  /** token on the Y side of the book */
  toky: string;
  /** fee divisor = 2^shift; empty/0 = 1/256 (0.39%); must be < 41 */
  feeShift?: string;
  /** boot price Q64.16 — raw string; empty = 2^64 (1.0) */
  s0?: string;
  /** LP lock duration in seconds; 0 = unlocked */
  lockSecs?: string;
  initialNear?: string;
};

export type PoolCreated = {
  accountId: string;
  hashes: string[];
};

function poolNameOk(name: string): string {
  const n = name.trim().toLowerCase();
  if (!ACCOUNT_RE.test(n)) {
    throw new Error(`pool-create: bad name "${name}" — use [a-z0-9-], max 32 chars`);
  }
  return n;
}

/**
 * Spawn a fresh CLMM v5 pool: one wallet-signed birth tx (create + attach
 * global code + fund) and one init call. Unseeded — call kitPoolSeedLegs
 * before anyone can trade (an unseeded pool quotes 0 and refunds).
 */
export async function kitCreatePool(cfg: KitJson, spec: PoolSpec): Promise<PoolCreated> {
  const name = poolNameOk(spec.name);
  if (!ACCOUNT_RE.test(spec.tokx) || !ACCOUNT_RE.test(spec.toky)) {
    throw new Error("pool-create: bad token account ids");
  }
  const owner = await ownerOf(cfg);
  const accountId = `${name}.${owner}`;
  const signer = await makeSigner(cfg);
  const mode = await poolCodeMode(cfg);

  // birth tx — create + attach code + fund storage (faucet pattern, one tx)
  const birthActions: TxRequest["actions"] = [{ type: "CreateAccount" }];
  if (mode.mode === "global") {
    birthActions.push({ type: "UseGlobalContract", params: { contractIdentifier: { codeHash: mode.hash } } });
  } else {
    const { poolWasmBytes } = await import("../core/pool-code.js");
    birthActions.push({ type: "DeployContract", params: codeParams(poolWasmBytes()) });
  }
  birthActions.push({ type: "Transfer", params: { deposit: spec.initialNear ?? DEFAULT_POOL_NEAR } });
  const birthOut = await signer.sendTransactions([{ receiverId: accountId, actions: birthActions }]);

  const initTx: TxRequest = {
    receiverId: accountId,
    actions: [
      {
        type: "FunctionCall",
        params: {
          methodName: "init",
          args: {
            toka: spec.tokx,
            tokb: spec.toky,
            curve: "",
            fee_shift: spec.feeShift ?? "",
            s0: spec.s0 ?? "",
            lock_secs: spec.lockSecs ?? "",
          },
          gas: "10000000000000",
          deposit: "0",
        },
      },
    ],
  };
  const initOut = await signer.sendTransactions([initTx]);

  const hashes = [...birthOut, ...initOut]
    .map((o: TxOutcome) => o.transaction_outcome?.id ?? "")
    .filter(Boolean);
  return { accountId, hashes };
}

/**
 * Required escrow for an LP position — straight from the pool's own
 * position_requirements view (state-independent closed form).
 */
export async function kitPoolRequirements(
  cfg: KitJson,
  poolId: string,
  d: string,
  lo: number,
  hi: number,
): Promise<{ rx: string; ry: string }> {
  const { RpcClient } = await import("../core/rpc.js");
  const rpc = new RpcClient(cfg.rpcEndpoint ?? "https://rpc.testnet.fastnear.com");
  const raw = await rpc.view(poolId, "position_requirements", { d, a: lo, b: hi });
  const s = typeof raw === "string" ? raw : JSON.stringify(raw);
  const rx = /rx:(\d+)/.exec(s)?.[1];
  const ry = /ry:(\d+)/.exec(s)?.[1];
  if (!rx || !ry) throw new Error(`pool-seed: bad req response ${s.slice(0, 80)}`);
  return { rx, ry };
}
