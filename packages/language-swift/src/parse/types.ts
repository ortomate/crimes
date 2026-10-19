/**
 * The parsed-file surface Swift detectors read.
 *
 * Satisfies core's structured surface like the Java and Kotlin packs, and
 * differs from them where Swift does: an `import` names a module, not a
 * type, so every type in a module is visible to every file in it. Graph
 * edges therefore come from {@link ParsedSwiftFile.referencedTypes}
 * resolved against declared types repo-wide, and an `extension Film` is a
 * reference to `Film`, never a second declaration of it.
 */

export type SwiftTypeKind =
  | "class"
  | "struct"
  | "enum"
  | "actor"
  | "protocol"
  | "extension";

export interface ParsedSwiftType {
  /** The declared name, or for an extension the extended type. */
  name: string;
  kind: SwiftTypeKind;
  startLine: number;
  endLine: number;
  attributes: string[];
  /** Inheritance clause entries as written: superclass and protocols. */
  inherits: string[];
  /** First inheritance entry, which is the superclass when there is one. */
  superclass?: string;
  enclosingType?: string;
}

/**
 * - `test_method`: an XCTest `test*` method on an `XCTestCase` subclass,
 *   or a Swift Testing `@Test` function.
 * - `ui_component`: SwiftUI — a function or computed property of type
 *   `some View`.
 */
export type SwiftFunctionShape =
  | "domain"
  | "test_method"
  | "constructor"
  | "ui_component";

export interface ParsedSwiftFunction {
  name: string;
  kind: "function" | "constructor" | "property";
  startLine: number;
  endLine: number;
  shape: SwiftFunctionShape;
  shapeEvidence: string[];
  attributes: string[];
  paramCount: number;
  maxNestingDepth: number;
  className?: string;
  hasBody: boolean;
  /** `XCTAssert*`, `XCTFail`, `XCTUnwrap`, `#expect`, `#require`, Nimble `expect`. */
  assertionCount: number;
  /** Swift has no expected-exception annotation; always false. */
  expectsException: boolean;
  /** `@Test(.disabled(...))`. */
  disabled: boolean;
  localCalls: string[];
}

export interface SwiftImport {
  module: string;
  line: number;
}

/** Same facts as the Java pack's `JavaCatch`. */
export interface SwiftCatch {
  line: number;
  endLine: number;
  /**
   * The matched type or case as written (`NetworkError`,
   * `NetworkError.timeout`); empty for a catch-all.
   */
  caughtTypes: string[];
  /** The bound name; `error` (implicit) when none is written. */
  param: string;
  statementCount: number;
  commentText: string;
  usesParam: boolean;
  rethrows: boolean;
  /** `print`, `NSLog`, `debugPrint`, `os_log`, `logger.*`, `Log.*`. */
  logStatements: number;
  /** A single `return` of `nil`, a boolean, a literal or an empty collection. */
  returnsFallback: boolean;
  /** Swift has no `finally`; always false. */
  inFinally: boolean;
  protectedText: string;
  enclosingMethod?: string;
  enclosingType?: string;
}

export interface SwiftClockRead {
  line: number;
  /** `Date` (for `Date()`), `Date.now`, `NSDate`. */
  callee: string;
  enclosingMethod?: string;
}

export interface ParsedSwiftFile {
  lineCount: number;
  imports: SwiftImport[];
  types: ParsedSwiftType[];
  /** Types this file declares (not extends): classes, structs, enums, actors, protocols, typealiases. */
  declaredTypes: string[];
  methods: ParsedSwiftFunction[];
  catches: SwiftCatch[];
  clockReads: SwiftClockRead[];
  /** Distinct capitalised type names this file mentions, own declarations excluded. Sorted. */
  referencedTypes: string[];
  hasSyntaxErrors: boolean;
}

export interface ParseSwiftInput {
  absolutePath: string;
  source: string;
}
