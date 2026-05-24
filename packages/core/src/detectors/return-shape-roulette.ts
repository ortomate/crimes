import type { Detector } from "../detector.js";
import type { Finding } from "../finding.js";
import { isTestFile } from "../util/test-files.js";

export const returnShapeRouletteDetector: Detector = {
  id: "return_shape_roulette",
  name: "Return Shape Roulette",
  description: "Flags functions that return substantially different object shapes across branches.",
  whyItMatters:
    "Functions that return different object shapes depending on input force " +
    "every caller to discriminate at runtime. Adding a branch or changing " +
    "one shape risks invalidating every consumer; agents tend to test only " +
    "the path they were debugging.",

  pack: "language-js",
  run(ctx) {
    if (isTestFile(ctx.file)) return [];

    const lines = ctx.source.split(/\r?\n/);
    const findings: Finding[] = [];

    for (const fn of ctx.parsed.functions) {
      const source = lines.slice(fn.startLine - 1, fn.endLine).join("\n");
      if (hasExplicitReturnType(source)) continue;

      const shapes = extractReturnShapes(source);
      if (shapes.length < 3) continue;

      const weakest = weakestOverlap(shapes);
      if (!weakest || weakest.overlap >= 0.5) continue;

      const symbol = fn.name ?? "<anonymous>";
      findings.push({
        id: "",
        type: "return_shape_roulette",
        charge: "Return Shape Roulette",
        severity: "low",
        confidence: round(Math.min(0.64 + shapes.length * 0.03, 0.82)),
        file: ctx.file,
        symbol,
        lines: [fn.startLine, fn.endLine],
        summary:
          `${symbol} returns several object shapes without an explicit return type. ` +
          `Callers and agents may infer the wrong result contract.`,
        evidence: [
          `${shapes.length} object-literal return shapes`,
          `lowest key overlap: ${(weakest.overlap * 100).toFixed(0)}%`,
          `example keys: { ${weakest.left.join(", ")} } vs { ${weakest.right.join(", ")} }`,
        ],
        effort: "small",
        fix_shape: "pick one return shape; use a discriminated union if you need both",
        scores: {
          severity: 0.3,
          confidence: round(Math.min(0.64 + shapes.length * 0.03, 0.82)),
          agent_risk: round(Math.min(0.56 + shapes.length * 0.04 + (1 - weakest.overlap) * 0.15, 0.82)),
        },
        suggested_actions: [
          {
            kind: "name_return_shape",
            description:
              "Add an explicit return type or split branch-specific results into named result variants.",
            risk: "low",
          },
        ],
      });
    }

    return findings.slice(0, 5);
  },
};

function extractReturnShapes(source: string): string[][] {
  const shapes: string[][] = [];
  for (const match of source.matchAll(/\breturn\s*{([^{}]+)}/g)) {
    const keys = extractKeys(match[1] ?? "");
    if (keys.length > 0) shapes.push(keys);
  }
  return shapes;
}

function extractKeys(body: string): string[] {
  const keys = new Set<string>();
  for (const part of body.split(",")) {
    const match = part.trim().match(/^([A-Za-z_$][\w$]*)\s*[:}]?/);
    if (match) keys.add(match[1]!);
  }
  return Array.from(keys).sort();
}

function weakestOverlap(shapes: string[][]):
  | { overlap: number; left: string[]; right: string[] }
  | undefined {
  let weakest: { overlap: number; left: string[]; right: string[] } | undefined;
  for (let i = 0; i < shapes.length; i++) {
    for (let j = i + 1; j < shapes.length; j++) {
      const left = shapes[i]!;
      const right = shapes[j]!;
      const overlap = keyOverlap(left, right);
      if (!weakest || overlap < weakest.overlap) weakest = { overlap, left, right };
    }
  }
  return weakest;
}

function keyOverlap(left: string[], right: string[]): number {
  const a = new Set(left);
  const b = new Set(right);
  const shared = left.filter((key) => b.has(key)).length;
  const total = new Set([...a, ...b]).size;
  return total === 0 ? 1 : shared / total;
}

function hasExplicitReturnType(source: string): boolean {
  const head = source.slice(0, Math.min(source.indexOf("{") + 1 || 200, 300));
  return /\)\s*:\s*(?!any\b|unknown\b|Record\b)[^{=]+[{=]/.test(head);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
