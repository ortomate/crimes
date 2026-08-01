import { describe, expect, it } from "vitest";
import type { Detector } from "./detector.js";
import { builtInDetectors, groupDetectorsByPack } from "./detector-registry.js";

describe("groupDetectorsByPack", () => {
  it("returns separate lists per pack", () => {
    const grouped = groupDetectorsByPack(builtInDetectors);
    expect(grouped["language-js"]).toBeDefined();
    expect(grouped["language-py"]).toBeDefined();
    expect(grouped["cross-language"]).toBeDefined();
    for (const d of grouped.universal ?? []) expect(d.pack).toBe("universal");
    for (const d of grouped["language-js"] ?? []) expect(d.pack).toBe("language-js");
    for (const d of grouped["language-py"] ?? []) expect(d.pack).toBe("language-py");
    for (const d of grouped["cross-language"] ?? [])
      expect(d.pack).toBe("cross-language");
  });

  it("includes every built-in detector in exactly one group", () => {
    const grouped = groupDetectorsByPack(builtInDetectors);
    const total =
      (grouped.universal?.length ?? 0) +
      (grouped["language-js"]?.length ?? 0) +
      (grouped["language-py"]?.length ?? 0) +
      (grouped["cross-language"]?.length ?? 0);
    expect(total).toBe(builtInDetectors.length);
  });

  it("qualifies every language-py detector id with a .py suffix", () => {
    // Python ids are qualified from the start so they are separately
    // addressable in `detectors.disable` and cannot collide with the JS
    // detector of the same name in the config registry.
    const grouped = groupDetectorsByPack(builtInDetectors);
    const pyDetectors = grouped["language-py"] ?? [];
    expect(pyDetectors.length).toBeGreaterThan(0);
    for (const d of pyDetectors) {
      expect(d.id, `${d.id} should end with .py`).toMatch(/\.py$/);
    }
  });

  /**
   * Two detectors sharing an id makes `buildDetectorRegistry` emit two
   * entries under that key, so `detectors.options.<id>` validation
   * resolves to whichever happened to be registered first.
   *
   * One pre-existing pair predates this check: `commented_out_code`
   * ships in both the universal and language-js packs (0.12.0). It is
   * harmless today because neither declares an `optionsSchema` and
   * disabling the shared id sensibly disables both. It is pinned here
   * rather than excluded so that adding an options schema to either one
   * fails loudly instead of becoming order-dependent.
   */
  const KNOWN_SHARED_IDS = new Set(["commented_out_code"]);

  it("has no unexpected duplicate detector ids across packs", () => {
    const counts = new Map<string, number>();
    for (const d of builtInDetectors) {
      counts.set(d.id, (counts.get(d.id) ?? 0) + 1);
    }
    const unexpected = [...counts]
      .filter(([id, n]) => n > 1 && !KNOWN_SHARED_IDS.has(id))
      .map(([id]) => id);
    expect(unexpected).toEqual([]);
  });

  it("keeps the known shared ids free of per-detector options schemas", () => {
    for (const id of KNOWN_SHARED_IDS) {
      const sharing = builtInDetectors.filter((d) => d.id === id);
      expect(sharing.length).toBeGreaterThan(1);
      for (const d of sharing) {
        expect(
          d.optionsSchema,
          `${id} (${d.pack}) shares its id with another pack, so an optionsSchema ` +
            "would make config validation depend on registration order",
        ).toBeUndefined();
      }
    }
  });

  it("treats hand-built detector lists the same way", () => {
    const detectors: Detector[] = [
      {
        id: "ux",
        name: "UX",
        description: "u",
        whyItMatters: "u",
        pack: "universal",
        run: () => [],
      },
      {
        id: "js",
        name: "JS",
        description: "j",
        whyItMatters: "j",
        pack: "language-js",
        run: () => [],
      },
    ];
    const grouped = groupDetectorsByPack(detectors);
    expect(grouped.universal?.map((d) => d.id)).toEqual(["ux"]);
    expect(grouped["language-js"]?.map((d) => d.id)).toEqual(["js"]);
  });
});
