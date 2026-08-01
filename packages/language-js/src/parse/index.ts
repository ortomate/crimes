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
import { collectObjectContract } from "./contracts.js";
import { collectEnvRead } from "./env.js";
import { collectErrorHandler } from "./errors.js";
import { collectFanOutSite } from "./fanout.js";
import { collectMockDeclaration, collectTestCase } from "./mocks.js";
import { collectPassThroughFunction } from "./passthrough.js";
import { collectPolicyExpression } from "./policy.js";
import { collectRetrySite } from "./retry.js";
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
  EnvRead,
  ErrorHandler,
  FanOutSite,
  FetchSite,
  JsxElementInfo,
  MockDeclaration,
  NavLiteral,
  ObjectContract,
  ParseInput,
  ParsedFile,
  ParsedFunction,
  PassThroughFunction,
  PolicyExpression,
  RetrySite,
  StringUnionType,
  SyncIoCall,
  TestCase,
  TypedDeclaration,
  UiStringLiteral,
} from "./types.js";

// Re-export every public type from the parse module so external imports
// (`import type { ParsedFile, ... } from "@crimes/language-js"`) keep
// working unchanged after the 0.7.0 split.
export type {
  AssertionCategory,
  ContractField,
  ContractSource,
  DateArithmetic,
  DateMethodCall,
  DateStringConcat,
  DateUse,
  DeclarationKind,
  EnclosingFunction,
  EnvRead,
  EnvReadVia,
  ErrorHandler,
  ErrorHandlerBody,
  ErrorHandlerKind,
  FanOutBound,
  FanOutSite,
  FanOutWork,
  FunctionKind,
  FunctionShape,
  InitializerKind,
  JsxAttributeValue,
  JsxElementInfo,
  JsxNode,
  FetchSite,
  MockDeclaration,
  MutatingCall,
  NavLiteral,
  NavLiteralEntry,
  ObjectContract,
  ParsedFile,
  ParsedFunction,
  ParseInput,
  PassThroughForwarding,
  PassThroughFunction,
  PolicyExpression,
  PolicyKind,
  RetryKind,
  RetrySafeguard,
  RetrySafeguardKind,
  RetrySite,
  StringUnionType,
  SyncIoCall,
  TestAssertion,
  TestCase,
  TypedDeclaration,
  UiStringContext,
  UiStringLiteral,
} from "./types.js";

/**
 * Test-file naming convention, duplicated from `@crimes/core`'s
 * `util/test-files.ts` on purpose: the language pack must not depend on
 * core (the dependency runs the other way), and the two collectors gated
 * by this — test cases and mock declarations — are meaningless outside a
 * test file. Over-matching here costs an empty array; under-matching
 * costs a missed detector, so the pattern is the permissive one.
 */
const TEST_SOURCE_RE = /(?:^|[/\\])(?:__tests__[/\\]|tests?[/\\])|[._](?:test|spec)\.[cm]?[jt]sx?$/;

export function parseFile(input: ParseInput): ParsedFile {
  const ext = extname(input.absolutePath).toLowerCase();
  const scriptKind = pickScriptKind(ext);
  const isTestSource = TEST_SOURCE_RE.test(input.absolutePath);
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
  const policyExpressions: PolicyExpression[] = [];
  const objectContracts: ObjectContract[] = [];
  const errorHandlers: ErrorHandler[] = [];
  const retrySites: RetrySite[] = [];
  const envReads: EnvRead[] = [];
  const fanOutSites: FanOutSite[] = [];
  const testCases: TestCase[] = [];
  const mockDeclarations: MockDeclaration[] = [];
  const passThroughFunctions: PassThroughFunction[] = [];
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
    // 0.16.0 risk surfaces. Each collector returns immediately for the
    // node kinds it doesn't care about, so the cost here is a handful of
    // predicate calls per node rather than another traversal.
    collectPolicyExpression(node, sourceFile, functions, policyExpressions);
    collectObjectContract(node, sourceFile, objectContracts);
    collectErrorHandler(node, sourceFile, functions, errorHandlers);
    collectRetrySite(node, sourceFile, functions, retrySites);
    collectEnvRead(node, sourceFile, functions, envReads);
    collectFanOutSite(node, sourceFile, functions, fanOutSites);
    collectPassThroughFunction(node, sourceFile, passThroughFunctions);
    if (isTestSource) {
      collectTestCase(node, sourceFile, testCases);
      collectMockDeclaration(node, sourceFile, mockDeclarations);
    }
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
  if (policyExpressions.length > 0) result.policyExpressions = policyExpressions;
  if (objectContracts.length > 0) result.objectContracts = objectContracts;
  if (errorHandlers.length > 0) result.errorHandlers = errorHandlers;
  if (retrySites.length > 0) result.retrySites = retrySites;
  if (envReads.length > 0) result.envReads = envReads;
  if (fanOutSites.length > 0) result.fanOutSites = fanOutSites;
  if (testCases.length > 0) result.testCases = testCases;
  if (mockDeclarations.length > 0) result.mockDeclarations = mockDeclarations;
  if (passThroughFunctions.length > 0) {
    result.passThroughFunctions = passThroughFunctions;
  }
  return result;
}
