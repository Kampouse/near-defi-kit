import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      "core/index": "src/core/index.ts",
      "adapters/clmm/index": "src/adapters/clmm/index.ts",
      "wallet/near-connect": "src/wallet/near-connect.ts",
      "wallet/near-kit-qwik-signer": "src/wallet/near-kit-qwik-signer.ts",
      "qwik/kit": "src/qwik/kit.ts",
      "qwik/token",
      "qwik/pool": "src/qwik/pool.ts",
    },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: true,
    external: ["@fastnear/near-connect", "near-kit-qwik"],
  },
]);
