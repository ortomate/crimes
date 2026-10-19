import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";
// @ts-expect-error -- plain .mjs build helper, shared with packages/cli.
import { copyJavaWasmAssets } from "./scripts/copy-wasm.mjs";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node18",
  // Left external for the workspace build; `packages/cli` bundles both.
  external: ["web-tree-sitter", "@crimes/language-py"],
  async onSuccess() {
    copyJavaWasmAssets(resolve(here, "dist"));
  },
});
