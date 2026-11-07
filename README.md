# @jemartel01/near-defi-kit

Generic, permissionless DeFi frontend kit for NEAR. Quote → swap → create tokens → create pools — everything a static site needs, with **no backend and no API keys**. Qwik-first (React works too), wallet-agnostic, every money path proven against live contracts.

## Install

```bash
npm install @jemartel01/near-defi-kit
# peer dep for wallet signing (pick ONE):
npm install @fastnear/near-connect   # default wallet layer
npm install near-kit-qwik            # if your app already uses near-kit
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

## Quickstart: swaps in Qwik (~20 lines)

```tsx
import { component$, useSignal, useStore, $ } from "@builder.io/qwik";
import { kitQuote, kitSwap, kitAccountId, type KitJson } from "@jemartel01/near-defi-kit/qwik";

// ONLY JSON lives in signals/stores — Qwik's serializer kills class instances.
const useKit = () => useStore<KitJson>({
  network: "testnet",
  clmmPools: [{
    id: "pool7.clmm5-51fe5a.testnet",
    tokx: { addr: "tokn.clmm5-51fe5a.testnet",  symbol: "TOKN",  decimals: 15 },
    toky: { addr: "wnear.clmm5-51fe5a.testnet", symbol: "wNEAR", decimals: 15 },
  }],
} satisfies KitJson);

export const SwapCard = component$(() => {
  const cfg = useKit();
  const account = useSignal<string | null>(null);
  const out = useSignal<string | null>(null);
  const status = useSignal("");

  // wallet state on reload: accountId is all you persist
  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(async () => { account.value = await kitAccountId(cfg); });

  const quote = $((amount: string) =>
    kitQuote(cfg, { from: cfg.clmmPools![0].tokx.addr, to: cfg.clmmPools![0].toky.addr, amount })
      .then(q => { out.value = q ? q.out : null; }));

  const swap = $(async () => {
    status.value = "swapping…";
    // minOut is required by the type — the compiler enforces the money-safety law
    const res = await kitSwap(cfg, {
      from: cfg.clmmPools![0].tokx.addr, to: cfg.clmmPools![0].toky.addr,
      amount: "5", minOut: out.value ?? "0",
    });
    // per-leg outcomes: "rejected" = pool refunded everything (soft-fail law)
    status.value = res.legs.every(l => l.status === "filled")
      ? `done: ${res.txHashes.join(", ")}` : "leg rejected by pool (refunded)";
  });

  return (<div>…</div>);
});
```

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
