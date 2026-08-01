import { readFile, stat } from "node:fs/promises";
import { extname, relative } from "node:path";
import { discoverFiles } from "./discovery/index.js";
import type { CrimesConfig } from "./config.js";
import type { AssetDetector, AssetDetectorContext } from "./detector.js";
import type { Finding } from "./finding.js";
import { assignPackAndDetectorId } from "./finding-finalise.js";

/**
 * Run every asset detector against every discovered asset file. Each
 * file is `stat`-ed once for byte size; the file bytes themselves are
 * loaded lazily and cached per-file so a detector that only needs
 * size never opens the file, and two detectors that both need bytes
 * read the file once between them.
 *
 * `--changed` is intentionally not honoured for the asset pass in
 * v1 — asset detection is per-file cheap and doesn't rely on the
 * cross-file scoring context, so a full asset walk on every PR is
 * acceptable. If asset scan time becomes a bottleneck we can plumb
 * through `restrictToChanged` later.
 *
 * Lives in its own module so `scan.ts` stays focused on the source-
 * pipeline orchestration. Exported so other scan entry points
 * (`context`, future commands) can run the asset pass without
 * importing the full source-scan orchestrator.
 */
export async function runAssetDetectorsForRoot(args: {
  root: string;
  config: CrimesConfig;
  detectors: AssetDetector[];
}): Promise<Finding[]> {
  if (args.detectors.length === 0) return [];
  const assetFiles = await discoverAssetFiles(args.root, args.config);
  if (assetFiles.length === 0) return [];

  const byExtension = groupDetectorsByExtension(args.detectors);

  const findings: Finding[] = [];
  for (const absolutePath of assetFiles) {
    findings.push(
      ...(await runDetectorsForAssetFile({
        root: args.root,
        absolutePath,
        config: args.config,
        byExtension,
      })),
    );
  }
  return findings;
}

async function discoverAssetFiles(root: string, config: CrimesConfig): Promise<string[]> {
  const includes = config.assets?.include;
  // No `assets.include` means the user explicitly cleared the
  // discovery pattern — treat that as "skip the asset pass entirely".
  if (!includes || includes.length === 0) return [];
  return discoverFiles({
    root,
    include: includes,
    exclude: config.assets?.exclude ?? [],
  });
}

function groupDetectorsByExtension(
  detectors: AssetDetector[],
): Map<string, AssetDetector[]> {
  // Group detectors by extension so each file walks only the detectors
  // that apply. A 5,000-image repo with 2 PNG detectors should not run
  // the SVG detector 5,000 times.
  const byExtension = new Map<string, AssetDetector[]>();
  for (const detector of detectors) {
    for (const ext of detector.extensions) {
      const key = ext.toLowerCase();
      const list = byExtension.get(key) ?? [];
      list.push(detector);
      byExtension.set(key, list);
    }
  }
  return byExtension;
}

async function runDetectorsForAssetFile(args: {
  root: string;
  absolutePath: string;
  config: CrimesConfig;
  byExtension: Map<string, AssetDetector[]>;
}): Promise<Finding[]> {
  const extension = extname(args.absolutePath).toLowerCase();
  const applicable = args.byExtension.get(extension);
  if (!applicable || applicable.length === 0) return [];

  const ctx = await buildAssetContext({
    root: args.root,
    absolutePath: args.absolutePath,
    extension,
    config: args.config,
  });
  if (!ctx) return [];

  const findings: Finding[] = [];
  for (const detector of applicable) {
    try {
      const detectorFindings = await detector.run(ctx);
      findings.push(...detectorFindings.map((f) => assignPackAndDetectorId(f, detector)));
    } catch {
      // Per-detector failure on one file should not abort the scan.
      // Skip and continue — same posture as the IA / scoring
      // builders' `safely*` wrappers.
    }
  }
  return findings;
}

async function buildAssetContext(args: {
  root: string;
  absolutePath: string;
  extension: string;
  config: CrimesConfig;
}): Promise<AssetDetectorContext | undefined> {
  let byteSize: number;
  try {
    const stats = await stat(args.absolutePath);
    byteSize = stats.size;
  } catch {
    // Unreadable files (permissions, vanished mid-scan) get skipped
    // silently — the asset pass should never crash a scan.
    return undefined;
  }

  let cachedBuffer: Buffer | undefined;
  const read = async (): Promise<Buffer> => {
    if (cachedBuffer === undefined) {
      cachedBuffer = await readFile(args.absolutePath);
    }
    return cachedBuffer;
  };

  return {
    file: toRepoPath(relative(args.root, args.absolutePath)),
    absolutePath: args.absolutePath,
    extension: args.extension,
    byteSize,
    read,
    config: args.config,
  };
}

function toRepoPath(p: string): string {
  // Node's `path.sep` differs across platforms, but the discovered
  // file list comes from fast-glob which already normalises to `/`.
  // Repeat the normalisation defensively in case a caller passes a
  // Windows-style path through.
  return p.split("\\").join("/");
}
