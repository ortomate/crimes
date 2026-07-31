import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";
// @ts-expect-error -- plain .mjs build helper owned by @crimes/language-py.
import { copyWasmAssets } from "../language-py/scripts/copy-wasm.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(resolve(here, "package.json"), "utf8"),
) as { version: string };

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: true,
  target: "node18",
  // Bundle workspace packages and small runtime deps (commander, fast-glob,
  // picocolors, zod) into a single self-contained file so the published
  // `crimes` package has minimal install-time resolution. We deliberately
  // externalise `typescript` — bundling the full TS compiler bloats the
  // tarball from ~4MB to ~100KB (and ~25MB unpacked to ~250KB) for no
  // runtime benefit. It is declared as a real dependency so `npm install -g
  // crimes` resolves it. Everything not listed here stays external (node
  // builtins, typescript), so be explicit when adding new runtime deps.
  noExternal: [
    /^@crimes\//,
    "commander",
    "fast-glob",
    "picocolors",
    "picomatch",
    "zod",
  ],
  // Some bundled deps (commander) are CJS and assume CommonJS globals —
  // `require`, `__filename`, `__dirname` — exist at runtime. The output is
  // ESM, where they don't. We polyfill all three so esbuild's CJS interop
  // wrapper works.
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __createRequire } from "node:module";',
      'import { fileURLToPath as __fileURLToPath } from "node:url";',
      'import { dirname as __pathDirname } from "node:path";',
      "const require = __createRequire(import.meta.url);",
      "const __filename = __fileURLToPath(import.meta.url);",
      "const __dirname = __pathDirname(__filename);",
    ].join("\n"),
  },
  define: {
    __CRIMES_VERSION__: JSON.stringify(pkg.version),
  },
  // The Python pack's two WASM assets travel with the bundle. They are
  // data, not code, so esbuild can't inline them — and once the pack is
  // bundled into dist/index.js it is no longer next to its own
  // node_modules. `@crimes/language-py`'s grammar loader resolves both by
  // walking up from wherever it runs, so landing them in dist/ is what
  // makes the published single-file CLI able to parse Python at all.
  async onSuccess() {
    copyWasmAssets(resolve(here, "dist"));
  },
});
