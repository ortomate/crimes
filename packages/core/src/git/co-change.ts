import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  findEnclosingGitRepo,
  rebaseChurnFile,
  resolveRealPath,
  runGit,
  toPosixRelative,
} from "./churn.js";

/** One file that has changed in the same commits as the target. */
export interface CoChange {
  /** Repo-relative (to the analysis root) POSIX path. */
  file: string;
  /** Commits, among those inspected, that changed both files. */
  commits: number;
}

export interface CoChangeResult {
  /** How many of the target's commits were inspected. */
  inspected: number;
  /** Files changed together at least `minCommits` times, most first. */
  files: CoChange[];
}

/**
 * Commits touching more files than this are sweeps — a rename, a
 * formatter run, a dependency bump — and say nothing about which files
 * belong together.
 */
const MAX_FILES_PER_COMMIT = 40;

/**
 * Files that historically change in the same commits as `fileRel`.
 *
 * The import graph says which files *use* each other. It cannot say which
 * ones a change usually has to touch together: a domain class, the
 * service that applies it, the admin action that exposes it, the task
 * that runs it. Replaying 82 recent commits on a private Java/Kotlin/Swift
 * estate, the files a commit went on to change were named by the graph
 * 12–40% of the time; adding the last 40 commits' co-changes roughly
 * doubled that (Java 12% -> 25%, Android 22% -> 34%,
 * iOS 40% -> 60%). It needs no parser, so it works for every language,
 * including the ones no pack reads.
 *
 * Deterministic for a given HEAD: the last `maxCommits` non-merge commits
 * touching the file, sweeps excluded, files that no longer exist dropped.
 * Returns an empty result outside a git repository or on any git failure.
 */
export async function collectCoChanges(options: {
  root: string;
  fileRel: string;
  maxCommits?: number;
  minCommits?: number;
}): Promise<CoChangeResult> {
  const empty: CoChangeResult = { inspected: 0, files: [] };
  const root = resolveRealPath(options.root);
  const gitRoot = findEnclosingGitRepo(root);
  if (gitRoot === undefined) return empty;
  const scanPath = toPosixRelative(gitRoot, root);
  const target = scanPath.length > 0 ? `${scanPath}/${options.fileRel}` : options.fileRel;

  let stdout: string;
  try {
    ({ stdout } = await runGit(gitRoot, [
      "log",
      "--no-merges",
      `-n${options.maxCommits ?? 40}`,
      "--pretty=format:@@commit",
      "--name-only",
      "--full-diff",
      "--",
      target,
    ]));
  } catch {
    return empty;
  }

  const counts = new Map<string, number>();
  let inspected = 0;
  for (const block of stdout.split("@@commit").slice(1)) {
    const files = block.split("\n").filter((l) => l.trim().length > 0);
    inspected += 1;
    if (files.length > MAX_FILES_PER_COMMIT) continue;
    for (const raw of new Set(files)) {
      if (raw === target) continue;
      const rel = rebaseChurnFile(raw, scanPath);
      if (rel === undefined) continue;
      counts.set(rel, (counts.get(rel) ?? 0) + 1);
    }
  }

  const minCommits = options.minCommits ?? 2;
  const files = [...counts]
    .filter(([file, n]) => n >= minCommits && existsSync(join(root, file)))
    .map(([file, commits]) => ({ file, commits }))
    .sort((a, b) => b.commits - a.commits || a.file.localeCompare(b.file));
  return { inspected, files };
}
