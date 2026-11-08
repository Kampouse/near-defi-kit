# @jemartel01/near-defi-kit

Generic, permissionless DeFi frontend kit for NEAR. Quote → swap → create tokens → create pools — everything a static site needs, with **no backend and no API keys**. Qwik-first (React works too), wallet-agnostic, every money path proven against live contracts.

## Install

```bash
npm install @jemartel01/near-defi-kit near-kit-qwik
# near-kit-qwik brings its own peers (near-kit, @hot-labs/near-connect).
# Prefer the near-connect wallet instead? swap in @fastnear/near-connect
# and drop signer: "near-kit-qwik" from the config.
```

| Import | Contents |
|---|---|
| `@jemartel01/near-defi-kit` or `/core` | `RpcClient`, `DefiKit` + adapter interface, tx builders, NEP-141 helpers, `parseInput`/`fmtRaw` |
| `/adapters/clmm` | `ClmmV5Adapter` + byte-parity pool twin (CLMM v5 wire format) |
| `/wallet` | `NearConnectSigner` — lazy `@fastnear/near-connect`, optional local agent-wallet daemon |
| `/wallet/near-kit-qwik` | `NearKitQwikSigner` — full action set through near-kit-qwik (≥ 0.4.0) |
| `/qwik` | Qwik-safe swap wrappers: hoisted functions, JSON in/out (serializer-law safe) |
| `/qwik/token` | `kitCreateToken`, `kitPublishTokenCode` — token factory |
| `/qwik/pool` | `kitCreatePool`, `kitPoolRequirements` — pool factory |

## Quickstart: swaps in Qwik

This is the **entire deployed app** (https://defi-swap.pages.dev) — copy it and change the pool. Your app owns the wallet session through near-kit-qwik (hoisted JSON functions, no classes anywhere); the kit bridges to it via `signer: "near-kit-qwik"`. Human↔raw conversion happens at the edge with `parseInput`/`fmtRaw`.

```tsx
import { component$, useSignal, useStore, $, useVisibleTask$ } from "@builder.io/qwik";
import type { DocumentHead } from "@builder.io/qwik-city";
// your wallet session — near-kit-qwik owns connect/disconnect, JSON functions only
// (getBalance/view are intentionally NOT used: they return FORMATTED/JSON-parsed
// values — "2.47" and floats over 2^53. Raw balances come from the kit's RpcClient.)
import { connect, getSession, disconnect, call } from "near-kit-qwik";
// the kit bridges to that same session via signer: "near-kit-qwik"
import {
  kitQuote, kitSwap, kitSwapResult, parseInput, fmtRaw,
  type KitJson,
} from "@jemartel01/near-defi-kit/qwik";
import { RpcClient } from "@jemartel01/near-defi-kit/core";

const CFG: KitJson = {
  network: "testnet",
  signer: "near-kit-qwik", // bridge: the kit reuses your near-kit-qwik session
  clmmPools: [{
    id: "fartpool.e.clmm5-51fe5a.testnet",
    tokx: { addr: "fartcoin.e.clmm5-51fe5a.testnet", symbol: "FART", decimals: 15 },
    toky: { addr: "wnear.clmm5-51fe5a.testnet", symbol: "wNEAR", decimals: 15 },
  }],
};

// ---------- module scope (helpers a QRL references must live here) ----------
const POOL = CFG.clmmPools![0];
const NET = { network: "testnet" } as const;
const WN = POOL.toky.addr; // the pool's wNEAR (15-dec)
const NEAR_DEC = 24;
const GAS_PAD_YOCTO = 20000000000000000000n; // 0.02 NEAR reserve for tx fees
const YOCTO_PER_WNEAR_RAW = 1000000000n;     // 10^24 native / 10^15 pool = 10^9

/** synthetic native NEAR — `addr` is a UI marker, never sent to the kit */
const NEAR_TOK = { addr: "NEAR", symbol: "NEAR", decimals: NEAR_DEC };
const isNear = (addr: string) => addr === NEAR_TOK.addr;

const decOf = (addr: string) =>
  isNear(addr) ? NEAR_DEC : CFG.clmmPools!.find((p) => p.tokx.addr === addr)?.tokx.decimals ?? 15;
/** the kit never sees "NEAR" — native NEAR enters/leaves the swap as wNEAR */
const poolAddrOf = (addr: string) => (isNear(addr) ? WN : addr);

export default component$(() => {
  const account = useSignal<string | null>(null);
  const amount = useSignal("");
  const display = useSignal("—");
  const minOutRaw = useSignal<string | null>(null); // RAW chain quote (display above is truncated)
  const feeRaw = useSignal<string | null>(null);
  const route = useSignal("");
  const rate = useSignal("");
  const status = useSignal("—");
  const dir = useStore({ x: POOL.tokx, y: POOL.toky }); // direction — JSON only
  const payBal = useSignal<string | null>(null);   // RAW balance of pay token
  const nearBal = useSignal<string | null>(null);  // RAW native NEAR (yocto)

  // mount: restore session + recover a swap interrupted by a reload
  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(async () => {
    account.value = await getSession({ network: "testnet" });
    const rec = await kitSwapResult(CFG);
    if (rec) status.value = rec.status === "completed" ? "last swap filled ✓" : "submitted — check explorer";
    refreshBal();
  });

  const login = $(async () => { account.value = await connect({ network: "testnet" }); refreshBal(); });
  const logout = $(async () => { await disconnect({ network: "testnet" }); account.value = null; payBal.value = null; nearBal.value = null; });

  // balances via the kit's RpcClient — RAW bigint, not formatted strings
  const refreshBal = $(async () => {
    const acct = account.value;
    if (!acct) return;
    try {
      const rpc = RpcClient.forNetwork("testnet");
      const nat = await rpc.nativeBalance(acct);
      nearBal.value = nat.toString();
      if (isNear(dir.x.addr)) { payBal.value = nat.toString(); return; }
      try {
        payBal.value = (await rpc.ftBalanceOf(dir.x.addr, acct)).toString();
      } catch {
        payBal.value = "0"; // no storage registration on that token = holds zero
      }
    } catch { payBal.value = null; nearBal.value = null; }
  });

  // typing quotes live off the chain. RAW below this line, humans above.
  // QRLs are invoked as (event, element) — no extra params, read dir inside.
  const quote = $(async (input: string) => {
    const from = dir.x.addr, to = dir.y.addr;
    amount.value = input;
    const fromDec = decOf(from), toDec = decOf(to);
    const raw = parseInput(input, fromDec);
    if (raw === null || raw <= 0n) { display.value = "—"; minOutRaw.value = null; feeRaw.value = null; route.value = ""; rate.value = ""; return; }
    // paying NEAR: quote the wNEAR leg (raw scaled 24-dec → 15-dec pool domain)
    const inPool = isNear(from) ? raw / YOCTO_PER_WNEAR_RAW : raw;
    const q = await kitQuote(CFG, { from: poolAddrOf(from), to: poolAddrOf(to), amount: inPool.toString() });
    if (!q) { display.value = "no route"; minOutRaw.value = null; feeRaw.value = null; route.value = ""; rate.value = ""; return; }
    minOutRaw.value = q.out;
    feeRaw.value = q.fee ?? null;
    route.value = q.route;
    // receiving NEAR: q.out is 15-dec wNEAR raw — scale up to 24-dec yocto for display
    const outRaw = isNear(to) ? BigInt(q.out) * YOCTO_PER_WNEAR_RAW : BigInt(q.out);
    display.value = fmtRaw(outRaw, toDec);
    // 1 X ≈ rate Y — human units on both sides (domain-safe): out/toDec ÷ in/fromDec
    const fromDen = 10n ** BigInt(fromDec), toDen = 10n ** BigInt(toDec);
    rate.value = fmtRaw((outRaw * fromDen * 1000000n) / (raw * toDen), 6);
  });

  const flip = $(() => {
    const x = dir.x, y = dir.y;
    dir.x = y; dir.y = x;
    resetQuote();
    if (amount.value) quote(amount.value);
    refreshBal();
  });

  // pill click: toggle NEAR ⇄ wNEAR on that side (pool pairs are FART ⇄ NEAR-variants)
  const resetQuote = $(() => {
    minOutRaw.value = null; feeRaw.value = null; route.value = ""; rate.value = ""; display.value = "—";
  });
  const togglePay = $(() => {
    if (isNear(dir.y.addr)) return; // keep one NEAR-variant per side
    dir.x = isNear(dir.x.addr) ? POOL.toky : NEAR_TOK;
    resetQuote();
    if (amount.value) quote(amount.value);
    refreshBal();
  });
  const toggleGet = $(() => {
    if (isNear(dir.x.addr)) return;
    dir.y = isNear(dir.y.addr) ? POOL.toky : NEAR_TOK;
    resetQuote();
    if (amount.value) quote(amount.value);
  });

  const swap = $(async () => {
    const raw = parseInput(amount.value, decOf(dir.x.addr));
    if (raw === null || raw <= 0n || !minOutRaw.value || !account.value) return;
    let poolIn = raw; // what the pool consumes, in its own 15-dec domain

    if (isNear(dir.x.addr)) {
      // paying NEAR: wrap exactly the input amount first, then swap the wNEAR
      if (nearBal.value === null || BigInt(nearBal.value) < raw + GAS_PAD_YOCTO) {
        status.value = "insufficient NEAR (keeping a gas reserve)";
        return;
      }
      status.value = "wrapping NEAR → wNEAR…";
      try {
        await call(NET, WN, "near_deposit", {}, { attachedDeposit: `${raw} yocto` });
      } catch {
        status.value = "wrap rejected — swap cancelled";
        return;
      }
      poolIn = raw / YOCTO_PER_WNEAR_RAW; // 24-dec yocto → 15-dec wNEAR raw
    } else if (dir.x.addr === WN && payBal.value !== null && BigInt(payBal.value) < raw) {
      // paying wNEAR but wallet is short — cover the gap from native NEAR
      const needYocto = (raw - BigInt(payBal.value)) * YOCTO_PER_WNEAR_RAW;
      if (nearBal.value === null || BigInt(nearBal.value) < needYocto + GAS_PAD_YOCTO) {
        status.value = `insufficient ${dir.x.symbol} and NEAR too low to wrap`;
        return;
      }
      status.value = "wrapping NEAR → wNEAR…";
      try {
        await call(NET, WN, "near_deposit", {}, { attachedDeposit: `${needYocto} yocto` });
      } catch {
        status.value = "wrap rejected — swap cancelled";
        return;
      }
      payBal.value = (BigInt(payBal.value) + (needYocto / YOCTO_PER_WNEAR_RAW)).toString();
    }

    status.value = "check your wallet…";
    const res = await kitSwap(CFG, {
      from: poolAddrOf(dir.x.addr),
      to: poolAddrOf(dir.y.addr),
      amount: poolIn.toString(),   // RAW u128, pool domain
      minOut: minOutRaw.value,     // RAW, from the chain quote — contract-enforced
    });
    const filled = res.legs.filter((l) => l.status === "filled");
    if (filled.length === 0) { status.value = "pool refunded (min-out moved) — try again"; refreshBal(); return; }

    // receiving NEAR: unwrap what actually arrived (last filled leg's `used`)
    if (isNear(dir.y.addr)) {
      const last = filled[filled.length - 1];
      const wnearOut = last && last.status === "filled" ? BigInt(last.used) : 0n;
      if (wnearOut > 0n) {
        status.value = "unwrapping wNEAR → NEAR…";
        try {
          await call(NET, WN, "near_withdraw", { amount: wnearOut.toString() });
          status.value = `filled + unwrapped ✓  ${res.txHashes[0]?.slice(0, 16)}…`;
          refreshBal();
          return;
        } catch {
          status.value = `swap filled ✓ — unwrap failed (${fmtRaw(wnearOut, 15)} wNEAR stays wrapped)`;
          refreshBal();
          return;
        }
      }
    }
    status.value = `filled ✓  ${res.txHashes[0]?.slice(0, 16)}…`;
    refreshBal();
  });

  return (
    <div class="page">
      <header>
        <h1><span class="logo">⚡</span> defi-swap</h1>
        {account.value
          ? <button class="pill" onClick$={logout}><span class="dot" />{account.value.slice(0, 12)}…</button>
          : <button class="pill off" onClick$={login}><span class="dot" style={{ background: "#57627a" }} />Connect wallet</button>}
      </header>
      <main class="card">
        {/* PAY */}
        <div class="panel">
          <label>You pay</label>
          <div class="row">
            <input inputMode="decimal" placeholder="0.0" value={amount.value}
              onInput$={(_, el) => quote(el.value)} />
            <button class="tok" onClick$={togglePay} title="Toggle NEAR ⇄ wNEAR"><span class={isNear(dir.x.addr) ? "icon n" : "icon x"}>{isNear(dir.x.addr) ? "Ⓝ" : "₣"}</span>{dir.x.symbol}<span class="chev">▾</span></button>
          </div>
          <div class="sub">
            <span>{dir.x.symbol}</span>
            <span>Balance: {payBal.value !== null ? fmtRaw(BigInt(payBal.value), decOf(dir.x.addr)) + " " + dir.x.symbol : "—"}
              {!isNear(dir.x.addr) && nearBal.value !== null ? " · " + fmtRaw(BigInt(nearBal.value), 24) + " NEAR" : ""}</span>
          </div>
        </div>

        {/* flip disc */}
        <div class="flipwrap">
          <button class="flip" title="Flip direction" onClick$={flip}>↓</button>
        </div>

        {/* RECEIVE */}
        <div class="panel">
          <label>You receive</label>
          <div class="row">
            <div class={`out ${display.value === "—" ? "empty" : ""}`}>{display.value}</div>
            <button class="tok" onClick$={toggleGet} title="Toggle NEAR ⇄ wNEAR"><span class={isNear(dir.y.addr) ? "icon n" : "icon y"}>{isNear(dir.y.addr) ? "Ⓝ" : "◈"}</span>{dir.y.symbol}<span class="chev">▾</span></button>
          </div>
          <div class="sub"><span>{rate.value ? `1 ${dir.x.symbol} ≈ ${rate.value} ${dir.y.symbol}` : ""}</span><span /></div>
        </div>

        {(() => {
          const rawIn = parseInput(amount.value, decOf(dir.x.addr));
          const short = rawIn !== null && payBal.value !== null && BigInt(payBal.value) < rawIn;
          const nearOk = isNear(dir.x.addr) && nearBal.value !== null && rawIn !== null
            && BigInt(nearBal.value) >= rawIn + GAS_PAD_YOCTO;
          const label = !account.value ? "Connect Wallet"
            : !minOutRaw.value ? "Enter an amount"
            : isNear(dir.x.addr) && nearOk ? "Wrap NEAR & Swap"
            : isNear(dir.x.addr) ? "Insufficient NEAR balance"
            : short && dir.x.addr === WN ? "Wrap NEAR & Swap"
            : short ? `Insufficient ${dir.x.symbol} balance`
            : `Swap ${dir.x.symbol} → ${dir.y.symbol}`;
          const canWrap = isNear(dir.x.addr) ? nearOk : dir.x.addr === WN; // wNEAR-short re-checks inside swap()
          return (
            <button class="go" disabled={!account.value || !minOutRaw.value || ((short || isNear(dir.x.addr)) && !canWrap)} onClick$={swap}>
              {label}
            </button>
          );
        })()}

        {(minOutRaw.value || route.value) ? (
          <div class="details">
            <div class="kv"><span>Min. received</span><b>{minOutRaw.value ? fmtRaw(isNear(dir.y.addr) ? BigInt(minOutRaw.value) * YOCTO_PER_WNEAR_RAW : BigInt(minOutRaw.value), decOf(dir.y.addr)) + " " + dir.y.symbol : "—"}</b></div>
            <div class="kv"><span>Network fee</span><b>{feeRaw.value ? fmtRaw(BigInt(feeRaw.value), 15) + " " + POOL.toky.symbol : "—"}</b></div>
            <div class="kv"><span>Route</span><b>{route.value || "—"}</b></div>
          </div>
        ) : <div class="details" />}
        <p class="status">{status.value}</p>
        <p class="fine">Slippage is on-chain (min-out from the live quote). Rejected legs refund automatically. NEAR wraps/unwraps automatically.</p>
      </main>
    </div>
  );
});

export const head: DocumentHead = {
  title: "defi-swap",
  meta: [{ name: "description", content: "NEAR swap front on @jemartel01/near-defi-kit + near-kit-qwik" }],
};
```

**`kitSwap` intent, field by field:**

| field | units | meaning |
|---|---|---|
| `from` / `to` | address | token addresses; picks the pool from `cfg.clmmPools` |
| `amount` | **raw u128 string** | what you send (`tokens × 10^decimals` — 15-dec: `"5"` human = `"5000000000000000"` raw) |
| `minOut` | **raw u128 string** | required; enforced by the contract (`mo` in the msg) — take it from `kitQuote`'s `q.out`, never from a formatted display string |

**Why the kit builds its own signer from JSON instead of taking yours:** in Qwik, a signer class instance cannot survive the serialization boundary — only JSON does. So `/qwik` handlers construct the signer inside, from `cfg`. If your app already owns a wallet session, set `signer: "near-kit-qwik"` in the config and the kit bridges to it instead of opening its own connector. The **vanilla path is plain DI**: `new DefiKit({ rpc, signer })` — pass whatever signer you hold.

That's the whole integration: config JSON + two hoisted functions. `kitQuote`/`kitSwap` build the signer internally, register the CLMM adapter from `clmmPools`, enforce min-out on-chain, and parse the receipt chains for you.

**React / vanilla:** skip `/qwik`, use `core` + `wallet` directly:

```ts
import { RpcClient, DefiKit } from "@jemartel01/near-defi-kit";
import { ClmmV5Adapter } from "@jemartel01/near-defi-kit/adapters/clmm";
import { NearConnectSigner } from "@jemartel01/near-defi-kit/wallet";

const kit = new DefiKit({ rpc: RpcClient.forNetwork("testnet"), signer: new NearConnectSigner({ network: "testnet" }) });
kit.register(new ClmmV5Adapter(kit.rpc, poolCfg));
const best = await kit.bestQuote({ from, to, amount });
const { txHashes, used } = await kit.swap({ from, to, amount, minOut });
```

## Wallets

- **near-connect** (default): `kitAccountId` / `kitConnect` / `kitDisconnect` own the picker; nothing to wire.
- **near-kit-qwik**: set `signer: "near-kit-qwik"` in `KitJson`. Your app owns the near-kit session; the kit never opens a second connector (one wallet library per app). Requires near-kit-qwik ≥ 0.4.0.
- **agent wallet** (desktop dev): `agentWallet: true` registers the loopback daemon at `127.0.0.1:8391` so local keys appear in the picker.

## Create a token (one call, two wallet-signed txs)

```ts
import { kitCreateToken } from "@jemartel01/near-defi-kit/qwik/token";

const tok = await kitCreateToken(cfg, {
  name: "mypooltoken",            // subaccount label under the connected owner
  symbol: "MPT",
  displayName: "My Pool Token",
  decimals: 15,
  icon: "🪙",
  mintAmount: "1000000000000000000000000",  // raw u128 minted to the owner
});
// → { accountId, codeHash, hashes }  (~0.8 N storage funded automatically)
```

Code mode is automatic: inline deploy per token by default; `kitPublishTokenCode()` opts into the global registry (one-time ~3 N burn, then every later token deploys keyless in one tx).

## Create + seed a pool

```ts
import { kitCreatePool, kitPoolRequirements } from "@jemartel01/near-defi-kit/qwik/pool";

const pool = await kitCreatePool(cfg, {
  name: "mypool",                       // → mypool.<owner>.testnet
  tokx: "tokn.clmm5-51fe5a.testnet",    // X side of the book
  toky: "wnear.clmm5-51fe5a.testnet",   // Y side
  feeShift: "8",                        // fee = 1/2^8 (0.39%); default
  s0: "",                               // boot price; "" = 1.0 (Q64.16: 2^64)
});
// → { accountId, hashes }  — birth tx + init tx

// then LP: find the exact escrow requirements for your depth…
const { rx, ry } = await kitPoolRequirements(cfg, pool.accountId, d, -8, 8);
// …seed the float (msg "seed" must be JSON: {"a":"seed"}), then mint in two legs:
// leg 1 = X side, attach slightly ABOVE rx (excess refunds);
// leg 2 = Y side, same with ry. msg: {"a":"mint","d":"<d>","lo":-8,"hi":8}
```

**Pick `d` big enough.** `d` is the liquidity constant; one price cell holds roughly `d × 5e-5` **raw** units of depth. For 15-decimal tokens, `d = 1e21` is ~50 tokens/cell — real trades will walk straight past your range. Rule of thumb: `d ≈ desired_cell_depth_in_tokens × 2e16`. A thin pool isn't broken — it just gets price-pinned past its edges by ordinary-sized swaps. Everything still fails closed (quotes go sentinel, swaps refund), and the other direction keeps pricing, but you'll want depth.

## Money-safety law

- **The on-chain `quote` verb is THE quote.** The byte-parity twin is advisory only; twin disagreement never blocks execution.
- **min-out rides in the transaction msg** (`mo:<raw>`), enforced by the contract (full revert incl. fees on breach) — not by frontend checks.
- **Soft-fail law:** NEP-141 legs answer `used:<kept>` as SuccessValue strings; a "successful" tx can still have been rejected by the pool. `kitSwap` parses this into `res.legs` — a discriminated union (`"filled"` / `"rejected"` / `"unknown"`) — narrow on `status`, never trust tx status alone.
- **Reload recovery:** if the browser reloads mid-swap (wallet redirects do this), `kitSwapResult()` on the fresh mount returns `{ status: "completed", … }` or `{ status: "submitted", intent }` — call it before assuming a swap is lost.
- `parseInput` / `fmtRaw` are the only human↔raw money converters; `parseInput` returns `null` on anything ambiguous.
- **15-decimal trap:** raw u128 is `tokens × 10^decimals`. When debugging raw strings, count digits before comparing — a factor of 1000 hides in plain sight.

## Qwik serializer law

Only JSON survives Qwik's serialization boundary — class instances die silently. All `/qwik` entries are hoisted pure functions taking `KitJson` (plain JSON) and returning JSON. Never store a signer, adapter, or `DefiKit` in a signal; build config as data, let the kit construct internals inside the handler.

## Writing an adapter

Implement `ProtocolAdapter` (`getQuote`, `buildSwapTx`, optional positions/liquidity) and `kit.register()` it. Adapters receive an `RpcClient` and a `Signer` — no wallet library, no framework. A lending protocol, a DEX aggregator, a vault: same interface. The 8-action tx builder (`FunctionCall`, `CreateAccount`, `Transfer`, `DeployContract`, `DeployGlobalContract`, `UseGlobalContract`, `AddKey`, `DeleteKey`) covers batch birth transactions (create + deploy + fund in one signed tx).

Bytes never cross the JSON boundary: code-carrying actions take `codeB64`, decoded at the builder edge.

## Verify

```bash
npm install && npm run build && npm run smoke
```

The smoke test runs the read path against live testnet pools: real chain quote, escrow-custody sanity, wire-format parse, twin parity.

Every snippet in this README is compile-verified against the built package — see `near-kit-qwik-test/src/readme-examples.tsx` (`npm run build.types` there).

## License

MIT
