/**
 * Deterministic IA signal extractors.
 *
 * Every helper here returns evidence-only data. No semantic claim is made
 * about whether two signals refer to the same concept — that decision
 * belongs to detectors built on top.
 */

import { readFileSync } from "node:fs";
import { sep } from "node:path";
import type { ParsedFile } from "@crimes/language-js";
import type {
  IaDocFencedCommand,
  IaDocHeading,
  IaDocLink,
  IaDocSignal,
  IaLabelSignal,
  IaNavSignal,
  IaPermissionSignal,
  RepoPath,
} from "./types.js";

/**
 * File-path prefixes that indicate a route-convention directory. The path
 * AFTER the matched prefix becomes the route token.
 */
const ROUTE_PREFIXES: readonly string[] = [
  "src/pages/",
  "src/app/",
  "src/routes/",
  "src/screens/",
  "pages/",
  "app/",
  "routes/",
  "screens/",
];

/** File extensions a route file may use. */
const ROUTE_EXTS = /\.(tsx|ts|jsx|js|mjs|cjs)$/;

/**
 * Next.js App Router conventional file names that contribute the route path
 * but should be stripped from the URL.
 */
const APP_ROUTER_TERMINALS =
  /\/(page|layout|route|template|loading|error|not-found|default)$/;

/**
 * Given a repo-relative POSIX path, return the canonical route path if the
 * file appears to be a route file by convention, otherwise undefined.
 *
 *   `src/pages/settings/billing.tsx`     -> `/settings/billing`
 *   `app/account/subscription/page.tsx`  -> `/account/subscription`
 *   `pages/index.tsx`                    -> `/`
 *   `src/billing/tax.ts`                 -> undefined
 *   `src/pages/api/users.ts`             -> undefined (excluded API folder)
 */
export function routeFromFilePath(repoRel: RepoPath): string | undefined {
  const p = toPosix(repoRel);
  let stripped: string | undefined;
  for (const prefix of ROUTE_PREFIXES) {
    if (p.startsWith(prefix)) {
      stripped = p.slice(prefix.length);
      break;
    }
  }
  if (stripped === undefined) return undefined;

  // Skip API routes -- they aren't user-facing destinations.
  if (stripped.startsWith("api/")) return undefined;

  // Strip extension.
  stripped = stripped.replace(ROUTE_EXTS, "");
  if (stripped === "") return undefined;

  // Strip Next.js Pages-router "/index" terminal.
  if (stripped === "index") return "/";
  if (stripped.endsWith("/index")) {
    stripped = stripped.slice(0, -"/index".length);
  }

  // Strip Next.js App-router conventional file names.
  if (APP_ROUTER_TERMINALS.test("/" + stripped)) {
    stripped = stripped.replace(APP_ROUTER_TERMINALS, "");
  }

  // App-router groups: `(marketing)/about` -> `about`.
  stripped = stripped
    .split("/")
    .filter((seg) => !(seg.startsWith("(") && seg.endsWith(")")))
    .join("/");

  // Dynamic segments: `[id]` -> `:id`, `[...slug]` -> `*`.
  stripped = stripped
    .split("/")
    .map((seg) => {
      if (/^\[\.\.\..+\]$/.test(seg)) return "*";
      if (/^\[.+\]$/.test(seg)) return ":" + seg.slice(1, -1);
      return seg;
    })
    .join("/");

  if (stripped === "") return "/";
  return "/" + stripped;
}

/**
 * Heuristic permission-string extractor. Scans for bare role names and
 * dotted permission strings -- both common shapes in TS/JS code. Uses a
 * conservative regex (no AST) over the raw source.
 */
const BARE_ROLE_LITERAL =
  /["'](owner|admin|administrator|manager|founder|member|viewer|editor|super_admin|superuser|guest)["']/g;
const DOTTED_PERMISSION_LITERAL = /["']([a-z][a-z0-9_]+(?:\.[a-z][a-z0-9_]+){1,3})["']/g;

export function extractPermissions(source: string): IaPermissionSignal[] {
  const out: IaPermissionSignal[] = [];
  const seen = new Set<string>();

  for (const match of source.matchAll(BARE_ROLE_LITERAL)) {
    const value = match[1]!;
    const line = lineOf(source, match.index ?? 0);
    const key = `role::${value}::${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ value, line, kind: "role" });
  }

  for (const match of source.matchAll(DOTTED_PERMISSION_LITERAL)) {
    const value = match[1]!;
    if (looksLikeTranslationKey(value)) continue;
    if (!looksLikePermissionShape(value)) continue;
    const line = lineOf(source, match.index ?? 0);
    const key = `dotted::${value}::${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ value, line, kind: "dotted" });
  }

  return out;
}

const TRANSLATION_KEY_PREFIXES = new Set([
  "common",
  "ui",
  "i18n",
  "intl",
  "messages",
  "translation",
  "translations",
  "errors",
  "form",
  "validation",
  "labels",
  "buttons",
]);

const PERMISSION_VERBS = new Set([
  "manage",
  "create",
  "read",
  "write",
  "update",
  "delete",
  "edit",
  "view",
  "admin",
  "own",
  "invite",
  "remove",
  "list",
  "access",
  "approve",
  "publish",
  "archive",
]);

function looksLikeTranslationKey(s: string): boolean {
  const head = s.split(".")[0]!;
  return TRANSLATION_KEY_PREFIXES.has(head);
}

function looksLikePermissionShape(s: string): boolean {
  const parts = s.split(".");
  if (parts.length < 2 || parts.length > 4) return false;
  return PERMISSION_VERBS.has(parts[parts.length - 1]!);
}

/** Maps a string-byte offset to a 1-based line number. */
function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

/**
 * Lift UI string literals from a ParsedFile into the IA label signal shape.
 */
export function liftLabelSignals(parsed: ParsedFile): IaLabelSignal[] {
  const lits = parsed.uiStringLiterals;
  if (!lits || lits.length === 0) return [];
  return lits.map((l) => ({
    value: l.value,
    line: l.line,
    kind: l.context,
    source: l.source,
  }));
}

/**
 * Lift parsed nav literals into IA nav signals.
 */
export function liftNavSignals(parsed: ParsedFile): IaNavSignal[] {
  const literals = parsed.navLiterals;
  if (!literals || literals.length === 0) return [];
  return literals.map((l) => ({
    identifier: l.identifier,
    line: l.line,
    entries: l.entries.map((e) => ({
      destination: e.destination,
      label: e.label,
      attributes: { ...e.attributes },
    })),
  }));
}

// ---------- Markdown extraction ---------------------------------------------

const MD_HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const MD_LINK_RE = /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const FENCE_RE = /^```/;

const NONLOCAL_PREFIXES = ["http://", "https://", "mailto:", "tel:", "ftp://"];
const DEFERRED_HINT_RE =
  /\b(deferred|not implemented|not yet implemented|planned|coming soon|future|unimplemented|todo:|v\d+(?:\.\d+){1,2})\b/i;

/**
 * Patterns that look like local filesystem paths to a naive parser but
 * are actually server-rewritten GitHub-relative URLs. README files
 * routinely link to `../../issues`, `../../pull/42`, `../../wiki`,
 * etc. — those resolve on github.com once the README is rendered there,
 * not on disk. Flagging them as broken local links is a false positive
 * that erodes trust in `docs_code_drift`.
 *
 * The list mirrors the path segments GitHub itself rewrites: issues,
 * pulls, discussions, wiki, actions, releases, projects, security,
 * sponsors, compare, blob/<ref>/…, tree/<ref>/…, commit/<sha>,
 * commits, raw/<ref>/…. Allow trailing path / query / fragment.
 *
 * Sources of truth (GitHub URL routes):
 *   - https://docs.github.com/en/repositories
 *   - https://docs.github.com/en/repositories/working-with-files/using-files/working-with-non-code-files#about-relative-links
 */
const GITHUB_RELATIVE_RE =
  /^\.\.\/\.\.\/(?:issues|pull|pulls|discussions|wiki|actions|releases|projects|security|sponsors|compare|blob|tree|commit|commits|raw)(?:[/?#].*)?$/i;

/**
 * Parse a markdown document into headings, local links, and code-fenced
 * commands. Conservative -- anything ambiguous is skipped rather than
 * mis-extracted.
 */
export function parseMarkdown(source: string, file: RepoPath): IaDocSignal {
  const lines = source.split(/\r?\n/);
  const headings: IaDocHeading[] = [];
  const links: IaDocLink[] = [];
  const fenced: IaDocFencedCommand[] = [];

  let inFence = false;
  let fenceStartLine = 0;
  let fenceFirstCmd: { command: string; line: number } | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;

    if (FENCE_RE.test(line)) {
      if (inFence) {
        if (fenceFirstCmd) {
          fenced.push({
            command: fenceFirstCmd.command,
            line: fenceFirstCmd.line,
            deferred: nearbyContainsDeferredHint(lines, fenceStartLine, lineNo),
          });
        }
        inFence = false;
        fenceFirstCmd = undefined;
      } else {
        inFence = true;
        fenceStartLine = lineNo;
      }
      continue;
    }

    if (inFence) {
      if (!fenceFirstCmd && line.trim().length > 0) {
        fenceFirstCmd = {
          command: line.trim().replace(/^[$#]\s+/, ""),
          line: lineNo,
        };
      }
      continue;
    }

    const headingMatch = MD_HEADING_RE.exec(line);
    if (headingMatch) {
      headings.push({
        level: headingMatch[1]!.length,
        text: headingMatch[2]!.trim(),
        line: lineNo,
      });
      continue;
    }

    // Strip inline backtick spans before matching link syntax -- otherwise
    // examples like `[label](path)` inside inline code register as a link.
    const stripped = line.replace(/`[^`\n]*`/g, "");

    MD_LINK_RE.lastIndex = 0;
    let linkMatch: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: canonical stateful `exec` loop — the assignment in the condition is what advances `lastIndex`; `matchAll` would change parser behaviour, which must stay stable for detector output.
    while ((linkMatch = MD_LINK_RE.exec(stripped)) !== null) {
      const target = linkMatch[2]!;
      const isLocal = isLocalLink(target);
      links.push({
        target,
        line: lineNo,
        isLocal,
        brokenLocal: false,
      });
    }
  }

  return { file, headings, links, fencedCommands: fenced };
}

function isLocalLink(target: string): boolean {
  if (!target) return false;
  if (target.startsWith("#")) return false;
  for (const prefix of NONLOCAL_PREFIXES) {
    if (target.startsWith(prefix)) return false;
  }
  // GitHub-relative URLs (`../../issues`, `../../pull/42`, …) look local
  // but are rewritten server-side. Treat them as non-local so
  // `docs_code_drift` doesn't try to resolve them against disk.
  if (GITHUB_RELATIVE_RE.test(target)) return false;
  return true;
}

function nearbyContainsDeferredHint(
  lines: string[],
  fenceStart: number,
  fenceEnd: number,
): boolean {
  const before = Math.max(0, fenceStart - 3);
  const after = Math.min(lines.length, fenceEnd + 2);
  for (let i = before; i < after; i++) {
    const l = lines[i];
    if (l && DEFERRED_HINT_RE.test(l)) return true;
  }
  return false;
}

// ---------- package.json bin --------------------------------------------------

/**
 * Read a `package.json` from disk and return its declared `bin` names.
 * Returns `[]` on any error.
 */
export function readDeclaredBins(absPackageJsonPath: string): string[] {
  try {
    const raw = readFileSync(absPackageJsonPath, "utf8");
    const json = JSON.parse(raw) as {
      name?: string;
      bin?: string | Record<string, string>;
    };
    const bin = json.bin;
    if (!bin) return [];
    if (typeof bin === "string") {
      return json.name ? [json.name] : [];
    }
    return Object.keys(bin).sort();
  } catch {
    return [];
  }
}

/**
 * Extract `<bin-name> <subcommand>` references from an AGENTS.md-style
 * document.
 */
export function extractReferencedCommands(
  doc: IaDocSignal,
  binNames: readonly string[],
  rawSource: string,
): string[] {
  const result = new Set<string>();
  const bins = new Set<string>(binNames);
  if (bins.size === 0) return [];

  for (const cmd of doc.fencedCommands) {
    if (cmd.deferred) continue;
    const first = cmd.command.split(/\s+/)[0];
    const sub = cmd.command.split(/\s+/)[1];
    if (!first || !bins.has(first)) continue;
    if (!sub || sub.startsWith("-")) {
      result.add(first);
      continue;
    }
    result.add(`${first} ${sub}`);
  }

  for (const bin of bins) {
    const re = new RegExp("`(" + escapeRegex(bin) + ")(?:\\s+([a-z][a-z0-9-]*))?", "g");
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: canonical stateful `exec` loop; see the note on the markdown-link loop above.
    while ((m = re.exec(rawSource)) !== null) {
      const sub = m[2];
      if (sub) result.add(`${m[1]} ${sub}`);
      else result.add(m[1]!);
    }
  }

  return [...result].sort();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------- path utilities ----------------------------------------------------

export function toPosix(p: string): string {
  if (sep === "/") return p;
  return p.split(sep).join("/");
}
