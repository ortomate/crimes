import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectChurn,
  findEnclosingGitRepo,
  normaliseSince,
  parseGitLog,
} from "./churn.js";

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

/**
 * `normaliseSince` used to return a git phrase ("90 days ago"), which
 * git resolved against the **system clock** — so a churn window slid
 * under a scan that had pinned everything else. It now returns an
 * absolute instant computed from the reference clock. The tests below
 * pin the property that matters (the same tree and reference produce the
 * same window) rather than the string shape.
 */
describe("normaliseSince", () => {
  const ref = Date.parse("2026-08-11T00:00:00Z");

  it.each([
    ["90d", "2026-05-13T00:00:00.000Z"],
    ["1d", "2026-08-10T00:00:00.000Z"],
    ["2w", "2026-07-28T00:00:00.000Z"],
    [" 30D ", "2026-07-12T00:00:00.000Z"],
  ])("resolves %s against the reference instant", (input, expected) => {
    expect(normaliseSince(input, ref)).toBe(expected);
  });

  /**
   * Calendar arithmetic, not 30- and 365-day approximations: `6m` back
   * from 11 August is 11 February, and `1y` is the same date last year.
   * git's own phrases are calendar-aware and matching that is the point
   * of computing the date here instead of handing git a relative phrase.
   */
  it("uses calendar months and years, not fixed day counts", () => {
    expect(normaliseSince("6m", ref)).toBe("2026-02-11T00:00:00.000Z");
    expect(normaliseSince("1y", ref)).toBe("2025-08-11T00:00:00.000Z");
  });

  it("is a pure function of the window and the reference", () => {
    // The whole point: two calls a fortnight apart agree, and only a
    // deliberate change of reference moves the window.
    expect(normaliseSince("90d", ref)).toBe(normaliseSince("90d", ref));
    expect(normaliseSince("90d", ref + 14 * 86_400_000)).not.toBe(
      normaliseSince("90d", ref),
    );
  });

  it("passes explicit dates and phrases through unchanged", () => {
    // The caller named an absolute point; moving it is not our business.
    expect(normaliseSince("2 weeks ago", ref)).toBe("2 weeks ago");
    expect(normaliseSince("2026-01-01", ref)).toBe("2026-01-01");
  });

  it("passes through anything that doesn't match the compact pattern", () => {
    expect(normaliseSince("90days", ref)).toBe("90days");
    expect(normaliseSince("nonsense", ref)).toBe("nonsense");
  });
});

describe("parseGitLog", () => {
  it("returns an empty list for empty output", () => {
    expect(parseGitLog("")).toEqual([]);
    expect(parseGitLog("\n\n")).toEqual([]);
  });

  it("counts repeat files across multiple commits", () => {
    const output = [
      "CRIMES_COMMIT 2026-05-15T10:00:00+00:00",
      "src/a.ts",
      "src/b.ts",
      "",
      "CRIMES_COMMIT 2026-05-10T09:00:00+00:00",
      "src/a.ts",
      "",
      "CRIMES_COMMIT 2026-05-01T08:00:00+00:00",
      "src/a.ts",
      "src/c.ts",
      "",
    ].join("\n");

    const parsed = parseGitLog(output);
    const a = parsed.find((f) => f.file === "src/a.ts");
    const b = parsed.find((f) => f.file === "src/b.ts");
    const c = parsed.find((f) => f.file === "src/c.ts");

    expect(a?.changeCount).toBe(3);
    expect(a?.latestChange).toBe("2026-05-15T10:00:00+00:00");
    expect(b?.changeCount).toBe(1);
    expect(b?.latestChange).toBe("2026-05-15T10:00:00+00:00");
    expect(c?.changeCount).toBe(1);
    expect(c?.latestChange).toBe("2026-05-01T08:00:00+00:00");
  });

  it("sorts by change_count desc, then file asc", () => {
    const output = [
      "CRIMES_COMMIT 2026-05-15T10:00:00+00:00",
      "src/z.ts",
      "src/a.ts",
      "",
      "CRIMES_COMMIT 2026-05-10T09:00:00+00:00",
      "src/a.ts",
      "",
      "CRIMES_COMMIT 2026-05-01T08:00:00+00:00",
      "src/a.ts",
      "src/m.ts",
      "",
    ].join("\n");

    const parsed = parseGitLog(output);
    expect(parsed.map((p) => p.file)).toEqual([
      "src/a.ts", // 3
      "src/m.ts", // 1
      "src/z.ts", // 1
    ]);
  });

  it("ignores stray lines that appear before any commit marker", () => {
    const output = [
      "some-stray-line.ts",
      "CRIMES_COMMIT 2026-05-15T10:00:00+00:00",
      "src/a.ts",
      "",
    ].join("\n");
    const parsed = parseGitLog(output);
    expect(parsed.map((p) => p.file)).toEqual(["src/a.ts"]);
  });

  it("tolerates merge commits with no file paths", () => {
    const output = [
      "CRIMES_COMMIT 2026-05-15T10:00:00+00:00",
      "",
      "CRIMES_COMMIT 2026-05-10T09:00:00+00:00",
      "src/a.ts",
      "",
    ].join("\n");
    const parsed = parseGitLog(output);
    expect(parsed).toEqual([
      {
        file: "src/a.ts",
        changeCount: 1,
        latestChange: "2026-05-10T09:00:00+00:00",
        uniqueAuthors: 0,
      },
    ]);
  });

  it("handles CRLF line endings emitted by git on Windows", () => {
    const output = [
      "CRIMES_COMMIT 2026-05-15T10:00:00+00:00\r",
      "src/a.ts\r",
      "\r",
      "CRIMES_COMMIT 2026-05-10T09:00:00+00:00\r",
      "src/a.ts\r",
      "\r",
    ].join("\n");
    const parsed = parseGitLog(output);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.changeCount).toBe(2);
    expect(parsed[0]!.file).toBe("src/a.ts");
  });

  it("uses the newest date even when commits are not strictly ordered", () => {
    const output = [
      "CRIMES_COMMIT 2026-05-01T08:00:00+00:00",
      "src/a.ts",
      "",
      "CRIMES_COMMIT 2026-05-15T10:00:00+00:00",
      "src/a.ts",
      "",
    ].join("\n");
    const parsed = parseGitLog(output);
    expect(parsed[0]!.latestChange).toBe("2026-05-15T10:00:00+00:00");
  });
});

describe("findEnclosingGitRepo", () => {
  let repo: string;

  beforeEach(async () => {
    const raw = await mkdtemp(join(tmpdir(), "crimes-churn-enclosing-"));
    repo = await realpath(raw);
    await git(repo, "init", "--initial-branch=main", "--quiet");
    await git(repo, "config", "commit.gpgsign", "false");
    await mkdir(join(repo, "packages", "cli", "src"), { recursive: true });
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("returns the same directory when .git is present", () => {
    expect(findEnclosingGitRepo(repo)).toBe(repo);
  });

  it("walks upward to find the enclosing repo from a subdirectory", () => {
    const sub = join(repo, "packages", "cli", "src");
    expect(findEnclosingGitRepo(sub)).toBe(repo);
  });

  it("returns undefined when no .git is found above the path", async () => {
    const orphan = await mkdtemp(join(tmpdir(), "crimes-churn-orphan-"));
    const real = await realpath(orphan);
    try {
      // Tmp dirs on most systems aren't inside a git repo. If they
      // happen to be, this test is a no-op rather than a failure.
      const found = findEnclosingGitRepo(real);
      if (found !== undefined) return;
      expect(found).toBeUndefined();
    } finally {
      await rm(real, { recursive: true, force: true });
    }
  });
});

/** Minimal repo helper: create a temp dir, initialise git, write files. */
async function makeRepo(files: Record<string, string>): Promise<string> {
  const raw = await mkdtemp(join(tmpdir(), "crimes-churn-makeRepo-"));
  const root = await realpath(raw);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(join(root, rel, ".."), { recursive: true });
    await writeFile(abs, content);
  }
  return root;
}

describe("collectChurn enclosing-repo lookup", () => {
  let repo: string;

  beforeEach(async () => {
    const raw = await mkdtemp(join(tmpdir(), "crimes-churn-int-"));
    repo = await realpath(raw);
    await git(repo, "init", "--initial-branch=main", "--quiet");
    await git(repo, "config", "commit.gpgsign", "false");
    await mkdir(join(repo, "packages", "cli", "src"), { recursive: true });
    await mkdir(join(repo, "packages", "core", "src"), { recursive: true });
    await writeFile(
      join(repo, "packages", "cli", "src", "scan.ts"),
      "export const x = 1;\n",
    );
    await writeFile(
      join(repo, "packages", "core", "src", "scan.ts"),
      "export const y = 1;\n",
    );
    await writeFile(join(repo, "README.md"), "root file\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-m", "init", "--quiet");
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("finds churn when called against a subdirectory of the repo", async () => {
    const sub = join(repo, "packages", "cli");
    const result = await collectChurn({ root: sub, since: "10y" });
    expect(result.gitAvailable).toBe(true);
    const files = result.files.map((f) => f.file).sort();
    // The scan root is `packages/cli`; paths must be relative to it,
    // not to the git root.
    expect(files).toContain("src/scan.ts");
    // Files outside the scan path are dropped.
    expect(files).not.toContain("packages/core/src/scan.ts");
    expect(files).not.toContain("README.md");
  });

  it("returns repo-root-relative paths when scan root == git root", async () => {
    const result = await collectChurn({ root: repo, since: "10y" });
    expect(result.gitAvailable).toBe(true);
    const files = result.files.map((f) => f.file).sort();
    expect(files).toContain("packages/cli/src/scan.ts");
    expect(files).toContain("README.md");
  });

  /**
   * The failure this guards against is silent, which is why it lasted.
   *
   * `git log -- <pathspec>` only matches paths git has committed. A
   * symlinked scan root produces a pathspec that exists on disk and not
   * in history, so the log matches nothing, every entry is dropped, and
   * the caller gets `gitAvailable: true` with an empty file list —
   * churn 0 for every file, indistinguishable from a genuinely quiet
   * repository.
   *
   * Found in the eval harness, where `evals/fixtures/01-messy-ts-app`
   * is a symlink to `examples/messy-ts-app`: all 42 of that fixture's
   * findings scored `churn: 0`, and it supplies 70% of the deep ranking
   * aggregate. But it was never eval-specific — any scan through a
   * symlinked checkout or workspace link lost the signal the same way.
   */
  it("follows a symlinked scan root, rather than reporting zero churn", async () => {
    const link = join(repo, "linked-cli");
    await symlink(join(repo, "packages", "cli"), link, "dir");
    const viaLink = await collectChurn({ root: link, since: "10y" });
    const viaReal = await collectChurn({
      root: join(repo, "packages", "cli"),
      since: "10y",
    });
    expect(viaLink.gitAvailable).toBe(true);
    expect(viaLink.files.map((f) => f.file).sort()).toEqual(
      viaReal.files.map((f) => f.file).sort(),
    );
    // The point of the test: not merely "equal", but non-empty. Two
    // empty lists would also be equal, and that is the bug.
    expect(viaLink.files.length).toBeGreaterThan(0);
  });

  it("reports gitAvailable=false when no enclosing repo is found", async () => {
    const orphan = await mkdtemp(join(tmpdir(), "crimes-churn-orphan2-"));
    const real = await realpath(orphan);
    try {
      const result = await collectChurn({ root: real, since: "10y" });
      // If the system temp dir happens to sit inside another git repo,
      // gitAvailable will be true — skip the assertion in that case.
      if (result.gitAvailable) return;
      expect(result.gitAvailable).toBe(false);
      expect(result.files).toEqual([]);
    } finally {
      await rm(real, { recursive: true, force: true });
    }
  });
});

/**
 * A git helper that does NOT override GIT_AUTHOR_* / GIT_COMMITTER_* env
 * vars so that `-c user.name=X -c user.email=Y` args are actually honoured.
 * Explicitly *unsets* those four env vars on the child if the outer
 * environment (CI runners, Git hosting hooks) injected them, so the test
 * is reproducible across environments. Used only in the author-tracking
 * test.
 */
async function gitBare(cwd: string, ...args: string[]): Promise<void> {
  const env = { ...process.env };
  delete env.GIT_AUTHOR_NAME;
  delete env.GIT_AUTHOR_EMAIL;
  delete env.GIT_COMMITTER_NAME;
  delete env.GIT_COMMITTER_EMAIL;
  await execFileAsync("git", args, { cwd, env });
}

describe("collectChurn — author tracking", () => {
  it("counts unique committers per file across the window", async () => {
    const root = await makeRepo({ "src/a.ts": "x" });
    await gitBare(root, "init", "--initial-branch=main", "--quiet");
    await gitBare(root, "config", "commit.gpgsign", "false");
    await gitBare(root, "add", "-A");
    // Three commits, two distinct authors.
    await gitBare(
      root,
      "-c",
      "user.name=Alice",
      "-c",
      "user.email=alice@example.com",
      "commit",
      "-m",
      "c1",
      "--quiet",
    );
    await writeFile(join(root, "src/a.ts"), "y");
    await gitBare(root, "add", "-A");
    await gitBare(
      root,
      "-c",
      "user.name=Bob",
      "-c",
      "user.email=bob@example.com",
      "commit",
      "-m",
      "c2",
      "--quiet",
    );
    await writeFile(join(root, "src/a.ts"), "z");
    await gitBare(root, "add", "-A");
    await gitBare(
      root,
      "-c",
      "user.name=Alice",
      "-c",
      "user.email=alice@example.com",
      "commit",
      "-m",
      "c3",
      "--quiet",
    );

    const r = await collectChurn({ root, since: "1y" });
    const a = r.files.find((f) => f.file === "src/a.ts");
    expect(a).toBeDefined();
    expect(a!.changeCount).toBe(3);
    expect(a!.uniqueAuthors).toBe(2);
    expect(a!.latestChange).toMatch(/^\d{4}-/);

    await rm(root, { recursive: true, force: true });
  });
});
