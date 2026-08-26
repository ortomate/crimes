/**
 * End-to-end cover for the stale-pin warning: the real built binary,
 * against a synthetic repo carrying a triage file whose fingerprints
 * were written under the pre-0.8.0 scheme.
 *
 * The unit tests prove the classifier is right. These prove it is
 * *wired* — that the warning survives the whole CLI pipeline into both
 * output formats. The bug being fixed is that a no-op was silent, so
 * "the code exists" is not the property worth asserting; "the user sees
 * it" is.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "..", "..", "dist", "index.js");

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(args: string[], cwd: string): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && typeof error.code === "number") {
          resolvePromise({ stdout, stderr, exitCode: error.code });
          return;
        }
        if (error) {
          reject(error);
          return;
        }
        resolvePromise({ stdout, stderr, exitCode: 0 });
      },
    );
  });
}

/** Past the default 60-line body threshold, so large_function fires. */
function largeFunctionSource(name: string): string {
  const body = Array.from({ length: 200 }, (_, i) => `  const v${i} = ${i};`).join("\n");
  return `export function ${name}() {\n${body}\n  return 0;\n}\n`;
}

/**
 * A repo with two large functions and a triage file pinned to the
 * **pre-0.8.0** fingerprint shape (`<type>::<file>::<symbol>`, no claim
 * segment) — exactly what every consumer has committed today.
 */
async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "crimes-stale-pins-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src", "billing.ts"),
    largeFunctionSource("generateInvoice"),
  );
  await writeFile(join(root, "src", "clean.ts"), "export const ok = 1;\n");
  await mkdir(join(root, ".crimes"), { recursive: true });
  await writeFile(
    join(root, ".crimes", "triage.json"),
    JSON.stringify({
      schema_version: "0.7.0",
      report_type: "triage",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      entries: [
        {
          // Still reported, under `large_function/too_long::…` now.
          fingerprint: "large_function::src/billing.ts::generateInvoice",
          type: "large_function",
          file: "src/billing.ts",
          symbol: "generateInvoice",
          disposition: "wont-fix",
          reason: "Legacy invoice builder; scheduled for deletion.",
          owner: "@team",
          date: "2026-01-01",
        },
        {
          // Nothing of this type fires in that file any more.
          fingerprint: "swallowed_error::src/clean.ts::handler",
          type: "swallowed_error",
          file: "src/clean.ts",
          symbol: "handler",
          disposition: "wont-fix",
          reason: "Deliberate best-effort cleanup path.",
          owner: "@team",
          date: "2026-01-01",
        },
      ],
    }),
  );
  return root;
}

describe("crimes scan — stale triage entries", () => {
  it("reports both verdicts under --format json", async () => {
    const root = await makeRepo();
    const { stdout, exitCode } = await runCli(["scan", ".", "--format", "json"], root);
    expect(exitCode).toBe(0);

    const report = JSON.parse(stdout);
    const pins = (report.coverage?.warnings ?? []).filter(
      (w: { kind: string }) => w.kind === "triage_entries_unmatched",
    );
    expect(pins).toHaveLength(2);

    const superseded = pins.find((w: { subject: string }) => w.subject === "superseded");
    expect(superseded.entries).toBe(1);
    expect(superseded.files).toBe(1);
    expect(superseded.examples).toEqual(["src/billing.ts"]);
    expect(superseded.detail).toContain("still reported under a different fingerprint");

    const gone = pins.find(
      (w: { subject: string }) => w.subject === "no_longer_reported",
    );
    expect(gone.entries).toBe(1);
    expect(gone.detail).toContain("nothing of that kind is reported there any more");

    // The pin lapsed, so the finding it named must be visible again —
    // this is the fact the warning is claiming, asserted directly.
    const live = report.findings.find(
      (f: { fingerprint: string }) =>
        f.fingerprint === "large_function/too_long::src/billing.ts::generateInvoice",
    );
    expect(live).toBeDefined();
    expect(report.triage_hidden_count).toBeUndefined();
  });

  it("reports it in human output too", async () => {
    const root = await makeRepo();
    const { stdout } = await runCli(["scan", ".", "--no-color"], root);
    expect(stdout).toContain("stale pins: 2 recorded entries match no finding");
    expect(stdout).toContain("NOT silenced any more");
    expect(stdout).toContain("likely fixed");
  });

  it("says nothing when every entry still matches", async () => {
    const root = await makeRepo();
    // Re-pin against what the scanner actually emits today.
    await writeFile(
      join(root, ".crimes", "triage.json"),
      JSON.stringify({
        schema_version: "0.8.0",
        report_type: "triage",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        entries: [
          {
            fingerprint: "large_function/too_long::src/billing.ts::generateInvoice",
            type: "large_function",
            claim: "too_long",
            file: "src/billing.ts",
            symbol: "generateInvoice",
            disposition: "wont-fix",
            reason: "Legacy invoice builder; scheduled for deletion.",
            owner: "@team",
            date: "2026-01-01",
          },
        ],
      }),
    );

    const { stdout } = await runCli(["scan", ".", "--format", "json"], root);
    const report = JSON.parse(stdout);
    const pins = (report.coverage?.warnings ?? []).filter((w: { kind: string }) =>
      w.kind.endsWith("_entries_unmatched"),
    );
    expect(pins).toEqual([]);
    // And the re-pinned entry does its job.
    expect(report.triage_hidden_count).toBe(1);
  });

  it("does not accuse a narrowed scan of stale pins", async () => {
    const root = await makeRepo();
    await execFileAsync("git", ["init", "--initial-branch=main", "--quiet"], {
      cwd: root,
    });
    const { stdout } = await runCli(["scan", ".", "--changed", "--format", "json"], root);
    const report = JSON.parse(stdout);
    // `--changed` on a fresh repo looks at the untracked files only;
    // whatever it looked at, it must not judge entries it never read.
    const pins = (report.coverage?.warnings ?? []).filter((w: { kind: string }) =>
      w.kind.endsWith("_entries_unmatched"),
    );
    for (const pin of pins) {
      for (const example of pin.examples ?? []) {
        expect(report.changed_files).toContain(example);
      }
    }
  });
});
