import type { PyFunctionShape, PyIoCall } from "@crimes/language-py";
import type { LanguagePyDetector } from "../../detector.js";
import type { PreFinding as Finding, Severity } from "../../finding.js";
import { isTestFile } from "../../util/test-files.js";
import { intrinsicFor, lineList, plural, severityScore } from "./shared.js";

/**
 * Shapes where a blocking call runs per request / per render and so
 * costs real latency or a blocked worker.
 */
const HOT_SHAPES = new Set<PyFunctionShape>([
  "route_handler",
  "django_view",
  "domain",
]);

/**
 * Shapes that make a blocking call fine. A CLI command is *supposed* to
 * read files; a test is supposed to do whatever it likes. If one of
 * these is anywhere in the enclosing chain, the call is exempt — the
 * same "any ancestor" policy the JS detector applies.
 */
const EXEMPT_SHAPES = new Set<PyFunctionShape>(["test_function", "cli_command"]);

export const syncIoInHotpathPyDetector: LanguagePyDetector = {
  id: "sync_io_in_hotpath.py",
  name: "Blocking I/O in a hot path (Python)",
  description:
    "Flags open(), requests.*, urlopen, subprocess.* and time.sleep inside route " +
    "handlers, Django views, or domain functions.",
  whyItMatters:
    "A blocking call inside a request handler holds the worker for its whole " +
    "duration. Under a sync WSGI server that is one fewer concurrent request; inside " +
    "an `async def` handler it is far worse, because it blocks the entire event loop " +
    "and stalls every other request the process is serving, not just this one. The " +
    "failure mode is invisible in development — one user, one request — and appears " +
    "as latency collapse under load. Agents reach for `requests.get` by reflex " +
    "because it is the idiomatic example everywhere, including inside handlers that " +
    "cannot afford it.",

  pack: "language-py",
  run(ctx) {
    if (isTestFile(ctx.file)) return [];

    const offenders = ctx.parsed.ioCalls.filter(isHotPathCall);
    if (offenders.length === 0) return [];

    // Blocking the event loop is categorically worse than blocking one
    // sync worker, so async handlers drive severity up. Asked of the
    // scope chain rather than by testing line containment against every
    // function in the file — enclosure is the actual question, and the
    // chain already answers it.
    const inAsyncHandler = offenders.some((c) =>
      c.enclosingFunctions.some(
        (fn) => fn.kind === "async_function" || fn.kind === "async_method",
      ),
    );
    const severity = pickSeverity(offenders.length, inAsyncHandler);

    const evidence: string[] = [
      `${offenders.length} blocking ${plural(offenders.length, "call")}: ` +
        offenders.map((c) => `${c.callee}() line ${c.line}`).join(", "),
      lineList(offenders.map((c) => c.line)),
    ];
    for (const call of offenders.slice(0, 4)) {
      const host = call.enclosingFunctions.find((f) => HOT_SHAPES.has(f.shape));
      if (host) {
        evidence.push(
          `${call.callee}() runs inside ${host.name ?? "an anonymous function"} (shape "${host.shape}")`,
        );
      }
    }
    if (inAsyncHandler) {
      evidence.push(
        "at least one call sits inside an `async def` — a blocking call there stalls " +
          "the event loop for every concurrent request, not just this one",
      );
    }

    const families = [...new Set(offenders.map((c) => c.family))].sort();
    evidence.push(`families: ${families.join(", ")}`);

    const first = offenders[0]!;
    const last = offenders[offenders.length - 1]!;

    const finding: Finding = {
      id: "",
      type: "sync_io_in_hotpath",
      charge: "Blocking the Hot Path",
      severity,
      confidence: 0.8,
      file: ctx.file,
      ...(first.enclosingFunctions[0]?.name !== undefined
        ? { symbol: first.enclosingFunctions[0].name }
        : {}),
      lines: [first.line, last.line],
      summary:
        `${offenders.length} blocking I/O ${plural(offenders.length, "call")} ` +
        `inside request- or domain-path ${plural(offenders.length, "function")}` +
        (inAsyncHandler ? ", at least one of them in an async handler" : "") +
        ". Each one holds the worker — or the event loop — for its full duration.",
      evidence,
      effort: "medium",
      fix_shape: "move the call off the request path, or use the async client",
      scores: {
        severity: severityScore(severity),
        confidence: 0.8,
        agent_risk: intrinsicFor({
          count: offenders.length,
          base: inAsyncHandler ? 0.7 : 0.5,
          step: 0.06,
          cap: 0.9,
        }),
      },
      suggested_actions: [
        {
          kind: "move_off_hot_path",
          description:
            "Move the call into a background task or a cached layer, or switch to the " +
            "async equivalent (`httpx.AsyncClient`, `aiofiles`, `asyncio.sleep`) so the " +
            "worker is released while it waits.",
          risk: "medium",
        },
      ],
    };

    return [finding];
  },
};

/**
 * A call counts when a hot shape appears in its enclosing chain and no
 * exempt shape does. "Anywhere in the chain" matters both ways: a
 * blocking call nested three closures deep inside a route handler still
 * runs per request, and one nested inside a test helper still doesn't.
 */
function isHotPathCall(call: PyIoCall): boolean {
  if (call.enclosingFunctions.length === 0) return false;
  if (call.enclosingFunctions.some((f) => EXEMPT_SHAPES.has(f.shape))) return false;
  return call.enclosingFunctions.some((f) => HOT_SHAPES.has(f.shape));
}

function pickSeverity(count: number, inAsyncHandler: boolean): Severity {
  if (inAsyncHandler && count >= 2) return "high";
  if (inAsyncHandler || count >= 3) return "medium";
  return "low";
}
