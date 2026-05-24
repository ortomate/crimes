import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import type { LanguageJsDetector, LanguageJsDetectorContext } from "../detector.js";
import { finderDuplicateFilenameDetector as _finderDuplicateFilenameDetector } from "./finder-duplicate-filename.js";
const finderDuplicateFilenameDetector = _finderDuplicateFilenameDetector as LanguageJsDetector;

function makeCtx(file: string): LanguageJsDetectorContext {
  return {
    kind: "language-js",
    file,
    absolutePath: `/tmp/${file}`,
    source: "",
    parsed: { lineCount: 0, functions: [], dateNowOrNewDateUses: [] },
    config: DEFAULT_CONFIG,
  };
}

describe("finderDuplicateFilenameDetector", () => {
  it("flags macOS Finder-style duplicate filenames", async () => {
    const findings = await finderDuplicateFilenameDetector.run(
      makeCtx("src/components/Button 2.tsx"),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.type).toBe("finder_duplicate_filename");
    expect(findings[0]!.severity).toBe("medium");
    expect(findings[0]!.related_files).toEqual(["src/components/Button.tsx"]);
    expect(findings[0]!.evidence.join(" ")).toContain("Button 2.tsx");
  });

  it("ignores ordinary filenames that contain numbers", async () => {
    for (const file of [
      "src/Page2.tsx",
      "src/v2.ts",
      "src/Billing 2026.ts",
      "src/Button copy.tsx",
      "src/Button.tsx",
    ]) {
      expect(await finderDuplicateFilenameDetector.run(makeCtx(file))).toEqual([]);
    }
  });
});
