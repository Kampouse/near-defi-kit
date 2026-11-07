import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      "core/index": "src/core/index.ts",
      "adapters/clmm/index": "src/adapters/clmm/index.ts",
      "wallet/near-connect": "src/wallet/near-connect.ts",
      "qwik/kit": "src/qwik/kit.ts",
    },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: true,
    external: ["@fastnear/near-connect"],
  },
]);
