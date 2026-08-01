import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  latestPerFingerprint,
  MalformedFeedbackEntryError,
  readFeedback,
} from "./read.js";

async function tempPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crimes-feedback-read-"));
  return join(dir, "feedback.jsonl");
}

const ENTRY_LINE = JSON.stringify({
  timestamp: "2026-05-20T12:00:00.000Z",
  crimes_version: "0.7.0",
  fingerprint: "large_function::src/a.ts::foo",
  finding_type: "large_function",
  verdict: "fp",
  note: "DSL chain",
  scan_hash: null,
  resurfaced_from: null,
});

describe("readFeedback", () => {
  it("returns an empty list when the file does not exist", async () => {
    const path = await tempPath();
    const result = await readFeedback(path);
    expect(result.entries).toEqual([]);
    expect(result.loaded).toBe(false);
  });

  it("parses one entry per non-empty line", async () => {
    const path = await tempPath();
    await writeFile(path, `${ENTRY_LINE}\n\n${ENTRY_LINE}\n`, "utf8");
    const result = await readFeedback(path);
    expect(result.entries).toHaveLength(2);
    expect(result.loaded).toBe(true);
  });

  it("silently skips malformed lines by default", async () => {
    const path = await tempPath();
    await writeFile(path, `${ENTRY_LINE}\nnot-json\n${ENTRY_LINE}\n`, "utf8");
    const result = await readFeedback(path);
    expect(result.entries).toHaveLength(2);
  });

  it("throws MalformedFeedbackEntryError under strict mode", async () => {
    const path = await tempPath();
    await writeFile(path, `${ENTRY_LINE}\nnot-json\n`, "utf8");
    await expect(readFeedback(path, { strict: true })).rejects.toBeInstanceOf(
      MalformedFeedbackEntryError,
    );
  });

  it("strict mode also rejects schema-invalid entries", async () => {
    const path = await tempPath();
    await writeFile(path, JSON.stringify({ fingerprint: "x" }) + "\n", "utf8");
    await expect(readFeedback(path, { strict: true })).rejects.toBeInstanceOf(
      MalformedFeedbackEntryError,
    );
  });
});

describe("latestPerFingerprint", () => {
  it("returns the latest entry per fingerprint", () => {
    const entries = [
      {
        timestamp: "2026-05-01T00:00:00.000Z",
        crimes_version: "0.7.0",
        fingerprint: "x::a.ts::foo",
        finding_type: "x",
        verdict: "fp" as const,
        note: "first",
        scan_hash: null,
        resurfaced_from: null,
      },
      {
        timestamp: "2026-05-02T00:00:00.000Z",
        crimes_version: "0.7.0",
        fingerprint: "x::a.ts::foo",
        finding_type: "x",
        verdict: "tp" as const,
        note: null,
        scan_hash: null,
        resurfaced_from: null,
      },
    ];
    const map = latestPerFingerprint(entries);
    expect(map.get("x::a.ts::foo")!.verdict).toBe("tp");
  });

  it("handles out-of-order entries (highest timestamp wins)", () => {
    const entries = [
      {
        timestamp: "2026-05-02T00:00:00.000Z",
        crimes_version: "0.7.0",
        fingerprint: "x::a.ts::foo",
        finding_type: "x",
        verdict: "tp" as const,
        note: null,
        scan_hash: null,
        resurfaced_from: null,
      },
      {
        timestamp: "2026-05-01T00:00:00.000Z",
        crimes_version: "0.7.0",
        fingerprint: "x::a.ts::foo",
        finding_type: "x",
        verdict: "fp" as const,
        note: "older",
        scan_hash: null,
        resurfaced_from: null,
      },
    ];
    const map = latestPerFingerprint(entries);
    expect(map.get("x::a.ts::foo")!.verdict).toBe("tp");
  });

  it("returns an empty map for an empty input", () => {
    expect(latestPerFingerprint([]).size).toBe(0);
  });
});
