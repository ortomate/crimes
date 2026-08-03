import { basename, resolve } from "node:path";
import { loadConfig } from "./config.js";
import { fingerprintFinding } from "./fingerprint.js";
import type { Finding } from "./finding.js";
import { SCHEMA_VERSION } from "./finding.js";
import { treeHashForRef, withRefCheckout } from "./git/archive.js";
import { isGitRepo, NotAGitRepoError } from "./git/changed-files.js";
import { scan } from "./scan.js";
import { loadSuppressionsForRoot, partitionFindings } from "./suppressions.js";

export interface DiffOptions {
  /** Absolute or relative path to the repo. Defaults to cwd. */
  root?: string;
  /** Base ref, e.g. `"main"` or `"origin/main"`. */
  base: string;
  /** Head ref. Defaults to `"HEAD"`. */
  head?: string;
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

/**
 * Threshold at which `crimes diff --fail-on` becomes a failing CI gate.
 *
 * - `"new-high"` — fail when any new finding has `severity: "high"`.
 * - `"new-medium"` — fail when any new finding has `"medium"` or `"high"`.
 *
 * Mirrors `crimes verdict --fail-on`'s thresholds minus `"worse"` —
 * `diff` doesn't carry a verdict, so the verdict-aware threshold is
 * meaningless here.
 */
export type DiffFailOn = "new-high" | "new-medium";

export interface DiffSummary {
  new: number;
  fixed: number;
  unchanged: number;
}

export interface DiffReport {
  schema_version: typeof SCHEMA_VERSION;
  report_type: "diff";
  repo: { name: string; root: string };
  base: string;
  head: string;
  summary: DiffSummary;
  /** Findings present at `head` but not at `base`. */
  new_findings: Finding[];
  /** Findings present at `base` but not at `head`. */
  fixed_findings: Finding[];
  /**
   * Findings present at both. The `Finding` object is taken from the `head`
   * scan, so line ranges, evidence, and the per-scan `id` reflect HEAD.
   */
  unchanged_findings: Finding[];
  /**
   * Number of new findings filtered out by `.crimes/suppressions.json`.
   * Suppressions only apply to the **new** set in a diff.
   */
  suppressed_count?: number;
  /**
   * Severity threshold the CLI gated on. Only set when the user passed
   * `--fail-on <threshold>` to `crimes diff`. Absent otherwise.
   */
  fail_on?: DiffFailOn;
  /**
   * True when at least one non-suppressed finding in `new_findings` meets
   * `fail_on`. Only set when `fail_on` is set. Drives the gate exit code.
   */
  failed?: boolean;
}

export class InvalidDiffRangeError extends Error {
  constructor(range: string, reason: string) {
    super(
      `invalid diff range "${range}": ${reason}. ` +
        `Use the triple-dot form, e.g. main...HEAD or origin/main...HEAD.`,
    );
    this.name = "InvalidDiffRangeError";
  }
}

/**
 * Parse a triple-dot diff range (`<base>...<head>`) into its two refs.
 *
 * Accepts arbitrary refs on either side as long as they are non-empty and
 * separated by exactly one `...`. Examples:
 *
 * - `main...HEAD`
 * - `origin/main...HEAD`
 * - `v0.1.0...HEAD`
 *
 * Throws {@link InvalidDiffRangeError} when the format is wrong. Ref
 * **existence** is not checked here — that happens during scan setup.
 */
export function parseDiffRange(range: string): {
  base: string;
  head: string;
} {
  if (typeof range !== "string" || range.length === 0) {
    throw new InvalidDiffRangeError(String(range), "range is empty");
  }

  // Double-dot ranges (`base..head`) are valid in `git diff` but mean
  // something different and we don't support them yet — reject explicitly
  // rather than silently treating them as part of a ref name.
  if (range.includes("..") && !range.includes("...")) {
    throw new InvalidDiffRangeError(
      range,
      "double-dot ranges are not supported — use triple-dot (...) form",
    );
  }

  const idx = range.indexOf("...");
  if (idx === -1) {
    throw new InvalidDiffRangeError(range, "missing triple-dot separator");
  }

  // Reject 4+ dots in a row (e.g. "main....HEAD") and a second triple-dot.
  if (range.indexOf("...", idx + 3) !== -1) {
    throw new InvalidDiffRangeError(range, "exactly one '...' separator is allowed");
  }
  if (range[idx + 3] === ".") {
    throw new InvalidDiffRangeError(range, "expected exactly three dots");
  }

  const base = range.slice(0, idx);
  const head = range.slice(idx + 3);

  if (base.length === 0) {
    throw new InvalidDiffRangeError(range, "base ref is empty");
  }
  if (head.length === 0) {
    throw new InvalidDiffRangeError(range, "head ref is empty");
  }

  return { base, head };
}

/**
 * Classify two finding sets into `new`, `fixed`, and `unchanged` groups by
 * {@link fingerprintFinding} identity. Pure / synchronous — useful for
 * unit tests that don't need the git plumbing.
 *
 * For `unchanged_findings`, the returned `Finding` object is taken from
 * `headFindings` so consumers see the line ranges / evidence of the current
 * state, not the pre-edit one.
 */
export function classifyDiff(args: {
  baseFindings: Finding[];
  headFindings: Finding[];
}): {
  new_findings: Finding[];
  fixed_findings: Finding[];
  unchanged_findings: Finding[];
} {
  const baseByPrint = new Map<string, Finding>();
  for (const f of args.baseFindings) {
    if (!baseByPrint.has(fingerprintFinding(f))) {
      baseByPrint.set(fingerprintFinding(f), f);
    }
  }

  const seenInHead = new Set<string>();
  const new_findings: Finding[] = [];
  const unchanged_findings: Finding[] = [];

  for (const f of args.headFindings) {
    const print = fingerprintFinding(f);
    if (seenInHead.has(print)) continue;
    seenInHead.add(print);
    if (baseByPrint.has(print)) {
      unchanged_findings.push(f);
    } else {
      new_findings.push(f);
    }
  }

  const fixed_findings: Finding[] = [];
  for (const [print, f] of baseByPrint) {
    if (!seenInHead.has(print)) fixed_findings.push(f);
  }

  return { new_findings, fixed_findings, unchanged_findings };
}

/**
 * Run a deterministic two-ref diff. Scans `base` and `head` in isolated
 * temporary directories created from `git archive` — the working tree is
 * **never** mutated. Both temp directories are cleaned up before returning.
 *
 * Throws:
 * - {@link NotAGitRepoError} when `root` is not inside a git repository.
 * - {@link UnknownGitRefError} when either ref fails to resolve.
 */
export async function diff(options: DiffOptions): Promise<DiffReport> {
  const root = resolve(options.root ?? process.cwd());
  const head = options.head ?? "HEAD";

  // Surface a clean error before we spend time exporting anything.
  if (!(await isGitRepo(root))) {
    throw new NotAGitRepoError(root);
  }

  // Two refs resolving to the same tree have byte-identical content, so
  // the second scan is guaranteed to return what the first one did. It
  // was run anyway. On hono, `verdict --base HEAD` — a commit against
  // itself — took 12.3s / 15.8s over two runs and now takes 7.0s / 7.1s.
  //
  // Reusing the first result rather than short-circuiting the whole diff
  // keeps every field honest — `unchanged` is still the real count of
  // findings present on both sides, which a fabricated empty report
  // could not report. The saving is half the work, not all of it, and
  // half of an accurate answer beats all of a wrong one.
  const baseFindings = await scanRef({ root, ref: options.base });
  const baseTree = await treeHashForRef({ repoRoot: root, ref: options.base });
  const headTree = await treeHashForRef({ repoRoot: root, ref: head });
  const identicalTrees = baseTree !== undefined && baseTree === headTree;
  const headFindings = identicalTrees ? baseFindings : await scanRef({ root, ref: head });

  const { new_findings, fixed_findings, unchanged_findings } = classifyDiff({
    baseFindings,
    headFindings,
  });

  // Suppressions apply only to the **new** set in a diff. Fixed and
  // unchanged sets reflect prior state — suppressing those would hide
  // information the reviewer needs.
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

  const report: DiffReport = {
    schema_version: SCHEMA_VERSION,
    report_type: "diff",
    repo: {
      name: basename(root),
      root,
    },
    base: options.base,
    head,
    summary: {
      new: visibleNew.length,
      fixed: fixed_findings.length,
      unchanged: unchanged_findings.length,
    },
    new_findings: visibleNew,
    fixed_findings,
    unchanged_findings,
  };
  if (suppressedCount > 0) report.suppressed_count = suppressedCount;
  return report;
}

/**
 * Apply a {@link DiffFailOn} threshold to a diff report. Returns a new
 * report carrying `fail_on` + `failed`. Suppressed entries in
 * `new_findings` are ignored — gate semantics are independent of display.
 */
export function applyDiffFailOn(report: DiffReport, failOn: DiffFailOn): DiffReport {
  const failed = report.new_findings.some((f) => {
    if (f.suppressed === true) return false;
    if (failOn === "new-high") return f.severity === "high";
    return f.severity === "high" || f.severity === "medium";
  });
  return { ...report, fail_on: failOn, failed };
}

async function scanRef(args: { root: string; ref: string }): Promise<Finding[]> {
  return withRefCheckout({ repoRoot: args.root, ref: args.ref }, async (tmpDir) => {
    const report = await scan({ root: tmpDir });
    return report.findings;
  });
}
