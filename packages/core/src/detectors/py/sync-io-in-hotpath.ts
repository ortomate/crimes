import type { PyEnclosingFunction, PyFunctionShape, PyIoCall } from "@crimes/language-py";
import type { LanguagePyDetector } from "../../detector.js";
import type { PreFinding as Finding, Severity } from "../../finding.js";
import { isTestFile } from "../../util/test-files.js";
import { intrinsicFor, lineList, plural, severityScore } from "./shared.js";

/**
 * Shapes where a blocking call runs per request / per render and so
 * costs real latency or a blocked worker.
 */
const HOT_SHAPES = new Set<PyFunctionShape>(["route_handler", "django_view", "domain"]);

/**
 * Shapes that make a blocking call fine. A CLI command is *supposed* to
 * read files; a test is supposed to do whatever it likes. If one of
 * these is anywhere in the enclosing chain, the call is exempt — the
 * same "any ancestor" policy the JS detector applies.
 */
const EXEMPT_SHAPES = new Set<PyFunctionShape>([
  "test_function",
  "cli_command",
  // A memoised body runs once, not once per request. Caching a slow
  // call is the standard *fix* for this charge, so charging the result
  // told people their fix was the crime. `cli_command` now also covers
  // Django's `Command(BaseCommand).handle()`, reached through
  // `manage.py` — an entry point whose job is to read files.
  "memoised",
]);

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

    const hits = ctx.parsed.ioCalls.filter(isHotPathCall);
    if (hits.length === 0) return [];

    // One finding per enclosing hot function, not one per file.
    //
    // The file-level shape produced a finding whose `symbol` named the
    // first offender's function while its `lines` stretched from the
    // first call to the last — on airflow, spans up to 4,196 lines
    // wearing one function's name, with the evidence itself listing
    // calls in two or three *other* functions. Any ±N-line excerpt built
    // from that range describes code the finding is not about, and
    // `crimes context` builds exactly such excerpts.
    //
    // Grouping on the innermost hot function makes `symbol`, `lines` and
    // the evidence describe the same code, and makes each finding
    // separately ignorable — a file with one acceptable blocking call
    // and one real one no longer has to be suppressed wholesale.
    const groups = new Map<string, { host: PyEnclosingFunction; calls: PyIoCall[] }>();
    for (const call of hits) {
      const host = call.enclosingFunctions.find((f) => HOT_SHAPES.has(f.shape));
      if (host === undefined) continue;
      const key = `${host.name ?? "<anonymous>"}:${host.startLine}`;
      const group = groups.get(key);
      if (group) group.calls.push(call);
      else groups.set(key, { host, calls: [call] });
    }

    // Splitting per function is a correctness fix, but it also multiplies
    // findings — on airflow, 494 file-level findings became 1,108. Cap
    // the worst few per file and say how many were held back, rather
    // than trading one wrong finding for four right ones nobody reads.
    const ranked = [...groups.values()].sort(
      (a, b) => b.calls.length - a.calls.length || a.host.startLine - b.host.startLine,
    );
    const shown = ranked.slice(0, MAX_FUNCTIONS_PER_FILE);
    const withheld = ranked.length - shown.length;
    return shown
      .sort((a, b) => a.host.startLine - b.host.startLine)
      .map((group) => buildFinding(ctx.file, group.host, group.calls, withheld));
  },
};

/** Functions reported per file before the rest are summarised. */
const MAX_FUNCTIONS_PER_FILE = 3;

function buildFinding(
  file: string,
  host: PyEnclosingFunction,
  offenders: PyIoCall[],
  withheld: number,
): Finding {
  {
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
    evidence.push(
      `all inside ${host.name ?? "an anonymous function"} ` +
        `(shape "${host.shape}", lines ${host.startLine}\u2013${host.endLine})`,
    );
    if (inAsyncHandler) {
      evidence.push(
        "at least one call sits inside an `async def` — a blocking call there stalls " +
          "the event loop for every concurrent request, not just this one",
      );
    }

    const families = [...new Set(offenders.map((c) => c.family))].sort();
    evidence.push(`families: ${families.join(", ")}`);
    if (withheld > 0) {
      evidence.push(
        `${withheld} further ${plural(withheld, "function")} in this file also ` +
          `${withheld === 1 ? "blocks" : "block"} — the ${MAX_FUNCTIONS_PER_FILE} ` +
          "with the most calls are reported separately",
      );
    }

    const first = offenders[0]!;
    const last = offenders[offenders.length - 1]!;

    const finding: Finding = {
      id: "",
      type: "sync_io_in_hotpath",
      charge: "Blocking the Hot Path",
      severity,
      confidence: 0.8,
      file,
      ...(host.name !== undefined ? { symbol: host.name } : {}),
      // Bounded by the function this finding is about, so an excerpt
      // built from the range shows the code being charged.
      lines: [Math.max(host.startLine, first.line), Math.min(host.endLine, last.line)],
      summary:
        `${offenders.length} blocking I/O ${plural(offenders.length, "call")} ` +
        `inside \`${host.name ?? "an anonymous function"}\`` +
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

    return finding;
  }
}

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
