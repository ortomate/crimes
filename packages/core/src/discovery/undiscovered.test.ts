import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SOURCE_INCLUDES } from "../config.js";
import { CoverageWarningLog } from "./coverage-warnings.js";
import { discoverFiles } from "./files.js";
import { collectDiscoveryWarnings } from "./undiscovered.js";

const execFileAsync = promisify(execFile);
const created: string[] = [];

afterEach(async () => {
  while (created.length > 0) {
    await rm(created.pop()!, { recursive: true, force: true });
  }
});

async function makeRepo(files: Record<string, string>): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "crimes-undiscovered-")));
  created.push(dir);
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  await execFileAsync("git", ["init", "--initial-branch=main", "--quiet"], {
    cwd: dir,
    env: GIT_ENV,
  });
  await commitAll(dir);
  return dir;
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "crimes-test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "crimes-test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

async function commitAll(dir: string): Promise<void> {
  await execFileAsync("git", ["add", "-A"], { cwd: dir, env: GIT_ENV });
  await execFileAsync("git", ["commit", "-m", "seed", "--quiet", "--allow-empty"], {
    cwd: dir,
    env: GIT_ENV,
  });
}

const EXCLUDE = ["**/dist/**"];

async function warningsFor(root: string, exclude = EXCLUDE) {
  const discovered = await discoverFiles({
    root,
    include: DEFAULT_SOURCE_INCLUDES,
    exclude,
  });
  const into = new CoverageWarningLog();
  await collectDiscoveryWarnings({
    root,
    include: DEFAULT_SOURCE_INCLUDES,
    exclude,
    discovered,
    into,
  });
  return into.build();
}

describe("collectDiscoveryWarnings", () => {
  it("reports files whose extension no include glob matches", async () => {
    // The n8n case: 1,226 .vue files that appear in no coverage field at
    // all today, because discovery never returns them and every existing
    // bucket counts only what discovery returned.
    const root = await makeRepo({
      "src/App.vue": "<template><div/></template>\n",
      "src/Page.vue": "<template><p/></template>\n",
      "src/main.ts": "export const x = 1;\n",
    });
    const warnings = await warningsFor(root);
    const vue = warnings.find((w) => w.subject === ".vue");
    expect(vue).toBeDefined();
    expect(vue?.kind).toBe("files_not_discovered");
    expect(vue?.files).toBe(2);
    expect(vue?.examples).toEqual(["src/App.vue", "src/Page.vue"]);
  });

  it("does not warn about files it did discover", async () => {
    const root = await makeRepo({ "src/main.ts": "export const x = 1;\n" });
    expect(await warningsFor(root)).toEqual([]);
  });

  it("counts files the exclude list removed, separately from unmatched ones", async () => {
    const root = await makeRepo({
      "src/main.ts": "export const x = 1;\n",
      "dist/main.js": "export const x = 1;\n",
      "dist/other.js": "export const y = 2;\n",
    });
    const warnings = await warningsFor(root);
    const excluded = warnings.find((w) => w.kind === "files_excluded");
    expect(excluded?.subject).toBe("config.exclude");
    expect(excluded?.files).toBe(2);
    expect(warnings.some((w) => w.kind === "files_not_discovered")).toBe(false);
  });

  it("aggregates one warning per extension, never one per file", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 40; i += 1) files[`t/c${i}.hbs`] = "{{x}}\n";
    const root = await makeRepo(files);
    const warnings = await warningsFor(root);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.files).toBe(40);
    expect(warnings[0]?.examples?.length).toBeLessThanOrEqual(5);
  });

  it("collapses the long tail so the list stays readable", async () => {
    const files: Record<string, string> = {};
    // 12 distinct unmatched extensions, one file each.
    for (let i = 0; i < 12; i += 1) files[`t/f${i}.x${i}`] = "x\n";
    const root = await makeRepo(files);
    const warnings = await warningsFor(root);
    expect(warnings.length).toBeLessThanOrEqual(11);
    const rollup = warnings.find((w) => w.subject === "(other extensions)");
    expect(rollup).toBeDefined();
    const total = warnings.reduce((sum, w) => sum + w.files, 0);
    expect(total).toBe(12);
  });

  it("blames the symlink, not the exclude list, for a link it never followed", async () => {
    // Regression from a real corpus run: zulip's docs/*.md are symlinks
    // to top-level files. Discovery does not follow symlinks, and the
    // first cut of this module reported them as "excluded by config" —
    // a wrong reason in the one field whose job is not being wrong.
    const root = await makeRepo({ "README.md": "# hi\n" });
    await mkdir(join(root, "docs"), { recursive: true });
    await symlink("../README.md", join(root, "docs", "readme.md"));
    await commitAll(root);
    const warnings = await warningsFor(root);
    const link = warnings.find((w) => w.kind === "files_not_followed");
    expect(link?.subject).toBe("symlink");
    expect(link?.examples).toEqual(["docs/readme.md"]);
    expect(warnings.some((w) => w.kind === "files_excluded")).toBe(false);
  });

  it("blames the dot-directory, not the include list, for a hidden .md", async () => {
    // hono carries .github/pull_request_template.md. `.md` is in the
    // default include list, so "no include pattern matched it" would be
    // a claim the report itself disproves two fields higher up. The real
    // reason is that discovery walks with `dot: false`.
    const root = await makeRepo({
      "README.md": "# hi\n",
      ".github/pull_request_template.md": "# pr\n",
    });
    const warnings = await warningsFor(root);
    const hidden = warnings.find((w) => w.kind === "files_in_hidden_path");
    expect(hidden?.subject).toBe(".github");
    expect(hidden?.examples).toEqual([".github/pull_request_template.md"]);
  });

  it("still calls an unscanned extension unscanned even inside a dot-directory", async () => {
    const root = await makeRepo({
      "main.ts": "export const x = 1;\n",
      ".github/workflows/ci.yml": "on: push\n",
    });
    const warnings = await warningsFor(root);
    expect(warnings.find((w) => w.kind === "files_not_discovered")?.subject).toBe(".yml");
    expect(warnings.some((w) => w.kind === "files_in_hidden_path")).toBe(false);
  });

  it("stays silent rather than guessing when the root is not a Git repo", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "crimes-nogit-")));
    created.push(dir);
    await writeFile(join(dir, "App.vue"), "<template/>\n", "utf8");
    expect(await warningsFor(dir)).toEqual([]);
  });
});
