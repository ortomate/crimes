import type { EnclosingFunction, FunctionShape, SyncIoCall } from "@crimes/language-js";
import type { Detector } from "../detector.js";
import type { Finding, Severity } from "../finding.js";
import { isTestFile } from "../util/test-files.js";

/**
 * Function shapes where a synchronous I/O call is treated as a
 * hot-path crime. The intent: this call runs on every request /
 * render / domain call, blocking the event loop each time.
 */
const HOTPATH_SHAPES: ReadonlySet<FunctionShape> = new Set([
  "route_handler",
  "page_export",
  "react_component",
  "domain",
]);

/**
 * Function shapes whose presence anywhere in the enclosing chain
 * suppresses the finding. Test code and CLI registrations are
 * legitimate sync-I/O surfaces — flagging them would be noise.
 */
const SUPPRESSING_SHAPES: ReadonlySet<FunctionShape> = new Set([
  "test_callback",
  "cli_command_registrar",
]);

/**
 * `readFileSync` / `writeFileSync` / `execSync` / … invoked inside a
 * function that runs on every request, render, or domain call. The
 * synchronous APIs block the event loop, which is a per-request
 * latency tax in route handlers and a render-thread tax in React.
 * Async counterparts (`readFile`, `writeFile`, `exec`) exist for
 * every method captured here.
 *
 * Gating uses the parser's `enclosingFunctions` chain:
 *   - Any `test_callback` or `cli_command_registrar` in the chain
 *     suppresses the finding (intentional sync I/O surface).
 *   - Otherwise the finding fires when the innermost shape from the
 *     hot-path set is found anywhere in the chain. Anonymous
 *     callbacks (`unknown`) inside a hot-path function still fire —
 *     the call ultimately runs per request / render even when wrapped
 *     in `.forEach(...)` or `useEffect(...)`.
 */
export const syncIoInHotpathDetector: Detector = {
  id: "sync_io_in_hotpath",
  name: "Sync I/O in Hot Path",
  description:
    "Flags synchronous Node.js I/O calls (`fs.readFileSync`, " +
    "`execSync`, …) inside route handlers, page exports, React " +
    "components, and domain functions — each call blocks the event " +
    "loop on every invocation.",
  whyItMatters:
    "Synchronous I/O inside a hot path is one of the silent " +
    "performance bugs agents introduce most often — the code reads " +
    "fine, the test passes (the test is itself synchronous and " +
    "single-threaded), and the cost only shows up under concurrent " +
    "load. Coding agents tend to reach for the sync variant because " +
    "it's shorter, then leave it there. Switching to the async API " +
    "is a mechanical change with no behaviour difference outside the " +
    "performance envelope.",

  pack: "language-js",
  run(ctx) {
    if (isTestFile(ctx.file)) return [];
    const calls = ctx.parsed.syncIoCalls;
    if (!calls || calls.length === 0) return [];

    const offenders = calls
      .map((call) => ({ call, hot: classifyCall(call) }))
      .filter((x): x is { call: SyncIoCall; hot: EnclosingFunction } =>
        x.hot !== undefined,
      );
    if (offenders.length === 0) return [];

    const severity = pickSeverity(offenders);
    const lines = offenders.map((o) => o.call.line);
    const sampleCount = Math.min(offenders.length, 3);
    const samples = offenders.slice(0, sampleCount).map((o) => {
      const where = o.hot.name ? ` in \`${o.hot.name}\`` : "";
      return `\`${o.call.callee}\` @L${o.call.line}${where} (${labelFor(o.hot.shape)})`;
    });
    const overflow = offenders.length > sampleCount
      ? `…and ${offenders.length - sampleCount} more`
      : undefined;

    const finding: Finding = {
      id: "",
      type: "sync_io_in_hotpath",
      charge: "Sync I/O in Hot Path",
      severity,
      confidence: 0.9,
      file: ctx.file,
      lines: [lines[0]!, lines[lines.length - 1]!],
      summary:
        `${offenders.length} synchronous I/O call${offenders.length === 1 ? "" : "s"} ` +
        `inside ${describeShapes(offenders)} — each invocation blocks the ` +
        `event loop for the duration of the I/O. Async counterparts exist for ` +
        `every method captured.`,
      evidence: [
        ...samples,
        ...(overflow ? [overflow] : []),
        `lines: ${lines.slice(0, 10).join(", ")}${lines.length > 10 ? `, …+${lines.length - 10} more` : ""}`,
        `swap for the async variant (\`readFile\`, \`writeFile\`, \`exec\`, …) and \`await\` it`,
      ],
      effort: "small",
      fix_shape: "switch to async I/O; await at the call site",
      scores: {
        severity: severityScore(severity),
        confidence: 0.9,
        agent_risk: round(Math.min(0.55 + (offenders.length - 1) * 0.08, 0.9)),
      },
      suggested_actions: [
        {
          kind: "swap_for_async_io",
          description:
            "Replace the `*Sync` call with its async counterpart and " +
            "`await` it. The function may need to be marked `async`; " +
            "React components should move the I/O into a Server " +
            "Component / loader rather than the render body.",
          risk: "low",
        },
      ],
    };
    return [finding];
  },
};

/**
 * Decide whether a call is a hot-path crime, and if so attribute it
 * to the innermost hot-path enclosing function (for the evidence
 * line). Returns `undefined` for calls outside the hot-path set or
 * for calls inside any suppressing shape.
 */
function classifyCall(call: SyncIoCall): EnclosingFunction | undefined {
  const chain = call.enclosingFunctions;
  if (chain.length === 0) return undefined;
  for (const fn of chain) {
    if (SUPPRESSING_SHAPES.has(fn.shape)) return undefined;
  }
  for (const fn of chain) {
    if (HOTPATH_SHAPES.has(fn.shape)) return fn;
  }
  return undefined;
}

function pickSeverity(
  offenders: ReadonlyArray<{ hot: EnclosingFunction }>,
): Severity {
  // Route handlers and React renders are the highest-impact surfaces —
  // every request / render eats the sync stall. Multiple calls in
  // one file compound it. Pure-`domain` findings stay low: the call
  // may still be wrong, but the bug class is "library happens to
  // block under load" rather than "request handler stalls on every
  // hit". Low keeps these off the default report while leaving them
  // available under `--all` and via JSON consumers.
  const hasRequestSurface = offenders.some(
    (o) =>
      o.hot.shape === "route_handler" ||
      o.hot.shape === "page_export" ||
      o.hot.shape === "react_component",
  );
  if (hasRequestSurface && offenders.length >= 2) return "high";
  if (hasRequestSurface) return "medium";
  return "low";
}

function describeShapes(
  offenders: ReadonlyArray<{ hot: EnclosingFunction }>,
): string {
  const unique = new Set(offenders.map((o) => labelFor(o.hot.shape)));
  return [...unique].join(" / ");
}

function labelFor(shape: FunctionShape): string {
  switch (shape) {
    case "route_handler": return "route handler";
    case "page_export": return "page export";
    case "react_component": return "React component";
    case "domain": return "domain function";
    default: return shape;
  }
}

function severityScore(s: Severity): number {
  return s === "high" ? 0.85 : s === "medium" ? 0.6 : 0.4;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
