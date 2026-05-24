import { describe, expect, it } from "vitest";
import type { TypedDeclaration } from "@crimes/language-js";
import { DEFAULT_CONFIG } from "../config.js";
import type { LanguageJsDetector, LanguageJsDetectorContext } from "../detector.js";
import { singularPluralTypeMismatchDetector as _singularPluralTypeMismatchDetector } from "./singular-plural-type-mismatch.js";
const singularPluralTypeMismatchDetector = _singularPluralTypeMismatchDetector as LanguageJsDetector;

function makeCtx(
  decls: TypedDeclaration[] | undefined,
  overrides: { file?: string } = {},
): LanguageJsDetectorContext {
  return {
    kind: "language-js",
    file: overrides.file ?? "src/data.ts",
    absolutePath: "/tmp/data.ts",
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

function decl(name: string, type: string, line = 1): TypedDeclaration {
  return {
    name,
    declarationKind: "const",
    type,
    exported: false,
    line,
  };
}

describe("singularPluralTypeMismatchDetector", () => {
  it("returns nothing on a clean file", async () => {
    expect(await singularPluralTypeMismatchDetector.run(makeCtx([]))).toEqual([]);
    expect(await singularPluralTypeMismatchDetector.run(makeCtx(undefined))).toEqual([]);
  });

  it("fires on `users: User` (plural name, singular type)", async () => {
    const findings = await singularPluralTypeMismatchDetector.run(
      makeCtx([decl("users", "User", 5)]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.charge).toBe("Plural Mismatch");
    expect(findings[0]!.severity).toBe("low");
    const evidence = findings[0]!.evidence.join(" ");
    expect(evidence).toContain("plural name, singular type");
    expect(evidence).toContain("`users: User`");
  });

  it("fires on `user: User[]` (singular name, array type)", async () => {
    const findings = await singularPluralTypeMismatchDetector.run(
      makeCtx([decl("user", "User[]", 5)]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.evidence.join(" ")).toContain("singular name, array type");
  });

  it("recognises Array<T> and ReadonlyArray<T>", async () => {
    const findings = await singularPluralTypeMismatchDetector.run(
      makeCtx([
        decl("user", "Array<User>", 1),
        decl("invoice", "ReadonlyArray<Invoice>", 2),
      ]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.summary).toMatch(/2 declarations/);
  });

  it("does NOT fire on matching `user: User`", async () => {
    const findings = await singularPluralTypeMismatchDetector.run(
      makeCtx([decl("user", "User")]),
    );
    expect(findings).toEqual([]);
  });

  it("does NOT fire on matching `users: User[]`", async () => {
    const findings = await singularPluralTypeMismatchDetector.run(
      makeCtx([decl("users", "User[]")]),
    );
    expect(findings).toEqual([]);
  });

  it("does NOT fire on uncountable nouns (`data: SomeType`)", async () => {
    const findings = await singularPluralTypeMismatchDetector.run(
      makeCtx([decl("data", "PayloadInfo")]),
    );
    expect(findings).toEqual([]);
  });

  it("does NOT fire when names don't pluralise-match the type element", async () => {
    // `things: Banana` — type and name don't share a singular root.
    const findings = await singularPluralTypeMismatchDetector.run(
      makeCtx([decl("things", "Banana")]),
    );
    expect(findings).toEqual([]);
  });

  it("does NOT fire on aliased / generic / union types (v1 limitation)", async () => {
    const findings = await singularPluralTypeMismatchDetector.run(
      makeCtx([
        decl("users", "UserDto"),
        decl("orders", "Map<string, Order>"),
        decl("items", "Item | null"),
      ]),
    );
    expect(findings).toEqual([]);
  });

  it("escalates to medium at 4+ offenders", async () => {
    const offenders = [
      decl("users", "User", 1),
      decl("invoices", "Invoice", 2),
      decl("orders", "Order", 3),
      decl("items", "Item", 4),
    ];
    const findings = await singularPluralTypeMismatchDetector.run(makeCtx(offenders));
    expect(findings[0]!.severity).toBe("medium");
  });

  it("honours detectors.options.allowedNames", async () => {
    const ctx = makeCtx([
      decl("users", "User", 1),
      decl("posts", "Post", 2),
    ]);
    ctx.config = {
      ...ctx.config,
      detectors: {
        options: {
          singular_plural_type_mismatch: { allowedNames: ["users"] },
        },
      },
    };
    const findings = await singularPluralTypeMismatchDetector.run(ctx);
    expect(findings).toHaveLength(1);
    const evidence = findings[0]!.evidence.join(" ");
    expect(evidence).not.toContain("`users:");
    expect(evidence).toContain("`posts:");
  });

  it("declares an optionsSchema", () => {
    const schema = singularPluralTypeMismatchDetector.optionsSchema!;
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ allowedNames: ["x"] }).success).toBe(true);
    expect(schema.safeParse({ unknownKey: 1 }).success).toBe(false);
  });

  it("skips test files", async () => {
    const findings = await singularPluralTypeMismatchDetector.run(
      makeCtx([decl("users", "User")], { file: "src/data.test.ts" }),
    );
    expect(findings).toEqual([]);
  });
});
