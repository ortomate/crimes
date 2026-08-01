import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import type { LanguageJsDetectorContext } from "../detector.js";
import type { PettyIndex } from "../petty/types.js";
import { magicDomainLiteralScatterDetector } from "./magic-domain-literal-scatter.js";

function makeCtx(file: string, petty?: PettyIndex): LanguageJsDetectorContext {
  return {
    kind: "language-js",
    file,
    absolutePath: `/repo/${file}`,
    source: "",
    parsed: {
      lineCount: 1,
      functions: [],
      dateNowOrNewDateUses: [],
    },
    config: DEFAULT_CONFIG,
    petty,
  };
}

describe("magicDomainLiteralScatterDetector", () => {
  it("emits one finding from the anchor file for repeated domain literals", async () => {
    const petty: PettyIndex = {
      root: "/repo",
      domainLiterals: {
        enterprise: [
          hit("enterprise", "src/api/billing.ts", 3),
          hit("enterprise", "src/jobs/sync.ts", 5),
          hit("enterprise", "src/ui/pricing.tsx", 7),
        ],
      },
    };

    const findings = await magicDomainLiteralScatterDetector.run(
      makeCtx("src/api/billing.ts", petty),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.type).toBe("magic_domain_literal_scatter");
    expect(findings[0]!.charge).toBe("String Sprinkles");
    expect(findings[0]!.related_files).toEqual([
      "src/jobs/sync.ts",
      "src/ui/pricing.tsx",
    ]);
  });

  it("does not emit from non-anchor files", async () => {
    const petty: PettyIndex = {
      root: "/repo",
      domainLiterals: {
        enterprise: [
          hit("enterprise", "src/api/billing.ts", 3),
          hit("enterprise", "src/jobs/sync.ts", 5),
          hit("enterprise", "src/ui/pricing.tsx", 7),
        ],
      },
    };

    const findings = await magicDomainLiteralScatterDetector.run(
      makeCtx("src/jobs/sync.ts", petty),
    );
    expect(findings).toEqual([]);
  });

  it("ignores literals that already have an exported constant source", async () => {
    const petty: PettyIndex = {
      root: "/repo",
      domainLiterals: {
        enterprise: [
          hit("enterprise", "src/constants.ts", 1, true),
          hit("enterprise", "src/api/billing.ts", 3),
          hit("enterprise", "src/jobs/sync.ts", 5),
          hit("enterprise", "src/ui/pricing.tsx", 7),
        ],
      },
    };

    const findings = await magicDomainLiteralScatterDetector.run(
      makeCtx("src/api/billing.ts", petty),
    );
    expect(findings).toEqual([]);
  });

  it("carries the literal as its discriminator", async () => {
    const petty: PettyIndex = {
      root: "/repo",
      domainLiterals: {
        enterprise: [
          hit("enterprise", "src/api/billing.ts", 3),
          hit("enterprise", "src/jobs/sync.ts", 5),
          hit("enterprise", "src/ui/pricing.tsx", 7),
        ],
      },
    };

    const findings = await magicDomainLiteralScatterDetector.run(
      makeCtx("src/api/billing.ts", petty),
    );
    expect(findings[0]!.discriminator).toBe("enterprise");
  });

  it("gives one anchor file a distinct fingerprint per scattered literal", async () => {
    // The reported collision: this detector emits no `symbol`, so two
    // literals anchored on the same file used to share a fingerprint —
    // and `crimes ignore` on one silently suppressed the other.
    const petty: PettyIndex = {
      root: "/repo",
      domainLiterals: {
        enterprise: [
          hit("enterprise", "src/api/billing.ts", 3),
          hit("enterprise", "src/jobs/sync.ts", 5),
          hit("enterprise", "src/ui/pricing.tsx", 7),
        ],
        trialing: [
          hit("trialing", "src/api/billing.ts", 11),
          hit("trialing", "src/jobs/sync.ts", 13),
          hit("trialing", "src/ui/pricing.tsx", 17),
        ],
      },
    };

    const findings = await magicDomainLiteralScatterDetector.run(
      makeCtx("src/api/billing.ts", petty),
    );
    expect(findings).toHaveLength(2);
    expect(new Set(findings.map((f) => f.discriminator))).toEqual(
      new Set(["enterprise", "trialing"]),
    );
    // Same file, same (absent) symbol — the discriminator is the only
    // thing keeping these two apart.
    expect(new Set(findings.map((f) => f.file)).size).toBe(1);
    expect(findings.every((f) => f.symbol === undefined)).toBe(true);
  });
});

function hit(value: string, file: string, line: number, exportedConstant = false) {
  return {
    value,
    file,
    line,
    lineText: `const x = "${value}";`,
    exportedConstant,
  };
}
