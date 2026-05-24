import type { Finding } from "./finding.js";
import type { Pack } from "./pack.js";

const PACK_SUFFIX: Record<Pack, string | null> = {
  universal: null,
  "language-js": "js",
  "language-py": "py",
  "cross-language": "x",
};

/**
 * Populate `Finding.pack` and `Finding.detector_id` from the detector
 * that produced the finding. Universal-pack findings keep the bare
 * detector id (`finder_duplicate_filename`); language-pack findings
 * get a qualified id (`large_function.js`, `large_function.py`).
 *
 * Idempotent: if `detector_id` already has the pack suffix, leave it.
 * `Finding.type` (the abstract grouping key) is never modified.
 *
 * Accepts any object carrying `id` and `pack` so both source `Detector`
 * and `AssetDetector` instances work without separate overloads.
 *
 * Mutates the finding in place — the scan / context finalisation pass
 * calls this once per emitted finding before fingerprints are computed.
 */
export function assignPackAndDetectorId(
  finding: Finding,
  detector: { id: string; pack: Pack },
): void {
  finding.pack = detector.pack;
  const suffix = PACK_SUFFIX[detector.pack];
  if (suffix === null || detector.id.endsWith(`.${suffix}`)) {
    finding.detector_id = detector.id;
    return;
  }
  finding.detector_id = `${detector.id}.${suffix}`;
}
