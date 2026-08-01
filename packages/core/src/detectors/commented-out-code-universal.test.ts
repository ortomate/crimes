import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import type { UniversalDetectorContext } from "../detector.js";
import { commentedOutCodeUniversalDetector } from "./commented-out-code-universal.js";

function makeCtx(file: string, source: string): UniversalDetectorContext {
  return {
    kind: "universal",
    file,
    absolutePath: `/tmp/${file}`,
    extension: file.match(/\.[^./]+$/)?.[0] ?? "",
    byteSize: source.length,
    readSource: async () => source,
    get lineCount() {
      return source.split("\n").length;
    },
    config: DEFAULT_CONFIG,
  };
}

describe("commentedOutCodeUniversalDetector", () => {
  it("skips JS files (the AST variant handles those)", async () => {
    const findings = await commentedOutCodeUniversalDetector.run(
      makeCtx(
        "src/x.ts",
        "// const x = 1;\n// const y = 2;\n// const z = 3;\n// const a = 4;",
      ),
    );
    expect(findings).toEqual([]);
  });

  it("fires on a .py file with multiple consecutive `# def`-shaped comments", async () => {
    const findings = await commentedOutCodeUniversalDetector.run(
      makeCtx(
        "src/x.py",
        [
          "# def old_function(x):",
          "#     return x + 1",
          "# def helper():",
          "#     pass",
          "active_code = 1",
        ].join("\n"),
      ),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.type).toBe("commented_out_code");
  });

  it("does not fire on prose comments", async () => {
    const findings = await commentedOutCodeUniversalDetector.run(
      makeCtx(
        "src/notes.py",
        [
          "# This module handles user authentication.",
          "# It exposes a single function `login`.",
          "# See ADR-007 for the full design.",
          "def login(): pass",
        ].join("\n"),
      ),
    );
    expect(findings).toEqual([]);
  });

  it("fires on a .rs file with bracketed commented code", async () => {
    const findings = await commentedOutCodeUniversalDetector.run(
      makeCtx(
        "src/x.rs",
        [
          "// fn old() -> i32 {",
          "//   return 42;",
          "// }",
          "// let unused = 1;",
          "fn current() {}",
        ].join("\n"),
      ),
    );
    expect(findings).toHaveLength(1);
  });
});
