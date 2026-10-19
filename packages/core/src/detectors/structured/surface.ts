/**
 * The parsed surface shared by the tree-sitter packs for statically typed,
 * method-oriented languages: Java, Kotlin and Swift.
 *
 * Each pack keeps its own parsed-file type, with fields its language alone
 * has (a Java `package`, a Swift `extension`). These interfaces are the
 * subset the shared detectors read, and each pack's type satisfies them
 * structurally — so `large_function`, `swallowed_error`, `direct_date` and
 * `weak_test_signal` are written once and configured per language by a
 * {@link LanguageProfile}, rather than copied three times and left to drift.
 * Drift between twice-implemented charges is a failure this codebase has
 * already measured (`docs/dogfooding/2026-08-11-cross-pack-intrinsics.md`).
 */
import type { CrimesConfig } from "../../config.js";

export type StructuredShape = "domain" | "test_method" | "constructor";

export interface StructuredMethod {
  name: string;
  startLine: number;
  endLine: number;
  shape: StructuredShape;
  shapeEvidence: string[];
  paramCount: number;
  maxNestingDepth: number;
  className?: string;
  hasBody: boolean;
  assertionCount: number;
  expectsException: boolean;
  disabled: boolean;
  localCalls: string[];
}

export interface StructuredCatch {
  line: number;
  endLine: number;
  /** Caught types as written; empty for a catch-all (`catch { }` in Swift). */
  caughtTypes: string[];
  /** The bound name; for a Swift catch-all, the implicit `error`. */
  param: string;
  statementCount: number;
  commentText: string;
  usesParam: boolean;
  rethrows: boolean;
  logStatements: number;
  returnsFallback: boolean;
  inFinally: boolean;
  protectedText: string;
  enclosingMethod?: string;
  enclosingType?: string;
}

export interface StructuredClockRead {
  line: number;
  callee: string;
}

export interface StructuredFile {
  methods: StructuredMethod[];
  catches: StructuredCatch[];
  clockReads: StructuredClockRead[];
  types: { superclass?: string }[];
  hasSyntaxErrors: boolean;
}

/** What a shared detector needs from its context. */
export interface StructuredContext {
  file: string;
  config: CrimesConfig;
  parsed: StructuredFile;
}

export type StructuredPack = "language-java" | "language-kotlin" | "language-swift";

/**
 * Everything that differs between languages for the shared detectors.
 * Wording is per language because evidence quotes the language's own
 * vocabulary — "method" or "function", "exception" or "error".
 */
export interface LanguageProfile<P extends StructuredPack = StructuredPack> {
  pack: P;
  /** Detector id suffix: `large_function.<suffix>`. */
  suffix: string;
  label: string;
  largeFunction: {
    description: string;
    whyItMatters: string;
    /** "named private methods" — what to extract into. */
    extractInto: string;
    budgets: { test_method: number; constructor: number };
  };
  swallowedError: {
    description: string;
    whyItMatters: string;
    /** Catch types that mean "anything at all". */
    broadTypes: ReadonlySet<string>;
    /** A catch with no type clause catches everything (Swift). */
    catchAllIsBroad: boolean;
    /** Parameter names that announce an ignore on purpose. */
    deliberateParam: RegExp;
    /** "exception" or "error", for evidence and summaries. */
    failureNoun: string;
    /** Remedy text when the handler discards the failure. */
    propagateAdvice: string;
  };
  directDate: {
    description: string;
    whyItMatters: string;
    testabilityNote: string;
    fixShape: string;
    injectAdvice: string;
    /** Files whose job is to be the clock. */
    clockBoundary: RegExp;
    /** Callees that are properties, not calls (`Date.now`), shown without `()`. */
    propertyCallees?: ReadonlySet<string>;
  };
  weakTestSignal: {
    description: string;
    whyItMatters: string;
    unitNoun: string;
    countedForms: string;
    strengthenAdvice: string;
  };
}
