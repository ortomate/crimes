import { describe, expect, it } from "vitest";
import {
  RELEASE_NOTES,
  RELEASE_NOTES_FALLBACK,
  releaseNoteFor,
} from "./release-notes.js";

describe("releaseNoteFor", () => {
  it("returns the baked-in hint for a known (detector, minor) pair", () => {
    expect(releaseNoteFor("direct_date", "0.7")).toMatch(/skips test files/);
    expect(releaseNoteFor("large_function", "0.6")).toMatch(/cli_command_registrar/);
  });

  it("falls back when no entry exists for the detector", () => {
    expect(releaseNoteFor("brand_new_detector", "0.7")).toBe(RELEASE_NOTES_FALLBACK);
  });

  it("falls back when the detector exists but the minor doesn't", () => {
    expect(releaseNoteFor("direct_date", "0.99")).toBe(RELEASE_NOTES_FALLBACK);
  });

  it("the map is non-empty (covers at least the §6.1 / §6.3 fixes)", () => {
    expect(Object.keys(RELEASE_NOTES).length).toBeGreaterThan(0);
  });
});
