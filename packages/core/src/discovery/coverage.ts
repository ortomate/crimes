import { extname } from "node:path";
import type { ScanReport } from "../finding.js";
import type { Pack } from "../pack.js";
import { JS_EXTENSIONS } from "./language-pack-router.js";

type Coverage = NonNullable<ScanReport["coverage"]>;

const PACK_SHORT_ID: Partial<Record<Pack, string>> = {
  "language-js": "js",
  "language-py": "py",
};

const PACK_EXTENSIONS: Partial<Record<Pack, readonly string[]>> = {
  "language-js": JS_EXTENSIONS,
  // language-py registers at module-load in 0.13.0.
};

export function buildCoverage(args: {
  files: readonly string[];
  packsLoaded: readonly string[];
}): Coverage {
  const filesByLanguage: Record<string, number> = {};
  let filesUniversalOnly = 0;

  for (const abs of args.files) {
    const ext = extname(abs).toLowerCase();
    const claimingPack = pickPack(ext, args.packsLoaded);
    if (claimingPack === undefined) {
      filesUniversalOnly += 1;
      continue;
    }
    const shortId = PACK_SHORT_ID[claimingPack] ?? claimingPack;
    filesByLanguage[shortId] = (filesByLanguage[shortId] ?? 0) + 1;
  }

  return {
    files_total: args.files.length,
    files_by_language: filesByLanguage,
    files_universal_only: filesUniversalOnly,
    files_skipped: 0,
    packs_loaded: [...args.packsLoaded],
  };
}

function pickPack(ext: string, packsLoaded: readonly string[]): Pack | undefined {
  for (const pack of packsLoaded as readonly Pack[]) {
    const exts = PACK_EXTENSIONS[pack];
    if (exts?.includes(ext)) return pack;
  }
  return undefined;
}
