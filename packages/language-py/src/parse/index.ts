import type { Node } from "web-tree-sitter";
import { buildCall, matchAssertionCall, matchDateCall, matchIoCall } from "./calls.js";
import { extractAssignment } from "./declarations.js";
import { ensurePythonParser } from "./grammar.js";
import { extractImport } from "./imports.js";
import { extractClassMembers, extractDocstring, routeFromDecorator } from "./routes.js";
import { classifyShape, decoratorText } from "./shapes.js";
import type {
  ParsedPyClass,
  ParsedPyFile,
  ParsedPyFunction,
  ParsePyInput,
  PyAssertion,
  PyAssignment,
  PyCall,
  PyDateCall,
  PyEnclosingFunction,
  PyImport,
  PyIoCall,
  PyFunctionKind,
} from "./types.js";
import { endLineOf, flatText, lineOf, maxNestingDepth } from "./utils.js";

export * from "./types.js";
export {
  ensurePythonParser,
  resolveGrammarPath,
  resetPythonParserForTests,
  PythonGrammarNotFoundError,
} from "./grammar.js";

/**
 * Parse one Python file into the surface detectors read.
 *
 * Single pass. Everything the eight 0.14.0 detectors need is collected
 * in one traversal that carries scope (enclosing classes, enclosing
 * functions) down the tree, so no detector ever re-walks the AST — the
 * same contract `@crimes/language-js` holds.
 *
 * Never throws on malformed input. tree-sitter recovers from syntax
 * errors locally and produces a partial tree; `hasSyntaxErrors` is set
 * so detectors can decide whether a whole-file count is trustworthy.
 */
export async function parsePyFile(input: ParsePyInput): Promise<ParsedPyFile> {
  const parser = await ensurePythonParser();
  const tree = parser.parse(input.source);

  const result = emptyParsedFile(input.source);
  if (!tree) return result;

  result.hasSyntaxErrors = tree.rootNode.hasError;
  collectWithScope(tree.rootNode, input.absolutePath, result);
  sortByLine(result);
  tree.delete();
  return result;
}

function emptyParsedFile(source: string): ParsedPyFile {
  return {
    lineCount: source.split("\n").length,
    functions: [],
    classes: [],
    imports: [],
    calls: [],
    dateCalls: [],
    ioCalls: [],
    assignments: [],
    assertions: [],
    routes: [],
    hasSyntaxErrors: false,
  };
}

/** One node plus the lexical scope it was reached through. */
interface Frame {
  node: Node;
  classStack: ParsedPyClass[];
  funcStack: PyEnclosingFunction[];
}

/**
 * Depth-first traversal carrying scope down the tree, so a call site
 * knows which functions and classes enclose it without any detector
 * having to walk back up.
 *
 * Iterative rather than recursive: an expression-heavy Python file can
 * nest deeply enough to blow the call stack, and a stack overflow here
 * would take out the whole scan rather than degrading one file.
 */
function collectWithScope(root: Node, filePath: string, result: ParsedPyFile): void {
  // Decorators attach to the wrapping `decorated_definition`, but shape
  // classification happens on the inner definition. Stash them by node
  // id on the way past rather than walking back up the tree.
  const decoratorsByDefinition = new Map<number, { texts: string[]; nodes: Node[] }>();
  const stack: Frame[] = [{ node: root, classStack: [], funcStack: [] }];

  while (stack.length > 0) {
    const { node, classStack, funcStack } = stack.pop()!;
    let childClassStack = classStack;
    let childFuncStack = funcStack;

    switch (node.type) {
      case "decorated_definition":
        recordDecorators(node, decoratorsByDefinition);
        break;

      case "class_definition": {
        const cls = buildClass(node, decoratorsByDefinition.get(node.id)?.texts ?? []);
        result.classes.push(cls);
        childClassStack = [...classStack, cls];
        break;
      }

      case "function_definition": {
        const stashed = decoratorsByDefinition.get(node.id);
        const fn = buildFunction({
          node,
          decorators: stashed?.texts ?? [],
          enclosingClass: classStack[classStack.length - 1],
          filePath,
        });
        result.functions.push(fn);
        for (const decorator of stashed?.nodes ?? []) {
          const route = routeFromDecorator(decorator, fn.name);
          if (route) result.routes.push(route);
        }
        // Innermost first — matches the JS `SyncIoCall` contract.
        childFuncStack = [toEnclosing(fn), ...funcStack];
        break;
      }

      case "import_statement":
      case "import_from_statement": {
        const imp = extractImport(node);
        if (imp) result.imports.push(imp);
        break;
      }

      case "assignment": {
        const assignment = extractAssignment(node, funcStack[0]?.name);
        if (assignment) result.assignments.push(assignment);
        break;
      }

      case "assert_statement":
        result.assertions.push(
          withFunctionName({ kind: "assert_statement", line: lineOf(node) }, funcStack),
        );
        break;

      case "call":
        recordCall(node, funcStack, result);
        break;

      default:
        break;
    }

    for (let i = node.namedChildCount - 1; i >= 0; i -= 1) {
      const child = node.namedChild(i);
      if (child) {
        stack.push({
          node: child,
          classStack: childClassStack,
          funcStack: childFuncStack,
        });
      }
    }
  }
}

function recordDecorators(
  node: Node,
  into: Map<number, { texts: string[]; nodes: Node[] }>,
): void {
  const definition = node.childForFieldName("definition");
  if (!definition) return;
  const texts: string[] = [];
  const nodes: Node[] = [];
  for (let i = 0; i < node.namedChildCount; i += 1) {
    const child = node.namedChild(i);
    if (child && child.type === "decorator") {
      texts.push(decoratorText(child));
      nodes.push(child);
    }
  }
  into.set(definition.id, { texts, nodes });
}

/**
 * A `call` node can be up to three things at once for our purposes — a
 * clock read, blocking I/O, and an assertion are all just calls — so
 * each matcher gets a look rather than the first match winning.
 *
 * The general `PyCall` is built once and handed to every matcher, so
 * the callee text and argument shape are read off the tree a single
 * time per call site.
 */
function recordCall(
  node: Node,
  funcStack: PyEnclosingFunction[],
  result: ParsedPyFile,
): void {
  const call = buildCall(node, funcStack);
  result.calls.push(call);

  const date = matchDateCall(call);
  if (date) result.dateCalls.push(date);

  const io = matchIoCall(call);
  if (io) result.ioCalls.push({ ...io, enclosingFunctions: funcStack });

  const assertion = matchAssertionCall(call);
  if (assertion) result.assertions.push(withFunctionName(assertion, funcStack));
}

function toEnclosing(fn: ParsedPyFunction): PyEnclosingFunction {
  const enclosing: PyEnclosingFunction = {
    shape: fn.shape,
    kind: fn.kind,
    startLine: fn.startLine,
    endLine: fn.endLine,
  };
  if (fn.name !== undefined) enclosing.name = fn.name;
  return enclosing;
}

function withFunctionName(
  assertion: Omit<PyAssertion, "functionName">,
  funcStack: PyEnclosingFunction[],
): PyAssertion {
  const entry: PyAssertion = { ...assertion };
  const fnName = funcStack[0]?.name;
  if (fnName !== undefined) entry.functionName = fnName;
  return entry;
}

function buildClass(node: Node, decorators: string[]): ParsedPyClass {
  const bases: string[] = [];
  const superclasses = node.childForFieldName("superclasses");
  if (superclasses) {
    for (let i = 0; i < superclasses.namedChildCount; i += 1) {
      const child = superclasses.namedChild(i);
      if (child) bases.push(flatText(child));
    }
  }
  const body = node.childForFieldName("body");
  const cls: ParsedPyClass = {
    name: flatText(node.childForFieldName("name")),
    startLine: lineOf(node),
    endLine: endLineOf(node),
    bases,
    decorators,
    members: body ? extractClassMembers(body) : [],
  };
  if (body) {
    const docstring = extractDocstring(body);
    if (docstring !== undefined) cls.docstring = docstring;
  }
  return cls;
}

function buildFunction(args: {
  node: Node;
  decorators: string[];
  enclosingClass: ParsedPyClass | undefined;
  filePath: string;
}): ParsedPyFunction {
  const { node, decorators, enclosingClass, filePath } = args;
  const nameText = flatText(node.childForFieldName("name"));
  const name = nameText.length > 0 ? nameText : undefined;

  const { paramCount, paramNames, firstParam } = readParameters(node);
  const isAsync = hasAsyncKeyword(node);
  const isMethod = enclosingClass !== undefined;
  const kind: PyFunctionKind = isMethod
    ? isAsync
      ? "async_method"
      : "method"
    : isAsync
      ? "async_function"
      : "function";

  const shapeInput: Parameters<typeof classifyShape>[0] = {
    name,
    decorators,
    firstParam,
    className: enclosingClass?.name,
    classBases: enclosingClass?.bases ?? [],
    filePath,
  };
  const { shape, evidence } = classifyShape(shapeInput);

  const body = node.childForFieldName("body");

  const fn: ParsedPyFunction = {
    name,
    kind,
    startLine: lineOf(node),
    endLine: endLineOf(node),
    shape,
    decorators,
    paramCount,
    paramNames,
    maxNestingDepth: body ? maxNestingDepth(body) : 0,
  };
  if (evidence.length > 0) fn.shapeEvidence = evidence;
  if (enclosingClass !== undefined) fn.className = enclosingClass.name;
  return fn;
}

/**
 * Count declared parameters, excluding `self` / `cls` and the bare
 * `*` / `/` markers. A method with `self` plus two arguments should
 * measure the same as a free function with two.
 */
function readParameters(node: Node): {
  paramCount: number;
  paramNames: string[];
  firstParam: string | undefined;
} {
  const params = node.childForFieldName("parameters");
  if (!params) return { paramCount: 0, paramNames: [], firstParam: undefined };

  let count = 0;
  const paramNames: string[] = [];
  let firstParam: string | undefined;
  for (let i = 0; i < params.namedChildCount; i += 1) {
    const child = params.namedChild(i);
    if (!child) continue;
    if (child.type === "positional_separator" || child.type === "keyword_separator") {
      continue;
    }
    const paramName = parameterName(child);
    if (paramName === "self" || paramName === "cls") continue;
    if (paramName !== undefined) paramNames.push(paramName);
    if (firstParam === undefined && paramName !== undefined) {
      firstParam = paramName;
    }
    count += 1;
  }
  return { paramCount: count, paramNames, firstParam };
}

function parameterName(node: Node): string | undefined {
  if (node.type === "identifier") return flatText(node);
  const named = node.childForFieldName("name");
  if (named) return flatText(named);
  // `*args` / `**kwargs` wrap the identifier without a `name` field.
  const first = node.namedChild(0);
  return first && first.type === "identifier" ? flatText(first) : undefined;
}

function hasAsyncKeyword(node: Node): boolean {
  for (let i = 0; i < node.childCount; i += 1) {
    const child = node.child(i);
    if (child && !child.isNamed && child.type === "async") return true;
  }
  return false;
}

/**
 * The traversal is depth-first but pushes siblings in reverse, so
 * collected entries can end up slightly out of source order. Detectors
 * quote line numbers into evidence, and evidence that jumps backwards
 * reads as a bug — sort once here rather than in eight detectors.
 */
function sortByLine(result: ParsedPyFile): void {
  const byLine = <T extends { line: number }>(a: T, b: T): number => a.line - b.line;
  result.imports.sort(byLine);
  result.routes.sort(byLine);
  result.calls.sort(byLine);
  result.dateCalls.sort(byLine);
  result.ioCalls.sort(byLine);
  result.assignments.sort(byLine);
  result.assertions.sort(byLine);
  result.functions.sort((a, b) => a.startLine - b.startLine);
  result.classes.sort((a, b) => a.startLine - b.startLine);
}

export type {
  ParsedPyClass,
  ParsedPyFile,
  ParsedPyFunction,
  ParsePyInput,
  PyAssertion,
  PyAssignment,
  PyCall,
  PyDateCall,
  PyEnclosingFunction,
  PyImport,
  PyIoCall,
};
