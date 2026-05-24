import { parseFile } from "@crimes/language-js";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import type { LanguageJsDetectorContext } from "../detector.js";
import { weakTestSignalDetector } from "./weak-test-signal.js";

function makeCtx(source: string, file = "src/example.test.ts"): LanguageJsDetectorContext {
  return {
    kind: "language-js",
    file,
    absolutePath: `/tmp/${file}`,
    source,
    parsed: parseFile({ absolutePath: `/tmp/${file}`, source }),
    config: DEFAULT_CONFIG,
  };
}

describe("weakTestSignalDetector", () => {
  it("detects tests with no assertions", async () => {
    const source = `
import { it } from "vitest";

it("renders billing page", () => {
  renderBillingPage();
});
`;
    const findings = await weakTestSignalDetector.run(makeCtx(source));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.type).toBe("weak_test_signal");
    expect(findings[0]!.severity).toBe("medium");
  });

  it("detects tests with only weak assertions", async () => {
    const source = `
test("creates invoice", () => {
  expect(createInvoice()).toBeTruthy();
});
`;
    const findings = await weakTestSignalDetector.run(makeCtx(source));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("low");
    expect(findings[0]!.evidence.join(" ")).toContain("weak assertion");
  });

  it("ignores meaningful assertions", async () => {
    const source = `
it("calculates total", () => {
  expect(calculateTotal()).toBe(42);
});
`;
    const findings = await weakTestSignalDetector.run(makeCtx(source));
    expect(findings).toEqual([]);
  });

  it("ignores non-test files and type-only tests", async () => {
    expect(await weakTestSignalDetector.run(makeCtx(`it("x", () => {});`, "src/example.ts"))).toEqual([]);
    expect(
      await weakTestSignalDetector.run(
        makeCtx(`it("types", () => { expectTypeOf(value).toEqualTypeOf<string>(); });`, "src/types.test.ts"),
      ),
    ).toEqual([]);
  });
});
