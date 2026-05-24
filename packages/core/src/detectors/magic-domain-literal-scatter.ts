import type { LanguageJsDetector } from "../detector.js";
import type { PreFinding as Finding, Severity } from "../finding.js";
import type { PettyLiteralHit } from "../petty/types.js";

const MIN_FILES = 3;
const MAX_FINDINGS_PER_ANCHOR = 5;

export const magicDomainLiteralScatterDetector: LanguageJsDetector = {
  id: "magic_domain_literal_scatter",
  name: "Magic Domain Literal Scatter",
  description: "Flags repeated domain-looking literals spread across production files.",
  whyItMatters:
    "When the same domain string appears in many files, the team has " +
    "accidentally created multiple sources of truth. Adding the next call " +
    "site quietly duplicates policy; renaming or retiring the value " +
    "requires finding every copy.",

  pack: "language-js",
  run(ctx) {
    if (!ctx.petty) return [];

    const findings: Finding[] = [];
    for (const [literal, hits] of Object.entries(ctx.petty.domainLiterals)) {
      const productionHits = hits.filter((hit) => !hit.exportedConstant);
      const files = Array.from(new Set(productionHits.map((hit) => hit.file))).sort();
      if (files.length < MIN_FILES) continue;
      if (hits.some((hit) => hit.exportedConstant)) continue;

      const anchor = files[0];
      if (anchor !== ctx.file) continue;

      const buckets = Array.from(new Set(files.map(dirBucket))).sort();
      if (buckets.length < 2) continue;

      const severity = pickSeverity(files.length, buckets.length);
      const confidence = round(Math.min(0.66 + files.length * 0.03 + buckets.length * 0.02, 0.85));
      const representatives = representativeHits(productionHits);

      findings.push({
        id: "",
        type: "magic_domain_literal_scatter",
        charge: "String Sprinkles",
        severity,
        confidence,
        file: anchor,
        lines: [representatives[0]!.line, representatives[0]!.line],
        summary:
          `Domain literal "${literal}" appears in ${files.length} production files across ` +
          `${buckets.length} areas. Repeated literals often become duplicated policy.`,
        evidence: [
          `literal: "${literal}"`,
          `appears in ${files.length} production files across ${buckets.join(", ")}`,
          `representative files: ${representatives.map((hit) => `${hit.file}:${hit.line}`).join(", ")}`,
        ],
        effort: "small",
        fix_shape: "promote the literal to a named constant in one module",
        scores: {
          severity: severityScore(severity),
          confidence,
          agent_risk: round(Math.min(0.52 + files.length * 0.04 + buckets.length * 0.03, 0.8)),
        },
        suggested_actions: [
          {
            kind: "centralise_domain_literal",
            description:
              "Move the literal to a named constant, enum, schema, registry, or policy module before adding another copy.",
            risk: "medium",
          },
        ],
        related_files: files.filter((file) => file !== anchor).slice(0, 8),
      });
    }

    return findings
      .sort((a, b) => b.confidence - a.confidence || a.summary.localeCompare(b.summary))
      .slice(0, MAX_FINDINGS_PER_ANCHOR);
  },
};

function representativeHits(hits: PettyLiteralHit[]): PettyLiteralHit[] {
  const byFile = new Map<string, PettyLiteralHit>();
  for (const hit of hits) {
    if (!byFile.has(hit.file)) byFile.set(hit.file, hit);
  }
  return Array.from(byFile.values()).sort((a, b) => a.file.localeCompare(b.file)).slice(0, 5);
}

function dirBucket(file: string): string {
  const parts = file.split("/");
  if (parts.length <= 2) return parts[0] ?? file;
  return `${parts[0]}/${parts[1]}`;
}

function pickSeverity(fileCount: number, bucketCount: number): Severity {
  return fileCount >= 5 || bucketCount >= 3 ? "medium" : "low";
}

function severityScore(severity: Severity): number {
  return severity === "medium" ? 0.5 : 0.3;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
