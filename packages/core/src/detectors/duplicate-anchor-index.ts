import type { FunctionHashIndex, FunctionHit } from "../ast-hash/function-index.js";

/** Which view of the hash index a caller wants. */
export type DuplicateView = "exact" | "shape";

export interface AnchoredGroup {
  hash: string;
  hits: FunctionHit[];
  /** Lexicographically first file in the group — the reporting anchor. */
  anchor: string;
}

/**
 * Group duplicate-hash entries by their anchor file, computed once per
 * (index, view) and cached.
 *
 * `Detector.run()` is called once per file. Both duplicate-block
 * detectors used to spread the whole repo-wide hash map into an array
 * and `localeCompare`-sort it on *every one of those calls*, then throw
 * away every group not anchored on the current file — O(files × hashes
 * log hashes). A CPU profile of a PostHog scan put 36% of all samples in
 * those two comparators, and the scan took 3h42m; n8n never finished at
 * all. Measured cost was superlinear in file count on both repos
 * (~O(n^1.45) and ~O(n^1.75)).
 *
 * Doing the sort once and indexing by anchor makes each `run()` call an
 * O(1) map lookup. Emitted order is unchanged: groups are still ordered
 * by hash, and the anchor is still the lexicographically first file, so
 * findings and their evidence are byte-identical to before.
 */
export function anchoredGroups(
  index: FunctionHashIndex,
  view: DuplicateView,
): Map<string, AnchoredGroup[]> {
  let perView = cache.get(index);
  if (perView === undefined) {
    perView = new Map();
    cache.set(index, perView);
  }
  const existing = perView.get(view);
  if (existing !== undefined) return existing;

  const built = build(view === "exact" ? index.byExact : index.byShape);
  perView.set(view, built);
  return built;
}

type AnchorMap = Map<string, AnchoredGroup[]>;

const cache = new WeakMap<FunctionHashIndex, Map<DuplicateView, AnchorMap>>();

function build(source: Map<string, FunctionHit[]>): Map<string, AnchoredGroup[]> {
  const byAnchor = new Map<string, AnchoredGroup[]>();
  // Sort the hashes once. Previously this happened per file.
  const hashes = [...source.keys()].sort((a, b) => a.localeCompare(b));
  for (const hash of hashes) {
    const hits = source.get(hash);
    if (hits === undefined) continue;
    const distinctFiles = new Set(hits.map((h) => h.file));
    if (distinctFiles.size < 2) continue;
    const anchor = [...distinctFiles].sort()[0];
    if (anchor === undefined) continue;
    const group: AnchoredGroup = { hash, hits, anchor };
    const bucket = byAnchor.get(anchor);
    if (bucket === undefined) byAnchor.set(anchor, [group]);
    else bucket.push(group);
  }
  return byAnchor;
}
