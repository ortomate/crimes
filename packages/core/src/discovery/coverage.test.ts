import { describe, expect, it } from "vitest";
import { buildCoverage } from "./coverage.js";

describe("buildCoverage", () => {
  it("rolls every file into one of the language buckets or universal-only", () => {
    const cov = buildCoverage({
      files: ["/r/a.ts", "/r/b.tsx", "/r/c.py", "/r/d.rs", "/r/e.md"],
      packsLoaded: ["language-js"],
    });
    expect(cov.files_total).toBe(5);
    expect(cov.files_by_language).toEqual({ js: 2 });
    expect(cov.files_universal_only).toBe(3);
    expect(cov.files_skipped).toBe(0);
    expect(cov.packs_loaded).toEqual(["language-js"]);
  });

  it("returns zero counts for an empty repo", () => {
    const cov = buildCoverage({ files: [], packsLoaded: [] });
    expect(cov.files_total).toBe(0);
    expect(cov.files_by_language).toEqual({});
    expect(cov.files_universal_only).toBe(0);
  });

  it("uses short pack ids (js, py) not the full pack name", () => {
    const cov = buildCoverage({
      files: ["/r/a.ts"],
      packsLoaded: ["language-js"],
    });
    expect(cov.files_by_language).toEqual({ js: 1 });
  });
});
