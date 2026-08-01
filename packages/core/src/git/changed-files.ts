import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ChangedFilesOptions {
  /** Repo root. Must be an existing directory; will be resolved internally. */
  root: string;
  /**
   * Optional base ref. When provided, files that differ between
   * `<base>...HEAD` plus any working-tree changes are returned. When omitted,
   * only working-tree changes (staged + unstaged + untracked) are returned.
   */
  base?: string;
}

export class NotAGitRepoError extends Error {
  constructor(root: string) {
    super(
      `not a git repository (or any of the parent directories): ${root}. ` +
        `This command needs Git history — initialise a repo or run it from inside one.`,
    );
    this.name = "NotAGitRepoError";
  }
}

export class UnknownGitRefError extends Error {
  constructor(ref: string) {
    super(
      `unknown git ref "${ref}". Pass a ref Git can resolve, e.g. main, origin/main, or a commit SHA.`,
    );
    this.name = "UnknownGitRefError";
  }
}

/**
 * Resolve the set of files changed in the working tree (and, when `base` is
 * given, additionally between `<base>...HEAD`). Returns absolute paths. Only
 * existing files are returned — deletions are skipped, since there is nothing
 * to scan.
 */
export async function getChangedFiles(options: ChangedFilesOptions): Promise<string[]> {
  const root = resolve(options.root);

  if (!(await isGitRepo(root))) {
    throw new NotAGitRepoError(root);
  }

  const repoRoot = await getGitTopLevel(root);

  const collected = new Set<string>();

  // Working-tree changes vs HEAD — staged, unstaged, and untracked.
  // `git status --porcelain=v1 -z` is the most reliable parse target for
  // filenames containing whitespace or unusual characters.
  for (const rel of await listWorkingTreeChanges(repoRoot)) {
    collected.add(rel);
  }

  // Optional comparison vs a base ref.
  if (options.base) {
    for (const rel of await listDiffAgainstBase(repoRoot, options.base)) {
      collected.add(rel);
    }
  }

  const absolutes: string[] = [];
  for (const rel of collected) {
    const abs = join(repoRoot, rel);
    if (!existsSync(abs)) continue;
    absolutes.push(abs);
  }
  absolutes.sort();
  return absolutes;
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      { cwd: dir },
    );
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

async function getGitTopLevel(dir: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
    cwd: dir,
  });
  return stdout.trim();
}

async function listWorkingTreeChanges(repoRoot: string): Promise<string[]> {
  // -z gives NUL-separated records; --porcelain=v1 keeps the format stable.
  // --no-renames simplifies parsing — renamed files appear as add+delete pairs.
  const { stdout } = await execFileAsync(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"],
    { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 },
  );

  // Each record is: XY SP path NUL. We split on NUL and parse from index 3.
  const records = stdout.split("\0").filter(Boolean);
  const out: string[] = [];
  for (const record of records) {
    if (record.length < 4) continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    // Skip pure deletions — there's nothing on disk to scan.
    if (status === " D" || status === "D " || status === "DD") continue;
    out.push(toPosix(path));
  }
  return out;
}

async function listDiffAgainstBase(repoRoot: string, base: string): Promise<string[]> {
  await assertRefExists(repoRoot, base);

  // `<base>...HEAD` uses the merge-base, which matches what `git diff
  // main...HEAD` does in CI: only commits unique to HEAD's branch.
  // --diff-filter=ACMRT keeps Added, Copied, Modified, Renamed, Type-changed.
  // Deleted (D) is skipped — there's nothing on disk to scan.
  const { stdout } = await execFileAsync(
    "git",
    [
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      "--diff-filter=ACMRT",
      `${base}...HEAD`,
    ],
    { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 },
  );
  return stdout
    .split("\0")
    .filter(Boolean)
    .map((p) => toPosix(p));
}

async function assertRefExists(repoRoot: string, ref: string): Promise<void> {
  try {
    await execFileAsync("git", ["rev-parse", "--verify", "--quiet", ref], {
      cwd: repoRoot,
    });
  } catch {
    throw new UnknownGitRefError(ref);
  }
}

function toPosix(p: string): string {
  if (sep === "/") return p;
  return p.split(sep).join("/");
}
