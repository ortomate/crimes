import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * CLI surface for the working set: `--files`, `--related-to`,
 * `--related-depth`.
 *
 * The unhappy paths carry most of the weight here. A working-set flag
 * that silently narrows a scan to nothing produces a report reading "No
 * crimes detected. Suspiciously clean." — which is the most dangerous
 * wrong answer this tool can give, and the exact shape of the
 * `detectors.enable` defect that 0.19.0 shipped a fix for.
 */

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "..", "..", "dist", "index.js");

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(args: string[], cwd: string): Promise<CliResult> {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { cwd, encoding: "utf8" },
      (error, stdout, stderr) => {
        const code = error && typeof error.code === "number" ? (error.code as number) : 0;
        resolvePromise({ stdout, stderr, exitCode: code });
      },
    );
  });
}

function bigSource(imports: string[] = []): string {
  const head = imports.map((i) => `import "${i}";`).join("\n");
  return `${head}\n${Array.from({ length: 400 }, () => "// line").join("\n")}\n`;
}

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crimes-cli-ws-"));
  const files: Record<string, string> = {
    "src/a.ts": bigSource(["./b.js"]),
    "src/b.ts": bigSource(),
    "src/unrelated.ts": bigSource(),
  };
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return dir;
}

describe("crimes scan --files", () => {
  it("reports only the named files", async () => {
    const root = await makeRepo();
    const result = await runCli(
      ["scan", "--files", "src/a.ts", "--format", "json"],
      root,
    );
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout);
    expect([...new Set(report.findings.map((f: { file: string }) => f.file))]).toEqual([
      "src/a.ts",
    ]);
  });

  it("accepts a comma-separated list", async () => {
    const root = await makeRepo();
    const result = await runCli(
      ["scan", "--files", "src/a.ts,src/unrelated.ts", "--format", "json"],
      root,
    );
    const report = JSON.parse(result.stdout);
    expect(report.working_set.files).toEqual(["src/a.ts", "src/unrelated.ts"]);
  });

  it("accepts a repeated flag", async () => {
    const root = await makeRepo();
    const result = await runCli(
      ["scan", "--files", "src/a.ts", "--files", "src/unrelated.ts", "--format", "json"],
      root,
    );
    const report = JSON.parse(result.stdout);
    expect(report.working_set.files).toEqual(["src/a.ts", "src/unrelated.ts"]);
  });

  it("says loudly when a named path matched nothing", async () => {
    // Without this the report reads "No crimes detected. Suspiciously
    // clean." and the reason is buried behind "+N more reasons" in the
    // coverage line.
    const root = await makeRepo();
    const result = await runCli(["scan", "--files", "src/typo.ts", "--no-color"], root);
    expect(result.stderr).toMatch(/src\/typo\.ts/);
    expect(result.stderr).toMatch(/matched no file/i);
  });

  it("warns even under --no-color, because the user did not choose this", async () => {
    // Same rule as the gated-detector breadcrumb: --no-color asks for
    // clean diagnostics, not for silence about a scan that did less than
    // it was asked to.
    const root = await makeRepo();
    const result = await runCli(
      ["scan", "--files", "src/typo.ts", "--no-color", "--format", "json"],
      root,
    );
    expect(result.stderr).toMatch(/matched no file/i);
  });

  it("does not warn when every path matched", async () => {
    const root = await makeRepo();
    const result = await runCli(["scan", "--files", "src/a.ts", "--no-color"], root);
    expect(result.stderr).not.toMatch(/matched no file/i);
  });
});

describe("crimes scan --related-to", () => {
  it("pulls in import-graph neighbours", async () => {
    const root = await makeRepo();
    const result = await runCli(
      ["scan", "--related-to", "src/a.ts", "--format", "json"],
      root,
    );
    const report = JSON.parse(result.stdout);
    expect(report.working_set.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(report.working_set.selector).toBe("related-to");
    expect(report.working_set.depth).toBe(1);
  });

  it("rejects --related-depth without --related-to", async () => {
    const root = await makeRepo();
    const result = await runCli(["scan", "--related-depth", "2"], root);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/--related-depth only applies/);
  });

  it("rejects a non-positive --related-depth", async () => {
    const root = await makeRepo();
    const result = await runCli(
      ["scan", "--related-to", "src/a.ts", "--related-depth", "0"],
      root,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/positive integer/);
  });
});

describe("working-set selectors are mutually exclusive", () => {
  it("rejects --files with --related-to", async () => {
    const root = await makeRepo();
    const result = await runCli(
      ["scan", "--files", "src/a.ts", "--related-to", "src/b.ts"],
      root,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/Pick one/);
  });

  it("rejects --changed with --files", async () => {
    const root = await makeRepo();
    const result = await runCli(["scan", "--changed", "--files", "src/a.ts"], root);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/Pick one/);
  });
});

describe("--fail-on accepts any working set", () => {
  it("gates on --files, not only on --changed", async () => {
    // Before 0.20.0 `--fail-on` required `--changed`, which meant the
    // CI story was unavailable to anyone scoping by path.
    const root = await makeRepo();
    const result = await runCli(
      ["scan", "--files", "src/a.ts", "--fail-on", "low", "--format", "json"],
      root,
    );
    expect(result.exitCode).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.failed).toBe(true);
  });

  it("still rejects --fail-on with no working set at all", async () => {
    const root = await makeRepo();
    const result = await runCli(["scan", "--fail-on", "high"], root);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/needs a working set/);
  });
});
