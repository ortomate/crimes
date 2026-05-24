import { describe, expect, it } from "vitest";
import type { Detector } from "./detector.js";
import {
  builtInDetectors,
  groupDetectorsByPack,
} from "./detector-registry.js";

describe("groupDetectorsByPack", () => {
  it("returns separate lists per pack", () => {
    const grouped = groupDetectorsByPack(builtInDetectors);
    expect(grouped["language-js"]).toBeDefined();
    for (const d of grouped.universal ?? []) expect(d.pack).toBe("universal");
    for (const d of grouped["language-js"] ?? []) expect(d.pack).toBe("language-js");
  });

  it("includes every built-in detector in exactly one group", () => {
    const grouped = groupDetectorsByPack(builtInDetectors);
    const total =
      (grouped.universal?.length ?? 0) +
      (grouped["language-js"]?.length ?? 0);
    expect(total).toBe(builtInDetectors.length);
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
