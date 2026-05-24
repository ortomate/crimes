import { parseFile } from "@crimes/language-js";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import type { LanguageJsDetector, LanguageJsDetectorContext } from "../detector.js";
import { optionBagJunkDrawerDetector as _optionBagJunkDrawerDetector } from "./option-bag-junk-drawer.js";
const optionBagJunkDrawerDetector = _optionBagJunkDrawerDetector as LanguageJsDetector;

function makeCtx(source: string): LanguageJsDetectorContext {
  return {
    kind: "language-js",
    file: "src/options.ts",
    absolutePath: "/tmp/options.ts",
    source,
    parsed: parseFile({ absolutePath: "/tmp/options.ts", source }),
    config: DEFAULT_CONFIG,
  };
}

describe("optionBagJunkDrawerDetector", () => {
  it("detects generic option bags with many property reads", async () => {
    const source = `
export function buildThing(options: Options) {
  return [
    options.plan,
    options.role,
    options.region,
    options.currency,
    options.status,
    options.retry,
  ].join(":");
}
`;
    const findings = await optionBagJunkDrawerDetector.run(makeCtx(source));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.type).toBe("option_bag_junk_drawer");
    expect(findings[0]!.evidence.join(" ")).toContain("6 distinct property reads");
  });

  it("ignores pass-through generic bags without local shape evidence", async () => {
    const source = `
export function handlePayload(payload: Payload) {
  validate(payload);
  enrich(payload);
  save(payload);
}
`;
    const findings = await optionBagJunkDrawerDetector.run(makeCtx(source));
    expect(findings).toEqual([]);
  });

  it("ignores small explicit option use", async () => {
    const source = `
export function buildThing(options: Options) {
  return options.plan;
}
`;
    const findings = await optionBagJunkDrawerDetector.run(makeCtx(source));
    expect(findings).toEqual([]);
  });
});
