import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getChangedFiles,
  NotAGitRepoError,
  UnknownGitRefError,
} from "./changed-files.js";

const execFileAsync = promisify(execFile);

// `git rev-parse --show-toplevel` returns the canonical repo path, so the
// helper's returned paths are canonical too. Resolve the temp dir up-front
// so equality checks in tests don't trip over /var → /private/var on macOS.

async function git(cwd: string, ...args: string[]): Promise<void> {
  // Use a deterministic identity so commits succeed in CI without global config.
  await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "crimes-test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "crimes-test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

async function makeRepo(): Promise<string> {
  const raw = await mkdtemp(join(tmpdir(), "crimes-changed-files-"));
  const dir = await realpath(raw);
  await git(dir, "init", "--initial-branch=main", "--quiet");
  await git(dir, "config", "commit.gpgsign", "false");
  return dir;
}

async function commitAll(cwd: string, message: string): Promise<void> {
  await git(cwd, "add", "-A");
  await git(cwd, "commit", "-m", message, "--quiet");
}

describe("getChangedFiles", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await makeRepo();
    await writeFile(join(repo, "kept.ts"), "export const kept = 1;\n");
    await commitAll(repo, "init");
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("returns an empty list when nothing has changed", async () => {
    const changed = await getChangedFiles({ root: repo });
    expect(changed).toEqual([]);
  });

  it("includes unstaged working-tree modifications", async () => {
    await writeFile(join(repo, "kept.ts"), "export const kept = 2;\n");
    const changed = await getChangedFiles({ root: repo });
    expect(changed).toEqual([join(repo, "kept.ts")]);
  });

  it("includes staged modifications", async () => {
    await writeFile(join(repo, "kept.ts"), "export const kept = 3;\n");
    await git(repo, "add", "kept.ts");
    const changed = await getChangedFiles({ root: repo });
    expect(changed).toEqual([join(repo, "kept.ts")]);
  });

  it("includes untracked files", async () => {
    await writeFile(join(repo, "new.ts"), "export const fresh = 1;\n");
    const changed = await getChangedFiles({ root: repo });
    expect(changed).toEqual([join(repo, "new.ts")]);
  });

  it("skips deleted files (nothing to scan on disk)", async () => {
    await rm(join(repo, "kept.ts"));
    const changed = await getChangedFiles({ root: repo });
    expect(changed).toEqual([]);
  });

  it("includes commits between <base> and HEAD when --base is passed", async () => {
    // Create a new branch off main and commit a file there.
    await git(repo, "checkout", "-b", "feature", "--quiet");
    await writeFile(join(repo, "added-on-branch.ts"), "export const x = 1;\n");
    await commitAll(repo, "add file on feature");

    // No working-tree changes, but the file differs vs main.
    const changed = await getChangedFiles({ root: repo, base: "main" });
    expect(changed).toEqual([join(repo, "added-on-branch.ts")]);
  });

  it("combines working-tree changes with base diff", async () => {
    await git(repo, "checkout", "-b", "feature", "--quiet");
    await writeFile(join(repo, "added-on-branch.ts"), "export const x = 1;\n");
    await commitAll(repo, "add file on feature");

    // Touch a third file in the working tree only.
    await writeFile(join(repo, "kept.ts"), "export const kept = 9;\n");

    const changed = await getChangedFiles({ root: repo, base: "main" });
    expect(new Set(changed)).toEqual(
      new Set([join(repo, "added-on-branch.ts"), join(repo, "kept.ts")]),
    );
  });

  it("works when called from a subdirectory inside the repo", async () => {
    await mkdir(join(repo, "src"));
    await writeFile(join(repo, "src", "a.ts"), "export const a = 1;\n");
    const changed = await getChangedFiles({ root: join(repo, "src") });
    expect(changed).toEqual([join(repo, "src", "a.ts")]);
  });

  it("throws NotAGitRepoError outside a git repo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crimes-not-a-repo-"));
    try {
      await expect(getChangedFiles({ root: dir })).rejects.toBeInstanceOf(
        NotAGitRepoError,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws UnknownGitRefError when --base does not resolve", async () => {
    await expect(
      getChangedFiles({ root: repo, base: "does-not-exist" }),
    ).rejects.toBeInstanceOf(UnknownGitRefError);
  });
});
