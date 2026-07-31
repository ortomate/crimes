/**
 * Shared test-file classifier. Every detector / index that has a notion of
 * "this is a test file, treat it differently" reaches for these helpers so
 * the codebase has exactly one source of truth for the test-file naming
 * convention.
 *
 * Matches:
 *   - JS/TS: `*.test.[cm]?[jt]sx?`, `*.spec.[cm]?[jt]sx?`, and the
 *     Go-style `*_test.ts` / `*_spec.ts` forms, `__tests__/`
 *   - Python: `*_test.py`, `test_*.py`
 *   - Go: `*_test.go`
 *   - Rust / generic: `tests/` top-level directory segment
 *
 * The JS underscore forms were recognised by `likely_tests` from 0.4.0
 * but not by this classifier, so `foo_test.ts` was offered as a test in
 * `crimes context` while being scanned as ordinary source everywhere
 * else. Unified in 0.14.0 — a file is a test file or it isn't.
 *
 * Path separator is `/` — callers pass repo-relative paths with forward
 * slashes (which is the shape every detector context exposes).
 */
export const TEST_FILE_RE =
  /(?:^|\/)(?:__tests__\/|tests\/|.*[._](?:test|spec)\.[cm]?[jt]sx?$|.*_test\.(?:py|go)$|test_[^/]+\.py$)/;

export function isTestFile(path: string): boolean {
  return TEST_FILE_RE.test(path);
}

/**
 * Directory segments meaning "this holds tests for code living
 * elsewhere". A test inside one of these pairs with a source file by
 * basename rather than by being its sibling.
 */
export const TEST_DIR_RE = /(^|\/)(__tests__|tests?)\//;

/**
 * Does a test file's basename indicate it covers `sourceBase`?
 *
 * Both arguments are basenames with the extension already stripped.
 *
 * | written as         | covers    | languages     |
 * | ------------------ | --------- | ------------- |
 * | `billing.test.ts`  | `billing` | JS/TS         |
 * | `billing.spec.ts`  | `billing` | JS/TS         |
 * | `billing_test.py`  | `billing` | Python, Go    |
 * | `test_billing.py`  | `billing` | Python        |
 *
 * Note the asymmetry that made this worth centralising: every
 * convention except Python's dominant one is a *suffix*.
 *
 * This lives here rather than beside either caller because the codebase
 * had **two** independent implementations of "does this test cover that
 * file" — one in `scoring/build.ts` feeding `test_gap`, one in
 * `context-likely-tests.ts` feeding `ContextReport.likely_tests` — and
 * teaching only the first about Python left `crimes context` confidently
 * reporting "no likely tests" for a well-covered Python module. One
 * source of truth, so the next language pack fixes both at once.
 */
export function testBaseCovers(testBase: string, sourceBase: string): boolean {
  if (testBase === sourceBase) return true;
  const suffixStripped = testBase.replace(/[._](test|spec)$/, "");
  if (suffixStripped === sourceBase) return true;
  const prefixStripped = testBase.replace(/^(test|spec)_/, "");
  return prefixStripped === sourceBase;
}
