import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";
// @ts-expect-error -- plain .mjs build helper, shared with packages/cli.
import { copyWasmAssets } from "./scripts/copy-wasm.mjs";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node18",
  // Left external here so the workspace build resolves it from
  // node_modules. `packages/cli` bundles it into its single-file output
  // instead — see that package's tsup config.
  external: ["web-tree-sitter"],
  async onSuccess() {
    copyWasmAssets(resolve(here, "dist"));
  },
});
