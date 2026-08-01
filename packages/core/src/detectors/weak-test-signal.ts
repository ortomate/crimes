import type { LanguageJsDetector } from "../detector.js";
import type { PreFinding as Finding, Severity } from "../finding.js";
import { isTestFile } from "../util/test-files.js";
const TEST_CALL = /\b(?:it|test)\s*\(\s*(["'`])([^"'`]+)\1/g;
const ASSERTION = /\b(?:expect|assert(?:\.[A-Za-z_$][\w$]*)?)\s*\(/g;
const WEAK_ASSERTION =
  /\.(?:toBeDefined|toBeTruthy|toBeFalsy|toMatchSnapshot|toMatchInlineSnapshot)\s*\(/g;

export const weakTestSignalDetector: LanguageJsDetector = {
  id: "weak_test_signal",
  name: "Weak Test Signal",
  description: "Flags tests that contain no meaningful assertion signal.",
  whyItMatters:
    "Tests that do not assert specific behaviour give the appearance of " +
    "coverage without the safety. Agents reading the file see green " +
    "checkmarks and assume the surrounding code is protected; small " +
    "regressions ship without warning.",

  pack: "language-js",
  run(ctx) {
    if (!isTestFile(ctx.file) || looksTypeOnlyTest(ctx.file, ctx.source)) return [];

    const blocks = extractTestBlocks(ctx.source);
    const findings: Finding[] = [];
    for (const block of blocks) {
      const assertions = block.body.match(ASSERTION) ?? [];
      const weakAssertions = block.body.match(WEAK_ASSERTION) ?? [];
      const onlyWeak =
        assertions.length > 0 &&
        assertions.length === weakAssertions.length &&
        weakAssertions.length > 0;
      if (assertions.length > 0 && !onlyWeak) continue;

      const severity = pickSeverity(assertions.length, onlyWeak);
      const confidence = assertions.length === 0 ? 0.88 : 0.78;
      findings.push({
        id: "",
        type: "weak_test_signal",
        charge: "Test That Proves Nothing",
        severity,
        confidence,
        file: ctx.file,
        lines: [block.startLine, block.endLine],
        summary:
          assertions.length === 0
            ? `Test "${block.title}" contains no expect/assert calls. A test that only runs setup gives agents false confidence.`
            : `Test "${block.title}" only uses weak assertion matchers. It may prove the code ran, not that behaviour is protected.`,
        evidence: [
          `test: "${block.title}"`,
          assertions.length === 0
            ? "0 expect/assert calls"
            : `${weakAssertions.length} weak assertion matcher${weakAssertions.length === 1 ? "" : "s"}`,
          `lines ${block.startLine}-${block.endLine}`,
        ],
        effort: "small",
        fix_shape: "assert behaviour, not implementation; remove no-op assertions",
        scores: {
          severity: severityScore(severity),
          confidence,
          agent_risk: assertions.length === 0 ? 0.68 : 0.58,
        },
        suggested_actions: [
          {
            kind: "assert_observable_behaviour",
            description:
              "Assert the observable behaviour this test is meant to protect, or delete the test if it only exercises setup.",
            risk: "low",
          },
        ],
      });
    }

    return findings.slice(0, 8);
  },
};

interface TestBlock {
  title: string;
  body: string;
  startLine: number;
  endLine: number;
}

function extractTestBlocks(source: string): TestBlock[] {
  const blocks: TestBlock[] = [];
  for (const match of source.matchAll(TEST_CALL)) {
    const start = match.index ?? 0;
    const callOpen = source.indexOf("(", start);
    const callClose = findMatchingParen(source, callOpen);
    if (callOpen === -1 || callClose === -1) continue;

    const callbackBrace = findCallbackBodyStart(source, callOpen, callClose);
    if (callbackBrace === -1) continue;

    const bodyStart = callbackBrace;
    if (bodyStart === -1) continue;
    const bodyEnd = findMatchingBrace(source, bodyStart);
    if (bodyEnd === -1) continue;
    blocks.push({
      title: match[2] ?? "<unnamed>",
      body: source.slice(bodyStart + 1, bodyEnd),
      startLine: lineOfOffset(source, start),
      endLine: lineOfOffset(source, bodyEnd),
    });
  }
  return blocks;
}

function findCallbackBodyStart(
  source: string,
  callOpen: number,
  callClose: number,
): number {
  const call = source.slice(callOpen + 1, callClose);
  const patterns = [
    /(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*{/g,
    /(?:async\s+)?function(?:\s+[A-Za-z_$][\w$]*)?\s*\([^)]*\)\s*{/g,
  ];
  let best = -1;
  for (const pattern of patterns) {
    for (const match of call.matchAll(pattern)) {
      const index = match.index ?? 0;
      const brace = call.indexOf("{", index);
      if (brace === -1) continue;
      const absolute = callOpen + 1 + brace;
      if (best === -1 || absolute < best) best = absolute;
    }
  }
  return best;
}

function findMatchingParen(source: string, open: number): number {
  if (open === -1) return -1;
  let depth = 0;
  let state: "code" | "single" | "double" | "template" = "code";
  for (let i = open; i < source.length; i++) {
    const ch = source[i]!;
    if (state !== "code") {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (
        (state === "single" && ch === "'") ||
        (state === "double" && ch === '"') ||
        (state === "template" && ch === "`")
      ) {
        state = "code";
      }
      continue;
    }
    if (ch === "'") {
      state = "single";
      continue;
    }
    if (ch === '"') {
      state = "double";
      continue;
    }
    if (ch === "`") {
      state = "template";
      continue;
    }
    if (ch === "(") depth += 1;
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findMatchingBrace(source: string, open: number): number {
  let depth = 0;
  let state: "code" | "single" | "double" | "template" = "code";
  for (let i = open; i < source.length; i++) {
    const ch = source[i]!;
    if (state !== "code") {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (
        (state === "single" && ch === "'") ||
        (state === "double" && ch === '"') ||
        (state === "template" && ch === "`")
      ) {
        state = "code";
      }
      continue;
    }
    if (ch === "'") {
      state = "single";
      continue;
    }
    if (ch === '"') {
      state = "double";
      continue;
    }
    if (ch === "`") {
      state = "template";
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function looksTypeOnlyTest(file: string, source: string): boolean {
  return (
    /(?:typecheck|tsd|types?)\.(?:test|spec)\./.test(file) ||
    /\b(?:expectTypeOf|expectAssignable|expectError)\s*\(/.test(source)
  );
}

function pickSeverity(assertionCount: number, onlyWeak: boolean): Severity {
  return assertionCount === 0 && !onlyWeak ? "medium" : "low";
}

function severityScore(severity: Severity): number {
  return severity === "medium" ? 0.45 : 0.25;
}

function lineOfOffset(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line += 1;
  }
  return line;
}
