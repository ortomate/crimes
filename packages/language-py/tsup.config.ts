import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node18",
  // `web-tree-sitter` is a real runtime dependency, never bundled. It is
  // pure JS + WASM (no native addon, no install script), so it installs
  // cleanly on every platform Node runs on.
  external: ["web-tree-sitter"],
  // Mirror the vendored grammar into dist/ so the resolver's first
  // candidate hits without walking. `vendor/` stays the source of truth.
  async onSuccess() {
    const dist = resolve(here, "dist");
    mkdirSync(dist, { recursive: true });
    copyFileSync(
      resolve(here, "vendor", "tree-sitter-python.wasm"),
      resolve(dist, "tree-sitter-python.wasm"),
    );
  },
});
