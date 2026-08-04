/**
 * A repo-wide Python symbol index — classes, their bases, their
 * methods, and which of those assert.
 *
 * ## Why it exists
 *
 * `weak_test_signal.py` follows a call to an assertion helper two hops,
 * **same file only**, because there was nothing to resolve a cross-file
 * call against. Python's dominant test idiom puts the helper on a base
 * class in another module, so the detector reported tests that do
 * assert — zulip's `capture_send_event_calls` on `ZulipTestCase`, and
 * the reason airflow's assertion-helper improvement stopped at 12%.
 *
 * ## Why it costs almost nothing
 *
 * The scoping note assumed a repo-wide index needs either a second
 * parse of every Python file or a shared parse cache, because Python
 * files are parsed *inside* the per-file detector loop. Both were
 * unnecessary. `buildPythonImportEdges` already parses every discovered
 * Python file in the pre-pass, and already builds the
 * {@link PyModuleIndex} that resolution needs — then keeps
 * `parsed.imports` and throws the rest away. This index is built from
 * that same parse, so it adds a linear pass over data already in hand.
 *
 * ## The resolution rule, which is the whole design
 *
 * **Never by name.** Matching `self.<method>()` against any function of
 * that name is the mistake `2e9b2da` removed from
 * `pass_through_abstraction`, where four unrelated registries were
 * joined into one 0.98-confidence "chain" because they all had a
 * `has()` method. Here the same mistake would be *worse*, because its
 * failure mode is silent: a test gets credited with an assertion it
 * does not make, and a detector about false confidence acquires some.
 *
 * So a base class is only followed when the importing file's own
 * imports say where it comes from, resolved through the module index.
 * A base that cannot be reached that way is not followed, and the test
 * stays reported. Uncredited is the honest answer; credited-on-a-hunch
 * is not.
 */

import {
  resolvePyImportedModule,
  type PyImportSpecifierInput,
  type PyModuleIndex,
} from "@crimes/language-py";

/**
 * How many levels of inheritance a lookup walks.
 *
 * Deep enough for the real hierarchies — zulip's `ZulipTestCase` sits
 * one level up, Django's test classes two or three — and bounded so a
 * pathological or mutually-recursive hierarchy cannot make a lookup
 * quadratic. Cycles are caught separately by the visited set; this
 * bounds the honest-but-deep case.
 */
const MAX_MRO_DEPTH = 8;

export interface PySymbol {
  name: string;
  startLine: number;
  endLine: number;
  /** True when an assertion falls inside this function's line span. */
  asserts: boolean;
}

export interface PyClassSymbol {
  name: string;
  /** Base class source text as written, e.g. `"zerver.lib.x.Base"`. */
  bases: string[];
  methods: PySymbol[];
}

/** A resolved symbol, carrying the file it was actually found in. */
export interface PyResolvedSymbol extends PySymbol {
  file: string;
  /** Class it was found on, absent for a module-level function. */
  className?: string;
}

export interface PyFileSymbols {
  file: string;
  classes: PyClassSymbol[];
  /** Module-level functions only — methods live on their class. */
  functions: PySymbol[];
  /**
   * Names this file's imports bind, mapped to the repo file that
   * defines them. The only route by which a base class or a helper is
   * followed across files.
   */
  bindings: Map<string, string>;
}

export interface PySymbolIndex {
  byFile: Map<string, PyFileSymbols>;
  /**
   * Resolve `<method>` against `className` in `file`, walking the MRO.
   * `undefined` when the class, the method, or the inheritance path
   * cannot be resolved — which is the common case and is correct.
   */
  resolveMethod(
    file: string,
    className: string,
    method: string,
  ): PyResolvedSymbol | undefined;
  /**
   * Resolve a bare `<name>()` call against the module-level functions
   * this file's imports bind. Same rule: through an import or not at
   * all.
   */
  resolveFunction(file: string, name: string): PyResolvedSymbol | undefined;
}

/** The subset of a parsed Python file this index reads. */
export interface ParsedForSymbols {
  classes: ReadonlyArray<{
    name: string;
    bases: readonly string[];
    startLine: number;
    endLine: number;
  }>;
  functions: ReadonlyArray<{
    name: string | undefined;
    className?: string;
    startLine: number;
    endLine: number;
  }>;
  assertions: ReadonlyArray<{ line: number }>;
  imports: ReadonlyArray<{
    module: string;
    relativeLevel: number;
    names: readonly string[];
    kind: "import" | "from_import";
    alias?: string;
  }>;
}

export interface PyFileSymbolsInput {
  file: string;
  classes: PyClassSymbol[];
  functions: PySymbol[];
  imports: PyImportSpecifierInput[];
}

/**
 * Reduce one parsed file to the compact summary the index holds.
 *
 * Called from inside the existing import-edge parse loop, so the
 * parsed file is discarded immediately afterwards and only this
 * summary survives — a few hundred bytes per file rather than a tree.
 */
export function collectPyFileSymbols(
  file: string,
  parsed: ParsedForSymbols,
): PyFileSymbolsInput {
  const assertionLines = parsed.assertions.map((a) => a.line).sort((a, b) => a - b);
  const asserts = (startLine: number, endLine: number): boolean =>
    hasLineInRange(assertionLines, startLine, endLine);

  const methodsByClass = new Map<string, PySymbol[]>();
  const functions: PySymbol[] = [];
  for (const fn of parsed.functions) {
    if (fn.name === undefined) continue;
    const symbol: PySymbol = {
      name: fn.name,
      startLine: fn.startLine,
      endLine: fn.endLine,
      asserts: asserts(fn.startLine, fn.endLine),
    };
    if (fn.className === undefined) {
      functions.push(symbol);
      continue;
    }
    const existing = methodsByClass.get(fn.className);
    if (existing) existing.push(symbol);
    else methodsByClass.set(fn.className, [symbol]);
  }

  const classes: PyClassSymbol[] = parsed.classes.map((cls) => ({
    name: cls.name,
    bases: [...cls.bases],
    methods: methodsByClass.get(cls.name) ?? [],
  }));

  const imports: PyImportSpecifierInput[] = parsed.imports.map((imp) => ({
    from: file,
    module: imp.module,
    relativeLevel: imp.relativeLevel,
    names: [...imp.names],
    kind: imp.kind,
  }));

  return { file, classes, functions, imports };
}

export function buildPySymbolIndex(args: {
  files: readonly PyFileSymbolsInput[];
  moduleIndex: PyModuleIndex;
}): PySymbolIndex {
  const byFile = new Map<string, PyFileSymbols>();
  for (const input of args.files) {
    byFile.set(input.file, {
      file: input.file,
      classes: input.classes,
      functions: input.functions,
      bindings: bindingsFor(input, args.moduleIndex),
    });
  }

  const classIn = (file: string, name: string): PyClassSymbol | undefined =>
    byFile.get(file)?.classes.find((c) => c.name === name);

  /**
   * Where does `baseText`, as written in `file`, actually live?
   *
   * Three written forms, all resolved the same way — through an import
   * this file makes, never through a repo-wide name search:
   *
   *   `Base`                  a `from … import Base`, or a class in
   *                           this same file
   *   `mod.Base`              a `from pkg import mod`, or `import mod`
   *   `pkg.sub.mod.Base`      an `import pkg.sub.mod`
   */
  const resolveBase = (
    file: string,
    baseText: string,
  ): { file: string; className: string } | undefined => {
    // `Base[Generic]` and `Base(metaclass=…)` — take the head.
    const clean = baseText.split(/[[(]/)[0]?.trim() ?? "";
    if (clean.length === 0) return undefined;
    const lastDot = clean.lastIndexOf(".");
    const className = lastDot === -1 ? clean : clean.slice(lastDot + 1);
    const prefix = lastDot === -1 ? "" : clean.slice(0, lastDot);
    const bindings = byFile.get(file)?.bindings;

    if (prefix === "") {
      // Defined right here — no import needed, and no ambiguity.
      if (classIn(file, className)) return { file, className };
      const target = bindings?.get(className);
      return target === undefined ? undefined : { file: target, className };
    }
    // A dotted prefix names a module. It must be one this file bound,
    // either whole (`import a.b.c`) or by its head (`from a import b`).
    const target = bindings?.get(prefix);
    return target === undefined ? undefined : { file: target, className };
  };

  const resolveMethod = (
    file: string,
    className: string,
    method: string,
  ): PyResolvedSymbol | undefined => {
    // Keyed on file+class, so the same class reached by two paths is
    // visited once and a mutually-recursive hierarchy terminates.
    const seen = new Set<string>();
    const walk = (
      atFile: string,
      atClass: string,
      depth: number,
    ): PyResolvedSymbol | undefined => {
      const key = `${atFile}::${atClass}`;
      if (seen.has(key)) return undefined;
      seen.add(key);
      const cls = classIn(atFile, atClass);
      if (!cls) return undefined;
      const own = cls.methods.find((m) => m.name === method);
      // A class that overrides a method gets its own version, not the
      // base's — that is what Python does, and crediting the base's
      // assertion for an override that drops it would be wrong.
      if (own) return { ...own, file: atFile, className: atClass };
      if (depth >= MAX_MRO_DEPTH) return undefined;
      for (const base of cls.bases) {
        const target = resolveBase(atFile, base);
        if (!target) continue;
        const found = walk(target.file, target.className, depth + 1);
        if (found) return found;
      }
      return undefined;
    };
    return walk(file, className, 0);
  };

  const resolveFunction = (file: string, name: string): PyResolvedSymbol | undefined => {
    const target = byFile.get(file)?.bindings.get(name);
    if (target === undefined) return undefined;
    const fn = byFile.get(target)?.functions.find((f) => f.name === name);
    return fn === undefined ? undefined : { ...fn, file: target };
  };

  return { byFile, resolveMethod, resolveFunction };
}

/**
 * Which names this file's imports bind, and to which repo file.
 *
 * `from pkg.mod import Thing` binds `Thing` to `pkg/mod.py` — note the
 * binding is to the *defining module*, not to a symbol: whether
 * `Thing` is a class, a function or a submodule is decided at lookup
 * time by what is actually found there.
 *
 * Ambiguity is dropped rather than resolved. Two imports binding the
 * same name (a conditional import, or a `try: … except ImportError:`
 * pair) leave that name unbound, on the same principle as everywhere
 * else here: a name that points at two things points at neither.
 */
function bindingsFor(
  input: PyFileSymbolsInput,
  moduleIndex: PyModuleIndex,
): Map<string, string> {
  const bound = new Map<string, string>();
  const ambiguous = new Set<string>();
  const bind = (name: string, file: string): void => {
    if (file === input.file) return;
    const existing = bound.get(name);
    if (existing !== undefined && existing !== file) {
      ambiguous.add(name);
      return;
    }
    bound.set(name, file);
  };

  for (const spec of input.imports) {
    if (spec.kind === "from_import") {
      const moduleFile = resolvePyImportedModule({ index: moduleIndex, spec });
      for (const name of spec.names) {
        // `from pkg import mod` — the name may itself be a module,
        // which is the more specific answer, so try it first.
        const asSubmodule = resolvePyImportedModule({
          index: moduleIndex,
          spec,
          submodule: name,
        });
        const target = asSubmodule ?? moduleFile;
        if (target !== undefined) bind(name, target);
      }
      continue;
    }
    // `import pkg.sub.mod` binds both the full dotted path and, for
    // `import x as y`, the alias.
    const moduleFile = resolvePyImportedModule({ index: moduleIndex, spec });
    if (moduleFile === undefined) continue;
    bind(spec.module, moduleFile);
    const alias = (spec as { alias?: string }).alias;
    if (alias !== undefined) bind(alias, moduleFile);
  }

  for (const name of ambiguous) bound.delete(name);
  return bound;
}

/** Is there an assertion line within `[start, end]`? Binary search. */
function hasLineInRange(sorted: readonly number[], start: number, end: number): boolean {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sorted[mid]! < start) low = mid + 1;
    else high = mid;
  }
  return low < sorted.length && sorted[low]! <= end;
}
