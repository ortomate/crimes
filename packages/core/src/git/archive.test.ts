import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportRefToTempDir, withRefCheckout } from "./archive.js";
import { NotAGitRepoError, UnknownGitRefError } from "./changed-files.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
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
  const raw = await mkdtemp(join(tmpdir(), "crimes-archive-test-"));
  const dir = await realpath(raw);
  await git(dir, "init", "--initial-branch=main", "--quiet");
  await git(dir, "config", "commit.gpgsign", "false");
  return dir;
}

describe("exportRefToTempDir", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await makeRepo();
    await writeFile(join(repo, "a.ts"), "export const a = 1;\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-m", "init", "--quiet");
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("exports the committed tree of HEAD into a fresh temp directory", async () => {
    const out = await exportRefToTempDir({ repoRoot: repo, ref: "HEAD" });
    try {
      const content = await readFile(join(out, "a.ts"), "utf8");
      expect(content).toBe("export const a = 1;\n");
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it("exports the state at a specific commit, not the working tree", async () => {
    // Take the SHA *before* mutating, so we know what we're asking for.
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
    });
    const baseSha = stdout.trim();

    // Mutate working tree + add a second commit.
    await writeFile(join(repo, "a.ts"), "export const a = 999;\n");
    await writeFile(join(repo, "b.ts"), "export const b = 2;\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-m", "second", "--quiet");

    const out = await exportRefToTempDir({ repoRoot: repo, ref: baseSha });
    try {
      const a = await readFile(join(out, "a.ts"), "utf8");
      expect(a).toBe("export const a = 1;\n"); // the *base* state
      expect(existsSync(join(out, "b.ts"))).toBe(false);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it("throws NotAGitRepoError outside a git repo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crimes-not-a-repo-"));
    try {
      await expect(
        exportRefToTempDir({ repoRoot: dir, ref: "HEAD" }),
      ).rejects.toBeInstanceOf(NotAGitRepoError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws UnknownGitRefError for an unknown ref", async () => {
    await expect(
      exportRefToTempDir({ repoRoot: repo, ref: "definitely-not-a-ref" }),
    ).rejects.toBeInstanceOf(UnknownGitRefError);
  });
});

describe("withRefCheckout", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await makeRepo();
    await writeFile(join(repo, "a.ts"), "export const a = 1;\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-m", "init", "--quiet");
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("cleans up the temp dir after the callback runs", async () => {
    let captured = "";
    await withRefCheckout({ repoRoot: repo, ref: "HEAD" }, async (dir) => {
      captured = dir;
      expect(existsSync(join(dir, "a.ts"))).toBe(true);
    });
    expect(existsSync(captured)).toBe(false);
  });

  it("cleans up the temp dir even when the callback throws", async () => {
    let captured = "";
    await expect(
      withRefCheckout({ repoRoot: repo, ref: "HEAD" }, async (dir) => {
        captured = dir;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(captured)).toBe(false);
  });
});
