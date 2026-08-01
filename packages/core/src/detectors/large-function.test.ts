import type { FunctionShape, ParsedFunction } from "@crimes/language-js";
import { parseFile } from "@crimes/language-js";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import type { LanguageJsDetectorContext } from "../detector.js";
import { largeFunctionDetector } from "./large-function.js";

/**
 * Build a stub ParsedFile with a single function at the given line
 * range. Default shape is `domain` — the historical bucket — so legacy
 * tests stay aligned with the configured threshold.
 */
function makeCtx(
  functions: Array<{
    name?: string;
    start: number;
    end: number;
    shape?: FunctionShape;
    shapeEvidence?: string[];
  }>,
  overrides: { file?: string; absolutePath?: string } = {},
): LanguageJsDetectorContext {
  return {
    kind: "language-js",
    file: overrides.file ?? "src/billing.ts",
    absolutePath: overrides.absolutePath ?? "/tmp/billing.ts",
    source: "",
    parsed: {
      lineCount: 1000,
      functions: functions.map<ParsedFunction>((f) => ({
        name: f.name,
        kind: "function",
        startLine: f.start,
        endLine: f.end,
        shape: f.shape ?? "domain",
        ...(f.shapeEvidence ? { shapeEvidence: f.shapeEvidence } : {}),
      })),
      dateNowOrNewDateUses: [],
    },
    config: DEFAULT_CONFIG,
  };
}

/** Convenience: parse a source string under a fake absolute path. */
function parsedCtx(args: {
  source: string;
  file: string;
  absolutePath: string;
}): LanguageJsDetectorContext {
  const parsed = parseFile({
    absolutePath: args.absolutePath,
    source: args.source,
  });
  return {
    kind: "language-js",
    file: args.file,
    absolutePath: args.absolutePath,
    source: args.source,
    parsed,
    config: DEFAULT_CONFIG,
  };
}

describe("largeFunctionDetector (domain default)", () => {
  it("ignores short functions", async () => {
    const findings = await largeFunctionDetector.run(
      makeCtx([{ name: "small", start: 1, end: 20 }]),
    );
    expect(findings).toEqual([]);
  });

  it("flags a barely-over-threshold domain function as medium", async () => {
    // 70-line function vs default 60-line threshold → ratio 1.17 → medium.
    const findings = await largeFunctionDetector.run(
      makeCtx([{ name: "borderline", start: 1, end: 70 }]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("medium");
    expect(findings[0]!.symbol).toBe("borderline");
  });

  it("flags a flagrant domain function as high", async () => {
    const findings = await largeFunctionDetector.run(
      makeCtx([{ name: "generateInvoice", start: 10, end: 259 }]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.symbol).toBe("generateInvoice");
    expect(findings[0]!.severity).toBe("high");
    expect(findings[0]!.lines).toEqual([10, 259]);
  });

  it("escalates a domain function to high at >=2x threshold", async () => {
    const findings = await largeFunctionDetector.run(
      makeCtx([{ name: "twoX", start: 1, end: 120 }]),
    );
    expect(findings[0]!.severity).toBe("high");
  });

  it("summary mentions why the size matters", async () => {
    const findings = await largeFunctionDetector.run(
      makeCtx([{ name: "f", start: 1, end: 200 }]),
    );
    expect(findings[0]!.summary).toMatch(/responsibilities|agent|edit/i);
  });

  it("evidence names the shape so a reader can verify the budget", async () => {
    const findings = await largeFunctionDetector.run(
      makeCtx([{ name: "f", start: 1, end: 200 }]),
    );
    expect(findings[0]!.evidence.some((e) => /domain function/i.test(e))).toBe(true);
  });
});

describe("largeFunctionDetector (shape-aware thresholds)", () => {
  it("does not flag a 70-line test_callback", async () => {
    const findings = await largeFunctionDetector.run(
      makeCtx([
        {
          start: 1,
          end: 70,
          shape: "test_callback",
          shapeEvidence: ["callback passed to describe(...)"],
        },
      ]),
    );
    expect(findings).toEqual([]);
  });

  it("flags a 240-line test_callback as low severity", async () => {
    const findings = await largeFunctionDetector.run(
      makeCtx([
        {
          start: 1,
          end: 240,
          shape: "test_callback",
          shapeEvidence: ["callback passed to describe(...)"],
        },
      ]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("low");
    expect(findings[0]!.symbol).toBe("describe callback");
    expect(findings[0]!.evidence.some((e) => /test callback/i.test(e))).toBe(true);
  });

  it("escalates a 400-line test_callback to medium (≥2× threshold)", async () => {
    const findings = await largeFunctionDetector.run(
      makeCtx([
        {
          name: undefined,
          start: 1,
          end: 401,
          shape: "test_callback",
          shapeEvidence: ["callback passed to describe(...)"],
        },
      ]),
    );
    expect(findings[0]!.severity).toBe("medium");
  });

  it("does not flag a 180-line React component", async () => {
    const findings = await largeFunctionDetector.run(
      makeCtx([
        {
          name: "HomePage",
          start: 1,
          end: 180,
          shape: "react_component",
          shapeEvidence: ['PascalCase name "HomePage"', "body returns JSX"],
        },
      ]),
    );
    expect(findings).toEqual([]);
  });

  it("flags a 220-line React component at medium", async () => {
    const findings = await largeFunctionDetector.run(
      makeCtx([
        {
          name: "HomePage",
          start: 1,
          end: 220,
          shape: "react_component",
        },
      ]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("medium");
    expect(
      findings[0]!.evidence.some((e) => /React component threshold \(200/.test(e)),
    ).toBe(true);
  });

  it("does not flag an 80-line route handler", async () => {
    const findings = await largeFunctionDetector.run(
      makeCtx([
        {
          name: "GET",
          start: 1,
          end: 80,
          shape: "route_handler",
          shapeEvidence: ['named export "GET"', "App Router route file"],
        },
      ]),
    );
    expect(findings).toEqual([]);
  });

  it("flags a 110-line route handler at medium", async () => {
    const findings = await largeFunctionDetector.run(
      makeCtx([
        {
          name: "GET",
          start: 1,
          end: 110,
          shape: "route_handler",
        },
      ]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("medium");
    expect(
      findings[0]!.evidence.some((e) => /route handler threshold \(100/.test(e)),
    ).toBe(true);
  });

  it("escalates a 250-line route handler to high (≥2× threshold)", async () => {
    const findings = await largeFunctionDetector.run(
      makeCtx([
        {
          name: "POST",
          start: 1,
          end: 250,
          shape: "route_handler",
        },
      ]),
    );
    expect(findings[0]!.severity).toBe("high");
  });

  it("flags a 220-line page_export at medium, 401-line at high", async () => {
    const mediumFindings = await largeFunctionDetector.run(
      makeCtx([{ name: "Page", start: 1, end: 220, shape: "page_export" }]),
    );
    expect(mediumFindings[0]!.severity).toBe("medium");

    const highFindings = await largeFunctionDetector.run(
      makeCtx([{ name: "Page", start: 1, end: 401, shape: "page_export" }]),
    );
    expect(highFindings[0]!.severity).toBe("high");
  });

  it("flags an anonymous unknown function at 90 lines (relaxed 80 threshold)", async () => {
    const findings = await largeFunctionDetector.run(
      makeCtx([{ start: 1, end: 90, shape: "unknown" }]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.symbol).toBe("<anonymous>");
  });

  it("does not flag an unknown function at 75 lines", async () => {
    const findings = await largeFunctionDetector.run(
      makeCtx([{ start: 1, end: 75, shape: "unknown" }]),
    );
    expect(findings).toEqual([]);
  });

  it("does not flag a 180-line cli_command_registrar", async () => {
    const findings = await largeFunctionDetector.run(
      makeCtx([
        {
          name: "registerScanCommand",
          start: 1,
          end: 180,
          shape: "cli_command_registrar",
          shapeEvidence: ["name matches register*Command"],
        },
      ]),
    );
    expect(findings).toEqual([]);
  });

  it("flags a 240-line cli_command_registrar as low severity", async () => {
    const findings = await largeFunctionDetector.run(
      makeCtx([
        {
          name: "registerScanCommand",
          start: 1,
          end: 240,
          shape: "cli_command_registrar",
          shapeEvidence: ["name matches register*Command"],
        },
      ]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("low");
    expect(
      findings[0]!.evidence.some((e) => /CLI command registrar threshold \(200/.test(e)),
    ).toBe(true);
  });

  it("escalates a 401-line cli_command_registrar to medium (≥2× threshold)", async () => {
    const findings = await largeFunctionDetector.run(
      makeCtx([
        {
          name: "registerIgnoreCommand",
          start: 1,
          end: 401,
          shape: "cli_command_registrar",
        },
      ]),
    );
    expect(findings[0]!.severity).toBe("medium");
  });

  it("labels anonymous cli_command_registrar callbacks as 'action callback'", async () => {
    const findings = await largeFunctionDetector.run(
      makeCtx([
        {
          start: 1,
          end: 240,
          shape: "cli_command_registrar",
          shapeEvidence: ["callback passed to Commander .action(...)"],
        },
      ]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.symbol).toBe("action callback");
  });

  it("test_callback agent_risk is lower than a same-size domain function", async () => {
    const test = await largeFunctionDetector.run(
      makeCtx([
        {
          start: 1,
          end: 240,
          shape: "test_callback",
          shapeEvidence: ["callback passed to describe(...)"],
        },
      ]),
    );
    const domain = await largeFunctionDetector.run(
      makeCtx([{ name: "f", start: 1, end: 240, shape: "domain" }]),
    );
    const testAgentRisk = test[0]!.scores.agent_risk ?? 0;
    const domainAgentRisk = domain[0]!.scores.agent_risk ?? 0;
    expect(testAgentRisk).toBeLessThan(domainAgentRisk);
  });
});

describe("largeFunctionDetector (end-to-end shape classification)", () => {
  it("classifies a real `describe()` callback as test_callback and respects the 200-line threshold", async () => {
    // 110-line describe block — well past the domain threshold (60) but
    // under the test threshold (200), so it must NOT fire.
    const body = Array.from({ length: 100 }, () => "  it('case', () => null);").join(
      "\n",
    );
    const source = "describe('billing', () => {\n" + body + "\n});\n";
    const ctx = parsedCtx({
      source,
      file: "src/billing.test.ts",
      absolutePath: "/tmp/billing.test.ts",
    });
    const findings = await largeFunctionDetector.run(ctx);
    expect(findings).toEqual([]);
  });

  it("classifies a default-exported page.tsx component as page_export", async () => {
    // 220 lines of body — past the 200-line page threshold → medium.
    const body = Array.from({ length: 210 }, (_, i) => `  const x${i} = ${i};`).join(
      "\n",
    );
    const source =
      "export default function HomePage() {\n" + body + "\n  return <main />;\n}\n";
    const ctx = parsedCtx({
      source,
      file: "src/app/page.tsx",
      absolutePath: "/tmp/app/page.tsx",
    });
    const findings = await largeFunctionDetector.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("medium");
    expect(
      findings[0]!.evidence.some((e) => /page component threshold \(200/.test(e)),
    ).toBe(true);
  });

  it("classifies a named-export `GET` under app/ as route_handler", async () => {
    // 110-line GET → past the 100-line handler threshold → medium.
    const body = Array.from({ length: 105 }, (_, i) => `  const x${i} = ${i};`).join(
      "\n",
    );
    const source = "export function GET() {\n" + body + "\n  return new Response();\n}\n";
    const ctx = parsedCtx({
      source,
      file: "src/app/api/users/route.ts",
      absolutePath: "/tmp/src/app/api/users/route.ts",
    });
    const findings = await largeFunctionDetector.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("medium");
    expect(findings[0]!.symbol).toBe("GET");
    expect(
      findings[0]!.evidence.some((e) => /route handler threshold \(100/.test(e)),
    ).toBe(true);
  });

  it("classifies a PascalCase function with JSX as react_component", async () => {
    const body = Array.from({ length: 210 }, (_, i) => `  const x${i} = ${i};`).join(
      "\n",
    );
    const source =
      "function HomePage() {\n" + body + "\n  return <div />;\n}\nexport { HomePage };\n";
    const ctx = parsedCtx({
      source,
      file: "src/components/HomePage.tsx",
      absolutePath: "/tmp/src/components/HomePage.tsx",
    });
    const findings = await largeFunctionDetector.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("medium");
    expect(
      findings[0]!.evidence.some((e) => /React component threshold \(200/.test(e)),
    ).toBe(true);
  });

  it("classifies a `registerXCommand(program)` wrapper as cli_command_registrar", async () => {
    // 240-line wrapper → past the 200-line registrar threshold → low.
    // (The DSL chain itself is declarative; severity stays low even at
    // generous sizes — the 0.5.0 dogfood signal was that high severity
    // on Commander wrappers was the dominant false-positive cluster.)
    const optionLines = Array.from({ length: 230 }, () => '    .option("--x", "x")').join(
      "\n",
    );
    const source =
      "import type { Command } from 'commander';\n" +
      "export function registerScanCommand(program: Command): void {\n" +
      "  program\n" +
      "    .command('scan')\n" +
      optionLines +
      "\n    .action(() => { return; });\n" +
      "}\n";
    const ctx = parsedCtx({
      source,
      file: "src/cli/commands/scan.ts",
      absolutePath: "/tmp/src/cli/commands/scan.ts",
    });
    const findings = await largeFunctionDetector.run(ctx);
    // The wrapper plus its anonymous `.action(...)` arrow both get
    // classified as cli_command_registrar — one or both may exceed
    // the 200-line threshold depending on the chain length. Just
    // require *some* finding to come back, and that none escape to
    // medium/high severity.
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(f.severity).toBe("low");
      expect(
        f.evidence.some((e) => /CLI command registrar threshold \(200/.test(e)),
      ).toBe(true);
    }
  });

  it("keeps the fixture's generateInvoice God Function at high severity", async () => {
    // 204-line domain function → ratio 3.4 → high. This is the
    // bundled `examples/messy-ts-app` headline finding; regressing it
    // would silently empty the demo report.
    const body = Array.from({ length: 200 }, (_, i) => `  const x${i} = ${i};`).join(
      "\n",
    );
    const source = "export function generateInvoice() {\n" + body + "\n  return 1;\n}\n";
    const ctx = parsedCtx({
      source,
      file: "src/billing.ts",
      absolutePath: "/tmp/src/billing.ts",
    });
    const findings = await largeFunctionDetector.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.symbol).toBe("generateInvoice");
    expect(findings[0]!.severity).toBe("high");
  });
});
