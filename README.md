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
import { component$, useSignal, $, useVisibleTask$ } from "@builder.io/qwik";
import type { DocumentHead } from "@builder.io/qwik-city";
// your wallet session — near-kit-qwik owns connect/disconnect, JSON functions only
import { connect, getSession, disconnect } from "near-kit-qwik";
// the kit bridges to that same session via signer: "near-kit-qwik"
import {
  kitQuote, kitSwap, kitSwapResult, parseInput, fmtRaw,
  type KitJson,
} from "@jemartel01/near-defi-kit/qwik";

const CFG: KitJson = {
  network: "testnet",
  signer: "near-kit-qwik", // bridge: the kit reuses your near-kit-qwik session
  clmmPools: [{
    id: "fartpool.e.clmm5-51fe5a.testnet",
    tokx: { addr: "fartcoin.e.clmm5-51fe5a.testnet", symbol: "FART", decimals: 15 },
    toky: { addr: "wnear.clmm5-51fe5a.testnet", symbol: "wNEAR", decimals: 15 },
  }],
};

// helpers a QRL references live at MODULE scope — never inside component$
const POOL = CFG.clmmPools![0];
const decOf = (addr: string) =>
  CFG.clmmPools!.find((p) => p.tokx.addr === addr)?.tokx.decimals ?? 15;

export default component$(() => {
  const account = useSignal<string | null>(null);
  const amount = useSignal("");
  const display = useSignal("—");
  const minOutRaw = useSignal<string | null>(null); // RAW chain quote (display above is truncated)
  const status = useSignal("—");

  // mount: restore session + recover a swap interrupted by a reload
  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(async () => {
    account.value = await getSession({ network: "testnet" });
    const rec = await kitSwapResult(CFG);
    if (rec) status.value = rec.status === "completed" ? "last swap filled ✓" : "submitted — check explorer";
  });

  const login = $(async () => { account.value = await connect({ network: "testnet" }); });
  const logout = $(async () => { await disconnect({ network: "testnet" }); account.value = null; });

  // typing quotes live off the chain. RAW below this line, humans above.
  const quote = $(async (input: string) => {
    amount.value = input;
    const raw = parseInput(input, decOf(POOL.tokx.addr));
    if (raw === null || raw <= 0n) { display.value = "—"; minOutRaw.value = null; return; }
    const q = await kitQuote(CFG, { from: POOL.tokx.addr, to: POOL.toky.addr, amount: raw.toString() });
    minOutRaw.value = q ? q.out : null;
    display.value = q ? fmtRaw(BigInt(q.out), decOf(POOL.toky.addr)) : "no route";
  });

  const swap = $(async () => {
    const raw = parseInput(amount.value, decOf(POOL.tokx.addr));
    if (raw === null || raw <= 0n || !minOutRaw.value || !account.value) return;
    status.value = "check your wallet…";
    const res = await kitSwap(CFG, {
      from: POOL.tokx.addr,
      to: POOL.toky.addr,
      amount: raw.toString(),      // RAW u128
      minOut: minOutRaw.value,     // RAW, from the chain quote — contract-enforced
    });
    status.value = res.legs.every((l) => l.status === "filled")
      ? `filled ✓  ${res.txHashes[0]?.slice(0, 16)}…`
      : "pool refunded (min-out moved) — try again";
  });

  return (
    <div class="page">
      <header>
        <h1>⚡ defi-swap</h1>
        {account.value
          ? <button class="pill" onClick$={logout}>{account.value.slice(0, 12)}… · exit</button>
          : <button class="pill" onClick$={login}>Connect wallet</button>}
      </header>
      <main class="card">
        <label>You pay</label>
        <div class="row">
          <input inputMode="decimal" placeholder="0.0" value={amount.value}
            onInput$={(_, el) => quote(el.value)} />
          <span class="tok static">{POOL.tokx.symbol}</span>
        </div>
        <label>You get (live on-chain quote)</label>
        <div class="row">
          <div class="out">{display.value}</div>
          <span class="tok static">{POOL.toky.symbol}</span>
        </div>
        <button class="go" disabled={!account.value || !minOutRaw.value} onClick$={swap}>
          {!account.value ? "Connect to swap" : !minOutRaw.value ? "Enter an amount" : `Swap ${POOL.tokx.symbol} → ${POOL.toky.symbol}`}
        </button>
        <p class="status">{status.value}</p>
        <p class="fine">min-out = live quote, enforced on-chain. Rejected legs refund automatically.</p>
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
