import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { explain, UnknownFindingError } from "./explain.js";
import { scan } from "./scan.js";

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "crimes-explain-test-"));
  const body = Array.from(
    { length: 200 },
    (_, i) => `  const v${i} = ${i};`,
  ).join("\n");
  await writeFile(
    join(root, "billing.ts"),
    `export function generateInvoice() {\n${body}\n  return 0;\n}\n`,
    "utf8",
  );
  return root;
}

describe("explain", () => {
  it("resolves a finding by stable fingerprint via fresh scan", async () => {
    const root = await makeRepo();
    const report = await explain(
      "large_function::billing.ts::generateInvoice",
      { root },
    );
    expect(report.report_type).toBe("explain");
    expect(report.detector.type).toBe("large_function");
    expect(report.detector.charge).toBe("God Function");
    expect(report.why_it_matters.length).toBeGreaterThan(0);
    expect(report.likely_remedies.length).toBeGreaterThan(0);
    expect(report.likely_remedies.join(" ")).toContain("configure the detector");
    expect(report.suggested_suppression_command).toContain(
      "crimes ignore large_function::billing.ts::generateInvoice",
    );
    expect(report.suggested_suppression_command).toContain("--reason");
  });

  it("resolves a finding by per-scan id from a passed-in ScanReport", async () => {
    const root = await makeRepo();
    const scanReport = await scan({ root });
    const targetId = scanReport.findings[0]!.id;
    const explained = await explain(targetId, { root, from: scanReport });
    expect(explained.finding.id).toBe(targetId);
  });

  it("throws UnknownFindingError for an id that does not exist", async () => {
    const root = await makeRepo();
    await expect(
      explain("crime_99999", { root }),
    ).rejects.toBeInstanceOf(UnknownFindingError);
  });

  it("throws UnknownFindingError for a fingerprint that does not exist", async () => {
    const root = await makeRepo();
    await expect(
      explain("large_function::missing.ts::nope", { root }),
    ).rejects.toBeInstanceOf(UnknownFindingError);
  });

  it("ExplainReport carries detector description and why_it_matters", async () => {
    const root = await makeRepo();
    const report = await explain(
      "large_function::billing.ts::generateInvoice",
      { root },
    );
    expect(report.detector.description).toContain("per-shape line threshold");
    expect(report.why_it_matters).toContain("Functions this large");
  });

  it("describes the Python detector, not the JS one of the same type", async () => {
    // `type` is the abstract charge and is shared across packs, so a
    // lookup by type returns whichever pack registered first. Before
    // 0.14.0 that was harmless; now it would tell a Python user their
    // finding is about `getUTCHours`, which does not exist in Python.
    const root = await mkdtemp(join(tmpdir(), "crimes-explain-py-"));
    await mkdir(join(root, "domain"), { recursive: true });
    await writeFile(
      join(root, "domain", "billing.py"),
      "from datetime import datetime\n" +
        "start = datetime.utcnow()\n" +
        "end = datetime.now()\n",
      "utf8",
    );
    const report = await explain(
      "mixed_utc_local_methods::domain/billing.py::",
      { root },
    );
    expect(report.detector.type).toBe("mixed_utc_local_methods.py");
    expect(report.detector.description).toContain("utcnow");
    expect(report.detector.description).not.toContain("getUTCHours");
    expect(report.why_it_matters).toContain("naive datetimes");
  });
});
