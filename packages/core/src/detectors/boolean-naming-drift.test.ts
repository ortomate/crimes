import { describe, expect, it } from "vitest";
import type { TypedDeclaration } from "@crimes/language-js";
import { DEFAULT_CONFIG } from "../config.js";
import type { LanguageJsDetector, LanguageJsDetectorContext } from "../detector.js";
import { booleanNamingDriftDetector as _booleanNamingDriftDetector } from "./boolean-naming-drift.js";
const booleanNamingDriftDetector = _booleanNamingDriftDetector as LanguageJsDetector;

function makeCtx(
  decls: TypedDeclaration[] | undefined,
  overrides: { file?: string } = {},
): LanguageJsDetectorContext {
  return {
    kind: "language-js",
    file: overrides.file ?? "src/state.ts",
    absolutePath: "/tmp/state.ts",
    source: "",
    parsed: {
      lineCount: 50,
      functions: [],
      dateNowOrNewDateUses: [],
      typedDeclarations: decls,
    },
    config: DEFAULT_CONFIG,
  };
}

function decl(name: string, fields: Partial<TypedDeclaration> = {}): TypedDeclaration {
  return {
    name,
    declarationKind: "const",
    exported: false,
    line: 1,
    ...fields,
  };
}

describe("booleanNamingDriftDetector", () => {
  it("returns nothing on a clean file", async () => {
    expect(await booleanNamingDriftDetector.run(makeCtx([]))).toEqual([]);
    expect(await booleanNamingDriftDetector.run(makeCtx(undefined))).toEqual([]);
  });

  it("fires on `: boolean` declarations without a recognised prefix", async () => {
    const findings = await booleanNamingDriftDetector.run(
      makeCtx([decl("paid", { type: "boolean", line: 5 })]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.charge).toBe("Unprefixed Boolean");
    expect(findings[0]!.severity).toBe("low");
    expect(findings[0]!.evidence.join(" ")).toContain("`paid`");
  });

  it("fires when initializer is a boolean literal even without an explicit type", async () => {
    const findings = await booleanNamingDriftDetector.run(
      makeCtx([decl("done", { initializerKind: "boolean_literal", line: 7 })]),
    );
    expect(findings).toHaveLength(1);
  });

  it("fires on negation and comparison initializers", async () => {
    const findings = await booleanNamingDriftDetector.run(
      makeCtx([
        decl("hidden_flag", { initializerKind: "negation", line: 1 }),
        decl("same", { initializerKind: "comparison", line: 2 }),
      ]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.summary).toMatch(/2 boolean-typed declarations/);
  });

  it("does NOT fire on names with recognised boolean prefixes", async () => {
    const findings = await booleanNamingDriftDetector.run(
      makeCtx([
        decl("isReady", { type: "boolean" }),
        decl("hasAccess", { type: "boolean" }),
        decl("shouldFetch", { type: "boolean" }),
        decl("canEdit", { type: "boolean" }),
        decl("willRetry", { type: "boolean" }),
      ]),
    );
    expect(findings).toEqual([]);
  });

  it("does NOT fire on built-in boolean-state allowlist", async () => {
    const allowlist = [
      "loading",
      "loaded",
      "ready",
      "active",
      "disabled",
      "visible",
      "open",
      "found",
      "settled",
      "overflow",
      "typeOnly",
      "interpolated",
      "limited",
      "existed",
    ];
    const findings = await booleanNamingDriftDetector.run(
      makeCtx(allowlist.map((n) => decl(n, { type: "boolean" }))),
    );
    expect(findings).toEqual([]);
  });

  it("does NOT fire on all-uppercase constants", async () => {
    const findings = await booleanNamingDriftDetector.run(
      makeCtx([
        decl("FEATURE_X_ENABLED", { type: "boolean" }),
        decl("DEBUG", { initializerKind: "boolean_literal" }),
      ]),
    );
    expect(findings).toEqual([]);
  });

  it("does NOT fire on non-boolean shapes", async () => {
    const findings = await booleanNamingDriftDetector.run(
      makeCtx([
        decl("count", { type: "number" }),
        decl("label", { initializerKind: "string" }),
      ]),
    );
    expect(findings).toEqual([]);
  });

  it("escalates to medium at 5+ offenders", async () => {
    const offenders = ["paid", "done", "shipped", "complete", "active_state"].map(
      (n) => decl(n, { type: "boolean", line: 1 }),
    );
    const findings = await booleanNamingDriftDetector.run(makeCtx(offenders));
    expect(findings[0]!.severity).toBe("medium");
  });

  it("honours detectors.options.boolean_naming_drift.allowedNames", async () => {
    const ctx = makeCtx([
      decl("paid", { type: "boolean", line: 1 }),
      decl("pristine", { type: "boolean", line: 2 }),
    ]);
    ctx.config = {
      ...ctx.config,
      detectors: {
        options: { boolean_naming_drift: { allowedNames: ["pristine"] } },
      },
    };
    const findings = await booleanNamingDriftDetector.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.evidence.join(" ")).toContain("`paid`");
    expect(findings[0]!.evidence.join(" ")).not.toContain("`pristine`");
  });

  it("declares an optionsSchema the config loader can validate against", () => {
    const schema = booleanNamingDriftDetector.optionsSchema!;
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ allowedNames: ["a"] }).success).toBe(true);
    expect(schema.safeParse({ allowedNames: 1 }).success).toBe(false);
    expect(schema.safeParse({ unknownKey: 1 }).success).toBe(false);
  });

  it("skips test files", async () => {
    const findings = await booleanNamingDriftDetector.run(
      makeCtx([decl("paid", { type: "boolean" })], { file: "src/state.test.ts" }),
    );
    expect(findings).toEqual([]);
  });
});
