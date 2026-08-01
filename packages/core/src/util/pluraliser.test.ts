import { describe, expect, it } from "vitest";
import { isUncountable, looksPlural, pluralise, singularise } from "./pluraliser.js";

describe("pluraliser", () => {
  it("handles regular -s plurals", () => {
    expect(pluralise("cat")).toBe("cats");
    expect(pluralise("dog")).toBe("dogs");
    expect(pluralise("user")).toBe("users");
  });

  it("handles -es for s/x/z/ch/sh endings", () => {
    expect(pluralise("box")).toBe("boxes");
    expect(pluralise("bus")).toBe("buses");
    expect(pluralise("class")).toBe("classes");
    expect(pluralise("dish")).toBe("dishes");
    expect(pluralise("watch")).toBe("watches");
  });

  it("handles consonant-y → -ies", () => {
    expect(pluralise("party")).toBe("parties");
    expect(pluralise("city")).toBe("cities");
  });

  it("keeps vowel-y as -ys", () => {
    expect(pluralise("day")).toBe("days");
    expect(pluralise("boy")).toBe("boys");
  });

  it("handles irregular plurals", () => {
    expect(pluralise("child")).toBe("children");
    expect(pluralise("person")).toBe("people");
    expect(pluralise("mouse")).toBe("mice");
    expect(pluralise("criterion")).toBe("criteria");
  });

  it("preserves leading case", () => {
    expect(pluralise("Child")).toBe("Children");
    expect(pluralise("User")).toBe("Users");
  });

  it("leaves uncountables unchanged on pluralise", () => {
    expect(pluralise("data")).toBe("data");
    expect(pluralise("information")).toBe("information");
    expect(pluralise("feedback")).toBe("feedback");
  });

  it("singularises regular -s", () => {
    expect(singularise("cats")).toBe("cat");
    expect(singularise("users")).toBe("user");
  });

  it("singularises -ies → -y", () => {
    expect(singularise("parties")).toBe("party");
    expect(singularise("cities")).toBe("city");
  });

  it("singularises -es words", () => {
    expect(singularise("boxes")).toBe("box");
    expect(singularise("buses")).toBe("bus");
    expect(singularise("classes")).toBe("class");
  });

  it("singularises irregular plurals", () => {
    expect(singularise("children")).toBe("child");
    expect(singularise("people")).toBe("person");
    expect(singularise("mice")).toBe("mouse");
  });

  it("leaves -ss/-us/-is/-os/-as endings alone (treats as singular)", () => {
    expect(singularise("class")).toBe("class");
    expect(singularise("bus")).toBe("bus");
    expect(singularise("basis")).toBe("basis");
    expect(singularise("status")).toBe("status");
    // The irregular `bases` → `basis` still wins via the irregular map.
    expect(singularise("bases")).toBe("basis");
  });

  it("looksPlural is false for singulars and uncountables", () => {
    expect(looksPlural("user")).toBe(false);
    expect(looksPlural("class")).toBe(false);
    expect(looksPlural("data")).toBe(false);
    expect(looksPlural("status")).toBe(false);
  });

  it("looksPlural is true for clear plurals", () => {
    expect(looksPlural("users")).toBe(true);
    expect(looksPlural("parties")).toBe(true);
    expect(looksPlural("children")).toBe(true);
  });

  it("isUncountable identifies the canonical set", () => {
    expect(isUncountable("data")).toBe(true);
    expect(isUncountable("Data")).toBe(true);
    expect(isUncountable("information")).toBe(true);
    expect(isUncountable("user")).toBe(false);
  });
});
