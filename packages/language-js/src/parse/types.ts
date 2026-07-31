export type FunctionKind =
  | "function"
  | "arrow"
  | "method"
  | "function_expression"
  | "constructor";

/**
 * Coarse semantic shape of a function, used by `largeFunctionDetector` to
 * pick a size threshold appropriate to the shape:
 *
 * - **`domain`** — a plain named function/method/arrow. Uses the
 *   configured `thresholds.largeFunctionLines` (default 60). The
 *   historical and most aggressive bucket.
 * - **`test_callback`** — a function passed as an argument to a known
 *   test-framework call (`describe`, `it`, `beforeAll`, …). High
 *   threshold + low severity at threshold — 60-line test blocks are
 *   not a smell.
 * - **`react_component`** — a PascalCase function whose body contains
 *   JSX. High threshold; UI rendering doesn't compress like domain
 *   logic.
 * - **`page_export`** — the default export of a route file
 *   (Next.js Pages or App Router page / layout / template / default).
 *   High threshold; conventional surface area.
 * - **`route_handler`** — a named export with an HTTP-verb name
 *   (`GET`, `POST`, …) under an App Router route directory, or the
 *   default export under `pages/api/**` (Pages Router API). Medium
 *   threshold (100).
 * - **`cli_command_registrar`** — a Commander.js builder DSL function:
 *   either the outer `registerXCommand(program)` wrapper whose body is
 *   a `program.command(…).description(…).option(…).action(…)` chain,
 *   or the anonymous arrow / function passed to `.action(…)` on that
 *   chain. High threshold, low severity at threshold — the chain is
 *   declarative registration, not branching logic.
 * - **`unknown`** — an anonymous function/arrow that didn't match any
 *   of the above. Sits at a slightly relaxed threshold (80) so real
 *   god-functions hiding inside callbacks still surface.
 */
export type FunctionShape =
  | "domain"
  | "test_callback"
  | "react_component"
  | "page_export"
  | "route_handler"
  | "cli_command_registrar"
  | "unknown";

export interface ParsedFunction {
  name: string | undefined;
  kind: FunctionKind;
  startLine: number;
  endLine: number;
  /**
   * Coarse semantic classification — see {@link FunctionShape}.
   * Detectors consume this to pick a size threshold appropriate to
   * the shape; agents reading the JSON consume the resulting
   * `Finding.evidence` line that names the shape.
   */
  shape: FunctionShape;
  /**
   * Short, machine-friendly evidence strings explaining *why* the
   * shape was picked (e.g. `"argument of describe(...)"`,
   * `"default export under app/billing/page.tsx"`). Detectors quote
   * these verbatim into `Finding.evidence`.
   */
  shapeEvidence?: string[];
}

export interface DateUse {
  /** `Date.now()` or `new Date(...)` */
  kind: "now" | "new";
  line: number;
  /**
   * Shape of the single argument to `new Date(...)`, when present. Used
   * by `timezone_unsafe_parse` to flag locally-parsed date strings.
   * Absent for `Date.now()` and for `new Date()` with no args.
   *
   * - `none`: zero arguments (current time).
   * - `string-literal`: a `"…"` or `'…'` literal — `argValue` is the
   *   literal text. Template literals with no substitutions also land
   *   here (their text is statically known).
   * - `number`: a numeric epoch.
   * - `expression`: anything else (identifier, call, computed
   *   expression). `argValue` is undefined.
   */
  argKind?: "none" | "string-literal" | "number" | "expression";
  argValue?: string;
}

/**
 * One invocation of a `Date.prototype` method (`getUTCHours`,
 * `toLocaleDateString`, etc.). Collected verbatim — the parser does
 * not verify that the receiver is actually a Date; detectors apply
 * additional heuristics or type info to reduce false positives.
 *
 * Method coverage: every `get*` / `set*` / `to{UTC,Date,Time,Locale*}`
 * method on `Date`. `toString` is intentionally omitted because it
 * appears on every JS object and would dominate the collected set.
 * `valueOf`, `getTime`, `toJSON` are omitted because they're not
 * involved in any 0.8.0 detector.
 */
export interface DateMethodCall {
  /** Receiver identifier as written, e.g. `"d"` in `d.getHours()`. */
  receiver: string;
  /** Method name, e.g. `"getUTCHours"`, `"toLocaleDateString"`. */
  method: string;
  /** Whether the method belongs to the UTC family. */
  family: "utc" | "local";
  /** 1-based line where the call site begins. */
  line: number;
  /** Number of arguments passed (for locale-arg-presence checks). */
  argCount: number;
}

/**
 * One `+` or `-` binary expression whose numeric operand matches a
 * known day-level constant (or a fold of one, e.g.
 * `24 * 60 * 60 * 1000`). Smaller granularities (minute, hour) are
 * excluded — the DST-naive concern only kicks in at day-level math.
 */
export interface DateArithmetic {
  kind: "add" | "subtract";
  /** 1-based line of the binary expression. */
  line: number;
  /** Numeric operand value in milliseconds. */
  operand: number;
  /** Plain-English unit label for evidence strings. */
  unit: "day" | "week" | "month_approx" | "year_approx";
}

/**
 * One `string + dateMethodCall()` (or vice versa) binary expression —
 * the manual-date-formatting smell. The parser captures only the
 * concat-with-string-literal form to keep false positives low; a
 * detector layered on top scores the file-level pattern.
 */
export interface DateStringConcat {
  /** 1-based line of the binary expression. */
  line: number;
  /** The Date method being concatenated, e.g. `"getUTCFullYear"`. */
  method: string;
}

/**
 * One ancestor of a call site that is a function-like node. The parser
 * captures the chain of these (innermost first) so call-in-hotpath
 * detectors can implement their own gating logic without re-walking the
 * AST. `name` mirrors {@link ParsedFunction.name}: present when the
 * function has a binding (named declaration, assigned arrow, named
 * method); absent for true anonymous callbacks.
 */
export interface EnclosingFunction {
  name?: string;
  shape: FunctionShape;
  /** 1-based inclusive line range — matches the {@link ParsedFunction}. */
  startLine: number;
  endLine: number;
}

/**
 * One call to a Node.js synchronous I/O API collected verbatim. The
 * parser does not decide whether the call is "in a hot path" — it
 * captures the full chain of enclosing functions, innermost first, and
 * the detector (`sync_io_in_hotpath`) applies the shape-based gating
 * policy. Calls at module top level (no enclosing function) are still
 * captured with an empty `enclosingFunctions` chain — detectors can
 * choose to skip them.
 *
 * Method coverage targets the common synchronous APIs from `node:fs`
 * (the `*Sync` family) and the synchronous process-spawning helpers.
 * The set is deliberately conservative — extending it later is
 * additive.
 */
export interface SyncIoCall {
  /**
   * Full callee text as written. For member-access calls
   * (`fs.readFileSync(...)`) this is `"fs.readFileSync"`; for
   * bare-identifier calls (after a named import of the sync method)
   * this is the bare method name, e.g. `"readFileSync"`.
   */
  callee: string;
  /** Receiver identifier when the call is a property access, e.g. `"fs"`. */
  receiver?: string;
  /** Method portion of the callee — always the bare sync method name. */
  method: string;
  /** 1-based line of the call site. */
  line: number;
  /**
   * Ancestor function-like nodes, innermost first. Empty when the call
   * is at module top level. A test-callback or CLI-registrar anywhere
   * in this chain means "this call is in a test / declarative
   * registration"; a route_handler / page_export / react_component /
   * domain anywhere in this chain means "this call runs per request /
   * render / domain call". Detectors apply their own policy.
   */
  enclosingFunctions: EnclosingFunction[];
}

/**
 * What kind of construct the declaration came from. Detectors that
 * care about scope (e.g. only flag exported names) consume this.
 */
export type DeclarationKind =
  | "const"
  | "let"
  | "var"
  | "param"
  | "property";

/**
 * Best-effort classification of the right-hand-side initializer
 * shape. Used by `boolean_naming_drift` to decide whether an
 * untyped declaration is "really" a boolean. `undefined` when the
 * declaration has no initializer (parameters, class fields without
 * `=`).
 */
export type InitializerKind =
  | "boolean_literal"
  | "negation"
  | "comparison"
  | "logical"
  | "string"
  | "number"
  | "array"
  | "object"
  | "call"
  | "other";

/**
 * A name + (optional) type annotation + (optional) initializer-shape
 * record for one declaration in the file. Covers `const`/`let`/`var`,
 * function parameters, and class properties. Destructuring patterns
 * are intentionally skipped — the v1 naming detectors only look at
 * simple identifier names.
 */
export interface TypedDeclaration {
  name: string;
  declarationKind: DeclarationKind;
  /**
   * Normalised type annotation text — `getText()` with internal
   * whitespace collapsed. Examples: `"User"`, `"User[]"`,
   * `"Array<User>"`, `"boolean"`, `"string | null"`. `undefined`
   * when no annotation is written.
   */
  type?: string;
  /** Shape of the initializer expression, when present. */
  initializerKind?: InitializerKind;
  /** True for top-level declarations carrying the `export` modifier. */
  exported: boolean;
  /** 1-based line of the declaration. */
  line: number;
}

/**
 * A single entry in a nav-like array literal.
 *
 * Optional fields are populated when the corresponding object key is found
 * with a string-literal value. Non-string values (translation calls, computed
 * expressions, etc.) are intentionally ignored — IA findings should only
 * rely on values that can be quoted verbatim in `evidence`.
 */
export interface NavLiteralEntry {
  /** Path-like value from `href|path|to|url|route` keys. */
  destination?: string;
  /** Label-like value from `label|title|name|text` keys. */
  label?: string;
  /** Other string-typed properties on the entry (icon, role, permission). */
  attributes: Record<string, string>;
}

export interface NavLiteral {
  /** Identifier the array is assigned to, if recoverable. */
  identifier?: string;
  /** 1-based line of the array literal's opening bracket. */
  line: number;
  entries: NavLiteralEntry[];
}

export type UiStringContext =
  | "jsx_title"
  | "document_title"
  | "metadata_title"
  | "use_title"
  | "jsx_label";

/**
 * A string literal extracted in a UI-text-ish context — page titles,
 * breadcrumb labels, nav labels. Used by IA detectors to compare what
 * different files claim a destination is called.
 */
export interface UiStringLiteral {
  value: string;
  /** 1-based line where the literal appears. */
  line: number;
  context: UiStringContext;
  /** JSX tag or call-site name (`"title"`, `"useTitle"`, `"Breadcrumb"`). */
  source?: string;
}

/**
 * Statically-knowable value of a JSX attribute. Frontend detectors read
 * these to look for design-token escapes (hex colors in `style`),
 * accessibility hazards (`onClick` with no `role`), and copy drift
 * (label attribute literals).
 */
export type JsxAttributeValue =
  | { kind: "string"; value: string }
  | { kind: "expression"; source: string }
  | { kind: "boolean"; value: true }
  | { kind: "spread"; source: string };

/** A child of a JSX element — another element, or a text run. */
export type JsxNode =
  | { kind: "element"; element: JsxElementInfo }
  | { kind: "text"; value: string };

/**
 * A single JSX element extracted from a source file. Attribute values are
 * captured when they are statically knowable (string literal, boolean
 * shorthand, `{…}` expression source). Children appear in document order;
 * non-element / non-text nodes (fragments are flattened into their
 * children) are dropped from `children`.
 */
export interface JsxElementInfo {
  /** Element name as written (`"Button"`, `"div"`, `"Pricing.Tier"`). */
  name: string;
  /** Inclusive [start, end] 1-based line range. */
  lines: [number, number];
  /** Attributes by name, with literal values when statically known. */
  attributes: Map<string, JsxAttributeValue>;
  /** Children, in document order. */
  children: JsxNode[];
  /** True for `<Component />` (self-closing, no children). */
  selfClosing: boolean;
}

/**
 * A `fetch()`-shaped HTTP call with a statically-known same-origin
 * path. Added in 0.15.0 for `cross_language_route_drift` — matched
 * against Python route declarations from the other side.
 *
 * Only literal URLs are captured; a runtime-assembled path cannot be
 * quoted into evidence and would line up against the wrong route.
 */
export interface FetchSite {
  /** Path as written, e.g. `"/api/users"`. Always starts with `/`. */
  url: string;
  /** Lowercased HTTP verb — from the callee, or from `{ method }`. */
  method: string;
  /** 1-based line of the call. */
  line: number;
}

/**
 * A type alias whose right-hand side is a closed set of string
 * literals: `type Plan = "free" | "pro"`. Added in 0.15.0 for
 * `cross_language_type_drift`.
 *
 * A union containing any non-literal member is not captured at all —
 * a partial member list would invent a disagreement that isn't there.
 */
export interface StringUnionType {
  name: string;
  members: string[];
  exported: boolean;
  line: number;
}

export interface ParsedFile {
  /** Total non-empty line count (1-based). */
  lineCount: number;
  /** Every declared function/method/arrow, with body line ranges. */
  functions: ParsedFunction[];
  /** Every call to `Date.now()` or `new Date(...)` in the file. */
  dateNowOrNewDateUses: DateUse[];
  /**
   * Every `Date.prototype` method invocation observed in the file.
   * Present even when empty so detectors can iterate without
   * undefined checks. Absent when no methods were observed.
   */
  dateMethodCalls?: DateMethodCall[];
  /**
   * Every `+` or `-` binary expression whose numeric operand looks
   * like a day-level millisecond constant. Absent when none seen.
   */
  dateArithmetic?: DateArithmetic[];
  /**
   * Every `"…" + d.dateMethod()` / `d.dateMethod() + "…"` binary
   * expression. Absent when none seen.
   */
  dateStringConcats?: DateStringConcat[];
  /**
   * Every typed declaration the file emits — variable bindings,
   * function parameters, and class properties. Absent when the file
   * declares no names of interest to the naming-tier detectors.
   */
  typedDeclarations?: TypedDeclaration[];
  /**
   * Every observed call to a synchronous Node.js I/O API, with the
   * chain of enclosing functions captured for shape-based gating.
   * Absent when no sync I/O calls were observed in the file.
   */
  syncIoCalls?: SyncIoCall[];
  /** Name of the file's default export, when recoverable. */
  defaultExport?: string;
  /** Array literals that look like navigation entries. */
  navLiterals?: NavLiteral[];
  /** String literals tagged with the UI context they appear in. */
  uiStringLiterals?: UiStringLiteral[];
  /**
   * Top-level JSX trees discovered in this file. Nested elements appear
   * as children of their parent rather than as separate roots. Absent
   * (rather than `[]`) for files without any JSX — keeps the JSON
   * fixture tidy on non-React surfaces.
   */
  jsxElements?: JsxElementInfo[];
  /**
   * `fetch()`-shaped calls with literal same-origin paths. Absent when
   * the file makes none. Consumed only by the cross-language pack.
   */
  fetchSites?: FetchSite[];
  /**
   * Type aliases that are closed sets of string literals. Absent when
   * the file declares none. Consumed only by the cross-language pack.
   */
  stringUnionTypes?: StringUnionType[];
}

export interface ParseInput {
  absolutePath: string;
  source: string;
}
