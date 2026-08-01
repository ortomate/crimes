import { z } from "zod";
import type { LanguageJsDetector } from "../detector.js";
import type { PreFinding as Finding } from "../finding.js";
import type { RetrySafeguardKind, RetrySite } from "@crimes/language-js";
import { ConfidenceLadder, SeverityLadder } from "../scoring/confidence.js";
import { classifyBoundary } from "../domain/vocabulary.js";
import { classifyScope } from "../util/scope-class.js";

/**
 * Double Jeopardy — a retry wrapped around work that may already have
 * landed.
 *
 * ## The primary crime
 *
 * Retrying is a bet that the first attempt did not take effect. For a
 * read the bet costs nothing. For a write it is a coin flip: a request
 * that timed out *after* the server committed it will be replayed, and
 * the customer is charged twice, the order ships twice, or the queue
 * receives a duplicate nothing downstream expects.
 *
 * The control that makes this safe is a stable idempotency or
 * deduplication key — something that lets the receiver recognise the
 * replay as the same operation. **The absence of that key around a
 * retried mutation is the finding.** Everything else (no bound, no
 * backoff, no jitter, no error classification) appears as supporting
 * evidence on the same finding rather than as separate ones, because
 * they are all symptoms of the same unreviewed retry.
 *
 * ## What is recognised as a retry
 *
 * Attempt-named loops, loops that catch and `continue`, retry helper
 * functions (`retry`, `withRetry`, `pRetry`, `backOff`, …), functions
 * that recurse from their own catch block, and SDK clients configured
 * with `maxRetries` / `retries` / `retryStrategy`.
 *
 * ## What is recognised as a mutation
 *
 * An HTTP `POST`, `PUT`, `PATCH`, or `DELETE`; or a call whose name
 * carries a write-shaped word (`create`, `save`, `publish`, `charge`,
 * `enqueue`, …). A call matching neither is treated as a read, which is
 * the conservative default: over-reporting would flag every codebase
 * that owns a retry helper.
 *
 * ## What it deliberately does not claim
 *
 * That the operation is not idempotent. A dedup key computed three files
 * away is invisible to a static reader, and the finding says so: it
 * reports that **no idempotency signal is visible at this call site**,
 * which is a statement about reviewability as much as about correctness.
 * An SDK documented as idempotent is respected when the configuration
 * says so.
 */

const optionsSchema = z
  .object({
    /**
     * Treat a visible transaction as sufficient on its own. Default
     * false: a transaction makes one attempt atomic, it does not make a
     * *replay* safe.
     */
    transactionCountsAsIdempotent: z.boolean().optional(),
    /**
     * Report `DELETE`, which is idempotent by HTTP semantics but often
     * is not in practice (soft deletes, cascading side effects).
     * Default true.
     */
    reportDelete: z.boolean().optional(),
    /**
     * Additional callee names to treat as mutating, e.g.
     * `["ledger.append"]`. Matched against the callee tail.
     */
    mutatingCalls: z.array(z.string().min(1)).optional(),
    /**
     * Callee names known to be idempotent, so a retry around them is
     * safe. Matched against the callee tail.
     */
    idempotentCalls: z.array(z.string().min(1)).optional(),
  })
  .strict();

type Options = z.infer<typeof optionsSchema>;

const MAX_FINDINGS_PER_FILE = 6;

export const unsafeRetryDetector: LanguageJsDetector = {
  id: "unsafe_retry",
  name: "Double Jeopardy",
  description:
    "Flags retry loops, helpers, and SDK retry configuration wrapped " +
    "around potentially-mutating operations where no idempotency or " +
    "deduplication key is visible.",
  whyItMatters:
    "A retried write that already succeeded is applied twice. The first " +
    "attempt timed out on the way back, not on the way in, and the " +
    "replay charges the card again, ships the order again, or publishes " +
    "the message again. Nothing in the type system or the test suite " +
    "distinguishes the safe retry from the dangerous one — the only " +
    "difference is whether the receiver can recognise the replay, and " +
    "that is exactly what an idempotency key is for.",

  pack: "language-js",
  optionsSchema,

  run(ctx) {
    const sites = ctx.parsed.retrySites ?? [];
    if (sites.length === 0) return [];

    const scope = classifyScope(ctx.file);
    if (scope !== "production" && scope !== "config") return [];

    const options = readOptions(ctx.config);
    const extraMutating = new Set(
      (options.mutatingCalls ?? []).map((c) => tailOf(c).toLowerCase()),
    );
    const knownIdempotent = new Set(
      (options.idempotentCalls ?? []).map((c) => tailOf(c).toLowerCase()),
    );

    const findings: Finding[] = [];
    for (const site of sites) {
      if (findings.length >= MAX_FINDINGS_PER_FILE) break;

      const mutations = site.mutations.filter((m) => {
        if (knownIdempotent.has(tailOf(m.callee).toLowerCase())) return false;
        if (options.reportDelete === false && m.method === "DELETE") return false;
        return true;
      });
      // Config-declared mutating calls widen the set beyond what the
      // parser recognised on name shape alone. Matched against every
      // call in the retry, not just the ones already classified —
      // otherwise the option could only ever re-add what was already
      // there.
      for (const callee of site.calls) {
        if (!extraMutating.has(tailOf(callee).toLowerCase())) continue;
        if (mutations.some((m) => m.callee === callee)) continue;
        mutations.push({ callee, line: site.line, via: "call" });
      }

      // An SDK client configured to retry, with no mutating call visible
      // at the construction site, is still worth reporting when the
      // client itself is what a payment / persistence / queue boundary
      // looks like: every write through it is silently replayed, and the
      // call sites give no hint that a retry is happening at all.
      if (mutations.length === 0 && site.kind === "sdk_config") {
        const clientBoundary = classifyBoundary(site.construct);
        if (clientBoundary !== undefined) {
          mutations.push({
            callee: site.construct,
            line: site.line,
            via: "call",
          });
        }
      }

      if (mutations.length === 0) continue;

      const kinds = new Set(site.safeguards.map((s) => s.kind));
      const hasIdempotency =
        kinds.has("idempotency_key") ||
        (options.transactionCountsAsIdempotent === true && kinds.has("transaction"));
      // The primary crime is the missing idempotency signal. A retry with
      // one is not reported at all, however scruffy its backoff.
      if (hasIdempotency) continue;

      findings.push(buildFinding(ctx.file, site, mutations, kinds));
    }

    findings.sort((a, b) => (a.lines?.[0] ?? 0) - (b.lines?.[0] ?? 0));
    return findings;
  },
};

function buildFinding(
  file: string,
  site: RetrySite,
  mutations: RetrySite["mutations"],
  present: Set<RetrySafeguardKind>,
): Finding {
  const boundary = strongestBoundary(mutations.map((m) => m.callee));
  const httpMutations = mutations.filter((m) => m.via === "http");
  const missing = MISSING_ORDER.filter((kind) => !present.has(kind));

  const confidence = new ConfidenceLadder(0.62)
    .add(
      httpMutations.length > 0,
      `explicit ${httpMutations[0]?.method ?? "HTTP"} inside the retry`,
      0.16,
    )
    .add(
      site.kind === "loop" || site.kind === "helper",
      "retry construct is explicit in this file",
      0.08,
    )
    .add(
      site.kind === "sdk_config",
      "retry happens inside the SDK, invisible at each call site",
      0.04,
    )
    .add(boundary !== undefined, `operation touches ${boundary?.label}`, 0.06)
    .add(
      present.has("transaction"),
      "a transaction is visible (may already dedupe)",
      -0.1,
    )
    .add(
      mutations.length === 1 && mutations[0]!.via === "call",
      "mutation recognised by name only",
      -0.08,
    );

  const severity = new SeverityLadder(0.42)
    .add(boundary?.id === "payment", "payment operation", 0.32)
    .add(boundary?.id === "persistence", "database write", 0.2)
    .add(boundary?.id === "queue", "queue publish", 0.2)
    .add(boundary?.id === "state_transition", "state transition", 0.14)
    .add(site.maxAttempts === undefined, "no visible attempt bound", 0.1)
    .add(!present.has("delay"), "no delay or backoff between attempts", 0.06)
    .add(
      !present.has("error_classification"),
      "every failure is retried, including permanent ones",
      0.06,
    );

  return {
    id: "",
    type: "unsafe_retry",
    charge: "Double Jeopardy",
    severity: severity.severity(),
    confidence: confidence.value(),
    file,
    lines: [site.line, site.endLine],
    // Enclosing function plus the first retried mutation. A function with
    // two retry blocks must not collapse to one fingerprint.
    symbol: `${site.enclosing ?? "<module>"} → ${tailOf(mutations[0]!.callee)}`,
    summary:
      `A retry wraps ${describeMutations(mutations)} with no idempotency or ` +
      "deduplication key visible at the call site. If an attempt succeeds but " +
      "the response is lost, the retry applies the operation a second time.",
    evidence: buildEvidence(
      site,
      mutations,
      present,
      missing,
      boundary,
      confidence,
      severity,
    ),
    effort: "medium",
    fix_shape: "pass a stable idempotency key, or make the retry read-only",
    scores: {
      severity: severity.score(),
      confidence: confidence.value(),
    },
    suggested_actions: buildActions(site, mutations, missing, boundary),
  };
}

function buildEvidence(
  site: RetrySite,
  mutations: RetrySite["mutations"],
  present: Set<RetrySafeguardKind>,
  missing: RetrySafeguardKind[],
  boundary: ReturnType<typeof classifyBoundary>,
  confidence: ConfidenceLadder,
  severity: SeverityLadder,
): string[] {
  const evidence: string[] = [];

  evidence.push(`retry construct: ${site.construct} (line ${site.line})`);
  for (const mutation of mutations.slice(0, 5)) {
    const how =
      mutation.via === "http" ? `HTTP ${mutation.method}` : "name suggests a write";
    evidence.push(
      `  retried mutation — ${mutation.callee} at line ${mutation.line} (${how})`,
    );
  }
  if (mutations.length > 5) {
    evidence.push(`  +${mutations.length - 5} further mutating call(s)`);
  }

  if (boundary !== undefined) {
    evidence.push(
      `boundary: ${boundary.label} (matched on \`${boundary.token}\`) — a ` +
        "duplicate here is visible to the customer, not just to the logs",
    );
  }

  if (site.safeguards.length > 0) {
    evidence.push("safeguards visible at this site:");
    for (const safeguard of site.safeguards.slice(0, 6)) {
      evidence.push(`  ${describeSafeguard(safeguard.kind)}: ${safeguard.evidence}`);
    }
  } else {
    evidence.push("safeguards visible at this site: none");
  }

  evidence.push(
    `missing safeguard (primary): no idempotency or deduplication key — ` +
      "nothing lets the receiver recognise a replayed attempt as the same operation",
  );
  const secondary = missing.filter((k) => k !== "idempotency_key");
  if (secondary.length > 0) {
    evidence.push(`also absent: ${secondary.map(describeSafeguard).join(", ")}`);
  }
  if (site.maxAttempts !== undefined) {
    evidence.push(`attempt bound: ${site.maxAttempts}`);
  }
  void present;

  evidence.push(confidence.explain());
  const escalation = severity.explain();
  if (escalation !== undefined) evidence.push(escalation);
  return evidence;
}

function buildActions(
  site: RetrySite,
  mutations: RetrySite["mutations"],
  missing: RetrySafeguardKind[],
  boundary: ReturnType<typeof classifyBoundary>,
): Finding["suggested_actions"] {
  const actions: NonNullable<Finding["suggested_actions"]> = [
    {
      kind: "add_idempotency_key",
      description:
        boundary?.id === "payment"
          ? "Pass a stable idempotency key derived from the business " +
            "operation (the order id, not a fresh UUID per attempt) so the " +
            "provider collapses replays into one charge."
          : `Derive a stable key for the operation and pass it with every ` +
            `attempt — the same value on retry — so ${mutations[0]?.callee ?? "the call"} ` +
            "can recognise and drop the duplicate.",
      risk: "medium",
    },
  ];

  if (missing.includes("bounded_attempts") && site.maxAttempts === undefined) {
    actions.push({
      kind: "bound_attempts",
      description:
        "Cap the number of attempts. An unbounded retry against a failing " +
        "dependency turns one outage into two.",
      risk: "low",
    });
  }
  if (missing.includes("error_classification")) {
    actions.push({
      kind: "classify_errors",
      description:
        "Retry only failures that can succeed on a second attempt. " +
        "Replaying a 400 or a validation error just repeats it.",
      risk: "low",
    });
  }
  if (missing.includes("delay")) {
    actions.push({
      kind: "add_backoff",
      description:
        "Add backoff between attempts, with jitter if many clients retry " +
        "the same dependency at once.",
      risk: "low",
    });
  }
  return actions;
}

/** Order in which absent safeguards are reported. Idempotency leads. */
const MISSING_ORDER: readonly RetrySafeguardKind[] = [
  "idempotency_key",
  "bounded_attempts",
  "error_classification",
  "delay",
  "jitter",
  "timeout",
  "transaction",
];

function describeSafeguard(kind: RetrySafeguardKind): string {
  switch (kind) {
    case "idempotency_key":
      return "idempotency / deduplication key";
    case "transaction":
      return "transaction or atomic operation";
    case "bounded_attempts":
      return "bounded attempt count";
    case "delay":
      return "delay or backoff";
    case "jitter":
      return "jitter";
    case "error_classification":
      return "error classification";
    case "timeout":
      return "timeout or cancellation";
  }
}

function describeMutations(mutations: RetrySite["mutations"]): string {
  const first = mutations[0]!;
  const label =
    first.via === "http"
      ? `an HTTP ${first.method} to ${first.callee}`
      : `\`${first.callee}\``;
  if (mutations.length === 1) return label;
  return `${label} and ${mutations.length - 1} other potentially-mutating call(s)`;
}

function strongestBoundary(callees: string[]): ReturnType<typeof classifyBoundary> {
  for (const callee of callees) {
    const boundary = classifyBoundary(callee);
    if (boundary) return boundary;
  }
  return undefined;
}

function tailOf(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx === -1 ? name : name.slice(idx + 1);
}

function readOptions(config: {
  detectors?: { options?: Record<string, unknown> };
}): Options {
  const raw = config.detectors?.options?.unsafe_retry;
  if (raw === undefined) return {};
  const parsed = optionsSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}
