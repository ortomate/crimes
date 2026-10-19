import type { Node, Tree } from "web-tree-sitter";
import { createSwiftParser } from "./grammar.js";
import type {
  ParsedSwiftFile,
  ParsedSwiftFunction,
  ParsedSwiftType,
  ParseSwiftInput,
  SwiftCatch,
  SwiftFunctionShape,
  SwiftTypeKind,
} from "./types.js";

export * from "./types.js";
export {
  createSwiftParser,
  ensureSwiftParser,
  resolveSwiftGrammarPath,
  SwiftGrammarNotFoundError,
} from "./grammar.js";

const COMPOUND = new Set([
  "if_statement",
  "guard_statement",
  "switch_statement",
  "for_statement",
  "while_statement",
  "repeat_while_statement",
  "do_statement",
]);

const DECLARATION_KINDS = new Set<SwiftTypeKind>([
  "class",
  "struct",
  "enum",
  "actor",
  "extension",
]);

/** XCTest, Swift Testing (`#expect` / `#require` are macros) and Nimble. */
const ASSERTION_CALL =
  /^(?:XCTAssert\w*|XCTFail|XCTUnwrap|XCTExpectFailure|expect|assertSnapshot\w*)$/;
const ASSERTION_MACRO = /^(?:expect|require)$/;

const LOG_FUNCTION = /^(?:print|debugPrint|NSLog|os_log|dump)$/;
const LOG_RECEIVER = /^(?:self\.)?(?:log|logger|Log|Logger|os_log)$/i;

/** Names a timer's starting reading goes by. */
const TIMER_NAME = /start|begin|before|^t\d$/i;

export async function parseSwiftFile(input: ParseSwiftInput): Promise<ParsedSwiftFile> {
  const parser = await createSwiftParser();
  const tree = parser.parse(input.source);
  parser.delete();
  const result: ParsedSwiftFile = {
    lineCount: input.source.split("\n").length,
    imports: [],
    types: [],
    declaredTypes: [],
    methods: [],
    catches: [],
    clockReads: [],
    referencedTypes: [],
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
  fn: ParsedSwiftFunction;
  calls: Set<string>;
  depth: number;
}

interface Open {
  nodeType: string;
  type: ParsedSwiftType | undefined;
  fn: FunctionState | undefined;
  counted: boolean;
}

function collect(tree: Tree, source: string, result: ParsedSwiftFile): void {
  const referenced = new Set<string>();
  const declared = new Set<string>();
  const states: FunctionState[] = [];
  const open: Open[] = [];
  let type: ParsedSwiftType | undefined;
  let fn: FunctionState | undefined;
  const cursor = tree.walk();

  const startFunction = (built: ParsedSwiftFunction): void => {
    fn = { fn: built, calls: new Set(), depth: 0 };
    states.push(fn);
    result.methods.push(built);
  };

  const enter = (): boolean => {
    const nodeType = cursor.nodeType;
    const fieldName = cursor.currentFieldName;
    const parentType = open[open.length - 1]?.nodeType;
    const entry: Open = { nodeType, type, fn, counted: false };
    let descend = true;
    switch (nodeType) {
      case "import_declaration": {
        const node = cursor.currentNode;
        result.imports.push({
          module: node.namedChildren[0]?.text ?? "",
          line: node.startPosition.row + 1,
        });
        descend = false;
        break;
      }
      case "class_declaration":
      case "protocol_declaration": {
        const built = buildType(cursor.currentNode, type);
        if (built) {
          result.types.push(built);
          if (built.kind === "extension") referenced.add(built.name);
          else declared.add(built.name);
          type = built;
          fn = undefined;
        }
        break;
      }
      case "typealias_declaration": {
        const name = cursor.currentNode.childForFieldName("name");
        if (name?.type === "type_identifier") declared.add(name.text);
        break;
      }
      case "class_body":
      case "protocol_body":
      case "enum_class_body":
        fn = undefined;
        break;
      case "function_declaration":
      case "protocol_function_declaration":
        startFunction(buildFunction(cursor.currentNode, type, "function"));
        break;
      case "init_declaration":
      case "deinit_declaration":
        startFunction(buildFunction(cursor.currentNode, type, "constructor"));
        break;
      case "property_declaration": {
        // A SwiftUI `var body: some View { … }` is where a view's code is.
        const node = cursor.currentNode;
        if (node.childForFieldName("computed_value") && returnsSomeView(node)) {
          startFunction(buildFunction(node, type, "property"));
        }
        break;
      }
      case "catch_block": {
        const caught = buildCatch(cursor.currentNode, { fn: fn?.fn, type });
        if (caught) result.catches.push(caught);
        break;
      }
      case "call_expression":
        visitCall(cursor.currentNode, {
          fn,
          result,
          referenced,
          isDefaultValue: fieldName === "default_value",
        });
        break;
      case "macro_invocation": {
        const name = cursor.currentNode.namedChildren[0]?.text ?? "";
        if (fn && ASSERTION_MACRO.test(name)) fn.fn.assertionCount += 1;
        break;
      }
      case "navigation_expression": {
        const node = cursor.currentNode;
        const target = node.childForFieldName("target");
        if (target?.type === "simple_identifier") addTypeLike(referenced, target.text);
        // `Date.now` read as a property, outside any call.
        const suffix = node.childForFieldName("suffix")?.text;
        if (
          target?.text === "Date" &&
          suffix === ".now" &&
          parentType !== "call_expression"
        ) {
          result.clockReads.push({
            line: node.startPosition.row + 1,
            callee: "Date.now",
            ...(fn !== undefined ? { enclosingMethod: fn.fn.name } : {}),
          });
        }
        break;
      }
      case "type_identifier":
        referenced.add(source.slice(cursor.startIndex, cursor.endIndex));
        break;
      default:
        if (fn && COMPOUND.has(nodeType)) {
          const elseIf = nodeType === "if_statement" && parentType === "if_statement";
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
    for (const state of states) state.fn.localCalls = [...state.calls];
    result.declaredTypes = [...declared].sort();
    for (const name of declared) referenced.delete(name);
    result.referencedTypes = [...referenced].filter((n) => /^[A-Z]/.test(n)).sort();
  }
}

function buildType(
  node: Node,
  enclosing: ParsedSwiftType | undefined,
): ParsedSwiftType | undefined {
  const kindText =
    node.type === "protocol_declaration"
      ? "protocol"
      : (node.childForFieldName("declaration_kind")?.text ?? "class");
  const kind = (
    DECLARATION_KINDS.has(kindText as SwiftTypeKind) || kindText === "protocol"
      ? kindText
      : "class"
  ) as SwiftTypeKind;
  const nameNode = node.childForFieldName("name");
  // An extension's name is a `user_type`, possibly generic or qualified.
  const name = (
    nameNode?.type === "user_type"
      ? (nameNode.namedChildren[0]?.text ?? nameNode.text)
      : (nameNode?.text ?? "")
  ).replace(/<.*$/, "");
  if (!name) return undefined;
  const inherits = node.namedChildren
    .filter((c): c is Node => c?.type === "inheritance_specifier")
    .map((c) => c.text);
  return {
    name,
    kind,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    attributes: attributesOf(node),
    inherits,
    ...(inherits[0] !== undefined ? { superclass: inherits[0] } : {}),
    ...(enclosing !== undefined ? { enclosingType: enclosing.name } : {}),
  };
}

function buildFunction(
  node: Node,
  type: ParsedSwiftType | undefined,
  kind: "function" | "constructor" | "property",
): ParsedSwiftFunction {
  const attributes = attributesOf(node);
  let name: string;
  if (kind === "constructor")
    name = node.type === "deinit_declaration" ? "deinit" : "init";
  else if (kind === "property") {
    name = node.childForFieldName("name")?.text ?? "body";
  } else name = node.childForFieldName("name")?.text ?? "(anonymous)";
  const paramCount = node.namedChildren.filter((c) => c?.type === "parameter").length;
  const body =
    kind === "property"
      ? node.childForFieldName("computed_value")
      : node.childForFieldName("body");

  let shape: SwiftFunctionShape = "domain";
  const evidence: string[] = [];
  const testCase = type?.inherits.some((i) => /\bXCTestCase\b/.test(i)) ?? false;
  if (kind === "constructor") {
    shape = "constructor";
    evidence.push(name);
  } else if (attributes.includes("Test")) {
    shape = "test_method";
    evidence.push("annotated @Test");
  } else if (kind === "function" && testCase && /^test/.test(name)) {
    shape = "test_method";
    evidence.push("XCTest `test*` method on an XCTestCase subclass");
  } else if (kind === "property" || returnsSomeView(node)) {
    shape = "ui_component";
    evidence.push("returns `some View`");
  }
  const disabled = /@Test\s*\([^)]*\.disabled/.test(node.text.slice(0, 300));

  return {
    name,
    kind,
    startLine: signatureLine(node),
    endLine: node.endPosition.row + 1,
    shape,
    shapeEvidence: evidence,
    attributes,
    paramCount,
    maxNestingDepth: 0,
    ...(type !== undefined ? { className: type.name } : {}),
    hasBody: body !== null && body !== undefined,
    assertionCount: 0,
    expectsException: false,
    disabled,
    localCalls: [],
  };
}

function returnsSomeView(node: Node): boolean {
  for (const child of node.namedChildren) {
    if (!child) continue;
    if (child.type === "opaque_type" && /\bView\b/.test(child.text)) return true;
    if (child.type === "type_annotation" && /^:\s*some\s+View\b/.test(child.text))
      return true;
  }
  return false;
}

function buildCatch(
  node: Node,
  scope: { fn: ParsedSwiftFunction | undefined; type: ParsedSwiftType | undefined },
): SwiftCatch | undefined {
  const pattern = node.childForFieldName("error");
  const body = node.namedChildren.find((c) => c?.type === "statements");
  let param = "error";
  const caughtTypes: string[] = [];
  if (pattern) {
    const bound = /^let\s+(\w+)/.exec(pattern.text);
    if (bound) param = bound[1]!;
    // `let e as NetworkError` and `is CancellationError` name a type;
    // `NetworkError.timeout` a case.
    const asType = /\b(?:as|is)\s+([\w.]+)/.exec(pattern.text);
    if (asType) caughtTypes.push(asType[1]!);
    else if (!/^let\s+\w+$/.test(pattern.text.trim()))
      caughtTypes.push(pattern.text.trim());
  }
  const statements =
    body?.namedChildren.filter(
      (c): c is Node =>
        c !== null && c.type !== "comment" && c.type !== "multiline_comment",
    ) ?? [];
  const comments = node.descendantsOfType(["comment", "multiline_comment"]);
  const usesParam =
    body?.descendantsOfType("simple_identifier").some((id) => id?.text === param) ??
    false;
  // Interpolation reads the error too: `"failed: \(error)"`.
  const interpolates = body
    ? new RegExp(`\\\\\\(\\s*${param}\\b`).test(body.text)
    : false;
  const doBlock = node.parent?.namedChildren.find((c) => c?.type === "statements");

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
    usesParam: usesParam || interpolates,
    rethrows: (body?.descendantsOfType("throw_keyword").length ?? 0) > 0,
    logStatements: statements.filter(isLogStatement).length,
    returnsFallback: statements.length === 1 && isFallbackReturn(statements[0]!),
    inFinally: false,
    protectedText: (doBlock?.text ?? "").slice(0, 600),
    protectedCalls: receiverCalls(doBlock),
    ...(scope.fn !== undefined ? { enclosingMethod: scope.fn.name } : {}),
    ...(scope.type !== undefined ? { enclosingType: scope.type.name } : {}),
  };
}

function calleeOf(call: Node): { name: string; receiver?: Node } {
  const callee = call.namedChildren[0];
  if (!callee) return { name: "" };
  if (callee.type === "simple_identifier") return { name: callee.text };
  if (callee.type === "navigation_expression") {
    const target = callee.childForFieldName("target");
    const suffix = callee.childForFieldName("suffix")?.text.replace(/^\./, "") ?? "";
    return { name: suffix, ...(target ? { receiver: target } : {}) };
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
    if (receiver === undefined || name === "" || receiver.type === "self_expression")
      continue;
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
  return LOG_RECEIVER.test(receiver.text);
}

function isFallbackReturn(statement: Node): boolean {
  if (statement.type !== "control_transfer_statement") return false;
  if (statement.children[0]?.type !== "return") return false;
  const value = statement.childForFieldName("result");
  if (!value) return true;
  return /^(?:nil|true|false|\[\]|\[:\]|""|-?\d+(?:\.\d+)?)$/.test(value.text.trim());
}

function visitCall(
  node: Node,
  ctx: {
    fn: FunctionState | undefined;
    result: ParsedSwiftFile;
    referenced: Set<string>;
    isDefaultValue: boolean;
  },
): void {
  const { name, receiver } = calleeOf(node);
  if (name === "") return;
  if (receiver === undefined) addTypeLike(ctx.referenced, name);
  if (ctx.fn) {
    if (receiver === undefined && ASSERTION_CALL.test(name))
      ctx.fn.fn.assertionCount += 1;
    if (receiver === undefined || receiver.type === "self_expression")
      ctx.fn.calls.add(name);
  }

  const args = node.namedChildren
    .find((c) => c?.type === "call_suffix")
    ?.namedChildren.find((c) => c?.type === "value_arguments");
  const argCount =
    args?.namedChildren.filter((c) => c?.type === "value_argument").length ?? 0;
  if (receiver !== undefined || argCount !== 0) return;
  if (name !== "Date" && name !== "NSDate") return;
  // `func f(now: Date = Date())` is the injection point, not a read.
  if (ctx.isDefaultValue) return;
  if (isTimerStart(node)) return;
  ctx.result.clockReads.push({
    line: node.startPosition.row + 1,
    callee: name,
    ...(ctx.fn !== undefined ? { enclosingMethod: ctx.fn.fn.name } : {}),
  });
}

/** `let start = Date()` starts a stopwatch; it does not depend on the date. */
function isTimerStart(call: Node): boolean {
  const parent = call.parent;
  if (parent?.type !== "property_declaration") return false;
  return TIMER_NAME.test(parent.childForFieldName("name")?.text ?? "");
}

/** A capitalised identifier reads as a type: `Film(...)`, `Film.shared`. */
function addTypeLike(into: Set<string>, name: string): void {
  if (/^[A-Z][A-Za-z0-9_]*$/.test(name) && !/^[A-Z0-9_]+$/.test(name)) into.add(name);
}

function attributesOf(node: Node): string[] {
  const modifiers = node.namedChildren.find((c) => c?.type === "modifiers");
  if (!modifiers) return [];
  return modifiers.namedChildren
    .filter((c): c is Node => c?.type === "attribute")
    .map((a) => a.namedChildren.find((c) => c?.type === "user_type")?.text ?? "")
    .filter((a) => a !== "");
}

/** First line of the signature, skipping attributes on their own lines. */
function signatureLine(node: Node): number {
  for (const child of node.children) {
    if (!child) continue;
    if (child.type !== "modifiers") return child.startPosition.row + 1;
    const keyword = child.children.find((m) => m !== null && m.type !== "attribute");
    if (keyword) return keyword.startPosition.row + 1;
  }
  return node.startPosition.row + 1;
}
