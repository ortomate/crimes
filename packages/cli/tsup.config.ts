import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";
// @ts-expect-error -- plain .mjs build helper owned by @crimes/language-py.
import { copyWasmAssets } from "../language-py/scripts/copy-wasm.mjs";
// @ts-expect-error -- plain .mjs build helper owned by @crimes/language-java.
import { copyJavaWasmAssets } from "../language-java/scripts/copy-wasm.mjs";
// @ts-expect-error -- plain .mjs build helper owned by @crimes/language-kotlin.
import { copyKotlinWasmAssets } from "../language-kotlin/scripts/copy-wasm.mjs";
// @ts-expect-error -- plain .mjs build helper owned by @crimes/language-swift.
import { copySwiftWasmAssets } from "../language-swift/scripts/copy-wasm.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(here, "package.json"), "utf8")) as {
  version: string;
};

/**
 * Re-run the CLI once under `--liftoff-only`, before any bundled code runs.
 *
 * V8's optimising WebAssembly compiler (TurboFan) spends unbounded memory
 * on the tree-sitter grammars: parsing a private iOS app's 1,604 Swift files
 * peaked at 2.8 GB RSS with it and 344 MB without, and the scan got
 * faster (21.4 s -> 12.6 s) because compiling cost more than it saved.
 * The flag only takes effect at process start — `v8.setFlagsFromString`
 * is too late, `NODE_OPTIONS` rejects it, and a shebang cannot pass it
 * portably — so the bundle re-executes itself with it. It changes nothing
 * for JavaScript: the TypeScript parser is not WebAssembly.
 *
 * Exit status and terminating signal pass through. If the child cannot be
 * started at all, the CLI runs in this process as before.
 * `CRIMES_NO_REEXEC=1` opts out.
 */
const REEXEC_LIFTOFF = [
  // tsup prepends the banner to every output chunk, and an imported chunk
  // runs first; so re-run the entry node was given (argv[1]), never this file.
  "if (",
  '  !process.execArgv.includes("--liftoff-only") &&',
  '  process.env.CRIMES_NO_REEXEC !== "1" &&',
  "  process.argv[1] !== undefined",
  ") {",
  "  const __crimesChild = __crimesSpawnSync(",
  "    process.execPath,",
  '    ["--liftoff-only", ...process.execArgv, process.argv[1], ...process.argv.slice(2)],',
  '    { stdio: "inherit" },',
  "  );",
  "  if (!__crimesChild.error) {",
  "    if (__crimesChild.signal) process.kill(process.pid, __crimesChild.signal);",
  "    process.exit(__crimesChild.status ?? 1);",
  "  }",
  "}",
].join("\n");

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
  noExternal: [/^@crimes\//, "commander", "fast-glob", "picocolors", "picomatch", "zod"],
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
      'import { spawnSync as __crimesSpawnSync } from "node:child_process";',
      "const require = __createRequire(import.meta.url);",
      "const __filename = __fileURLToPath(import.meta.url);",
      "const __dirname = __pathDirname(__filename);",
      REEXEC_LIFTOFF,
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
    // The Java, Kotlin and Swift grammars travel the same way; the runtime blob
    // above is shared by every tree-sitter pack.
    copyJavaWasmAssets(resolve(here, "dist"));
    copyKotlinWasmAssets(resolve(here, "dist"));
    copySwiftWasmAssets(resolve(here, "dist"));
  },
});
