import { describe, expect, it } from "vitest";
import type { ScanReport } from "@crimes/core";
import { buildCoverageBanner } from "./coverage.js";

function coverage(
  filesTotal: number,
  universalOnly: number,
  packs: string[] = ["language-js"],
): ScanReport["coverage"] {
  return {
    files_total: filesTotal,
    files_by_language: { js: filesTotal - universalOnly },
    files_universal_only: universalOnly,
    files_skipped: 0,
    packs_loaded: packs,
  };
}

describe("buildCoverageBanner", () => {
  it("returns null when most files are pack-covered", () => {
    expect(buildCoverageBanner(coverage(100, 10))).toBeNull();
  });

  it("returns a banner when >50% of files are universal-only", () => {
    const banner = buildCoverageBanner(coverage(100, 80));
    expect(banner).toContain("coverage:");
    expect(banner).toContain("100 files");
    expect(banner).toContain("20% covered");
    expect(banner).toContain("--explain-coverage");
  });

  it("returns null when coverage is undefined", () => {
    expect(buildCoverageBanner(undefined)).toBeNull();
  });

  it("returns null on an empty repo", () => {
    expect(buildCoverageBanner(coverage(0, 0))).toBeNull();
  });

  it("triggers at exactly the 50% boundary (>50%, not >=50%)", () => {
    expect(buildCoverageBanner(coverage(100, 50))).toBeNull();
    expect(buildCoverageBanner(coverage(100, 51))).not.toBeNull();
  });

  it("labels the no-pack case explicitly", () => {
    const banner = buildCoverageBanner(coverage(100, 100, []));
    expect(banner).toContain("(no language packs loaded)");
  });
});
