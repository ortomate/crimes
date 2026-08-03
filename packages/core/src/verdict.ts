import { execFile } from "node:child_process";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
import { diff } from "./diff.js";
import type { Finding, Severity } from "./finding.js";
import { SCHEMA_VERSION } from "./finding.js";
import { treeHashForRef } from "./git/archive.js";
import { isGitRepo, NotAGitRepoError } from "./git/changed-files.js";

const execFileAsync = promisify(execFile);

/**
 * Weighted severity score used by the verdict judgement.
 *
 * The weights are intentionally simple — a coarse "is this branch net better
 * or net worse?" signal, not a precise debt measurement. They form a 3 / 2 / 1
 * scale so that a single new high finding outweighs anything short of
 * fixing a high finding too.
 */
export const SEVERITY_WEIGHT: Record<Severity, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * One of four headline verdicts. Always one of these — `unknown` is not a
 * valid state; environment errors throw instead so the CLI can exit 2.
 */
export type Verdict = "cleaner" | "worse" | "unchanged" | "mixed";

/**
 * Threshold at which a `crimes verdict` run becomes a failing CI gate.
 *
 * - `"worse"` — fail when the verdict is `"worse"`.
 * - `"new-high"` — fail when any new finding has `severity: "high"`.
 * - `"new-medium"` — fail when any new finding has `severity: "medium"` or
 *   `"high"`.
 *
 * `undefined` keeps the command advisory (always exit 0).
 */
export type VerdictFailOn = "worse" | "new-high" | "new-medium";

export interface VerdictSummary {
  new: number;
  fixed: number;
  unchanged: number;
  new_by_severity: { high: number; medium: number; low: number };
  fixed_by_severity: { high: number; medium: number; low: number };
  /** Σ SEVERITY_WEIGHT over `new_findings`. */
  new_weighted: number;
  /** Σ SEVERITY_WEIGHT over `fixed_findings`. */
  fixed_weighted: number;
}

export interface VerdictReport {
  schema_version: typeof SCHEMA_VERSION;
  report_type: "verdict";
  repo: { name: string; root: string };
  base: string;
  head: string;
  verdict: Verdict;
  summary: VerdictSummary;
  /** Short, machine-friendly reasons that drove the verdict. */
  reasons: string[];
  /** Short, human-readable next-step suggestions. */
  recommended_actions: string[];
  /** Findings present at `head` but not at `base`. */
  new_findings: Finding[];
  /** Findings present at `base` but not at `head`. */
  fixed_findings: Finding[];
  /**
   * Number of new findings filtered out by `.crimes/suppressions.json`.
   * Only present when ≥1 suppression matched on the new set.
   */
  suppressed_count?: number;
}

export interface VerdictOptions {
  /** Absolute or relative path to the repo. Defaults to cwd. */
  root?: string;
  /**
   * Base ref. When omitted, {@link resolveDefaultBase} picks one — what
   * `origin/HEAD` points at when the repo says, else `origin/main`,
   * `main`, `origin/master`, `master`. Throws
   * {@link NoDefaultBaseError} if none resolves.
   */
  base?: string;
  /** Head ref. Defaults to `"HEAD"`. */
  head?: string;
  /**
   * When true, suppressed new findings stay in `new_findings` annotated
   * with `suppressed: true` and `suppression_reason`. Defaults to false.
   */
  showSuppressed?: boolean;
}

export class NoDefaultBaseError extends Error {
  constructor(tried: string[]) {
    super(
      `could not pick a default base ref (tried ${tried.join(", ")}). ` +
        `Pass --base <ref> explicitly, e.g. --base main.`,
    );
    this.name = "NoDefaultBaseError";
  }
}

/**
 * Pure judgement logic. Takes two pre-classified finding sets and returns
 * the verdict + the reasons that drove it. Used by tests so they don't need
 * a git repo.
 *
 * Rules (in order):
 * 1. No new and no fixed → `unchanged`.
 * 2. Any new high → `worse`.
 * 3. `new_weighted > fixed_weighted` → `worse`.
 * 4. `fixed_weighted > new_weighted` AND no new high → `cleaner`.
 * 5. Otherwise (both sides non-zero with equal weight, or any other
 *    ambiguity) → `mixed`.
 */
export function judgeVerdict(args: {
  newFindings: Finding[];
  fixedFindings: Finding[];
}): {
  verdict: Verdict;
  reasons: string[];
  summary: VerdictSummary;
} {
  const summary = summariseVerdict(args);
  const reasons: string[] = [];

  const hasAnyChange = args.newFindings.length > 0 || args.fixedFindings.length > 0;
  const hasNewHigh = summary.new_by_severity.high > 0;
  const hasFixedHigh = summary.fixed_by_severity.high > 0;

  if (!hasAnyChange) {
    return {
      verdict: "unchanged",
      reasons: ["no new findings and no fixed findings"],
      summary,
    };
  }

  let verdict: Verdict;

  if (hasNewHigh) {
    verdict = "worse";
    reasons.push(
      `introduced ${summary.new_by_severity.high} high-severity crime${
        summary.new_by_severity.high === 1 ? "" : "s"
      }`,
    );
    if (hasFixedHigh) {
      reasons.push(
        `cleared ${summary.fixed_by_severity.high} high-severity crime${
          summary.fixed_by_severity.high === 1 ? "" : "s"
        } (does not offset new high findings)`,
      );
    }
  } else if (summary.new_weighted > summary.fixed_weighted) {
    verdict = "worse";
    reasons.push(
      `new weighted severity ${summary.new_weighted} > fixed weighted severity ${summary.fixed_weighted}`,
    );
  } else if (summary.fixed_weighted > summary.new_weighted) {
    verdict = "cleaner";
    reasons.push(
      `fixed weighted severity ${summary.fixed_weighted} > new weighted severity ${summary.new_weighted}`,
    );
  } else {
    // Both sides are non-zero (we already returned on the all-zero case) and
    // weights are equal — net-zero change. Or one side is empty and weights
    // happen to match (only possible when both are zero, already handled).
    verdict = "mixed";
    reasons.push(`new and fixed weighted severity tied at ${summary.new_weighted}`);
  }

  return { verdict, reasons, summary };
}

/**
 * Suggest one or two short next-step lines for the user, keyed off the
 * verdict. Deterministic — no LLM, no detector-specific advice.
 */
export function recommendActions(args: {
  verdict: Verdict;
  summary: VerdictSummary;
}): string[] {
  const out: string[] = [];

  if (args.verdict === "worse" && args.summary.new_by_severity.high > 0) {
    out.push("fix new high-severity findings before merging.");
    return out;
  }

  if (args.verdict === "worse") {
    out.push("review the new findings — they outweigh the cleanups on this branch.");
    return out;
  }

  if (args.verdict === "cleaner") {
    out.push("ship it — this branch removes more crime weight than it adds.");
    return out;
  }

  if (args.verdict === "unchanged") {
    out.push("no maintainability change vs. base — verdict is advisory only.");
    return out;
  }

  // mixed
  out.push(
    "trade-off — review new findings and confirm the fixed ones are intentional cleanups.",
  );
  return out;
}

function summariseVerdict(args: {
  newFindings: Finding[];
  fixedFindings: Finding[];
}): VerdictSummary {
  const newBySev = { high: 0, medium: 0, low: 0 };
  const fixedBySev = { high: 0, medium: 0, low: 0 };
  let newWeighted = 0;
  let fixedWeighted = 0;

  for (const f of args.newFindings) {
    newBySev[f.severity] += 1;
    newWeighted += SEVERITY_WEIGHT[f.severity];
  }
  for (const f of args.fixedFindings) {
    fixedBySev[f.severity] += 1;
    fixedWeighted += SEVERITY_WEIGHT[f.severity];
  }

  return {
    new: args.newFindings.length,
    fixed: args.fixedFindings.length,
    unchanged: 0, // overwritten by `verdict()` when used end-to-end
    new_by_severity: newBySev,
    fixed_by_severity: fixedBySev,
    new_weighted: newWeighted,
    fixed_weighted: fixedWeighted,
  };
}

/**
 * Ordered fallbacks, used only when the repo does not say what its
 * default branch is. `master` is included because a great many repos
 * never renamed, and omitting it meant `crimes verdict` refused to run
 * on them at all rather than guessing slightly wrong.
 */
const BASE_CANDIDATES = ["origin/main", "main", "origin/master", "master"];

/**
 * Pick a default base ref.
 *
 * **Ask git before guessing.** `refs/remotes/origin/HEAD` is what the
 * remote says its default branch is, so when it is set it beats any
 * name-ordered candidate list — a repo whose remote defaults to
 * `master` while a local `main` also exists would otherwise be compared
 * against the wrong branch silently, which is worse than the failure
 * this replaces.
 *
 * Falls back to {@link BASE_CANDIDATES} when `origin/HEAD` is unset,
 * which is the common case for a repo cloned with `--single-branch` or
 * created locally. Throws {@link NoDefaultBaseError} when nothing
 * resolves — the CLI surfaces that as exit 2 pointing at `--base`.
 */
export async function resolveDefaultBase(root: string): Promise<string> {
  const fromRemote = await remoteDefaultBranch(root);
  if (fromRemote !== undefined && (await refExists(root, fromRemote))) {
    return fromRemote;
  }
  for (const ref of BASE_CANDIDATES) {
    if (await refExists(root, ref)) return ref;
  }
  throw new NoDefaultBaseError(BASE_CANDIDATES);
}

/**
 * What `refs/remotes/origin/HEAD` points at, as a ref usable directly
 * (`origin/master`). Undefined when the symbolic ref is unset, which is
 * not an error — plenty of working repos never have it.
 */
async function remoteDefaultBranch(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      { cwd },
    );
    const ref = stdout.trim();
    return ref.length > 0 ? ref : undefined;
  } catch {
    return undefined;
  }
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--verify", "--quiet", ref], {
      cwd,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a verdict against the current repo. Defers to `crimes diff` for the
 * heavy lifting (archive-export each ref, run a deterministic scan in a
 * temp dir, classify by stable fingerprint), then layers the judgement +
 * summary fields on top.
 *
 * Throws:
 * - {@link NotAGitRepoError} when `root` is not inside a git repository.
 * - {@link NoDefaultBaseError} when `base` is omitted and no default
 *   branch resolves.
 * - {@link UnknownGitRefError} when an explicit ref fails to resolve.
 */
export async function verdict(options: VerdictOptions = {}): Promise<VerdictReport> {
  const root = resolve(options.root ?? process.cwd());
  const head = options.head ?? "HEAD";

  if (!(await isGitRepo(root))) {
    throw new NotAGitRepoError(root);
  }

  const base = options.base ?? (await resolveDefaultBase(root));

  const showSuppressed = options.showSuppressed ?? false;
  // Defer suppression handling to `diff()` — the diff already loads
  // `.crimes/suppressions.json` from `root`, applies entries to the new
  // set, and exposes the matched count via `suppressed_count`.
  const diffReport = await diff({ root, base, head, showSuppressed });

  // Gate logic must always evaluate against the unsuppressed slice of
  // the new set, regardless of whether annotated entries are visible.
  const gateNewFindings = diffReport.new_findings.filter((f) => f.suppressed !== true);
  const judged = judgeVerdict({
    newFindings: gateNewFindings,
    fixedFindings: diffReport.fixed_findings,
  });

  // Preserve the unchanged count from the underlying diff so the verdict
  // summary stays a strict superset of the diff summary.
  const summary: VerdictSummary = {
    ...judged.summary,
    new: diffReport.new_findings.length,
    unchanged: diffReport.summary.unchanged,
  };

  const recommended_actions = recommendActions({
    verdict: judged.verdict,
    summary,
  });

  // "no new findings and no fixed findings" is true of an unchanged
  // verdict either way, but it reads as a judgement about the code when
  // the real answer is that there was nothing to judge. Say which.
  const reasons = [...judged.reasons];
  const baseTree = await treeHashForRef({ repoRoot: root, ref: base });
  const headTree = await treeHashForRef({ repoRoot: root, ref: head });
  if (baseTree !== undefined && baseTree === headTree) {
    reasons.push(`${base} and ${head} resolve to identical trees — nothing to compare`);
  }

  const report: VerdictReport = {
    schema_version: SCHEMA_VERSION,
    report_type: "verdict",
    repo: {
      name: basename(root),
      root,
    },
    base,
    head,
    verdict: judged.verdict,
    summary,
    reasons,
    recommended_actions,
    new_findings: diffReport.new_findings,
    fixed_findings: diffReport.fixed_findings,
  };
  if (diffReport.suppressed_count !== undefined) {
    report.suppressed_count = diffReport.suppressed_count;
  }
  return report;
}

/**
 * Apply a `--fail-on` threshold to a verdict report. Returns `true` when the
 * CLI should exit non-zero.
 *
 * - `"worse"` — fail when `verdict === "worse"`.
 * - `"new-high"` — fail when any new finding is `severity: "high"`.
 * - `"new-medium"` — fail when any new finding is `severity: "medium"` or
 *   `"high"`.
 */
export function shouldFailVerdict(report: VerdictReport, failOn: VerdictFailOn): boolean {
  switch (failOn) {
    case "worse":
      return report.verdict === "worse";
    case "new-high":
      return report.summary.new_by_severity.high > 0;
    case "new-medium":
      return (
        report.summary.new_by_severity.high > 0 ||
        report.summary.new_by_severity.medium > 0
      );
  }
}
