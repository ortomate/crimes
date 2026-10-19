import { describe, expect, it } from "vitest";
import { componentIds } from "./components.js";
import type { ImportEdge, ImportGraph } from "./types.js";

function graph(pairs: [string, string][]): ImportGraph {
  const edges: ImportEdge[] = pairs.map(([from, to]) => ({
    from,
    to,
    specifier: to,
    external: false,
    typeOnly: false,
    dynamic: false,
  }));
  const out = new Map<string, ImportEdge[]>();
  const inbound = new Map<string, ImportEdge[]>();
  const files = new Set<string>();
  for (const e of edges) {
    out.set(e.from, [...(out.get(e.from) ?? []), e]);
    inbound.set(e.to, [...(inbound.get(e.to) ?? []), e]);
    files.add(e.from).add(e.to);
  }
  return { edges, out, in: inbound, files };
}

describe("componentIds", () => {
  it("groups a cycle and leaves acyclic files on their own", () => {
    const ids = componentIds(
      graph([
        ["a", "b"],
        ["b", "c"],
        ["c", "a"],
        ["a", "hub"],
        ["leaf", "hub"],
      ]),
    );
    expect(ids.get("a")).toBe(ids.get("b"));
    expect(ids.get("b")).toBe(ids.get("c"));
    expect(ids.get("hub")).not.toBe(ids.get("a"));
    expect(ids.get("leaf")).not.toBe(ids.get("hub"));
  });

  it("handles a cycle deeper than the call stack", () => {
    const n = 50_000;
    const pairs: [string, string][] = [];
    for (let i = 0; i < n; i++) pairs.push([`f${i}`, `f${(i + 1) % n}`]);
    const ids = componentIds(graph(pairs));
    expect(new Set(ids.values()).size).toBe(1);
  });
});
