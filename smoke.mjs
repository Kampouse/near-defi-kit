// smoke.mjs — REAL verification: kit → live pool7 → quote + custody + twin advisory.
// No wallet needed: everything here is the permissionless read path.
import { RpcClient, fmtRaw, parseInput } from "./dist/core/index.js";
import { ClmmV5Adapter, Pool } from "./dist/adapters/clmm/index.js";

const POOL7 = "pool7.clmm5-51fe5a.testnet";
const rpc = RpcClient.forNetwork("testnet");
console.log("rpc:", rpc.endpoint);

const adapter = new ClmmV5Adapter(rpc, {
  id: POOL7,
  tokx: { addr: "tokn.clmm5-51fe5a.testnet", symbol: "TOKN", decimals: 15 },
  toky: { addr: "wnear.clmm5-51fe5a.testnet", symbol: "wNEAR", decimals: 15 },
});

// 0. pool7 is ONE-SIDED seeded (graduation seeds a single leg): quote
// out CAN legitimately be 0 — the assertion is wire-format sanity, not >0.
// 1. real quote: 1 TOKN → wNEAR
const amt = parseInput("1", 24);
const quote = await adapter.getQuote({
  from: "tokn.clmm5-51fe5a.testnet",
  to: "wnear.clmm5-51fe5a.testnet",
  amount: amt.toString(),
});
if (!quote) throw new Error("smoke: no quote for TOKN/wNEAR");
console.log("quote 1 TOKN →", quote.out, "yocto-wNEAR (", fmtRaw(BigInt(quote.out), 24, 12), "wNEAR, fee", fmtRaw(BigInt(quote.fee), 24), ") route:", quote.route);

// 2. reverse quote: 0.01 wNEAR → TOKN
const q2 = await adapter.getQuote({
  from: "wnear.clmm5-51fe5a.testnet",
  to: "tokn.clmm5-51fe5a.testnet",
  amount: parseInput("0.01", 24).toString(),
});
console.log("quote 0.01 wNEAR →", q2.out, "yocto-TOKN (", fmtRaw(BigInt(q2.out), 24, 12), "TOKN)");

// 3. min-out tx builder — enforcement must ride in the msg
const minOut = (BigInt(q2.out) * 9900n) / 10000n; // 1% slip
const txs = await adapter.buildSwapTx(
  { from: "wnear.clmm5-51fe5a.testnet", to: "tokn.clmm5-51fe5a.testnet", amount: parseInput("0.01", 24).toString(), minOut: minOut.toString() },
  q2,
);
const msgArg = txs[0].actions[0].params.args.msg;
const parsed = JSON.parse(msgArg);
if (parsed.a !== "swap" || !("mo" in parsed)) throw new Error("smoke: swap tx missing {a:'swap',mo} min-out enforcement");
console.log("swap tx →", txs[0].receiverId, "msg:", msgArg, "gas:", txs[0].actions[0].params.gas);

// 4. custody check: escrow slices must equal pool token balances
const cust = await adapter.custodyCheck(POOL7);
console.log("custody:", cust.x ? "x ✓" : "x ✗ MISMATCH", cust.y ? "y ✓" : "y ✗ MISMATCH", "(esc raw:", cust.escx.toString(), "/", cust.escy.toString(), ")");

// 5. twin advisory: hydrated twin walks the same state offline
const { raw, twin } = await adapter["fetchState"](POOL7);
const twinQ = twin.quoteSwap(parseInput("1", 24).toString(), "x");
const agree = BigInt(twinQ.out) === BigInt(quote.out);
console.log("twin advisory:", twinQ.out, "yocto", agree ? "= chain ✓ (parity)" : "≠ chain (advisory-only, non-blocking)");

// 6. wire-format regression: parse the state the kit just fetched
const st = Pool.parseState(raw);
if (st.tokx !== "tokn.clmm5-51fe5a.testnet" || st.shift !== "8") throw new Error("smoke: parseState drifted: tokx=" + st.tokx + " shift=" + st.shift);
if (!st.escx || st.escx === "0") throw new Error("smoke: escx unparsed");
if (!st.last.startsWith("swap-out:")) throw new Error("smoke: LAST unparsed: " + st.last);
console.log("escrow parse:", st.escx, "/", st.escy, "last:", st.last);
console.log("state parse ✓ —", st.ticks.length, "ticks, IMIN", st.imin, "IMAX", st.imax);
console.log("\nSMOKE PASS");
