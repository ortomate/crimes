import { describe, expect, it } from "vitest";
import { resolveDiscriminators } from "./disambiguate.js";

interface Candidate {
  symbol?: string;
  lines?: [number, number];
  discriminator?: string;
}

describe("resolveDiscriminators", () => {
  it("drops the candidate when the symbol already identifies the finding", () => {
    const findings: Candidate[] = [
      { symbol: "chargeCard", lines: [10, 20], discriminator: "orders" },
      { symbol: "refund", lines: [30, 40], discriminator: "invoices" },
    ];
    resolveDiscriminators(findings);
    expect(findings.map((f) => f.discriminator)).toEqual([undefined, undefined]);
  });

  it("keeps distinct candidates when the symbol repeats", () => {
    const findings: Candidate[] = [
      { symbol: "sync → post", lines: [4, 4], discriminator: "orders" },
      { symbol: "sync → post", lines: [9, 9], discriminator: "users" },
    ];
    resolveDiscriminators(findings);
    expect(findings.map((f) => f.discriminator)).toEqual(["orders", "users"]);
  });

  it("falls back to the start line when a repeated symbol has no candidate", () => {
    const findings: Candidate[] = [
      { symbol: "describe callback", lines: [4, 20] },
      { symbol: "describe callback", lines: [22, 40] },
    ];
    resolveDiscriminators(findings);
    expect(findings.map((f) => f.discriminator)).toEqual(["L4", "L22"]);
  });

  it("appends the start line when two findings share symbol and candidate", () => {
    const findings: Candidate[] = [
      { symbol: "sync → post", lines: [4, 4], discriminator: "orders" },
      { symbol: "sync → post", lines: [9, 9], discriminator: "orders" },
    ];
    resolveDiscriminators(findings);
    expect(findings.map((f) => f.discriminator)).toEqual(["orders@L4", "orders@L9"]);
  });

  it("tie-breaks only the colliding candidates within an ambiguous group", () => {
    const findings: Candidate[] = [
      { symbol: "sync", lines: [4, 4], discriminator: "orders" },
      { symbol: "sync", lines: [9, 9], discriminator: "orders" },
      { symbol: "sync", lines: [14, 14], discriminator: "users" },
    ];
    resolveDiscriminators(findings);
    expect(findings.map((f) => f.discriminator)).toEqual([
      "orders@L4",
      "orders@L9",
      "users",
    ]);
  });

  it("groups findings with no symbol together", () => {
    const findings: Candidate[] = [
      { lines: [1, 3], discriminator: "abc123" },
      { lines: [8, 9], discriminator: "def456" },
    ];
    resolveDiscriminators(findings);
    expect(findings.map((f) => f.discriminator)).toEqual(["abc123", "def456"]);
  });

  it("leaves a lone finding with no symbol and no candidate untouched", () => {
    const findings: Candidate[] = [{ lines: [1, 3] }];
    resolveDiscriminators(findings);
    expect(findings[0]!.discriminator).toBeUndefined();
  });

  it("does not let one file's symbol collide with another symbol's candidate", () => {
    const findings: Candidate[] = [
      { symbol: "a", lines: [1, 2], discriminator: "shared" },
      { symbol: "b", lines: [5, 6], discriminator: "shared" },
    ];
    resolveDiscriminators(findings);
    expect(findings.map((f) => f.discriminator)).toEqual([undefined, undefined]);
  });

  it("uses L0 when an ambiguous finding carries no line range", () => {
    const findings: Candidate[] = [{ symbol: "x" }, { symbol: "x", lines: [7, 8] }];
    resolveDiscriminators(findings);
    expect(findings.map((f) => f.discriminator)).toEqual(["L0", "L7"]);
  });
});
