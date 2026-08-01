import { z } from "zod";
import type { UniversalDetector } from "../detector.js";
import type { PreFinding as Finding, Severity } from "../finding.js";
import { isTestFile } from "../util/test-files.js";

const optionsSchema = z
  .object({
    /**
     * Path substrings that should NOT be flagged, even when they look
     * like a developer-specific home directory. Useful for codebases
     * that intentionally embed a sample path inside a docstring or
     * template literal.
     */
    allowedPaths: z.array(z.string().min(1)).optional(),
  })
  .strict();

/**
 * macOS home directory subpath: `/Users/<name>/...`. The username
 * segment must start with a letter and continue with letters, digits,
 * `.`, `_`, or `-`. Followed by at least one more path segment so a
 * lone `/Users` mention (which is rare but harmless) is not flagged.
 */
const MAC_HOME_RE = /\/Users\/[A-Za-z][A-Za-z0-9._-]*\/[A-Za-z0-9._-]/g;

/**
 * Linux home directory subpath: `/home/<name>/...`. Same shape as
 * the macOS regex. We require the leading slash to be at the start of
 * a token (preceded by string-quote, whitespace, or another path
 * separator) so a substring like `at/home/page` doesn't match.
 */
const LINUX_HOME_RE =
  /(?:^|[\s"'`(,{<\\])\/home\/[A-Za-z][A-Za-z0-9._-]*\/[A-Za-z0-9._-]/g;

/**
 * Windows home directory subpath: `C:\Users\<name>\...` (back-slashed,
 * the form JavaScript source carries them in) or `C:/Users/<name>/...`
 * (forward-slashed, the form some tools and editors show). Matches
 * any drive letter, not just `C:`.
 */
const WIN_HOME_RE =
  /[A-Za-z]:[\\/]+Users[\\/]+[A-Za-z][A-Za-z0-9._-]*[\\/]+[A-Za-z0-9._-]/g;

/**
 * Files where a developer-specific path is intentional rather than
 * accidental — local scripts, examples meant to be copied, test
 * fixtures with hard-coded inputs.
 */
const NON_PRODUCTION_DIR_RE = /(?:^|\/)(?:scripts|examples|fixtures|test|tests)\//;

interface PathHit {
  text: string;
  line: number;
}

/**
 * A user-home path hardcoded into source — `/Users/<name>/…`,
 * `/home/<name>/…`, or `C:\Users\<name>\…`. Such paths work on
 * exactly one developer's machine and fail silently everywhere else
 * (CI, teammates, deploy targets). `os.homedir()`,
 * `process.env.HOME`, or a relative path fixes the surface.
 */
export const hardcodedLocalPathDetector: UniversalDetector = {
  id: "hardcoded_local_path",
  name: "Localhost-on-Disk",
  description:
    "Flags paths under `/Users/<name>/`, `/home/<name>/`, or " +
    "`C:\\Users\\<name>\\` embedded in non-test source — they work " +
    "on exactly one developer's machine and fail elsewhere.",
  whyItMatters:
    "A path hardcoded to one user's home directory works on that " +
    "user's laptop and nowhere else. The failure mode is silent: " +
    "tests pass locally, CI fails for unrelated-looking reasons, and " +
    "the user-named segment is exactly the kind of constant a coding " +
    "agent will copy from one file to the next without noticing it's " +
    "machine-specific. `os.homedir()`, `process.env.HOME`, or a " +
    "config-driven base path eliminates the surface.",
  optionsSchema,

  pack: "universal",
  async run(ctx) {
    if (isTestFile(ctx.file)) return [];
    if (NON_PRODUCTION_DIR_RE.test(ctx.file)) return [];

    const source = await ctx.readSource();
    const allowed = readAllowedPaths(ctx.config.detectors?.options);
    const hits = scanSource(source, allowed);
    if (hits.length === 0) return [];

    const severity: Severity = hits.length >= 3 ? "high" : "medium";
    const samples = hits.slice(0, 3).map((h) => `\`${truncate(h.text)}\` @L${h.line}`);
    const overflow = hits.length > samples.length;
    const lineList = hits.map((h) => h.line).slice(0, 10);

    const finding: Finding = {
      id: "",
      type: "hardcoded_local_path",
      charge: "Localhost-on-Disk",
      severity,
      confidence: 0.9,
      file: ctx.file,
      lines: [hits[0]!.line, hits[hits.length - 1]!.line],
      summary:
        `${hits.length} hardcoded user-home path${hits.length === 1 ? "" : "s"} ` +
        `(\`/Users/<name>/\`, \`/home/<name>/\`, or \`C:\\Users\\<name>\\\`) ` +
        `in non-test source. These paths exist on exactly one machine — the ` +
        `code silently breaks for every other developer, every CI runner, ` +
        `and every deploy.`,
      evidence: [
        ...samples,
        ...(overflow ? [`…and ${hits.length - samples.length} more`] : []),
        `lines: ${lineList.join(", ")}${hits.length > 10 ? `, …+${hits.length - 10} more` : ""}`,
        `replace with \`os.homedir()\`, \`process.env.HOME\`, or a config-driven base path`,
      ],
      effort: "quick",
      fix_shape: "use a portable path or resolve from a configured root",
      scores: {
        severity: severity === "high" ? 0.8 : 0.6,
        confidence: 0.9,
        agent_risk: round(Math.min(0.5 + (hits.length - 1) * 0.1, 0.85)),
      },
      suggested_actions: [
        {
          kind: "use_portable_home_path",
          description:
            "Replace the literal with `os.homedir()` (or " +
            "`process.env.HOME`) and join the remainder, or pass the " +
            "base path through configuration so each environment " +
            "supplies its own.",
          risk: "low",
        },
      ],
    };
    return [finding];
  },
};

function scanSource(source: string, allowed: Set<string>): PathHit[] {
  const lines = source.split("\n");
  const hits: PathHit[] = [];
  lines.forEach((rawLine, idx) => {
    collectMatches(rawLine, MAC_HOME_RE, hits, idx + 1, allowed, false);
    collectMatches(rawLine, LINUX_HOME_RE, hits, idx + 1, allowed, true);
    collectMatches(rawLine, WIN_HOME_RE, hits, idx + 1, allowed, false);
  });
  return hits;
}

function collectMatches(
  line: string,
  re: RegExp,
  out: PathHit[],
  lineNumber: number,
  allowed: Set<string>,
  trimLeadingNonPathChar: boolean,
): void {
  for (const m of line.matchAll(re)) {
    const matchStart = m.index ?? 0;
    const matchEnd = matchStart + m[0]!.length;
    const adjustedStart =
      trimLeadingNonPathChar && !m[0]!.startsWith("/") ? matchStart + 1 : matchStart;
    const text = expandToFullPath(line, adjustedStart, matchEnd);
    if (isAllowed(text, allowed)) continue;
    out.push({ text, line: lineNumber });
  }
}

const PATH_DELIMITER_RE = /[\s"'`)\],}<>;]/;

function expandToFullPath(line: string, start: number, initialEnd: number): string {
  let end = initialEnd;
  while (end < line.length && !PATH_DELIMITER_RE.test(line[end]!)) end++;
  return line.slice(start, end);
}

function isAllowed(text: string, allowed: Set<string>): boolean {
  if (allowed.size === 0) return false;
  for (const a of allowed) {
    if (text.includes(a)) return true;
  }
  return false;
}

function truncate(text: string): string {
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

function readAllowedPaths(options: Record<string, unknown> | undefined): Set<string> {
  const raw = options?.["hardcoded_local_path"];
  if (!raw) return new Set();
  const parsed = optionsSchema.safeParse(raw);
  if (!parsed.success) return new Set();
  return new Set(parsed.data.allowedPaths ?? []);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
