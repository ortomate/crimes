// Copy the two WASM assets the Python pack needs into a target directory.
//
// Called from both `packages/language-py/tsup.config.ts` and
// `packages/cli/tsup.config.ts`. The CLI bundles this pack into a single
// `dist/index.js`, which moves the code away from its own node_modules —
// so the assets have to travel with the bundle, and `grammar.ts` resolves
// them by walking up from wherever it ends up running.
//
//  - `tree-sitter-python.wasm` is vendored (see ../vendor/ATTRIBUTION.md).
//  - `web-tree-sitter.wasm` belongs to the npm package and is copied from
//    node_modules so it stays version-locked to the JS that loads it.

import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");

/**
 * Resolve `web-tree-sitter.wasm` through Node's own resolver rather than
 * a guessed `node_modules` path — pnpm's layout is symlinked and content-
 * addressed, so a hard-coded path breaks on a different store layout.
 */
function runtimeWasmPath() {
  const require = createRequire(resolve(packageRoot, "package.json"));
  return resolve(dirname(require.resolve("web-tree-sitter")), "web-tree-sitter.wasm");
}

export function copyWasmAssets(targetDir) {
  mkdirSync(targetDir, { recursive: true });
  copyFileSync(
    resolve(packageRoot, "vendor", "tree-sitter-python.wasm"),
    resolve(targetDir, "tree-sitter-python.wasm"),
  );
  copyFileSync(runtimeWasmPath(), resolve(targetDir, "web-tree-sitter.wasm"));
}
