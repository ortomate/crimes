import { parseFile } from "@crimes/language-js";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import type { LanguageJsDetectorContext } from "../detector.js";
import { weakTestSignalDetector } from "./weak-test-signal.js";

function makeCtx(
  source: string,
  file = "src/example.test.ts",
): LanguageJsDetectorContext {
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
    expect(
      await weakTestSignalDetector.run(makeCtx(`it("x", () => {});`, "src/example.ts")),
    ).toEqual([]);
    expect(
      await weakTestSignalDetector.run(
        makeCtx(
          `it("types", () => { expectTypeOf(value).toEqualTypeOf<string>(); });`,
          "src/types.test.ts",
        ),
      ),
    ).toEqual([]);
  });
});

describe("weak_test_signal fingerprint uniqueness", () => {
  it("gives each test in a file a distinct fingerprint", async () => {
    // One finding per test block, no `symbol`, so every finding in a file
    // shared `weak_test_signal::<file>::`. Eight tests in a single hono
    // file collapsed onto one fingerprint; zulip lost 114 findings this
    // way. `crimes ignore` on one silenced all of them.
    const source = [
      "it('alpha', () => {",
      "  setup();",
      "});",
      "it('beta', () => {",
      "  setup();",
      "});",
      "it('gamma', () => {",
      "  setup();",
      "});",
    ].join("\n");

    const found = await weakTestSignalDetector.run(makeCtx(source, "src/a.test.ts"));
    expect(found.length).toBeGreaterThanOrEqual(2);

    const discriminators = found.map((f) => f.discriminator);
    expect(discriminators.every((d) => typeof d === "string" && d.length > 0)).toBe(true);
    expect(new Set(discriminators).size).toBe(found.length);
  });
});

describe("weak_test_signal — two tests with the same title", () => {
  // The residual case 0.4.0's title discriminator could not reach.
  // Measured on n8n `packages/cli`: 4 findings in 2 groups, both a
  // pair of identically-titled `it(...)` blocks in one file —
  // `credentials.service.test.ts` and `source-control-import.service.test.ts`.
  // `crimes ignore` on either silenced the other.
  it("separates them by start line", async () => {
    const source = [
      "it('creates a credential', () => {",
      "  setup();",
      "});",
      "it('creates a credential', () => {",
      "  setupDifferently();",
      "});",
    ].join("\n");

    const found = await weakTestSignalDetector.run(makeCtx(source, "src/a.test.ts"));
    expect(found).toHaveLength(2);
    expect(new Set(found.map((f) => f.discriminator)).size).toBe(2);
    expect(found.map((f) => f.discriminator)).toEqual([
      "creates a credential@L1",
      "creates a credential@L4",
    ]);
  });

  // Rule 1 of `resolveDiscriminators` must not apply here. The title
  // has been part of this detector's fingerprint since schema_version
  // 0.4.0, so dropping it from a file with one silent test would
  // change a fingerprint that was never ambiguous — breaking pins for
  // exactly the findings this change is not about.
  it("leaves a lone silent test's fingerprint alone", async () => {
    const source = [
      "it('asserts properly', () => {",
      "  expect(compute()).toBe(1);",
      "});",
      "it('proves nothing', () => {",
      "  setup();",
      "});",
    ].join("\n");

    const found = await weakTestSignalDetector.run(makeCtx(source, "src/b.test.ts"));
    expect(found).toHaveLength(1);
    expect(found[0]!.discriminator).toBe("proves nothing");
  });
});
