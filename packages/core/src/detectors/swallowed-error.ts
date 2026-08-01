import { z } from "zod";
import type { LanguageJsDetector } from "../detector.js";
import type { PreFinding as Finding } from "../finding.js";
import type { ErrorHandler } from "@crimes/language-js";
import { ConfidenceLadder, SeverityLadder } from "../scoring/confidence.js";
import { classifyBoundary } from "../domain/vocabulary.js";
import { classifyScope } from "../util/scope-class.js";

/**
 * Catch and Release — a failure that is caught and then discarded, or
 * converted into an indistinguishable success.
 *
 * ## What counts as swallowing
 *
 * A handler swallows when it neither **propagates** the failure
 * (rethrow, `Promise.reject`, a typed error result) nor **records** it
 * (any observability call that receives the error value). Concretely:
 *
 *  - an empty or comment-only `catch`
 *  - `.catch(() => {})` and `.catch(noop)`
 *  - a `catch` that returns `null` / `undefined` / `false` / `[]` / `{}`
 *    without first inspecting the error
 *  - a discarded rejection: `doThing().catch(() => {})` as a statement
 *  - a handler that logs a message but never passes the error, losing the
 *    stack, the cause chain, and the error code
 *
 * ## What does not count
 *
 * - Converting a known failure into a **typed, discriminable** result —
 *   `return { ok: false, error: e }`. Nothing was lost; the caller can
 *   still branch on it.
 * - Any handler that **inspects** the error first (`e.code === "ENOENT"`,
 *   `e instanceof NotFound`) and recovers deliberately from a specific
 *   case. That is precise error handling, and it is what good code looks
 *   like.
 * - A handler that rethrows, even if it also returns something.
 * - Named no-ops (`.catch(noop)` where a `noop` exists), which are
 *   reported at reduced severity: the author chose this on purpose.
 * - Test files, and cleanup paths whose comment says the suppression is
 *   deliberate.
 *
 * ## Severity
 *
 * Escalates with the consequence of the protected operation. A swallowed
 * read that returns `null` is a missing value; a swallowed database
 * write, payment, or queue publish is a silent data-loss bug that
 * surfaces days later as a support ticket.
 *
 * ## What it deliberately does not claim
 *
 * A logging convention. The detector recognises any call whose method
 * name is observability-shaped and which receives the error — it does not
 * require a specific library, and it does not tell you which one to use.
 */

const optionsSchema = z
  .object({
    /**
     * Also report handlers that log a message but never pass the error
     * value. Default true — losing the stack is most of the cost.
     */
    reportLogWithoutError: z.boolean().optional(),
    /**
     * Also report handlers that return a bland fallback. Default true.
     * Set false in codebases that use `null` as a documented "absent".
     */
    reportFallbackReturns: z.boolean().optional(),
    /**
     * Treat a comment inside an empty handler as a deliberate
     * suppression and skip it. Default false: a comment explains, it does
     * not observe.
     */
    treatCommentAsIntent: z.boolean().optional(),
    /** Enclosing function names to exempt, e.g. `["shutdown", "cleanup"]`. */
    allowedFunctions: z.array(z.string().min(1)).optional(),
  })
  .strict();

type Options = z.infer<typeof optionsSchema>;

const MAX_FINDINGS_PER_FILE = 8;

/**
 * Words in a comment or enclosing name that say "this suppression is on
 * purpose". Recognised because a codebase that documents its best-effort
 * paths should not be nagged about them.
 */
const DELIBERATE_RE =
  /\b(best[- ]effort|fire[- ]and[- ]forget|non[- ]critical|optional|advisory|cleanup|clean[- ]up|teardown|shutdown|dispose|ignore[ds]? (?:on purpose|deliberately|intentionally)|deliberately|intentionally|safe to ignore|not fatal|never fatal)\b/i;

/** Enclosing-function names where suppression is conventional. */
const CLEANUP_FUNCTION_RE =
  /^(cleanup|clean|teardown|tearDown|dispose|destroy|close|shutdown|stop|finalize|finalise|unmount|abort)/i;

/**
 * Function names that *announce* tolerance of failure.
 *
 * `safelyBuildIaIndex`, `tryParse`, `maybeReadConfig`, `readOrNull` all
 * say in their own signature that a failure returns nothing rather than
 * propagating. That is the documented-intent case the spec asks to
 * down-rank: the author declared the contract in the name, and every
 * caller reads it there.
 */
const BEST_EFFORT_FUNCTION_RE =
  /^(safely|try|maybe|attempt|best[Ee]ffort|optional|soft|quiet|silent)[A-Z_]|(?:OrNull|OrUndefined|OrDefault|OrEmpty|IfPossible|Safe)$/;

export const swallowedErrorDetector: LanguageJsDetector = {
  id: "swallowed_error",
  name: "Catch and Release",
  description:
    "Flags failures that are caught and then discarded, or converted into " +
    "an ambiguous success or fallback, with no propagation and no record " +
    "of what went wrong.",
  whyItMatters:
    "A swallowed failure removes the only evidence that something broke. " +
    "The write did not land, the queue never got the message, the charge " +
    "did not go through — and the code returned as if it had. The bug " +
    "surfaces days later, far from its cause, with no stack trace to " +
    "follow. For an agent the cost compounds: an empty catch reads as " +
    "handled, so the agent trusts the call site and builds on a guarantee " +
    "that was never there.",

  pack: "language-js",
  optionsSchema,

  run(ctx) {
    const handlers = ctx.parsed.errorHandlers ?? [];
    if (handlers.length === 0) return [];

    // Tests catch deliberately, constantly, and none of it ships.
    const scope = classifyScope(ctx.file);
    if (scope === "test" || scope === "generated" || scope === "vendored") {
      return [];
    }

    const options = readOptions(ctx.config);
    const allowed = new Set((options.allowedFunctions ?? []).map((f) => f.toLowerCase()));

    const findings: Finding[] = [];
    for (const handler of handlers) {
      if (findings.length >= MAX_FINDINGS_PER_FILE) break;
      const verdict = classify(handler, options, allowed);
      if (verdict === undefined) continue;
      findings.push(buildFinding(ctx.file, handler, verdict, scope));
    }

    findings.sort((a, b) => (a.lines?.[0] ?? 0) - (b.lines?.[0] ?? 0));
    return findings;
  },
};

/* ------------------------------------------------------------------ *
 * Classification
 * ------------------------------------------------------------------ */

type SwallowKind =
  | "empty"
  | "comment_only"
  | "discarded_rejection"
  | "bland_fallback"
  | "log_without_error";

interface Verdict {
  kind: SwallowKind;
  /** One-line statement of what happens to the failure. */
  disposition: string;
  /** True when the author's intent to suppress is documented. */
  deliberate: boolean;
}

function classify(
  handler: ErrorHandler,
  options: Options,
  allowed: Set<string>,
): Verdict | undefined {
  const body = handler.body;

  // Propagation and observability are both complete defences.
  if (body.rethrows) return undefined;
  if (body.typedResult) return undefined;
  if (body.reportsError) return undefined;
  // A handler that inspects the error and then recovers is deliberate
  // narrow recovery, which is the correct shape.
  if (body.discriminates) return undefined;

  if (handler.enclosing !== undefined && allowed.has(handler.enclosing.toLowerCase())) {
    return undefined;
  }

  const deliberate = looksDeliberate(handler);

  // A named no-op is the most specific classification available, so it is
  // checked first. `.catch(noop)` also reads as "empty", and reporting it
  // as an anonymous discarded rejection would lose the one fact that
  // matters: the author reached for a name that says "ignore this".
  if (body.intentionalNoop === true) {
    return {
      kind: "discarded_rejection",
      disposition: "the handler is a named no-op",
      deliberate: true,
    };
  }

  if (body.empty) {
    if (handler.kind === "fire_and_forget") {
      return {
        kind: "discarded_rejection",
        disposition: "the rejection is discarded without being recorded",
        deliberate,
      };
    }
    return {
      kind: "empty",
      disposition: "the handler body is empty",
      deliberate,
    };
  }

  if (body.commentOnly) {
    if (options.treatCommentAsIntent === true) return undefined;
    return {
      kind: "comment_only",
      disposition: `the handler contains only a comment (${handler.comment ?? "…"})`,
      deliberate,
    };
  }

  if (body.fallback !== undefined) {
    if (options.reportFallbackReturns === false) return undefined;
    return {
      kind: "bland_fallback",
      disposition: `the handler returns \`${body.fallback}\` without inspecting the error`,
      deliberate,
    };
  }

  if (body.reportsWithoutError) {
    if (options.reportLogWithoutError === false) return undefined;
    return {
      kind: "log_without_error",
      disposition:
        "the handler logs a message but never passes the error, so the stack, " +
        "cause chain, and error code are lost",
      deliberate,
    };
  }

  // The handler does *something* unrecognised. Silence is the right
  // answer: reporting "we could not tell what this does" is noise.
  return undefined;
}

function looksDeliberate(handler: ErrorHandler): boolean {
  if (handler.comment !== undefined && DELIBERATE_RE.test(handler.comment)) {
    return true;
  }
  if (handler.enclosing !== undefined && CLEANUP_FUNCTION_RE.test(handler.enclosing)) {
    return true;
  }
  if (
    handler.enclosing !== undefined &&
    BEST_EFFORT_FUNCTION_RE.test(handler.enclosing)
  ) {
    return true;
  }
  if (DELIBERATE_RE.test(handler.protectedOperation)) return true;
  return false;
}

/* ------------------------------------------------------------------ *
 * Finding
 * ------------------------------------------------------------------ */

function buildFinding(
  file: string,
  handler: ErrorHandler,
  verdict: Verdict,
  scope: string,
): Finding {
  const boundary = strongestBoundary(handler);

  const confidence = new ConfidenceLadder(0.72)
    .add(verdict.kind === "empty", "handler body is empty", 0.14)
    .add(verdict.kind === "discarded_rejection", "rejection explicitly discarded", 0.1)
    .add(verdict.kind === "comment_only", "handler contains only a comment", 0.06)
    .add(verdict.kind === "log_without_error", "log call omits the error value", -0.06)
    .add(boundary !== undefined, `protected operation touches ${boundary?.label}`, 0.06)
    .add(
      verdict.deliberate,
      "suppression appears deliberate (documented or cleanup path)",
      -0.2,
    )
    .add(scope === "fixture", "file is fixture material", -0.15);

  const severity = new SeverityLadder(0.35)
    .add(boundary?.id === "payment", "payment operation", 0.35)
    .add(boundary?.id === "persistence", "database write", 0.28)
    .add(boundary?.id === "authorization", "authentication / authorization", 0.28)
    .add(boundary?.id === "queue", "queue publish", 0.24)
    .add(boundary?.id === "state_transition", "state transition", 0.2)
    .add(boundary?.id === "filesystem", "file write", 0.14)
    .add(boundary?.id === "network", "external request", 0.1)
    .add(verdict.kind === "empty", "nothing is recorded at all", 0.06)
    .add(verdict.deliberate, "suppression appears deliberate", -0.25);

  return {
    id: "",
    type: "swallowed_error",
    charge: "Catch and Release",
    severity: severity.severity(),
    confidence: confidence.value(),
    file,
    lines: [handler.line, handler.endLine],
    symbol: handlerIdentity(handler),
    summary: buildSummary(handler, verdict, boundary),
    evidence: buildEvidence(handler, verdict, boundary, confidence, severity),
    effort: "small",
    fix_shape: "propagate, or record the error with enough context to act on",
    scores: {
      severity: severity.score(),
      confidence: confidence.value(),
    },
    suggested_actions: buildActions(handler, verdict, boundary),
  };
}

function buildSummary(
  handler: ErrorHandler,
  verdict: Verdict,
  boundary: ReturnType<typeof classifyBoundary>,
): string {
  const what = boundary !== undefined ? `A ${boundary.label} failure` : "A failure";
  const where = handler.enclosing !== undefined ? ` in \`${handler.enclosing}\`` : "";
  return (
    `${what}${where} is caught and discarded — ${verdict.disposition}. ` +
    "The caller sees success and there is no record the operation failed."
  );
}

function buildEvidence(
  handler: ErrorHandler,
  verdict: Verdict,
  boundary: ReturnType<typeof classifyBoundary>,
  confidence: ConfidenceLadder,
  severity: SeverityLadder,
): string[] {
  const evidence: string[] = [];

  evidence.push(`protected operation: ${handler.protectedOperation}`);
  if (handler.protectedCalls.length > 0) {
    evidence.push(
      `calls inside the protected region: ${handler.protectedCalls.slice(0, 6).join(", ")}`,
    );
  }
  evidence.push(
    `handler kind: ${describeHandlerKind(handler.kind)} (line ${handler.line})`,
  );
  evidence.push(`what happens to the failure: ${verdict.disposition}`);

  if (boundary !== undefined) {
    evidence.push(
      `boundary: ${boundary.label} (matched on \`${boundary.token}\`) — a silent ` +
        "failure here does not surface until something downstream is missing",
    );
  }

  // The missing-signal line is the point of the finding: name what is
  // absent, not just what is present.
  const missing: string[] = [];
  if (!handler.body.rethrows) missing.push("no rethrow or rejected promise");
  if (!handler.body.reportsError) {
    missing.push(
      handler.body.reportsWithoutError
        ? "a log call is present but the error value is not passed to it"
        : "no logging, telemetry, or error-wrapping call",
    );
  }
  if (!handler.body.typedResult)
    missing.push("no typed error result the caller could branch on");
  if (!handler.body.discriminates) missing.push("the error is never inspected");
  evidence.push(`missing signal: ${missing.join("; ")}`);

  if (handler.errorBinding === undefined && handler.kind === "catch_clause") {
    evidence.push(
      "the catch declares no binding, so the error object is not even " +
        "available to the handler",
    );
  }
  if (verdict.deliberate) {
    evidence.push(
      "this appears deliberate — the surrounding comment or function name " +
        `(\`${handler.enclosing ?? "…"}\`) marks it as a best-effort or cleanup ` +
        "path — so severity and confidence are both reduced",
    );
  }

  evidence.push(confidence.explain());
  const escalation = severity.explain();
  if (escalation !== undefined) evidence.push(escalation);
  return evidence;
}

function buildActions(
  handler: ErrorHandler,
  verdict: Verdict,
  boundary: ReturnType<typeof classifyBoundary>,
): Finding["suggested_actions"] {
  const actions: NonNullable<Finding["suggested_actions"]> = [];

  if (verdict.kind === "log_without_error") {
    actions.push({
      kind: "pass_error_to_logger",
      description:
        `Pass the caught error to the existing log call so the stack and ` +
        "cause chain survive.",
      risk: "low",
    });
  } else {
    actions.push({
      kind: "propagate_or_record",
      description:
        boundary !== undefined
          ? `Rethrow, or record the failure with enough context to act on it ` +
            `— at minimum the error itself and which ${boundary.label} ` +
            "operation was in flight."
          : "Rethrow, or record the failure with the error value attached so " +
            "the stack survives.",
      risk: "low",
    });
  }

  if (verdict.kind === "bland_fallback") {
    actions.push({
      kind: "return_typed_result",
      description:
        `Return a discriminable result (\`{ ok: false, error }\`) instead of ` +
        `\`${handler.body.fallback}\`, so callers can tell "no data" from ` +
        '"it broke".',
      risk: "medium",
    });
  }

  if (verdict.deliberate) {
    actions.push({
      kind: "document_suppression",
      description:
        "If the suppression really is intended, make it explicit — a named " +
        "helper such as `bestEffort(() => …)` states the intent in a way both " +
        "reviewers and this detector recognise.",
      risk: "low",
    });
  }

  return actions;
}

/**
 * A stable identity for one handler within its file.
 *
 * This becomes `Finding.symbol` and therefore part of the fingerprint
 * (`<type>::<file>::<symbol>`). The enclosing function name alone is not
 * enough: a function with two `try` blocks would produce two findings
 * sharing one fingerprint, and every downstream surface — baseline,
 * suppressions, triage, diff — would treat them as one.
 *
 * Pairing the function with the *first operation it protects* separates
 * them, stays stable when lines move, and reads meaningfully in output:
 * `readManifest → readFile`.
 */
function handlerIdentity(handler: ErrorHandler): string {
  const where = handler.enclosing ?? "<module>";
  const protectedCall = handler.protectedCalls[0];
  if (protectedCall === undefined) return `${where} → ${handler.kind}`;
  const tail = protectedCall.slice(protectedCall.lastIndexOf(".") + 1);
  return `${where} → ${tail}`;
}

/**
 * The most consequential boundary the protected region touches. Checked
 * against every call in the region, then against the rendered operation
 * text, so `await stripe.charges.create(…)` and a bare
 * `await chargeCustomer()` both resolve.
 */
function strongestBoundary(handler: ErrorHandler): ReturnType<typeof classifyBoundary> {
  for (const call of handler.protectedCalls) {
    const boundary = classifyBoundary(call);
    if (boundary) return boundary;
  }
  return classifyBoundary(handler.protectedOperation);
}

function describeHandlerKind(kind: ErrorHandler["kind"]): string {
  switch (kind) {
    case "catch_clause":
      return "try/catch";
    case "promise_catch":
      return ".catch() handler";
    case "fire_and_forget":
      return "discarded promise rejection";
  }
}

function readOptions(config: {
  detectors?: { options?: Record<string, unknown> };
}): Options {
  const raw = config.detectors?.options?.swallowed_error;
  if (raw === undefined) return {};
  const parsed = optionsSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}
