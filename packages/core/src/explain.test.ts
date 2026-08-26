import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { explain, UnknownFindingError } from "./explain.js";
import { scan } from "./scan.js";

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "crimes-explain-test-"));
  const body = Array.from({ length: 200 }, (_, i) => `  const v${i} = ${i};`).join("\n");
  await writeFile(
    join(root, "billing.ts"),
    `export function generateInvoice() {\n${body}\n  return 0;\n}\n`,
    "utf8",
  );
  return root;
}

/**
 * A structurally valid PNG padded past the 1 MB `oversized_raster`
 * high threshold with one big ancillary chunk. The detector reads
 * `byteSize` only, so the padding is all that matters.
 */
function oversizedPng(): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(8, 0);
  ihdr.writeUInt32BE(8, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("tEXt", Buffer.concat([Buffer.from("pad\0"), Buffer.alloc(1_400_000, 0x78)])),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("explain", () => {
  it("resolves a finding by stable fingerprint via fresh scan", async () => {
    const root = await makeRepo();
    const report = await explain("large_function/too_long::billing.ts::generateInvoice", {
      root,
    });
    expect(report.report_type).toBe("explain");
    expect(report.detector.type).toBe("large_function");
    expect(report.detector.charge).toBe("God Function");
    expect(report.why_it_matters.length).toBeGreaterThan(0);
    expect(report.likely_remedies.length).toBeGreaterThan(0);
    expect(report.likely_remedies.join(" ")).toContain("configure the detector");
    expect(report.suggested_suppression_command).toContain(
      "crimes ignore 'large_function/too_long::billing.ts::generateInvoice'",
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
    await expect(explain("crime_99999", { root })).rejects.toBeInstanceOf(
      UnknownFindingError,
    );
  });

  it("throws UnknownFindingError for a fingerprint that does not exist", async () => {
    const root = await makeRepo();
    await expect(
      explain("large_function/too_long::missing.ts::nope", { root }),
    ).rejects.toBeInstanceOf(UnknownFindingError);
  });

  it("ExplainReport carries detector description and why_it_matters", async () => {
    const root = await makeRepo();
    const report = await explain("large_function/too_long::billing.ts::generateInvoice", {
      root,
    });
    expect(report.detector.description).toContain("per-shape line threshold");
    expect(report.why_it_matters).toContain("Functions this large");
  });

  it("explains an asset-detector finding instead of exiting on it", async () => {
    // Asset detectors live in `builtInAssetDetectors`, a list `explain`
    // never searched — so every `oversized_raster`,
    // `raster_should_be_vector` and `svg_with_embedded_raster` finding
    // the scanner emitted was unexplainable, exit 2.
    const root = await mkdtemp(join(tmpdir(), "crimes-explain-asset-"));
    await writeFile(join(root, "hero.png"), oversizedPng(), null);
    const report = await explain("oversized_raster::hero.png::", { root });
    expect(report.detector.type).toBe("oversized_raster");
    expect(report.detector.description).toContain("raster images");
    expect(report.why_it_matters).toContain("Core Web Vitals");
  });

  it("quotes the suggested ignore command so it survives a copy-paste", async () => {
    // The fingerprint embeds the file path. Unquoted, a path with a
    // space turns one argument into three and the pasted command fails
    // — or worse, silently ignores the wrong thing.
    const root = await mkdtemp(join(tmpdir(), "crimes-explain-quote-"));
    await mkdir(join(root, "my src"), { recursive: true });
    const body = Array.from({ length: 200 }, (_, i) => `  const v${i} = ${i};`).join(
      "\n",
    );
    await writeFile(
      join(root, "my src", "big file.ts"),
      `export function generateInvoice() {\n${body}\n  return 0;\n}\n`,
      "utf8",
    );
    const report = await explain(
      "large_function/too_long::my src/big file.ts::generateInvoice",
      {
        root,
      },
    );
    expect(report.suggested_suppression_command).toContain(
      "'large_function/too_long::my src/big file.ts::generateInvoice'",
    );
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
    const report = await explain("mixed_utc_local_methods::domain/billing.py::", {
      root,
    });
    expect(report.detector.type).toBe("mixed_utc_local_methods.py");
    expect(report.detector.description).toContain("utcnow");
    expect(report.detector.description).not.toContain("getUTCHours");
    expect(report.why_it_matters).toContain("naive datetimes");
  });
});
