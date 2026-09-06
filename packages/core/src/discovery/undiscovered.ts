/**
 * The gap between "files in this repo" and "files this scan looked at".
 *
 * Every other coverage field is computed from the list `discoverFiles`
 * returned, which makes them structurally incapable of reporting a file
 * discovery never returned. A repo of 1,226 `.vue` components produced a
 * report where `.vue` appeared nowhere — not in `files_total`, not in
 * `files_universal_only`, not in `universal_only_by_extension` — because
 * no `include` glob matches `*.vue` and the walker therefore never
 * emitted one. This module is the only place that looks outside the
 * walker's answer.
 *
 * The reference set is Git's, not a second filesystem walk. `git
 * ls-files --cached --others --exclude-standard` is one cheap process
 * that returns exactly "files a human would call part of this repo":
 * tracked files plus untracked ones Git isn't ignoring. A second glob
 * walk would either miss `.gitignore` (and count 90k files under
 * `node_modules` as a coverage gap) or have to reimplement it.
 */

import { execFile } from "node:child_process";
import { extname } from "node:path";
import { promisify } from "node:util";
import fg from "fast-glob";
import type { CoverageWarningLog } from "./coverage-warnings.js";
import { mapWithConcurrency } from "../util/concurrency.js";

const execFileAsync = promisify(execFile);

/**
 * Extensions listed individually before the rest collapse into one
 * rollup entry. A repo can easily carry twenty unmatched extensions with
 * one file each; without a cap the array that exists to make gaps
 * obvious buries the `.vue` line under `.pxm` and `.bson`.
 */
const EXTENSION_LIMIT = 10;

export interface CollectDiscoveryWarningsOptions {
  /**
   * Repo-relative paths that were dropped for a reason already recorded
   * elsewhere, so they must not also be reported as undiscovered.
   */
  alreadyExplained?: readonly string[];
  /** Absolute scan root. */
  root: string;
  /** The config `include` globs the walk used. */
  include: readonly string[];
  /** The config `exclude` globs the walk used. */
  exclude: readonly string[];
  /** Absolute paths `discoverFiles` returned for the same root. */
  discovered: readonly string[];
  /**
   * Absolute paths analysed by a pass other than the source pipeline —
   * in practice the asset pass. Subtracted from the gap, because a
   * `.png` matched by no source `include` glob is still read by the
   * raster detectors, and reporting it as unanalysed would be a lie in
   * the one field whose job is not lying.
   */
  alsoAnalysed?: readonly string[];
  /** Log the gap is recorded into. */
  into: CoverageWarningLog;
}

/**
 * Record every file the repo contains and the scan never read.
 *
 * Records nothing — deliberately, not even a warning about not knowing —
 * when the root is not inside a Git work tree. Without Git there is no
 * cheap way to tell a repo file from a build artefact, and a wrong count
 * in a field whose whole purpose is honesty is worse than no count.
 */
export async function collectDiscoveryWarnings(
  options: CollectDiscoveryWarningsOptions,
): Promise<void> {
  const repo = await gitRepoFiles(options.root);
  if (repo === undefined) return;

  const discovered = new Set(
    [...options.discovered, ...(options.alsoAnalysed ?? [])].map((abs) =>
      toRepoRelative(options.root, abs),
    ),
  );
  // Files the repo's own tooling excluded were discovered and then
  // deliberately dropped, and they already carry a
  // `files_excluded_by_tooling` warning naming the pattern that
  // authorised it. Without this they fall through to
  // `files_not_discovered`, which tells the user "no include pattern
  // matched them" — a second, false reason for the same 26 files.
  const alreadyExplained = new Set(options.alreadyExplained ?? []);
  const missed = repo.files
    .filter((rel) => !discovered.has(rel) && !alreadyExplained.has(rel))
    .sort();
  if (missed.length === 0) return;

  const excluded = await partitionByExclude({
    root: options.root,
    exclude: options.exclude,
    candidates: missed,
  });

  for (const rel of excluded.removed) {
    options.into.record("files_excluded", "config.exclude", { file: rel });
  }

  // Symlinks, submodules and dot-directories are missed for reasons that
  // have nothing to do with `include`, so folding them into the extension
  // histogram would put a false claim ("no include pattern matched .md")
  // in the one field whose job is not making false claims.
  //
  // Extensions the walk *did* return are the evidence that separates the
  // two: `.github/pull_request_template.md` is missed even though `.md`
  // is included, and the only reason is the leading dot.
  const scannedExtensions = new Set([...discovered].map(extensionKey));
  const unmatched: string[] = [];
  for (const rel of excluded.survived) {
    const entry = repo.notFollowed.get(rel);
    if (entry !== undefined) {
      options.into.record("files_not_followed", entry, { file: rel });
      continue;
    }
    const hidden = hiddenSegment(rel);
    if (hidden !== undefined && scannedExtensions.has(extensionKey(rel))) {
      options.into.record("files_in_hidden_path", hidden, { file: rel });
      continue;
    }
    unmatched.push(rel);
  }
  recordByExtension(options.into, unmatched);
}

/**
 * Split the missed set into "an `exclude` pattern removed this" and
 * "nothing claimed it in the first place".
 *
 * The test runs the *same matcher discovery runs* rather than a
 * reimplementation: fast-glob is handed the missed paths as literal
 * patterns with the config `exclude` list as `ignore`. Static patterns
 * are stat'd rather than walked, so this costs one `stat` per missed
 * file and never descends into `node_modules`.
 */
async function partitionByExclude(args: {
  root: string;
  exclude: readonly string[];
  candidates: readonly string[];
}): Promise<{ removed: string[]; survived: string[] }> {
  if (args.exclude.length === 0) {
    return { removed: [], survived: [...args.candidates] };
  }
  let survivors: Set<string>;
  try {
    // fast-glob compiles the supplied static patterns into each task's
    // matcher. Thousands of literal paths made this coverage-only step
    // quadratic. Bounded batches preserve its exact matcher/stat semantics.
    const batches: string[][] = [];
    for (let i = 0; i < args.candidates.length; i += 128) {
      batches.push(args.candidates.slice(i, i + 128).map((rel) => fg.escapePath(rel)));
    }
    const kept = await mapWithConcurrency(
      batches,
      (patterns) =>
        fg(patterns, {
          cwd: args.root,
          ignore: [...args.exclude],
          absolute: false,
          // `false` on purpose: a symlinked file fails an `onlyFiles`
          // check with `followSymbolicLinks: false`, and dropping it here
          // would misattribute it to the exclude list.
          onlyFiles: false,
          dot: true,
          followSymbolicLinks: false,
          suppressErrors: true,
        }),
      4,
    );
    survivors = new Set(kept.flat());
  } catch {
    // Attribution failed; report every missed file as undiscovered
    // rather than losing the whole warning set to a matcher problem.
    return { removed: [], survived: [...args.candidates] };
  }

  const removed: string[] = [];
  const survived: string[] = [];
  for (const rel of args.candidates) {
    if (survivors.has(rel)) survived.push(rel);
    else removed.push(rel);
  }
  return { removed, survived };
}

/**
 * Bucket undiscovered files by extension, largest first, with the tail
 * beyond {@link EXTENSION_LIMIT} collapsed into a single rollup entry so
 * the counts still add up to the total.
 */
function recordByExtension(log: CoverageWarningLog, files: readonly string[]): void {
  const byExtension = new Map<string, string[]>();
  for (const rel of files) {
    const key = extensionKey(rel);
    const list = byExtension.get(key);
    if (list) list.push(rel);
    else byExtension.set(key, [rel]);
  }

  const ranked = [...byExtension.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  );
  for (const [ext, paths] of ranked.slice(0, EXTENSION_LIMIT)) {
    for (const rel of paths) log.record("files_not_discovered", ext, { file: rel });
  }
  const tail = ranked.slice(EXTENSION_LIMIT);
  for (const [, paths] of tail) {
    for (const rel of paths) {
      log.record("files_not_discovered", "(other extensions)", { file: rel });
    }
  }
}

/**
 * First path segment starting with a dot, or `undefined` when there is
 * none. Returning the segment rather than a boolean makes the warning's
 * `subject` the directory to act on.
 *
 * `discoverFiles` walks dot-directories (`dot: true`), so `.github/`,
 * `.storybook/` and `.config/` are *found* — a hidden path only reaches
 * this function when discovery's `NEVER_WALK` list dropped it (`.git`,
 * `.venv`, `.tox`, the tool caches). Those are almost always gitignored
 * too, so they rarely survive as far as the missed set; when one is
 * committed anyway, this is the only field that can explain the gap
 * without blaming the include list for something it does match.
 */
function hiddenSegment(relativePath: string): string | undefined {
  for (const segment of relativePath.split("/")) {
    if (segment.startsWith(".") && segment !== "." && segment !== "..") {
      return segment;
    }
  }
  return undefined;
}

/** Matches `buildCoverage`'s bucketing so the two histograms line up. */
function extensionKey(relativePath: string): string {
  const ext = extname(relativePath).toLowerCase();
  return ext === "" ? "(no extension)" : ext;
}

function toRepoRelative(root: string, absolutePath: string): string {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  const rel = absolutePath.startsWith(prefix)
    ? absolutePath.slice(prefix.length)
    : absolutePath;
  return rel.split("\\").join("/");
}

interface RepoInventory {
  /** Repo entries at or under `root`, relative to `root`. */
  files: string[];
  /**
   * Entries discovery structurally cannot walk into, mapped to why:
   * `"symlink"` (mode 120000) or `"submodule"` (mode 160000). Read from
   * the index rather than by `lstat`-ing thousands of paths.
   */
  notFollowed: Map<string, "symlink" | "submodule">;
}

/**
 * Repo entries at or under `root`, relative to `root`. `git ls-files` is
 * already scoped to its working directory, so scanning a subdirectory of
 * a monorepo compares against that subdirectory only.
 *
 * `undefined` means "no Git here" — distinct from an empty inventory,
 * which means "Git says this directory is empty".
 */
async function gitRepoFiles(root: string): Promise<RepoInventory | undefined> {
  let files: string[];
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: root, maxBuffer: MAX_GIT_OUTPUT },
    );
    files = [...new Set(stdout.split("\0").filter((p) => p.length > 0))];
  } catch {
    return undefined;
  }
  return { files, notFollowed: await gitNotFollowed(root) };
}

/** File modes Git records for entries a directory walk cannot enter. */
const GIT_MODE_SYMLINK = "120000";
const GIT_MODE_GITLINK = "160000";
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;

async function gitNotFollowed(
  root: string,
): Promise<Map<string, "symlink" | "submodule">> {
  const out = new Map<string, "symlink" | "submodule">();
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "-s", "-z"], {
      cwd: root,
      maxBuffer: MAX_GIT_OUTPUT,
    });
    // `<mode> <object> <stage>\t<path>` per NUL-separated record.
    for (const record of stdout.split("\0")) {
      const tab = record.indexOf("\t");
      if (tab < 0) continue;
      const mode = record.slice(0, record.indexOf(" "));
      const path = record.slice(tab + 1);
      if (mode === GIT_MODE_SYMLINK) out.set(path, "symlink");
      else if (mode === GIT_MODE_GITLINK) out.set(path, "submodule");
    }
  } catch {
    // Attribution is a refinement; without it these entries still get
    // reported, just under the extension histogram.
  }
  return out;
}
