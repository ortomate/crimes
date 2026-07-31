import { extname } from "node:path";
import type { ScanReport } from "../finding.js";
import type { Pack } from "../pack.js";
import type { LanguagePackRouter } from "./language-pack-router.js";

type Coverage = NonNullable<ScanReport["coverage"]>;

const PACK_SHORT_ID: Partial<Record<Pack, string>> = {
  "language-js": "js",
  "language-py": "py",
};

/**
 * Roll discovered files into per-language buckets for
 * `ScanReport.coverage`.
 *
 * Pack membership comes from the `LanguagePackRouter` — the same
 * registry the detector orchestrator routes on — so coverage cannot
 * drift from what actually ran. A pack that registers extensions at
 * module load is reported here automatically; there is no second list
 * to keep in sync.
 *
 * `packs_loaded` always leads with `universal`, which claims every file
 * unconditionally and therefore never appears in the router.
 */
export function buildCoverage(args: {
  files: readonly string[];
  router: LanguagePackRouter;
}): Coverage {
  const filesByLanguage: Record<string, number> = {};
  const universalOnlyByExtension: Record<string, number> = {};
  let filesUniversalOnly = 0;

  for (const abs of args.files) {
    const claimingPack = args.router.claimingPack(abs);
    if (claimingPack === undefined) {
      filesUniversalOnly += 1;
      const ext = extensionKey(abs);
      universalOnlyByExtension[ext] = (universalOnlyByExtension[ext] ?? 0) + 1;
      continue;
    }
    const shortId = PACK_SHORT_ID[claimingPack] ?? claimingPack;
    filesByLanguage[shortId] = (filesByLanguage[shortId] ?? 0) + 1;
  }

  return {
    files_total: args.files.length,
    files_by_language: filesByLanguage,
    files_universal_only: filesUniversalOnly,
    universal_only_by_extension: universalOnlyByExtension,
    packs_loaded: ["universal", ...args.router.registeredPacks()],
  };
}

/**
 * Bucket key for the universal-only histogram. Lower-cased extension
 * including the dot (`.py`); extensionless files (`Makefile`,
 * `Dockerfile`) collapse into `(no extension)` rather than an empty
 * string, which reads badly in both JSON and terminal output.
 */
function extensionKey(absolutePath: string): string {
  const ext = extname(absolutePath).toLowerCase();
  return ext === "" ? "(no extension)" : ext;
}
