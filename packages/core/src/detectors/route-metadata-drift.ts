import type { Detector } from "../detector.js";
import type { Finding } from "../finding.js";
import { tokenise, tokenisePath } from "../ia/tokenise.js";
import type {
  IaIndex,
  IaLabelSignal,
  IaRouteSignal,
} from "../ia/types.js";

/**
 * Fires when a single route's vocabulary appears to drift across the
 * places that describe it: the route path itself, the file/component
 * name, the page title / metadata, and any nav entry that points at it.
 *
 * The detector emits per route file, anchored on the route file's own
 * path -- so the finding shows up alongside the route in `crimes context`.
 */
export const routeMetadataDriftDetector: Detector = {
  id: "route_metadata_drift",
  name: "Route Metadata Drift",
  description:
    "Flags routes whose path, file/component name, page title, and nav " +
    "labels appear to describe the destination differently.",
  whyItMatters:
    "When a route's path, page title, breadcrumb, and component name " +
    "disagree, the product tells the user one story and the code tells " +
    "reviewers another. Agents updating labels rely on whichever source " +
    "they happen to see first, which is rarely the canonical one.",

  run(ctx) {
    if (!ctx.ia) return [];

    // Each route file fires at most one finding -- when ctx.file is that
    // route file. Other files in the scan return nothing.
    const route = ctx.ia.routes.find((r) => r.file === ctx.file);
    if (!route) return [];

    return analyseRoute(route, ctx.ia);
  },
};

/**
 * Cap how many evidence strings we attach -- keep the report readable.
 * Sized to fit route path + file + component + up to ~2 titles + up to ~3
 * nav labels (the common worst case) without dropping a nav source that
 * `related_files` will still surface.
 */
const MAX_EVIDENCE = 8;

interface LabelSource {
  origin: string;
  tokens: string[];
  quote: string;
}

interface NavHit {
  file: string;
  entry: { destination?: string; label?: string };
}

function analyseRoute(route: IaRouteSignal, ia: IaIndex): Finding[] {
  const labelSignals = ia.files[route.file]?.labels ?? [];
  const navHits = findNavEntriesFor(route.routePath, ia);
  const sources = collectSources(route, labelSignals, navHits);

  // Generic routes (only stop-word tokens after normalisation) are not
  // candidates -- "/", "/settings", "/app", layout-only paths, etc.
  // The route-path source is always the first one when present.
  const routeTokens = sources[0]?.origin === "route_path" ? sources[0].tokens : [];
  if (sources.length < 3 || routeTokens.length === 0) return [];

  const distinctTokenSets = computeDistinctTokenSets(sources);
  if (distinctTokenSets < 3) return [];

  const evidence = buildEvidenceLines(route, labelSignals, navHits);
  const related = relatedFilesFor(route, navHits);
  const confidence = round(Math.min(0.6 + (distinctTokenSets - 3) * 0.05, 0.8));

  return [
    {
      id: "",
      type: "route_metadata_drift",
      charge: "Route Metadata Drift",
      severity: "medium",
      confidence,
      file: route.file,
      summary:
        `Route ${route.routePath} appears to be labelled in ${distinctTokenSets} ` +
        "competing ways across its path, file, component, page title, and nav " +
        "entries. An agent editing one label may leave the others out of sync.",
      evidence,
      effort: "small",
      fix_shape: "derive route metadata from one source; remove the divergent copies",
      scores: {
        severity: 0.6,
        confidence,
        agent_risk: round(Math.min(0.65 + (distinctTokenSets - 3) * 0.05, 0.85)),
      },
      suggested_actions: [
        {
          kind: "align_route_metadata",
          description:
            "Choose the canonical name for this destination and align route " +
            "metadata, nav labels, and page/component names.",
          risk: "low",
        },
      ],
      related_files: related.length > 0 ? related : undefined,
    },
  ];
}

/**
 * Collect tokenised concept bags from each labelled source: route
 * path, file path, component name, page-title/heading labels, and any
 * nav entries pointing at this route. Sources contributing no tokens
 * after normalisation are dropped.
 */
function collectSources(
  route: IaRouteSignal,
  labelSignals: IaLabelSignal[],
  navHits: NavHit[],
): LabelSource[] {
  const sources: LabelSource[] = [];

  const routeTokens = tokenise(route.routePath);
  if (routeTokens.length > 0) {
    sources.push({ origin: "route_path", tokens: routeTokens, quote: route.routePath });
  }

  const fileTokens = tokenisePath(route.file);
  if (fileTokens.length > 0) {
    sources.push({ origin: "file_path", tokens: fileTokens, quote: route.file });
  }

  if (route.componentName) {
    const compTokens = tokenise(route.componentName);
    if (compTokens.length > 0) {
      sources.push({ origin: "component", tokens: compTokens, quote: route.componentName });
    }
  }

  for (const label of labelSignals) {
    const tks = tokenise(label.value);
    if (tks.length === 0) continue;
    sources.push({ origin: `label:${labelKindShort(label)}`, tokens: tks, quote: label.value });
  }

  for (const nav of navHits) {
    if (!nav.entry.label) continue;
    const tks = tokenise(nav.entry.label);
    if (tks.length === 0) continue;
    sources.push({ origin: `nav:${nav.file}`, tokens: tks, quote: nav.entry.label });
  }

  return sources;
}

/**
 * Distinct concept = the minimal token set after dropping tokens that
 * appear in EVERY source (the shared spine, not drift). A source
 * contributes drift if its remaining set is non-empty and not equal
 * to any other source's set. Returns the count of distinct sets.
 */
function computeDistinctTokenSets(sources: LabelSource[]): number {
  const everyTokens = intersectAll(sources.map((s) => new Set(s.tokens)));
  const distinct = new Set<string>();
  for (const src of sources) {
    const minus = src.tokens.filter((t) => !everyTokens.has(t));
    if (minus.length === 0) continue;
    distinct.add(minus.sort().join("|"));
  }
  return distinct.size;
}

function buildEvidenceLines(
  route: IaRouteSignal,
  labelSignals: IaLabelSignal[],
  navHits: NavHit[],
): string[] {
  const evidence: string[] = [];
  evidence.push(`route path: ${route.routePath}`);
  evidence.push(`file: ${route.file}`);
  if (route.componentName) evidence.push(`component: ${route.componentName}`);

  for (const label of labelSignals) {
    if (evidence.length >= MAX_EVIDENCE) break;
    evidence.push(`${labelKindLong(label)}: ${label.value}`);
  }
  for (const nav of navHits) {
    if (evidence.length >= MAX_EVIDENCE) break;
    if (!nav.entry.label) continue;
    evidence.push(`nav label in ${nav.file}: ${nav.entry.label}`);
  }
  return evidence;
}

function relatedFilesFor(route: IaRouteSignal, navHits: NavHit[]): string[] {
  return Array.from(new Set([route.file, ...navHits.map((n) => n.file)]))
    .filter((f) => f !== route.file)
    .sort();
}

function findNavEntriesFor(
  routePath: string,
  ia: IaIndex,
): { file: string; entry: { destination?: string; label?: string } }[] {
  const hits: { file: string; entry: { destination?: string; label?: string } }[] = [];
  const normTarget = normaliseDestination(routePath);
  for (const source of ia.navSources) {
    for (const literal of source.entries) {
      for (const entry of literal.entries) {
        if (!entry.destination) continue;
        if (normaliseDestination(entry.destination) === normTarget) {
          hits.push({ file: source.file, entry });
        }
      }
    }
  }
  return hits;
}

function normaliseDestination(dest: string): string {
  return dest.toLowerCase().replace(/\/+$/, "");
}

function labelKindShort(label: IaLabelSignal): string {
  switch (label.kind) {
    case "jsx_title":
      return "title";
    case "metadata_title":
      return "metadata.title";
    case "document_title":
      return "document.title";
    case "use_title":
      return "useTitle";
    case "jsx_label":
      return label.source ?? "jsx";
  }
}

function labelKindLong(label: IaLabelSignal): string {
  switch (label.kind) {
    case "jsx_title":
      return "<title>";
    case "metadata_title":
      return "metadata.title";
    case "document_title":
      return "document.title";
    case "use_title":
      return `${label.source ?? "useTitle"}()`;
    case "jsx_label":
      return `<${label.source ?? "Component"} label>`;
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function intersectAll(sets: Set<string>[]): Set<string> {
  if (sets.length === 0) return new Set();
  const out = new Set(sets[0]);
  for (let i = 1; i < sets.length; i++) {
    for (const v of out) {
      if (!sets[i]!.has(v)) out.delete(v);
    }
  }
  return out;
}
