/**
 * The parsed-file surface Java detectors read.
 *
 * Mirrors `@crimes/language-py` where the languages agree and diverges
 * where Java differs: annotations drive shape, a file declares a package,
 * and a class refers to another class in its own package without any
 * import at all. That last difference is why {@link ParsedJavaFile.referencedTypes}
 * exists — without it the import graph would miss most of a Java repo's
 * edges.
 */

export type JavaTypeKind = "class" | "interface" | "enum" | "record" | "annotation";

export interface ParsedJavaType {
  name: string;
  kind: JavaTypeKind;
  /** 1-based inclusive line range. */
  startLine: number;
  endLine: number;
  /** Annotation names as written, without `@` or arguments. */
  annotations: string[];
  /** `extends` clause as written, e.g. `"BaseEntity<Film>"`. */
  superclass?: string;
  /** Simple name of the enclosing type for a nested declaration. */
  enclosingType?: string;
}

/**
 * Coarse shape of a method, used by `large_function.java` to pick a
 * size budget.
 *
 * - **`domain`** — any other method. The default bucket.
 * - **`test_method`** — annotated `@Test`, `@ParameterizedTest`,
 *   `@RepeatedTest`, `@TestFactory` or `@TestTemplate`, or a JUnit 3
 *   `test*` method on a class extending `TestCase`. Long tests are not a
 *   smell.
 * - **`constructor`** — a constructor. Field wiring is conventionally
 *   long and flat.
 */
export type JavaMethodShape = "domain" | "test_method" | "constructor";

export interface ParsedJavaMethod {
  name: string;
  kind: "method" | "constructor";
  /** 1-based inclusive line range, annotations excluded. */
  startLine: number;
  endLine: number;
  shape: JavaMethodShape;
  /** Why the shape was picked, quoted into evidence. */
  shapeEvidence: string[];
  annotations: string[];
  paramCount: number;
  /** Deepest nesting of compound statements inside the body. */
  maxNestingDepth: number;
  /** Simple name of the enclosing type. */
  className?: string;
  /** False for an abstract or interface method with no body. */
  hasBody: boolean;
  /**
   * Assertion-shaped calls inside the body: `assert*`, `fail`, `verify*`,
   * `expect*`, `andExpect`, and the `assert` statement.
   */
  assertionCount: number;
  /**
   * `@Test(expected = …)` / `@Test(expectedExceptions = …)`: the
   * annotation is the assertion.
   */
  expectsException: boolean;
  /** `@Disabled` / `@Ignore`: the runner never executes it. */
  disabled: boolean;
  /**
   * Methods called with no receiver or with `this.`, in source order,
   * de-duplicated. Lets a detector follow a test into a same-class
   * helper without re-walking the tree.
   */
  localCalls: string[];
}

/** One `import` declaration. */
export interface JavaImport {
  /** Dotted name as written, without `.*`, e.g. `"com.acme.om.Film"`. */
  name: string;
  static: boolean;
  /** True for `import a.b.*;`. */
  wildcard: boolean;
  line: number;
}

/**
 * One `catch` clause, with what its body does with the failure.
 *
 * Classified by detectors, not here: the parser reports facts (statement
 * count, whether the parameter is read, which calls are logging-shaped)
 * and `swallowed_error.java` decides what they mean.
 */
export interface JavaCatch {
  line: number;
  endLine: number;
  /** Caught types as written; several for a multi-catch. */
  caughtTypes: string[];
  /** The catch parameter's name. */
  param: string;
  /** Named statements in the body, comments excluded. */
  statementCount: number;
  /** Text of any comments inside the body, joined. */
  commentText: string;
  /** The parameter is read anywhere in the body. */
  usesParam: boolean;
  /** The body contains a `throw`. */
  rethrows: boolean;
  /**
   * How many top-level body statements are logging calls
   * (`log.*`, `logger.*`, `System.out|err.*`, `printStackTrace`).
   */
  logStatements: number;
  /**
   * The body is a single `return` of a bland value: `null`, a boolean,
   * a numeric or string literal, or an empty collection factory.
   */
  returnsFallback: boolean;
  /** The clause sits inside a `finally` block: a cleanup path. */
  inFinally: boolean;
  /** Source text of the protected `try` block, for boundary matching. */
  protectedText: string;
  enclosingMethod?: string;
  enclosingType?: string;
}

/**
 * One read of the wall clock.
 *
 * `System.nanoTime()` is deliberately absent: it measures elapsed time
 * and cannot tell anyone the date.
 */
export interface JavaClockRead {
  line: number;
  /** As written: `"System.currentTimeMillis"`, `"Instant.now"`, `"new Date"`. */
  callee: string;
  enclosingMethod?: string;
}

export interface ParsedJavaFile {
  lineCount: number;
  /** Dotted package name, or `undefined` for the default package. */
  packageName?: string;
  imports: JavaImport[];
  types: ParsedJavaType[];
  methods: ParsedJavaMethod[];
  catches: JavaCatch[];
  clockReads: JavaClockRead[];
  /**
   * Distinct simple type names this file mentions — in declarations,
   * `new`, generics, casts, and as the receiver of a static call or
   * field read (`Film.of(…)`, `Status.ACTIVE`). Sorted.
   */
  referencedTypes: string[];
  /** Set when tree-sitter recovered from a syntax error. */
  hasSyntaxErrors: boolean;
}

export interface ParseJavaInput {
  absolutePath: string;
  source: string;
}
