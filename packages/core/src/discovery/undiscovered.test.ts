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

  it("blames the never-walked directory, not the include list, for a file inside it", async () => {
    // `.tox` is on discovery's NEVER_WALK list, so a committed `.py`
    // inside it is missed for a reason the include list cannot explain —
    // `.py` is in `DEFAULT_SOURCE_INCLUDES`, and saying "no include
    // pattern matched it" would be a claim the report disproves two
    // fields higher up.
    const root = await makeRepo({
      "main.py": "x = 1\n",
      ".tox/py311/helper.py": "y = 2\n",
    });
    const warnings = await warningsFor(root);
    const hidden = warnings.find((w) => w.kind === "files_in_hidden_path");
    expect(hidden?.subject).toBe(".tox");
    expect(hidden?.examples).toEqual([".tox/py311/helper.py"]);
  });

  it("does not blame a dot-directory that discovery actually walks", async () => {
    // Discovery has walked dot-directories since 0.17.1 (`dot: true`), so
    // `.github/pull_request_template.md` is *found*, not missed. An
    // earlier revision of this test asserted the opposite; it was written
    // against a tree where discovery still used `dot: false`.
    const root = await makeRepo({
      "README.md": "# hi\n",
      ".github/pull_request_template.md": "# pr\n",
    });
    const warnings = await warningsFor(root);
    expect(warnings.some((w) => w.kind === "files_in_hidden_path")).toBe(false);
  });

  it("still calls an unscanned extension unscanned even inside a dot-directory", async () => {
    // `.vue`, not `.yml`: YAML became discoverable in 0.18.1 when the
    // structured-data extensions were added to DEFAULT_SOURCE_INCLUDES.
    const root = await makeRepo({
      "main.ts": "export const x = 1;\n",
      ".github/components/Widget.vue": "<template/>\n",
    });
    const warnings = await warningsFor(root);
    expect(warnings.find((w) => w.kind === "files_not_discovered")?.subject).toBe(".vue");
    expect(warnings.some((w) => w.kind === "files_in_hidden_path")).toBe(false);
  });

  it("stays silent rather than guessing when the root is not a Git repo", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "crimes-nogit-")));
    created.push(dir);
    await writeFile(join(dir, "App.vue"), "<template/>\n", "utf8");
    expect(await warningsFor(dir)).toEqual([]);
  });
});
