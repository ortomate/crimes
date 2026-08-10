import type { Dirent } from "node:fs";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_CONFIG, DEFAULT_SOURCE_INCLUDES } from "@crimes/core";

export interface RepoShape {
  isMonorepo: boolean;
  isNextJs: boolean;
  isVite: boolean;
  isTsOnly: boolean;
  scopeTiers: string[];
}

const DIR_PATTERNS: Array<[string, string]> = [
  ["scripts", "scripts/**"],
  ["examples", "examples/**"],
  ["fixtures", "fixtures/**"],
  ["public", "public/**"],
  ["__tests__", "**/__tests__/**"],
];

const STATIC_TEST_GLOBS = [
  "**/*.test.{ts,tsx,js,jsx}",
  "**/*.spec.{ts,tsx,js,jsx}",
  // Python test conventions. Without these a pytest suite is scored as
  // production code — see docs/dogfooding/2026-08-02-0.14-to-0.17.md §3.10.
  "**/test_*.py",
  "**/*_test.py",
];

/**
 * The JS-family entry inside `DEFAULT_SOURCE_INCLUDES`. Narrowing this
 * one glob is the only include change `--detect` is allowed to make:
 * dropping the others would make `crimes init` scan *less* than a
 * zero-config run, which is how a repo's whole Python tree can vanish.
 */
const JS_FAMILY_GLOB = "**/*.{ts,tsx,js,jsx,mjs,cjs,cts,mts}";
const TS_ONLY_GLOB = "**/*.{ts,tsx}";

export async function detectRepoShape(root: string): Promise<RepoShape> {
  const exists = (path: string) => existsSync(join(root, path));

  const isMonorepo =
    exists("pnpm-workspace.yaml") || exists("turbo.json") || exists("lerna.json");

  const isNextJs =
    exists("next.config.js") ||
    exists("next.config.mjs") ||
    exists("next.config.cjs") ||
    exists("next.config.ts");

  const isVite =
    exists("vite.config.js") || exists("vite.config.mjs") || exists("vite.config.ts");

  const isTsOnly = await scanForJsFamilyAbsence(root);

  const scopeTiers: string[] = [];
  for (const [dir, pattern] of DIR_PATTERNS) {
    if (exists(dir)) scopeTiers.push(pattern);
  }
  scopeTiers.push(...STATIC_TEST_GLOBS);

  return { isMonorepo, isNextJs, isVite, isTsOnly, scopeTiers };
}

async function scanForJsFamilyAbsence(root: string): Promise<boolean> {
  // Walk a bounded depth; stop on first .js/.jsx/.mjs/.cjs hit.
  const queue: string[] = [root];
  let visited = 0;
  while (queue.length > 0 && visited < 1000) {
    const dir = queue.shift()!;
    // `readdir` is overloaded; name the element type rather than
    // reaching through ReturnType, which resolves to the Buffer overload.
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "dist")
        continue;
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        queue.push(path);
        continue;
      }
      visited += 1;
      if (/\.(jsx?|mjs|cjs)$/.test(e.name)) return false;
    }
  }
  return true;
}

export interface GenerateConfigOptions {
  root: string;
  detect: boolean;
}

export async function generateConfig(options: GenerateConfigOptions): Promise<string> {
  // Start from the same list a zero-config scan uses. `crimes init` must
  // never make crimes see less than it would with no config at all.
  const include = [...DEFAULT_SOURCE_INCLUDES];
  // Derived, never hand-copied. The literal list that used to live here
  // fell 11 patterns behind when the `.json`/`.yaml` includes landed —
  // every lockfile and `tsconfig*.json` — so `crimes init` wrote a config
  // that scanned `pnpm-lock.yaml` and reported it as a high `large_file`.
  // The suite pinning this function's "does not narrow the scan"
  // invariant only ever checked `include`, so nothing caught it.
  const exclude = [...DEFAULT_CONFIG.exclude];
  let scopeTiers = [
    "scripts/**",
    "examples/**",
    "fixtures/**",
    "public/**",
    "**/__tests__/**",
    ...STATIC_TEST_GLOBS,
  ];

  if (options.detect) {
    const shape = await detectRepoShape(options.root);
    if (shape.isTsOnly) {
      const js = include.indexOf(JS_FAMILY_GLOB);
      if (js !== -1) include[js] = TS_ONLY_GLOB;
    }
    if (shape.isNextJs) exclude.push("**/.next/**", "**/.vercel/**");
    if (shape.isVite) exclude.push("**/dist/**");
    scopeTiers = shape.scopeTiers;
  }

  const config = {
    $schema: "https://crimes.sh/schema/0.1.0/config.json",
    include,
    exclude: dedupe(exclude),
    thresholds: { largeFileLines: 300, largeFunctionLines: 60, todoDensityPerKLoc: 10 },
    scopeTiers: { nonDomain: scopeTiers },
    scan: { topFiles: 5 },
    detectors: { enable: [], disable: [] },
    ia: { aliasGroups: [] },
    suppressions: { path: ".crimes/suppressions.json" },
  };
  return serializeConfig(config);
}

/**
 * Serialize config to JSON. Short (single-element) arrays are kept on one
 * line so the output stays readable; longer arrays use normal pretty-print.
 */
function serializeConfig(config: object): string {
  // Use a replacer-free stringify to get standard pretty-print, then
  // collapse single-element string arrays to compact form.
  const raw = JSON.stringify(config, null, 2);
  // Collapse patterns like:
  //   [
  //     "single-value"
  //   ]
  // into: ["single-value"]
  const collapsed = raw.replace(/\[\n\s+"([^"]+)"\n\s+\]/g, '["$1"]');
  return collapsed + "\n";
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr));
}
