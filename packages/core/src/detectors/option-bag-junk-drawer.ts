import type { Detector } from "../detector.js";
import type { Finding } from "../finding.js";
import { isTestFile } from "../util/test-files.js";

const BAG_NAMES = ["options", "config", "payload", "data", "params", "meta"];

export const optionBagJunkDrawerDetector: Detector = {
  id: "option_bag_junk_drawer",
  name: "Option Bag Junk Drawer",
  description: "Flags broad object bags whose implicit shape is large or passed through helpers.",
  whyItMatters:
    "Generic options objects hide which fields are required, which are " +
    "optional, and how they interact. Agents extending the call site often " +
    "add or rename a key without understanding what depends on it; " +
    "downstream consumers silently break.",

  run(ctx) {
    if (isTestFile(ctx.file)) return [];

    const lines = ctx.source.split(/\r?\n/);
    const findings: Finding[] = [];

    for (const fn of ctx.parsed.functions) {
      const source = lines.slice(fn.startLine - 1, fn.endLine).join("\n");
      const bag = BAG_NAMES.find((name) => hasBagParameter(source, name));
      if (!bag) continue;

      const properties = extractPropertyReads(source, bag);
      if (properties.length < 6) continue;

      const symbol = fn.name ?? "<anonymous>";
      findings.push({
        id: "",
        type: "option_bag_junk_drawer",
        charge: "Option Bag Junk Drawer",
        severity: "low",
        confidence: round(Math.min(0.62 + properties.length * 0.02, 0.82)),
        file: ctx.file,
        symbol,
        lines: [fn.startLine, fn.endLine],
        summary:
          `${symbol} accepts a broad \`${bag}\` object with an implicit shape. ` +
          `Generic bags make it hard for agents to know which fields are required.`,
        evidence: [
          `parameter: ${bag}`,
          `${properties.length} distinct property reads: ${properties.slice(0, 8).join(", ")}`,
        ],
        effort: "small",
        fix_shape: "split the options bag into named, narrowly-typed records",
        scores: {
          severity: 0.3,
          confidence: round(Math.min(0.62 + properties.length * 0.02, 0.82)),
          agent_risk: round(Math.min(0.52 + properties.length * 0.03, 0.78)),
        },
        suggested_actions: [
          {
            kind: "name_option_shape",
            description:
              "Replace the generic bag with a named type/object shape, or destructure only the fields this function owns.",
            risk: "low",
          },
        ],
      });
    }

    return findings.slice(0, 5);
  },
};

function hasBagParameter(source: string, bag: string): boolean {
  return new RegExp(`[,(]\\s*${bag}\\s*(?::|[,)=])`).test(source.slice(0, 300));
}

function extractPropertyReads(source: string, bag: string): string[] {
  const properties = new Set<string>();
  const dot = new RegExp(`\\b${bag}\\??\\.([A-Za-z_$][\\w$]*)`, "g");
  const bracket = new RegExp(`\\b${bag}\\s*\\[\\s*["']([^"']+)["']\\s*\\]`, "g");
  for (const match of source.matchAll(dot)) properties.add(match[1]!);
  for (const match of source.matchAll(bracket)) properties.add(match[1]!);
  return Array.from(properties).sort();
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
