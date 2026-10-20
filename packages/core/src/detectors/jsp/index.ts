/**
 * The `language-jsp` detector slate.
 *
 * One charge, chosen for what fails silently: JSP compiles at request
 * time, so a reference that no longer resolves builds cleanly, passes
 * every Java test, and breaks the page on its first request. Resolution
 * itself happens once per scan in `imports/jsp.ts`; this detector only
 * reports what it found for the file in hand. See
 * `@crimes/language-jsp`'s `resolve.ts` for the rules that keep library-
 * supplied resources from being reported.
 *
 * Not reported: anything about style — scriptlets, escaping, markup.
 */

import { composeClaim } from "../../claims.js";
import type { LanguageJspDetector, LanguageJspDetectorContext } from "../../detector.js";
import type { PreFinding as Finding } from "../../finding.js";
import { classifyScope } from "../../util/scope-class.js";
import { resolveDiscriminators } from "../disambiguate.js";
import { round, severityScore } from "../py/shared.js";

const MAX_FINDINGS_PER_FILE = 8;

type Kind = "missing_include" | "missing_tag" | "missing_taglib" | "tag_contract";

const KIND_FOR = {
  include: "missing_include",
  tag: "missing_tag",
  taglib: "missing_taglib",
} as const;

const NOUN: Record<Exclude<Kind, "tag_contract">, string> = {
  missing_include: "included file",
  missing_tag: "tag file",
  missing_taglib: "tag library descriptor",
};

export const danglingTemplateReferenceDetector: LanguageJspDetector = {
  id: "dangling_template_reference.jsp",
  claims: ["missing_include", "missing_tag", "missing_taglib", "tag_contract"],
  name: "Dangling Template Reference (JSP)",
  description:
    "Flags includes, tag files and tag library descriptors a JSP names that do not " +
    "exist, and tag calls that omit a required attribute or pass one the tag does not " +
    "declare.",
  whyItMatters:
    "JSP is translated on the first request, not at build time, so a moved fragment or " +
    "a renamed tag attribute compiles, passes the Java tests and then fails every " +
    "request for the page. Nothing in the build tells an agent the edit broke it; " +
    "only the page does, in production.",
  pack: "language-jsp",
  run(ctx: LanguageJspDetectorContext): Finding[] {
    const scope = classifyScope(ctx.file);
    if (scope !== "production" && scope !== "config") return [];
    const findings: Finding[] = [];
    for (const d of ctx.jsp?.dangling ?? []) {
      if (findings.length >= MAX_FINDINGS_PER_FILE) break;
      const kind = KIND_FOR[d.kind];
      const noun = NOUN[kind];
      findings.push(
        build(ctx.file, d.line, kind, d.specifier, {
          summary:
            `The ${noun} \`${d.specifier}\` does not exist. Its directory does, so it was ` +
            "moved, renamed or deleted rather than supplied from a library, and the page " +
            "fails when it is first requested.",
          evidence: [
            `reference: \`${d.specifier}\` (line ${d.line})`,
            `expected at: ${d.expected}`,
            "the directory exists; the file does not",
          ],
          fix: `point the reference at the ${noun}'s new location, or remove it`,
        }),
      );
    }
    for (const b of ctx.jsp?.contractBreaks ?? []) {
      if (findings.length >= MAX_FINDINGS_PER_FILE) break;
      const parts = [
        ...(b.missing.length > 0
          ? [
              `omits required ${plural(b.missing.length, "attribute")} ${quote(b.missing)}`,
            ]
          : []),
        ...(b.undeclared.length > 0
          ? [
              `passes undeclared ${plural(b.undeclared.length, "attribute")} ${quote(b.undeclared)}`,
            ]
          : []),
      ];
      findings.push(
        build(ctx.file, b.line, "tag_contract", `${b.tag}@${b.line}`, {
          summary:
            `\`<${b.tag}>\` ${parts.join(" and ")}. JSP rejects the page when it ` +
            "translates it, on the first request.",
          evidence: [
            `call: \`<${b.tag}>\` (line ${b.line})`,
            `contract declared in: ${b.definedIn}`,
            ...(b.missing.length > 0
              ? [`required, not passed: ${b.missing.join(", ")}`]
              : []),
            ...(b.undeclared.length > 0
              ? [`passed, not declared: ${b.undeclared.join(", ")}`]
              : []),
          ],
          fix: "pass the attributes the tag requires, and only those it declares",
        }),
      );
    }
    resolveDiscriminators(findings);
    return findings;
  },
};

export const jspDetectors: LanguageJspDetector[] = [danglingTemplateReferenceDetector];

function build(
  file: string,
  line: number,
  kind: Kind,
  discriminator: string,
  text: { summary: string; evidence: string[]; fix: string },
): Finding {
  const severity = "medium";
  const confidence = kind === "tag_contract" ? 0.75 : 0.8;
  return {
    id: "",
    type: "dangling_template_reference",
    charge: "Dangling Template Reference",
    severity,
    confidence,
    file,
    lines: [line, line],
    discriminator,
    claim: composeClaim([kind]),
    summary: text.summary,
    evidence: text.evidence,
    effort: "quick",
    fix_shape: text.fix,
    scores: {
      severity: severityScore(severity),
      confidence,
      // Certain breakage when the page is requested; the one thing we do
      // not know is whether anything still requests it.
      agent_risk: round(0.6),
    },
    suggested_actions: [
      {
        kind: "repair_template_reference",
        description: text.fix.charAt(0).toUpperCase() + text.fix.slice(1),
        risk: "low",
      },
    ],
  };
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

function quote(names: readonly string[]): string {
  return names.map((n) => `\`${n}\``).join(", ");
}
