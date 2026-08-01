import { describe, expect, it } from "vitest";
import { extractComments } from "./comments.js";

describe("extractComments", () => {
  it("extracts line comments and preserves line numbers", () => {
    const comments = extractComments("const x = 1;\n// first\n// second\nconst y = 2;\n");
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      kind: "line",
      text: "first\nsecond",
      startLine: 2,
      endLine: 3,
    });
  });

  it("extracts block comments", () => {
    const comments = extractComments("const x = 1;\n/*\n * hello\n * world\n */\n");
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      kind: "block",
      text: "hello\nworld",
      startLine: 2,
      endLine: 5,
    });
  });

  it("ignores comment markers inside strings and templates", () => {
    const comments = extractComments(
      'const url = "https://example.com";\nconst text = `/* not a comment */`;\n// real\n',
    );
    expect(comments).toHaveLength(1);
    expect(comments[0]!.text).toBe("real");
  });
});
