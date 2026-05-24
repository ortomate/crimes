import { parseFile } from "@crimes/language-js";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import type { LanguageJsDetectorContext } from "../detector.js";
import { negativeFlagMazeDetector } from "./negative-flag-maze.js";

function makeCtx(source: string): LanguageJsDetectorContext {
  return {
    kind: "language-js",
    file: "src/flags.ts",
    absolutePath: "/tmp/flags.ts",
    source,
    parsed: parseFile({ absolutePath: "/tmp/flags.ts", source }),
    config: DEFAULT_CONFIG,
  };
}

describe("negativeFlagMazeDetector", () => {
  it("detects conditionals with multiple negative flags", async () => {
    const source = `
export function canRun(disableBilling: boolean, skipRetry: boolean) {
  if (!disableBilling && !skipRetry) return true;
  return false;
}
`;
    const findings = await negativeFlagMazeDetector.run(makeCtx(source));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.type).toBe("negative_flag_maze");
    expect(findings[0]!.evidence.join(" ")).toContain("disableBilling");
  });

  it("ignores simple positive predicates", async () => {
    const source = `
export function canRun(isEnabled: boolean, hasPlan: boolean) {
  if (isEnabled && hasPlan) return true;
  return false;
}
`;
    const findings = await negativeFlagMazeDetector.run(makeCtx(source));
    expect(findings).toEqual([]);
  });
});
