import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

/**
 * Default path the suppressions file lives at, relative to the repo root.
 * Mirrors `.crimes/baseline.json`: same parent directory, intended to be
 * committed, hand-reviewable in PRs.
 */
export const DEFAULT_SUPPRESSIONS_PATH = ".crimes/suppressions.json";

/**
 * Default glob patterns that classify files as non-domain. Used as the
 * runtime default for `scopeTiers.nonDomain` when the user has not
 * supplied that key. Empty array opts out of tiering entirely.
 */
export const DEFAULT_NON_DOMAIN_PATTERNS: string[] = [
  "scripts/**",
  "examples/**",
  "fixtures/**",
  "public/**",
  "**/__tests__/**",
  "**/*.test.{ts,tsx,js,jsx}",
  "**/*.spec.{ts,tsx,js,jsx}",
];

/**
 * Default value for `scan.topFiles` — how many files appear in the
 * default file-grouped view of `crimes scan`.
 */
export const DEFAULT_TOP_FILES = 5;

/**
 * Default Git ref used by the resurfacing pipeline. `crimes scan`
 * compares the current branch against this ref to find triaged or
 * baselined findings whose files have been touched. Override per repo
 * via `crimes.config.json` `triage.resurfaceBase`; empty string opts
 * out of resurfacing entirely.
 */
export const DEFAULT_RESURFACE_BASE = "main";

/**
 * `crimes.config.json` shape. All fields are optional and back-compat —
 * a config from `crimes@0.4.0` keeps loading unchanged, and a config that
 * sets only the new fields keeps the existing defaults for the rest.
 */
export interface CrimesConfig {
  /** Optional `$schema` URL for IDE validation. Parsed but otherwise ignored. */
  $schema?: string;
  include: string[];
  exclude: string[];
  thresholds: {
    largeFileLines: number;
    largeFunctionLines: number;
    todoDensityPerKLoc: number;
    /**
     * Per-shape `large_function` overrides. Any subset is fine — unset
     * shapes use the built-in defaults documented in
     * `packages/core/src/detectors/large-function.ts`.
     *
     * The `domain` entry wins over the legacy top-level
     * `thresholds.largeFunctionLines` when both are set.
     */
    largeFunction?: {
      domain?: number;
      route_handler?: number;
      react_component?: number;
      page_export?: number;
      test_callback?: number;
      cli_command_registrar?: number;
      unknown?: number;
    };
    /**
     * Per-shape `large_file` overrides. Any subset is fine — unset shapes
     * use the built-in defaults documented in
     * `packages/core/src/detectors/large-file.ts`.
     *
     * The `domain` entry wins over the legacy top-level
     * `thresholds.largeFileLines` when both are set.
     */
    largeFile?: {
      domain?: number;
      test_file?: number;
    };
    /**
     * Severity thresholds for `oversized_raster`. Sizes are in KB
     * (1 KB = 1024 bytes). A subset is fine — unset levels fall back to
     * the built-in defaults (`lowKb: 200`, `mediumKb: 500`,
     * `highKb: 1000`), which mirror common web-perf guidance.
     *
     * Severity rule: `< lowKb` → no finding; `[lowKb, mediumKb)` → low;
     * `[mediumKb, highKb)` → medium; `>= highKb` → high.
     */
    assetWeight?: {
      lowKb?: number;
      mediumKb?: number;
      highKb?: number;
    };
  };
  /**
   * Asset-file discovery overrides. Asset detectors (raster sizing,
   * raster-should-be-vector, SVG-with-embedded-raster) run a second
   * pass over files that don't parse as TS/JS. `include`/`exclude`
   * are independent of the top-level source `include`/`exclude` so
   * users can tune asset discovery without touching source scope.
   */
  assets?: {
    include?: string[];
    exclude?: string[];
  };
  /**
   * IA seed overrides. Always **additive** to
   * `DEFAULT_ALIAS_GROUPS` from `packages/core/src/ia/aliases.ts`. A future
   * `aliasGroupsReplace: true` opt-in could replace the built-in list.
   */
  ia?: {
    aliasGroups?: Array<{
      id: string;
      aliases: string[];
      preferred?: string;
    }>;
  };
  /**
   * Detector toggles and per-detector options.
   *
   * - `enable` is an allowlist (empty/omitted means all built-ins).
   * - `disable` is a blocklist that runs **after** `enable`.
   * - `options.<id>` carries per-detector exemption values (e.g.
   *   `allowedNames`, `allowedLiterals`). Each detector declares an
   *   optional zod schema via `Detector.optionsSchema`; the loader
   *   validates the supplied options against that schema at config
   *   load time. Unknown detector ids and unsupported keys for known
   *   detectors raise {@link ConfigParseError}. Setting `options.<id>`
   *   for a known detector that has no `optionsSchema` is also an
   *   error — that detector accepts no options.
   */
  detectors?: {
    enable?: string[];
    disable?: string[];
    options?: Record<string, unknown>;
  };
  /**
   * Two-tier scope classification. Patterns under `nonDomain` mark files
   * whose findings should appear in a separate "Also flagged elsewhere"
   * section instead of competing with domain findings for the default
   * top-N. Empty array opts out of tiering entirely.
   */
  scopeTiers: {
    nonDomain: string[];
  };
  /**
   * `crimes scan` rendering knobs.
   *
   * - `topFiles`: how many files appear in the default file-grouped view.
   *   `--top N` (CLI) and `--all` (CLI) override per invocation.
   */
  scan: {
    topFiles: number;
  };
  /** Suppression file path override. Defaults to `.crimes/suppressions.json`. */
  suppressions?: {
    path?: string;
  };
  /**
   * Reserved — schema-validated but not consumed in 0.5.0. The shape
   * mirrors `PRD.md` §18 so the eventual implementation doesn't have to
   * rev the schema again.
   */
  architecture?: {
    layers?: Array<{ name: string; pattern: string }>;
    rules?: Array<{ from: string; cannotImport: string[] }>;
  };
  /**
   * Triage workflow knobs.
   *
   * - `resurfaceBase`: Git ref used to detect "touched files" for the
   *   triage- and baseline-aware resurfacing pipeline introduced in
   *   Release B. Empty string disables resurfacing entirely.
   */
  triage?: {
    resurfaceBase: string;
  };
}

/**
 * Default source-file include patterns. Broader than just TS/JS so
 * universal-pack detectors (`large_file`, `todo_density`,
 * `hardcoded_localhost`, `hardcoded_local_path`, `commented_out_code`,
 * `finder_duplicate_filename`, `missing_agent_context`,
 * `docs_code_drift`) fire on every common source language. Language
 * packs still only run on files their pack claims by extension
 * (`language-js` claims the `*.{ts,tsx,js,jsx,mjs,cjs,cts,mts}`
 * subset). Asset detectors use `assets.include` instead, not this list.
 */
export const DEFAULT_SOURCE_INCLUDES: string[] = [
  // JavaScript / TypeScript (language-js pack)
  "**/*.{ts,tsx,js,jsx,mjs,cjs,cts,mts}",
  // Python (language-py pack, 0.14.0)
  "**/*.{py,pyi}",
  // Other popular source languages — universal pack only for now
  "**/*.{rs,go,rb,java,kt,scala,swift,c,h,cpp,hpp,cs,php,ex,exs,lua,sh,bash,zsh}",
  // Documentation (docs_code_drift detects broken links here)
  "**/*.{md,mdx}",
];

export const DEFAULT_CONFIG: CrimesConfig = {
  include: DEFAULT_SOURCE_INCLUDES,
  exclude: [
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/.next/**",
    "**/out/**",
    "**/coverage/**",
    "**/*.min.js",
    "**/*.generated.*",
    "**/.crimes/**",
  ],
  thresholds: {
    largeFileLines: 300,
    largeFunctionLines: 60,
    todoDensityPerKLoc: 10,
    assetWeight: {
      lowKb: 200,
      mediumKb: 500,
      highKb: 1000,
    },
  },
  assets: {
    include: ["**/*.{png,jpg,jpeg,gif,webp,avif,svg}"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/.next/**",
      "**/out/**",
      "**/coverage/**",
      "**/.crimes/**",
      "**/public/vendor/**",
      "**/__snapshots__/**",
      // Test / scenario fixtures often carry intentionally-broken
      // assets (oversized inputs, icon-sized rasters that demonstrate
      // the smell). Scans of a fixture root pass through cleanly —
      // this only excludes nested `fixtures/` directories.
      "**/fixtures/**",
      "**/*.test.{png,jpg,jpeg,gif,webp,avif,svg}",
    ],
  },
  scopeTiers: { nonDomain: DEFAULT_NON_DOMAIN_PATTERNS },
  scan: { topFiles: DEFAULT_TOP_FILES },
  triage: { resurfaceBase: DEFAULT_RESURFACE_BASE },
};

/**
 * One advisory issue surfaced while loading a config. Unknown keys are
 * silently merged today, so no warnings are produced — `issues` exists
 * for future soft-warning use (deprecated keys, conflicting overrides).
 */
export interface ConfigIssue {
  severity: "warning";
  message: string;
}

export interface LoadConfigResult {
  config: CrimesConfig;
  issues: ConfigIssue[];
  /** Absolute path that was read, or `undefined` when no file exists. */
  path?: string;
}

/**
 * Raised when `crimes.config.json` is present but unreadable or
 * structurally invalid. The CLI maps this to exit-code 2 with the
 * single-line message produced here.
 */
export class ConfigParseError extends Error {
  path: string;
  constructor(path: string, reason: string) {
    super(`crimes.config.json at ${path} is invalid: ${reason}`);
    this.name = "ConfigParseError";
    this.path = path;
  }
}

const aliasGroupSchema = z.object({
  id: z.string().min(1),
  aliases: z.array(z.string().min(1)).min(1),
  preferred: z.string().min(1).optional(),
});

const largeFunctionShapesSchema = z
  .object({
    domain: z.number().int().positive().optional(),
    route_handler: z.number().int().positive().optional(),
    react_component: z.number().int().positive().optional(),
    page_export: z.number().int().positive().optional(),
    test_callback: z.number().int().positive().optional(),
    cli_command_registrar: z.number().int().positive().optional(),
    unknown: z.number().int().positive().optional(),
  })
  .strict();

const largeFileShapesSchema = z
  .object({
    domain: z.number().int().positive().optional(),
    test_file: z.number().int().positive().optional(),
  })
  .strict();

const assetWeightSchema = z
  .object({
    lowKb: z.number().int().positive().optional(),
    mediumKb: z.number().int().positive().optional(),
    highKb: z.number().int().positive().optional(),
  })
  .strict();

const thresholdsSchema = z
  .object({
    largeFileLines: z.number().int().positive().optional(),
    largeFunctionLines: z.number().int().positive().optional(),
    todoDensityPerKLoc: z.number().int().nonnegative().optional(),
    largeFunction: largeFunctionShapesSchema.optional(),
    largeFile: largeFileShapesSchema.optional(),
    assetWeight: assetWeightSchema.optional(),
  })
  .strict();

const assetsSchema = z
  .object({
    include: z.array(z.string().min(1)).optional(),
    exclude: z.array(z.string().min(1)).optional(),
  })
  .strict();

const detectorsSchema = z
  .object({
    enable: z.array(z.string().min(1)).optional(),
    disable: z.array(z.string().min(1)).optional(),
    options: z.record(z.string().min(1), z.unknown()).optional(),
  })
  .strict();

/**
 * Minimal slice of {@link Detector} that the config loader consumes for
 * validating `detectors.options.<id>`. Pass {@link buildDetectorRegistry}
 * from the scan entry points; direct callers that don't need
 * options-validation may omit the registry.
 */
export interface DetectorRegistryEntry {
  id: string;
  optionsSchema?: z.ZodType<unknown>;
}

export type DetectorRegistry = readonly DetectorRegistryEntry[];

const iaSchema = z
  .object({
    aliasGroups: z.array(aliasGroupSchema).optional(),
  })
  .strict();

const suppressionsConfigSchema = z
  .object({
    path: z.string().min(1).optional(),
  })
  .strict();

const architectureSchema = z
  .object({
    layers: z
      .array(
        z
          .object({
            name: z.string().min(1),
            pattern: z.string().min(1),
          })
          .strict(),
      )
      .optional(),
    rules: z
      .array(
        z
          .object({
            from: z.string().min(1),
            cannotImport: z.array(z.string().min(1)).min(1),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

const scopeTiersSchema = z
  .object({
    nonDomain: z.array(z.string().min(1)),
  })
  .strict();

const scanSchema = z
  .object({
    topFiles: z.number().int().positive(),
  })
  .strict();

const triageSchema = z
  .object({
    resurfaceBase: z.string(),
  })
  .strict();

/**
 * Top-level schema. Unknown keys are stripped (and ignored) so future
 * config releases can extend the file without breaking old CLI builds.
 * Known keys with malformed _values_ raise a {@link ConfigParseError}.
 */
export const CrimesConfigSchema = z
  .object({
    $schema: z.string().optional(),
    include: z.array(z.string().min(1)).optional(),
    exclude: z.array(z.string().min(1)).optional(),
    thresholds: thresholdsSchema.optional(),
    assets: assetsSchema.optional(),
    detectors: detectorsSchema.optional(),
    scopeTiers: scopeTiersSchema.optional(),
    scan: scanSchema.optional(),
    triage: triageSchema.optional(),
    ia: iaSchema.optional(),
    suppressions: suppressionsConfigSchema.optional(),
    architecture: architectureSchema.optional(),
  })
  .passthrough();

/**
 * Load `crimes.config.json` from the given root and merge it with
 * {@link DEFAULT_CONFIG}.
 *
 * Throws {@link ConfigParseError} when the file exists but is unreadable,
 * not JSON, or contains a known key with a malformed value. The CLI maps
 * this to exit code 2.
 *
 * When `registry` is provided, every `detectors.options.<id>` block is
 * validated against the detector's registered `optionsSchema` (or
 * rejected as "no options accepted" / "unknown detector id"). When
 * omitted, options-level validation is skipped — useful for tests and
 * for direct programmatic callers that don't carry a detector list.
 */
export function loadConfig(
  root: string,
  registry?: DetectorRegistry,
): CrimesConfig {
  return loadConfigDetailed(root, registry).config;
}

/**
 * Same as {@link loadConfig} but returns the soft-issues list alongside
 * the merged config. Reserved for programmatic consumers that want to
 * surface advisory warnings; the CLI prefers the throw-on-error path.
 */
export function loadConfigDetailed(
  root: string,
  registry?: DetectorRegistry,
): LoadConfigResult {
  const path = resolve(root, "crimes.config.json");
  if (!existsSync(path)) {
    return { config: DEFAULT_CONFIG, issues: [] };
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ConfigParseError(path, `unable to read file — ${message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ConfigParseError(path, `invalid JSON — ${message}`);
  }

  const result = CrimesConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigParseError(path, formatZodIssues(result.error.issues));
  }

  const merged = mergeConfig(DEFAULT_CONFIG, result.data as CrimesConfig);
  if (registry !== undefined) {
    validateDetectorOptions(merged, registry, path);
  }
  return { config: merged, issues: [], path };
}

/**
 * Walk `config.detectors.options` and validate each entry against the
 * registry. Three failure modes, all `ConfigParseError`:
 *
 * 1. Unknown detector id — the user typed an id that no built-in
 *    detector exposes.
 * 2. Known detector with no `optionsSchema` — that detector accepts
 *    no options; the block is likely a typo.
 * 3. Schema validation failure — the value's shape doesn't match the
 *    detector's declared options.
 */
function validateDetectorOptions(
  config: CrimesConfig,
  registry: DetectorRegistry,
  path: string,
): void {
  const options = config.detectors?.options;
  if (!options) return;
  const byId = new Map<string, DetectorRegistryEntry>();
  for (const entry of registry) byId.set(entry.id, entry);
  for (const [detectorId, value] of Object.entries(options)) {
    const entry = byId.get(detectorId);
    if (!entry) {
      throw new ConfigParseError(
        path,
        `detectors.options.${detectorId}: unknown detector id`,
      );
    }
    if (!entry.optionsSchema) {
      throw new ConfigParseError(
        path,
        `detectors.options.${detectorId}: this detector accepts no options`,
      );
    }
    const parsed = entry.optionsSchema.safeParse(value);
    if (!parsed.success) {
      throw new ConfigParseError(
        path,
        `detectors.options.${detectorId}: ${formatZodIssues(parsed.error.issues)}`,
      );
    }
  }
}

function formatZodIssues(issues: z.core.$ZodIssue[]): string {
  // Surface the first malformed value precisely — the user fixes it and
  // re-runs. Subsequent issues, if any, surface on the next run.
  const first = issues[0];
  if (!first) return "validation failed";
  const path = first.path.length > 0 ? first.path.join(".") : "(root)";
  return `${path}: ${first.message}`;
}

function mergeConfig(base: CrimesConfig, override: CrimesConfig): CrimesConfig {
  const merged: CrimesConfig = {
    include: override.include ?? base.include,
    exclude: override.exclude ?? base.exclude,
    thresholds: {
      ...base.thresholds,
      ...stripUndefined(override.thresholds ?? {}),
    },
    // scopeTiers.nonDomain replaces the default wholesale when set, matching
    // the contract of the top-level `include` / `exclude` lists. An explicit
    // empty array is a valid opt-out, so we use ?? (not ||).
    scopeTiers: {
      nonDomain:
        override.scopeTiers !== undefined
          ? override.scopeTiers.nonDomain
          : (base.scopeTiers.nonDomain ?? DEFAULT_NON_DOMAIN_PATTERNS),
    },
    // scan.topFiles replaces the default wholesale when set.
    scan: {
      topFiles:
        override.scan !== undefined
          ? override.scan.topFiles
          : (base.scan.topFiles ?? DEFAULT_TOP_FILES),
    },
    // triage.resurfaceBase replaces the default wholesale when set.
    triage: {
      resurfaceBase:
        override.triage !== undefined
          ? override.triage.resurfaceBase
          : (base.triage?.resurfaceBase ?? DEFAULT_RESURFACE_BASE),
    },
  };
  if (override.$schema !== undefined) merged.$schema = override.$schema;
  if (override.thresholds?.largeFunction !== undefined) {
    merged.thresholds.largeFunction = { ...override.thresholds.largeFunction };
  }
  if (override.thresholds?.largeFile !== undefined) {
    merged.thresholds.largeFile = { ...override.thresholds.largeFile };
  }
  // assetWeight merges field-by-field so a user-supplied `mediumKb` keeps
  // the default `lowKb` / `highKb` instead of wiping them.
  if (
    override.thresholds?.assetWeight !== undefined ||
    base.thresholds.assetWeight !== undefined
  ) {
    merged.thresholds.assetWeight = {
      ...base.thresholds.assetWeight,
      ...stripUndefined(override.thresholds?.assetWeight ?? {}),
    };
  }
  // assets.include / assets.exclude each replace the default wholesale
  // when set — same contract as the top-level `include` / `exclude`.
  if (override.assets !== undefined || base.assets !== undefined) {
    merged.assets = {
      include: override.assets?.include ?? base.assets?.include,
      exclude: override.assets?.exclude ?? base.assets?.exclude,
    };
  }
  if (override.detectors !== undefined) merged.detectors = override.detectors;
  if (override.ia !== undefined) merged.ia = override.ia;
  if (override.suppressions !== undefined) {
    merged.suppressions = override.suppressions;
  }
  if (override.architecture !== undefined) {
    merged.architecture = override.architecture;
  }
  return merged;
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/**
 * Resolve the suppressions file path for a given root, honouring
 * `config.suppressions.path` when set. Relative paths resolve against the
 * repo root; absolute paths win unchanged.
 */
export function resolveSuppressionsPath(
  root: string,
  config: CrimesConfig,
): string {
  const override = config.suppressions?.path;
  if (!override) return resolve(root, DEFAULT_SUPPRESSIONS_PATH);
  return resolve(root, override);
}
