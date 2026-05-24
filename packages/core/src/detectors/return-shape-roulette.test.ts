import { parseFile } from "@crimes/language-js";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import type { LanguageJsDetectorContext } from "../detector.js";
import { returnShapeRouletteDetector } from "./return-shape-roulette.js";

function makeCtx(source: string): LanguageJsDetectorContext {
  return {
    kind: "language-js",
    file: "src/result.ts",
    absolutePath: "/tmp/result.ts",
    source,
    parsed: parseFile({ absolutePath: "/tmp/result.ts", source }),
    config: DEFAULT_CONFIG,
  };
}

describe("returnShapeRouletteDetector", () => {
  it("detects branchy functions with divergent object return shapes", async () => {
    const source = `
export function parseResult(input: Input) {
  if (input.error) return { ok: false, code: input.code, message: input.message };
  if (input.redirect) return { url: input.url, permanent: false };
  return { ok: true, value: input.value, cached: input.cached };
}
`;
    const findings = await returnShapeRouletteDetector.run(makeCtx(source));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.type).toBe("return_shape_roulette");
  });

  it("ignores explicit return types", async () => {
    const source = `
export function parseResult(input: Input): ParseResult {
  if (input.error) return { ok: false, code: input.code };
  if (input.redirect) return { url: input.url };
  return { ok: true, value: input.value };
}
`;
    const findings = await returnShapeRouletteDetector.run(makeCtx(source));
    expect(findings).toEqual([]);
  });
});
