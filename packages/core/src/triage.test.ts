import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  emptyTriage,
  loadTriage,
  parseTriage,
  resolveTriagePath,
  saveTriage,
  upsertTriageEntry,
  MalformedTriageError,
  type Triage,
  type TriageEntry,
} from "./triage.js";

function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), "crimes-triage-test-"));
}

function sampleEntry(overrides: Partial<TriageEntry> = {}): TriageEntry {
  return {
    fingerprint: "large_function::src/foo.ts::doStuff",
    type: "large_function",
    file: "src/foo.ts",
    symbol: "doStuff",
    disposition: "wont-fix",
    reason: "legacy code, planned rewrite",
    owner: "@amayfield",
    date: "2026-05-20",
    ...overrides,
  };
}

describe("triage", () => {
  it("returns an empty entries list when the file does not exist", async () => {
    const root = makeTempRoot();
    const result = await loadTriage(resolveTriagePath(root));
    expect(result.entries).toEqual([]);
    expect(result.loaded).toBe(false);
    expect(result.path.endsWith(".crimes/triage.json")).toBe(true);
  });

  it("round-trips a single entry through save then load", async () => {
    const root = makeTempRoot();
    const path = resolveTriagePath(root);
    const triage: Triage = {
      schema_version: "0.2.0",
      report_type: "triage",
      created_at: "2026-05-20T14:00:00Z",
      updated_at: "2026-05-20T14:00:00Z",
      entries: [sampleEntry()],
    };
    await saveTriage(path, triage);
    const loaded = await loadTriage(path);
    expect(loaded.entries).toHaveLength(1);
    expect(loaded.entries[0]).toMatchObject({
      fingerprint: "large_function::src/foo.ts::doStuff",
      disposition: "wont-fix",
      owner: "@amayfield",
    });
  });

  it("rejects malformed JSON with MalformedTriageError", async () => {
    const root = makeTempRoot();
    mkdirSync(join(root, ".crimes"), { recursive: true });
    const path = join(root, ".crimes", "triage.json");
    writeFileSync(path, "{ not json");
    await expect(loadTriage(path)).rejects.toBeInstanceOf(MalformedTriageError);
  });

  it("rejects an entry missing the reason field", async () => {
    const root = makeTempRoot();
    mkdirSync(join(root, ".crimes"), { recursive: true });
    const path = join(root, ".crimes", "triage.json");
    writeFileSync(
      path,
      JSON.stringify({
        schema_version: "0.2.0",
        report_type: "triage",
        created_at: "2026-05-20T14:00:00Z",
        updated_at: "2026-05-20T14:00:00Z",
        entries: [
          {
            fingerprint: "x::a::b",
            type: "x",
            file: "a",
            disposition: "wont-fix",
            // reason missing
            owner: "@a",
            date: "2026-05-20",
          },
        ],
      }),
    );
    await expect(loadTriage(path)).rejects.toBeInstanceOf(MalformedTriageError);
  });

  it("upsertTriageEntry adds a new entry", () => {
    const triage: Triage = {
      schema_version: "0.2.0",
      report_type: "triage",
      created_at: "2026-05-20T14:00:00Z",
      updated_at: "2026-05-20T14:00:00Z",
      entries: [],
    };
    const next = upsertTriageEntry(triage, sampleEntry(), {
      now: () => new Date("2026-05-21T00:00:00Z"),
    });
    expect(next.entries).toHaveLength(1);
    expect(next.updated_at).toBe("2026-05-21T00:00:00.000Z");
  });

  it("upsertTriageEntry overwrites by fingerprint", () => {
    const triage: Triage = {
      schema_version: "0.2.0",
      report_type: "triage",
      created_at: "2026-05-20T14:00:00Z",
      updated_at: "2026-05-20T14:00:00Z",
      entries: [sampleEntry({ disposition: "needs-design", reason: "old" })],
    };
    const next = upsertTriageEntry(
      triage,
      sampleEntry({ disposition: "wont-fix", reason: "new" }),
      { now: () => new Date("2026-05-21T00:00:00Z") },
    );
    expect(next.entries).toHaveLength(1);
    expect(next.entries[0]!.disposition).toBe("wont-fix");
    expect(next.entries[0]!.reason).toBe("new");
  });

  it("allows owner to be the empty string", async () => {
    const root = makeTempRoot();
    const path = resolveTriagePath(root);
    const triage: Triage = {
      schema_version: "0.2.0",
      report_type: "triage",
      created_at: "2026-05-20T14:00:00Z",
      updated_at: "2026-05-20T14:00:00Z",
      entries: [sampleEntry({ owner: "" })],
    };
    await saveTriage(path, triage);
    const loaded = await loadTriage(path);
    expect(loaded.entries[0]!.owner).toBe("");
  });

  it("rejects an invalid date format", async () => {
    const root = makeTempRoot();
    mkdirSync(join(root, ".crimes"), { recursive: true });
    const path = join(root, ".crimes", "triage.json");
    writeFileSync(
      path,
      JSON.stringify({
        schema_version: "0.2.0",
        report_type: "triage",
        created_at: "2026-05-20T14:00:00Z",
        updated_at: "2026-05-20T14:00:00Z",
        entries: [
          {
            fingerprint: "x::a::b",
            type: "x",
            file: "a",
            disposition: "wont-fix",
            reason: "ok",
            owner: "@a",
            date: "May 20, 2026", // invalid format
          },
        ],
      }),
    );
    await expect(loadTriage(path)).rejects.toBeInstanceOf(MalformedTriageError);
  });

  it("emptyTriage returns a fresh document with both timestamps equal", () => {
    const fixedNow = new Date("2026-05-20T14:00:00Z");
    const doc = emptyTriage({ now: () => fixedNow });
    expect(doc.entries).toEqual([]);
    expect(doc.created_at).toBe("2026-05-20T14:00:00.000Z");
    expect(doc.updated_at).toBe("2026-05-20T14:00:00.000Z");
    expect(doc.report_type).toBe("triage");
    expect(doc.crimes_version).toBeUndefined();
  });

  it("emptyTriage records crimes_version when supplied", () => {
    const doc = emptyTriage({
      now: () => new Date("2026-05-20T14:00:00Z"),
      crimesVersion: "0.11.0",
    });
    expect(doc.crimes_version).toBe("0.11.0");
  });

  it("surfaces zod path + message in MalformedTriageError", async () => {
    const root = makeTempRoot();
    mkdirSync(join(root, ".crimes"), { recursive: true });
    const path = join(root, ".crimes", "triage.json");
    writeFileSync(
      path,
      JSON.stringify({
        schema_version: "0.2.0",
        report_type: "triage",
        created_at: "2026-05-20T14:00:00Z",
        updated_at: "2026-05-20T14:00:00Z",
        entries: [
          {
            fingerprint: "x::a::b",
            type: "x",
            file: "a",
            disposition: "wont-fix",
            // reason missing
            owner: "@a",
            date: "2026-05-20",
          },
        ],
      }),
    );
    await expect(loadTriage(path)).rejects.toMatchObject({
      message: expect.stringMatching(/entries\.0\.reason/),
    });
  });

  it("parseTriage round-trips a valid document with no filesystem touch", () => {
    const raw = JSON.stringify({
      schema_version: "0.2.0",
      report_type: "triage",
      created_at: "2026-05-20T14:00:00Z",
      updated_at: "2026-05-20T14:00:00Z",
      entries: [sampleEntry()],
    });
    const doc = parseTriage(raw);
    expect(doc.entries).toHaveLength(1);
    expect(doc.entries[0]!.fingerprint).toBe("large_function::src/foo.ts::doStuff");
  });

  it("parseTriage throws MalformedTriageError on invalid JSON", () => {
    expect(() => parseTriage("{ not json", "my-file.json")).toThrow(MalformedTriageError);
    expect(() => parseTriage("{ not json", "my-file.json")).toThrow(/my-file\.json/);
  });

  it("parseTriage throws MalformedTriageError on shape mismatch", () => {
    const raw = JSON.stringify({
      schema_version: "0.2.0",
      report_type: "triage",
      created_at: "2026-05-20T14:00:00Z",
      updated_at: "2026-05-20T14:00:00Z",
      entries: [{ fingerprint: "x::y::" }],
    });
    expect(() => parseTriage(raw)).toThrow(MalformedTriageError);
  });
});
