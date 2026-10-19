import { describe, expect, it } from "vitest";
import { isTestFile, TEST_FILE_RE, testBaseCovers } from "./test-files.js";

describe("isTestFile", () => {
  it("matches *.test.[cm]?[jt]sx? files at the path leaf", () => {
    expect(isTestFile("src/foo.test.ts")).toBe(true);
    expect(isTestFile("src/foo.test.tsx")).toBe(true);
    expect(isTestFile("src/foo.test.js")).toBe(true);
    expect(isTestFile("src/foo.test.jsx")).toBe(true);
    expect(isTestFile("src/foo.test.mts")).toBe(true);
    expect(isTestFile("src/foo.test.cts")).toBe(true);
  });

  it("matches *.spec.* equivalents", () => {
    expect(isTestFile("src/foo.spec.ts")).toBe(true);
    expect(isTestFile("apps/web/src/page.spec.tsx")).toBe(true);
  });

  it("matches anything under a __tests__ directory", () => {
    expect(isTestFile("src/__tests__/foo.ts")).toBe(true);
    expect(isTestFile("__tests__/index.ts")).toBe(true);
    expect(isTestFile("packages/core/src/__tests__/build.ts")).toBe(true);
  });

  it("does not match plain source files", () => {
    expect(isTestFile("src/foo.ts")).toBe(false);
    expect(isTestFile("src/test.ts")).toBe(false); // bare 'test.ts' is not a test file
    expect(isTestFile("src/testing.ts")).toBe(false);
    expect(isTestFile("packages/core/src/scan.ts")).toBe(false);
  });

  it("exports the same regex used internally", () => {
    expect(TEST_FILE_RE.test("foo.test.ts")).toBe(true);
    expect(TEST_FILE_RE.test("foo.ts")).toBe(false);
  });
});

describe("Java test conventions", () => {
  it("recognises JUnit naming and the Maven test tree", () => {
    expect(isTestFile("core/src/test/java/com/acme/om/FilmTest.java")).toBe(true);
    expect(isTestFile("test/src/test/java/com/acme/om/FilmTests.java")).toBe(true);
    expect(isTestFile("api/src/test/java/com/acme/ApiIT.java")).toBe(true);
    expect(isTestFile("api/src/test/java/com/acme/support/Fixtures.java")).toBe(true);
    expect(isTestFile("core/src/main/java/com/acme/om/Film.java")).toBe(false);
    expect(isTestFile("core/src/main/java/com/acme/om/Contest.java")).toBe(false);
  });

  it("keeps the src/test rule to Java", () => {
    expect(isTestFile("app/src/test/helpers.ts")).toBe(false);
  });

  it("pairs a Java test with the class it covers", () => {
    expect(testBaseCovers("FilmTest", "Film")).toBe(true);
    expect(testBaseCovers("FilmServiceIT", "FilmService")).toBe(true);
    expect(testBaseCovers("Test", "")).toBe(false);
  });
});
