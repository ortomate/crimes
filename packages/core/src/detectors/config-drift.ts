import { z } from "zod";
import type { LanguageJsDetector } from "../detector.js";
import type { PreFinding as Finding } from "../finding.js";
import {
  ConfidenceLadder,
  SeverityLadder,
  scoreRationale,
} from "../scoring/confidence.js";
import type { EnvIndex, EnvVariableRecord } from "../risk/types.js";

/**
 * Environment Roulette — one setting, treated as several different
 * things.
 *
 * ## What it detects
 *
 * The detector builds an inventory of every environment read in the repo
 * and reports variables whose handling disagrees between call sites:
 *
 *  - **type** — parsed as an integer here, compared as a string there
 *  - **unit** — one read treats `_MS` as milliseconds, another divides it
 *  - **default** — two call sites supply different fallbacks
 *  - **requiredness** — one site asserts it must exist, another shrugs
 *  - **boundary bypass** — a direct read in a repo that has a central
 *    config module
 *  - **client exposure** — a server-shaped secret read through a
 *    `NEXT_PUBLIC_` / `VITE_` prefix, or from a file that looks
 *    browser-reachable
 *  - **undocumented** — used in code, absent from `.env.example`
 *  - **unused** — documented but never read (low severity)
 *
 * ## Values are never reported
 *
 * Only names, locations, parsers, and *defaults written as literals in
 * committed source*. A real `.env` is never opened — the discovery glob
 * excludes it and a second independent filter rejects it — so there is no
 * path by which a secret reaches a finding.
 *
 * ## What it deliberately does not claim
 *
 * That a bundler will actually ship a value to the browser. Client
 * reachability is a path heuristic, and the finding says "appears to be
 * reachable from client code" because proving a bundling outcome needs
 * the bundler.
 */

const optionsSchema = z
  .object({
    /** Report variables used in code but absent from `.env.example`. Default true. */
    reportUndocumented: z.boolean().optional(),
    /** Report variables documented but never read. Default false — low value, high volume. */
    reportUnused: z.boolean().optional(),
    /**
     * Report direct reads that bypass a central config module. Only
     * applies when such a module was detected. Default true.
     */
    reportBoundaryBypass: z.boolean().optional(),
    /** Variable names to ignore entirely. */
    ignoreNames: z.array(z.string().min(1)).optional(),
    /**
     * Extra prefixes that expose a value to client bundles, beyond the
     * built-in `NEXT_PUBLIC_` / `VITE_` / `PUBLIC_` / `REACT_APP_` set.
     */
    publicPrefixes: z.array(z.string().min(1)).optional(),
  })
  .strict();

type Options = z.infer<typeof optionsSchema>;

const MAX_FINDINGS = 12;

/**
 * Name fragments that mean a value must not reach a browser.
 *
 * Boundaries are `_` or string edges rather than `\b`, because
 * environment variables are SCREAMING_SNAKE and `_` is a word character:
 * `\bSECRET\b` does not match inside `STRIPE_SECRET_KEY`, which is
 * precisely the name this needs to catch.
 */
const SECRET_NAME_RE =
  /(^|_)(SECRET|PRIVATE|PASSWORD|PASSWD|TOKEN|CREDENTIAL|CREDENTIALS|APIKEY|KEY|SIGNING|SALT|CERT|DSN|CONNECTION)(_|$)/i;

export const configDriftDetector: LanguageJsDetector = {
  id: "config_drift",
  name: "Environment Roulette",
  description:
    "Builds an inventory of environment-variable reads and flags settings " +
    "that are parsed as different types, given different defaults, treated " +
    "as required in one place and optional in another, read past a central " +
    "config boundary, exposed to client bundles, or used without being " +
    "documented.",
  whyItMatters:
    "A setting handled two ways is a bug that only appears in the " +
    "environment where the two paths disagree — usually production, " +
    "usually at 3am. `TIMEOUT` parsed as an integer in one module and " +
    "compared as a string in another works fine until someone sets it. " +
    "Agents make this worse by adding a read wherever they happen to be " +
    "working, with whatever default seems reasonable there, because " +
    "nothing in the file says a canonical treatment already exists.",

  pack: "language-js",
  optionsSchema,

  run(ctx) {
    const risk = ctx.risk;
    if (!risk) return [];
    const env = risk.env;

    const options = readOptions(ctx.config);
    const ignore = new Set((options.ignoreNames ?? []).map((n) => n.toUpperCase()));
    const extraPrefixes = options.publicPrefixes ?? [];

    const findings: Finding[] = [];

    for (const variable of env.variables) {
      if (findings.length >= MAX_FINDINGS) break;
      if (ignore.has(variable.name.toUpperCase())) continue;
      // Emit once per variable, anchored at its lexicographically first
      // reading file — stable when unrelated files change.
      if (variable.anchorFile !== ctx.file) continue;

      const finding = assessVariable(variable, env, options, extraPrefixes);
      if (finding) findings.push(finding);
    }

    if (options.reportUnused === true && risk.anchorFile === ctx.file) {
      // A documented-but-unused variable has no reading file, so there is
      // nothing natural to anchor emission on. It emits at the repo
      // anchor — the first source file the risk index processed — while
      // the finding's `file` points at the inventory that documents it.
      const unusedFinding = assessUnused(env, ignore);
      if (unusedFinding) findings.push(unusedFinding);
    }

    findings.sort((a, b) => {
      const lineDelta = (a.lines?.[0] ?? 0) - (b.lines?.[0] ?? 0);
      return lineDelta !== 0 ? lineDelta : (a.symbol ?? "").localeCompare(b.symbol ?? "");
    });
    return findings;
  },
};

/* ------------------------------------------------------------------ *
 * Per-variable assessment
 * ------------------------------------------------------------------ */

interface Issue {
  id: string;
  label: string;
  /** Evidence lines describing the disagreement. */
  detail: string[];
  severityDelta: number;
  confidenceDelta: number;
}

function assessVariable(
  variable: EnvVariableRecord,
  env: EnvIndex,
  options: Options,
  extraPrefixes: string[],
): Finding | undefined {
  const issues: Issue[] = [];

  // --- type / parser disagreement -----------------------------------
  const realParsers = variable.parsers.filter((p) => p !== "(none)");
  const distinctParsers = new Set(realParsers.map(normaliseParser));
  if (distinctParsers.size >= 2) {
    issues.push({
      id: "type_disagreement",
      label: "parsed as different types",
      detail: [
        `parsers observed: ${realParsers.join(", ")}`,
        ...variable.reads
          .filter((r) => r.parser !== undefined)
          .slice(0, 5)
          .map((r) => `  ${r.file}:${r.line} parses as ${r.parser}`),
      ],
      severityDelta: 0.22,
      confidenceDelta: 0.14,
    });
  }

  // --- default disagreement -----------------------------------------
  if (variable.defaults.length >= 2) {
    issues.push({
      id: "default_disagreement",
      label: "given different defaults",
      detail: [
        `defaults observed: ${variable.defaults.join(", ")}`,
        ...variable.reads
          .filter((r) => r.defaultValue !== undefined)
          .slice(0, 5)
          .map((r) => `  ${r.file}:${r.line} defaults to ${r.defaultValue}`),
      ],
      severityDelta: 0.18,
      confidenceDelta: 0.16,
    });
  }

  // --- requiredness disagreement ------------------------------------
  if (variable.anyRequired && variable.anyOptional && variable.files.length >= 2) {
    const required = variable.reads.filter((r) => r.required);
    const optional = variable.reads.filter((r) => !r.required);
    issues.push({
      id: "requiredness_disagreement",
      label: "required in one place, optional in another",
      detail: [
        `${required.length} read(s) treat it as required, ${optional.length} do not`,
        ...required.slice(0, 2).map((r) => `  required at ${r.file}:${r.line}`),
        ...optional.slice(0, 2).map((r) => `  optional at ${r.file}:${r.line}`),
      ],
      severityDelta: 0.12,
      confidenceDelta: 0.1,
    });
  }

  // --- unit disagreement --------------------------------------------
  // A `_MS`-suffixed variable divided by 1000 somewhere is the classic
  // seconds-vs-milliseconds bug. The signal available statically is a
  // name that declares one unit while a read parses it as a float, or
  // two reads implying different units.
  if (variable.units.length >= 2) {
    issues.push({
      id: "unit_disagreement",
      label: "read with conflicting units",
      detail: [`units implied by the name: ${variable.units.join(", ")}`],
      severityDelta: 0.24,
      confidenceDelta: 0.1,
    });
  }

  // --- client exposure ----------------------------------------------
  const prefixed = variable.reads.find((r) => r.publicPrefix !== undefined);
  const looksSecret = SECRET_NAME_RE.test(variable.name);
  const customPrefix = extraPrefixes.find((p) => variable.name.startsWith(p));
  if (looksSecret && (prefixed !== undefined || customPrefix !== undefined)) {
    issues.push({
      id: "client_exposed_secret",
      label: "server-shaped value carries a client-exposing prefix",
      detail: [
        `\`${variable.name}\` begins with \`${prefixed?.publicPrefix ?? customPrefix}\`, ` +
          "which bundlers inline into client output",
        "the name matches a secret-shaped pattern (SECRET / TOKEN / KEY / PASSWORD / URL)",
      ],
      severityDelta: 0.45,
      confidenceDelta: 0.18,
    });
  } else {
    const clientRead = variable.reads.find((r) => r.clientReachable);
    if (looksSecret && clientRead !== undefined) {
      issues.push({
        id: "client_reachable_secret",
        label: "server-shaped value read from apparently client-reachable code",
        detail: [
          `read at ${clientRead.file}:${clientRead.line}, which appears to be ` +
            "client-side by path convention",
          "note: whether a bundler actually ships this depends on the build; " +
            "this is a path heuristic, not a bundling proof",
        ],
        severityDelta: 0.3,
        confidenceDelta: 0.02,
      });
    }
  }

  // --- central-boundary bypass --------------------------------------
  if (options.reportBoundaryBypass !== false && env.configModules.length > 0) {
    const outside = variable.reads.filter((r) => !r.central);
    const inside = variable.reads.filter((r) => r.central);
    if (inside.length > 0 && outside.length > 0) {
      issues.push({
        id: "boundary_bypass",
        label: "read directly despite a central config module",
        detail: [
          `this repo funnels configuration through ${env.configModules.slice(0, 2).join(", ")}`,
          `\`${variable.name}\` is also read directly at ` +
            outside
              .slice(0, 3)
              .map((r) => `${r.file}:${r.line}`)
              .join(", "),
        ],
        severityDelta: 0.08,
        confidenceDelta: 0.08,
      });
    }
  }

  // --- undocumented --------------------------------------------------
  if (
    options.reportUndocumented !== false &&
    env.inventoryFiles.length > 0 &&
    !variable.documented
  ) {
    issues.push({
      id: "undocumented",
      label: "used but not documented",
      detail: [
        `\`${variable.name}\` is read in ${variable.files.length} file(s) but does ` +
          `not appear in ${env.inventoryFiles.join(", ")}`,
        "a new environment will start without it and fail in whichever way " +
          "the missing value happens to break",
      ],
      severityDelta: 0.05,
      confidenceDelta: 0.06,
    });
  }

  if (issues.length === 0) return undefined;

  // A single low-value issue on a single-file variable is not worth a
  // finding: "undocumented" alone, read once, is a chore not a risk.
  const onlySoftIssues = issues.every((i) => i.severityDelta <= 0.06);
  if (onlySoftIssues && variable.files.length < 2) return undefined;

  return buildFinding(variable, issues);
}

function buildFinding(variable: EnvVariableRecord, issues: Issue[]): Finding {
  const anchor = variable.reads.find((r) => r.file === variable.anchorFile)!;

  const confidence = new ConfidenceLadder(0.55);
  for (const issue of issues) {
    confidence.add(true, issue.label, issue.confidenceDelta);
  }
  confidence.add(
    variable.files.length >= 3,
    `read in ${variable.files.length} files`,
    0.06,
  );

  const severity = new SeverityLadder(0.25);
  for (const issue of issues) {
    severity.add(true, issue.label, issue.severityDelta);
  }

  const evidence: string[] = [
    `variable: ${variable.name}`,
    `${variable.reads.length} read(s) across ${variable.files.length} file(s)`,
  ];
  for (const read of variable.reads.slice(0, 6)) {
    const parts = [
      `via ${read.via}`,
      read.parser !== undefined ? `parsed as ${read.parser}` : "no parse",
      read.defaultValue !== undefined ? `default ${read.defaultValue}` : "no default",
      read.required ? "required" : "not asserted",
    ];
    evidence.push(`  ${read.file}:${read.line} — ${parts.join(", ")}`);
  }
  if (variable.reads.length > 6) {
    evidence.push(`  +${variable.reads.length - 6} further read(s)`);
  }

  for (const issue of issues) {
    evidence.push(`issue — ${issue.label}:`);
    for (const line of issue.detail) evidence.push(`  ${line}`);
  }
  evidence.push(
    "no configuration values are reported by this detector — names, " +
      "locations, and literal defaults written in committed source only",
  );
  const rationale = scoreRationale(confidence, severity);

  return {
    id: "",
    type: "config_drift",
    charge: "Environment Roulette",
    severity: severity.severity(),
    confidence: confidence.value(),
    file: variable.anchorFile,
    lines: [anchor.line, anchor.line],
    symbol: variable.name,
    summary:
      `\`${variable.name}\` is ${issues.map((i) => i.label).join("; ")} ` +
      `across ${variable.files.length} file(s). The behaviour depends on which ` +
      "code path reads it first.",
    evidence,
    score_rationale: rationale,
    effort: "small",
    fix_shape: "parse each setting once, in one module; everyone imports it",
    scores: {
      severity: severity.score(),
      confidence: confidence.value(),
    },
    suggested_actions: buildActions(variable, issues),
    related_files: variable.files.filter((f) => f !== variable.anchorFile),
  };
}

function buildActions(
  variable: EnvVariableRecord,
  issues: Issue[],
): Finding["suggested_actions"] {
  const actions: NonNullable<Finding["suggested_actions"]> = [];
  const ids = new Set(issues.map((i) => i.id));

  if (ids.has("client_exposed_secret")) {
    actions.push({
      kind: "unprefix_secret",
      description:
        `Rename \`${variable.name}\` to drop the public prefix and read it ` +
        "only on the server. If the client genuinely needs a value, expose a " +
        "scoped, non-secret one instead — and rotate the current value, since " +
        "a prefixed secret should be assumed to have shipped.",
      risk: "high",
    });
  }
  if (
    ids.has("type_disagreement") ||
    ids.has("default_disagreement") ||
    ids.has("unit_disagreement")
  ) {
    actions.push({
      kind: "centralise_parse",
      description:
        `Parse \`${variable.name}\` once — one module, one coercion, one ` +
        "default, one unit — and have every consumer import the parsed value " +
        "rather than reading the raw variable.",
      risk: "medium",
    });
  }
  if (ids.has("requiredness_disagreement")) {
    actions.push({
      kind: "declare_requiredness",
      description:
        `Decide whether \`${variable.name}\` is required and enforce it at ` +
        "startup, so a missing value fails on boot rather than on the first " +
        "request that happens to need it.",
      risk: "low",
    });
  }
  if (ids.has("boundary_bypass")) {
    actions.push({
      kind: "route_through_config",
      description:
        "Route the direct reads through the existing config module so the " +
        "canonical treatment applies everywhere.",
      risk: "low",
    });
  }
  if (ids.has("undocumented")) {
    actions.push({
      kind: "document_variable",
      description:
        `Add \`${variable.name}\` to the committed environment inventory so a ` +
        "fresh environment can be brought up from the checked-in docs.",
      risk: "low",
    });
  }
  return actions;
}

/* ------------------------------------------------------------------ *
 * Documented-but-unused
 * ------------------------------------------------------------------ */

function assessUnused(env: EnvIndex, ignore: Set<string>): Finding | undefined {
  const used = new Set(env.variables.map((v) => v.name));
  const unused = [...env.documentedNames]
    .filter((name) => !used.has(name) && !ignore.has(name.toUpperCase()))
    .sort();
  if (unused.length === 0) return undefined;
  // A computed read means the code may consume names this scan cannot
  // enumerate, so "unused" would be a guess.
  if (env.hasDynamicReads) return undefined;

  const anchor = env.inventoryFiles[0]!;
  const confidence = new ConfidenceLadder(0.5).add(
    unused.length >= 3,
    `${unused.length} documented names have no reader`,
    0.1,
  );

  return {
    id: "",
    type: "config_drift",
    charge: "Environment Roulette",
    severity: "low",
    confidence: confidence.value(),
    file: anchor,
    lines: [1, 1],
    symbol: "(documented but unused)",
    summary:
      `${unused.length} variable(s) documented in ${anchor} are never read in ` +
      "code. Operators are being asked to set values that do nothing.",
    evidence: [
      `inventory file: ${anchor}`,
      `documented but unread: ${unused.slice(0, 12).join(", ")}` +
        (unused.length > 12 ? `, +${unused.length - 12} more` : ""),
      "no computed `process.env[…]` reads were found, so the code's variable " +
        "set is fully enumerable and this list is not a guess",
    ],
    score_rationale: scoreRationale(confidence),
    effort: "quick",
    fix_shape: "delete the stale entries, or wire them up",
    scores: {
      severity: 0.2,
      confidence: confidence.value(),
    },
    suggested_actions: [
      {
        kind: "prune_env_inventory",
        description:
          "Remove entries no code reads, so the documented inventory stays a " +
          "reliable description of what the service actually needs.",
        risk: "low",
      },
    ],
  };
}

/**
 * Collapse parser variants that mean the same thing. `Number`,
 * `parseInt`, and `parseFloat` are all "this is a number" — reporting
 * them as a type disagreement would flag every codebase that uses both
 * spellings.
 */
function normaliseParser(parser: string): string {
  if (parser === "int" || parser === "float" || parser === "number") return "number";
  return parser;
}

function readOptions(config: {
  detectors?: { options?: Record<string, unknown> };
}): Options {
  const raw = config.detectors?.options?.config_drift;
  if (raw === undefined) return {};
  const parsed = optionsSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}
