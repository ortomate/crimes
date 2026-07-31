/**
 * Per-package coverage for polyglot monorepos.
 *
 * `files_by_language` answers "how much of this repo is Python?".
 * `by_package` answers "*which part* is the Python one", which is the
 * question that actually decides where a change is risky. In a repo
 * that is 70% TypeScript with one Python service, the repo-wide number
 * makes the service look like a rounding error.
 */

import { existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { ScanReport } from "../finding.js";
import type { Pack } from "../pack.js";
import type { LanguagePackRouter } from "./language-pack-router.js";

type ByPackage = NonNullable<NonNullable<ScanReport["coverage"]>["by_package"]>;

const PACK_SHORT_ID: Partial<Record<Pack, string>> = {
  "language-js": "js",
  "language-py": "py",
};

/**
 * Files whose presence marks a directory as a package root. Kept
 * broader than the packs we can parse: a `Cargo.toml` directory is
 * still a package worth reporting as universal-only coverage, and
 * naming it is more useful than folding it into the repo total.
 */
const MANIFESTS = [
  "package.json",
  "pyproject.toml",
  "setup.py",
  "Cargo.toml",
  "go.mod",
];

/**
 * A single-package repo is not a monorepo, and reporting one entry that
 * restates the repo total is noise.
 */
const MIN_PACKAGES = 2;

/**
 * Build the per-package breakdown, or `undefined` when the repo does
 * not look like a monorepo.
 *
 * Each file is attributed to the **deepest** package root containing
 * it, so a file in `packages/api/src/x.py` counts toward
 * `packages/api` rather than the repo root's own manifest.
 */
export function buildByPackage(args: {
  root: string;
  files: readonly string[];
  router: LanguagePackRouter;
}): ByPackage | undefined {
  const { root, files, router } = args;

  // Manifests are not in the discovered file set — `include` covers
  // source and docs, not `package.json` / `pyproject.toml`. So the
  // candidate directories come from the files we did discover, and each
  // one is checked on disk. Bounded by the number of distinct
  // directories, and memoised, so it stays a handful of `stat` calls
  // rather than a second walk of the tree.
  const absRoot = resolve(root);
  const checked = new Map<string, boolean>();
  const isPackageDir = (dir: string): boolean => {
    const cached = checked.get(dir);
    if (cached !== undefined) return cached;
    const abs = dir.length === 0 ? absRoot : join(absRoot, dir);
    const found = MANIFESTS.some((m) => existsSync(join(abs, m)));
    checked.set(dir, found);
    return found;
  };

  const packageDirs = new Set<string>();
  for (const abs of files) {
    const rel = toRepoPath(root, abs);
    let dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    // Walk up recording every package root above this file, so a nested
    // package inside another is still seen.
    for (;;) {
      if (isPackageDir(dir)) packageDirs.add(dir);
      if (dir.length === 0) break;
      dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
    }
  }

  // The repo root's own manifest doesn't make it a package *within*
  // itself; a repo needs two or more nested ones to be a monorepo.
  const nested = [...packageDirs].filter((d) => d.length > 0);
  if (nested.length < MIN_PACKAGES) return undefined;

  // Deepest-first so the first containing root wins.
  const ordered = nested.sort((a, b) => b.split("/").length - a.split("/").length);

  const buckets = new Map<string, { total: number; byLang: Record<string, number> }>();
  for (const dir of nested) buckets.set(dir, { total: 0, byLang: {} });

  for (const abs of files) {
    const rel = toRepoPath(root, abs);
    const owner = ordered.find((dir) => rel === dir || rel.startsWith(`${dir}/`));
    if (owner === undefined) continue;

    const bucket = buckets.get(owner)!;
    bucket.total += 1;
    const pack = router.claimingPack(abs);
    if (pack === undefined) continue;
    const shortId = PACK_SHORT_ID[pack] ?? pack;
    bucket.byLang[shortId] = (bucket.byLang[shortId] ?? 0) + 1;
  }

  return [...buckets.entries()]
    .map(([path, bucket]) => ({
      path,
      files_total: bucket.total,
      files_by_language: bucket.byLang,
      dominant_language: dominant(bucket.byLang, bucket.total),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The pack holding a strict majority of a package's files, or `null`.
 *
 * A strict majority rather than "most" on purpose: a package that is
 * 45% Python and 40% TypeScript has no dominant language, and calling
 * one of them dominant would put a confident label on a coin flip.
 */
function dominant(
  byLang: Record<string, number>,
  filesTotal: number,
): string | null {
  if (filesTotal === 0) return null;
  for (const [lang, count] of Object.entries(byLang)) {
    if (count * 2 > filesTotal) return lang;
  }
  return null;
}

function toRepoPath(root: string, abs: string): string {
  const rel = abs.startsWith(root) ? relative(root, abs) : abs;
  return rel.split(sep).join("/");
}
