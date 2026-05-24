import type { DateMethodCall } from "@crimes/language-js";
import type { Detector } from "../detector.js";
import type { Finding, Severity } from "../finding.js";
import { isTestFile } from "../util/test-files.js";

/**
 * Same receiver identifier calling **both** UTC and local Date
 * methods. The pattern is a silent bug class — most tests don't
 * cross a DST or international-date-line boundary, so the value
 * differs from what the developer expects only in production.
 */
export const mixedUtcLocalMethodsDetector: Detector = {
  id: "mixed_utc_local_methods",
  name: "Half-UTC, Half-Local",
  description:
    "Flags Date receivers that mix UTC-family methods (`getUTCHours`, " +
    "`getUTCFullYear`, …) with local-family methods (`getHours`, " +
    "`getFullYear`, …) in the same file.",
  whyItMatters:
    "Mixing UTC and local Date methods on the same value silently shifts " +
    "by the host's UTC offset. Tests that run in one timezone won't catch " +
    "the bug; the production runtime applies whichever offset it has. " +
    "Pick one family per variable and stick to it — usually UTC for " +
    "storage and computation, local only at the user-display boundary.",

  pack: "language-js",
  run(ctx) {
    if (isTestFile(ctx.file)) return [];
    const calls = ctx.parsed.dateMethodCalls;
    if (!calls || calls.length === 0) return [];

    const byReceiver = new Map<
      string,
      { utc: DateMethodCall[]; local: DateMethodCall[] }
    >();
    for (const call of calls) {
      const bucket = byReceiver.get(call.receiver) ?? { utc: [], local: [] };
      if (call.family === "utc") bucket.utc.push(call);
      else bucket.local.push(call);
      byReceiver.set(call.receiver, bucket);
    }

    const offenders = [...byReceiver.entries()].filter(
      ([, { utc, local }]) => utc.length > 0 && local.length > 0,
    );
    if (offenders.length === 0) return [];

    const firstLine = offenders
      .flatMap(([, { utc, local }]) => [...utc, ...local])
      .reduce((min, c) => Math.min(min, c.line), Infinity);
    const lastLine = offenders
      .flatMap(([, { utc, local }]) => [...utc, ...local])
      .reduce((max, c) => Math.max(max, c.line), 0);
    // Silent-bug class — even one mixed receiver is high. (Severity
    // doesn't escalate further because there's nowhere above high.)
    const severity: Severity = "high";
    const sampleEvidence = offenders.slice(0, 3).map(([receiver, { utc, local }]) => {
      const u = utc[0]!;
      const l = local[0]!;
      return `"${receiver}" uses ${u.method}() @L${u.line} and ${l.method}() @L${l.line}`;
    });

    const finding: Finding = {
      id: "",
      type: "mixed_utc_local_methods",
      charge: "Half-UTC, Half-Local",
      severity,
      confidence: 0.85,
      file: ctx.file,
      lines: [firstLine, lastLine],
      summary:
        `${offenders.length} receiver${offenders.length === 1 ? "" : "s"} ` +
        `using both UTC and local Date methods. The two families differ ` +
        `silently by the host's UTC offset.`,
      evidence: [
        ...sampleEvidence,
        offenders.length > 3
          ? `…and ${offenders.length - 3} more receiver${offenders.length - 3 === 1 ? "" : "s"}`
          : `pick one family per variable; usually UTC for storage and local only at the display boundary`,
      ],
      effort: "medium",
      fix_shape: "pick one time domain; convert at the boundary",
      scores: {
        severity: 0.8,
        confidence: 0.85,
        agent_risk: round(Math.min(0.65 + (offenders.length - 1) * 0.1, 0.9)),
      },
      suggested_actions: [
        {
          kind: "unify_date_family",
          description:
            "Convert all reads on this receiver to either the UTC family " +
            "or the local family — don't mix.",
          risk: "low",
        },
      ],
    };
    return [finding];
  },
};

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
