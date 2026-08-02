import type { Node } from "web-tree-sitter";
import type {
  PyAssertion,
  PyCall,
  PyCallKeyword,
  PyDateCall,
  PyEnclosingFunction,
  PyIoCall,
} from "./types.js";
import { calleeText, flatText, lastSegment, lineOf } from "./utils.js";

/**
 * Read one `call` node into the general `PyCall` record.
 *
 * Every classifier below takes this rather than the raw node, so the
 * callee text and argument shape are computed once per call site
 * instead of once per matcher.
 */
export function buildCall(callNode: Node, funcStack: PyEnclosingFunction[]): PyCall {
  const callee = calleeText(callNode);
  const name = lastSegment(callee);
  const receiver = callee.slice(0, Math.max(0, callee.length - name.length - 1));
  const args = callNode.childForFieldName("arguments");

  const keywords: PyCallKeyword[] = [];
  let argCount = 0;
  if (args) {
    for (let i = 0; i < args.namedChildCount; i += 1) {
      const arg = args.namedChild(i);
      if (!arg) continue;
      argCount += 1;
      if (arg.type !== "keyword_argument") continue;
      const keywordName = flatText(arg.childForFieldName("name"));
      if (keywordName.length === 0) continue;
      const entry: PyCallKeyword = { name: keywordName };
      const value = stringLiteralValue(arg.childForFieldName("value"));
      if (value !== undefined) entry.stringValue = value;
      keywords.push(entry);
    }
  }

  return {
    callee,
    name,
    receiver,
    line: lineOf(callNode),
    argCount,
    keywords,
    enclosingFunctions: funcStack,
  };
}

/**
 * The text of a plain string literal, quotes and prefix stripped.
 * Returns `undefined` for f-strings, concatenations, and anything else
 * whose value cannot be read straight off the source.
 */
function stringLiteralValue(node: Node | null | undefined): string | undefined {
  if (!node || node.type !== "string") return undefined;
  let content: string | undefined;
  for (let i = 0; i < node.namedChildCount; i += 1) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === "interpolation") return undefined;
    if (child.type === "string_content") content = child.text;
  }
  return content ?? "";
}

/**
 * Recognise a clock read.
 *
 * The receiver must actually look like `datetime` / `date` / `time`. A
 * bare `now()` or a project-local `cache.now()` is not flagged: the
 * false-positive cost of matching every method called `now` across a
 * Python codebase is far higher than the recall we would gain, and
 * `direct_date.py` is meant to carry 0.9 confidence.
 */
export function matchDateCall(call: PyCall): PyDateCall | undefined {
  const { callee, name: method, receiver, argCount } = call;
  if (callee.length === 0) return undefined;

  if (method === "now" || method === "utcnow") {
    if (!/(^|\.)datetime$/.test(receiver)) return undefined;
    return {
      kind: method === "utcnow" ? "utcnow" : "now",
      callee,
      line: call.line,
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
      line: call.line,
      timezoneAware: false,
    };
  }

  if (callee === "time.time") {
    return {
      kind: "time",
      callee,
      line: call.line,
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
  call: PyCall,
): Omit<PyIoCall, "enclosingFunctions"> | undefined {
  const { callee, name: method, receiver, line } = call;
  if (callee.length === 0) return undefined;

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

/** Receivers on which a `fail(...)` really is the test-framework one. */
const FAIL_RECEIVERS = /^(self|cls|pytest|unittest)$/;

/**
 * Serialisation calls that validate as a side effect when asked to.
 * pydantic's `warnings='error'` turns a silent coercion into a raise,
 * which is the only reason anyone writes it.
 */
const RAISING_SERIALIZERS = new Set(["model_dump_json", "model_dump"]);

/**
 * Recognise an assertion.
 *
 * Covers bare `assert` (handled at the statement level, not here), the
 * `unittest` `self.assert*` family, `pytest.raises`, the explicit
 * `self.fail(...)` / `pytest.fail(...)` idiom, and calls whose whole
 * purpose is to raise on invalid data. Each is real test strength, and
 * a file that uses only one of them should not read as untested to
 * `weak_test_signal.py`.
 *
 * `fail` is matched only on a framework receiver. A project-local
 * `job.fail("retry")` is a state transition, not a test verdict, and
 * crediting it would hand a free pass to every test that touches a
 * job queue.
 */
export function matchAssertionCall(
  call: PyCall,
): Omit<PyAssertion, "functionName"> | undefined {
  const { callee, name: method, receiver, line } = call;
  if (callee.length === 0) return undefined;

  if (/^assert[A-Z_]/.test(method)) {
    return { kind: "unittest_method", method, line };
  }
  if (callee === "pytest.raises" || callee === "raises") {
    return { kind: "pytest_raises", line };
  }
  if (method === "fail" && FAIL_RECEIVERS.test(receiver)) {
    return { kind: "explicit_fail", method, line };
  }
  if (
    RAISING_SERIALIZERS.has(method) &&
    call.keywords.some((kw) => kw.name === "warnings" && kw.stringValue === "error")
  ) {
    return { kind: "raises_on_invalid", method, line };
  }
  return undefined;
}
