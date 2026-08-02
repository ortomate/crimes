import { describe, expect, it } from "vitest";
import { formatBlastRadius, formatChurn, formatTestGap } from "./score-format.js";

describe("formatBlastRadius", () => {
  it("labels the two counts distinctly when they differ", () => {
    // hono's src/utils/mime.ts: 5 files import it, 240 can reach it.
    // Rendering that as "240 importers" was the defect.
    expect(formatBlastRadius(1, { direct: 5, transitive: 240 })).toBe(
      "top-quartile (5 direct / 240 transitive importers)",
    );
  });

  it("never renders a bare importer count when the counts disagree", () => {
    const rendered = formatBlastRadius(1, { direct: 5, transitive: 240 });
    expect(rendered).not.toMatch(/\(\d+ importers?\)/);
    expect(rendered).toContain("direct");
    expect(rendered).toContain("transitive");
  });

  it("collapses to a direct-only phrasing when nothing is reachable indirectly", () => {
    expect(formatBlastRadius(0.85, { direct: 11, transitive: 11 })).toBe(
      "top-quartile (11 direct importers)",
    );
  });

  it("falls back to quartile-only when no counts are available", () => {
    expect(formatBlastRadius(0.85)).toBe("top-quartile");
    expect(formatBlastRadius(0.85, {})).toBe("top-quartile");
  });

  it("uses bottom-quartile for low scores", () => {
    expect(formatBlastRadius(0.15, { direct: 1, transitive: 2 })).toBe(
      "bottom-quartile (1 direct / 2 transitive importers)",
    );
  });

  it("uses singular form for one importer", () => {
    expect(formatBlastRadius(0.85, { direct: 1, transitive: 1 })).toBe(
      "top-quartile (1 direct importer)",
    );
  });

  it("renders whichever count is present when the other is missing", () => {
    expect(formatBlastRadius(0.85, { direct: 4 })).toBe(
      "top-quartile (4 direct importers)",
    );
    expect(formatBlastRadius(0.85, { transitive: 40 })).toBe(
      "top-quartile (40 transitive importers)",
    );
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
