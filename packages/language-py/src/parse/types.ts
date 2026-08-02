/**
 * The parsed-file surface Python detectors read.
 *
 * Deliberately mirrors `@crimes/language-js`'s `ParsedFile` in naming and
 * shape wherever the two languages agree, and diverges only where Python
 * genuinely differs (decorators drive shape classification; imports carry
 * relative-level depth; `assert` is a statement rather than a call). The
 * point of the 0.14.0 release is to prove the pack seam is not
 * JS-shaped, so a divergence here should be a real language difference,
 * not convenience.
 */

export type PyFunctionKind = "function" | "async_function" | "method" | "async_method";

/**
 * Coarse semantic shape of a Python function, used by `large_function.py`
 * to pick a size threshold appropriate to the shape. Mirrors the JS
 * `FunctionShape` policy: the classification exists so that conventional
 * surface area (a Django view, a Click command) is not measured against
 * the same budget as dense domain logic.
 *
 * - **`domain`** — a plain function or method. The default and most
 *   aggressive bucket.
 * - **`test_function`** — a `test_*` function, a method on a
 *   `unittest.TestCase` subclass, or anything decorated with
 *   `@pytest.fixture` / `@pytest.mark.*`. Long tests are not a smell.
 * - **`route_handler`** — decorated with a web-framework route
 *   decorator: `@app.get`, `@router.post`, `@app.route`,
 *   `@api_view`, etc. Covers FastAPI, Flask, and DRF function views.
 * - **`django_view`** — a function taking `request` as its first
 *   positional parameter, or a method on a class whose bases include a
 *   Django view class. Conventional shape with framework-imposed size.
 * - **`cli_command`** — decorated with `@click.command`,
 *   `@click.group`, `@app.command` (Typer), or `@cli.command`.
 *   Declarative argument registration, not branching logic.
 * - **`dunder`** — a `__init__` / `__new__` / `__enter__` style special
 *   method. `__init__` in particular is conventionally long.
 * - **`unknown`** — a lambda or a function whose name could not be
 *   recovered.
 */
export type PyFunctionShape =
  | "domain"
  | "test_function"
  | "route_handler"
  | "django_view"
  | "cli_command"
  | "dunder"
  | "unknown";

export interface ParsedPyFunction {
  name: string | undefined;
  kind: PyFunctionKind;
  /** 1-based inclusive line range, decorators excluded. */
  startLine: number;
  endLine: number;
  shape: PyFunctionShape;
  /**
   * Short machine-friendly strings explaining *why* the shape was
   * picked (e.g. `"decorated @app.get"`, `"first parameter named
   * request"`). Detectors quote these verbatim into `Finding.evidence`.
   */
  shapeEvidence?: string[];
  /** Decorator source text as written, without the leading `@`. */
  decorators: string[];
  /**
   * Positional + keyword parameter count. `self` / `cls` are excluded so
   * a method is measured on the same scale as a free function.
   */
  paramCount: number;
  /**
   * Declared parameter names in source order, same exclusions as
   * `paramCount`. `*args` / `**kwargs` appear as `args` / `kwargs`.
   *
   * Present because in Python a parameter name is often a *dependency
   * declaration* rather than a value — a pytest fixture is requested by
   * naming it. `weak_test_signal.py` reads this to recognise the
   * `pytest-benchmark` idiom (`def test_x(benchmark)`), which is by far
   * the most common way a benchmark is written and which no decorator
   * marks.
   */
  paramNames: string[];
  /** Deepest nesting level of compound statements inside the body. */
  maxNestingDepth: number;
  /** Enclosing class name, when the function is a method. */
  className?: string;
}

export interface ParsedPyClass {
  name: string;
  startLine: number;
  endLine: number;
  /** Base class source text as written, e.g. `"unittest.TestCase"`. */
  bases: string[];
  decorators: string[];
  /**
   * Class-body members that read as a closed set — Enum values and
   * Pydantic / dataclass fields. Added in 0.15.0.
   */
  members: PyClassMember[];
  /** First line of the class docstring, when present. */
  docstring?: string;
}

/**
 * One `import` / `from … import …` statement.
 *
 * `module` is the dotted path exactly as written, with relative dots
 * stripped — `from ..pkg.sub import thing` yields `module: "pkg.sub"`,
 * `relativeLevel: 2`. A bare `from . import sibling` yields
 * `module: ""`, `relativeLevel: 1`.
 */
export interface PyImport {
  kind: "import" | "from_import";
  /** Dotted module path with relative dots stripped. May be empty. */
  module: string;
  /**
   * Number of leading dots. `0` for an absolute import, `1` for
   * `from . import x`, `2` for `from .. import x`, and so on.
   */
  relativeLevel: number;
  /** Imported symbol names. Empty for a plain `import x`. */
  names: string[];
  /** True for `from x import *`. */
  wildcard: boolean;
  /** Alias from `import x as y`, when present. */
  alias?: string;
  /** 1-based line of the statement. */
  line: number;
  /**
   * Dotted depth used by `deep_import.py` — segment count of the full
   * path as written. `from a.b.c.d import x` is depth 4.
   */
  depth: number;
}

/**
 * One clock read. Mirrors the JS `DateUse` role but keyed on the Python
 * API surface.
 *
 * - `now` — `datetime.now()` / `datetime.datetime.now()`
 * - `utcnow` — `datetime.utcnow()` (deprecated since 3.12, and the
 *   naive-UTC trap `mixed_utc_local_methods.py` looks for)
 * - `today` — `date.today()` / `datetime.today()`
 * - `time` — `time.time()`
 */
export interface PyDateCall {
  kind: "now" | "utcnow" | "today" | "time";
  /** Callee text as written, e.g. `"datetime.datetime.now"`. */
  callee: string;
  /** 1-based line of the call. */
  line: number;
  /**
   * True when the call passes a `tz=` / `tzinfo=` keyword argument, or a
   * single positional argument (`datetime.now(timezone.utc)`). A
   * timezone-aware read is not a temporal-recklessness finding.
   */
  timezoneAware: boolean;
}

/**
 * One ancestor of a call site that is a function-like node, innermost
 * first. Mirrors the JS `EnclosingFunction`.
 */
export interface PyEnclosingFunction {
  name?: string;
  shape: PyFunctionShape;
  /**
   * Carried so a detector can ask "is this call inside an `async def`?"
   * from the scope chain itself. Without it the only way to answer is to
   * test the call's line number against every function's range, which is
   * both O(calls × functions) and a weaker claim — line containment is
   * not the same as lexical enclosure.
   */
  kind: PyFunctionKind;
  startLine: number;
  endLine: number;
}

/**
 * One call to a blocking I/O API. The parser captures the call verbatim
 * plus its enclosing-function chain; `sync_io_in_hotpath.py` applies the
 * shape policy.
 */
export interface PyIoCall {
  /** Callee text as written, e.g. `"requests.get"`, `"open"`. */
  callee: string;
  /** Coarse family for evidence strings and severity weighting. */
  family: "file" | "network" | "subprocess" | "sleep";
  /** 1-based line of the call. */
  line: number;
  /** Ancestor functions, innermost first. Empty at module top level. */
  enclosingFunctions: PyEnclosingFunction[];
}

/**
 * Best-effort classification of an assignment's right-hand side. Used by
 * `boolean_naming_drift.py` to decide whether an unannotated name is
 * "really" a boolean.
 */
export type PyInitializerKind =
  | "boolean_literal"
  | "negation"
  | "comparison"
  | "logical"
  | "membership"
  | "identity"
  | "call"
  | "string"
  | "number"
  | "collection"
  | "none"
  | "other";

export interface PyAssignment {
  /** Bare target name. Attribute targets carry the attribute only. */
  name: string;
  /** True when the target was `self.x` / `cls.x` rather than a local. */
  attributeTarget: boolean;
  /** Annotation source text from `x: bool = True`, when written. */
  annotation?: string;
  initializerKind: PyInitializerKind;
  /** 1-based line. */
  line: number;
  /** Enclosing function name, when inside one. */
  functionName?: string;
}

/**
 * One assertion. Every form that makes a test fail on bad data lands
 * here so `weak_test_signal.py` can count test strength without caring
 * which framework the file uses.
 *
 * - `assert_statement` — a bare `assert`.
 * - `unittest_method` — the `self.assert*` family.
 * - `pytest_raises` — `pytest.raises(...)`, usually as a context manager.
 * - `explicit_fail` — `self.fail(...)` / `pytest.fail(...)`. unittest's
 *   idiom for "reaching this line is the failure" is a deliberate
 *   assertion written inside-out, not an absent one.
 * - `raises_on_invalid` — a call that is only ever written for its
 *   raise-on-bad-data behaviour, currently pydantic's
 *   `model_dump_json(warnings='error')`. The call *is* the assertion:
 *   without the keyword it silently coerces, with it the test fails.
 */
export interface PyAssertion {
  kind:
    | "assert_statement"
    | "unittest_method"
    | "pytest_raises"
    | "explicit_fail"
    | "raises_on_invalid";
  /** Method name for the unittest family, e.g. `"assertEqual"`. */
  method?: string;
  line: number;
  /** Enclosing test function name, when recoverable. */
  functionName?: string;
}

/** One keyword argument at a call site. */
export interface PyCallKeyword {
  /** Keyword name as written: `warnings` in `f(warnings='error')`. */
  name: string;
  /**
   * The argument's value when it is a plain string literal, quotes and
   * prefix stripped. Absent for every other expression — a value that
   * cannot be read off the source is not guessed at.
   */
  stringValue?: string;
}

/**
 * One call site, recorded for every `call` node in the file.
 *
 * This is the *general* call surface, deliberately unfiltered and
 * unclassified: `dateCalls` and `ioCalls` answer narrow, policy-laden
 * questions ("is this a clock read?", "is this blocking I/O?"), whereas
 * plenty of analysis only needs "what did this function call, and from
 * where?". Building that from a filtered list is impossible, so it is
 * collected once in the same pass and the narrow lists are derived from
 * it.
 *
 * Both `dateCalls` and `ioCalls` are still published as their own
 * classified lists rather than being folded into this one: their
 * `kind` / `family` / `timezoneAware` fields are Python-API knowledge
 * that belongs in the language pack, and re-deriving them in `core`
 * from `calls` would push exactly that knowledge across the pack seam.
 */
export interface PyCall {
  /**
   * Dotted callee text exactly as written — `"open"`,
   * `"self.assertEqual"`, `"datetime.datetime.now"`. A receiver built
   * at runtime (`registry["x"].run`) yields its flattened source text,
   * so an unusual receiver fails to match rather than mis-matching.
   */
  callee: string;
  /** Trailing segment of `callee`: `"assertEqual"`. */
  name: string;
  /** Everything before the trailing segment: `"self"`, or `""`. */
  receiver: string;
  /** 1-based line of the call. */
  line: number;
  /** Total argument count, positional and keyword together. */
  argCount: number;
  /** Keyword arguments, in source order. Empty when there are none. */
  keywords: PyCallKeyword[];
  /** Ancestor functions, innermost first. Empty at module top level. */
  enclosingFunctions: PyEnclosingFunction[];
}

/**
 * A web-framework route declared on the Python side.
 *
 * Added in 0.15.0 for `cross_language_route_drift`, which lines these
 * up against `fetch()` call sites and nav labels on the JS side.
 *
 * Only routes whose path is a **string literal** are captured. A path
 * built at runtime (`@app.get(PREFIX + "/users")`) cannot be quoted
 * verbatim into `Finding.evidence`, and the IA family's rule is that
 * anything not quotable is not recorded.
 */
export interface PyRoute {
  /** HTTP method lowercased, or `"route"` / `"websocket"` when the
   *  decorator does not name one (Flask's `@app.route`). */
  method: string;
  /** Path exactly as written, e.g. `"/api/users/{user_id}"`. */
  path: string;
  /** Decorator receiver, e.g. `"app"`, `"router"`, `"bp"`. */
  receiver: string;
  /** Handler function name. */
  handler?: string;
  /** 1-based line of the decorator. */
  line: number;
}

/**
 * A member of a class body that reads as part of a closed set — an Enum
 * value or a Pydantic/dataclass field.
 *
 * Added in 0.15.0 for `cross_language_type_drift`, which compares these
 * against string-literal unions on the TS side.
 */
export interface PyClassMember {
  /** Member name as written (`FREE`, `plan`). */
  name: string;
  /**
   * String-literal value when the member is assigned one
   * (`FREE = "free"`). Absent for bare annotations (`plan: str`) and
   * for non-literal values.
   */
  value?: string;
  line: number;
}

export interface ParsedPyFile {
  /** Total line count. */
  lineCount: number;
  functions: ParsedPyFunction[];
  classes: ParsedPyClass[];
  imports: PyImport[];
  /** Every call site in the file, unfiltered. */
  calls: PyCall[];
  dateCalls: PyDateCall[];
  ioCalls: PyIoCall[];
  assignments: PyAssignment[];
  assertions: PyAssertion[];
  /** Web-framework routes with string-literal paths. */
  routes: PyRoute[];
  /**
   * True when tree-sitter reported an ERROR node anywhere in the tree.
   * The parse is still usable — tree-sitter recovers locally — but
   * detectors that would produce a confident verdict from a whole-file
   * reading (`weak_test_signal.py` counting assertions) downgrade
   * confidence rather than claim a count they cannot stand behind.
   */
  hasSyntaxErrors: boolean;
}

export interface ParsePyInput {
  absolutePath: string;
  source: string;
}
