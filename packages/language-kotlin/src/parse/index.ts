import type { Node, Tree } from "web-tree-sitter";
import { createKotlinParser } from "./grammar.js";
import type {
  KotlinCatch,
  KotlinFunctionShape,
  KotlinImport,
  KotlinTypeKind,
  ParsedKotlinFile,
  ParsedKotlinFunction,
  ParsedKotlinType,
  ParseKotlinInput,
} from "./types.js";

export * from "./types.js";
export {
  createKotlinParser,
  ensureKotlinParser,
  KotlinGrammarNotFoundError,
  resolveKotlinGrammarPath,
} from "./grammar.js";

/** Expressions that open a nesting level for `maxNestingDepth`. */
const COMPOUND = new Set([
  "if_expression",
  "when_expression",
  "for_statement",
  "while_statement",
  "do_while_statement",
  "try_expression",
]);

const TEST_ANNOTATIONS = new Set([
  "Test",
  "ParameterizedTest",
  "RepeatedTest",
  "TestFactory",
  "TestTemplate",
]);
const DISABLED_ANNOTATIONS = new Set(["Ignore", "Disabled"]);

/**
 * JUnit / kotlin.test `assert*`, `fail`, Mockito and MockK `verify*`,
 * `expect*`, MockMvc `andExpect`, and Kotest `should*` matchers.
 */
const ASSERTION_NAME = /^(?:assert|verify|expect|should)|^(?:fail|andExpect)$/;

/**
 * Screenshot and snapshot tests assert by comparing against a recorded
 * image: Roborazzi `captureRoboImage`, project helpers such as
 * `captureMultiTheme`, Paparazzi `snapshot`, Shot `compareScreenshot`.
 * Bare `capture()` is excluded — that is Mockito's argument captor.
 */
const SCREENSHOT_NAME = /^capture[A-Z]\w*$|[Ss]creenshot|[Ss]napshot/;

/**
 * Assertion-call shapes in source text, for the fallback below. Generic
 * calls (`assertIs<Success>(x)`) are what the grammar misparses.
 */
const ASSERTION_TEXT =
  /\b(?:assert\w*|verify\w*|expect\w*|should\w*|fail|capture[A-Z]\w*)\s*(?:<[^()]*?>)?\s*[({]/;

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

/** Receivers that make a call a logging call: Android `Log`, Timber, a logger. */
const LOG_RECEIVER = /^(?:this\.)?_?(?:log|logger|Log|Timber)$/i;
const LOG_FUNCTION = /^(?:println|print)$/;

const EMPTY_FACTORY = /^(?:empty(?:List|Set|Map|Array|Sequence)|listOf|setOf|mapOf)$/;
const BLAND_LITERAL = new Set([
  "number_literal",
  "float_literal",
  "string_literal",
  "character_literal",
]);

/** Names a timer's starting reading goes by: `start`, `batchStartTime`, `t0`. */
const TIMER_NAME = /start|begin|before|^t\d$/i;

/**
 * Parse one Kotlin file into the surface detectors read. Same contract as
 * the Java pack: one cursor walk, never throws, `hasSyntaxErrors` when
 * tree-sitter had to recover.
 */
export async function parseKotlinFile(
  input: ParseKotlinInput,
): Promise<ParsedKotlinFile> {
  const parser = await createKotlinParser();
  const tree = parser.parse(input.source);
  parser.delete();
  const result: ParsedKotlinFile = {
    lineCount: input.source.split("\n").length,
    imports: [],
    types: [],
    topLevelDeclarations: [],
    methods: [],
    catches: [],
    clockReads: [],
    referencedNames: [],
    hasSyntaxErrors: false,
  };
  if (!tree) return result;
  try {
    result.hasSyntaxErrors = tree.rootNode.hasError;
    collect(tree, input.source, result);
  } finally {
    tree.delete();
  }
  result.types.sort((a, b) => a.startLine - b.startLine);
  result.methods.sort((a, b) => a.startLine - b.startLine);
  return result;
}

interface FunctionState {
  fn: ParsedKotlinFunction;
  calls: Set<string>;
  depth: number;
  /** Source range, for the assertion text fallback. */
  start: number;
  end: number;
}

interface Open {
  nodeType: string;
  type: ParsedKotlinType | undefined;
  fn: FunctionState | undefined;
  inFinally: boolean;
  counted: boolean;
}

function collect(tree: Tree, source: string, result: ParsedKotlinFile): void {
  const referenced = new Set<string>();
  const declared = new Set<string>();
  const topLevel = new Set<string>();
  const states: FunctionState[] = [];
  const open: Open[] = [];
  let type: ParsedKotlinType | undefined;
  let fn: FunctionState | undefined;
  let inFinally = false;
  const cursor = tree.walk();

  const startFunction = (built: ParsedKotlinFunction): void => {
    fn = {
      fn: built,
      calls: new Set(),
      depth: 0,
      start: cursor.startIndex,
      end: cursor.endIndex,
    };
    states.push(fn);
    result.methods.push(built);
  };

  const enter = (): boolean => {
    const nodeType = cursor.nodeType;
    const parentType = open[open.length - 1]?.nodeType;
    const entry: Open = { nodeType, type, fn, inFinally, counted: false };
    let descend = true;
    switch (nodeType) {
      case "package_header": {
        const name = cursor.currentNode.namedChildren.find(
          (c) => c?.type === "qualified_identifier" || c?.type === "identifier",
        );
        if (name) result.packageName = name.text;
        break;
      }
      case "import":
        result.imports.push(buildImport(cursor.currentNode));
        descend = false;
        break;
      case "finally_block":
        inFinally = true;
        break;
      case "class_body":
      case "enum_class_body":
      case "lambda_literal":
      case "object_literal":
        // Code in a nested body or lambda still belongs to the enclosing
        // function for assertions and calls — except a class body, whose
        // members are their own functions.
        if (nodeType !== "lambda_literal") fn = undefined;
        break;
      case "class_declaration":
      case "object_declaration": {
        const built = buildType(cursor.currentNode, type);
        if (built) {
          result.types.push(built);
          declared.add(built.name);
          type = built;
          fn = undefined;
        }
        break;
      }
      case "type_alias": {
        const name = cursor.currentNode.namedChildren.find(
          (c) => c?.type === "identifier",
        );
        if (name && type === undefined) topLevel.add(name.text);
        break;
      }
      case "property_declaration": {
        if (type === undefined && fn === undefined) {
          const decl = cursor.currentNode.namedChildren.find(
            (c) => c?.type === "variable_declaration",
          );
          const name = decl?.namedChildren.find((c) => c?.type === "identifier");
          if (name) topLevel.add(name.text);
        }
        break;
      }
      case "function_declaration": {
        const node = cursor.currentNode;
        const built = buildFunction(node, type, "function");
        if (type === undefined && fn === undefined) topLevel.add(built.name);
        startFunction(built);
        break;
      }
      case "secondary_constructor":
        startFunction(buildFunction(cursor.currentNode, type, "constructor"));
        break;
      case "anonymous_initializer":
        startFunction(buildFunction(cursor.currentNode, type, "initializer"));
        break;
      case "catch_block": {
        const caught = buildCatch(cursor.currentNode, { fn: fn?.fn, type, inFinally });
        if (caught) result.catches.push(caught);
        break;
      }
      case "call_expression":
        visitCall(cursor.currentNode, { fn, result, referenced });
        break;
      case "infix_expression": {
        const op = cursor.currentNode.namedChildren[1];
        if (fn && op?.type === "identifier" && /^should/.test(op.text)) {
          fn.fn.assertionCount += 1;
        }
        break;
      }
      case "navigation_expression": {
        const receiver = cursor.currentNode.namedChildren[0];
        if (receiver?.type === "identifier") addTypeLike(referenced, receiver.text);
        break;
      }
      case "user_type": {
        const first = cursor.currentNode.namedChildren[0];
        if (first?.type === "identifier") referenced.add(first.text);
        break;
      }
      default:
        if (fn && COMPOUND.has(nodeType)) {
          // `else if` continues its chain rather than opening a level.
          const elseIf = nodeType === "if_expression" && parentType === "if_expression";
          if (!elseIf) {
            fn.depth += 1;
            if (fn.depth > fn.fn.maxNestingDepth) fn.fn.maxNestingDepth = fn.depth;
            entry.counted = true;
          }
        }
    }
    open.push(entry);
    return descend;
  };

  const leave = (): void => {
    const entry = open.pop()!;
    if (entry.counted && fn) fn.depth -= 1;
    type = entry.type;
    fn = entry.fn;
    inFinally = entry.inFinally;
  };

  try {
    let descend = enter();
    for (;;) {
      if (descend && cursor.gotoFirstChild()) {
        descend = enter();
        continue;
      }
      leave();
      let moved = cursor.gotoNextSibling();
      while (!moved) {
        if (!cursor.gotoParent()) {
          finish();
          return;
        }
        leave();
        moved = cursor.gotoNextSibling();
      }
      descend = enter();
    }
  } finally {
    cursor.delete();
  }

  function finish(): void {
    for (const state of states) {
      state.fn.localCalls = [...state.calls];
      // tree-sitter-kotlin reads `assertIs<Success>(x)` as two
      // comparisons, so a generic assertion leaves no call node. Only when
      // the tree found nothing, look at the function's own text.
      if (state.fn.assertionCount === 0 && state.fn.hasBody) {
        const body = source.slice(state.start, state.end);
        const signatureEnd = body.indexOf(state.fn.name) + state.fn.name.length;
        if (ASSERTION_TEXT.test(body.slice(Math.max(0, signatureEnd)))) {
          state.fn.assertionCount = 1;
        }
      }
    }
    result.topLevelDeclarations = [...topLevel].sort();
    for (const name of declared) referenced.delete(name);
    for (const name of topLevel) referenced.delete(name);
    result.referencedNames = [...referenced].sort();
  }
}

function buildImport(node: Node): KotlinImport {
  let name = "";
  let wildcard = false;
  let alias: string | undefined;
  for (const child of node.children) {
    if (!child) continue;
    if (child.type === "qualified_identifier") name = child.text;
    else if (child.type === "*") wildcard = true;
    else if (child.type === "identifier") alias = child.text;
  }
  return {
    name,
    static: false,
    wildcard,
    ...(alias !== undefined ? { alias } : {}),
    line: node.startPosition.row + 1,
  };
}

function buildType(
  node: Node,
  enclosing: ParsedKotlinType | undefined,
): ParsedKotlinType | undefined {
  const name = node.childForFieldName("name")?.text;
  if (!name) return undefined;
  let kind: KotlinTypeKind = node.type === "object_declaration" ? "object" : "class";
  if (node.children.some((c) => c?.type === "interface")) kind = "interface";
  const modifiers = node.children.find((c) => c?.type === "modifiers");
  const classModifiers =
    modifiers?.namedChildren
      .filter((c) => c?.type === "class_modifier")
      .map((c) => c!.text) ?? [];
  if (classModifiers.includes("enum")) kind = "enum";
  if (classModifiers.includes("annotation")) kind = "annotation";

  const specifiers = node.namedChildren
    .find((c) => c?.type === "delegation_specifiers")
    ?.namedChildren.filter((c): c is Node => c !== null);
  const invoked = specifiers
    ?.map((s) => s.namedChildren.find((c) => c?.type === "constructor_invocation"))
    .find((c) => c !== undefined && c !== null);
  const superclass =
    invoked?.namedChildren.find((c) => c?.type === "user_type")?.text ??
    specifiers?.[0]?.namedChildren.find((c) => c?.type === "user_type")?.text;

  return {
    name,
    kind,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    annotations: annotationsOf(node),
    ...(superclass !== undefined ? { superclass } : {}),
    ...(enclosing !== undefined ? { enclosingType: enclosing.name } : {}),
  };
}

function buildFunction(
  node: Node,
  type: ParsedKotlinType | undefined,
  kind: "function" | "constructor" | "initializer",
): ParsedKotlinFunction {
  const name =
    kind === "constructor"
      ? "constructor"
      : kind === "initializer"
        ? "init"
        : (node.childForFieldName("name")?.text ?? "(anonymous)");
  const annotations = annotationsOf(node);
  const params = node.namedChildren.find((c) => c?.type === "function_value_parameters");
  const paramCount =
    params?.namedChildren.filter((p) => p?.type === "parameter").length ?? 0;
  const body = node.namedChildren.find(
    (c) => c?.type === "function_body" || c?.type === "block",
  );

  let shape: KotlinFunctionShape = "domain";
  const evidence: string[] = [];
  const test = annotations.find((a) => TEST_ANNOTATIONS.has(a));
  if (kind !== "function") {
    shape = "constructor";
    evidence.push(kind === "initializer" ? "init block" : "secondary constructor");
  } else if (test) {
    shape = "test_method";
    evidence.push(`annotated @${test}`);
  } else if (annotations.includes("Composable")) {
    shape = "ui_component";
    evidence.push("annotated @Composable");
  }
  const testAnnotation = annotationNodes(node).find((a) =>
    TEST_ANNOTATIONS.has(annotationName(a)),
  );
  const expectsException = /\bexpected\s*=/.test(testAnnotation?.text ?? "");

  return {
    name,
    kind: kind === "function" ? "function" : "constructor",
    startLine: signatureLine(node),
    endLine: node.endPosition.row + 1,
    shape,
    shapeEvidence: evidence,
    annotations,
    paramCount,
    maxNestingDepth: 0,
    ...(type !== undefined ? { className: type.name } : {}),
    hasBody: body !== undefined && body !== null,
    assertionCount: 0,
    expectsException,
    disabled: annotations.some((a) => DISABLED_ANNOTATIONS.has(a)),
    localCalls: [],
  };
}

function buildCatch(
  node: Node,
  scope: {
    fn: ParsedKotlinFunction | undefined;
    type: ParsedKotlinType | undefined;
    inFinally: boolean;
  },
): KotlinCatch | undefined {
  const body = node.namedChildren.find((c) => c?.type === "block");
  if (!body) return undefined;
  const param = node.namedChildren.find((c) => c?.type === "identifier")?.text ?? "";
  const caughtTypes = node.namedChildren
    .filter(
      (c): c is Node =>
        c !== null && (c.type === "user_type" || c.type === "nullable_type"),
    )
    .map((c) => c.text);
  const statements = body.namedChildren.filter(
    (c): c is Node =>
      c !== null && c.type !== "line_comment" && c.type !== "block_comment",
  );
  const comments = body.descendantsOfType(["line_comment", "block_comment"]);
  const usesParam =
    param !== "" && body.descendantsOfType("identifier").some((id) => id?.text === param);
  const tryBlock = node.parent?.namedChildren.find((c) => c?.type === "block");

  return {
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    caughtTypes,
    param,
    statementCount: statements.length,
    commentText: comments
      .filter((c): c is Node => c !== null)
      .map((c) => c.text)
      .join(" "),
    usesParam,
    rethrows: body.descendantsOfType("throw_expression").length > 0,
    logStatements: statements.filter(isLogStatement).length,
    returnsFallback: statements.length === 1 && isFallback(statements[0]!),
    inFinally: scope.inFinally,
    protectedText: (tryBlock?.text ?? "").slice(0, 600),
    protectedCalls: receiverCalls(tryBlock),
    ...(scope.fn !== undefined ? { enclosingMethod: scope.fn.name } : {}),
    ...(scope.type !== undefined ? { enclosingType: scope.type.name } : {}),
  };
}

function calleeOf(call: Node): { name: string; receiver?: Node } {
  const callee = call.namedChildren[0];
  if (!callee) return { name: "" };
  if (callee.type === "identifier") return { name: callee.text };
  if (callee.type === "navigation_expression") {
    const parts = callee.namedChildren.filter((c): c is Node => c !== null);
    const last = parts[parts.length - 1];
    const receiver = parts[0];
    return {
      name: last?.type === "identifier" ? last.text : "",
      ...(receiver !== undefined && parts.length > 1 ? { receiver } : {}),
    };
  }
  return { name: "" };
}

/** Receiver-qualified calls under `block`, first twenty, de-duplicated. */
function receiverCalls(block: Node | null | undefined): string[] {
  if (!block) return [];
  const out = new Set<string>();
  for (const call of block.descendantsOfType("call_expression")) {
    if (!call) continue;
    const { name, receiver } = calleeOf(call);
    if (receiver === undefined || name === "") continue;
    const text = `${receiver.text}.${name}`;
    if (text.length <= 120) out.add(text);
    if (out.size >= 20) break;
  }
  return [...out];
}

function isLogStatement(statement: Node): boolean {
  if (statement.type !== "call_expression") return false;
  const { name, receiver } = calleeOf(statement);
  if (receiver === undefined) return LOG_FUNCTION.test(name);
  if (name === "printStackTrace") return true;
  return LOG_RECEIVER.test(receiver.text);
}

function isFallback(statement: Node): boolean {
  let value: Node | null | undefined = statement;
  if (statement.type === "return_expression") {
    value = statement.namedChildren[0];
    if (!value) return true;
  }
  if (["null", "true", "false"].includes(value.text)) return true;
  if (BLAND_LITERAL.has(value.type)) return true;
  if (value.type === "call_expression") {
    const { name, receiver } = calleeOf(value);
    const args = value.namedChildren.find((c) => c?.type === "value_arguments");
    return (
      receiver === undefined &&
      EMPTY_FACTORY.test(name) &&
      (args?.namedChildCount ?? 0) === 0
    );
  }
  return false;
}

function visitCall(
  node: Node,
  ctx: {
    fn: FunctionState | undefined;
    result: ParsedKotlinFile;
    referenced: Set<string>;
  },
): void {
  const { name, receiver } = calleeOf(node);
  if (name === "") return;
  // `Film(1)` constructs; `slug()` and `x.slug()` may be same-package or
  // imported top-level and extension functions.
  ctx.referenced.add(name);
  if (ctx.fn) {
    if (ASSERTION_NAME.test(name) || SCREENSHOT_NAME.test(name)) {
      ctx.fn.fn.assertionCount += 1;
    }
    if (receiver === undefined || receiver.type === "this_expression")
      ctx.fn.calls.add(name);
  }

  const args = node.namedChildren.find((c) => c?.type === "value_arguments");
  const argList = args?.namedChildren.filter((c): c is Node => c !== null) ?? [];
  const receiverText = receiver?.text;
  let callee: string | undefined;
  if (receiverText === "System" && name === "currentTimeMillis") {
    if (isElapsedTimer(node)) return;
    callee = "System.currentTimeMillis";
  } else if (receiverText === "Clock.System" && name === "now") {
    callee = "Clock.System.now";
  } else if (
    receiverText === "Calendar" &&
    name === "getInstance" &&
    argList.length === 0
  ) {
    callee = "Calendar.getInstance";
  } else if (
    receiverText !== undefined &&
    CLOCK_TYPES.has(receiverText) &&
    name === "now" &&
    !(argList.length === 1 && /clock/i.test(argList[0]!.text))
  ) {
    callee = `${receiverText}.now`;
  } else if (
    receiver === undefined &&
    (name === "Date" || name === "GregorianCalendar") &&
    argList.length === 0
  ) {
    callee = name;
  }
  if (callee !== undefined) {
    ctx.result.clockReads.push({
      line: node.startPosition.row + 1,
      callee,
      usage: classifyUsage(node),
      ...(ctx.fn !== undefined ? { enclosingMethod: ctx.fn.fn.name } : {}),
    });
  }
}

/**
 * `val start = System.currentTimeMillis()` and `System.currentTimeMillis()
 * - start` time an operation; an age (`- lastModified`) is not matched.
 */
function isElapsedTimer(call: Node): boolean {
  const parent = call.parent;
  if (!parent) return false;
  if (parent.type === "property_declaration") {
    const decl = parent.namedChildren.find((c) => c?.type === "variable_declaration");
    return TIMER_NAME.test(decl?.text ?? "");
  }
  if (parent.type === "assignment") {
    return TIMER_NAME.test(parent.namedChildren[0]?.text ?? "");
  }
  if (
    parent.type === "binary_expression" &&
    parent.childForFieldName("operator")?.text === "-"
  ) {
    const left = parent.childForFieldName("left");
    const other = left?.id === call.id ? parent.childForFieldName("right") : left;
    return other?.type === "identifier" && TIMER_NAME.test(other.text);
  }
  return false;
}

const COMPARISON_OPERATOR = /^(?:<|<=|>|>=|==|!=|===|!==)$/;
const ARITHMETIC_OPERATOR = /^[-+*/%]$/;
const COMPARE_METHOD = /^(?:before|after|compareTo|isBefore|isAfter|isEqual|equals)$/;
const TRANSPARENT_METHOD =
  /^(?:getTime|toEpochMilli|toEpochMilliseconds|epochSeconds|getTimeInMillis|toInstant|atZone|toLocalDate|toLocalDateTime|truncatedTo|plus\w*|minus\w*|with\w*)$/;

/**
 * Compared or only recorded? The Java pack's walk, over Kotlin's nodes:
 * operators are `binary_expression`s with an `operator` field, a method on
 * the reading is a `call_expression` around a `navigation_expression`, and
 * conditions are `if_expression` / `while_statement` `condition` fields.
 */
function classifyUsage(node: Node, followBinding = true): "compared" | "value" {
  let current = node;
  let parent = node.parent;
  while (parent) {
    const advance = (): void => {
      current = parent!;
      parent = parent!.parent;
    };
    switch (parent.type) {
      case "binary_expression": {
        const op = parent.childForFieldName("operator")?.text ?? "";
        if (COMPARISON_OPERATOR.test(op)) return "compared";
        if (ARITHMETIC_OPERATOR.test(op)) {
          advance();
          continue;
        }
        return "value";
      }
      case "parenthesized_expression":
      case "unary_expression":
      case "as_expression":
        advance();
        continue;
      case "if_expression":
      case "while_statement":
      case "do_while_statement":
        return parent.childForFieldName("condition")?.id === current.id
          ? "compared"
          : "value";
      case "navigation_expression": {
        if (parent.namedChildren[0]?.id !== current.id) return "value";
        const name = parent.namedChildren[parent.namedChildCount - 1]?.text ?? "";
        if (COMPARE_METHOD.test(name)) return "compared";
        if (TRANSPARENT_METHOD.test(name)) {
          // Skip the call wrapping `now.plusDays(1)` as well.
          advance();
          if ((parent as Node | null)?.type === "call_expression") advance();
          continue;
        }
        return "value";
      }
      case "value_argument": {
        const call = parent.parent?.parent;
        const name = call?.type === "call_expression" ? calleeOf(call).name : "";
        if (COMPARE_METHOD.test(name)) return "compared";
        if (/^(?:between|max|min|maxOf|minOf)$/.test(name) && call) {
          current = call;
          parent = call.parent;
          continue;
        }
        return "value";
      }
      case "property_declaration": {
        if (!followBinding) return "value";
        const name = parent.namedChildren
          .find((c) => c?.type === "variable_declaration")
          ?.namedChildren.find((c) => c?.type === "identifier");
        return name && bindingIsCompared(name) ? "compared" : "value";
      }
      default:
        return "value";
    }
  }
  return "compared";
}

function bindingIsCompared(nameNode: Node): boolean {
  let scope = nameNode.parent;
  while (
    scope &&
    scope.type !== "function_declaration" &&
    scope.type !== "lambda_literal"
  ) {
    scope = scope.parent;
  }
  if (!scope) return true;
  for (const id of scope.descendantsOfType("identifier")) {
    if (!id || id.id === nameNode.id || id.text !== nameNode.text) continue;
    if (id.parent?.type === "variable_declaration") continue;
    if (classifyUsage(id, false) === "compared") return true;
  }
  return false;
}

/** Record a receiver that reads as a type: `Film.of`, `Status.ACTIVE`. */
function addTypeLike(into: Set<string>, name: string): void {
  if (/^[A-Z][A-Za-z0-9_]*$/.test(name) && !/^[A-Z0-9_]+$/.test(name)) into.add(name);
}

function annotationNodes(node: Node): Node[] {
  const modifiers = node.namedChildren.find((c) => c?.type === "modifiers");
  if (!modifiers) return [];
  return modifiers.namedChildren.filter((c): c is Node => c?.type === "annotation");
}

function annotationName(annotation: Node): string {
  const target =
    annotation.namedChildren.find((c) => c?.type === "constructor_invocation") ??
    annotation;
  const userType = target.namedChildren.find((c) => c?.type === "user_type");
  const ids = userType?.namedChildren.filter((c) => c?.type === "identifier") ?? [];
  return ids[ids.length - 1]?.text ?? "";
}

function annotationsOf(node: Node): string[] {
  return annotationNodes(node).map(annotationName);
}

/** First line of the signature, skipping annotations on their own lines. */
function signatureLine(node: Node): number {
  for (const child of node.children) {
    if (!child) continue;
    if (child.type !== "modifiers") return child.startPosition.row + 1;
    const keyword = child.children.find((m) => m !== null && m.type !== "annotation");
    if (keyword) return keyword.startPosition.row + 1;
  }
  return node.startPosition.row + 1;
}
