import ts from "typescript";
import {
  calleeName,
  calleeTail,
  endLineOf,
  isFunctionLike,
  pathTail,
  startLineOf,
  stringLiteralText,
  unwrap,
} from "./ast-util.js";
import type {
  AssertionCategory,
  MockDeclaration,
  TestAssertion,
  TestCase,
} from "./types.js";

/**
 * Test-surface extraction — the parser half of `mock_saturation`.
 *
 * The question this collector answers is not "does this test use mocks?"
 * — nearly every good unit test does — but "if every collaborator is
 * replaced and every assertion is about the replacements, what did the
 * test prove?"
 *
 * Answering it needs three inventories:
 *
 *  1. **Mock declarations** — what was replaced, and whether the
 *     replacement has any behaviour (`vi.mock("./db")` with a factory of
 *     bare `vi.fn()`s is *hollow*: it returns `undefined` for everything).
 *  2. **Test cases** — the `it` / `test` blocks, with their `describe`
 *     nesting so a finding can name the case a human would recognise.
 *  3. **Assertions, categorised** — an assertion about a mock's call
 *     count is evidence the code called something; an assertion about a
 *     returned value is evidence the code computed something. Only the
 *     second kind survives a refactor.
 *
 * Frameworks recognised: Vitest (`vi.*`), Jest (`jest.*`), Sinon
 * (`sinon.*`), and `node:test` (`mock.*`). They differ in spelling and
 * agree in structure, so one collector covers all four.
 */

const MAX_CASES_PER_FILE = 120;
const MAX_MOCKS_PER_FILE = 80;

/** Mocking namespaces, lowercased. */
const MOCK_NAMESPACES: ReadonlySet<string> = new Set([
  "vi",
  "jest",
  "sinon",
  "mock",
  "td",
]);

/** Namespace methods that replace a whole module. */
const MODULE_MOCK_METHODS: ReadonlySet<string> = new Set([
  "mock",
  "domock",
  "unstable_mockmodule",
  "setmock",
  "mockmodule",
]);

/** Namespace methods that replace one member of an object. */
const SPY_METHODS: ReadonlySet<string> = new Set([
  "spyon",
  "stub",
  "replace",
  "method",
  "fn",
  "createstubinstance",
]);

/** Matchers that only observe a test double. */
const MOCK_INTERACTION_MATCHERS: ReadonlySet<string> = new Set([
  "tohavebeencalled",
  "tohavebeencalledtimes",
  "tohavebeencalledwith",
  "tohavebeenlastcalledwith",
  "tohavebeennthcalledwith",
  "tohavebeencalledonce",
  "tohavereturned",
  "tohavereturnedtimes",
  "tohavereturnedwith",
  "tobecalled",
  "tobecalledwith",
  "calledonce",
  "calledwith",
  "called",
  "notcalled",
  "callcount",
]);

/** Matchers that assert a concrete value or structure. */
const VALUE_MATCHERS: ReadonlySet<string> = new Set([
  "tobe",
  "toequal",
  "tostrictequal",
  "tocontain",
  "tocontainequal",
  "tomatch",
  "tomatchobject",
  "tohavelength",
  "tohaveproperty",
  "tobecloseto",
  "tobegreaterthan",
  "tobegreaterthanorequal",
  "tobelessthan",
  "tobelessthanorequal",
  "tobeinstanceof",
  "tobenull",
  "tobeundefined",
  "tobenan",
  "toincludes",
  "toinclude",
  "deepequal",
  "equal",
  "strictequal",
  "deepstrictequal",
]);

/** Matchers that assert a failure happened. */
const ERROR_MATCHERS: ReadonlySet<string> = new Set([
  "tothrow",
  "tothrowerror",
  "toreject",
  "rejects",
  "throws",
  "tothrowerrormatchingsnapshot",
  "tothrowerrormatchinginlinesnapshot",
]);

/** Matchers that assert only "something exists". */
const TRUTHINESS_MATCHERS: ReadonlySet<string> = new Set([
  "tobetruthy",
  "tobefalsy",
  "tobedefined",
  "ok",
  "istrue",
  "isfalse",
]);

const SNAPSHOT_MATCHERS: ReadonlySet<string> = new Set([
  "tomatchsnapshot",
  "tomatchinlinesnapshot",
  "tomatchfilesnapshot",
]);

const TYPE_MATCHERS: ReadonlySet<string> = new Set([
  "toequaltypeof",
  "tomatchtypeof",
  "tobeassignable",
]);

const TEST_CALL_NAMES: ReadonlySet<string> = new Set(["it", "test"]);
const SUITE_CALL_NAMES: ReadonlySet<string> = new Set(["describe", "suite", "context"]);

export function collectMockDeclaration(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  out: MockDeclaration[],
): void {
  if (out.length >= MAX_MOCKS_PER_FILE) return;
  if (!ts.isCallExpression(node)) return;

  const callee = calleeName(node);
  if (callee === undefined || !callee.includes(".")) return;

  const namespace = callee.slice(0, callee.indexOf(".")).toLowerCase();
  if (!MOCK_NAMESPACES.has(namespace)) return;
  const method = pathTail(callee).toLowerCase();
  const line = startLineOf(node, sourceFile);

  if (MODULE_MOCK_METHODS.has(method)) {
    const target = node.arguments[0]
      ? stringLiteralText(unwrap(node.arguments[0]))
      : undefined;
    if (target === undefined) return;
    const factory = node.arguments[1] ? unwrap(node.arguments[1]) : undefined;
    out.push({
      kind: "module",
      target,
      line,
      hollow: factory === undefined || isHollowFactory(factory),
      autoMocked: factory === undefined,
    });
    return;
  }

  if (method === "usefaketimers" || method === "settimeout") {
    out.push({ kind: "timers", target: "clock", line, hollow: false, autoMocked: false });
    return;
  }

  if (SPY_METHODS.has(method)) {
    // `vi.spyOn(billing, "charge")` → target `billing.charge`.
    const first = node.arguments[0] ? unwrap(node.arguments[0]) : undefined;
    const second = node.arguments[1] ? unwrap(node.arguments[1]) : undefined;
    const objectText = first ? renderTarget(first, sourceFile) : undefined;
    const memberText = second ? stringLiteralText(second) : undefined;

    if (method === "fn") {
      // A bare `vi.fn()` is only a mock *declaration* when it is bound to
      // a name; inline `vi.fn()` arguments are counted through the module
      // factory instead, so they are not double-recorded here.
      const bound = boundName(node);
      if (bound === undefined) return;
      out.push({ kind: "fn", target: bound, line, hollow: node.arguments.length === 0, autoMocked: false });
      return;
    }

    const target =
      objectText !== undefined && memberText !== undefined
        ? `${objectText}.${memberText}`
        : (objectText ?? memberText);
    if (target === undefined) return;
    out.push({
      kind: method === "stub" || method === "createstubinstance" ? "stub" : "spy",
      target,
      line,
      hollow: !hasBehaviourChain(node),
      autoMocked: false,
    });
  }
}

/**
 * A factory whose members are all bare `vi.fn()` / `jest.fn()` with no
 * implementation. Such a module returns `undefined` for every call, so
 * nothing downstream of it can be exercised.
 */
function isHollowFactory(factory: ts.Node): boolean {
  const returned = returnedObject(factory);
  if (returned === undefined) return false;

  let sawMember = false;
  for (const prop of returned.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    sawMember = true;
    const init = unwrap(prop.initializer);
    if (!ts.isCallExpression(init)) return false;
    const callee = calleeName(init);
    if (callee === undefined) return false;
    if (pathTail(callee).toLowerCase() !== "fn") return false;
    // `vi.fn(() => realThing())` has behaviour.
    if (init.arguments.length > 0) return false;
    // `vi.fn().mockResolvedValue(x)` also has behaviour, but that is a
    // chained call — the initializer would not be the `fn()` call itself.
  }
  return sawMember;
}

/** The object literal a factory function returns, if it returns one. */
function returnedObject(factory: ts.Node): ts.ObjectLiteralExpression | undefined {
  if (ts.isObjectLiteralExpression(factory)) return factory;
  if (!isFunctionLike(factory)) return undefined;
  const body = (factory as { body?: ts.Node }).body;
  if (!body) return undefined;
  if (ts.isObjectLiteralExpression(body)) return body;
  // `() => ({ … })` parses the object inside parentheses.
  if (ts.isParenthesizedExpression(body) && ts.isObjectLiteralExpression(body.expression)) {
    return body.expression;
  }
  if (ts.isBlock(body)) {
    for (const statement of body.statements) {
      if (!ts.isReturnStatement(statement) || !statement.expression) continue;
      const expr = unwrap(statement.expression);
      if (ts.isObjectLiteralExpression(expr)) return expr;
    }
  }
  return undefined;
}

/** Does the spy get an implementation or a canned return value? */
function hasBehaviourChain(call: ts.CallExpression): boolean {
  let cur: ts.Node | undefined = call.parent;
  for (let depth = 0; depth < 6 && cur; depth++) {
    if (ts.isPropertyAccessExpression(cur)) {
      const name = cur.name.text.toLowerCase();
      if (
        name.startsWith("mock") ||
        name === "returns" ||
        name === "resolves" ||
        name === "callsfake" ||
        name === "throws"
      ) {
        return true;
      }
    }
    cur = cur.parent;
  }
  return false;
}

function boundName(call: ts.CallExpression): string | undefined {
  const parent = call.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  return undefined;
}

function renderTarget(node: ts.Expression, sourceFile: ts.SourceFile): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  const literal = stringLiteralText(node);
  if (literal !== undefined) return literal;
  const text = node.getText(sourceFile).replace(/\s+/g, " ").trim();
  return text.length > 0 && text.length <= 60 ? text : undefined;
}

/* ------------------------------------------------------------------ *
 * Test cases and assertions
 * ------------------------------------------------------------------ */

export function collectTestCase(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  out: TestCase[],
): void {
  if (out.length >= MAX_CASES_PER_FILE) return;
  if (!ts.isCallExpression(node)) return;

  const callee = calleeName(node);
  if (callee === undefined) return;
  // `it.each(...)`, `test.skip(...)` — the head of the chain names the call.
  const head = callee.split(".")[0]!;
  if (!TEST_CALL_NAMES.has(head)) return;
  // `it.todo("…")` has no body to inspect.
  if (/\.(todo|skip|failing)$/.test(callee)) return;

  const titleArg = node.arguments[0];
  const title = titleArg ? stringLiteralText(unwrap(titleArg)) : undefined;
  if (title === undefined) return;

  const body = node.arguments.find((a) => isFunctionLike(unwrap(a)));
  if (!body) return;

  out.push({
    title,
    line: startLineOf(node, sourceFile),
    endLine: endLineOf(node, sourceFile),
    suite: enclosingSuites(node, sourceFile),
    assertions: collectAssertions(unwrap(body), sourceFile),
    mockConfigurations: countMockConfigurations(unwrap(body)),
  });
}

/** `describe` titles enclosing this case, outermost first. */
function enclosingSuites(node: ts.Node, sourceFile: ts.SourceFile): string[] {
  const titles: string[] = [];
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isCallExpression(cur)) {
      const callee = calleeName(cur);
      const head = callee?.split(".")[0];
      if (head !== undefined && SUITE_CALL_NAMES.has(head)) {
        const arg = cur.arguments[0];
        const title = arg ? stringLiteralText(unwrap(arg)) : undefined;
        if (title !== undefined) titles.push(title);
      }
    }
    cur = cur.parent;
  }
  void sourceFile;
  return titles.reverse();
}

function collectAssertions(body: ts.Node, sourceFile: ts.SourceFile): TestAssertion[] {
  const out: TestAssertion[] = [];

  const visit = (node: ts.Node): void => {
    if (out.length >= 40) return;
    // A nested `it(...)` belongs to its own case.
    if (ts.isCallExpression(node)) {
      const callee = calleeName(node);
      const head = callee?.split(".")[0];
      if (head !== undefined && TEST_CALL_NAMES.has(head) && node !== body) return;

      const assertion = classifyAssertion(node, sourceFile);
      if (assertion !== undefined) out.push(assertion);
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return out;
}

/**
 * Categorise an assertion by its matcher.
 *
 * Two families of syntax: `expect(x).toBe(y)` (Jest / Vitest / Chai) and
 * `assert.equal(x, y)` (node:test / Chai's assert / Sinon). Both end in a
 * matcher name, which is the only thing that determines the category.
 */
function classifyAssertion(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
): TestAssertion | undefined {
  const matcher = calleeTail(call);
  if (matcher === undefined) return undefined;
  // A bare `f(x)` call is not an assertion; every recognised form is a
  // member access on `expect(…)` or on an `assert` namespace.
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
  const line = startLineOf(call, sourceFile);

  // `assert.equal(...)` / `assert.ok(...)` / `sinon.assert.calledWith(...)`
  const path = calleeName(call);
  if (path !== undefined && /(^|\.)assert\./.test(path)) {
    return { category: categoriseMatcher(matcher), matcher, line };
  }

  // `expect(x).resolves.not.toBe(y)` — walk down to find the `expect(` root.
  if (!rootsInExpect(call.expression)) return undefined;
  return { category: categoriseMatcher(matcher), matcher, line };
}

/** Does this member chain bottom out in an `expect(...)` call? */
function rootsInExpect(expr: ts.Expression): boolean {
  let cur: ts.Node = expr;
  for (let depth = 0; depth < 8; depth++) {
    if (ts.isPropertyAccessExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (ts.isCallExpression(cur)) {
      const callee = calleeName(cur);
      if (callee !== undefined) {
        const head = callee.split(".")[0]!;
        if (head === "expect" || head === "expectTypeOf") return true;
      }
      cur = cur.expression;
      continue;
    }
    if (ts.isAwaitExpression(cur) || ts.isNonNullExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (ts.isIdentifier(cur)) {
      return cur.text === "expect" || cur.text === "expectTypeOf";
    }
    return false;
  }
  return false;
}

function categoriseMatcher(matcher: string): AssertionCategory {
  const key = matcher.toLowerCase().replace(/[^a-z]/g, "");
  if (MOCK_INTERACTION_MATCHERS.has(key)) return "mock_interaction";
  if (ERROR_MATCHERS.has(key)) return "error";
  if (SNAPSHOT_MATCHERS.has(key)) return "snapshot";
  if (TYPE_MATCHERS.has(key)) return "type";
  if (TRUTHINESS_MATCHERS.has(key)) return "truthiness";
  if (VALUE_MATCHERS.has(key)) return "value";
  return "unknown";
}

/**
 * Count `mockReturnValue` / `mockResolvedValue` / `.returns()` calls
 * inside a case. A test that spends most of its body programming its
 * doubles and then asserts on those same doubles is describing the mock,
 * not the subject.
 */
function countMockConfigurations(body: ts.Node): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (count >= 50) return;
    if (ts.isCallExpression(node)) {
      const rawTail = calleeTail(node);
      if (rawTail !== undefined) {
        const tail = rawTail.toLowerCase();
        if (
          tail.startsWith("mockreturn") ||
          tail.startsWith("mockresolved") ||
          tail.startsWith("mockrejected") ||
          tail.startsWith("mockimplementation") ||
          tail === "returns" ||
          tail === "resolves" ||
          tail === "callsfake"
        ) {
          count += 1;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return count;
}
