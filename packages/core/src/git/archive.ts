import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { isGitRepo, NotAGitRepoError, UnknownGitRefError } from "./changed-files.js";

const execFileAsync = promisify(execFile);

/**
 * Export a Git ref's tree into a fresh temporary directory and return its
 * absolute path. The working tree is **not** touched — the export is done
 * via `git archive`, which streams the committed tree of the requested ref
 * without checking it out.
 *
 * Caller is responsible for removing the directory afterwards (or use
 * {@link withRefCheckout} which handles cleanup).
 *
 * Throws:
 * - {@link NotAGitRepoError} if `repoRoot` is not inside a git repository.
 * - {@link UnknownGitRefError} if `ref` cannot be resolved.
 */
export async function exportRefToTempDir(args: {
  repoRoot: string;
  ref: string;
}): Promise<string> {
  const repoRoot = resolve(args.repoRoot);
  const { ref } = args;

  if (!(await isGitRepo(repoRoot))) {
    throw new NotAGitRepoError(repoRoot);
  }
  await assertRefExists(repoRoot, ref);

  const outDir = await mkdtemp(join(tmpdir(), "crimes-archive-"));

  try {
    await runArchive({ repoRoot, ref, outDir });
  } catch (err) {
    await rm(outDir, { recursive: true, force: true });
    throw err;
  }

  return outDir;
}

/**
 * Run `fn` against a temp checkout of `ref`, then clean up. The temp dir is
 * removed even if `fn` throws.
 */
export async function withRefCheckout<T>(
  args: { repoRoot: string; ref: string },
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await exportRefToTempDir(args);
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

function runArchive(args: {
  repoRoot: string;
  ref: string;
  outDir: string;
}): Promise<void> {
  const { repoRoot, ref, outDir } = args;

  return new Promise((resolvePromise, rejectPromise) => {
    // git archive writes a tar stream of the committed tree of `ref` to stdout.
    // We pipe it directly into `tar -x` so we never materialise the tarball
    // on disk. Both `git` and `tar` are universal on macOS / Linux / Git for
    // Windows.
    const archive = spawn("git", ["archive", "--format=tar", ref], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const extract = spawn("tar", ["-x", "-C", outDir], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let archiveStderr = "";
    let extractStderr = "";
    let archiveCode: number | null = null;
    let extractCode: number | null = null;
    let archiveError: Error | null = null;
    let extractError: Error | null = null;
    let settled = false;

    archive.stderr.on("data", (chunk: Buffer) => {
      archiveStderr += chunk.toString("utf8");
    });
    extract.stderr.on("data", (chunk: Buffer) => {
      extractStderr += chunk.toString("utf8");
    });

    archive.stdout.pipe(extract.stdin);

    archive.on("error", (err) => {
      archiveError = err;
      settle();
    });
    extract.on("error", (err) => {
      extractError = err;
      settle();
    });
    archive.on("close", (code) => {
      archiveCode = code;
      settle();
    });
    extract.on("close", (code) => {
      extractCode = code;
      settle();
    });

    function settle(): void {
      if (settled) return;
      if (archiveError) {
        settled = true;
        rejectPromise(archiveError);
        return;
      }
      if (extractError) {
        settled = true;
        rejectPromise(extractError);
        return;
      }
      if (archiveCode === null || extractCode === null) return;
      settled = true;
      if (archiveCode !== 0) {
        rejectPromise(
          new Error(
            `git archive ${ref} failed (exit ${archiveCode}): ${archiveStderr.trim()}`,
          ),
        );
        return;
      }
      if (extractCode !== 0) {
        rejectPromise(
          new Error(`tar extract failed (exit ${extractCode}): ${extractStderr.trim()}`),
        );
        return;
      }
      resolvePromise();
    }
  });
}
