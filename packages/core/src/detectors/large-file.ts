import type { CrimesConfig } from "../config.js";
import type { UniversalDetector } from "../detector.js";
import type { PreFinding as Finding, Severity } from "../finding.js";
import { isTestFile } from "../util/test-files.js";

type LargeFileShape = "domain" | "test_file" | "docs" | "data" | "stylesheet";

/**
 * Prose and markup files: reference documentation, not modules.
 *
 * Kept deliberately narrow — extensions whose whole purpose is prose.
 * `.json`, `.yaml`, and friends are data, and a 3000-line config is a
 * finding worth keeping.
 */
export const DOCS_EXT_RE = /\.(md|mdx|markdown|rst|adoc|asciidoc|txt)$/i;

/**
 * Structured data: records, fixtures, exports and configuration.
 *
 * These are scanned (see `DEFAULT_SOURCE_INCLUDES`) and a hand-maintained
 * 3000-line config is still a finding worth keeping — that decision is
 * unchanged. What changes is the *severity*: field notes from rolecred
 * (2026-09-22) recorded generated audit JSON arriving as `high` and
 * outranking the runtime changes the developer had come to review.
 *
 * Extension is the only signal available here. The universal pack has no
 * parser, and `looksGeneratedSource` cannot help: JSON has no comment
 * syntax, so a generated `.json` carries no banner to find. Lockfiles and
 * manifests are already excluded by path in `DEFAULT_CONFIG`.
 */
export const DATA_EXT_RE = /\.(json|jsonc|json5|yaml|yml|toml)$/i;

/**
 * Stylesheets with their own budget (0.31.0). Templates are not here:
 * a JSP holds logic and markup together, and is held to the code budget.
 */
export const STYLESHEET_EXT_RE = /\.(?:less|css)$/i;

/**
 * Default line budget for the `stylesheet` shape.
 *
 * A stylesheet is a flat list of rules that mostly do not depend on one
 * another, so its length costs an agent navigation — finding the rule —
 * rather than the reasoning a long module costs. Twice the code budget:
 * on a 948-file LESS estate the code budget reported 84 files (median
 * 445 lines) and this one 16, the largest of them still at medium.
 */
const DEFAULT_STYLESHEET_THRESHOLD = 600;

/**
 * Default line budget for the `docs` shape.
 *
 * Reference documentation is supposed to be long: a schema reference or
 * a configuration guide earns its length, and measuring it against the
 * 300-line domain-code budget says nothing useful. 1000 is where a
 * single document stops being one thing a reader (or an agent) can hold
 * at once and wants to become a directory of pages — which is exactly
 * the split this detector asks for.
 */
const DEFAULT_DOCS_THRESHOLD = 1000;

/**
 * Default line budget for the `data` shape.
 *
 * Matched to the `docs` budget for the same reason: like a reference
 * document, a data file is expected to be long, and measuring it against
 * the 300-line domain budget says nothing about whether anyone has to
 * maintain it.
 */
const DEFAULT_DATA_THRESHOLD = 1000;

/**
 * Per-shape size policy. `domain` reads the configured threshold so existing
 * `crimes.config.json` setups keep working; the `test_file` shape uses a much
 * higher threshold because test suites legitimately grow with many small
 * `it()` blocks, and `docs` higher still because prose is not code.
 *
 *   shape      | threshold | sev @ thr | sev @ 2× thr
 *   -----------+-----------+-----------+-------------
 *   domain     | config    | medium    | high
 *   test_file  |   1500    | low       | medium
 *   docs       |   1000    | low       | medium
 */
interface LargeFilePolicy {
  threshold: number;
  severityAtThreshold: Severity;
  severityAtTwoX: Severity;
  label: string;
  agentRiskScale: number;
}

/**
 * Resolve the size policy for one file. The `domain` threshold comes from
 * `thresholds.largeFile.domain` when set, else the legacy
 * `thresholds.largeFileLines` (kept for back-compat). The `test_file` and
 * `docs` thresholds honour `thresholds.largeFile.test_file` /
 * `thresholds.largeFile.docs` when present; otherwise the built-in
 * defaults apply.
 */
export function policyForFile(
  shape: LargeFileShape,
  config: CrimesConfig,
): LargeFilePolicy {
  const overrides = config.thresholds.largeFile;
  if (shape === "test_file") {
    return {
      threshold: overrides?.test_file ?? 1500,
      severityAtThreshold: "low",
      severityAtTwoX: "medium",
      label: "test file",
      agentRiskScale: 0.5,
    };
  }
  if (shape === "data") {
    return {
      threshold: overrides?.data ?? DEFAULT_DATA_THRESHOLD,
      severityAtThreshold: "low",
      severityAtTwoX: "medium",
      label: "data file",
      // Below the document scale. An agent asked to change behaviour
      // rarely has to load a data file at all, where an oversized
      // document it has been told to follow must be read to be obeyed.
      agentRiskScale: 0.5,
    };
  }
  if (shape === "stylesheet") {
    return {
      threshold: overrides?.stylesheet ?? DEFAULT_STYLESHEET_THRESHOLD,
      severityAtThreshold: "low",
      severityAtTwoX: "medium",
      label: "stylesheet",
      // Below code: an edit to one rule rarely depends on the rest.
      agentRiskScale: 0.6,
    };
  }
  if (shape === "docs") {
    return {
      threshold: overrides?.docs ?? DEFAULT_DOCS_THRESHOLD,
      severityAtThreshold: "low",
      severityAtTwoX: "medium",
      label: "document",
      // Above the test-file scale: an oversized document is still a real
      // context cost, because an agent asked to follow it has to load the
      // whole thing to find the paragraph that applies.
      agentRiskScale: 0.6,
    };
  }
  return {
    threshold: overrides?.domain ?? config.thresholds.largeFileLines,
    severityAtThreshold: "medium",
    severityAtTwoX: "high",
    label: "file",
    agentRiskScale: 1,
  };
}

/**
 * Classify a file into a size-policy shape.
 *
 * `docs` is checked first: nothing that matches {@link DOCS_EXT_RE} is a
 * test module, and checking prose first keeps the two rules from having
 * to know about each other.
 */
export function shapeForFile(file: string): LargeFileShape {
  if (DOCS_EXT_RE.test(file)) return "docs";
  // Before the test-file rule: a fixture named `users.test.json` is data
  // whichever way it is read, and the data budget is the lower of the two.
  if (DATA_EXT_RE.test(file)) return "data";
  if (STYLESHEET_EXT_RE.test(file)) return "stylesheet";
  return isTestFile(file) ? "test_file" : "domain";
}

export const largeFileDetector: UniversalDetector = {
  id: "large_file",
  name: "Large File",
  description:
    "Flags files that exceed a per-shape line-count threshold " +
    "(domain code and test files each carry their own budget).",
  whyItMatters:
    "Files this large are hard to read in one breath and exceed many " +
    "agents' practical context budget. They concentrate unrelated changes, " +
    "so every PR's diff is harder to review and easier to break. Splitting " +
    "by responsibility keeps each module independently understandable.",

  pack: "universal",
  async run(ctx) {
    // Universal pack: no AST. lineCount comes from newline-split source.
    // The "N top-level functions" evidence line the language-js variant
    // emitted is intentionally dropped — we don't have a parser. Severity
    // policy is unchanged.
    const source = await ctx.readSource();
    const shape = shapeForFile(ctx.file);
    const policy = policyForFile(shape, ctx.config);
    const lines = ctx.lineCount;

    if (lines <= policy.threshold) return [];
    // A stylesheet library copied in by hand (a theme's `bootstrap.css`)
    // is vendored wherever it sits; its length is not the repo's to fix.
    if (shape === "stylesheet" && looksLibraryStylesheet(source)) return [];

    const ratio = lines / policy.threshold;
    const severity = ratio >= 2 ? policy.severityAtTwoX : policy.severityAtThreshold;
    const confidence = Math.min(0.7 + (ratio - 1) * 0.15, 0.95);

    const isDomain = shape === "domain";
    const summary = isDomain
      ? `File is ${lines} lines (threshold ${policy.threshold}). Modules this large hide local coupling: small edits can collide with code an agent never loaded into context.`
      : shape === "docs"
        ? `${capitalise(policy.label)} is ${lines} lines (${policy.label} threshold ${policy.threshold}). Documents this long are read in fragments: a reader or agent looking for one rule loads the whole file and may act on the wrong section.`
        : shape === "data"
          ? `${capitalise(policy.label)} is ${lines} lines (${policy.label} threshold ${policy.threshold}). Check whether it is generated or bulk data before acting: length is a maintenance signal only for a file somebody edits by hand.`
          : shape === "stylesheet"
            ? `${capitalise(policy.label)} is ${lines} lines (${policy.label} threshold ${policy.threshold}). Rules this far apart are found by search rather than by reading, and a change to one can be overridden by another the editor never saw.`
            : `${capitalise(policy.label)} is ${lines} lines (${policy.label} threshold ${policy.threshold}). Modules this large hide local coupling: small edits can collide with code an agent never loaded into context.`;
    const thresholdEvidence = isDomain
      ? `${ratio.toFixed(1)}× the configured ${policy.threshold}-line threshold`
      : `${ratio.toFixed(1)}× the configured ${policy.threshold}-line ${policy.label} threshold`;

    const finding: Finding = {
      id: "", // filled in by scan.ts
      type: "large_file",
      charge: "God File",
      severity,
      confidence: round(confidence),
      file: ctx.file,
      lines: [1, lines],
      summary,
      evidence: [
        // "non-empty lines" was never what this counted — blank lines are
        // included. Say what the number is rather than what it isn't.
        `${lines} lines`,
        thresholdEvidence,
        ...(shape === "test_file"
          ? ["shape: test file (matches **/*.{test,spec}.[jt]sx? or __tests__/)"]
          : []),
        ...(shape === "docs"
          ? ["shape: document (matches .md/.mdx/.markdown/.rst/.adoc/.txt)"]
          : []),
        ...(shape === "data"
          ? ["shape: data file (matches .json/.jsonc/.json5/.yaml/.yml/.toml)"]
          : []),
        ...(shape === "stylesheet" ? ["shape: stylesheet (matches .less/.css)"] : []),
      ],
      effort: "medium",
      fix_shape:
        shape === "docs"
          ? "split into per-topic pages; one subject per document"
          : shape === "data"
            ? "exclude it if it is generated; split by subject if it is maintained by hand"
            : shape === "stylesheet"
              ? "split into partials by component or page"
              : "split by responsibility; one concern per module",
      scores: {
        severity: severityScore(severity),
        confidence: round(confidence),
        agent_risk: round(
          Math.min(0.45 * policy.agentRiskScale + (ratio - 1) * 0.18, 0.9),
        ),
      },
      suggested_actions: [
        {
          kind: shape === "data" ? "exclude_or_split_data" : "split_file",
          description: suggestedActionFor(shape),
          risk: "medium",
        },
      ],
    };

    return [finding];
  },
};

function suggestedActionFor(shape: LargeFileShape): string {
  if (shape === "data") {
    return (
      "Confirm whether the file is generated. If it is, exclude it in " +
      "crimes.config.json so it stops competing with code findings; if it " +
      "is maintained by hand, split it by subject."
    );
  }
  if (shape === "test_file") {
    return (
      "Split the suite into per-feature or per-scenario files so each " +
      "behaviour can be discovered, run, and diffed in isolation."
    );
  }
  if (shape === "stylesheet") {
    return (
      "Split into partials per component or page, imported by the bundle, " +
      "so the rules for one thing live in one place."
    );
  }
  if (shape === "docs") {
    return (
      "Split into per-topic pages with an index, so a reader can find " +
      "the section that applies without loading the whole document."
    );
  }
  return (
    "Split along clear responsibility boundaries. Smaller modules give " +
    "humans and agents a smaller surface to reason about per edit."
  );
}

function severityScore(s: Severity): number {
  return s === "high" ? 0.85 : s === "medium" ? 0.6 : 0.35;
}

function capitalise(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * A stylesheet that opens with a library's preserved-licence banner:
 * `/*!` followed, within a few lines, by a semantic version and a
 * copyright, licence or project URL (`/*! Bootstrap v3.4.1 (https://…)`).
 * Minifiers and copy-in distributions keep exactly this comment; a
 * repository's own stylesheets rarely start with one.
 */
export function looksLibraryStylesheet(source: string): boolean {
  const head = source.slice(0, 600);
  const banner = /^\s*\/\*!([\s\S]*?)\*\//.exec(head);
  if (banner === null) return false;
  const text = banner[1]!;
  return (
    /\bv?\d+\.\d+\.\d+\b/.test(text) && /copyright|licen[cs]e|https?:\/\//i.test(text)
  );
}
