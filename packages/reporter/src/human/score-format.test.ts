import { describe, expect, it } from "vitest";
import {
  formatBlastRadius,
  formatChurn,
  formatTestGap,
} from "./score-format.js";

describe("formatBlastRadius", () => {
  it("returns top-quartile + importer count when both present", () => {
    expect(formatBlastRadius(0.85, 11)).toBe("top-quartile (11 importers)");
  });

  it("falls back to quartile-only when importer count missing", () => {
    expect(formatBlastRadius(0.85)).toBe("top-quartile");
  });

  it("uses bottom-quartile for low scores", () => {
    expect(formatBlastRadius(0.15, 2)).toBe("bottom-quartile (2 importers)");
  });

  it("uses singular form for one importer", () => {
    expect(formatBlastRadius(0.85, 1)).toBe("top-quartile (1 importer)");
  });

  it("renders the median band for mid-range scores", () => {
    expect(formatBlastRadius(0.5)).toBe("median");
  });
});

describe("formatChurn", () => {
  it("renders commits + last touched when both present", () => {
    const now = new Date("2026-05-20T00:00:00Z");
    expect(formatChurn(0.6, 24, "2026-05-18T00:00:00Z", now)).toBe(
      "24 commits over 90d · last touched 2 days ago",
    );
  });

  it("omits last touched when lastCommitAt is undefined", () => {
    expect(formatChurn(0.6, 24)).toBe("24 commits over 90d");
  });

  it("falls back to high/medium/low band when no commits supplied", () => {
    expect(formatChurn(0.8)).toBe("high");
    expect(formatChurn(0.5)).toBe("medium");
    expect(formatChurn(0.2)).toBe("low");
  });

  it("formats today / yesterday", () => {
    const now = new Date("2026-05-20T12:00:00Z");
    expect(formatChurn(0.6, 1, "2026-05-20T01:00:00Z", now)).toContain("today");
    expect(formatChurn(0.6, 1, "2026-05-19T11:30:00Z", now)).toContain("yesterday");
  });

  it("uses weeks/months at larger horizons", () => {
    const now = new Date("2026-05-20T00:00:00Z");
    expect(formatChurn(0.6, 5, "2026-02-20T00:00:00Z", now)).toContain("month");
    expect(formatChurn(0.6, 5, "2026-05-01T00:00:00Z", now)).toContain("weeks ago");
  });
});

describe("formatTestGap", () => {
  it("returns the supplied label when one is provided", () => {
    expect(formatTestGap(1.0, "top-quartile")).toBe("top-quartile");
  });

  it("derives a label from the raw score when no label supplied", () => {
    expect(formatTestGap(0.8)).toBe("top-quartile");
    expect(formatTestGap(0.5)).toBe("median");
    expect(formatTestGap(0.1)).toBe("bottom-quartile");
  });

  it("falls through to the raw score when label is 'unknown'", () => {
    expect(formatTestGap(0.9, "unknown")).toBe("top-quartile");
  });
});
