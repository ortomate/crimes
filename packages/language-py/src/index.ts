/**
 * `@crimes/language-py` — the Python language pack.
 *
 * Second pack after `language-js`, and the one that proves the pack seam
 * introduced in 0.12.0 is reusable rather than a JS-shaped abstraction
 * with a single implementation.
 *
 * Registration is a module-load side effect, matching the contract in
 * `CONTRIBUTING.md` §"Adding a new language": importing this package is
 * what makes `LanguagePackRouter` route `.py` / `.pyi` here, and
 * `ScanReport.coverage` picks the pack up automatically from the router.
 * There is no second extension list to keep in sync.
 */

export const PY_EXTENSIONS = [".py", ".pyi"] as const;

export { parsePyFile } from "./parse/index.js";
export {
  getPythonParser,
  resolveGrammarPath,
  resetPythonParserForTests,
  PythonGrammarNotFoundError,
} from "./parse/grammar.js";
export { BOOLEAN_INITIALIZER_KINDS } from "./parse/declarations.js";
export {
  buildPyModuleIndex,
  resolvePyImports,
  type PyImportSpecifierInput,
  type PyModuleIndex,
  type PyResolvedEdge,
} from "./imports/resolve.js";

export type {
  ParsedPyClass,
  ParsedPyFile,
  ParsedPyFunction,
  ParsePyInput,
  PyAssertion,
  PyAssignment,
  PyDateCall,
  PyEnclosingFunction,
  PyFunctionKind,
  PyFunctionShape,
  PyImport,
  PyInitializerKind,
  PyIoCall,
} from "./parse/types.js";
