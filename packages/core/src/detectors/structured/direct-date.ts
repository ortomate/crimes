import type { Detector } from "../../detector.js";
import type { PreFinding as Finding, Severity } from "../../finding.js";
import { classifyScope } from "../../util/scope-class.js";
import { intrinsicFor, lineList, severityScore } from "../py/shared.js";
import type { LanguageProfile, StructuredContext, StructuredPack } from "./surface.js";

/**
 * `direct_date` for a structured-surface language: domain code reading the
 * wall clock instead of a clock it was handed. Which calls count is the
 * parser's decision (an injected-clock form and stopwatch reads are not
 * clock reads); this reports them, once per file.
 */
export function makeDirectDateDetector<P extends StructuredPack>(
  profile: LanguageProfile<P>,
): Extract<Detector, { pack: P }> {
  const cfg = profile.directDate;
  const show = (callee: string): string =>
    cfg.propertyCallees?.has(callee) ? callee : `${callee}()`;
  const detector = {
    id: `direct_date.${profile.suffix}`,
    claims: ["clock_read"],
    name: `Direct clock read (${profile.label})`,
    description: cfg.description,
    whyItMatters: cfg.whyItMatters,
    pack: profile.pack,
    run(ctx: StructuredContext): Finding[] {
      if (classifyScope(ctx.file) !== "production") return [];
      if (cfg.clockBoundary.test(ctx.file)) return [];
      const hits = ctx.parsed.clockReads;
      if (hits.length === 0) return [];

      const byCallee = new Map<string, number>();
      for (const h of hits) byCallee.set(h.callee, (byCallee.get(h.callee) ?? 0) + 1);
      const breakdown = [...byCallee.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([callee, n]) => `${n}× ${show(callee)}`)
        .join(", ");
      // A reading that decides a branch changes what the program does; one
      // that is recorded or rendered changes only what it outputs. Same
      // split, wording and severity rule as the JS detector.
      const compared = hits.filter((h) => h.usage !== "value");
      const recorded = hits.filter((h) => h.usage === "value");
      const severity = pickSeverity(hits.length, compared.length);
      const usageLine =
        compared.length > 0 && recorded.length > 0
          ? `${compared.length} decide a branch or comparison (lines ${compared
              .map((h) => h.line)
              .slice(0, 6)
              .join(", ")}); ${recorded.length} only record or render the reading`
          : compared.length > 0
            ? `all ${compared.length} decide a branch or comparison`
            : `none decide a branch — all ${recorded.length} record or render the reading`;

      const finding: Finding = {
        id: "",
        type: "direct_date",
        charge: "Temporal Recklessness",
        severity,
        confidence: 0.9,
        file: ctx.file,
        lines: [hits[0]!.line, hits[hits.length - 1]!.line],
        claim: "clock_read",
        summary:
          `${hits.length} direct clock read${hits.length === 1 ? "" : "s"}. Domain code ` +
          "that reads the clock cannot be tested at a fixed moment.",
        evidence: [
          breakdown,
          usageLine,
          lineList(hits.map((h) => h.line)),
          compared.length > 0
            ? cfg.testabilityNote
            : "these readings change what the code outputs, not what it does — lower " +
              "risk, but still untestable without a fixed clock",
        ],
        effort: "small",
        fix_shape: cfg.fixShape,
        scores: {
          severity: severityScore(severity),
          confidence: 0.9,
          agent_risk: intrinsicFor({
            count: hits.length,
            base: 0.45,
            step: 0.07,
            cap: 0.85,
          }),
        },
        suggested_actions: [
          { kind: "inject_clock", description: cfg.injectAdvice, risk: "low" },
        ],
      };
      return [finding];
    },
  };
  return detector as unknown as Extract<Detector, { pack: P }>;
}

function pickSeverity(total: number, compared: number): Severity {
  // All recorded or rendered caps at medium however many there are, as in
  // the JS detector: timestamp columns are a testability cost, not a
  // poll timeout.
  if (compared === 0) return total >= 2 ? "medium" : "low";
  if (total >= 8) return "high";
  if (total >= 2) return "medium";
  return "low";
}
