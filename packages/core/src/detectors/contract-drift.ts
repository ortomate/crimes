import { z } from "zod";
import type { LanguageJsDetector } from "../detector.js";
import type { PreFinding as Finding } from "../finding.js";
import {
  ConfidenceLadder,
  SeverityLadder,
  scoreRationale,
} from "../scoring/confidence.js";
import type { ContractDisagreement, ContractDriftPair } from "../risk/types.js";
import { resolveDiscriminators } from "./disambiguate.js";

/**
 * Contract Split-Brain — two declarations that describe the same record
 * and disagree about it.
 *
 * ## Supported contract forms
 *
 * | form                  | example                                       |
 * | --------------------- | --------------------------------------------- |
 * | `interface`           | `interface User { id: string }`                |
 * | object type alias     | `type User = { id: string }`                   |
 * | Zod object schema     | `const User = z.object({ id: z.string() })`    |
 * | Valibot object schema | `const User = v.object({ id: v.string() })`    |
 *
 * Zod and Valibot are supported because both express optionality and
 * closed value sets *structurally*, so a field-level comparison against a
 * TypeScript interface is exact rather than inferred. JSON Schema,
 * OpenAPI, GraphQL SDL, and ORM model DSLs are **not** supported: each is
 * a separate parsing problem in a separate file format, and a partial
 * reading of any of them would produce confident, wrong drift reports.
 * Adding one later is additive — the detector consumes a normalised
 * contract, not the syntax that produced it.
 *
 * ## How two declarations are matched
 *
 * Both names are reduced to a concept key (`UserDTO`, `UserModel`, and
 * `User` all reduce to `user`), and the pair must additionally share at
 * least 60% of the smaller declaration's fields. **Projection markers are
 * retained in the key**, so `UserSummary`, `CreateUserInput`,
 * `PublicUser`, and `UserRow` never pair with `User` — they are supposed
 * to differ, and reporting them would be reporting the design as a bug.
 *
 * ## What it deliberately does not claim
 *
 * That one side is correct. The finding is that two independently
 * maintained declarations of one record disagree, and that nothing in the
 * build checks them against each other.
 */

const optionsSchema = z
  .object({
    /**
     * Field-set overlap required before two declarations are treated as
     * the same record, as a fraction of the smaller declaration. Default
     * 0.6. Raising it reports only near-identical pairs.
     */
    minOverlap: z.number().min(0.3).max(1).optional(),
    /**
     * Minimum disagreements before a pair is reported. Default 1.
     * Raise to 2+ in codebases that intentionally vary nullability.
     */
    minDisagreements: z.number().int().min(1).max(20).optional(),
    /** Contract names to exclude, matched case-insensitively and exactly. */
    ignoreNames: z.array(z.string().min(1)).optional(),
    /**
     * Report pairs where only requiredness differs. Default true.
     * Optional-vs-required is the single most common real drift and the
     * single most common intentional variation, so it is tunable.
     */
    reportRequiredness: z.boolean().optional(),
  })
  .strict();

type Options = z.infer<typeof optionsSchema>;

const MAX_FINDINGS = 10;

export const contractDriftDetector: LanguageJsDetector = {
  id: "contract_drift",
  name: "Contract Split-Brain",
  description:
    "Flags two declarations — interfaces, object type aliases, or Zod / " +
    "Valibot schemas — that appear to describe the same record but " +
    "disagree about field requiredness, nullability, types, or value sets.",
  whyItMatters:
    "When one declaration says a field is required and another says it is " +
    "optional, the disagreement is invisible to both type checkers: they " +
    "each check their own side and neither compares them. The failure " +
    "shows up at the boundary, at runtime, with a value that one half of " +
    "the system considers legal and the other rejects. An agent asked to " +
    "add a field will add it to whichever declaration it was shown, " +
    "widening the gap while appearing to close a ticket.",

  pack: "language-js",
  optionsSchema,

  run(ctx) {
    const risk = ctx.risk;
    if (!risk) return [];

    const options = readOptions(ctx.config);
    const minOverlap = options.minOverlap ?? 0.6;
    const minDisagreements = options.minDisagreements ?? 1;
    const ignore = new Set((options.ignoreNames ?? []).map((n) => n.toLowerCase()));

    const findings: Finding[] = [];
    for (const pair of risk.contracts.pairs) {
      if (findings.length >= MAX_FINDINGS) break;
      if (pair.anchorFile !== ctx.file) continue;
      if (pair.overlap < minOverlap) continue;
      if (ignore.has(pair.left.name.toLowerCase())) continue;
      if (ignore.has(pair.right.name.toLowerCase())) continue;

      const disagreements =
        options.reportRequiredness === false
          ? pair.disagreements.filter((d) => d.kind !== "requiredness")
          : pair.disagreements;
      if (disagreements.length < minDisagreements) continue;

      findings.push(buildFinding(pair, disagreements));
    }

    findings.sort((a, b) => {
      const lineDelta = (a.lines?.[0] ?? 0) - (b.lines?.[0] ?? 0);
      return lineDelta !== 0 ? lineDelta : a.summary.localeCompare(b.summary);
    });
    resolveDiscriminators(findings);
    return findings;
  },
};

function buildFinding(
  pair: ContractDriftPair,
  disagreements: ContractDisagreement[],
): Finding {
  const critical = disagreements.filter((d) => d.criticalReason !== undefined);
  const sameFile = pair.left.file === pair.right.file;
  const differentForms = pair.left.source !== pair.right.source;
  const bothExported = pair.left.exported && pair.right.exported;

  const confidence = new ConfidenceLadder(0.58)
    .add(pair.overlap >= 0.85, `${Math.round(pair.overlap * 100)}% field overlap`, 0.14)
    .add(
      pair.overlap >= 0.6 && pair.overlap < 0.85,
      `${Math.round(pair.overlap * 100)}% field overlap`,
      0.06,
    )
    .add(
      critical.length > 0,
      `${critical.length} disagreement(s) on critical field(s)`,
      0.1,
    )
    .add(differentForms, "declared in different forms, so no checker compares them", 0.08)
    .add(bothExported, "both declarations are exported", 0.05)
    .add(sameFile, "both declarations live in the same file (may be deliberate)", -0.12)
    .add(
      pair.left.partial || pair.right.partial,
      "one side extends an unexpanded type",
      -0.08,
    );

  // A *type* disagreement on a critical field is the most consequential
  // shape this detector finds: one side will reject values the other
  // legitimately produces. A requiredness or nullability difference on
  // the same field is a smaller problem — both sides can still represent
  // every value — so the two are scored separately rather than lumped
  // under one "critical field" signal.
  const criticalTypeConflict = critical.some(
    (d) => d.kind === "type" || d.kind === "enum_members" || d.kind === "missing_field",
  );

  const severity = new SeverityLadder(0.4)
    .add(critical.length > 0, criticalLabel(critical), 0.2)
    .add(
      criticalTypeConflict,
      "the disagreement is about the field's type, not just its optionality",
      0.12,
    )
    .add(
      disagreements.some((d) => d.kind === "enum_members"),
      "value sets disagree",
      0.12,
    )
    .add(
      disagreements.some((d) => d.kind === "missing_field"),
      "a critical field is absent from one side",
      0.12,
    )
    .add(!sameFile, "declarations are in different files", 0.06)
    .add(disagreements.length >= 3, `${disagreements.length} disagreements`, 0.06);

  const built = buildEvidence(pair, disagreements, confidence, severity);
  return {
    id: "",
    type: "contract_drift",
    charge: "Contract Split-Brain",
    severity: severity.severity(),
    confidence: confidence.value(),
    file: pair.anchorFile,
    lines:
      pair.left.file === pair.anchorFile
        ? [pair.left.line, pair.left.endLine]
        : [pair.right.line, pair.right.endLine],
    symbol: pair.left.file === pair.anchorFile ? pair.left.name : pair.right.name,
    // One declaration drifting against several others anchors every
    // pair on the same (type, file, symbol) triple — 26 findings were
    // lost to it on n8n. The other side identifies the pair and is
    // stable across scans. `resolveDiscriminators` drops it again
    // wherever the symbol is already unique.
    discriminator:
      pair.left.file === pair.anchorFile
        ? `${pair.right.file}:${pair.right.name}`
        : `${pair.left.file}:${pair.left.name}`,
    summary:
      `\`${pair.left.name}\` and \`${pair.right.name}\` appear to describe the ` +
      `same record but disagree on ${describeCount(disagreements.length, "field")}. ` +
      `Nothing in the build checks the two declarations against each other.`,
    evidence: built.evidence,
    score_rationale: built.rationale,
    effort: "medium",
    fix_shape: "derive one declaration from the other, or share one schema",
    scores: {
      severity: severity.score(),
      confidence: confidence.value(),
    },
    suggested_actions: [
      {
        kind: "unify_contract",
        description: suggestUnification(pair),
        risk: "medium",
      },
      {
        kind: "resolve_field_disagreements",
        description: `Decide the correct shape for ${disagreements
          .slice(0, 3)
          .map((d) => `\`${d.field}\``)
          .join(", ")} and apply it to both declarations in one change.`,
        risk: "medium",
      },
    ],
    related_files:
      pair.left.file === pair.right.file
        ? []
        : [pair.left.file === pair.anchorFile ? pair.right.file : pair.left.file],
  };
}

function buildEvidence(
  pair: ContractDriftPair,
  disagreements: ContractDisagreement[],
  confidence: ConfidenceLadder,
  severity: SeverityLadder,
): { evidence: string[]; rationale: string[] } {
  const evidence: string[] = [];

  evidence.push(
    `A: \`${pair.left.name}\` (${pair.left.source}) — ${pair.left.file}:${pair.left.line}, ` +
      `${pair.left.fields.length} field(s)`,
  );
  evidence.push(
    `B: \`${pair.right.name}\` (${pair.right.source}) — ${pair.right.file}:${pair.right.line}, ` +
      `${pair.right.fields.length} field(s)`,
  );

  for (const reason of pair.matchReasons) evidence.push(`matched because: ${reason}`);

  evidence.push(`${disagreements.length} field-level disagreement(s):`);
  for (const d of disagreements.slice(0, 8)) {
    const critical = d.criticalReason !== undefined ? ` [${d.criticalReason}]` : "";
    evidence.push(
      `  ${d.field}: A is ${d.left}, B is ${d.right} (${describeKind(d.kind)})${critical}`,
    );
  }
  if (disagreements.length > 8) {
    evidence.push(`  +${disagreements.length - 8} more`);
  }

  if (pair.left.partial || pair.right.partial) {
    const which = pair.left.partial ? pair.left.name : pair.right.name;
    evidence.push(
      `note: \`${which}\` extends or spreads a type this scan did not expand, ` +
        "so absent-field claims are suppressed for it",
    );
  }

  // The ladder trace is arithmetic about the finding, not a fact
  // about the code, so it leaves `evidence` and rides alongside it.
  return { evidence, rationale: scoreRationale(confidence, severity) };
}

function suggestUnification(pair: ContractDriftPair): string {
  if (pair.left.source === "zod" || pair.right.source === "zod") {
    const schema = pair.left.source === "zod" ? pair.left : pair.right;
    const other = pair.left.source === "zod" ? pair.right : pair.left;
    return (
      `Make \`${other.name}\` derive from the schema — ` +
      `\`type ${other.name} = z.infer<typeof ${schema.name}>\` — so the two ` +
      "cannot disagree again."
    );
  }
  if (pair.left.source === "valibot" || pair.right.source === "valibot") {
    const schema = pair.left.source === "valibot" ? pair.left : pair.right;
    const other = pair.left.source === "valibot" ? pair.right : pair.left;
    return (
      `Make \`${other.name}\` derive from the schema — ` +
      `\`type ${other.name} = v.InferOutput<typeof ${schema.name}>\` — so the two ` +
      "cannot disagree again."
    );
  }
  return (
    `Keep one declaration and have the other reference it ` +
    `(\`type ${pair.right.name} = ${pair.left.name}\`, or a named projection ` +
    `such as \`Pick<${pair.left.name}, …>\`) so a future field change reaches both.`
  );
}

function criticalLabel(critical: ContractDisagreement[]): string {
  const reasons = [
    ...new Set(critical.map((d) => d.criticalReason ?? "critical field")),
  ].sort();
  return `disagreement on ${reasons.join(" / ")}`;
}

function describeKind(kind: ContractDisagreement["kind"]): string {
  switch (kind) {
    case "requiredness":
      return "requiredness";
    case "nullability":
      return "nullability";
    case "type":
      return "type";
    case "enum_members":
      return "value set";
    case "nesting":
      return "nested structure";
    case "missing_field":
      return "field present on one side only";
  }
}

function describeCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function readOptions(config: {
  detectors?: { options?: Record<string, unknown> };
}): Options {
  const raw = config.detectors?.options?.contract_drift;
  if (raw === undefined) return {};
  const parsed = optionsSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}
