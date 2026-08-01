import { z } from "zod";
import type { LanguageJsDetector } from "../detector.js";
import type { PreFinding as Finding } from "../finding.js";
import type { FanOutSite, FanOutWork } from "@crimes/language-js";
import { ConfidenceLadder, SeverityLadder } from "../scoring/confidence.js";
import { classifyScope } from "../util/scope-class.js";

/**
 * Concurrency Stampede — `Promise.all` over a collection whose size is
 * decided at runtime, doing expensive work per element, with no visible
 * bound.
 *
 * ## Why this is a change-risk finding and not a perf nit
 *
 * The code is correct. It passes review, passes tests, and works in
 * every environment where the collection is small. Then a backfill runs,
 * or a customer with 40 000 rows signs up, and the same line opens 40 000
 * sockets at once. The failure lands on the dependency — the database
 * runs out of connections, the API rate-limits, the file descriptors run
 * out — so the stack trace points somewhere other than the cause.
 *
 * What makes it a *change* risk is that nothing about the line changes
 * when the danger arrives. The collection got bigger somewhere else.
 *
 * ## Required signals
 *
 * All three, together:
 *
 *  1. The collection is not statically sized (not a small array literal).
 *  2. The callback does something expensive per element — a network call,
 *     a database query, filesystem work, a subprocess, or a queue publish.
 *  3. No bound is visible: no `.slice()`, no `take`/`limit` on the query
 *     that produced it, no batching helper, no concurrency-limit library.
 *
 * A pure transform over a large array is not reported: `Promise.all` over
 * ten thousand already-resolved values is fine.
 *
 * ## What it deliberately does not claim
 *
 * That the collection *is* large. A static reader cannot know. The
 * finding is that nothing in the code bounds it, and that the size is
 * therefore a property of the data rather than of the program.
 */

const optionsSchema = z
  .object({
    /**
     * Array literals with at most this many elements are treated as
     * bounded by construction. Default 8.
     */
    staticallySmall: z.number().int().min(1).max(100).optional(),
    /**
     * Report fan-outs whose callback work could not be classified.
     * Default false — an unclassified callback is usually a pure
     * transform, and reporting those makes the detector noise.
     */
    reportUnclassifiedWork: z.boolean().optional(),
    /**
     * Helper functions that bound concurrency in this codebase, e.g.
     * `["mapWithLimit"]`. A fan-out passing through one of these is
     * treated as bounded.
     */
    boundedHelpers: z.array(z.string().min(1)).optional(),
  })
  .strict();

type Options = z.infer<typeof optionsSchema>;

const MAX_FINDINGS_PER_FILE = 6;

export const unboundedAsyncFanoutDetector: LanguageJsDetector = {
  id: "unbounded_async_fanout",
  name: "Concurrency Stampede",
  description:
    "Flags `Promise.all` / `Promise.allSettled` over runtime-sized " +
    "collections whose callback performs network, database, filesystem, " +
    "subprocess, or queue work with no visible concurrency bound.",
  whyItMatters:
    "The line is correct and stays correct while the collection is small. " +
    "When it is not — a backfill, a large customer, an unpaginated query " +
    "— the same code opens as many concurrent operations as there are " +
    "rows, and the failure surfaces in the dependency rather than here. " +
    "Nothing about the code changed; the data did. Agents reproduce this " +
    "shape constantly because `await Promise.all(xs.map(f))` is the most " +
    'idiomatic way to express "do this for each".',

  pack: "language-js",
  optionsSchema,

  run(ctx) {
    const sites = ctx.parsed.fanOutSites ?? [];
    if (sites.length === 0) return [];

    const scope = classifyScope(ctx.file);
    if (scope !== "production" && scope !== "config") return [];

    const options = readOptions(ctx.config);
    const staticallySmall = options.staticallySmall ?? 8;
    const boundedHelpers = new Set(
      (options.boundedHelpers ?? []).map((h) => h.toLowerCase()),
    );

    const findings: Finding[] = [];
    for (const site of sites) {
      if (findings.length >= MAX_FINDINGS_PER_FILE) break;
      if (!shouldReport(site, staticallySmall, boundedHelpers, options)) continue;
      findings.push(buildFinding(ctx.file, site));
    }

    findings.sort((a, b) => (a.lines?.[0] ?? 0) - (b.lines?.[0] ?? 0));
    return findings;
  },
};

function shouldReport(
  site: FanOutSite,
  staticallySmall: number,
  boundedHelpers: Set<string>,
  options: Options,
): boolean {
  // 1. Statically bounded collections are fine by construction.
  if (site.staticallyBounded) return false;
  if (site.staticSize !== undefined && site.staticSize <= staticallySmall) {
    return false;
  }

  // 2. A visible bound is a complete defence.
  if (site.bounds.length > 0) return false;
  if (
    site.producer !== undefined &&
    boundedHelpers.has(tailOf(site.producer).toLowerCase())
  ) {
    return false;
  }

  // 3. The callback must do something worth bounding.
  if (site.work.length === 0) return options.reportUnclassifiedWork === true;

  return true;
}

function buildFinding(file: string, site: FanOutSite): Finding {
  const kinds = [...new Set(site.work.map((w) => w.kind))].sort();
  const runtimeSourced =
    site.collectionSource === "await_call" || site.collectionSource === "property";

  const confidence = new ConfidenceLadder(0.6)
    .add(
      runtimeSourced,
      `collection comes from ${describeSource(site.collectionSource)}`,
      0.14,
    )
    .add(site.producer !== undefined, `produced by \`${site.producer}\``, 0.08)
    .add(
      site.work.length >= 2,
      `${site.work.length} expensive operations per element`,
      0.06,
    )
    .add(kinds.includes("database") || kinds.includes("network"), "per-element I/O", 0.06)
    .add(
      site.collectionSource === "unknown",
      "collection source not statically visible",
      -0.12,
    )
    .add(
      site.collectionSource === "parameter",
      "collection is a parameter with no visible bound",
      0.04,
    );

  const severity = new SeverityLadder(0.38)
    .add(kinds.includes("database"), "per-element database work", 0.2)
    .add(kinds.includes("network"), "per-element network requests", 0.18)
    .add(kinds.includes("subprocess"), "per-element subprocess execution", 0.24)
    .add(kinds.includes("queue"), "per-element queue operations", 0.14)
    .add(kinds.includes("filesystem"), "per-element filesystem work", 0.1)
    .add(kinds.length >= 2, "multiple expensive operation kinds", 0.06)
    .add(runtimeSourced, "collection size is decided at runtime", 0.06);

  return {
    id: "",
    type: "unbounded_async_fanout",
    charge: "Concurrency Stampede",
    severity: severity.severity(),
    confidence: confidence.value(),
    file,
    lines: [site.line, site.endLine],
    // Enclosing function plus the first expensive operation, so two
    // fan-outs in one function keep distinct fingerprints.
    symbol: `${site.enclosing ?? "<module>"} → ${
      site.work[0] !== undefined ? tailOf(site.work[0].callee) : "fanout"
    }`,
    summary:
      `\`${site.kind === "promise_all" ? "Promise.all" : "Promise.allSettled"}\` ` +
      `starts one ${describeWorkList(kinds)} per element of ${site.collection}, ` +
      "with no visible bound on how many run at once.",
    evidence: buildEvidence(site, kinds, confidence, severity),
    effort: "small",
    fix_shape: "bound the concurrency, or page the source and process in batches",
    scores: {
      severity: severity.score(),
      confidence: confidence.value(),
    },
    suggested_actions: [
      {
        kind: "bound_concurrency",
        description:
          "Cap in-flight work — a concurrency-limited map, a batch loop, or a " +
          "semaphore. A limit of 5-20 usually costs nothing in wall-clock and " +
          "removes the failure mode entirely.",
        risk: "low",
      },
      {
        kind: "bound_the_source",
        description:
          site.producer !== undefined
            ? `Add a page size or \`take\` to \`${site.producer}\` so the ` +
              "collection cannot grow without the code changing."
            : "Page or limit whatever produces this collection, so its size is " +
              "a property of the program rather than of the data.",
        risk: "medium",
      },
    ],
  };
}

function buildEvidence(
  site: FanOutSite,
  kinds: string[],
  confidence: ConfidenceLadder,
  severity: SeverityLadder,
): string[] {
  const evidence: string[] = [];

  evidence.push(
    `fan-out: ${site.kind === "promise_all" ? "Promise.all" : "Promise.allSettled"} ` +
      `at line ${site.line}`,
  );
  evidence.push(`collection: ${site.collection}`);
  evidence.push(`collection source: ${describeSource(site.collectionSource)}`);
  if (site.producer !== undefined) {
    evidence.push(`produced by: ${site.producer}`);
  }

  evidence.push(`per-element work (${site.work.length}):`);
  for (const work of site.work.slice(0, 6)) {
    evidence.push(
      `  ${describeWorkKind(work.kind)} — ${work.callee} at line ${work.line}`,
    );
  }
  if (site.work.length > 6) {
    evidence.push(`  +${site.work.length - 6} more`);
  }

  evidence.push(
    "no bound visible: no `.slice()` or `take`/`limit` on the source, no " +
      "batching, no concurrency-limit helper, no semaphore",
  );
  evidence.push(
    `if the collection holds N elements, N concurrent ${describeWorkList(kinds)} ` +
      "start at once — N is a property of the data, not of this code",
  );

  evidence.push(confidence.explain());
  const escalation = severity.explain();
  if (escalation !== undefined) evidence.push(escalation);
  return evidence;
}

function describeSource(source: FanOutSite["collectionSource"]): string {
  switch (source) {
    case "await_call":
      return "an awaited call (query, request, or listing)";
    case "parameter":
      return "a parameter or local binding with no visible bound";
    case "property":
      return "a property read with no visible bound";
    case "literal":
      return "an array literal";
    case "unknown":
    case undefined:
      return "an expression whose size is not statically visible";
  }
}

function describeWorkKind(kind: FanOutWork["kind"]): string {
  switch (kind) {
    case "network":
      return "network request";
    case "database":
      return "database operation";
    case "filesystem":
      return "filesystem operation";
    case "subprocess":
      return "subprocess execution";
    case "queue":
      return "queue operation";
  }
}

function describeWorkList(kinds: string[]): string {
  if (kinds.length === 0) return "operation";
  const labels = kinds.map((k) => describeWorkKind(k as FanOutWork["kind"]));
  if (labels.length === 1) return labels[0]!;
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

function tailOf(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx === -1 ? name : name.slice(idx + 1);
}

function readOptions(config: {
  detectors?: { options?: Record<string, unknown> };
}): Options {
  const raw = config.detectors?.options?.unbounded_async_fanout;
  if (raw === undefined) return {};
  const parsed = optionsSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}
