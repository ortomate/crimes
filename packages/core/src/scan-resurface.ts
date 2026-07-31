import { relative, resolve, sep } from "node:path";
import type { BaselineEntry } from "./baseline.js";
import {
  BASELINE_RELATIVE_PATH,
  BaselineNotFoundError,
  loadBaseline,
} from "./baseline.js";
import type { CrimesConfig } from "./config.js";
import type { Detector } from "./detector.js";
import { groupDetectorsByPack } from "./detector-registry.js";
import { resolveLanguagePackRouter } from "./discovery/language-pack-router.js";
import type { Finding } from "./finding.js";
import {
  getChangedFiles,
  NotAGitRepoError,
  UnknownGitRefError,
} from "./git/changed-files.js";
import { collectResurfaced } from "./resurface.js";
import { type ScanIndexes, runDetectorsForFile } from "./scan-detect.js";
import { finaliseFindingScores } from "./scoring/build.js";
import { loadTriage, resolveTriagePath } from "./triage.js";
import { safeRealpath } from "./util/realpath.js";

export /**
 * Resurface stage: re-run detectors on files in the diff against
 * `config.triage.resurfaceBase`, then keep only the findings whose
 * fingerprint matches a triage or baseline entry. Returns the annotated
 * resurfaced list. Empty when git is unavailable, the diff is empty, or
 * there's nothing to resurface — resurfacing is a quality-of-life feature
 * and must never make `scan()` fail.
 *
 * Shares the outer scan's `indexes` (IA, petty, imports, JSX shapes,
 * function hashes, scoring context) and `detectors`/`config`. The outer
 * scan already paid the cost of building these over the full file set;
 * re-detection on a handful of touched files is then just the per-file
 * detector pass, not a doubled scan.
 */
async function collectResurfaceForScan(args: {
  root: string;
  config: CrimesConfig;
  allFiles: string[];
  indexes: ScanIndexes;
  detectors: Detector[];
}): Promise<Finding[]> {
  const resurfaceBase = args.config.triage?.resurfaceBase ?? "main";
  if (resurfaceBase === "") return [];

  // Compute diff files. Any git failure (no repo, unknown ref) short-
  // circuits to "no resurfacing this run" — resurfacing is a quality-
  // of-life feature, never a fatal error.
  let diffPaths: string[];
  try {
    diffPaths = await getChangedFiles({ root: args.root, base: resurfaceBase });
  } catch (err) {
    if (err instanceof NotAGitRepoError || err instanceof UnknownGitRefError) {
      return [];
    }
    throw err;
  }
  if (diffPaths.length === 0) return [];

  // Convert absolute paths to repo-relative POSIX (matching Finding.file shape).
  // git emits canonical paths (`/private/var/...` on macOS); `args.root` may
  // still be the `/var/...` symlink the caller passed. realpath both sides
  // so the relative path comes out as `src/foo.ts`, not `../../private/var/.../src/foo.ts`.
  const rootReal = await safeRealpath(args.root);
  const diffFiles = new Set<string>(
    await Promise.all(
      diffPaths.map(async (abs) =>
        relative(rootReal, await safeRealpath(abs)).split(sep).join("/"),
      ),
    ),
  );

  // Load triage + baseline. Both files are optional — empty when absent.
  const [triageResult, baselineEntries] = await Promise.all([
    loadTriage(resolveTriagePath(args.root)),
    loadBaselineEntriesIfPresent(args.root),
  ]);

  if (triageResult.entries.length === 0 && baselineEntries.length === 0) {
    return [];
  }

  // Map repo-relative diff files back to absolute paths from the outer
  // scan's `allFiles` so the per-file detector pass uses identical
  // realpath / discovery semantics (and matches what the indexes were
  // built against). Files in the diff that aren't in `allFiles` (e.g.
  // markdown, lockfiles, JSON) are skipped — detectors don't run on
  // them and they can't carry triage / baseline entries.
  const allFilesReal = await Promise.all(
    args.allFiles.map(async (abs) => ({
      abs,
      relPath: relative(rootReal, await safeRealpath(abs)).split(sep).join("/"),
    })),
  );
  const absByRelPath = new Map<string, string>();
  for (const { abs, relPath } of allFilesReal) {
    absByRelPath.set(relPath, abs);
  }

  // Per-file detector cache so multiple resurfaced fingerprints on the
  // same file only pay one detector pass.
  const langPack = resolveLanguagePackRouter();
  const grouped = groupDetectorsByPack(args.detectors);
  const detectionCache = new Map<string, Promise<Finding[]>>();
  const reDetect = async (file: string): Promise<Finding[]> => {
    const cached = detectionCache.get(file);
    if (cached) return cached;
    const absolutePath = absByRelPath.get(file);
    if (!absolutePath) {
      const empty = Promise.resolve<Finding[]>([]);
      detectionCache.set(file, empty);
      return empty;
    }
    const promise = (async () => {
      const findings = await runDetectorsForFile({
        root: args.root,
        absolutePath,
        config: args.config,
        indexes: args.indexes,
        langPack,
        grouped,
      });
      // Finalise scores so resurfaced findings carry the same shape as
      // findings from the outer scan (agent_risk, churn, etc.).
      for (const f of findings) {
        finaliseFindingScores(f, args.indexes.scoring);
      }
      return findings;
    })();
    detectionCache.set(file, promise);
    return promise;
  };

  return collectResurfaced({
    diffFiles,
    triageEntries: triageResult.entries,
    baselineEntries,
    reDetect,
  });
}

async function loadBaselineEntriesIfPresent(
  root: string,
): Promise<BaselineEntry[]> {
  try {
    const baseline = await loadBaseline(resolve(root, BASELINE_RELATIVE_PATH));
    return baseline.findings;
  } catch (err) {
    if (err instanceof BaselineNotFoundError) return [];
    throw err;
  }
}
