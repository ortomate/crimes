import { describe, expect, it } from "vitest";
import {
  compareResultsVersionDesc,
  parseResultsVersion,
  sortResultsVersionsDesc,
} from "./versions.js";

describe("parseResultsVersion", () => {
  it("reads a bare version as sample 1", () => {
    expect(parseResultsVersion("0.15.0")).toMatchObject({
      major: 0,
      minor: 15,
      patch: 0,
      sample: 1,
    });
  });

  it("reads an -rN label as that sample number", () => {
    expect(parseResultsVersion("0.15.0-r2")?.sample).toBe(2);
    expect(parseResultsVersion("0.12.1-r3")?.sample).toBe(3);
    expect(parseResultsVersion("0.7.15-r10")?.sample).toBe(10);
  });

  it("reads a non-numbered label as sample 0", () => {
    // `0.7.2-judge` is a judge-model pass, not a later canonical run.
    expect(parseResultsVersion("0.7.2-judge")?.sample).toBe(0);
  });

  it("rejects names that are not results directories", () => {
    expect(parseResultsVersion("replay")).toBeUndefined();
    expect(parseResultsVersion(".gitkeep")).toBeUndefined();
    expect(parseResultsVersion("0.15")).toBeUndefined();
  });
});

describe("compareResultsVersionDesc", () => {
  // The bug this module exists for: both operands used to parse to
  // [0, 15, 0] because Number.parseInt("0-r2") is 0, so they compared
  // equal and readdir order picked the winner.
  it("orders a re-run sample above its base version", () => {
    expect(compareResultsVersionDesc("0.15.0-r2", "0.15.0")).toBeLessThan(0);
    expect(compareResultsVersionDesc("0.15.0", "0.15.0-r2")).toBeGreaterThan(0);
  });

  it("never returns 0 for two different names", () => {
    const names = ["0.15.0", "0.15.0-r2", "0.7.2-judge", "0.7.2", "0.7.15"];
    for (const a of names) {
      for (const b of names) {
        if (a === b) continue;
        expect(compareResultsVersionDesc(a, b)).not.toBe(0);
      }
    }
  });

  it("compares numerically, not lexically", () => {
    // "0.7.15" < "0.7.2" as strings; 15 > 2 as numbers.
    expect(compareResultsVersionDesc("0.7.15", "0.7.2")).toBeLessThan(0);
  });

  it("keeps a judge variant below the canonical run of the same version", () => {
    expect(compareResultsVersionDesc("0.7.2", "0.7.2-judge")).toBeLessThan(0);
  });
});

describe("sortResultsVersionsDesc", () => {
  it("puts the newest baseline first and drops non-version entries", () => {
    const sorted = sortResultsVersionsDesc([
      "0.7.2",
      "0.16.0",
      "0.15.0",
      "0.15.0-r2",
      ".gitkeep",
      "0.7.2-r3",
      "0.7.2-judge",
      "0.9.5",
    ]);
    expect(sorted[0]).toBe("0.16.0");
    expect(sorted).not.toContain(".gitkeep");
    expect(sorted.indexOf("0.15.0-r2")).toBeLessThan(sorted.indexOf("0.15.0"));
    expect(sorted.indexOf("0.7.2-r3")).toBeLessThan(sorted.indexOf("0.7.2"));
    expect(sorted.indexOf("0.7.2")).toBeLessThan(sorted.indexOf("0.7.2-judge"));
  });

  it("is stable regardless of input order", () => {
    const a = sortResultsVersionsDesc(["0.15.0", "0.15.0-r2", "0.16.0"]);
    const b = sortResultsVersionsDesc(["0.16.0", "0.15.0-r2", "0.15.0"]);
    const c = sortResultsVersionsDesc(["0.15.0-r2", "0.16.0", "0.15.0"]);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it("picks the corrected sample as the real repo's baseline", () => {
    // Regression guard against the exact production data that broke:
    // before the fix, replay could pin 0.15.0 over 0.15.0-r2.
    const real = ["0.14.0", "0.14.0-r2", "0.15.0", "0.15.0-r2"];
    expect(sortResultsVersionsDesc(real)[0]).toBe("0.15.0-r2");
  });
});
