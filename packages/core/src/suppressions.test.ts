import { mkdtemp, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Finding } from "./finding.js";
import { SCHEMA_VERSION } from "./finding.js";
import {
  appendSuppression,
  compareMinor,
  countResurfacedByPinnedMinor,
  findFuturePinnedSuppressions,
  loadSuppressions,
  MalformedSuppressionsError,
  minorKey,
  partitionFindings,
  removeSuppression,
  shouldResurface,
  suppressionsForFile,
} from "./suppressions.js";
import type { SuppressionEntry } from "./suppressions.js";

async function tempPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crimes-supp-test-"));
  return join(dir, "suppressions.json");
}

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "crime_00001",
    fingerprint: "",
    type: "large_function",
    pack: "language-js",
    detector_id: "large_function.js",
    charge: "God Function",
    severity: "high",
    confidence: 0.9,
    file: "src/billing.ts",
    symbol: "generateInvoice",
    lines: [10, 200],
    summary: "long function",
    evidence: [],
    effort: "small",
    fix_shape: "extract pure helpers; keep the orchestrator thin",
    scores: { severity: 0.9, confidence: 0.9 },
    ...overrides,
  };
}

describe("loadSuppressions", () => {
  it("returns an empty list when the file does not exist", async () => {
    const path = await tempPath();
    const result = loadSuppressions(path);
    expect(result.entries).toEqual([]);
    expect(result.loaded).toBe(false);
  });

  it("round-trips a valid file", async () => {
    const path = await tempPath();
    const doc = {
      schema_version: SCHEMA_VERSION,
      report_type: "suppressions" as const,
      created_at: "2026-05-17T11:30:00.000Z",
      updated_at: "2026-05-17T11:30:00.000Z",
      suppressions: [
        {
          fingerprint: "large_function::src/billing.ts::generateInvoice",
          type: "large_function",
          file: "src/billing.ts",
          symbol: "generateInvoice",
          reason: "tracked in #1234",
          created_at: "2026-05-17T11:30:00.000Z",
        },
      ],
    };
    await writeFile(path, JSON.stringify(doc, null, 2), "utf8");

    const result = loadSuppressions(path);
    expect(result.loaded).toBe(true);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.reason).toBe("tracked in #1234");
  });

  it("throws MalformedSuppressionsError on a malformed file", async () => {
    const path = await tempPath();
    await writeFile(path, "not json", "utf8");
    expect(() => loadSuppressions(path)).toThrowError(MalformedSuppressionsError);
  });

  it("rejects missing reason field", async () => {
    const path = await tempPath();
    await writeFile(
      path,
      JSON.stringify({
        schema_version: SCHEMA_VERSION,
        report_type: "suppressions",
        created_at: "x",
        updated_at: "x",
        suppressions: [{ fingerprint: "x::y::z", type: "x", created_at: "x" }],
      }),
      "utf8",
    );
    expect(() => loadSuppressions(path)).toThrowError(MalformedSuppressionsError);
  });
});

describe("appendSuppression", () => {
  it("creates the file when it does not exist", async () => {
    const path = await tempPath();
    const result = await appendSuppression(
      path,
      {
        fingerprint: "large_function::src/a.ts::foo",
        type: "large_function",
        file: "src/a.ts",
        symbol: "foo",
        reason: "ok",
      },
      { now: () => new Date("2026-05-17T11:30:00.000Z") },
    );
    expect(result.updated).toBe(false);
    expect(existsSync(path)).toBe(true);

    const reread = loadSuppressions(path);
    expect(reread.entries).toHaveLength(1);
    expect(reread.entries[0]!.fingerprint).toBe("large_function::src/a.ts::foo");
  });

  it("appends a new entry to an existing file", async () => {
    const path = await tempPath();
    await appendSuppression(
      path,
      {
        fingerprint: "x::a.ts::foo",
        type: "x",
        reason: "one",
      },
      { now: () => new Date("2026-05-17T11:30:00.000Z") },
    );
    await appendSuppression(
      path,
      {
        fingerprint: "y::b.ts::bar",
        type: "y",
        reason: "two",
      },
      { now: () => new Date("2026-05-18T11:30:00.000Z") },
    );
    const reread = loadSuppressions(path);
    expect(reread.entries.map((e) => e.fingerprint)).toEqual([
      "x::a.ts::foo",
      "y::b.ts::bar",
    ]);
  });

  it("updates reason and bumps updated_at on an existing fingerprint", async () => {
    const path = await tempPath();
    await appendSuppression(
      path,
      {
        fingerprint: "x::a.ts::foo",
        type: "x",
        reason: "original",
      },
      { now: () => new Date("2026-05-17T11:30:00.000Z") },
    );
    const updated = await appendSuppression(
      path,
      {
        fingerprint: "x::a.ts::foo",
        type: "x",
        reason: "revised",
      },
      { now: () => new Date("2026-05-20T11:30:00.000Z") },
    );
    expect(updated.updated).toBe(true);
    const reread = loadSuppressions(path);
    expect(reread.entries).toHaveLength(1);
    expect(reread.entries[0]!.reason).toBe("revised");
    expect(reread.entries[0]!.created_at).toBe("2026-05-17T11:30:00.000Z");
    expect(updated.document.updated_at).toBe("2026-05-20T11:30:00.000Z");
  });

  it("writes pretty-printed JSON with a trailing newline", async () => {
    const path = await tempPath();
    await appendSuppression(path, {
      fingerprint: "x::a.ts::foo",
      type: "x",
      reason: "ok",
    });
    const raw = readFileSync(path, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain('  "fingerprint":');
  });
});

describe("end-to-end scan suppression", () => {
  it("removes suppressed findings + recomputes summary + sets suppressed_count", async () => {
    const { mkdtemp: mkdtempFn } = await import("node:fs/promises");
    const root = await mkdtempFn(join(tmpdir(), "crimes-scan-supp-e2e-"));
    const { writeFile: wf } = await import("node:fs/promises");

    const body = Array.from({ length: 200 }, (_, i) => `  const v${i} = ${i};`).join(
      "\n",
    );
    await wf(
      join(root, "billing.ts"),
      `export function generateInvoice() {\n${body}\n  return 0;\n}\n`,
      "utf8",
    );

    const { scan, applySuppressionsToScan, applyScanFailOn } = await import("./scan.js");
    const report = await scan({ root });
    expect(report.summary.high).toBeGreaterThan(0);

    const filtered = applySuppressionsToScan(
      report,
      [
        {
          fingerprint: "large_function::billing.ts::generateInvoice",
          type: "large_function",
          reason: "ok",
          created_at: "x",
        },
      ],
      { showSuppressed: false },
    );
    expect(filtered.suppressed_count).toBe(1);
    expect(filtered.findings.find((f) => f.type === "large_function")).toBeUndefined();

    // Gate must not fire on a suppressed finding.
    const gated = applyScanFailOn(filtered, "high");
    expect(gated.failed).toBe(false);
  });

  it("--show-suppressed retains annotated findings but gate still ignores them", async () => {
    const { applyScanFailOn, applySuppressionsToScan } = await import("./scan.js");
    const report = {
      schema_version: SCHEMA_VERSION,
      report_type: "scan" as const,
      repo: { name: "x", root: "/x" },
      summary: { total: 1, high: 1, medium: 0, low: 0 },
      findings: [makeFinding()],
    };
    const filtered = applySuppressionsToScan(
      report,
      [
        {
          fingerprint: "large_function::src/billing.ts::generateInvoice",
          type: "large_function",
          reason: "legacy",
          created_at: "x",
        },
      ],
      { showSuppressed: true },
    );
    expect(filtered.findings).toHaveLength(1);
    expect(filtered.findings[0]!.suppressed).toBe(true);
    const gated = applyScanFailOn(filtered, "high");
    expect(gated.failed).toBe(false);
  });
});

describe("partitionFindings", () => {
  it("is the identity when no suppressions are configured", () => {
    const findings = [makeFinding()];
    const { visible, suppressedCount } = partitionFindings(findings, [], {
      showSuppressed: false,
    });
    expect(visible).toEqual(findings);
    expect(suppressedCount).toBe(0);
  });

  it("removes matched findings when showSuppressed: false", () => {
    const findings = [
      makeFinding(),
      makeFinding({
        type: "large_file",
        file: "src/other.ts",
        symbol: undefined,
      }),
    ];
    const { visible, suppressedCount } = partitionFindings(
      findings,
      [
        {
          fingerprint: "large_function::src/billing.ts::generateInvoice",
          type: "large_function",
          reason: "ok",
          created_at: "x",
        },
      ],
      { showSuppressed: false },
    );
    expect(suppressedCount).toBe(1);
    expect(visible).toHaveLength(1);
    expect(visible[0]!.type).toBe("large_file");
  });

  it("annotates matched findings when showSuppressed: true", () => {
    const findings = [makeFinding()];
    const { visible, suppressedCount } = partitionFindings(
      findings,
      [
        {
          fingerprint: "large_function::src/billing.ts::generateInvoice",
          type: "large_function",
          reason: "legacy module",
          created_at: "x",
        },
      ],
      { showSuppressed: true },
    );
    expect(suppressedCount).toBe(1);
    expect(visible).toHaveLength(1);
    expect(visible[0]!.suppressed).toBe(true);
    expect(visible[0]!.suppression_reason).toBe("legacy module");
  });

  it("leaves unmatched findings untouched", () => {
    const findings = [makeFinding()];
    const { visible, suppressedCount } = partitionFindings(
      findings,
      [
        {
          fingerprint: "other_type::src/other.ts::other",
          type: "other_type",
          reason: "ok",
          created_at: "x",
        },
      ],
      { showSuppressed: false },
    );
    expect(suppressedCount).toBe(0);
    expect(visible).toEqual(findings);
  });
});

describe("removeSuppression", () => {
  const NOW_ISO = "2026-06-01T12:00:00.000Z";

  it("returns removed:false when the file is missing", async () => {
    const path = await tempPath();
    const result = await removeSuppression(
      path,
      "large_function::src/billing.ts::generateInvoice",
    );
    expect(result.removed).toBe(false);
    expect(result.document).toBeUndefined();
    expect(existsSync(path)).toBe(false);
  });

  it("returns removed:false when the fingerprint is not present", async () => {
    const path = await tempPath();
    await appendSuppression(
      path,
      {
        fingerprint: "large_function::a.ts::a",
        type: "large_function",
        reason: "tracked in #1234",
      },
      { now: () => new Date("2026-05-01T12:00:00.000Z") },
    );
    const result = await removeSuppression(path, "large_function::missing.ts::nope", {
      now: () => new Date(NOW_ISO),
    });
    expect(result.removed).toBe(false);
    expect(result.document?.suppressions).toHaveLength(1);
  });

  it("removes an existing entry, bumps updated_at, preserves created_at", async () => {
    const path = await tempPath();
    await appendSuppression(
      path,
      {
        fingerprint: "large_function::a.ts::a",
        type: "large_function",
        file: "a.ts",
        symbol: "a",
        reason: "tracked in #1234",
      },
      { now: () => new Date("2026-05-01T12:00:00.000Z") },
    );
    const before = JSON.parse(readFileSync(path, "utf8"));
    expect(before.suppressions).toHaveLength(1);
    const originalCreatedAt = before.created_at;

    const result = await removeSuppression(path, "large_function::a.ts::a", {
      now: () => new Date(NOW_ISO),
    });
    expect(result.removed).toBe(true);
    expect(result.entry?.fingerprint).toBe("large_function::a.ts::a");

    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after.suppressions).toEqual([]);
    expect(after.created_at).toBe(originalCreatedAt);
    expect(after.updated_at).toBe(NOW_ISO);
  });

  it("leaves other entries untouched", async () => {
    const path = await tempPath();
    await appendSuppression(path, {
      fingerprint: "large_function::a.ts::a",
      type: "large_function",
      reason: "tracked in #1234",
    });
    await appendSuppression(path, {
      fingerprint: "large_function::b.ts::b",
      type: "large_function",
      reason: "tracked in #5678",
    });

    const result = await removeSuppression(path, "large_function::a.ts::a", {
      now: () => new Date(NOW_ISO),
    });
    expect(result.removed).toBe(true);

    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after.suppressions).toHaveLength(1);
    expect(after.suppressions[0].fingerprint).toBe("large_function::b.ts::b");
  });
});

describe("minorKey + compareMinor", () => {
  it("strips patch from semver-shaped strings", () => {
    expect(minorKey("0.7")).toBe("0.7");
    expect(minorKey("0.7.0")).toBe("0.7");
    expect(minorKey("0.7.42")).toBe("0.7");
    expect(minorKey("1.2.3-beta")).toBe("1.2");
  });

  it("returns input unchanged when unparseable", () => {
    expect(minorKey("v0.7")).toBe("v0.7");
    expect(minorKey("not-a-version")).toBe("not-a-version");
  });

  it("orders by major then minor, treating different patches as equal", () => {
    expect(compareMinor("0.6.5", "0.7.0")).toBe(-1);
    expect(compareMinor("0.7.0", "0.7.5")).toBe(0);
    expect(compareMinor("1.0.0", "0.99.99")).toBe(1);
    expect(compareMinor("0.7", "0.7.99")).toBe(0);
  });

  it("treats unparseable versions as same-minor (conservative)", () => {
    expect(compareMinor("junk", "0.7.0")).toBe(0);
  });
});

describe("shouldResurface", () => {
  it("returns false for manual suppressions (never resurface)", () => {
    expect(
      shouldResurface(
        {
          fingerprint: "x",
          type: "x",
          reason: "r",
          created_at: "x",
          source: "manual",
          crimes_version_pinned: "0.6",
        },
        "0.7.0",
      ),
    ).toBe(false);
    // Also: no `source` field at all (the 0.5.0 / 0.6.0 file shape).
    expect(
      shouldResurface(
        {
          fingerprint: "x",
          type: "x",
          reason: "r",
          created_at: "x",
        },
        "0.7.0",
      ),
    ).toBe(false);
  });

  it("returns false for feedback entries with no pinned version (malformed, treat as quiet)", () => {
    expect(
      shouldResurface(
        {
          fingerprint: "x",
          type: "x",
          reason: "r",
          created_at: "x",
          source: "feedback",
        },
        "0.7.0",
      ),
    ).toBe(false);
  });

  it("returns true when a feedback pin is older than the current minor", () => {
    expect(
      shouldResurface(
        {
          fingerprint: "x",
          type: "x",
          reason: "r",
          created_at: "x",
          source: "feedback",
          crimes_version_pinned: "0.6",
        },
        "0.7.0",
      ),
    ).toBe(true);
  });

  it("returns false when pin minor matches current minor (any patch)", () => {
    expect(
      shouldResurface(
        {
          fingerprint: "x",
          type: "x",
          reason: "r",
          created_at: "x",
          source: "feedback",
          crimes_version_pinned: "0.7",
        },
        "0.7.5",
      ),
    ).toBe(false);
  });

  it("returns false when pin is from the future (downgrade scenario)", () => {
    expect(
      shouldResurface(
        {
          fingerprint: "x",
          type: "x",
          reason: "r",
          created_at: "x",
          source: "feedback",
          crimes_version_pinned: "0.8",
        },
        "0.7.0",
      ),
    ).toBe(false);
  });
});

describe("findFuturePinnedSuppressions", () => {
  it("returns only feedback entries whose pin is later than current", () => {
    const entries = [
      {
        fingerprint: "future",
        type: "x",
        reason: "r",
        created_at: "x",
        source: "feedback" as const,
        crimes_version_pinned: "0.8",
      },
      {
        fingerprint: "current",
        type: "x",
        reason: "r",
        created_at: "x",
        source: "feedback" as const,
        crimes_version_pinned: "0.7",
      },
      {
        fingerprint: "old",
        type: "x",
        reason: "r",
        created_at: "x",
        source: "feedback" as const,
        crimes_version_pinned: "0.6",
      },
      {
        fingerprint: "manual-future-pin",
        type: "x",
        reason: "r",
        created_at: "x",
        crimes_version_pinned: "0.9",
      },
    ];
    const result = findFuturePinnedSuppressions(entries, "0.7.0");
    expect(result.map((e) => e.fingerprint)).toEqual(["future"]);
  });
});

describe("partitionFindings — resurface (0.7.0)", () => {
  function feedbackFinding(): Finding {
    return makeFinding({
      type: "direct_date",
      file: "src/billing.ts",
      symbol: undefined,
    });
  }

  it("silences a feedback suppression whose pin matches the current minor", () => {
    const { visible, suppressedCount, resurfacedCount } = partitionFindings(
      [feedbackFinding()],
      [
        {
          fingerprint: "direct_date::src/billing.ts::",
          type: "direct_date",
          reason: "Test-file injection — intentional",
          created_at: "x",
          source: "feedback",
          crimes_version_pinned: "0.7",
        },
      ],
      { showSuppressed: false, crimesVersion: "0.7.0" },
    );
    expect(visible).toHaveLength(0);
    expect(suppressedCount).toBe(1);
    expect(resurfacedCount).toBe(0);
  });

  it("resurfaces a feedback suppression whose pin is older than the current minor", () => {
    const { visible, suppressedCount, resurfacedCount, resurfacedByPinnedMinor } =
      partitionFindings(
        [feedbackFinding()],
        [
          {
            fingerprint: "direct_date::src/billing.ts::",
            type: "direct_date",
            reason: "Test-file injection — intentional",
            created_at: "x",
            source: "feedback",
            crimes_version_pinned: "0.6",
          },
        ],
        { showSuppressed: false, crimesVersion: "0.7.0" },
      );
    expect(visible).toHaveLength(1);
    expect(visible[0]!.previously_suppressed).toBe(true);
    expect(visible[0]!.previous_suppression).toEqual({
      pinned_version: "0.6",
      reason: "Test-file injection — intentional",
    });
    expect(suppressedCount).toBe(0);
    expect(resurfacedCount).toBe(1);
    expect(resurfacedByPinnedMinor).toEqual({ "0.6": 1 });
  });

  it("never resurfaces a manual suppression, regardless of version mismatch", () => {
    const { visible, suppressedCount, resurfacedCount } = partitionFindings(
      [feedbackFinding()],
      [
        {
          fingerprint: "direct_date::src/billing.ts::",
          type: "direct_date",
          reason: "legacy module",
          created_at: "x",
          source: "manual",
          crimes_version_pinned: "0.5",
        },
      ],
      { showSuppressed: false, crimesVersion: "0.7.0" },
    );
    expect(visible).toHaveLength(0);
    expect(suppressedCount).toBe(1);
    expect(resurfacedCount).toBe(0);
  });

  it("silences a future-pinned feedback suppression and records a warning", () => {
    const { visible, suppressedCount, resurfacedCount, futurePinnedWarnings } =
      partitionFindings(
        [feedbackFinding()],
        [
          {
            fingerprint: "direct_date::src/billing.ts::",
            type: "direct_date",
            reason: "from the future",
            created_at: "x",
            source: "feedback",
            crimes_version_pinned: "0.8",
          },
        ],
        { showSuppressed: false, crimesVersion: "0.7.0" },
      );
    expect(visible).toHaveLength(0);
    expect(suppressedCount).toBe(1);
    expect(resurfacedCount).toBe(0);
    expect(futurePinnedWarnings).toHaveLength(1);
    expect(futurePinnedWarnings[0]).toContain("0.8");
    expect(futurePinnedWarnings[0]).toContain("0.7.0");
  });

  it("no resurfacing when crimesVersion is absent (back-compat path)", () => {
    const { visible, suppressedCount, resurfacedCount } = partitionFindings(
      [feedbackFinding()],
      [
        {
          fingerprint: "direct_date::src/billing.ts::",
          type: "direct_date",
          reason: "x",
          created_at: "x",
          source: "feedback",
          crimes_version_pinned: "0.6",
        },
      ],
      { showSuppressed: false },
    );
    expect(visible).toHaveLength(0);
    expect(suppressedCount).toBe(1);
    expect(resurfacedCount).toBe(0);
  });

  it("groups multiple resurfaced entries by pinned minor", () => {
    const findings: Finding[] = [
      makeFinding({ type: "direct_date", file: "a.ts", symbol: undefined }),
      makeFinding({ type: "direct_date", file: "b.ts", symbol: undefined }),
      makeFinding({ type: "direct_date", file: "c.ts", symbol: undefined }),
    ];
    const { resurfacedByPinnedMinor, resurfacedCount } = partitionFindings(
      findings,
      [
        {
          fingerprint: "direct_date::a.ts::",
          type: "direct_date",
          reason: "r",
          created_at: "x",
          source: "feedback",
          crimes_version_pinned: "0.6",
        },
        {
          fingerprint: "direct_date::b.ts::",
          type: "direct_date",
          reason: "r",
          created_at: "x",
          source: "feedback",
          crimes_version_pinned: "0.6.3",
        },
        {
          fingerprint: "direct_date::c.ts::",
          type: "direct_date",
          reason: "r",
          created_at: "x",
          source: "feedback",
          crimes_version_pinned: "0.5",
        },
      ],
      { showSuppressed: false, crimesVersion: "0.7.0" },
    );
    expect(resurfacedCount).toBe(3);
    expect(resurfacedByPinnedMinor).toEqual({ "0.6": 2, "0.5": 1 });
  });
});

describe("countResurfacedByPinnedMinor", () => {
  it("walks findings and groups by pinned minor", () => {
    const findings: Finding[] = [
      {
        ...makeFinding({ file: "a.ts" }),
        previously_suppressed: true,
        previous_suppression: { pinned_version: "0.6", reason: "r" },
      },
      {
        ...makeFinding({ file: "b.ts" }),
        previously_suppressed: true,
        previous_suppression: { pinned_version: "0.6.3", reason: "r" },
      },
      makeFinding({ file: "c.ts" }), // not resurfaced
    ];
    expect(countResurfacedByPinnedMinor(findings)).toEqual({ "0.6": 2 });
  });

  it("returns empty record when nothing is resurfaced", () => {
    expect(countResurfacedByPinnedMinor([makeFinding()])).toEqual({});
  });
});

describe("0.5.0 / 0.6.0 file back-compat", () => {
  it("reads a suppressions file with no `source` / `crimes_version_pinned`", async () => {
    const path = await tempPath();
    const doc = {
      schema_version: SCHEMA_VERSION,
      report_type: "suppressions" as const,
      created_at: "2026-04-01T00:00:00.000Z",
      updated_at: "2026-04-01T00:00:00.000Z",
      suppressions: [
        {
          fingerprint: "large_function::src/x.ts::foo",
          type: "large_function",
          file: "src/x.ts",
          symbol: "foo",
          reason: "legacy",
          created_at: "2026-04-01T00:00:00.000Z",
        },
      ],
    };
    await writeFile(path, JSON.stringify(doc, null, 2), "utf8");
    const loaded = loadSuppressions(path);
    expect(loaded.entries).toHaveLength(1);
    expect(loaded.entries[0]!.source).toBeUndefined();
    expect(loaded.entries[0]!.crimes_version_pinned).toBeUndefined();
  });

  it("appendSuppression can write new source + crimes_version_pinned fields", async () => {
    const path = await tempPath();
    await appendSuppression(
      path,
      {
        fingerprint: "direct_date::src/x.ts::",
        type: "direct_date",
        reason: "test-file injection",
        source: "feedback",
        crimes_version_pinned: "0.7",
      },
      { now: () => new Date("2026-05-20T12:00:00.000Z") },
    );
    const reread = loadSuppressions(path);
    expect(reread.entries).toHaveLength(1);
    expect(reread.entries[0]!.source).toBe("feedback");
    expect(reread.entries[0]!.crimes_version_pinned).toBe("0.7");
  });
});

describe("suppressionsForFile", () => {
  const FILE_PATH = "src/billing.ts";
  const OTHER_FILE = "src/other.ts";

  const entryForFile: SuppressionEntry = {
    fingerprint: "large_function::src/billing.ts::generateInvoice",
    type: "large_function",
    file: FILE_PATH,
    reason: "tracked in #1234",
    created_at: "2026-05-17T11:30:00.000Z",
    crimes_version_pinned: "0.9",
  };

  const entryOtherFile: SuppressionEntry = {
    fingerprint: "large_file::src/other.ts::",
    type: "large_file",
    file: OTHER_FILE,
    reason: "too big for now",
    created_at: "2026-05-17T11:30:00.000Z",
    crimes_version_pinned: "0.9",
  };

  const entryByPrint: SuppressionEntry = {
    // No `file` field — fingerprint-scoped only.
    fingerprint: "direct_date::src/billing.ts::",
    type: "direct_date",
    reason: "injected for tests",
    created_at: "2026-05-17T11:30:00.000Z",
    crimes_version_pinned: "0.8",
  };

  const findingOnFile: Finding = {
    id: "crime_00001",
    fingerprint: "",
    type: "large_function",
    pack: "language-js",
    detector_id: "large_function.js",
    charge: "God Function",
    severity: "high",
    confidence: 0.9,
    file: FILE_PATH,
    symbol: "generateInvoice",
    lines: [10, 200],
    summary: "long function",
    evidence: [],
    effort: "small",
    fix_shape: "extract pure helpers; keep the orchestrator thin",
    scores: { severity: 0.9, confidence: 0.9 },
  };

  const findingDateOnFile: Finding = {
    id: "crime_00002",
    fingerprint: "",
    type: "direct_date",
    pack: "language-js",
    detector_id: "direct_date.js",
    charge: "Temporal Recklessness",
    severity: "low",
    confidence: 0.8,
    file: FILE_PATH,
    symbol: undefined,
    lines: [5, 5],
    summary: "uses Date.now()",
    evidence: [],
    effort: "small",
    fix_shape: "inject a clock; pass through the domain boundary",
    scores: { severity: 0.45, confidence: 0.8 },
  };

  it("returns entries scoped to the file by the `file` field", () => {
    const result = suppressionsForFile([entryForFile, entryOtherFile], FILE_PATH, []);
    expect(result).toHaveLength(1);
    expect(result[0]!.fingerprint).toBe(entryForFile.fingerprint);
    expect(result[0]!.detector).toBe("large_function");
    expect(result[0]!.reason).toBe("tracked in #1234");
    expect(result[0]!.pinned_version).toBe("0.9");
    // The finding isn't in currentFindings, so matches_current_finding is false.
    expect(result[0]!.matches_current_finding).toBe(false);
  });

  it("returns entries scoped by fingerprint match (no `file` field)", () => {
    // entryByPrint has no `file` field; it should be included only when
    // its fingerprint appears in currentFindings.
    const result = suppressionsForFile([entryByPrint, entryOtherFile], FILE_PATH, [
      findingDateOnFile,
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]!.fingerprint).toBe(entryByPrint.fingerprint);
    expect(result[0]!.detector).toBe("direct_date");
    expect(result[0]!.matches_current_finding).toBe(true);
  });

  it("sets matches_current_finding correctly", () => {
    // entryForFile points at FILE_PATH. findingOnFile is in currentFindings
    // and has a matching fingerprint.
    const result = suppressionsForFile([entryForFile], FILE_PATH, [findingOnFile]);
    expect(result).toHaveLength(1);
    expect(result[0]!.matches_current_finding).toBe(true);
  });

  it("sets matches_current_finding false when no current finding matches the fingerprint", () => {
    const result = suppressionsForFile(
      [entryForFile],
      FILE_PATH,
      [], // no current findings
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.matches_current_finding).toBe(false);
  });

  it("output is sorted deterministically by fingerprint ascending", () => {
    const entryZ: SuppressionEntry = {
      fingerprint: "zzz::src/billing.ts::z",
      type: "zzz",
      file: FILE_PATH,
      reason: "z",
      created_at: "2026-05-17T11:30:00.000Z",
    };
    const entryA: SuppressionEntry = {
      fingerprint: "aaa::src/billing.ts::a",
      type: "aaa",
      file: FILE_PATH,
      reason: "a",
      created_at: "2026-05-17T11:30:00.000Z",
    };
    const result = suppressionsForFile([entryZ, entryA], FILE_PATH, []);
    expect(result.map((r) => r.fingerprint)).toEqual([
      "aaa::src/billing.ts::a",
      "zzz::src/billing.ts::z",
    ]);
  });

  it("returns empty array when no entries match this file", () => {
    const result = suppressionsForFile([entryOtherFile], FILE_PATH, []);
    expect(result).toHaveLength(0);
  });

  it("returns empty array when entries list is empty", () => {
    const result = suppressionsForFile([], FILE_PATH, [findingOnFile]);
    expect(result).toHaveLength(0);
  });

  it("uses empty string for pinned_version when crimes_version_pinned is absent", () => {
    const entryNoPinned: SuppressionEntry = {
      fingerprint: "large_function::src/billing.ts::generateInvoice",
      type: "large_function",
      file: FILE_PATH,
      reason: "old entry",
      created_at: "2026-05-17T11:30:00.000Z",
      // no crimes_version_pinned
    };
    const result = suppressionsForFile([entryNoPinned], FILE_PATH, []);
    expect(result[0]!.pinned_version).toBe("");
  });
});
