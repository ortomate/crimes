import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import type { UniversalDetectorContext } from "../detector.js";
import { finderDuplicateFilenameDetector } from "./finder-duplicate-filename.js";

function makeCtx(file: string): UniversalDetectorContext {
  return {
    kind: "universal",
    file,
    absolutePath: `/tmp/${file}`,
    extension: file.match(/\.[^./]+$/)?.[0] ?? "",
    byteSize: 0,
    readSource: async () => "",
    get lineCount() {
      return 1;
    },
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

describe("finderDuplicateFilenameDetector — universal pack", () => {
  it("fires on `Button 2.rs` (non-JS)", async () => {
    const findings = await finderDuplicateFilenameDetector.run(
      makeCtx("src/Button 2.rs"),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.evidence.some((e) => e.includes("Button 2.rs"))).toBe(
      true,
    );
  });

  it("fires on `notes 3.md`", async () => {
    const findings = await finderDuplicateFilenameDetector.run(
      makeCtx("docs/notes 3.md"),
    );
    expect(findings).toHaveLength(1);
  });
});
