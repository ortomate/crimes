/**
 * One test per silent-skip path, asserting it reaches
 * `coverage.warnings` rather than vanishing. A path that can drop work
 * and has no test here is the bug this field exists to prevent.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { buildFunctionHashIndex } from "../ast-hash/function-index.js";
import { buildImportGraph } from "../imports/build.js";
import { buildJsxShapeIndex } from "../jsx/shape-index.js";
import { buildPettyIndex } from "../petty/build.js";
import { safelyBuildIaIndex } from "../indexes.js";
import { scan } from "../scan.js";
import { CoverageWarningLog } from "./coverage-warnings.js";

const execFileAsync = promisify(execFile);
const created: string[] = [];

afterEach(async () => {
  while (created.length > 0) {
    await rm(created.pop()!, { recursive: true, force: true });
  }
});

async function makeRepo(files: Record<string, string>): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "crimes-warn-wiring-")));
  created.push(dir);
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "crimes-test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "crimes-test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  await execFileAsync("git", ["init", "--initial-branch=main", "--quiet"], {
    cwd: dir,
    env,
  });
  await execFileAsync("git", ["add", "-A"], { cwd: dir, env });
  await execFileAsync("git", ["commit", "-m", "seed", "--quiet"], { cwd: dir, env });
  return dir;
}

describe("read failures reach coverage.warnings", () => {
  it("records an unreadable file from the function hash index", async () => {
    const warnings = new CoverageWarningLog();
    await buildFunctionHashIndex({
      root: "/nowhere",
      files: ["/nowhere/gone.ts"],
      warnings,
    });
    const [warning] = warnings.build();
    expect(warning?.kind).toBe("files_unreadable");
    expect(warning?.subject).toBe("ENOENT");
    expect(warning?.files).toBe(1);
  });

  it("records an unreadable file from the JSX shape index", async () => {
    const warnings = new CoverageWarningLog();
    await buildJsxShapeIndex({
      root: "/nowhere",
      files: ["/nowhere/gone.tsx"],
      warnings,
    });
    expect(warnings.build()[0]?.kind).toBe("files_unreadable");
  });

  it("records an unreadable file from the petty literal index", async () => {
    const warnings = new CoverageWarningLog();
    await buildPettyIndex({ root: "/nowhere", files: ["/nowhere/gone.ts"], warnings });
    expect(warnings.build()[0]?.kind).toBe("files_unreadable");
  });

  it("records an unreadable file from the import graph", async () => {
    const warnings = new CoverageWarningLog();
    await buildImportGraph({ root: "/nowhere", files: ["/nowhere/gone.ts"], warnings });
    expect(warnings.build()[0]?.kind).toBe("files_unreadable");
  });

  it("records an unreadable file from the IA index", async () => {
    const warnings = new CoverageWarningLog();
    await safelyBuildIaIndex({
      root: "/nowhere",
      allFiles: ["/nowhere/gone.ts"],
      warnings,
    });
    expect(warnings.build()[0]?.kind).toBe("files_unreadable");
  });
});

describe("index caps reach coverage.warnings", () => {
  it("reports how many files fell outside the import-graph cap", async () => {
    const root = await makeRepo({
      "a.ts": "export const a = 1;\n",
      "b.ts": "export const b = 2;\n",
      "c.ts": "export const c = 3;\n",
    });
    const warnings = new CoverageWarningLog();
    await buildImportGraph({
      root,
      files: [join(root, "a.ts"), join(root, "b.ts"), join(root, "c.ts")],
      maxFiles: 1,
      warnings,
    });
    const truncated = warnings.build().find((w) => w.kind === "index_truncated");
    expect(truncated?.subject).toBe("imports");
    expect(truncated?.files).toBe(2);
  });
});

describe("scan() surfaces warnings on the report", () => {
  it("names the extension nothing scanned", async () => {
    const root = await makeRepo({
      "src/App.vue": "<template><div/></template>\n",
      "src/main.ts": "export const x = 1;\n",
    });
    const report = await scan({ root });
    const vue = report.coverage?.warnings?.find((w) => w.subject === ".vue");
    expect(vue?.kind).toBe("files_not_discovered");
    expect(vue?.files).toBe(1);
  });

  it("reports a Python file that only parsed partially", async () => {
    const root = await makeRepo({
      "app.py": "def broken(:\n    return 1\n",
    });
    const report = await scan({ root });
    const partial = report.coverage?.warnings?.find(
      (w) => w.kind === "files_partial_parse",
    );
    expect(partial?.subject).toBe("language-py");
    expect(partial?.files).toBe(1);
    expect(partial?.examples).toEqual(["app.py"]);
  });

  it("omits the field entirely when nothing was skipped", async () => {
    const root = await makeRepo({ "src/main.ts": "export const x = 1;\n" });
    const report = await scan({ root });
    expect(report.coverage?.warnings).toBeUndefined();
  });
});
