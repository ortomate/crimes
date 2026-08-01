/**
 * Deterministic tokenisation for IA signal extraction.
 *
 * Tokens are lowercased, stop-word-filtered, and singularised via a small
 * whitelist. Deliberately no general stemmer — over-aggressive
 * normalisation hides real signal and produces noisy IA findings.
 */

/**
 * Stop words filtered out of every token bag. Includes generic structural
 * nouns ("page", "view", "settings"), JS/TS keywords that occasionally
 * leak in, and repo-structural directory names.
 */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  // Generic UI / structural nouns
  "page",
  "view",
  "screen",
  "layout",
  "container",
  "component",
  "components",
  "index",
  "main",
  "default",
  "list",
  "detail",
  "details",
  "form",
  "modal",
  "dialog",
  "section",
  "panel",
  "block",
  "wrapper",

  // Repo structure
  "src",
  "app",
  "apps",
  "pages",
  "routes",
  "screens",
  "lib",
  "libs",
  "utils",
  "util",
  "helpers",
  "helper",
  "test",
  "tests",
  "spec",
  "specs",
  "__tests__",
  "__mocks__",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "out",
  ".next",
  "next",
  "public",
  "static",
  "assets",
  "settings",
  "config",
  "configuration",
  "packages",
  "package",

  // Short / non-content tokens
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "for",
  "with",
  "your",
  "my",
  "our",
  "is",
  "are",
  "be",
  "to",
  "in",
  "on",
  "by",

  // JS keywords / literal words that occasionally appear as path segments
  "true",
  "false",
  "null",
  "undefined",
  "const",
  "let",
  "var",
  "return",
  "function",
  "class",
  "import",
  "export",
  "from",
  "type",
  "interface",

  // Test infixes that path tokenisation might pull in
  "mock",
  "mocks",
  "fixture",
  "fixtures",
  "stub",
  "stubs",
]);

/**
 * Singular forms for tokens that frequently appear plural. Whitelist only —
 * a general `-s` stripper would over-collapse legitimate distinct tokens.
 */
export const SINGULAR_TABLE: ReadonlyMap<string, string> = new Map([
  ["teams", "team"],
  ["workspaces", "workspace"],
  ["organisations", "organisation"],
  ["organizations", "organization"],
  ["accounts", "account"],
  ["tenants", "tenant"],
  ["companies", "company"],
  ["users", "user"],
  ["members", "member"],
  ["seats", "seat"],
  ["plans", "plan"],
  ["tiers", "tier"],
  ["subscriptions", "subscription"],
  ["payments", "payment"],
  ["invoices", "invoice"],
  ["billings", "billing"],
  ["roles", "role"],
  ["permissions", "permission"],
  ["admins", "admin"],
  ["owners", "owner"],
  ["managers", "manager"],
  ["projects", "project"],
  ["channels", "channel"],
  ["threads", "thread"],
  ["messages", "message"],
  ["notifications", "notification"],
]);

/**
 * Split a raw string into tokens.
 *
 * Splits on:
 *   - Path separators (`/`, `\`)
 *   - Word boundaries (`-`, `_`, ` `, `.`, `:`, `,`, `;`)
 *   - camelCase / PascalCase transitions
 *
 * Output is lowercased. Stop words and singular normalisation are applied
 * AFTER splitting by `normaliseTokens`.
 */
export function splitTokens(raw: string): string[] {
  if (!raw) return [];
  const out: string[] = [];

  // First split on coarse separators.
  const coarse = raw.split(/[\s/\\\-_.:,;()<>[\]{}]+/);
  for (const part of coarse) {
    if (!part) continue;
    // Then split each chunk on case transitions:
    //   PricingPage   → Pricing | Page
    //   APIToken      → API | Token
    //   billingV2     → billing | V | 2  (numbers are kept separate)
    const camelSplit = part.split(
      /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[a-zA-Z])(?=[0-9])|(?<=[0-9])(?=[a-zA-Z])/,
    );
    for (const piece of camelSplit) {
      if (!piece) continue;
      out.push(piece.toLowerCase());
    }
  }
  return out;
}

/**
 * Apply stop-word filtering and singularisation to a token list.
 * Removes empty / one-character tokens (except for digits which are
 * preserved as a single character `0`-`9`, but we drop those anyway since
 * they rarely carry IA signal — keep behaviour predictable).
 */
export function normaliseTokens(tokens: string[]): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    if (!t) continue;
    if (t.length < 2) continue;
    if (STOP_WORDS.has(t)) continue;
    out.push(SINGULAR_TABLE.get(t) ?? t);
  }
  return out;
}

/**
 * One-step shortcut: split + normalise. Returns deduplicated tokens in
 * first-seen order.
 */
export function tokenise(raw: string): string[] {
  const normalised = normaliseTokens(splitTokens(raw));
  return dedupe(normalised);
}

/**
 * Drop common repo-prefix segments so file paths and route paths share
 * the same token bag. Removes a small fixed set rather than guessing.
 *
 *   `src/pages/settings/billing.tsx` → `settings/billing`
 *   `packages/cli/src/index.ts`      → `cli`
 *   `apps/website/src/index.html`    → `website`
 */
export function stripRepoPrefix(repoRelPath: string): string {
  let p = repoRelPath.replace(/^\.\//, "");

  // packages/<x>/src/  and apps/<x>/src/  → drop the workspace prefix.
  p = p.replace(/^(packages|apps)\/[^/]+\/src\//, "");
  // Bare `src/` and `app/` at root.
  p = p.replace(/^(src|app)\//, "");
  return p;
}

function dedupe(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of arr) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * Tokenise a repo-relative file path. Drops the file extension and the
 * conventional `/index` / `/page` / `/route` terminal segments before
 * splitting — these are structural, not semantic.
 */
export function tokenisePath(repoRelPath: string): string[] {
  let p = stripRepoPrefix(repoRelPath);
  p = p.replace(/\.(ts|tsx|js|jsx|mjs|cjs|md|mdx)$/i, "");
  p = p.replace(/\/(index|page|route|view|screen|layout)$/i, "");
  return tokenise(p);
}
