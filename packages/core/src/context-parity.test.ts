import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { context } from "./context.js";
import { scan } from "./scan.js";

const temporary: string[] = [];
async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "crimes-context-parity-"));
  temporary.push(root);
  for (const [file, source] of Object.entries(files)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), source);
  }
  return root;
}
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("pre-edit briefing parity", () => {
  it("carries every authority and agent-configuration finding from the complete scan", async () => {
    const root = fileURLToPath(
      new URL("../../../examples/risky-service/", import.meta.url),
    );
    const report = await scan({ root });
    const types = new Set([
      "duplicated_policy",
      "contract_drift",
      "config_drift",
      "pass_through_abstraction",
      "dependency_provenance_gap",
      "agent_permission_sprawl",
    ]);
    const relevant = report.findings.filter((f) => types.has(f.type));
    expect(new Set(relevant.map((f) => f.type))).toEqual(types);
    for (const file of new Set(
      relevant.flatMap((f) => [f.file, ...(f.related_files ?? [])]),
    )) {
      const briefing = await context({ root, file });
      const expected = report.findings.filter(
        (f) => f.file === file || f.related_files?.includes(file),
      );
      expect(briefing.findings.map((f) => f.fingerprint)).toEqual(
        expected.map((f) => f.fingerprint),
      );
      for (const finding of briefing.findings) {
        expect(finding.scores).toEqual(
          expected.find((f) => f.fingerprint === finding.fingerprint)?.scores,
        );
      }
    }
  });

  it("honours claim disables and reports alias-importing tests", async () => {
    const root = await fixture({
      "package.json": "{}",
      "crimes.config.json": JSON.stringify({
        detectors: { disable: ["weak_test_signal/no_assertions"] },
      }),
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } },
      }),
      "src/rates.ts": "export const rate = 2;",
      "tests/billing.test.ts":
        'import { test } from "vitest"; import { rate } from "@/rates"; test("rate", () => { console.log(rate); });',
      "src/invoice.ts": 'import { rate } from "@/rates"; export const total = rate * 10;',
    });
    const test = await context({ root, file: "tests/billing.test.ts" });
    expect(test.findings.some((f) => f.claim === "no_assertions")).toBe(false);
    const briefing = await context({ root, file: "src/rates.ts" });
    expect(briefing.likely_tests).toContain("tests/billing.test.ts");
    expect(briefing.clues?.test_gap?.raw).toBe(0);
    expect(briefing.related_files[0]).toMatchObject({
      file: "src/invoice.ts",
      reason: expect.stringContaining("imports this file"),
    });
  });

  it("distinguishes an excluded target from a clean target", async () => {
    const root = await fixture({
      "crimes.config.json": JSON.stringify({ exclude: ["src/ignored.ts"] }),
      "src/ignored.ts": "export const ok = true;",
    });
    const briefing = await context({ root, file: "src/ignored.ts" });
    expect(briefing.analysis_status).toBe("not_analyzed");
    expect(briefing.agent_guidance.join(" ")).toContain("not analysed");
    expect(
      briefing.coverage?.warnings?.some((w) => w.kind === "working_set_path_unmatched"),
    ).toBe(true);
  });

  it("exposes partial parsing in a briefing", async () => {
    const root = await fixture({ "src/broken.ts": "export function broken( { return;" });
    const briefing = await context({ root, file: "src/broken.ts" });
    expect(briefing.analysis_status).toBe("partial");
    expect(
      briefing.coverage?.warnings?.some((w) => w.kind === "files_partial_parse"),
    ).toBe(true);
  });
});
