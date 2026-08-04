import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "./config.js";
import type { Detector } from "./detector.js";
import {
  builtInAssetDetectors,
  builtInDetectors,
  collectKnownIds,
  filterAssetDetectors,
  filterDetectors,
  groupDetectorsByPack,
} from "./detector-registry.js";

describe("default-off detectors", () => {
  function configWith(
    detectors: Partial<NonNullable<typeof DEFAULT_CONFIG.detectors>>,
  ): typeof DEFAULT_CONFIG {
    return {
      ...DEFAULT_CONFIG,
      detectors: { ...DEFAULT_CONFIG.detectors, ...detectors },
    };
  }

  it("leaves parallel_destination out of a default scan", () => {
    // 2,819 findings on n8n's editor-ui — 52.8% of that package's entire
    // report — from pairing Vue composables on the token `use`, and zero
    // findings on every other repo in the corpus.
    const ids = filterDetectors(builtInDetectors, DEFAULT_CONFIG).map((d) => d.id);
    expect(ids).not.toContain("parallel_destination");
  });

  it("runs it when the config asks for it by name", () => {
    const ids = filterDetectors(
      builtInDetectors,
      configWith({ enable: ["parallel_destination"] }),
    ).map((d) => d.id);
    expect(ids).toContain("parallel_destination");
  });

  it("keeps every other detector running when only a gated id is enabled", () => {
    // The CLI tells the user, verbatim:
    //
    //   crimes: parallel_destination did not run (off by default).
    //           Enable with "detectors": { "enable": ["parallel_destination"] }.
    //
    // Under a pure allowlist reading, following that advice silently
    // turns off all 68 other detectors — measured on
    // `evals/fixtures/05-stress-ia-drift`: 13 findings become 1. A tool
    // whose own remediation advice quietly guts the scan is worse than
    // one that never offered it.
    const defaults = filterDetectors(builtInDetectors, DEFAULT_CONFIG).map((d) => d.id);
    const enabled = filterDetectors(
      builtInDetectors,
      configWith({ enable: ["parallel_destination"] }),
    ).map((d) => d.id);
    expect(enabled).toEqual(
      [...defaults, "parallel_destination"].sort(
        (a, b) => enabled.indexOf(a) - enabled.indexOf(b),
      ),
    );
    for (const id of defaults) expect(enabled).toContain(id);
    expect(enabled).toHaveLength(defaults.length + 1);
  });

  it("does not disable the asset pass when only a gated source id is enabled", () => {
    // Mirrors the real call in `scan.ts`, which passes the combined
    // source + asset id set so a source id in `enable` is recognised.
    const known = collectKnownIds(builtInDetectors, builtInAssetDetectors);
    const defaults = filterAssetDetectors(builtInAssetDetectors, DEFAULT_CONFIG, known);
    const enabled = filterAssetDetectors(
      builtInAssetDetectors,
      configWith({ enable: ["parallel_destination"] }),
      known,
    );
    expect(enabled.map((d) => d.id)).toEqual(defaults.map((d) => d.id));
    expect(enabled.length).toBeGreaterThan(0);
  });

  it("still treats a list naming a default-on detector as an allowlist", () => {
    // The existing contract, unchanged: naming a normal detector means
    // "only these". Adding a gated id alongside adds it to that list
    // rather than widening it back to everything.
    const ids = filterDetectors(
      builtInDetectors,
      configWith({ enable: ["large_function", "parallel_destination"] }),
    ).map((d) => d.id);
    expect(ids.sort()).toEqual(["large_function", "parallel_destination"]);
  });

  it("keeps every other detector on by default", () => {
    const defaultIds = new Set(
      filterDetectors(builtInDetectors, DEFAULT_CONFIG).map((d) => d.id),
    );
    const offByDefault = builtInDetectors
      .filter((d) => !defaultIds.has(d.id))
      .map((d) => d.id);
    // Exactly one detector is gated. Adding another is a product
    // decision, not a refactor, so it has to change this list.
    expect(offByDefault).toEqual(["parallel_destination"]);
  });

  it("does not resurrect a default-off detector via an unrelated enable list", () => {
    const ids = filterDetectors(
      builtInDetectors,
      configWith({ enable: ["large_function"] }),
    ).map((d) => d.id);
    expect(ids).toContain("large_function");
    expect(ids).not.toContain("parallel_destination");
  });

  it("still lets disable win over an explicit enable", () => {
    const ids = filterDetectors(
      builtInDetectors,
      configWith({
        enable: ["parallel_destination"],
        disable: ["parallel_destination"],
      }),
    ).map((d) => d.id);
    expect(ids).not.toContain("parallel_destination");
  });
});

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
