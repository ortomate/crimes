import { describe, expect, it } from "vitest";
import type { Finding } from "@crimes/core";
import { groupByFile, renderFileGroups } from "./scan-groups.js";
import { plainColour } from "./shared.js";

/**
 * Symbol rendering for the 0.16.0 identity symbols.
 *
 * The historical convention appends `()` to `Finding.symbol`, which was
 * always a function or class name. Several 0.16.0 detectors use `symbol`
 * to carry a stable *identity* instead — the fingerprint depends on it —
 * and `persistOrder → insert()` reads as though the arrow were part of a
 * call. These tests pin both halves of the rule.
 */

/** The package's own no-op colouriser, so assertions match raw text. */
const PLAIN = plainColour();

function finding(overrides: Partial<Finding>): Finding {
  return {
    id: "crime_00001",
    type: "large_function",
    pack: "language-js",
    detector_id: "large_function.js",
    charge: "God Function",
    severity: "medium",
    confidence: 0.8,
    file: "src/a.ts",
    summary: "summary",
    evidence: ["evidence"],
    effort: "small",
    fix_shape: "fix",
    scores: { severity: 0.5, confidence: 0.8 },
    ...overrides,
  };
}

function render(findings: Finding[]): string {
  const lines: string[] = [];
  renderFileGroups(lines, groupByFile(findings), PLAIN, true);
  return lines.join("\n");
}

describe("symbol rendering", () => {
  it("keeps the historical `()` for a callable symbol", () => {
    const text = render([finding({ symbol: "generateInvoice" })]);
    expect(text).toContain("generateInvoice()");
  });

  it("keeps `()` for a PascalCase callable", () => {
    const text = render([finding({ symbol: "OrderService" })]);
    expect(text).toContain("OrderService()");
  });

  it("omits `()` for a compound identity symbol", () => {
    const text = render([
      finding({ charge: "Catch and Release", symbol: "persistOrder → insert" }),
    ]);
    expect(text).toContain("persistOrder → insert");
    expect(text).not.toContain("insert()");
  });

  it("omits `()` for a SCREAMING_SNAKE name — a setting, not a call", () => {
    const text = render([
      finding({ charge: "Environment Roulette", symbol: "REQUEST_TIMEOUT_MS" }),
    ]);
    expect(text).toContain("REQUEST_TIMEOUT_MS");
    expect(text).not.toContain("REQUEST_TIMEOUT_MS()");
  });

  it("omits `()` for dotted and quoted identities", () => {
    const text = render([
      finding({ charge: "Loaded Agent", symbol: "permissions.allow" }),
      finding({
        id: "crime_00002",
        charge: "Policy Doppelgänger",
        symbol: 'admin role "admin" rule',
      }),
    ]);
    expect(text).toContain("permissions.allow");
    expect(text).not.toContain("permissions.allow()");
    expect(text).toContain('admin role "admin" rule');
  });

  it("renders nothing extra when a finding has no symbol", () => {
    const text = render([finding({ symbol: undefined })]);
    expect(text).not.toContain("()");
  });
});
