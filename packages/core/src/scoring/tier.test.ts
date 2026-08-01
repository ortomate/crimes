import { describe, expect, it } from "vitest";
import { DEFAULT_NON_DOMAIN_PATTERNS } from "../config.js";
import { classifyTier, makeTierClassifier } from "./tier.js";

describe("classifyTier", () => {
  it("returns 'domain' for files under src/", () => {
    expect(classifyTier("src/billing/invoice.ts", DEFAULT_NON_DOMAIN_PATTERNS)).toBe(
      "domain",
    );
  });

  it("returns 'nonDomain' for scripts/", () => {
    expect(classifyTier("scripts/_probe-x.ts", DEFAULT_NON_DOMAIN_PATTERNS)).toBe(
      "nonDomain",
    );
  });

  it("returns 'nonDomain' for test files anywhere", () => {
    expect(classifyTier("src/billing/invoice.test.ts", DEFAULT_NON_DOMAIN_PATTERNS)).toBe(
      "nonDomain",
    );
    expect(
      classifyTier("packages/core/__tests__/x.ts", DEFAULT_NON_DOMAIN_PATTERNS),
    ).toBe("nonDomain");
  });

  it("returns 'domain' when the pattern list is empty (opt-out)", () => {
    expect(classifyTier("scripts/x.ts", [])).toBe("domain");
  });

  it("memoises via makeTierClassifier", () => {
    const c = makeTierClassifier(DEFAULT_NON_DOMAIN_PATTERNS);
    expect(c("scripts/x.ts")).toBe("nonDomain");
    expect(c("scripts/x.ts")).toBe("nonDomain"); // second call hits cache
  });
});
