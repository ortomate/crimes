import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

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

const STATIC_TEST_GLOBS = ["**/*.test.{ts,tsx,js,jsx}", "**/*.spec.{ts,tsx,js,jsx}"];

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
    let entries;
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
  const include = ["**/*.{ts,tsx,js,jsx,mjs,cjs}"];
  const exclude = [
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/.next/**",
    "**/out/**",
    "**/coverage/**",
    "**/*.min.js",
    "**/*.generated.*",
    "**/.crimes/**",
  ];
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
    if (shape.isTsOnly) include[0] = "**/*.{ts,tsx}";
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
