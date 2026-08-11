import { isTestFile } from "../../util/test-files.js";

/**
 * How much of the repository talks about each Python module.
 *
 * ## Why textual references and not the import graph
 *
 * `sync_io_in_hotpath` over-reports on one-shot scripts: 227 of
 * airflow's 811 findings sit in files carrying an
 * `if __name__ == "__main__":` guard, and a blocking read in a
 * developer script costs nothing. Three signals were tried before this
 * one and **all three failed on the same file**,
 * `task-sdk/src/airflow/sdk/execution_time/task_runner.py`:
 *
 *  1. *The file has a guard.* It does — at line 2441 of 2442 — and it is
 *     production code.
 *  2. *Guard, and nothing imports the module.* crimes reports it at **0
 *     direct importers**, because airflow launches it with `python -m`
 *     rather than importing it.
 *  3. *Guard, and every same-file call path starts inside the guard.*
 *     Traced: `_send_error_email_notification ← finalize ← main ← guard`
 *     and `_handle_trigger_dag_run ← run ← main ← guard`, with no other
 *     same-file caller. It exempts them too.
 *
 * What separates it is that the repository **talks about** the module 42
 * times — including
 * `mock.patch("airflow.sdk.execution_time.task_runner.startup")`, a
 * string no import graph can see. So the question this index answers is
 * not "who imports this?" but "does anyone mention it?", and the answer
 * is deliberately allowed to come from a string.
 *
 * ## The bar is zero
 *
 * Only a module **nothing at all** references is treated as a script.
 * Measured across airflow's 137 guarded files: 94 modules with no
 * reference (151 findings), 35 referenced only by tests (60), 8
 * referenced by non-test code (16, including `task_runner.py`). The
 * conservative cut takes the first bucket only — the test-only bucket is
 * a judgement call that can be made later with its own argument, and a
 * module a test exercises is not obviously unmaintained.
 */

export interface PyModuleReferences {
  /** Files mentioning this module, excluding the module itself. */
  total: number;
  /** How many of those are tests. */
  test: number;
}

export interface PyModuleReferenceIndex {
  /**
   * References to the module defined by `file` (a repo-relative path).
   * Returns `undefined` when the file is not a Python module this index
   * knows about, so callers can tell "no data" from "no references".
   */
  referencesTo(file: string): PyModuleReferences | undefined;
}

/**
 * Every module name a single file mentions.
 *
 * One pass per *file*, not one per (module, file) pair. The first draft
 * tested each module's own pattern against every source, which on
 * airflow is ~4,700 × ~4,700 regex executions and did not finish inside
 * ten minutes. Collecting each file's references once and inverting the
 * map is linear in the total source size.
 *
 * Matching is on whole dotted components, so `task_runner` is not found
 * in `task_runner_v2`.
 */
function referencesIn(source: string): Set<string> {
  const found = new Set<string>();

  // `from a.b.c import x` / `import a.b.c as d`.
  for (const m of source.matchAll(/^[ \t]*(?:from|import)[ \t]+([\w.]+)/gm)) {
    for (const part of (m[1] ?? "").split(".")) {
      if (part !== "") found.add(part);
    }
  }

  // Dotted paths inside string literals — `mock.patch("a.b.mod.fn")`.
  // This is the case no import graph can see, and the whole reason the
  // index is textual rather than structural.
  for (const m of source.matchAll(/["'`](\w+(?:\.\w+)+)["'`]/g)) {
    for (const part of (m[1] ?? "").split(".")) {
      if (part !== "") found.add(part);
    }
  }

  return found;
}

/** Module basename for a repo-relative Python path, or `undefined`. */
export function moduleNameOf(file: string): string | undefined {
  if (!file.endsWith(".py")) return undefined;
  const base = file.slice(file.lastIndexOf("/") + 1, -3);
  // `__init__` and `__main__` name a package or an entry point rather
  // than an importable leaf; counting references to them would pool
  // every package in the repo into one bucket.
  if (base === "" || base.startsWith("__")) return undefined;
  return base;
}

/**
 * Build the index from every Python file's source.
 *
 * Two linear passes: collect who defines each module name, then walk
 * each file's references once and increment. Matching is
 * case-sensitive, because Python imports are.
 */
export function buildPyModuleReferenceIndex(
  files: ReadonlyArray<{ file: string; source: string }>,
): PyModuleReferenceIndex {
  // module name -> files defining it, so a module never counts its own
  // mentions of itself.
  const owners = new Map<string, Set<string>>();
  for (const { file } of files) {
    const name = moduleNameOf(file);
    if (name === undefined) continue;
    const bucket = owners.get(name);
    if (bucket) bucket.add(file);
    else owners.set(name, new Set([file]));
  }

  const counts = new Map<string, PyModuleReferences>();
  for (const name of owners.keys()) counts.set(name, { total: 0, test: 0 });

  for (const { file, source } of files) {
    const test = isTestFile(file);
    for (const name of referencesIn(source)) {
      const entry = counts.get(name);
      if (entry === undefined) continue;
      if (owners.get(name)?.has(file)) continue;
      entry.total += 1;
      if (test) entry.test += 1;
    }
  }

  return {
    referencesTo(file: string): PyModuleReferences | undefined {
      const name = moduleNameOf(file);
      if (name === undefined) return undefined;
      return counts.get(name);
    },
  };
}

/** `if __name__ == "__main__":`, in either quote style. */
const MAIN_GUARD = /^\s*if\s+__name__\s*==\s*(['"])__main__\1\s*:/m;

export function hasMainGuard(source: string): boolean {
  return MAIN_GUARD.test(source);
}

/**
 * Whether a module is a one-shot script: it has an entry-point guard and
 * **nothing in the repository references it**.
 *
 * Returns `false` whenever the index is absent, so a detector without
 * repo-wide context keeps its existing behaviour rather than silently
 * suppressing. Missing the exemption costs a false positive; applying it
 * wrongly costs a silence, and that is the more expensive mistake.
 */
export function isUnreferencedScript(
  file: string,
  source: string,
  index: PyModuleReferenceIndex | undefined,
): boolean {
  if (index === undefined) return false;
  if (!hasMainGuard(source)) return false;
  const refs = index.referencesTo(file);
  return refs !== undefined && refs.total === 0;
}
