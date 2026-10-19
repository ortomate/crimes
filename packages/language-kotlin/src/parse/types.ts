/**
 * The parsed-file surface Kotlin detectors read.
 *
 * Shaped like `@crimes/language-java`'s on purpose: both satisfy the
 * structured surface core's shared detectors read, and both feed the one
 * JVM type resolver, because Kotlin and Java share packages and call each
 * other freely. What Kotlin adds is declarations outside any class —
 * top-level and extension functions, properties and type aliases — which
 * a same-package file uses without an import.
 */

export type KotlinTypeKind = "class" | "interface" | "enum" | "object" | "annotation";

export interface ParsedKotlinType {
  name: string;
  kind: KotlinTypeKind;
  startLine: number;
  endLine: number;
  annotations: string[];
  /** The constructor-invoked supertype (`: Base()`), else the first one listed. */
  superclass?: string;
  enclosingType?: string;
}

/** See `@crimes/language-java`'s `JavaMethodShape`. */
/** `ui_component`: a Jetpack Compose `@Composable` function. */
export type KotlinFunctionShape =
  | "domain"
  | "test_method"
  | "constructor"
  | "ui_component";

export interface ParsedKotlinFunction {
  name: string;
  kind: "function" | "constructor";
  /** 1-based inclusive line range, annotations excluded. */
  startLine: number;
  endLine: number;
  shape: KotlinFunctionShape;
  shapeEvidence: string[];
  annotations: string[];
  paramCount: number;
  maxNestingDepth: number;
  className?: string;
  hasBody: boolean;
  /**
   * Assertion-shaped calls: `assert*`, `fail`, `verify*` (Mockito and
   * MockK), `expect*`, `check*` is deliberately absent (a precondition),
   * and Kotest's `should*` matchers, infix or called.
   */
  assertionCount: number;
  /** `@Test(expected = X::class)`. */
  expectsException: boolean;
  /** `@Ignore` / `@Disabled`. */
  disabled: boolean;
  /** No-receiver and `this.` calls, in source order, de-duplicated. */
  localCalls: string[];
}

export interface KotlinImport {
  /** Dotted name as written, without `.*` or the alias. */
  name: string;
  /** Kotlin has no `import static`; members import like types. */
  static: false;
  wildcard: boolean;
  alias?: string;
  line: number;
}

/** Same facts as `@crimes/language-java`'s `JavaCatch`. */
export interface KotlinCatch {
  line: number;
  endLine: number;
  caughtTypes: string[];
  param: string;
  statementCount: number;
  commentText: string;
  usesParam: boolean;
  rethrows: boolean;
  /** `Log.*`, `Timber.*`, `log`/`logger`, `println`. */
  logStatements: number;
  /**
   * A single bland value — `return null`, or (try as an expression) a
   * bare `null`, boolean, literal or `emptyList()`-style factory.
   */
  returnsFallback: boolean;
  inFinally: boolean;
  protectedText: string;
  /** Receiver-qualified calls in the protected block (`repository.save`). */
  protectedCalls: string[];
  enclosingMethod?: string;
  enclosingType?: string;
}

export interface KotlinClockRead {
  line: number;
  callee: string;
  /** `compared` decides a branch or comparison; `value` is recorded or rendered. */
  usage: "compared" | "value";
  enclosingMethod?: string;
}

export interface ParsedKotlinFile {
  lineCount: number;
  packageName?: string;
  imports: KotlinImport[];
  types: ParsedKotlinType[];
  /**
   * Names declared outside any type: functions (extension or not),
   * properties and type aliases. Resolvable from the same package without
   * an import, and importable by name.
   */
  topLevelDeclarations: string[];
  methods: ParsedKotlinFunction[];
  catches: KotlinCatch[];
  clockReads: KotlinClockRead[];
  /**
   * Distinct names this file may resolve elsewhere: types, the receiver
   * of a call or property read (`Film.of`, `Instant.now`), and called
   * function names (for top-level and extension functions). Sorted.
   */
  referencedNames: string[];
  hasSyntaxErrors: boolean;
}

export interface ParseKotlinInput {
  absolutePath: string;
  source: string;
}
