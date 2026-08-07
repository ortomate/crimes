import { createHash } from "node:crypto";
import type { PreFinding as Finding } from "../finding.js";
import type { UniversalDetector } from "../detector.js";
import { JS_EXTENSIONS } from "../discovery/language-pack-router.js";
import { resolveDiscriminators } from "./disambiguate.js";

const JS_EXT_SET = new Set<string>(JS_EXTENSIONS);

const SINGLE_LINE_COMMENT_RE = /^\s*(?:\/\/|#|--)\s?(.*)$/;

/**
 * Documentation comments, which are prose by definition.
 *
 * Rust's `///` and `//!` are the ones that bit: a doc comment carrying a
 * `# Examples` block is *full* of `use` and `fn`, so the more idiomatic
 * the documentation the more likely it was to be reported as dead code.
 */
const DOC_COMMENT_RE = /^\s*(?:\/\/[/!]|#!)/;

/**
 * Lines that are code because of their **shape**, not because they
 * contain a word that also appears in English.
 *
 * The previous rule was a bare-word alternation over `def|fn|class|…|
 * for|use|if|match|return|while`. Every one of those after `impl` is
 * also an ordinary English word, and that is not a corner case: on
 * airflow it made the Apache licence header — "distributed with this
 * work **for** additional information", "you may not **use** this
 * file", "the License **for** the specific language" — clear the
 * three-hit threshold on prepositions alone. 7,320 findings, 41% of the
 * entire report, one per file, every Apache-licensed repo.
 *
 * A keyword now has to be *used* as a keyword: `def name(`, `class
 * Name`, `import x`, `return <something>`, an assignment, a call, a
 * brace. Prose containing the same words does not match, because prose
 * does not have the punctuation.
 */
const CODE_LINE_PATTERNS: RegExp[] = [
  // def foo( | fn foo( | function foo( — the name and the paren are what
  // make it a definition; "def" alone is not enough.
  /^(?:async\s+|pub\s+|public\s+|private\s+|protected\s+|static\s+)*(?:def|fn|function)\s+[A-Za-z_$][\w$]*\s*[(<]/,
  // class Foo: | struct Foo { | impl Trait for Foo {
  // Must *open a body*, which is what stops "class of request arrives
  // first and returns…" — a sentence — from reading as a declaration.
  /^(?:pub\s+|public\s+|private\s+|protected\s+|abstract\s+|final\s+)*(?:class|struct|enum|impl|interface|trait)\s+[A-Za-z_$][\w$]*.*[:{]\s*$/,
  // Imports in their real syntactic forms. "use this helper for…" is a
  // sentence; `use serde::Deserialize;` is not.
  /^import\s+[A-Za-z_$][\w$.]*(?:\s+as\s+[\w$]+)?\s*[;,]?$/,
  /^from\s+[\w$.]+\s+import\s+\S/,
  /^use\s+[\w:{}, ]+;$/,
  /^#?\s*include\s+[<"]/,
  // Declaration with an initialiser: let x = 1, const y: T = z
  /^(?:const|let|var|val)\s+[A-Za-z_$][\w$]*\s*(?::[^=]*)?=\s*\S/,
  // A bare control-flow statement on its own line
  /^(?:pass|break|continue|return|yield)\s*;?$/,
  // return / raise / yield carrying an expression with code punctuation
  /^(?:return|yield|raise|throw|assert|del|await)\s+.*[=+\-*/%()[\]{}<>|&]/,
  // return self.x | raise ValueError — a single dotted operand
  /^(?:return|yield|raise|throw|del)\s+[A-Za-z_$][\w$.]*\s*;?$/,
  // Control flow that opens a block: if x:, for (…) {, match v {
  /^(?:if|elif|else|while|for|switch|match|case|try|catch|except|finally|with|do)\b.*[:{]\s*$/,
  // Assignment: x = 1, self.y += 2, a[0] = b
  /^[A-Za-z_$][\w$.[\]"']*\s*(?:\+|-|\*|\/|\|\||&&|\?\?|\/\/|\*\*)?=[^=~]\s*\S/,
  // A call statement alone on the line
  /^[A-Za-z_$][\w$.]*\s*\([^)]*\)\s*[;:{,]?\s*$/,
  // Brackets, and any line terminated the way a statement is
  /^[}\])]+\s*[;,)]?\s*$/,
  /[;{]\s*$/,
];
const MINIMUM_RUN = 4;
const MINIMUM_CODE_HITS = 3;

function looksLikeCode(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  return CODE_LINE_PATTERNS.some((re) => re.test(trimmed));
}

/**
 * Universal-pack variant of `commented_out_code`. Runs on every file
 * except those claimed by the language-js pack (which has an AST-aware
 * variant under the same abstract `type`). Uses line-level regex
 * detection: a run of >= 4 single-line comments where >= 3 are
 * *syntactically* code — see {@link CODE_LINE_PATTERNS} — is the
 * trigger. Documentation comments never participate.
 */
export const commentedOutCodeUniversalDetector: UniversalDetector = {
  id: "commented_out_code",
  name: "Commented-Out Code (Universal)",
  description:
    "Flags runs of consecutive line comments whose content looks like " +
    "disabled code (universal variant; runs on non-JS files).",
  whyItMatters:
    "Code left behind in comments stales: the language and APIs around " +
    "it move on, but the dead block still hints at intent that's no " +
    "longer true. Agents reading the file may pattern-match on the " +
    "commented version and revive it incorrectly. Delete or move to " +
    "version control history.",
  pack: "universal",

  async run(ctx) {
    if (JS_EXT_SET.has(ctx.extension)) return [];
    const source = await ctx.readSource();
    const lines = source.split("\n");

    const findings: Finding[] = [];
    let runStart = -1;
    let runCodeHits = 0;
    let runCount = 0;

    const flushRun = (endLine: number): void => {
      if (runCount >= MINIMUM_RUN && runCodeHits >= MINIMUM_CODE_HITS && runStart >= 0) {
        findings.push(
          buildFinding(
            ctx.file,
            runStart + 1,
            endLine,
            lines.slice(runStart, endLine).join("\n"),
          ),
        );
      }
      runStart = -1;
      runCodeHits = 0;
      runCount = 0;
    };

    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i]!;
      // A doc comment breaks the run rather than extending it: a block
      // that mixes `///` documentation with `//` disabled code is two
      // different things, and only the second one is the charge.
      if (DOC_COMMENT_RE.test(raw)) {
        flushRun(i);
        continue;
      }
      const m = SINGLE_LINE_COMMENT_RE.exec(raw);
      if (m) {
        if (runStart < 0) runStart = i;
        runCount += 1;
        if (looksLikeCode(m[1] ?? "")) runCodeHits += 1;
      } else {
        flushRun(i);
      }
    }
    flushRun(lines.length);

    // The language-js twin has carried a hash of the block's text as
    // its discriminator since 0.17.0; this variant never got one, so
    // every block in a non-JS file shared
    // `commented_out_code::<file>::` and `crimes ignore` on one
    // silenced the rest. `zproject/prod_settings_template.py` carries
    // 18 blocks under a single fingerprint — 21 of zulip's 39
    // colliding findings and 18 of airflow's 184.
    //
    // Routed through `resolveDiscriminators` rather than set
    // unconditionally, so a file holding one block keeps the
    // fingerprint it has always had. That leaves the two variants
    // disagreeing for single-block files — the JS one always appends a
    // hash — which is pre-existing and not worth churning every JS
    // fingerprint to unify.
    resolveDiscriminators(findings);
    return findings;
  },
};

/**
 * Hash the block's own text. Deliberately not `hashSlice`, which
 * tokenises with the TypeScript scanner: this variant runs on Python,
 * Go, Ruby and anything else the JS pack does not claim, and a
 * TS-shaped tokenisation of a `# ...` run is a category error even
 * where it happens to be deterministic.
 */
function blockHash(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

function buildFinding(
  file: string,
  startLine: number,
  endLine: number,
  text: string,
): Finding {
  return {
    id: "",
    type: "commented_out_code",
    charge: "Commented-Out Code",
    severity: "low",
    confidence: 0.65,
    file,
    // Candidate only — see the `resolveDiscriminators` call above.
    discriminator: blockHash(text),
    lines: [startLine, endLine] as [number, number],
    summary:
      `A run of ${endLine - startLine + 1} consecutive comments looks like disabled code. ` +
      "Code left in comments stales — agents may revive incorrect snippets.",
    evidence: [
      `${endLine - startLine + 1} consecutive comment lines (lines ${startLine}–${endLine})`,
      ">=3 lines are syntactically code (a declaration, import, assignment, call, or brace) rather than prose containing keywords",
    ],
    effort: "quick",
    fix_shape: "delete the commented block (history preserves it)",
    scores: {
      severity: 0.35,
      confidence: 0.65,
      agent_risk: 0.35,
    },
    suggested_actions: [
      {
        kind: "delete_commented_block",
        description:
          "Delete the commented-out block. Version control preserves the history " +
          "if the code ever needs to come back.",
        risk: "low",
      },
    ],
  };
}
