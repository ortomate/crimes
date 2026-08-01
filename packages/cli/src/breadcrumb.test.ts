import type { CrimesConfig, SuppressionEntry } from "@crimes/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  emitDetectorsDisabledBreadcrumb,
  emitFuturePinnedSuppressionsWarnings,
  emitResurfacedSuppressionsBreadcrumb,
  resolveNoColor,
} from "./breadcrumb.js";

function makeConfig(disabled: string[]): CrimesConfig {
  return {
    include: ["**/*.ts"],
    exclude: [],
    thresholds: {
      largeFileLines: 300,
      largeFunctionLines: 60,
      todoDensityPerKLoc: 10,
    },
    detectors: { disable: disabled },
    scopeTiers: { nonDomain: [] },
    scan: { topFiles: 5 },
  };
}

class FakeStderr {
  chunks: string[] = [];
  write(s: string): boolean {
    this.chunks.push(s);
    return true;
  }
}

describe("emitDetectorsDisabledBreadcrumb", () => {
  it("stays silent when fewer than 3 detectors are disabled", () => {
    const stderr = new FakeStderr();
    emitDetectorsDisabledBreadcrumb(makeConfig(["a", "b"]), { stderr });
    expect(stderr.chunks).toEqual([]);
  });

  it("stays silent when detectors.disable is missing entirely", () => {
    const stderr = new FakeStderr();
    emitDetectorsDisabledBreadcrumb(
      {
        include: [],
        exclude: [],
        thresholds: {
          largeFileLines: 300,
          largeFunctionLines: 60,
          todoDensityPerKLoc: 10,
        },
        scopeTiers: { nonDomain: [] },
        scan: { topFiles: 5 },
      },
      { stderr },
    );
    expect(stderr.chunks).toEqual([]);
  });

  it("emits a one-line breadcrumb when 3 detectors are disabled", () => {
    const stderr = new FakeStderr();
    emitDetectorsDisabledBreadcrumb(
      makeConfig(["large_function", "todo_density", "direct_date"]),
      { stderr },
    );
    expect(stderr.chunks).toHaveLength(1);
    expect(stderr.chunks[0]!).toContain(
      "detectors.disable removed 3 detectors from this run",
    );
    expect(stderr.chunks[0]!).toMatch(/crimes ignore/);
  });

  it("includes the actual disabled count in the message (5 detectors)", () => {
    const stderr = new FakeStderr();
    emitDetectorsDisabledBreadcrumb(makeConfig(["a", "b", "c", "d", "e"]), { stderr });
    expect(stderr.chunks[0]!).toContain(
      "detectors.disable removed 5 detectors from this run",
    );
  });

  it("stays silent when noColor is set, even with 5 disabled", () => {
    const stderr = new FakeStderr();
    emitDetectorsDisabledBreadcrumb(makeConfig(["a", "b", "c", "d", "e"]), {
      stderr,
      noColor: true,
    });
    expect(stderr.chunks).toEqual([]);
  });
});

describe("resolveNoColor", () => {
  const originalIsTTY = process.stdout.isTTY;

  afterEach(() => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalIsTTY,
      configurable: true,
    });
  });

  function setIsTTY(value: boolean): void {
    Object.defineProperty(process.stdout, "isTTY", {
      value,
      configurable: true,
    });
  }

  it("returns true when Commander parses --no-color (color: false)", () => {
    setIsTTY(true);
    expect(resolveNoColor({ color: false })).toBe(true);
  });

  it("returns false in an interactive TTY with no flag", () => {
    setIsTTY(true);
    expect(resolveNoColor({})).toBe(false);
  });

  it("returns true when stdout is piped, regardless of flag absence", () => {
    setIsTTY(false);
    expect(resolveNoColor({})).toBe(true);
  });

  it("returns true when the legacy noColor: true is passed", () => {
    setIsTTY(true);
    expect(resolveNoColor({ noColor: true })).toBe(true);
  });
});

describe("emitResurfacedSuppressionsBreadcrumb", () => {
  it("stays silent when nothing resurfaced", () => {
    const stderr = new FakeStderr();
    emitResurfacedSuppressionsBreadcrumb({}, { stderr });
    expect(stderr.chunks).toEqual([]);
  });

  it("emits a single-pin line when one pinned minor accounts for everything", () => {
    const stderr = new FakeStderr();
    emitResurfacedSuppressionsBreadcrumb({ "0.6": 5 }, { stderr });
    expect(stderr.chunks).toHaveLength(1);
    expect(stderr.chunks[0]!).toContain(
      "5 feedback-sourced suppressions resurface because they were pinned to 0.6",
    );
    expect(stderr.chunks[0]!).toMatch(/crimes feedback recheck/);
  });

  it("emits a per-pin breakdown when multiple minors are involved", () => {
    const stderr = new FakeStderr();
    emitResurfacedSuppressionsBreadcrumb({ "0.6": 2, "0.5": 1 }, { stderr });
    expect(stderr.chunks[0]!).toContain("3 feedback-sourced suppressions resurface");
    expect(stderr.chunks[0]!).toContain("1 pinned to 0.5");
    expect(stderr.chunks[0]!).toContain("2 pinned to 0.6");
  });

  it("singular wording when exactly one suppression resurfaces", () => {
    const stderr = new FakeStderr();
    emitResurfacedSuppressionsBreadcrumb({ "0.6": 1 }, { stderr });
    expect(stderr.chunks[0]!).toContain("1 feedback-sourced suppression resurface");
  });

  it("stays silent under noColor", () => {
    const stderr = new FakeStderr();
    emitResurfacedSuppressionsBreadcrumb({ "0.6": 5 }, { stderr, noColor: true });
    expect(stderr.chunks).toEqual([]);
  });
});

describe("emitFuturePinnedSuppressionsWarnings", () => {
  function makeEntry(overrides: Partial<SuppressionEntry> = {}): SuppressionEntry {
    return {
      fingerprint: "direct_date::src/x.ts::",
      type: "direct_date",
      reason: "from the future",
      created_at: "x",
      source: "feedback",
      crimes_version_pinned: "0.8",
      ...overrides,
    };
  }

  it("stays silent when no entries are future-pinned", () => {
    const stderr = new FakeStderr();
    emitFuturePinnedSuppressionsWarnings([], "0.7.0", { stderr });
    expect(stderr.chunks).toEqual([]);
  });

  it("emits one line per future-pinned feedback entry", () => {
    const stderr = new FakeStderr();
    emitFuturePinnedSuppressionsWarnings(
      [
        makeEntry(),
        makeEntry({ fingerprint: "x::y.ts::z", crimes_version_pinned: "0.9" }),
      ],
      "0.7.0",
      { stderr },
    );
    expect(stderr.chunks).toHaveLength(2);
    expect(stderr.chunks[0]!).toContain("0.8");
    expect(stderr.chunks[1]!).toContain("0.9");
  });

  it("ignores manual entries even when pinned to a future version", () => {
    const stderr = new FakeStderr();
    emitFuturePinnedSuppressionsWarnings([makeEntry({ source: "manual" })], "0.7.0", {
      stderr,
    });
    expect(stderr.chunks).toEqual([]);
  });

  it("stays silent under noColor", () => {
    const stderr = new FakeStderr();
    emitFuturePinnedSuppressionsWarnings([makeEntry()], "0.7.0", {
      stderr,
      noColor: true,
    });
    expect(stderr.chunks).toEqual([]);
  });
});
