import type { Node } from "web-tree-sitter";
import type { PyAssertion, PyDateCall, PyIoCall } from "./types.js";
import { calleeText, lastSegment, lineOf } from "./utils.js";

/**
 * Recognise a clock read.
 *
 * The receiver must actually look like `datetime` / `date` / `time`. A
 * bare `now()` or a project-local `cache.now()` is not flagged: the
 * false-positive cost of matching every method called `now` across a
 * Python codebase is far higher than the recall we would gain, and
 * `direct_date.py` is meant to carry 0.9 confidence.
 */
export function matchDateCall(callNode: Node): PyDateCall | undefined {
  const callee = calleeText(callNode);
  if (callee.length === 0) return undefined;
  const method = lastSegment(callee);
  const receiver = callee.slice(0, Math.max(0, callee.length - method.length - 1));

  const args = callNode.childForFieldName("arguments");
  const argCount = args ? args.namedChildCount : 0;

  if (method === "now" || method === "utcnow") {
    if (!/(^|\.)datetime$/.test(receiver)) return undefined;
    return {
      kind: method === "utcnow" ? "utcnow" : "now",
      callee,
      line: lineOf(callNode),
      // `utcnow()` takes no arguments and is never tz-aware — it returns
      // a *naive* datetime holding UTC, which is the whole trap.
      timezoneAware: method === "now" && argCount > 0,
    };
  }

  if (method === "today") {
    if (!/(^|\.)(date|datetime)$/.test(receiver)) return undefined;
    return {
      kind: "today",
      callee,
      line: lineOf(callNode),
      timezoneAware: false,
    };
  }

  if (callee === "time.time") {
    return {
      kind: "time",
      callee,
      line: lineOf(callNode),
      timezoneAware: false,
    };
  }

  return undefined;
}

const NETWORK_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "request",
]);
const NETWORK_RECEIVERS = /(^|\.)(requests|httpx|session|client)$/i;

const SUBPROCESS_METHODS = new Set([
  "run",
  "call",
  "check_call",
  "check_output",
  "Popen",
]);

const FILE_METHODS = new Set(["read_text", "write_text", "read_bytes", "write_bytes"]);

/**
 * Recognise a blocking I/O call.
 *
 * Deliberately narrow. This is not a general "does this touch the
 * network" analysis — it is the set of calls whose *synchronous*
 * variant is a known hazard inside a request handler, which is what
 * `sync_io_in_hotpath.py` charges. `aiofiles.open` and `httpx.AsyncClient`
 * are the async escapes and are not matched.
 */
export function matchIoCall(
  callNode: Node,
): Omit<PyIoCall, "enclosingFunctions"> | undefined {
  const callee = calleeText(callNode);
  if (callee.length === 0) return undefined;
  const method = lastSegment(callee);
  const receiver = callee.slice(0, Math.max(0, callee.length - method.length - 1));
  const line = lineOf(callNode);

  if (callee === "open") return { callee, family: "file", line };
  if (FILE_METHODS.has(method)) return { callee, family: "file", line };

  if (callee === "urllib.request.urlopen" || callee === "urlopen") {
    return { callee, family: "network", line };
  }
  if (NETWORK_METHODS.has(method) && NETWORK_RECEIVERS.test(receiver)) {
    return { callee, family: "network", line };
  }

  if (SUBPROCESS_METHODS.has(method) && /(^|\.)subprocess$/.test(receiver)) {
    return { callee, family: "subprocess", line };
  }
  if (callee === "os.system") return { callee, family: "subprocess", line };

  if (callee === "time.sleep") return { callee, family: "sleep", line };

  return undefined;
}

/**
 * Recognise an assertion. Covers bare `assert`, the `unittest`
 * `self.assert*` family, and `pytest.raises` used as a context manager
 * — all three are real test strength, and a file that uses only one of
 * them should not read as untested to `weak_test_signal.py`.
 */
export function matchAssertionCall(
  callNode: Node,
): Omit<PyAssertion, "functionName"> | undefined {
  const callee = calleeText(callNode);
  if (callee.length === 0) return undefined;
  const method = lastSegment(callee);

  if (/^assert[A-Z_]/.test(method)) {
    return { kind: "unittest_method", method, line: lineOf(callNode) };
  }
  if (callee === "pytest.raises" || callee === "raises") {
    return { kind: "pytest_raises", line: lineOf(callNode) };
  }
  return undefined;
}
