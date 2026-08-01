import { describe, expect, it } from "vitest";
import { conceptKeyOf, isProjectionPair } from "./concept.js";

describe("conceptKeyOf", () => {
  it("strips meaningless affixes so spellings of one concept agree", () => {
    const keys = ["User", "UserDTO", "UserModel", "UserSchema", "UserEntity", "user_type"].map(
      (n) => conceptKeyOf(n).key,
    );
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe("user");
  });

  it("singularises, including the irregular forms worth handling", () => {
    expect(conceptKeyOf("Users").base).toBe("user");
    expect(conceptKeyOf("Companies").base).toBe("company");
    expect(conceptKeyOf("Policies").base).toBe("policy");
    expect(conceptKeyOf("People").base).toBe("person");
  });

  it("does not strip a trailing s that is part of the word", () => {
    expect(conceptKeyOf("Status").base).toBe("status");
    expect(conceptKeyOf("Address").base).toBe("address");
  });

  it("retains projection markers in the key", () => {
    expect(conceptKeyOf("UserSummary").key).toBe("user::summary");
    expect(conceptKeyOf("CreateUserInput").key).toBe("user::create+input");
    expect(conceptKeyOf("PublicUser").key).toBe("user::public");
    expect(conceptKeyOf("UserRow").key).toBe("user::row");
  });

  it("sorts markers so word order does not change the key", () => {
    expect(conceptKeyOf("CreateUserInput").key).toBe(conceptKeyOf("UserInputCreate").key);
  });

  it("falls back to the whole name when everything is an affix", () => {
    // `Schema` alone has no concept; it must only ever match another
    // bare `Schema`, never every record in the repo.
    expect(conceptKeyOf("Schema").base).toBe("schema");
    expect(conceptKeyOf("Schema").key).not.toBe(conceptKeyOf("User").key);
  });
});

describe("isProjectionPair", () => {
  it("treats two unmarked names as the same record", () => {
    expect(isProjectionPair(conceptKeyOf("User"), conceptKeyOf("UserDTO"))).toBe(false);
  });

  it("treats a marked name and an unmarked one as a projection", () => {
    expect(isProjectionPair(conceptKeyOf("User"), conceptKeyOf("UserSummary"))).toBe(true);
    expect(isProjectionPair(conceptKeyOf("User"), conceptKeyOf("CreateUserInput"))).toBe(true);
  });

  it("treats two identically-marked names as the same projection", () => {
    expect(
      isProjectionPair(conceptKeyOf("UserSummary"), conceptKeyOf("UserSummaryDTO")),
    ).toBe(false);
  });

  it("treats differently-marked names as unrelated projections", () => {
    expect(
      isProjectionPair(conceptKeyOf("UserSummary"), conceptKeyOf("UserPatch")),
    ).toBe(true);
  });
});
