import type { Node } from "web-tree-sitter";
import {
  matchAssertionCall,
  matchDateCall,
  matchIoCall,
} from "./calls.js";
import { extractAssignment } from "./declarations.js";
import { getPythonParser } from "./grammar.js";
import { extractImport } from "./imports.js";
import { classifyShape, decoratorText } from "./shapes.js";
import type {
  ParsedPyClass,
  ParsedPyFile,
  ParsedPyFunction,
  ParsePyInput,
  PyAssertion,
  PyAssignment,
  PyDateCall,
  PyEnclosingFunction,
  PyImport,
  PyIoCall,
  PyFunctionKind,
} from "./types.js";
import { endLineOf, flatText, lineOf, maxNestingDepth } from "./utils.js";

export * from "./types.js";
export {
  getPythonParser,
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
  const parser = await getPythonParser();
  const tree = parser.parse(input.source);

  const result: ParsedPyFile = {
    lineCount: input.source.split("\n").length,
    functions: [],
    classes: [],
    imports: [],
    dateCalls: [],
    ioCalls: [],
    assignments: [],
    assertions: [],
    hasSyntaxErrors: false,
  };
  if (!tree) return result;

  const root = tree.rootNode;
  result.hasSyntaxErrors = root.hasError;

  // Decorators attach to the wrapping `decorated_definition`, but shape
  // classification happens on the inner definition. Stash them by node
  // id on the way past rather than walking back up the tree.
  const decoratorsByDefinition = new Map<number, string[]>();

  interface Frame {
    node: Node;
    classStack: ParsedPyClass[];
    funcStack: PyEnclosingFunction[];
  }

  const stack: Frame[] = [{ node: root, classStack: [], funcStack: [] }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const { node } = frame;
    let { classStack, funcStack } = frame;

    switch (node.type) {
      case "decorated_definition": {
        const definition = node.childForFieldName("definition");
        if (definition) {
          const decorators: string[] = [];
          for (let i = 0; i < node.namedChildCount; i += 1) {
            const child = node.namedChild(i);
            if (child && child.type === "decorator") {
              decorators.push(decoratorText(child));
            }
          }
          decoratorsByDefinition.set(definition.id, decorators);
        }
        break;
      }

      case "class_definition": {
        const cls = buildClass(node, decoratorsByDefinition.get(node.id) ?? []);
        result.classes.push(cls);
        classStack = [...classStack, cls];
        break;
      }

      case "function_definition": {
        const fn = buildFunction({
          node,
          decorators: decoratorsByDefinition.get(node.id) ?? [],
          enclosingClass: classStack[classStack.length - 1],
          filePath: input.absolutePath,
        });
        result.functions.push(fn);
        const enclosing: PyEnclosingFunction = {
          shape: fn.shape,
          startLine: fn.startLine,
          endLine: fn.endLine,
        };
        if (fn.name !== undefined) enclosing.name = fn.name;
        // Innermost first — matches the JS `SyncIoCall` contract.
        funcStack = [enclosing, ...funcStack];
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

      case "assert_statement": {
        const assertion: PyAssertion = {
          kind: "assert_statement",
          line: lineOf(node),
        };
        const fnName = funcStack[0]?.name;
        if (fnName !== undefined) assertion.functionName = fnName;
        result.assertions.push(assertion);
        break;
      }

      case "call": {
        const date = matchDateCall(node);
        if (date) result.dateCalls.push(date);

        const io = matchIoCall(node);
        if (io) result.ioCalls.push({ ...io, enclosingFunctions: funcStack });

        const assertion = matchAssertionCall(node);
        if (assertion) {
          const entry: PyAssertion = { ...assertion };
          const fnName = funcStack[0]?.name;
          if (fnName !== undefined) entry.functionName = fnName;
          result.assertions.push(entry);
        }
        break;
      }

      default:
        break;
    }

    for (let i = node.namedChildCount - 1; i >= 0; i -= 1) {
      const child = node.namedChild(i);
      if (child) stack.push({ node: child, classStack, funcStack });
    }
  }

  sortByLine(result);
  tree.delete();
  return result;
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
  return {
    name: flatText(node.childForFieldName("name")),
    startLine: lineOf(node),
    endLine: endLineOf(node),
    bases,
    decorators,
  };
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

  const { paramCount, firstParam } = readParameters(node);
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
  firstParam: string | undefined;
} {
  const params = node.childForFieldName("parameters");
  if (!params) return { paramCount: 0, firstParam: undefined };

  let count = 0;
  let firstParam: string | undefined;
  for (let i = 0; i < params.namedChildCount; i += 1) {
    const child = params.namedChild(i);
    if (!child) continue;
    if (
      child.type === "positional_separator" ||
      child.type === "keyword_separator"
    ) {
      continue;
    }
    const paramName = parameterName(child);
    if (paramName === "self" || paramName === "cls") continue;
    if (firstParam === undefined && paramName !== undefined) {
      firstParam = paramName;
    }
    count += 1;
  }
  return { paramCount: count, firstParam };
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
  const byLine = <T extends { line: number }>(a: T, b: T): number =>
    a.line - b.line;
  result.imports.sort(byLine);
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
  PyDateCall,
  PyEnclosingFunction,
  PyImport,
  PyIoCall,
};
