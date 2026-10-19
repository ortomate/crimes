// Copy the Java grammar into a target directory.
//
// Called from `packages/language-java/tsup.config.ts` and
// `packages/cli/tsup.config.ts`, for the same reason as the Python pack's
// copy-wasm.mjs: the CLI bundles this pack into a single dist/index.js,
// so the grammar has to travel with the bundle. The runtime's own
// `web-tree-sitter.wasm` is copied by the Python pack's helper; both
// packs share one runtime.

import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");

export function copyJavaWasmAssets(targetDir) {
  mkdirSync(targetDir, { recursive: true });
  copyFileSync(
    resolve(packageRoot, "vendor", "tree-sitter-java.wasm"),
    resolve(targetDir, "tree-sitter-java.wasm"),
  );
}
