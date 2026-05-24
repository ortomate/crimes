import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { systemClock } from "./clock.js";
import { loadConfig } from "./config.js";
import { fingerprintFinding } from "./fingerprint.js";
import type {
  Finding,
  ScanSummary,
  Severity,
} from "./finding.js";
import { SCHEMA_VERSION } from "./finding.js";
import { scan } from "./scan.js";
import {
  loadSuppressionsForRoot,
  partitionFindings,
} from "./suppressions.js";

/**
 * Repo-relative path under which `crimes` writes the on-disk baseline.
 * `.crimes/baseline.json` is intended to be committed — it is the team's
 * snapshot of pre-existing crimes that should not block CI.
 */
export const BASELINE_RELATIVE_PATH = ".crimes/baseline.json";

/**
 * Severity threshold at which a **new** finding (relative to the baseline)
 * causes `crimes baseline check` to fail.
 *
 * - `"low"` — any new finding fails.
 * - `"medium"` — new medium + high findings fail (the default; matches the
 *   "fail CI on new debt, ignore legacy debt" workflow).
 * - `"high"` — only new high findings fail.
 */
export type FailOn = Severity;

/**
 * Minimal per-finding shape stored in the baseline file. Carries enough to
 * (a) classify a future scan via {@link fingerprintFinding}, and (b) produce
 * a useful `fixed_findings` list in {@link BaselineCheckReport} even after
 * the underlying source has been deleted or rewritten.
 *
 * Deliberately a subset of `Finding`: we don't serialise `lines`, `evidence`,
 * `summary`, `scores`, `suggested_actions`, or per-scan `id`, since those
 * either drift between scans or are useless after the offending code is
 * gone.
 */
export interface BaselineEntry {
  fingerprint: string;
  type: string;
  charge: string;
  severity: Severity;
  file: string;
  symbol?: string;
}

/**
 * On-disk schema versions the baseline loader accepts. Mirrors the same
 * convention used in `triage.ts` and `suppressions.ts`: the loader
 * tolerates any value in this list, the writer always emits the current
 * `SCHEMA_VERSION`. Extend whenever `SCHEMA_VERSION` bumps.
 */
const ACCEPTED_BASELINE_SCHEMA_VERSIONS = ["0.1.0", "0.2.0", "0.3.0"] as const;
export type AcceptedBaselineSchemaVersion =
  (typeof ACCEPTED_BASELINE_SCHEMA_VERSIONS)[number];

export interface Baseline {
  /**
   * On-disk schema version. The loader accepts any value in
   * `ACCEPTED_BASELINE_SCHEMA_VERSIONS` (currently `"0.1.0"`, `"0.2.0"`, or
   * `"0.3.0"`); the writer always emits the current `SCHEMA_VERSION`.
   */
  schema_version: AcceptedBaselineSchemaVersion;
  /** Discriminator. Always the literal `"baseline"`. */
  report_type: "baseline";
  /** ISO-8601 timestamp at which the baseline was written. */
  created_at: string;
  /** Version of `crimes` that wrote the file. Set by the CLI when available. */
  crimes_version?: string;
  /** Best-effort repo identity. `root` is machine-specific. */
  repo?: { name: string; root: string };
  /** Severity counts at the moment the baseline was written. */
  summary: ScanSummary;
  /** All findings that existed when the baseline was captured. */
  findings: BaselineEntry[];
}

export interface BaselineCheckSummary {
  /** Total entries in the baseline. */
  total_baseline: number;
  /** Total findings in the current scan. */
  total_current: number;
  /** Findings present at HEAD but not in the baseline. */
  new: number;
  /** Findings present in the baseline but not at HEAD. */
  fixed: number;
  /** Findings present in both (matched by fingerprint). */
  unchanged: number;
  /** Severity counts on the **new** set — drives `failed`. */
  new_by_severity: { high: number; medium: number; low: number };
}

export interface BaselineCheckReport {
  schema_version: typeof SCHEMA_VERSION;
  /** Discriminator. Always the literal `"baseline_check"`. */
  report_type: "baseline_check";
  repo: { name: string; root: string };
  /** Absolute path to the baseline that was loaded. */
  baseline_path: string;
  /** Threshold at which a new finding causes `failed` to flip to true. */
  fail_on: FailOn;
  /** `true` when at least one new finding has severity ≥ `fail_on`. */
  failed: boolean;
  summary: BaselineCheckSummary;
  /** Full `Finding` objects from the current scan that aren't in the baseline. */
  new_findings: Finding[];
  /** Baseline entries with no matching fingerprint in the current scan. */
  fixed_findings: BaselineEntry[];
  /** Current-scan findings matched by fingerprint to a baseline entry. */
  unchanged_findings: Finding[];
  /**
   * Number of new findings filtered out by `.crimes/suppressions.json`.
   * Suppressions only apply to the **new** set; baseline entries are
   * already a "this is fine" snapshot.
   */
  suppressed_count?: number;
}

export class BaselineNotFoundError extends Error {
  /** Resolved absolute path of the missing baseline. */
  path: string;
  constructor(path: string) {
    super(
      `baseline file not found: ${path}. ` +
        `Run \`crimes baseline save\` to create one.`,
    );
    this.name = "BaselineNotFoundError";
    this.path = path;
  }
}

export class MalformedBaselineError extends Error {
  path: string;
  constructor(path: string, reason: string) {
    super(`baseline at ${path} is malformed: ${reason}`);
    this.name = "MalformedBaselineError";
    this.path = path;
  }
}

export interface SaveBaselineOptions {
  /** Absolute or relative path to the repo. Defaults to cwd. */
  root?: string;
  /**
   * Override the on-disk baseline path. Relative paths are resolved against
   * `root`. Defaults to `<root>/.crimes/baseline.json`.
   */
  path?: string;
  /** `crimes` version string to record. Set by the CLI from package.json. */
  crimesVersion?: string;
  /** Injected for tests so the timestamp is deterministic. */
  now?: () => Date;
}

export interface SaveBaselineResult {
  /** The baseline object that was written to disk. */
  baseline: Baseline;
  /** Absolute path the baseline was written to. */
  path: string;
}

export interface CheckBaselineOptions {
  /** Absolute or relative path to the repo. Defaults to cwd. */
  root?: string;
  /**
   * Override the on-disk baseline path. Relative paths are resolved against
   * `root`. Defaults to `<root>/.crimes/baseline.json`.
   */
  path?: string;
  /** Severity threshold for the `failed` verdict. Defaults to `"medium"`. */
  failOn?: FailOn;
  /**
   * When true, suppressed new findings stay in `new_findings` annotated
   * with `suppressed: true` and `suppression_reason`. Defaults to false.
   */
  showSuppressed?: boolean;
  /**
   * Current crimes version (semver). When provided, feedback-sourced
   * suppressions with a stale `crimes_version_pinned` minor are resurfaced
   * — kept in `new_findings` tagged `previously_suppressed: true` — so the
   * user can re-confirm. The CLI passes its own `__CRIMES_VERSION__`.
   */
  crimesVersion?: string;
}

const SEVERITY_RANK: Record<Severity, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

/**
 * Convert a `Finding` into the trimmed shape we serialise. Symbol is omitted
 * (not set to `undefined`) when absent — keeps the JSON minimal and
 * round-trips cleanly through `JSON.parse`.
 */
export function toBaselineEntry(finding: Finding): BaselineEntry {
  const entry: BaselineEntry = {
    fingerprint: fingerprintFinding(finding),
    type: finding.type,
    charge: finding.charge,
    severity: finding.severity,
    file: finding.file,
  };
  if (finding.symbol !== undefined) entry.symbol = finding.symbol;
  return entry;
}

/**
 * Classify a current scan against a set of baseline entries by stable
 * fingerprint. Pure / synchronous — usable in unit tests without any
 * filesystem plumbing.
 *
 * Mirrors `classifyDiff` from `./diff.ts`, but the baseline only carries
 * `BaselineEntry` for fixed findings (the original `Finding` may no longer
 * exist on disk), so `fixed_findings` is typed accordingly.
 */
export function classifyAgainstBaseline(args: {
  baseline: BaselineEntry[];
  current: Finding[];
}): {
  new_findings: Finding[];
  fixed_findings: BaselineEntry[];
  unchanged_findings: Finding[];
} {
  const baselineByPrint = new Map<string, BaselineEntry>();
  for (const entry of args.baseline) {
    if (!baselineByPrint.has(entry.fingerprint)) {
      baselineByPrint.set(entry.fingerprint, entry);
    }
  }

  const seenInCurrent = new Set<string>();
  const new_findings: Finding[] = [];
  const unchanged_findings: Finding[] = [];

  for (const f of args.current) {
    const print = fingerprintFinding(f);
    if (seenInCurrent.has(print)) continue;
    seenInCurrent.add(print);
    if (baselineByPrint.has(print)) {
      unchanged_findings.push(f);
    } else {
      new_findings.push(f);
    }
  }

  const fixed_findings: BaselineEntry[] = [];
  for (const [print, entry] of baselineByPrint) {
    if (!seenInCurrent.has(print)) fixed_findings.push(entry);
  }

  return { new_findings, fixed_findings, unchanged_findings };
}

/**
 * `true` when `finding.severity` is at least as severe as the configured
 * threshold. With `failOn === "medium"`, both medium and high block.
 */
export function severityAtLeast(severity: Severity, failOn: FailOn): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[failOn];
}

function resolveBaselinePath(root: string, override?: string): string {
  if (override === undefined) {
    return resolve(root, BASELINE_RELATIVE_PATH);
  }
  return isAbsolute(override) ? override : resolve(root, override);
}

/**
 * Run a scan, then write a baseline snapshot of every current finding to
 * disk. The default location is `<root>/.crimes/baseline.json`; the
 * containing directory is created if it doesn't already exist.
 *
 * The baseline is **intended to be committed**. It pins the set of
 * pre-existing crimes that future `baseline check` runs should ignore.
 */
export async function saveBaseline(
  options: SaveBaselineOptions = {},
): Promise<SaveBaselineResult> {
  const root = resolve(options.root ?? process.cwd());
  const path = resolveBaselinePath(root, options.path);
  const now = (options.now ?? systemClock)();

  const report = await scan({ root });

  const baseline: Baseline = {
    schema_version: SCHEMA_VERSION,
    report_type: "baseline",
    created_at: now.toISOString(),
    summary: report.summary,
    findings: report.findings.map(toBaselineEntry),
    repo: { name: basename(root), root },
  };
  if (options.crimesVersion) baseline.crimes_version = options.crimesVersion;

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(baseline, null, 2) + "\n", "utf8");

  return { baseline, path };
}

/**
 * Read and validate a baseline file. Throws {@link BaselineNotFoundError}
 * when the file is missing, {@link MalformedBaselineError} otherwise. Only
 * the structural invariants the rest of the codebase depends on are
 * checked — unknown fields are preserved, not rejected.
 */
export async function loadBaseline(path: string): Promise<Baseline> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (isNodeErrnoException(err) && err.code === "ENOENT") {
      throw new BaselineNotFoundError(path);
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new MalformedBaselineError(path, `invalid JSON — ${message}`);
  }

  if (!isObject(parsed)) {
    throw new MalformedBaselineError(path, "top-level value is not an object");
  }
  if (parsed["report_type"] !== "baseline") {
    throw new MalformedBaselineError(
      path,
      `expected report_type "baseline", got ${JSON.stringify(parsed["report_type"])}`,
    );
  }
  // Accept any schema_version still in the active migration window. The
  // loader tolerates prior values so users upgrading crimes don't have to
  // hand-edit baseline.json; the writer always emits the current
  // SCHEMA_VERSION on the next `crimes baseline save`. Extend
  // ACCEPTED_BASELINE_SCHEMA_VERSIONS whenever SCHEMA_VERSION bumps.
  if (
    !ACCEPTED_BASELINE_SCHEMA_VERSIONS.includes(
      parsed["schema_version"] as AcceptedBaselineSchemaVersion,
    )
  ) {
    throw new MalformedBaselineError(
      path,
      `unsupported schema_version ${JSON.stringify(parsed["schema_version"])}, ` +
        `this build of crimes understands ${ACCEPTED_BASELINE_SCHEMA_VERSIONS.map(
          (v) => `"${v}"`,
        ).join(" or ")}`,
    );
  }
  if (!Array.isArray(parsed["findings"])) {
    throw new MalformedBaselineError(path, "findings is not an array");
  }
  for (const [idx, entry] of (parsed["findings"] as unknown[]).entries()) {
    if (!isObject(entry)) {
      throw new MalformedBaselineError(
        path,
        `findings[${idx}] is not an object`,
      );
    }
    if (typeof entry["fingerprint"] !== "string") {
      throw new MalformedBaselineError(
        path,
        `findings[${idx}].fingerprint is missing or not a string`,
      );
    }
    if (typeof entry["type"] !== "string") {
      throw new MalformedBaselineError(
        path,
        `findings[${idx}].type is missing or not a string`,
      );
    }
    if (
      entry["severity"] !== "low" &&
      entry["severity"] !== "medium" &&
      entry["severity"] !== "high"
    ) {
      throw new MalformedBaselineError(
        path,
        `findings[${idx}].severity must be "low" | "medium" | "high"`,
      );
    }
  }

  return parsed as unknown as Baseline;
}

/**
 * Compare the current scan against a saved baseline.
 *
 * Behaviour:
 * - Loads `<root>/.crimes/baseline.json` (or `options.path`).
 * - Runs `scan({ root })`.
 * - Partitions findings into `new` / `fixed` / `unchanged` by stable
 *   {@link fingerprintFinding} identity.
 * - Sets `failed: true` when at least one new finding has
 *   `severity ≥ options.failOn` (default `"medium"`).
 *
 * Throws {@link BaselineNotFoundError} / {@link MalformedBaselineError}
 * — the caller is expected to surface those as exit-code-2 environment
 * errors, distinct from the exit-code-1 "blocking new findings" verdict.
 */
export async function checkBaseline(
  options: CheckBaselineOptions = {},
): Promise<BaselineCheckReport> {
  const root = resolve(options.root ?? process.cwd());
  const baselinePath = resolveBaselinePath(root, options.path);
  const failOn: FailOn = options.failOn ?? "medium";

  const baseline = await loadBaseline(baselinePath);
  const report = await scan({ root });

  const { new_findings, fixed_findings, unchanged_findings } =
    classifyAgainstBaseline({
      baseline: baseline.findings,
      current: report.findings,
    });

  // Suppressions apply only to the **new** set — baseline entries are
  // already a "this is fine" snapshot, so suppressing them is a no-op.
  const config = loadConfig(root);
  const suppressions = loadSuppressionsForRoot(root, config);
  const { visible: visibleNew, suppressedCount } = partitionFindings(
    new_findings,
    suppressions.entries,
    {
      showSuppressed: options.showSuppressed ?? false,
      ...(options.crimesVersion !== undefined
        ? { crimesVersion: options.crimesVersion }
        : {}),
    },
  );

  // Gate-relevant counts always exclude suppressed entries (gate
  // semantics are independent of display).
  const new_by_severity = { high: 0, medium: 0, low: 0 };
  for (const f of visibleNew) {
    if (f.suppressed) continue;
    new_by_severity[f.severity] += 1;
  }

  const failed = visibleNew.some(
    (f) => f.suppressed !== true && severityAtLeast(f.severity, failOn),
  );

  const result: BaselineCheckReport = {
    schema_version: SCHEMA_VERSION,
    report_type: "baseline_check",
    repo: { name: basename(root), root },
    baseline_path: baselinePath,
    fail_on: failOn,
    failed,
    summary: {
      total_baseline: baseline.findings.length,
      total_current: report.findings.length,
      new: visibleNew.length,
      fixed: fixed_findings.length,
      unchanged: unchanged_findings.length,
      new_by_severity,
    },
    new_findings: visibleNew,
    fixed_findings,
    unchanged_findings,
  };
  if (suppressedCount > 0) result.suppressed_count = suppressedCount;
  return result;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as { code?: unknown }).code === "string";
}
