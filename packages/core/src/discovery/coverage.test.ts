import { describe, expect, it } from "vitest";
import type { Pack } from "../pack.js";
import { buildCoverage } from "./coverage.js";
import type { LanguagePackRouter } from "./language-pack-router.js";

/** Minimal router stub — maps extension → pack via a literal table. */
function routerFor(table: Record<string, Pack>): LanguagePackRouter {
  const ext = (p: string) => p.slice(p.lastIndexOf("."));
  const packs = [...new Set(Object.values(table))];
  return {
    claims: (pack, path) => table[ext(path)] === pack,
    claimingPack: (path) => table[ext(path)],
    registeredPacks: () => packs,
  };
}

describe("buildCoverage", () => {
  it("rolls every file into one of the language buckets or universal-only", () => {
    const cov = buildCoverage({
      files: ["/r/a.ts", "/r/b.tsx", "/r/c.py", "/r/d.rs", "/r/e.md"],
      router: routerFor({ ".ts": "language-js", ".tsx": "language-js" }),
    });
    expect(cov.files_total).toBe(5);
    expect(cov.files_by_language).toEqual({ js: 2 });
    expect(cov.files_universal_only).toBe(3);
    expect(cov.packs_loaded).toEqual(["universal", "language-js"]);
  });

  it("returns zero counts for an empty repo", () => {
    const cov = buildCoverage({ files: [], router: routerFor({}) });
    expect(cov.files_total).toBe(0);
    expect(cov.files_by_language).toEqual({});
    expect(cov.files_universal_only).toBe(0);
  });

  it("uses short pack ids (js, py) not the full pack name", () => {
    const cov = buildCoverage({
      files: ["/r/a.ts", "/r/b.py"],
      router: routerFor({ ".ts": "language-js", ".py": "language-py" }),
    });
    expect(cov.files_by_language).toEqual({ js: 1, py: 1 });
  });

  it("always reports the universal pack, which claims every file", () => {
    // Regression guard: `packs_loaded` used to be a hardcoded
    // ["language-js"], so a repo the JS pack never touched still
    // claimed it — and never named the pack that actually ran.
    const cov = buildCoverage({
      files: ["/r/only.rs", "/r/readme.md"],
      router: routerFor({}),
    });
    expect(cov.packs_loaded).toEqual(["universal"]);
    expect(cov.files_universal_only).toBe(2);
  });

  it("picks up a newly registered pack without a second source of truth", () => {
    const cov = buildCoverage({
      files: ["/r/a.py"],
      router: routerFor({ ".py": "language-py" }),
    });
    expect(cov.packs_loaded).toEqual(["universal", "language-py"]);
    expect(cov.files_by_language).toEqual({ py: 1 });
  });
});
