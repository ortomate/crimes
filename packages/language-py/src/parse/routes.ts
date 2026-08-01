import type { Node } from "web-tree-sitter";
import type { PyClassMember, PyRoute } from "./types.js";
import { flatText, lastSegment, lineOf } from "./utils.js";

/**
 * HTTP methods and the framework-generic verbs. `route` covers Flask's
 * `@app.route("/x")`; `websocket` covers FastAPI's.
 */
const ROUTE_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "route",
  "websocket",
]);

/**
 * Receivers that plausibly own routes. Deliberately the same shape as
 * the function-shape classifier's list — a `@cache.get("key")` is not a
 * route, and mistaking one for a route would put a fabricated endpoint
 * into a cross-language finding.
 */
const ROUTE_RECEIVERS = /(^|[._])(app|router|api|bp|blueprint|mod|server)$/i;

/**
 * Extract a route from a decorator, if it declares one with a
 * string-literal path.
 *
 * Runtime-built paths (`@app.get(PREFIX + "/users")`) are skipped: the
 * IA family's rule is that a signal which cannot be quoted verbatim into
 * `Finding.evidence` is not recorded, and a half-known path would line
 * up against the wrong `fetch()` site.
 */
export function routeFromDecorator(
  decoratorNode: Node,
  handler: string | undefined,
): PyRoute | undefined {
  const call = findCall(decoratorNode);
  if (!call) return undefined;

  const callee = flatText(call.childForFieldName("function"));
  if (callee.length === 0) return undefined;
  const method = lastSegment(callee).toLowerCase();
  if (!ROUTE_METHODS.has(method)) return undefined;

  const receiver = callee.slice(0, Math.max(0, callee.length - method.length - 1));
  if (!ROUTE_RECEIVERS.test(receiver)) return undefined;

  const args = call.childForFieldName("arguments");
  if (!args) return undefined;
  const path = firstStringLiteral(args);
  if (path === undefined || !path.startsWith("/")) return undefined;

  const route: PyRoute = {
    method,
    path,
    receiver,
    line: lineOf(decoratorNode),
  };
  if (handler !== undefined) route.handler = handler;
  return route;
}

/** The `call` node inside a decorator, if the decorator is a call. */
function findCall(decoratorNode: Node): Node | undefined {
  for (let i = 0; i < decoratorNode.namedChildCount; i += 1) {
    const child = decoratorNode.namedChild(i);
    if (child && child.type === "call") return child;
  }
  return undefined;
}

/**
 * First positional string-literal argument's *content*, with the quotes
 * stripped. Keyword arguments are skipped so `@app.get(path="/x")` is
 * not confused with a positional path — it still resolves, because the
 * keyword's value is itself a string node encountered in order.
 */
function firstStringLiteral(argumentList: Node): string | undefined {
  for (let i = 0; i < argumentList.namedChildCount; i += 1) {
    const child = argumentList.namedChild(i);
    if (!child) continue;
    if (child.type === "string") return stringContent(child);
    if (child.type === "keyword_argument") {
      const name = flatText(child.childForFieldName("name"));
      if (name !== "path" && name !== "rule") continue;
      const value = child.childForFieldName("value");
      if (value && value.type === "string") return stringContent(value);
    }
  }
  return undefined;
}

/**
 * Text between the quotes. tree-sitter models a Python string as
 * `string_start` / `string_content` / `string_end`, so the content node
 * is read directly rather than trimming quote characters — which would
 * mangle prefixed forms like `f"..."` and `rb"..."`.
 */
export function stringContent(stringNode: Node): string | undefined {
  for (let i = 0; i < stringNode.namedChildCount; i += 1) {
    const child = stringNode.namedChild(i);
    if (child && child.type === "string_content") return child.text;
  }
  // An empty string literal has no `string_content` child.
  return stringNode.namedChildCount === 0 ? "" : undefined;
}

/**
 * Members of a class body that read as a closed set.
 *
 * Covers the two shapes that matter for cross-language type drift:
 *
 *     class Plan(str, Enum):        class Customer(BaseModel):
 *         FREE = "free"                 plan: str
 *         PRO = "pro"                   seats: int
 *
 * Plain method definitions are not members; they are already captured
 * as functions.
 */
export function extractClassMembers(bodyNode: Node): PyClassMember[] {
  const members: PyClassMember[] = [];
  for (let i = 0; i < bodyNode.namedChildCount; i += 1) {
    const stmt = bodyNode.namedChild(i);
    if (!stmt || stmt.type !== "expression_statement") continue;
    const assignment = stmt.namedChild(0);
    if (!assignment || assignment.type !== "assignment") continue;

    const left = assignment.childForFieldName("left");
    if (!left || left.type !== "identifier") continue;
    const name = flatText(left);
    if (name.length === 0 || name.startsWith("__")) continue;

    const member: PyClassMember = { name, line: lineOf(assignment) };
    const right = assignment.childForFieldName("right");
    if (right && right.type === "string") {
      const value = stringContent(right);
      if (value !== undefined) member.value = value;
    }
    members.push(member);
  }
  return members;
}

/**
 * A class or module docstring — the first statement, when it is a bare
 * string. Only the first line is kept: docstrings feed the alias-drift
 * source pool, where what matters is the vocabulary used, and carrying
 * whole paragraphs into an index would balloon it for no gain.
 */
export function extractDocstring(bodyNode: Node): string | undefined {
  const first = bodyNode.namedChild(0);
  if (!first || first.type !== "expression_statement") return undefined;
  const inner = first.namedChild(0);
  if (!inner || inner.type !== "string") return undefined;
  const content = stringContent(inner);
  if (content === undefined) return undefined;
  const line = content
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line;
}
