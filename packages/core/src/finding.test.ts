import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "./finding.js";

describe("SCHEMA_VERSION", () => {
  it("is 0.3.0 — universal pack release", () => {
    expect(SCHEMA_VERSION).toBe("0.3.0");
  });
});
