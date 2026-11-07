# @jemartel01/near-defi-kit

Generic, permissionless DeFi frontend kit for NEAR. RPC, tokens, wallet signing, and pluggable protocol adapters — everything a static site needs to build a full DeFi frontend with **no backend and no API keys**.

## Why

Every DeFi frontend is a thin client over public contract views and `ft_transfer_call`. This kit factors that pattern out once so new frontends are config + UI, not protocol plumbing.

## Install

```bash
npm install @jemartel01/near-defi-kit
# peer deps (pick what you use):
npm install @fastnear/near-connect   # wallet signing
npm install react                    # hooks entry
```

## Entries

| Import | Contents |
|---|---|
| `@jemartel01/near-defi-kit` / `/core` | `RpcClient`, `Signer`, tx builders, NEP-141 helpers, formatting, `DefiKit` + adapter contract |
| `@jemartel01/near-defi-kit/adapters/clmm` | `ClmmV5Adapter` + byte-parity pool twin (CLMM v5 wire format) |
| `@jemartel01/near-defi-kit/wallet` | `NearConnectSigner` (lazy `@fastnear/near-connect`, optional local agent-wallet daemon) |
| `@jemartel01/near-defi-kit/qwik` | Qwik-safe wrappers: hoisted functions, JSON in/out (serializer-law safe) |

## Usage

```ts
import { RpcClient, DefiKit } from "@jemartel01/near-defi-kit";
import { ClmmV5Adapter } from "@jemartel01/near-defi-kit/adapters/clmm";
import { NearConnectSigner } from "@jemartel01/near-defi-kit/wallet";

const rpc = RpcClient.forNetwork("testnet");
const signer = new NearConnectSigner({ network: "testnet" });
const kit = new DefiKit({ rpc, signer });

kit.register(new ClmmV5Adapter(rpc, {
  id: "pool7.clmm5-51fe5a.testnet",
  tokx: { addr: "tokn.clmm5-51fe5a.testnet", symbol: "TOKN", decimals: 24 },
  toky: { addr: "wnear.clmm5-51fe5a.testnet", symbol: "wNEAR", decimals: 24 },
}));

// quote across all registered adapters
const best = await kit.bestQuote({ from: tokn, to: wnear, amount, minOut });

// quote → min-out check → sign + send (min-out enforced by the contract via msg)
const { txHashes, quote } = await kit.swap({ from: tokn, to: wnear, amount, minOut });
```

Qwik (see the serializer laws: only JSON survives Qwik's serialization boundary — class instances die silently):

```ts
// component: keep ONLY JSON in signals/stores
const cfg = useStore<KitJson>({ network: "testnet", clmmPools: [pool7] });
const quote = useSignal<Quote | null>(null);

// QRL: client born inside the handler, nothing captured but cfg
const doQuote = $((amount: string) => {
  quote.value = await kitQuote(cfg.value, { from: tokn, to: wnear, amount });
});

const doSwap = $(async () => {
  const res = await kitSwap(cfg.value, { from: tokn, to: wnear, amount, minOut });
  // res.used — `used:<kept>` per leg; null = leg rejected by the pool (soft-fail law)
});

// session restore on load (useVisibleTask$): accountId is the only wallet state you keep
const account = useSignal<string | null>(await kitAccountId(cfg.value));
```

React/other frameworks: use `core` + `wallet` directly — `new DefiKit({ rpc, signer })` in your own provider (`adapters/clmm` and `wallet` are framework-free).

## Money-safety law

- **The on-chain `quote` verb is THE quote.** The byte-parity twin is advisory only — it hydrates from `get_state` and has drifted before; twin disagreement never blocks execution.
- **min-out rides in the transaction msg** (`mo:<raw>`), enforced by the contract (full revert incl. fees on breach) — not by frontend checks.
- **Soft-fail law:** NEP-141 legs answer `used:<kept>` as SuccessValue strings; a "successful" tx can still have been rejected by the pool. `parseUsed` / `decodeResult` — check, never trust status alone.
- `parseInput` / `fmtRaw` are the only human↔raw money converters; `parseInput` returns `null` on anything ambiguous.

## Writing an adapter

Implement `ProtocolAdapter` (`getQuote`, `buildSwapTx`, optional positions/liquidity) and `kit.register()` it. Adapters receive an `RpcClient` and a `Signer` — no wallet library, no framework. A lending protocol, a DEX aggregator, a vault: same interface.

## Verify

```bash
npm install && npm run build && npm run smoke
```

The smoke test runs the read path against the live pool7 testnet deployment: real chain quote, escrow-custody sanity, wire-format parse, twin parity.

## License

MIT
