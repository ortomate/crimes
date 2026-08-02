import { describe, expect, it } from "vitest";
import type { FunctionHashIndex, FunctionHit } from "../ast-hash/function-index.js";
import { anchoredGroups } from "./duplicate-anchor-index.js";

function hit(file: string, symbol: string, tokens = 40): FunctionHit {
  return { file, symbol, lines: [1, 10], tokens };
}

function index(entries: Record<string, FunctionHit[]>): FunctionHashIndex {
  return { byExact: new Map(Object.entries(entries)), byShape: new Map() };
}

describe("anchoredGroups", () => {
  it("computes the anchor map once per index and reuses it", () => {
    // This is the whole point of the module. `run()` is called once per
    // file, and each call used to materialise and localeCompare-sort the
    // entire repo-wide hash index before discarding everything not
    // anchored on that file — O(files × hashes log hashes). On PostHog
    // that was 36% of all CPU samples and a 3h42m scan.
    const idx = index({ h1: [hit("b.ts", "x"), hit("a.ts", "x")] });

    const first = anchoredGroups(idx, "exact");
    const second = anchoredGroups(idx, "exact");

    expect(second).toBe(first);
  });

  it("keeps separate maps per view", () => {
    const idx = index({ h1: [hit("a.ts", "x"), hit("b.ts", "x")] });
    expect(anchoredGroups(idx, "shape")).not.toBe(anchoredGroups(idx, "exact"));
  });

  it("does not share a cache across different index objects", () => {
    const a = index({ h1: [hit("a.ts", "x"), hit("b.ts", "x")] });
    const b = index({ h1: [hit("a.ts", "x"), hit("b.ts", "x")] });
    expect(anchoredGroups(a, "exact")).not.toBe(anchoredGroups(b, "exact"));
  });

  it("anchors each group on its lexicographically first file", () => {
    const idx = index({ h1: [hit("z.ts", "x"), hit("a.ts", "x"), hit("m.ts", "x")] });
    const map = anchoredGroups(idx, "exact");

    expect(map.get("a.ts")).toHaveLength(1);
    expect(map.get("z.ts")).toBeUndefined();
    expect(map.get("m.ts")).toBeUndefined();
    expect(map.get("a.ts")?.[0]?.hash).toBe("h1");
  });

  it("drops groups confined to a single file", () => {
    const idx = index({ h1: [hit("a.ts", "x"), hit("a.ts", "y")] });
    expect(anchoredGroups(idx, "exact").size).toBe(0);
  });

  it("orders an anchor's groups by hash, so output is reproducible", () => {
    const idx = index({
      zzz: [hit("a.ts", "x"), hit("b.ts", "x")],
      aaa: [hit("a.ts", "y"), hit("b.ts", "y")],
      mmm: [hit("a.ts", "z"), hit("b.ts", "z")],
    });
    const groups = anchoredGroups(idx, "exact").get("a.ts") ?? [];
    expect(groups.map((g) => g.hash)).toEqual(["aaa", "mmm", "zzz"]);
  });

  it("carries every hit in the group through", () => {
    const idx = index({ h1: [hit("b.ts", "x"), hit("a.ts", "x"), hit("c.ts", "x")] });
    const groups = anchoredGroups(idx, "exact").get("a.ts") ?? [];
    expect(groups[0]?.hits).toHaveLength(3);
  });
});
