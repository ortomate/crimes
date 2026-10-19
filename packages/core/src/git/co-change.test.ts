import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { context } from "../context.js";
import { collectCoChanges } from "./co-change.js";

async function repoWithHistory(commits: Record<string, string>[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "crimes-cochange-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.invalid",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.invalid",
      },
    });
  git("init", "-q");
  for (const [i, files] of commits.entries()) {
    for (const [path, body] of Object.entries(files)) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), body);
    }
    git("add", "-A");
    git("commit", "-q", "-m", `c${i}`);
  }
  return root;
}

describe("collectCoChanges", () => {
  it("counts files changed with the target, ignoring one-offs and sweeps", async () => {
    const sweep = Object.fromEntries(
      Array.from({ length: 45 }, (_, i) => [`gen/f${i}.ts`, `export const v${i} = 1;\n`]),
    );
    const root = await repoWithHistory([
      { "src/order.ts": "export const a = 1;\n", "src/order-service.ts": "1\n" },
      {
        "src/order.ts": "export const a = 2;\n",
        "src/order-service.ts": "2\n",
        "src/once.ts": "1\n",
      },
      { "src/order.ts": "export const a = 3;\n", "src/admin/order-action.ts": "1\n" },
      { "src/order.ts": "export const a = 4;\n", "src/admin/order-action.ts": "2\n" },
      { "src/order.ts": "export const a = 5;\n", ...sweep },
    ]);
    const result = await collectCoChanges({ root, fileRel: "src/order.ts" });
    expect(result.inspected).toBe(5);
    expect(result.files).toEqual([
      { file: "src/admin/order-action.ts", commits: 2 },
      { file: "src/order-service.ts", commits: 2 },
    ]);
  });

  it("returns nothing outside a git repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "crimes-nogit-"));
    expect(await collectCoChanges({ root, fileRel: "a.ts" })).toEqual({
      inspected: 0,
      files: [],
    });
  });

  it("puts co-changed files in a context briefing with their reason", async () => {
    const root = await repoWithHistory([
      { "src/order.ts": "export const a = 1;\n", "src/admin/order-action.ts": "1\n" },
      { "src/order.ts": "export const a = 2;\n", "src/admin/order-action.ts": "2\n" },
    ]);
    const report = await context({ root, file: "src/order.ts" });
    const related = report.related_files.find(
      (r) => r.file === "src/admin/order-action.ts",
    );
    expect(related?.reason).toContain(
      "changed with this file in 2 of its last 2 commits",
    );
  });
});
