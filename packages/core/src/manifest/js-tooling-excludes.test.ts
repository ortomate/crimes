import { describe, expect, it } from "vitest";
import { readEslintFlatIgnores, readIgnoreFile } from "./js-tooling-excludes.js";

const PRETTIER = { file: ".prettierignore", tool: "prettier" };

describe("readIgnoreFile", () => {
  it("reads patterns and strips the leading anchor", () => {
    const entry = readIgnoreFile("# third party\n/js/lib/\n\nless/vendor\n", PRETTIER);
    expect(entry).toEqual({
      table: ".prettierignore",
      key: "patterns",
      tool: "prettier",
      patterns: ["js/lib/", "less/vendor"],
    });
  });

  it("yields nothing when any line is a negation", () => {
    expect(readIgnoreFile("js/lib/\n!js/lib/ours.js\n", PRETTIER)).toBeUndefined();
  });

  it("yields nothing for an empty file", () => {
    expect(readIgnoreFile("# nothing\n\n", PRETTIER)).toBeUndefined();
  });
});

describe("readEslintFlatIgnores", () => {
  it("reads a global ignores object of string literals", () => {
    const source = `export default [
  { ignores: ['etc/*', "js/lib/*", \`generated-api/*\`] },
  { files: ['**/*.ts'], rules: {} },
]`;
    expect(readEslintFlatIgnores(source, "eslint.config.mjs")?.patterns).toEqual([
      "etc/*",
      "js/lib/*",
      "generated-api/*",
    ]);
  });

  it("ignores `ignores` scoped beside files or rules", () => {
    const source = `export default [{ files: ['src/**'], ignores: ['src/legacy/**'] }]`;
    expect(readEslintFlatIgnores(source, "eslint.config.js")).toBeUndefined();
  });

  it("drops an object holding anything but string literals", () => {
    const source = "export default [{ ignores: [...generated, 'dist'] }]";
    expect(readEslintFlatIgnores(source, "eslint.config.js")).toBeUndefined();
  });

  it("drops template literals with interpolation", () => {
    const source = "export default [{ ignores: [`${root}/dist`] }]";
    expect(readEslintFlatIgnores(source, "eslint.config.js")).toBeUndefined();
  });

  it("yields nothing when a global ignore negates", () => {
    const source = "export default [{ ignores: ['dist/*', '!dist/keep.js'] }]";
    expect(readEslintFlatIgnores(source, "eslint.config.js")).toBeUndefined();
  });
});
