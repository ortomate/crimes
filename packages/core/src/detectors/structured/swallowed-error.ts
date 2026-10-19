import { composeClaim } from "../../claims.js";
import type { Detector } from "../../detector.js";
import { classifyBoundary } from "../../domain/vocabulary.js";
import type { PreFinding as Finding, Severity } from "../../finding.js";
import { classifyScope } from "../../util/scope-class.js";
import { resolveDiscriminators } from "../disambiguate.js";
import { round, severityScore } from "../py/shared.js";
import {
  BEST_EFFORT_FUNCTION_RE,
  CLEANUP_FUNCTION_RE,
  DELIBERATE_RE,
} from "../swallowed-error.js";
import type {
  LanguageProfile,
  StructuredCatch,
  StructuredContext,
  StructuredPack,
} from "./surface.js";

const MAX_FINDINGS_PER_FILE = 8;

type Kind = "empty" | "comment_only" | "bland_fallback" | "log_without_error";

/**
 * Catch and Release for a structured-surface language.
 *
 * Same contract as the JS detector: a handler swallows when it neither
 * propagates the failure nor records it with the failure attached —
 * a `catch` whose body is empty or only a comment, only returns a bland
 * value, or only logs a message without the exception or error itself,
 * which loses the stack trace and the cause chain.
 *
 * Catching a specific type is itself a decision about a known case — the
 * analogue of the JS detector's "inspects the error first" rule.
 * `catch (ObjectNotFoundException e) { return false; }` is find-or-default,
 * and a commented handler for a named type explains itself. So a fallback
 * return or a comment-only body is reported only when the catch is broad
 * (the profile's broad types, or a Swift catch-all). An empty body is
 * always reported — at low severity and confidence when the type is
 * specific — because it leaves no trace either way.
 *
 * Not reported: any handler that reads the failure (logs it, wraps it,
 * inspects it), rethrows, or does other work; a parameter whose name
 * announces the ignore (`ignored`); handlers inside `finally`; handlers in
 * test code; and enclosing functions whose names announce best effort.
 */
export function makeSwallowedErrorDetector<P extends StructuredPack>(
  profile: LanguageProfile<P>,
): Extract<Detector, { pack: P }> {
  const cfg = profile.swallowedError;
  const noun = cfg.failureNoun;
  const disposition: Record<Kind, string> = {
    empty: "the catch block is empty",
    comment_only: "the catch block contains only a comment",
    bland_fallback: `the catch block returns a fallback without reading the ${noun}`,
    log_without_error:
      `the catch block logs a message but never passes the ${noun}, so the stack ` +
      "trace and cause chain are lost",
  };
  const isBroad = (handler: StructuredCatch): boolean =>
    (cfg.catchAllIsBroad && handler.caughtTypes.length === 0) ||
    handler.caughtTypes.some((t) => cfg.broadTypes.has(t));

  const classify = (handler: StructuredCatch): Kind | undefined => {
    if (handler.usesParam || handler.rethrows) return undefined;
    if (handler.inFinally) return undefined;
    if (cfg.deliberateParam.test(handler.param)) return undefined;
    const enclosing = handler.enclosingMethod;
    if (
      enclosing !== undefined &&
      (CLEANUP_FUNCTION_RE.test(enclosing) || BEST_EFFORT_FUNCTION_RE.test(enclosing))
    ) {
      return undefined;
    }
    if (DELIBERATE_RE.test(handler.commentText)) return undefined;

    const broad = isBroad(handler);
    if (handler.statementCount === 0) {
      if (handler.commentText.trim() === "") return "empty";
      return broad ? "comment_only" : undefined;
    }
    if (handler.returnsFallback) return broad ? "bland_fallback" : undefined;
    if (handler.logStatements === handler.statementCount) return "log_without_error";
    // Anything else does work we cannot judge — setting a flag, a
    // computed default. Conservative: say nothing.
    return undefined;
  };

  const buildFinding = (file: string, handler: StructuredCatch, kind: Kind): Finding => {
    const boundary = classifyBoundary(handler.protectedText);
    const broad = isBroad(handler);
    const severity = pickSeverity(boundary?.id, broad);
    const catchAll = handler.caughtTypes.length === 0;
    const where =
      handler.enclosingMethod !== undefined ? ` in \`${handler.enclosingMethod}\`` : "";
    const what = boundary !== undefined ? `A ${boundary.label} failure` : "A failure";
    const caught = catchAll ? "everything" : handler.caughtTypes.join(" | ");
    const evidence = [
      `catches: ${caught} as \`${handler.param}\` (line ${handler.line})`,
      `what happens to the failure: ${disposition[kind]}`,
      `protected operation: ${condense(handler.protectedText)}`,
      ...(boundary !== undefined
        ? [
            `boundary: ${boundary.label} (matched on \`${boundary.token}\`) — a silent ` +
              "failure here does not surface until something downstream is missing",
          ]
        : []),
      ...(broad
        ? [
            `catches ${
              catchAll
                ? "everything"
                : handler.caughtTypes.filter((t) => cfg.broadTypes.has(t)).join(", ")
            } — ` +
              "every failure in the protected block is discarded, including ones nobody anticipated",
          ]
        : []),
      `missing signal: no rethrow, no wrapping ${noun}, and the ${noun} is never passed to a log call`,
    ];

    return {
      id: "",
      type: "swallowed_error",
      charge: "Catch and Release",
      severity,
      confidence: confidenceFor(kind, broad),
      file,
      lines: [handler.line, handler.endLine],
      ...(symbolOf(handler) !== undefined ? { symbol: symbolOf(handler) } : {}),
      discriminator: catchAll ? "*" : handler.caughtTypes.join("|"),
      claim: composeClaim([kind]),
      summary:
        `${what}${where} is caught and discarded — ${disposition[kind]}. ` +
        (kind === "log_without_error"
          ? "The caller sees success, and the record that survives cannot say what went wrong."
          : "The caller sees success and there is no record the operation failed."),
      evidence,
      effort: "small",
      fix_shape: "propagate, or record the error with enough context to act on",
      scores: {
        severity: severityScore(severity),
        confidence: confidenceFor(kind, broad),
        agent_risk: round(intrinsic(kind, boundary?.id, broad)),
      },
      suggested_actions: [
        kind === "log_without_error"
          ? {
              kind: "pass_error_to_logger",
              description:
                `Pass \`${handler.param}\` to the existing log call so the stack and ` +
                "cause chain survive.",
              risk: "low",
            }
          : {
              kind: "propagate_or_record",
              description: cfg.propagateAdvice,
              risk: "low",
            },
      ],
    };
  };

  const detector = {
    id: `swallowed_error.${profile.suffix}`,
    claims: ["empty", "comment_only", "bland_fallback", "log_without_error"],
    name: `Catch and Release (${profile.label})`,
    description: cfg.description,
    whyItMatters: cfg.whyItMatters,
    pack: profile.pack,
    run(ctx: StructuredContext): Finding[] {
      const scope = classifyScope(ctx.file);
      if (scope !== "production" && scope !== "config") return [];
      const findings: Finding[] = [];
      for (const handler of ctx.parsed.catches) {
        if (findings.length >= MAX_FINDINGS_PER_FILE) break;
        const kind = classify(handler);
        if (kind === undefined) continue;
        findings.push(buildFinding(ctx.file, handler, kind));
      }
      resolveDiscriminators(findings);
      return findings;
    },
  };
  return detector as unknown as Extract<Detector, { pack: P }>;
}

const CONSEQUENTIAL = new Set([
  "payment",
  "persistence",
  "authorization",
  "queue",
  "state_transition",
]);

function pickSeverity(boundary: string | undefined, broad: boolean): Severity {
  if (boundary !== undefined && CONSEQUENTIAL.has(boundary)) return "high";
  if (broad) return "medium";
  return "low";
}

function intrinsic(kind: Kind, boundary: string | undefined, broad: boolean): number {
  if (boundary !== undefined && CONSEQUENTIAL.has(boundary)) return 0.8;
  const empty = broad ? 0.5 : 0.35;
  const base = kind === "empty" ? empty : kind === "log_without_error" ? 0.4 : 0.3;
  return Math.min(base + (broad ? 0.1 : 0) + (boundary !== undefined ? 0.05 : 0), 0.7);
}

function confidenceFor(kind: Kind, broad: boolean): number {
  if (kind === "log_without_error") return 0.8;
  // A specific type left empty may be a deliberate ignore that nobody
  // named `ignored`; it is still worth a look, at lower confidence.
  return broad ? 0.88 : 0.7;
}

function symbolOf(handler: StructuredCatch): string | undefined {
  const parts = [handler.enclosingType, handler.enclosingMethod].filter(
    (p): p is string => p !== undefined,
  );
  return parts.length > 0 ? parts.join(".") : undefined;
}

function condense(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 117)}…` : flat;
}
