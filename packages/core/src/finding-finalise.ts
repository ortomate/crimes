import type { Finding, PreFinding } from "./finding.js";
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
/**
 * Populate `Finding.pack` and `Finding.detector_id` on a pre-finding,
 * returning the now-complete `Finding`. The mutation is in place; the
 * return type narrows the caller's view from `PreFinding` to `Finding`.
 */
export function assignPackAndDetectorId(
  finding: PreFinding,
  detector: { id: string; pack: Pack },
): Finding {
  const f = finding as Finding;
  f.pack = detector.pack;
  const suffix = PACK_SUFFIX[detector.pack];
  if (suffix === null || detector.id.endsWith(`.${suffix}`)) {
    f.detector_id = detector.id;
  } else {
    f.detector_id = `${detector.id}.${suffix}`;
  }
  return f;
}
