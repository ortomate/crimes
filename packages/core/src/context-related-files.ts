/**
 * Deterministic neighbourhood related-file discovery for `crimes context`.
 *
 * Answers the question "before editing this file, what else should an agent
 * read?" — without git history, without an LLM, and without parsing every
 * file's imports. The output is a ranked, capped list of repo-relative
 * paths each carrying a short reason an agent can quote back.
 *
 * No new detectors. No new CLI command. Heuristics are intentionally
 * conservative; the cap keeps the noise floor predictable on large repos.
 */
import { basename, dirname } from "node:path";
import type { Finding } from "./finding.js";
import type { ImportEdge, ImportGraph } from "./imports/types.js";
import type { IaIndex } from "./ia/types.js";

/**
 * A single related-file suggestion. The shape is intentionally simple so
 * agents can render it with no schema knowledge: one path, one reason
 * string (multiple heuristic hits are joined with `; `), one ordinal score.
 *
 * `score` is a sort key — treat it as ordinal, not absolute, the same
 * contract as `Finding.scores.*`. Wording and weights may shift across
 * minor releases.
 */
export interface ContextRelatedFile {
  /** Repo-relative POSIX path. Never the target file itself. */
  file: string;
  /** Short, human-readable rationale. Multiple reasons joined with `; `. */
  reason: string;
  /** 0–1 ordinal weight used for sorting. Higher = more likely relevant. */
  score?: number;
}

/**
 * Cap on entries returned. Above-cap entries are dropped silently —
 * the per-heuristic weights keep the most-relevant entries near the top.
 * Bumping this isn't a breaking change but does push readability — 10 is
 * what a human or agent can scan in one breath.
 */
export const RELATED_FILES_CAP = 10;

/**
 * Tokens that pass the IA tokeniser's stop-word filter but are still too
 * generic to anchor a `matches domain prefix "<token>"` line. Without this
 * filter, every file under `api/` would suggest every other `api/` file
 * just because they share that single weak token.
 */
const WEAK_DOMINANT_TOKENS: ReadonlySet<string> = new Set([
  "api",
  "route",
  "router",
  "service",
  "services",
  "module",
  "modules",
  "handler",
  "handlers",
  "model",
  "models",
  "type",
  "types",
  "data",
  "store",
  "stores",
  "store",
  "common",
  "shared",
  "core",
]);

export interface FindRelatedFilesOptions {
  /** Repo-relative POSIX path of the target file. */
  fileRel: string;
  /** Repo-relative POSIX paths of every source file the scan discovered. */
  allFilesRel: readonly string[];
  /** Optional repo-level IA signal index, if it could be built. */
  ia?: IaIndex;
  /** Findings emitted on the target file (used for `.related_files` passthrough). */
  findings: readonly Finding[];
  /** Files already surfaced as likely tests — excluded so we don't double-count. */
  likelyTests: readonly string[];
  imports?: ImportGraph | undefined;
  /**
   * Files that changed in the same commits as the target, most first
   * (`git/co-change.ts`). Up to {@link CO_CHANGE_SLOTS} of them are
   * guaranteed a place, so a class with hundreds of importers cannot push
   * out the files a change to it usually touches.
   */
  coChanges?: readonly { file: string; commits: number }[];
  /** How many of the target's commits `coChanges` was counted over. */
  coChangeWindow?: number;
}

/**
 * Related-file places reserved for history. Four of ten: enough to carry
 * the cross-layer files imports cannot see, while graph edges keep the
 * majority.
 */
export const CO_CHANGE_SLOTS = 4;

/**
 * Run all enabled heuristics and return a ranked, capped, deduplicated
 * list of related files. Deterministic — repeated calls over the same
 * inputs produce identical output.
 */
export function findRelatedFiles(options: FindRelatedFilesOptions): ContextRelatedFile[] {
  const { fileRel, allFilesRel, ia, findings, likelyTests } = options;
  const targetDir = dirname(fileRel);
  const likelyTestSet = new Set(likelyTests);

  const targetTokens = new Set(ia?.files[fileRel]?.tokens ?? []);
  const dominantToken = pickDominantToken([...targetTokens]);

  // Accumulator keyed by repo-relative path. Reasons compound; score
  // accumulates with a per-entry cap so a file that hits three weak
  // heuristics doesn't beat one that hits a single strong one.
  const accumulator = new Map<string, { reasons: string[]; score: number }>();

  const add = (file: string, reason: string, weight: number): void => {
    if (file === fileRel) return;
    if (likelyTestSet.has(file)) return;
    const existing = accumulator.get(file);
    if (existing) {
      // Don't duplicate the same reason wording on the same file.
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      existing.score = Math.max(existing.score, weight);
    } else {
      accumulator.set(file, { reasons: [reason], score: Math.min(1, weight) });
    }
  };

  // Proven graph edges outrank accumulated filename hints.
  for (const edge of options.imports?.in.get(fileRel) ?? []) {
    add(edge.from, incomingReason(edge), 1);
  }
  for (const edge of options.imports?.out.get(fileRel) ?? []) {
    if (edge.to) add(edge.to, outgoingReason(edge), 0.9);
  }

  // (B/C) Finding.related_files passthrough. This is the highest-confidence
  // heuristic — an IA detector has already done cross-file work and
  // surfaced concrete evidence. Each passthrough hit weighs more than any
  // path-based heuristic.
  for (const f of findings) {
    if (!f.related_files || f.related_files.length === 0) continue;
    const reason = `related to ${f.charge}`;
    for (const rel of f.related_files) {
      add(rel, reason, 0.4);
    }
  }

  // Path-based heuristics — one loop over the candidate set.
  for (const rel of allFilesRel) {
    if (rel === fileRel) continue;

    // (A) Same directory siblings — cheap, conservative, useful for
    // grouping. Skip when the target sits at the repo root (`dirname`
    // is `"."`); in that case every other root-level file would qualify.
    if (dirname(rel) === targetDir && targetDir !== "." && targetDir !== "") {
      add(rel, "same directory", 0.2);
    }

    // (D) Shared IA tokens — cross-directory neighbourhood. Tokens are
    // already lowercased, stop-word-filtered, and singularised by the IA
    // tokeniser, so we only need to intersect.
    if (ia && targetTokens.size > 0) {
      const candTokens = ia.files[rel]?.tokens ?? [];
      const shared: string[] = [];
      for (const t of candTokens) {
        if (targetTokens.has(t) && !WEAK_DOMINANT_TOKENS.has(t)) {
          shared.push(t);
        }
      }
      if (shared.length > 0) {
        const top = shared[0]!;
        const weight = Math.min(0.4, 0.1 * shared.length);
        add(rel, `shares domain token "${top}"`, weight);
      }
    }

    // (E) Domain prefix / directory match on the file path. Independent
    // of the IA index — works on bare path strings.
    if (dominantToken) {
      if (matchesDomain(rel, dominantToken)) {
        add(rel, `matches domain "${dominantToken}"`, 0.3);
      }
    }
  }

  // History: files changed with the target in at least two recent
  // commits. Weighted by how often, below a proven import edge.
  const window = options.coChangeWindow ?? 0;
  const historyFiles = new Set<string>();
  for (const { file, commits } of options.coChanges ?? []) {
    if (file === fileRel || likelyTestSet.has(file)) continue;
    historyFiles.add(file);
    add(
      file,
      `changed with this file in ${commits} of its last ${window} commits`,
      Math.min(0.85, 0.5 + 0.07 * commits),
    );
  }

  const ranked = [...accumulator.entries()]
    .map(
      ([file, { reasons, score }]): ContextRelatedFile => ({
        file,
        reason: reasons.join("; "),
        score: roundScore(score),
      }),
    )
    .sort((a, b) => {
      const bs = b.score ?? 0;
      const as = a.score ?? 0;
      if (bs !== as) return bs - as;
      return a.file.localeCompare(b.file);
    });

  // Reserve places for history, in the order git gave it (most often
  // first), then fill the rest by score.
  const reserved = (options.coChanges ?? [])
    .map((c) => c.file)
    .filter((f) => historyFiles.has(f))
    .slice(0, CO_CHANGE_SLOTS);
  const chosen = new Set(reserved);
  for (const entry of ranked) {
    if (chosen.size >= RELATED_FILES_CAP) break;
    chosen.add(entry.file);
  }
  return ranked.filter((entry) => chosen.has(entry.file));
}

/**
 * Pick the most informative path token to anchor the "matches domain"
 * heuristic. Drops weak tokens (`api`, `route`, etc.) so a target like
 * `api/admin/users/route.ts` picks `admin` over `api` or `user`.
 *
 * Returns the first surviving token by insertion order — IA tokenisation
 * preserves segment order, so this approximates "leftmost meaningful
 * segment after the repo prefix".
 */
function pickDominantToken(tokens: readonly string[]): string | undefined {
  for (const t of tokens) {
    if (t.length < 3) continue;
    if (WEAK_DOMINANT_TOKENS.has(t)) continue;
    return t;
  }
  return undefined;
}

/**
 * Check whether a candidate path is "about" the given domain token via
 * any of: basename prefix (`admin-auth.ts`), basename suffix
 * (`auth-admin.ts`), or any path segment equalling the token.
 */
function matchesDomain(rel: string, domain: string): boolean {
  const b = basename(rel);
  if (b.startsWith(`${domain}-`) || b.startsWith(`${domain}.`)) return true;
  if (b.startsWith(`${domain}_`)) return true;
  // `-admin.ts` / `_admin.ts` suffix on the stem.
  const stem = b.replace(/\.[^.]+$/, "");
  if (stem.endsWith(`-${domain}`) || stem.endsWith(`_${domain}`)) return true;
  // Any path segment is exactly the domain.
  const segs = rel.split("/");
  if (segs.includes(domain)) return true;
  return false;
}

function roundScore(n: number): number {
  return Math.round(n * 100) / 100;
}

const TEMPLATE_RE = /\.(?:jsp|jspf|tag)$/i;
const STYLESHEET_RE = /\.(?:less|css)$/i;

/**
 * Why an in-edge's source is related. Template and stylesheet edges are
 * not all imports — a LESS partial *uses* a variable without importing
 * the file defining it, a page *calls* a tag — and saying "imports this
 * file" for those sends a reader looking for an `@import` that is not
 * there (0.31.0, from an eval agent doing exactly that).
 */
function incomingReason(edge: ImportEdge): string {
  if (STYLESHEET_RE.test(edge.from)) {
    if (edge.specifier.startsWith("@")) return `uses ${edge.specifier}, defined here`;
    if (edge.specifier.startsWith("."))
      return `uses mixin ${edge.specifier}, defined here`;
    return "imports this file";
  }
  if (TEMPLATE_RE.test(edge.from)) {
    if (edge.specifier.startsWith("<")) return `calls this tag as ${edge.specifier}`;
    if (/\.tld$/i.test(edge.to)) return "uses this tag library";
    if (/\.(?:java|kts?)$/.test(edge.to)) return "references this class";
    return "includes this file";
  }
  if (/\.tld$/i.test(edge.from)) return "declares this in a tag library";
  return edge.typeOnly ? "imports this file's types" : "imports this file";
}

/** Why an out-edge's target is related; the mirror of {@link incomingReason}. */
function outgoingReason(edge: ImportEdge): string {
  if (STYLESHEET_RE.test(edge.from)) {
    if (edge.specifier.startsWith("@") || edge.specifier.startsWith(".")) {
      return `defines ${edge.specifier}, used by this file`;
    }
    return "imported by this file";
  }
  if (TEMPLATE_RE.test(edge.from)) {
    if (edge.specifier.startsWith("<")) return `tag this file calls as ${edge.specifier}`;
    if (/\.tld$/i.test(edge.to)) return "tag library this file uses";
    if (/\.(?:java|kts?)$/.test(edge.to)) return "class this file references";
    return "included by this file";
  }
  return edge.typeOnly ? "type dependency" : "imported by this file";
}
