/**
 * Shared test-file classifier. Every detector / index that has a notion of
 * "this is a test file, treat it differently" reaches for these helpers so
 * the codebase has exactly one source of truth for the test-file naming
 * convention.
 *
 * Matches:
 *   - JS/TS: `*.test.[cm]?[jt]sx?`, `*.spec.[cm]?[jt]sx?`, `__tests__/`
 *   - Python: `*_test.py`, `test_*.py`
 *   - Go: `*_test.go`
 *   - Rust / generic: `tests/` top-level directory segment
 *
 * Path separator is `/` — callers pass repo-relative paths with forward
 * slashes (which is the shape every detector context exposes).
 */
export const TEST_FILE_RE =
  /(?:^|\/)(?:__tests__\/|tests\/|.*\.(?:test|spec)\.[cm]?[jt]sx?$|.*_test\.(?:py|go)$|test_[^/]+\.py$)/;

export function isTestFile(path: string): boolean {
  return TEST_FILE_RE.test(path);
}
