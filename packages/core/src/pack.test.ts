import { describe, expect, it } from "vitest";
import { isLanguagePack, PACK_IDS, type Pack } from "./pack.js";

describe("Pack type", () => {
  it("enumerates the four pack ids", () => {
    expect(PACK_IDS).toEqual([
      "universal",
      "language-js",
      "language-py",
      "cross-language",
    ]);
  });

  it("isLanguagePack returns true only for language packs", () => {
    const cases: Array<[Pack, boolean]> = [
      ["universal", false],
      ["language-js", true],
      ["language-py", true],
      ["cross-language", false],
    ];
    for (const [pack, expected] of cases) {
      expect(isLanguagePack(pack)).toBe(expected);
    }
  });
});
