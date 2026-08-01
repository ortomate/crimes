import { describe, expect, it } from "vitest";
import { extractStringLiterals } from "./literals.js";

describe("extractStringLiterals", () => {
  it("extracts string literals with line numbers", () => {
    const literals = extractStringLiterals("const a = \"active\";\nconst b = 'pro';\n");
    expect(literals.map((l) => [l.value, l.line])).toEqual([
      ["active", 1],
      ["pro", 2],
    ]);
  });

  it("ignores comment text", () => {
    const literals = extractStringLiterals(
      '// "old"\n/* \'stale\' */\nconst x = "live";\n',
    );
    expect(literals.map((l) => l.value)).toEqual(["live"]);
  });

  it("ignores interpolated templates but keeps plain templates", () => {
    const literals = extractStringLiterals(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: this string IS source code handed to the parser; the ${id} must stay unexpanded.
      "const a = `plain.key`;\nconst b = `user.${id}`;\n",
    );
    expect(literals.map((l) => l.value)).toEqual(["plain.key"]);
  });
});
