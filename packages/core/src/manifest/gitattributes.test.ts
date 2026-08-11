import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generatedMatcherFor, parseGeneratedDeclarations } from "./gitattributes.js";

describe("parseGeneratedDeclarations", () => {
  it("reads a linguist-generated pattern with its line", () => {
    expect(
      parseGeneratedDeclarations("frontend/src/generated/** linguist-generated\n"),
    ).toEqual([{ pattern: "frontend/src/generated/**", line: 1 }]);
  });

  it("reads the pattern when other attributes share the line", () => {
    // posthog writes `* text=auto` elsewhere in the same file, and git
    // allows any number of attributes per pattern.
    expect(
      parseGeneratedDeclarations("schema.json binary linguist-generated -diff\n"),
    ).toEqual([{ pattern: "schema.json", line: 1 }]);
  });

  it("ignores patterns that do not claim to be generated", () => {
    const text = [
      "* text=auto",
      ".github/ export-ignore",
      "/.yarn/** linguist-vendored",
    ].join("\n");
    expect(parseGeneratedDeclarations(text)).toEqual([]);
  });

  /**
   * `-linguist-generated` and `linguist-generated=false` both mean "this
   * is NOT generated". Honouring either as an assertion would invert the
   * file's meaning and suppress findings the repo explicitly wanted.
   */
  it("does not treat a negated or false-valued attribute as a claim", () => {
    for (const attr of ["-linguist-generated", "linguist-generated=false"]) {
      expect(parseGeneratedDeclarations(`src/real.ts ${attr}\n`), attr).toEqual([]);
    }
  });

  it("skips comments and blank lines, and reports 1-based lines", () => {
    const text = ["# generated code", "", "a/**  linguist-generated"].join("\n");
    expect(parseGeneratedDeclarations(text)).toEqual([{ pattern: "a/**", line: 3 }]);
  });
});

describe("generatedMatcherFor", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "crimes-gitattributes-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("matches declared paths and nothing else", async () => {
    await writeFile(
      join(root, ".gitattributes"),
      [
        "* text=auto",
        "frontend/src/generated/** linguist-generated",
        "frontend/src/products.tsx linguist-generated",
        "posthog/temporal/proxy_service/proto/*_pb2*.py linguist-generated",
        "/.yarn/** linguist-vendored",
      ].join("\n"),
      "utf8",
    );
    const isGenerated = generatedMatcherFor(root);
    expect(isGenerated("frontend/src/generated/schema.ts")).toBe(true);
    expect(isGenerated("frontend/src/products.tsx")).toBe(true);
    expect(isGenerated("posthog/temporal/proxy_service/proto/thing_pb2.py")).toBe(true);
    // Declared vendored, not generated — a display hint, not a claim
    // about who wrote the file.
    expect(isGenerated(".yarn/releases/yarn.js")).toBe(false);
    expect(isGenerated("frontend/src/App.tsx")).toBe(false);
  });

  it("is false for every path when .gitattributes is absent", async () => {
    const isGenerated = generatedMatcherFor(root);
    expect(isGenerated("anything.ts")).toBe(false);
  });

  it("is false for every path when nothing is declared generated", async () => {
    await writeFile(join(root, ".gitattributes"), "* text=auto\n", "utf8");
    expect(generatedMatcherFor(root)("anything.ts")).toBe(false);
  });

  it("refuses absolute and parent-relative paths rather than throwing", async () => {
    await writeFile(join(root, ".gitattributes"), "gen/** linguist-generated\n", "utf8");
    const isGenerated = generatedMatcherFor(root);
    for (const path of ["", "/abs/gen/x.ts", "../gen/x.ts"]) {
      expect(isGenerated(path), path).toBe(false);
    }
  });

  it("anchors a leading slash to the repo root", async () => {
    await writeFile(join(root, ".gitattributes"), "/gen/** linguist-generated\n", "utf8");
    expect(generatedMatcherFor(root)("gen/x.ts")).toBe(true);
  });
});
