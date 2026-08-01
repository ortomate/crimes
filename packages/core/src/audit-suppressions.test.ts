import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  auditSuppressions,
  SUPPRESSION_MIN_REASON_LENGTH,
  SUPPRESSION_STALE_AGE_DAYS,
} from "./audit-suppressions.js";
import { SCHEMA_VERSION } from "./finding.js";
import { MalformedSuppressionsError } from "./suppressions.js";

const NOW_ISO = "2026-05-17T12:00:00.000Z";
const NOW = () => new Date(NOW_ISO);

async function tempRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "crimes-audit-"));
}

interface DocEntry {
  fingerprint: string;
  type: string;
  file?: string;
  symbol?: string;
  reason: string;
  created_at: string;
  created_by?: string;
}

async function writeSuppressionsFile(root: string, entries: DocEntry[]): Promise<string> {
  const path = join(root, ".crimes", "suppressions.json");
  const doc = {
    schema_version: SCHEMA_VERSION,
    report_type: "suppressions" as const,
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: NOW_ISO,
    suppressions: entries,
  };
  await mkdtemp(join(tmpdir(), "_seed-")); // ensure os.tmpdir is writable
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(root, ".crimes"), { recursive: true });
  await writeFile(path, JSON.stringify(doc, null, 2), "utf8");
  return path;
}

describe("auditSuppressions", () => {
  it("returns loaded:false and empty entries when the file is missing", () => {
    const report = auditSuppressions({
      root: "/tmp/does-not-exist-crimes-audit-stub",
      now: NOW,
    });
    expect(report.report_type).toBe("audit_suppressions");
    expect(report.loaded).toBe(false);
    expect(report.total).toBe(0);
    expect(report.flagged_count).toBe(0);
    expect(report.entries).toEqual([]);
    expect(report.generated_at).toBe(NOW_ISO);
  });

  it("computes age_days from created_at against generated_at", async () => {
    const root = await tempRoot();
    await writeSuppressionsFile(root, [
      {
        fingerprint: "large_function::a.ts::foo",
        type: "large_function",
        reason: "tracked in #1234 (legacy module rewrite planned)",
        created_at: "2026-05-07T12:00:00.000Z", // 10 days before NOW
      },
    ]);
    const report = auditSuppressions({ root, now: NOW });
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]!.age_days).toBe(10);
    expect(report.entries[0]!.concerns).toEqual([]);
    expect(report.flagged_count).toBe(0);
  });

  it("flags entries older than the stale threshold", async () => {
    const root = await tempRoot();
    const created = new Date(
      new Date(NOW_ISO).getTime() -
        (SUPPRESSION_STALE_AGE_DAYS + 1) * 24 * 60 * 60 * 1000,
    ).toISOString();
    await writeSuppressionsFile(root, [
      {
        fingerprint: "large_function::a.ts::foo",
        type: "large_function",
        reason: "tracked in #1234 (legacy module rewrite planned)",
        created_at: created,
      },
    ]);
    const report = auditSuppressions({ root, now: NOW });
    expect(report.entries[0]!.concerns).toContain("stale");
    expect(report.flagged_count).toBe(1);
  });

  it("flags entries with reasons shorter than the minimum length", async () => {
    const root = await tempRoot();
    await writeSuppressionsFile(root, [
      {
        fingerprint: "large_function::a.ts::foo",
        type: "large_function",
        reason: "short",
        created_at: NOW_ISO,
      },
    ]);
    const report = auditSuppressions({ root, now: NOW });
    expect(report.entries[0]!.concerns).toContain("short_reason");
    expect(SUPPRESSION_MIN_REASON_LENGTH).toBeGreaterThan("short".length);
  });

  it("flags vague reasons that start with deferral keywords", async () => {
    const root = await tempRoot();
    await writeSuppressionsFile(root, [
      {
        fingerprint: "large_function::a.ts::a",
        type: "large_function",
        reason: "wip — will fix in the next sprint",
        created_at: NOW_ISO,
      },
      {
        fingerprint: "large_function::b.ts::b",
        type: "large_function",
        reason: "too noisy on this codebase right now",
        created_at: NOW_ISO,
      },
      {
        fingerprint: "large_function::c.ts::c",
        type: "large_function",
        reason: "we know about this one already",
        created_at: NOW_ISO,
      },
    ]);
    const report = auditSuppressions({ root, now: NOW });
    expect(report.entries).toHaveLength(3);
    for (const entry of report.entries) {
      expect(entry.concerns).toContain("vague_reason");
    }
    expect(report.flagged_count).toBe(3);
  });

  it("sorts entries by age descending", async () => {
    const root = await tempRoot();
    await writeSuppressionsFile(root, [
      {
        fingerprint: "large_function::young.ts::y",
        type: "large_function",
        reason: "tracked in #1234 (legacy module rewrite planned)",
        created_at: "2026-05-10T12:00:00.000Z", // 7 days old
      },
      {
        fingerprint: "large_function::old.ts::o",
        type: "large_function",
        reason: "tracked in #9876 (architectural debt)",
        created_at: "2025-01-01T12:00:00.000Z", // ~500 days old
      },
      {
        fingerprint: "large_function::mid.ts::m",
        type: "large_function",
        reason: "tracked in #5555 (refactor planned)",
        created_at: "2026-01-01T12:00:00.000Z", // ~137 days old
      },
    ]);
    const report = auditSuppressions({ root, now: NOW });
    expect(report.entries.map((e) => e.fingerprint)).toEqual([
      "large_function::old.ts::o",
      "large_function::mid.ts::m",
      "large_function::young.ts::y",
    ]);
  });

  it("throws MalformedSuppressionsError on a malformed file", async () => {
    const root = await tempRoot();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root, ".crimes"), { recursive: true });
    await writeFile(
      join(root, ".crimes", "suppressions.json"),
      "not json at all",
      "utf8",
    );
    expect(() => auditSuppressions({ root, now: NOW })).toThrowError(
      MalformedSuppressionsError,
    );
  });

  it("clean entries land under flagged_count 0", async () => {
    const root = await tempRoot();
    await writeSuppressionsFile(root, [
      {
        fingerprint: "large_function::a.ts::a",
        type: "large_function",
        reason: "tracked in #1234 (legacy module rewrite planned)",
        created_at: NOW_ISO,
      },
    ]);
    const report = auditSuppressions({ root, now: NOW });
    expect(report.total).toBe(1);
    expect(report.flagged_count).toBe(0);
    expect(report.entries[0]!.concerns).toEqual([]);
  });
});
