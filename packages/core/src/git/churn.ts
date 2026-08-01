import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

/**
 * Sentinel header for parsing `git log` output. We emit one of these before
 * every commit so we can split the stream unambiguously — file paths in a
 * repo will never start with this string.
 */
const COMMIT_MARKER = "CRIMES_COMMIT";

export interface FileChurn {
  /** Repo-relative path with forward slashes (as Git emits it). */
  file: string;
  /** Number of commits in the window that touched this file. */
  changeCount: number;
  /** ISO-8601 timestamp of the most recent commit that touched the file. */
  latestChange: string;
  /** Number of distinct committer emails in the window. */
  uniqueAuthors: number;
}

export interface CollectChurnOptions {
  /** Repo root. */
  root: string;
  /**
   * Window for `git log --since`. Examples accepted by Git:
   *   "90 days ago", "2 weeks ago", "2026-01-01". This module also accepts
   *   compact forms via {@link normaliseSince} — `"90d"`, `"2w"`, `"1y"`.
   */
  since: string;
}

export interface CollectChurnResult {
  /** Whether the directory is a git repository and `git` is invokable. */
  gitAvailable: boolean;
  /**
   * One entry per file touched in the window. Empty when `gitAvailable` is
   * false or the window contains no commits.
   */
  files: FileChurn[];
  /**
   * True when the working tree is a shallow clone (commit history is
   * truncated). Older commits are unavailable to `git log`, so the churn
   * counts only reflect history present locally. Treat hotspot rankings
   * as advisory in this case.
   *
   * Detected via `git rev-parse --is-shallow-repository`. Absent /
   * `undefined` when `gitAvailable` is false.
   */
  historyLimited?: boolean;
  /**
   * Short, human-readable explanation of why history is limited. Only
   * set when `historyLimited` is true.
   */
  historyLimitedReason?: string;
}

/**
 * Convert compact since-strings ("90d", "2w", "6m", "1y") to a phrase Git
 * understands. Anything that doesn't match the compact pattern is returned
 * as-is so Git's own parser handles dates / phrases.
 */
export function normaliseSince(since: string): string {
  const compact = /^\s*(\d+)\s*([dwmy])\s*$/i.exec(since);
  if (!compact) return since;

  const value = Number(compact[1]);
  const unit = compact[2]!.toLowerCase();
  switch (unit) {
    case "d":
      return `${value} days ago`;
    case "w":
      return `${value} weeks ago`;
    case "m":
      return `${value} months ago`;
    case "y":
      return `${value} years ago`;
    default:
      return since;
  }
}

/**
 * Parse the output of `git log --pretty=format:CRIMES_COMMIT %cI %ae --name-only`.
 *
 * Output shape (one commit shown):
 *
 *   CRIMES_COMMIT 2026-05-15T14:30:00+00:00 author@example.com
 *   path/to/file-a.ts
 *   path/to/file-b.ts
 *
 *   CRIMES_COMMIT 2026-05-14T... author2@example.com
 *   path/to/file-c.ts
 *
 * Each blank line ends a commit block. Merge commits (no file changes) are
 * tolerated and ignored.
 *
 * Also handles the legacy `CRIMES_COMMIT <date>` format (no email field) —
 * the `spaceIdx === -1` branch sets `currentAuthor = ""` which is filtered
 * out, so `uniqueAuthors` will be 0 for those entries (backwards-compat).
 */
export function parseGitLog(output: string): FileChurn[] {
  const byFile = new Map<
    string,
    { count: number; latest: string; authors: Set<string> }
  >();
  let currentDate: string | null = null;
  let currentAuthor: string | null = null;

  for (const rawLine of output.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.length === 0) {
      currentDate = null;
      currentAuthor = null;
      continue;
    }
    if (line.startsWith(COMMIT_MARKER)) {
      const payload = line.slice(COMMIT_MARKER.length).trim();
      const spaceIdx = payload.indexOf(" ");
      if (spaceIdx === -1) {
        currentDate = payload;
        currentAuthor = "";
      } else {
        currentDate = payload.slice(0, spaceIdx);
        currentAuthor = payload.slice(spaceIdx + 1);
      }
      continue;
    }
    if (currentDate === null) continue;

    const file = line.trim();
    if (file.length === 0) continue;

    const existing = byFile.get(file);
    if (existing) {
      existing.count += 1;
      if (existing.latest < currentDate) existing.latest = currentDate;
      if (currentAuthor) existing.authors.add(currentAuthor);
    } else {
      byFile.set(file, {
        count: 1,
        latest: currentDate,
        authors: new Set(currentAuthor ? [currentAuthor] : []),
      });
    }
  }

  const result: FileChurn[] = [];
  for (const [file, { count, latest, authors }] of byFile) {
    result.push({
      file,
      changeCount: count,
      latestChange: latest,
      uniqueAuthors: authors.size,
    });
  }
  result.sort((a, b) => {
    if (b.changeCount !== a.changeCount) return b.changeCount - a.changeCount;
    return a.file.localeCompare(b.file);
  });
  return result;
}

/**
 * Return true if `root` looks like a Git working tree. Cheap — just a file
 * existence check. Doesn't shell out to `git`.
 */
export function isGitRepo(root: string): boolean {
  return existsSync(resolve(root, ".git"));
}

/**
 * Walk upward from `start` looking for a `.git` entry (file or
 * directory — submodules use a file). Returns the absolute path of the
 * enclosing repo root, or `undefined` if the walk reaches the
 * filesystem root without finding one.
 *
 * Used by `crimes hotspots <subdir>` so a sub-directory inside a Git
 * repo still gets churn signal — running the command from
 * `packages/cli` in this monorepo, for example, should still see
 * commits even though `packages/cli/.git` doesn't exist.
 */
export function findEnclosingGitRepo(start: string): string | undefined {
  let current = resolve(start);
  while (true) {
    if (existsSync(resolve(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

interface SpawnResult {
  status: number | null;
  stdout: string;
}

function runGit(root: string, args: string[]): Promise<SpawnResult> {
  return new Promise((resolvePromise, reject) => {
    // `spawn` with an args array does not invoke a shell, so the `since`
    // string can't be interpreted as a command.
    const child = spawn("git", args, { cwd: root });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => {
      if (status === 0) {
        resolvePromise({ status, stdout });
      } else {
        reject(new Error(`git ${args.join(" ")} exited ${status}: ${stderr}`));
      }
    });
  });
}

/**
 * Run `git log` over the window and return per-file churn. Resolves with
 * `gitAvailable: false` (and an empty file list) for non-git directories or
 * when the `git` binary is missing.
 *
 * Also probes `git rev-parse --is-shallow-repository` so callers can
 * annotate degraded rankings as `history_limited`. Probing is best-effort;
 * a probe failure is treated as "not shallow" rather than as the whole
 * churn collection failing.
 */
export async function collectChurn(
  options: CollectChurnOptions,
): Promise<CollectChurnResult> {
  const { root, since } = options;
  // Walk upward to the enclosing git repo. This is what makes
  // `crimes hotspots packages` work from the monorepo root — the
  // sub-directory isn't its own git root, but the parent is.
  const gitRoot = findEnclosingGitRepo(root);
  if (gitRoot === undefined) {
    return { gitAvailable: false, files: [] };
  }

  const sinceArg = normaliseSince(since);

  // Repo-root-relative POSIX path to the scan root. Empty when the
  // scan root *is* the git root. Passed to `git log -- <pathspec>` so
  // git filters to commits that touch files under the scan directory.
  const scanPathRelToGit = toPosixRelative(gitRoot, root);

  try {
    const logArgs = [
      "log",
      `--since=${sinceArg}`,
      `--pretty=format:${COMMIT_MARKER} %cI %ae`,
      "--name-only",
      "--no-merges",
    ];
    if (scanPathRelToGit.length > 0) {
      logArgs.push("--", scanPathRelToGit);
    }
    const [log, shallow] = await Promise.all([
      runGit(gitRoot, logArgs),
      probeShallow(gitRoot),
    ]);
    // `git log` emits paths relative to the git root. Callers expect
    // them relative to the scan root they passed in, so rewrite each
    // entry. Files outside the scan path are dropped (`--` pathspec
    // already filters them, but rewriting is a defensive second check).
    const rebased: FileChurn[] = [];
    for (const entry of parseGitLog(log.stdout)) {
      const rel = rebaseChurnFile(entry.file, scanPathRelToGit);
      if (rel === undefined) continue;
      rebased.push({ ...entry, file: rel });
    }
    const result: CollectChurnResult = {
      gitAvailable: true,
      files: rebased,
    };
    if (shallow) {
      result.historyLimited = true;
      result.historyLimitedReason =
        "repository is a shallow clone; older commits are unavailable, so churn counts only reflect history present locally";
    }
    return result;
  } catch {
    return { gitAvailable: false, files: [] };
  }
}

/**
 * Repo-root-relative POSIX path from `gitRoot` to `target`, or the
 * empty string when the two are the same. `..`-leading paths are
 * treated as outside the repo and return the empty string — that
 * should be impossible given the upward walk, but stays defensive.
 */
function toPosixRelative(gitRoot: string, target: string): string {
  const rel = relative(resolve(gitRoot), resolve(target));
  if (rel.length === 0) return "";
  if (rel.startsWith("..")) return "";
  return rel.split(sep).join("/");
}

/**
 * Convert a path emitted by `git log` (relative to the git root) to a
 * path relative to the scan root. `scanPath` is the git-root-relative
 * scan directory (empty when scan root == git root). Returns
 * `undefined` when the file is outside `scanPath`.
 */
function rebaseChurnFile(file: string, scanPath: string): string | undefined {
  if (scanPath.length === 0) return file;
  if (file === scanPath) return "";
  const prefix = `${scanPath}/`;
  if (!file.startsWith(prefix)) return undefined;
  return file.slice(prefix.length);
}

/**
 * Best-effort `git rev-parse --is-shallow-repository` probe. Returns
 * `true` only when git explicitly answers `true`. Any error (older git,
 * detached environments, etc.) returns `false` — callers should treat
 * "we couldn't tell" the same as "not shallow" rather than masking
 * findings.
 */
async function probeShallow(root: string): Promise<boolean> {
  try {
    const result = await runGit(root, ["rev-parse", "--is-shallow-repository"]);
    return result.stdout.trim() === "true";
  } catch {
    return false;
  }
}
