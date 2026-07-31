import { realpath } from "node:fs/promises";

/**
 * `fs.realpath` that falls back to the input on failure.
 *
 * Used wherever a git-supplied or caller-supplied path has to line up
 * with a discovered one. macOS temp dirs are the motivating case: git
 * emits canonical `/private/var/...` paths while a caller may pass the
 * `/var/...` symlink, and `relative()` between the two produces
 * `../../private/var/...` instead of `src/foo.ts`.
 *
 * Swallowing the error is deliberate — a path that cannot be resolved
 * (deleted between listing and reading, permission denied) should fall
 * back to the literal string rather than abort the scan.
 *
 * Deduplicated from scan.ts and context.ts in 0.12.2, which carried
 * identical private copies.
 */
export async function safeRealpath(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}
