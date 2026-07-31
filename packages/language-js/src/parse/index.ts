import { extname } from "node:path";
import ts from "typescript";
import {
  collectDateArithmetic,
  collectDateMethodCall,
  collectDateStringConcat,
  collectDateUse,
} from "./dates.js";
import {
  collectFetchSite,
  collectStringUnionType,
} from "./cross-language.js";
import { collectTypedDeclaration } from "./declarations.js";
import { collectFunction } from "./functions.js";
import { collectJsxRoot } from "./jsx.js";
import { collectTopLevelNavLiterals } from "./nav.js";
import { collectSyncIoCall } from "./sync-io.js";
import { collectUiStringLiteral } from "./ui-strings.js";
import {
  countNonEmptyLines,
  extractDefaultExport,
  pickScriptKind,
} from "./utils.js";
import type {
  DateArithmetic,
  DateMethodCall,
  DateStringConcat,
  DateUse,
  FetchSite,
  JsxElementInfo,
  NavLiteral,
  ParseInput,
  ParsedFile,
  ParsedFunction,
  StringUnionType,
  SyncIoCall,
  TypedDeclaration,
  UiStringLiteral,
} from "./types.js";

// Re-export every public type from the parse module so external imports
// (`import type { ParsedFile, ... } from "@crimes/language-js"`) keep
// working unchanged after the 0.7.0 split.
export type {
  DateArithmetic,
  DateMethodCall,
  DateStringConcat,
  DateUse,
  DeclarationKind,
  EnclosingFunction,
  FunctionKind,
  FunctionShape,
  InitializerKind,
  JsxAttributeValue,
  JsxElementInfo,
  JsxNode,
  FetchSite,
  NavLiteral,
  NavLiteralEntry,
  ParsedFile,
  ParsedFunction,
  ParseInput,
  StringUnionType,
  SyncIoCall,
  TypedDeclaration,
  UiStringContext,
  UiStringLiteral,
} from "./types.js";

export function parseFile(input: ParseInput): ParsedFile {
  const ext = extname(input.absolutePath).toLowerCase();
  const scriptKind = pickScriptKind(ext);
  const sourceFile = ts.createSourceFile(
    input.absolutePath,
    input.source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKind,
  );

  const functions: ParsedFunction[] = [];
  const dateUses: DateUse[] = [];
  const dateMethodCalls: DateMethodCall[] = [];
  const dateArithmetic: DateArithmetic[] = [];
  const dateStringConcats: DateStringConcat[] = [];
  const typedDeclarations: TypedDeclaration[] = [];
  const syncIoCalls: SyncIoCall[] = [];
  const navLiterals: NavLiteral[] = [];
  const uiStringLiterals: UiStringLiteral[] = [];
  const jsxElements: JsxElementInfo[] = [];
  const fetchSites: FetchSite[] = [];
  const stringUnionTypes: StringUnionType[] = [];
  let defaultExport: string | undefined;

  const visit = (node: ts.Node): void => {
    // `collectFunction` runs first so the function-like nodes we visit
    // are recorded before any nested calls are inspected — the sync-I/O
    // collector walks the partially-populated `functions[]` to build
    // its enclosing-chain, and depth-first traversal guarantees that
    // every ancestor function has been pushed by the time its child
    // calls are visited.
    collectFunction(node, sourceFile, functions, input.absolutePath);
    collectDateUse(node, sourceFile, dateUses);
    collectDateMethodCall(node, sourceFile, dateMethodCalls);
    collectDateArithmetic(node, sourceFile, dateArithmetic);
    collectDateStringConcat(node, sourceFile, dateStringConcats);
    collectTypedDeclaration(node, sourceFile, typedDeclarations);
    collectSyncIoCall(node, sourceFile, functions, syncIoCalls);
    collectUiStringLiteral(node, sourceFile, uiStringLiterals);
    collectJsxRoot(node, sourceFile, input.source, jsxElements);
    collectFetchSite(node, sourceFile, fetchSites);
    collectStringUnionType(node, sourceFile, stringUnionTypes);
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, (node) => {
    defaultExport = defaultExport ?? extractDefaultExport(node);
    collectTopLevelNavLiterals(node, sourceFile, navLiterals);
    visit(node);
  });

  const result: ParsedFile = {
    lineCount: countNonEmptyLines(input.source),
    functions,
    dateNowOrNewDateUses: dateUses,
    defaultExport,
    navLiterals,
    uiStringLiterals,
  };
  if (jsxElements.length > 0) result.jsxElements = jsxElements;
  if (dateMethodCalls.length > 0) result.dateMethodCalls = dateMethodCalls;
  if (dateArithmetic.length > 0) result.dateArithmetic = dateArithmetic;
  if (dateStringConcats.length > 0) result.dateStringConcats = dateStringConcats;
  if (typedDeclarations.length > 0) result.typedDeclarations = typedDeclarations;
  if (syncIoCalls.length > 0) result.syncIoCalls = syncIoCalls;
  if (fetchSites.length > 0) result.fetchSites = fetchSites;
  if (stringUnionTypes.length > 0) result.stringUnionTypes = stringUnionTypes;
  return result;
}
