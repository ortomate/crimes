import { z } from "zod";
import type { LanguageJsDetector } from "../detector.js";
import type { PreFinding as Finding, Severity } from "../finding.js";
import { isTestFile } from "../util/test-files.js";

const optionsSchema = z
  .object({
    /**
     * Literal date strings that should NOT be flagged even when they
     * lack a timezone marker. Useful for configuration-style literals
     * where the application's intent is "this date in whatever the
     * host's local zone is" (e.g. a launch-day date that anchors to
     * wall-clock midnight where the deploy lives).
     */
    allowedLiterals: z.array(z.string().min(1)).optional(),
  })
  .strict();

type TimezoneUnsafeParseOptions = z.infer<typeof optionsSchema>;

/**
 * `new Date("…")` with a string literal that carries no timezone
 * marker. The Date constructor interprets such strings either as UTC
 * (date-only `YYYY-MM-DD`) or as local time (datetime without `Z` or
 * offset) — and the developer's mental model rarely matches whichever
 * branch the spec picks. Adding `Z` or `±HH:MM` removes the ambiguity.
 */
export const timezoneUnsafeParseDetector: LanguageJsDetector = {
  id: "timezone_unsafe_parse",
  name: "Timezone Roulette",
  description:
    'Flags `new Date("…")` calls whose string argument has no timezone marker ' +
    "(no `Z` and no `±HH:MM` offset).",
  whyItMatters:
    "JavaScript parses date strings differently depending on their shape: " +
    "`YYYY-MM-DD` is read as UTC midnight, while `YYYY-MM-DDTHH:MM:SS` (no " +
    "zone) is read as local time. Either way the developer is usually " +
    "betting on a timezone the runtime won't honour. Coding agents are " +
    "especially prone to this — they copy a literal that worked in one " +
    "environment and silently break in another. Including `Z` or `±HH:MM` " +
    "(or parsing through a library that requires it) removes the guess.",
  optionsSchema,

  pack: "language-js",
  run(ctx) {
    // Tests routinely pin fixed date strings in assertions; flagging
    // them is noise. Domain code is where parse-time ambiguity bites.
    if (isTestFile(ctx.file)) return [];

    const allowed = readAllowedLiterals(ctx.config.detectors?.options);

    const unsafe = ctx.parsed.dateNowOrNewDateUses.filter((u) => {
      if (u.kind !== "new") return false;
      if (u.argKind !== "string-literal") return false;
      const value = u.argValue ?? "";
      if (allowed.has(value)) return false;
      return looksLikeDateString(value) && !hasTimezoneMarker(value);
    });
    if (unsafe.length === 0) return [];

    const severity = pickSeverity(unsafe.length);
    const samples = unsafe.slice(0, 3).map((u) => `"${u.argValue}"`);
    const overflow = unsafe.length > samples.length;
    const sampleList = `${samples.join(", ")}${overflow ? ", …" : ""}`;
    const lineList = unsafe.map((u) => u.line).slice(0, 10);

    const finding: Finding = {
      id: "",
      type: "timezone_unsafe_parse",
      charge: "Timezone Roulette",
      severity,
      confidence: 0.9,
      file: ctx.file,
      lines: [unsafe[0]!.line, unsafe[unsafe.length - 1]!.line],
      summary:
        `${unsafe.length} \`new Date("…")\` call${unsafe.length === 1 ? "" : "s"} ` +
        `parsing a string with no timezone marker. The runtime applies its own ` +
        `timezone, which is rarely the one the literal author had in mind.`,
      evidence: [
        `unsafe literal${unsafe.length === 1 ? "" : "s"}: ${sampleList}`,
        `lines: ${lineList.join(", ")}${unsafe.length > 10 ? `, …+${unsafe.length - 10} more` : ""}`,
        `add \`Z\` for UTC, \`±HH:MM\` for an offset, or parse through a timezone-aware library`,
      ],
      effort: "small",
      fix_shape: "parse with explicit timezone; reject ambiguous inputs",
      scores: {
        severity: severityScoreFor(severity),
        confidence: 0.9,
        agent_risk: round(Math.min(0.55 + (unsafe.length - 1) * 0.08, 0.9)),
      },
      suggested_actions: [
        {
          kind: "fix_timezone_parse",
          description:
            "Append `Z` (UTC) or `±HH:MM` to the literal, or parse through a " +
            "library that mandates an explicit zone.",
          risk: "low",
        },
      ],
    };
    return [finding];
  },
};

function readAllowedLiterals(options: Record<string, unknown> | undefined): Set<string> {
  const raw = options?.timezone_unsafe_parse;
  if (!raw) return new Set();
  // Loader already validated against optionsSchema, but in case of
  // direct programmatic callers that bypassed validation, parse
  // defensively. Failure → no exemptions, not a crash.
  const parsed = optionsSchema.safeParse(raw);
  if (!parsed.success) return new Set();
  return new Set(parsed.data.allowedLiterals ?? []);
}

/**
 * Filter out strings that don't look date-like at all. The detector is
 * about parse-time timezone ambiguity, not "every `new Date(string)` is
 * bad". `new Date("hello")` produces Invalid Date — a different bug
 * class that other tooling (typecheck, runtime tests) catches.
 */
function looksLikeDateString(value: string): boolean {
  if (value.length < 6) return false;
  // Has at least one 4-digit year-like run.
  if (!/\d{4}/.test(value)) return false;
  // Has a date-ish separator: `-`, `/`, or `T` between digits.
  if (!/\d[-/T]\d/.test(value)) return false;
  return true;
}

function hasTimezoneMarker(value: string): boolean {
  // Trailing `Z` or `±HH:MM` / `±HHMM` offset.
  if (/Z$/i.test(value)) return true;
  if (/[+-]\d{2}:?\d{2}$/.test(value)) return true;
  // `GMT+0500` / `UTC-08:00` style — uncommon but unambiguous.
  if (/\b(GMT|UTC)[+-]\d{2}:?\d{2}\b/i.test(value)) return true;
  return false;
}

function pickSeverity(count: number): Severity {
  // One slip is medium; recurring use in a file is systemic.
  if (count >= 5) return "high";
  return "medium";
}

function severityScoreFor(s: Severity): number {
  return s === "high" ? 0.8 : s === "medium" ? 0.6 : 0.35;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
