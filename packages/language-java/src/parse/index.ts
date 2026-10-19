import type { Node } from "web-tree-sitter";
import { ensureJavaParser } from "./grammar.js";
import type {
  JavaCatch,
  JavaImport,
  JavaMethodShape,
  JavaTypeKind,
  ParsedJavaFile,
  ParsedJavaMethod,
  ParsedJavaType,
  ParseJavaInput,
} from "./types.js";

export * from "./types.js";
export {
  ensureJavaParser,
  JavaGrammarNotFoundError,
  resolveJavaGrammarPath,
} from "./grammar.js";

const TYPE_DECLARATIONS: Record<string, JavaTypeKind> = {
  class_declaration: "class",
  interface_declaration: "interface",
  enum_declaration: "enum",
  record_declaration: "record",
  annotation_type_declaration: "annotation",
};

/** Statements that open a nesting level for `maxNestingDepth`. */
const COMPOUND_STATEMENTS = new Set([
  "if_statement",
  "for_statement",
  "enhanced_for_statement",
  "while_statement",
  "do_statement",
  "try_statement",
  "try_with_resources_statement",
  "switch_expression",
  "synchronized_statement",
]);

const TEST_ANNOTATIONS = new Set([
  "Test",
  "ParameterizedTest",
  "RepeatedTest",
  "TestFactory",
  "TestTemplate",
]);

const DISABLED_ANNOTATIONS = new Set(["Disabled", "Ignore"]);

/**
 * Assertion-shaped method names: JUnit, AssertJ, Hamcrest and TestNG
 * `assert*`; `fail`; Mockito `verify*`; EasyMock and JMock `expect*`;
 * MockMvc `andExpect`.
 */
const ASSERTION_NAME = /^(?:assert|verify|expect)|^(?:fail|andExpect)$/;

/** Types whose static `now()` reads the system clock. */
const CLOCK_TYPES = new Set([
  "Instant",
  "LocalDate",
  "LocalDateTime",
  "LocalTime",
  "ZonedDateTime",
  "OffsetDateTime",
  "OffsetTime",
  "Year",
  "YearMonth",
  "MonthDay",
]);

/** Receivers that make a call a logging call. */
const LOG_RECEIVER = /^(?:this\.)?_?(?:log|logger)$|^System\.(?:out|err)$/i;

/** Empty-collection factories a catch can return as a bland fallback. */
const EMPTY_FACTORY =
  /^(?:Collections\.empty(?:List|Set|Map)?|(?:List|Set|Map)\.of|Optional\.empty)$/;

/**
 * Parse one Java file into the surface detectors read.
 *
 * Single pass carrying the enclosing type and method down the tree, so
 * no detector re-walks the AST. Never throws on malformed input:
 * tree-sitter recovers locally, and `hasSyntaxErrors` says so.
 */
export async function parseJavaFile(input: ParseJavaInput): Promise<ParsedJavaFile> {
  const parser = await ensureJavaParser();
  const tree = parser.parse(input.source);
  const result: ParsedJavaFile = {
    lineCount: input.source.split("\n").length,
    imports: [],
    types: [],
    methods: [],
    catches: [],
    clockReads: [],
    referencedTypes: [],
    hasSyntaxErrors: false,
  };
  if (!tree) return result;
  try {
    result.hasSyntaxErrors = tree.rootNode.hasError;
    collect(tree.rootNode, result);
  } finally {
    tree.delete();
  }
  result.types.sort((a, b) => a.startLine - b.startLine);
  result.methods.sort((a, b) => a.startLine - b.startLine);
  return result;
}

interface Frame {
  node: Node;
  type?: ParsedJavaType;
  method?: ParsedJavaMethod;
  localCalls?: Set<string>;
  inFinally: boolean;
}

/**
 * Iterative depth-first walk. Recursion would be simpler, but a deeply
 * nested builder chain can overflow the stack, and that would take out
 * the scan instead of one file.
 */
function collect(root: Node, result: ParsedJavaFile): void {
  const referenced = new Set<string>();
  const declared = new Set<string>();
  const callSets = new Map<ParsedJavaMethod, Set<string>>();
  const stack: Frame[] = [{ node: root, inFinally: false }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const { node } = frame;
    let { type, method, localCalls } = frame;
    let inFinally = frame.inFinally;

    switch (node.type) {
      case "package_declaration": {
        const name = node.namedChildren.find(
          (c) => c?.type === "scoped_identifier" || c?.type === "identifier",
        );
        if (name) result.packageName = name.text;
        break;
      }
      case "import_declaration":
        result.imports.push(buildImport(node));
        // Nothing inside an import is a type reference of this file's own.
        continue;
      case "finally_clause":
        inFinally = true;
        break;
      case "method_declaration":
      case "constructor_declaration":
      case "compact_constructor_declaration": {
        method = buildMethod(node, type);
        localCalls = new Set<string>();
        callSets.set(method, localCalls);
        result.methods.push(method);
        break;
      }
      case "catch_clause": {
        const caught = buildCatch(node, { method, type, inFinally });
        if (caught) result.catches.push(caught);
        break;
      }
      case "method_invocation":
        visitInvocation(node, { method, localCalls, result, referenced });
        break;
      case "object_creation_expression":
        visitCreation(node, { method, result });
        break;
      case "field_access": {
        const object = node.childForFieldName("object");
        if (object?.type === "identifier") addTypeLike(referenced, object.text);
        break;
      }
      case "assert_statement":
        if (method) method.assertionCount += 1;
        break;
      case "type_identifier":
        referenced.add(node.text);
        break;
      case "marker_annotation":
      case "annotation": {
        const name = node.childForFieldName("name");
        if (name?.type === "identifier") referenced.add(name.text);
        break;
      }
      default: {
        const kind = TYPE_DECLARATIONS[node.type];
        if (kind !== undefined) {
          const built = buildType(node, kind, type);
          if (built) {
            result.types.push(built);
            declared.add(built.name);
            type = built;
            // A nested type's methods are not the outer method's.
            method = undefined;
            localCalls = undefined;
          }
        }
      }
    }

    // Anonymous class bodies belong to their own methods.
    const childMethod = node.type === "class_body" ? undefined : method;
    const childCalls = node.type === "class_body" ? undefined : localCalls;
    for (let i = node.childCount - 1; i >= 0; i -= 1) {
      const child = node.child(i);
      if (!child) continue;
      stack.push({
        node: child,
        ...(type !== undefined ? { type } : {}),
        ...(childMethod !== undefined ? { method: childMethod } : {}),
        ...(childCalls !== undefined ? { localCalls: childCalls } : {}),
        inFinally,
      });
    }
  }

  for (const [method, calls] of callSets) method.localCalls = [...calls];
  // A file's own types are not references to elsewhere.
  for (const name of declared) referenced.delete(name);
  result.referencedTypes = [...referenced].sort();
}

function buildImport(node: Node): JavaImport {
  let name = "";
  let isStatic = false;
  let wildcard = false;
  for (const child of node.children) {
    if (!child) continue;
    if (child.type === "static") isStatic = true;
    else if (child.type === "asterisk") wildcard = true;
    else if (child.type === "scoped_identifier" || child.type === "identifier") {
      name = child.text;
    }
  }
  return { name, static: isStatic, wildcard, line: lineOf(node) };
}

function buildType(
  node: Node,
  kind: JavaTypeKind,
  enclosing: ParsedJavaType | undefined,
): ParsedJavaType | undefined {
  const name = node.childForFieldName("name")?.text;
  if (!name) return undefined;
  const superclass = node.children.find((c) => c?.type === "superclass")?.namedChildren[0]
    ?.text;
  return {
    name,
    kind,
    startLine: lineOf(node),
    endLine: endLineOf(node),
    annotations: annotationsOf(node),
    ...(superclass !== undefined ? { superclass } : {}),
    ...(enclosing !== undefined ? { enclosingType: enclosing.name } : {}),
  };
}

function buildMethod(node: Node, type: ParsedJavaType | undefined): ParsedJavaMethod {
  const isConstructor = node.type !== "method_declaration";
  const name = node.childForFieldName("name")?.text ?? "(anonymous)";
  const annotations = annotationsOf(node);
  const body = node.childForFieldName("body");
  const params = node.childForFieldName("parameters");
  const paramCount =
    params?.namedChildren.filter(
      (p) => p?.type === "formal_parameter" || p?.type === "spread_parameter",
    ).length ?? 0;

  const { shape, evidence } = classifyShape({ name, isConstructor, annotations, type });
  const testAnnotation = annotationNodes(node).find((a) =>
    TEST_ANNOTATIONS.has(simpleName(a.childForFieldName("name")?.text ?? "")),
  );
  const expectsException =
    testAnnotation?.type === "annotation" &&
    /\bexpected(?:Exceptions)?\s*=/.test(
      testAnnotation.childForFieldName("arguments")?.text ?? "",
    );

  return {
    name,
    kind: isConstructor ? "constructor" : "method",
    startLine: signatureLine(node),
    endLine: endLineOf(node),
    shape,
    shapeEvidence: evidence,
    annotations,
    paramCount,
    maxNestingDepth: body ? nestingDepth(body) : 0,
    ...(type !== undefined ? { className: type.name } : {}),
    hasBody: body !== null,
    assertionCount: 0,
    expectsException,
    disabled: annotations.some((a) => DISABLED_ANNOTATIONS.has(a)),
    localCalls: [],
  };
}

function classifyShape(args: {
  name: string;
  isConstructor: boolean;
  annotations: string[];
  type: ParsedJavaType | undefined;
}): { shape: JavaMethodShape; evidence: string[] } {
  if (args.isConstructor) return { shape: "constructor", evidence: ["constructor"] };
  const test = args.annotations.find((a) => TEST_ANNOTATIONS.has(a));
  if (test) return { shape: "test_method", evidence: [`annotated @${test}`] };
  if (
    /^test/.test(args.name) &&
    args.type?.superclass !== undefined &&
    /\bTestCase\b/.test(args.type.superclass)
  ) {
    return {
      shape: "test_method",
      evidence: [`JUnit 3 test on a ${args.type.superclass} subclass`],
    };
  }
  return { shape: "domain", evidence: [] };
}

function buildCatch(
  node: Node,
  scope: {
    method: ParsedJavaMethod | undefined;
    type: ParsedJavaType | undefined;
    inFinally: boolean;
  },
): JavaCatch | undefined {
  const formal = node.namedChildren.find((c) => c?.type === "catch_formal_parameter");
  const body = node.childForFieldName("body");
  if (!formal || !body) return undefined;
  const caughtTypes =
    formal.namedChildren
      .find((c) => c?.type === "catch_type")
      ?.namedChildren.filter((c) => c !== null)
      .map((c) => c!.text) ?? [];
  const param =
    formal.childForFieldName("name")?.text ??
    formal.namedChildren.filter((c) => c?.type === "identifier").pop()?.text ??
    "";

  const statements = body.namedChildren.filter(
    (c): c is Node =>
      c !== null && c.type !== "line_comment" && c.type !== "block_comment",
  );
  const comments = body.descendantsOfType(["line_comment", "block_comment"]);
  const usesParam =
    param !== "" && body.descendantsOfType("identifier").some((id) => id?.text === param);
  const tryBlock = node.parent?.childForFieldName("body");

  return {
    line: lineOf(node),
    endLine: endLineOf(node),
    caughtTypes,
    param,
    statementCount: statements.length,
    commentText: comments
      .filter((c): c is Node => c !== null)
      .map((c) => c.text)
      .join(" "),
    usesParam,
    rethrows: body.descendantsOfType("throw_statement").length > 0,
    logStatements: statements.filter(isLogStatement).length,
    returnsFallback: statements.length === 1 && isFallbackReturn(statements[0]!),
    inFinally: scope.inFinally,
    protectedText: (tryBlock?.text ?? "").slice(0, 600),
    ...(scope.method !== undefined ? { enclosingMethod: scope.method.name } : {}),
    ...(scope.type !== undefined ? { enclosingType: scope.type.name } : {}),
  };
}

function isLogStatement(statement: Node): boolean {
  if (statement.type !== "expression_statement") return false;
  const call = statement.namedChildren[0];
  if (call?.type !== "method_invocation") return false;
  const name = call.childForFieldName("name")?.text ?? "";
  if (name === "printStackTrace") return true;
  const object = call.childForFieldName("object")?.text ?? "";
  return LOG_RECEIVER.test(object);
}

function isFallbackReturn(statement: Node): boolean {
  if (statement.type !== "return_statement") return false;
  const value = statement.namedChildren[0];
  if (!value) return true;
  switch (value.type) {
    case "null_literal":
    case "true":
    case "false":
    case "decimal_integer_literal":
    case "decimal_floating_point_literal":
    case "string_literal":
      return true;
    case "method_invocation": {
      const object = value.childForFieldName("object")?.text ?? "";
      const name = value.childForFieldName("name")?.text ?? "";
      return EMPTY_FACTORY.test(`${object}.${name}`);
    }
    default:
      return false;
  }
}

function visitInvocation(
  node: Node,
  ctx: {
    method: ParsedJavaMethod | undefined;
    localCalls: Set<string> | undefined;
    result: ParsedJavaFile;
    referenced: Set<string>;
  },
): void {
  const name = node.childForFieldName("name")?.text ?? "";
  const object = node.childForFieldName("object");
  const objectText = object?.text;
  if (object?.type === "identifier") addTypeLike(ctx.referenced, object.text);

  if (ctx.method) {
    if (ASSERTION_NAME.test(name)) ctx.method.assertionCount += 1;
    if (object === null || objectText === "this") ctx.localCalls?.add(name);
  }

  const args = node.childForFieldName("arguments");
  const argCount = args?.namedChildren.filter((c) => c !== null).length ?? 0;
  let callee: string | undefined;
  if (objectText === "System" && name === "currentTimeMillis") {
    // A stopwatch, not a dependency on what time it is.
    if (isElapsedTimer(node)) return;
    callee = "System.currentTimeMillis";
  } else if (objectText === "Calendar" && name === "getInstance" && argCount === 0) {
    callee = "Calendar.getInstance";
  } else if (
    objectText !== undefined &&
    CLOCK_TYPES.has(objectText) &&
    name === "now" &&
    // `now(clock)` is the injected form this detector asks for; a zone
    // argument still reads the system clock.
    !(argCount === 1 && /clock/i.test(args?.namedChildren[0]?.text ?? ""))
  ) {
    callee = `${objectText}.now`;
  }
  if (callee !== undefined) {
    ctx.result.clockReads.push({
      line: lineOf(node),
      callee,
      ...(ctx.method !== undefined ? { enclosingMethod: ctx.method.name } : {}),
    });
  }
}

/** Names a timer's starting reading goes by: `start`, `batchStartTime`, `t0`. */
const TIMER_NAME = /start|begin|before|^t\d$/i;

/**
 * `long start = System.currentTimeMillis()` and
 * `System.currentTimeMillis() - start` measure elapsed time; the result
 * is the same whatever the clock says. `currentTimeMillis() -
 * lastModified.getTime()` is an age, which does depend on it, and is not
 * matched: only a timer-named operand counts.
 */
function isElapsedTimer(call: Node): boolean {
  const parent = call.parent;
  if (!parent) return false;
  if (parent.type === "variable_declarator") {
    return TIMER_NAME.test(parent.childForFieldName("name")?.text ?? "");
  }
  if (parent.type === "assignment_expression") {
    return TIMER_NAME.test(parent.childForFieldName("left")?.text ?? "");
  }
  if (
    parent.type === "binary_expression" &&
    parent.childForFieldName("operator")?.text === "-"
  ) {
    const other =
      parent.childForFieldName("left")?.id === call.id
        ? parent.childForFieldName("right")
        : parent.childForFieldName("left");
    return other?.type === "identifier" && TIMER_NAME.test(other.text);
  }
  return false;
}

function visitCreation(
  node: Node,
  ctx: { method: ParsedJavaMethod | undefined; result: ParsedJavaFile },
): void {
  const typeName = simpleName(node.childForFieldName("type")?.text ?? "");
  const argCount =
    node.childForFieldName("arguments")?.namedChildren.filter((c) => c !== null).length ??
    0;
  if (argCount !== 0) return;
  if (typeName !== "Date" && typeName !== "GregorianCalendar") return;
  ctx.result.clockReads.push({
    line: lineOf(node),
    callee: `new ${typeName}`,
    ...(ctx.method !== undefined ? { enclosingMethod: ctx.method.name } : {}),
  });
}

/**
 * Record an identifier used as a receiver when it reads as a type:
 * `Film.of(…)`, `Status.ACTIVE`. All-caps names are constants or fields
 * (`LOG.info`), not types.
 */
function addTypeLike(into: Set<string>, name: string): void {
  if (/^[A-Z][A-Za-z0-9_]*$/.test(name) && !/^[A-Z0-9_]+$/.test(name)) into.add(name);
}

function annotationNodes(node: Node): Node[] {
  const modifiers = node.children.find((c) => c?.type === "modifiers");
  if (!modifiers) return [];
  return modifiers.namedChildren.filter(
    (c): c is Node =>
      c !== null && (c.type === "marker_annotation" || c.type === "annotation"),
  );
}

function annotationsOf(node: Node): string[] {
  return annotationNodes(node).map((a) =>
    simpleName(a.childForFieldName("name")?.text ?? ""),
  );
}

/**
 * The first line of the signature itself, skipping annotations written
 * on their own lines above it — the Python pack excludes decorators the
 * same way, so three annotation lines don't push a method over budget.
 */
function signatureLine(node: Node): number {
  for (const child of node.children) {
    if (!child) continue;
    if (child.type !== "modifiers") return lineOf(child);
    const keyword = child.children.find(
      (m) => m !== null && m.type !== "marker_annotation" && m.type !== "annotation",
    );
    if (keyword) return lineOf(keyword);
  }
  return lineOf(node);
}

/**
 * Deepest nesting of compound statements. An `else if` continues its
 * chain rather than opening a level, and an anonymous class body is its
 * own methods' business.
 */
function nestingDepth(body: Node): number {
  let max = 0;
  const stack: { node: Node; depth: number }[] = [{ node: body, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    let here = depth;
    if (COMPOUND_STATEMENTS.has(node.type) && !isElseIf(node)) {
      here = depth + 1;
      if (here > max) max = here;
    }
    for (const child of node.namedChildren) {
      if (child && child.type !== "class_body") stack.push({ node: child, depth: here });
    }
  }
  return max;
}

function isElseIf(node: Node): boolean {
  const parent = node.parent;
  return (
    node.type === "if_statement" &&
    parent?.type === "if_statement" &&
    parent.childForFieldName("alternative")?.id === node.id
  );
}

function simpleName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1) : name;
}

function lineOf(node: Node): number {
  return node.startPosition.row + 1;
}

function endLineOf(node: Node): number {
  return node.endPosition.row + 1;
}
