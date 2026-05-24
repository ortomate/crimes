import type { LanguageJsDetector } from "../detector.js";
import type { Finding } from "../finding.js";
import { tokenise, tokenisePath } from "../ia/tokenise.js";
import type { IaIndex, IaRouteSignal } from "../ia/types.js";

/**
 * Fires when two route files appear to serve the same user intent
 * (`/billing` vs `/settings/billing` vs `/account/subscription`).
 *
 * Heuristic:
 *   1. Two routes share ≥ 2 path tokens after IA tokenisation.
 *   2. Their default-export component names share ≥ 1 token (or both
 *      are absent — naming a default export is optional in some
 *      frameworks).
 *   3. They live under distinct top-level directories — same-dir
 *      neighbours are typically intentional siblings, not parallel
 *      destinations.
 *   4. Neither references the other through a doc link, nav entry
 *      pointing at one of the routes, or in-repo import edge.
 *
 * Anchored on the lexicographically first file in the pair so the
 * per-file loop emits each pair exactly once.
 */
export const parallelDestinationDetector: LanguageJsDetector = {
  id: "parallel_destination",
  name: "Parallel Destination",
  description:
    "Flags pairs of route files that appear to serve overlapping user " +
    "intent across different parts of the IA.",
  whyItMatters:
    "When two pages mean roughly the same thing, the product tells the " +
    "user two competing stories and the codebase tells agents two " +
    "competing places to make a change. The fix is to merge or to " +
    "document which one is canonical — but only after surfacing the " +
    "drift.",

  pack: "language-js",
  run(ctx) {
    if (!ctx.ia) return [];
    const route = ctx.ia.routes.find((r) => r.file === ctx.file);
    if (!route) return [];

    const candidates = findParallelCandidates(route, ctx.ia);
    if (candidates.length === 0) return [];

    // Anchor on the lex-first file in each pair.
    const findings: Finding[] = [];
    for (const other of candidates) {
      if (areLinked(route, other, ctx.ia, ctx.imports)) continue;
      const [anchorRoute, otherRoute] = sortPair(route, other);
      if (anchorRoute.file !== ctx.file) continue;
      findings.push(buildFinding(anchorRoute, otherRoute));
    }
    return findings;
  },
};

function findParallelCandidates(
  route: IaRouteSignal,
  ia: IaIndex,
): IaRouteSignal[] {
  const candidates: IaRouteSignal[] = [];
  const seedTokens = new Set(tokenise(route.routePath));
  if (seedTokens.size === 0) return [];
  const seedRoot = routeRootSegment(route.routePath);

  for (const other of ia.routes) {
    if (other.file === route.file) continue;
    if (other.routePath === route.routePath) continue;
    // Different first URL segment — routes that share a top segment are
    // typically intentional siblings (`/billing/subscription` vs
    // `/billing/invoices`), not parallel destinations.
    const otherRoot = routeRootSegment(other.routePath);
    if (otherRoot === seedRoot) continue;

    const otherTokens = new Set(tokenise(other.routePath));
    let overlap = 0;
    for (const t of otherTokens) if (seedTokens.has(t)) overlap += 1;
    if (overlap < 2) continue;

    if (!componentTokensOverlap(route, other)) continue;

    candidates.push(other);
  }
  return candidates;
}

function componentTokensOverlap(a: IaRouteSignal, b: IaRouteSignal): boolean {
  // Both component names absent → treat as a soft match (don't disqualify).
  if (!a.componentName && !b.componentName) return true;
  if (!a.componentName || !b.componentName) return false;
  const aTokens = new Set(tokenise(a.componentName));
  const bTokens = new Set(tokenise(b.componentName));
  for (const t of aTokens) if (bTokens.has(t)) return true;
  return false;
}

function areLinked(
  a: IaRouteSignal,
  b: IaRouteSignal,
  ia: IaIndex,
  imports: import("../imports/types.js").ImportGraph | undefined,
): boolean {
  // Nav entries pointing from one to the other.
  for (const source of ia.navSources) {
    const isFromA = source.file === a.file;
    const isFromB = source.file === b.file;
    if (!isFromA && !isFromB) continue;
    for (const lit of source.entries) {
      for (const entry of lit.entries) {
        const dest = entry.destination
          ? normalisePath(entry.destination)
          : undefined;
        if (!dest) continue;
        if (isFromA && dest === normalisePath(b.routePath)) return true;
        if (isFromB && dest === normalisePath(a.routePath)) return true;
      }
    }
  }
  // Doc links that resolve to one file inside the other's directory.
  for (const doc of ia.docs) {
    for (const link of doc.links) {
      if (link.resolved === a.file && doc.file === b.file) return true;
      if (link.resolved === b.file && doc.file === a.file) return true;
    }
  }
  // Direct import edge between the two route files.
  if (imports) {
    const aOut = imports.out.get(a.file) ?? [];
    if (aOut.some((e) => e.to === b.file)) return true;
    const bOut = imports.out.get(b.file) ?? [];
    if (bOut.some((e) => e.to === a.file)) return true;
  }
  return false;
}

function buildFinding(
  anchor: IaRouteSignal,
  other: IaRouteSignal,
): Finding {
  const evidence: string[] = [
    `routes: ${anchor.routePath}, ${other.routePath}`,
    `files: ${anchor.file}, ${other.file}`,
  ];
  if (anchor.componentName) evidence.push(`component: ${anchor.componentName}`);
  if (other.componentName) evidence.push(`component: ${other.componentName}`);
  const sharedTokens = sharedRouteTokens(anchor, other);
  if (sharedTokens.length > 0) {
    evidence.push(`shared tokens: ${sharedTokens.join(", ")}`);
  }
  evidence.push("no nav, doc, or import link between them");

  return {
    id: "",
    type: "parallel_destination",
    charge: "Parallel Destination",
    severity: "medium",
    confidence: 0.6,
    file: anchor.file,
    summary:
      `${anchor.routePath} and ${other.routePath} appear to serve ` +
      "overlapping user intent across different parts of the IA. An agent " +
      "updating one flow will likely miss the parallel one.",
    evidence,
    effort: "small",
    fix_shape: "fold the parallel destinations into one; route via a switch if necessary",
    scores: {
      severity: 0.55,
      confidence: 0.6,
    },
    suggested_actions: [
      {
        kind: "merge_or_document",
        description:
          "Decide which destination is canonical and either redirect the " +
          "other or document the deliberate split in the relevant docs.",
        risk: "medium",
      },
    ],
    related_files: [other.file],
  };
}

function sharedRouteTokens(
  a: IaRouteSignal,
  b: IaRouteSignal,
): string[] {
  const aSet = new Set([...tokenise(a.routePath), ...tokenisePath(a.file)]);
  const out: string[] = [];
  for (const t of tokenise(b.routePath)) {
    if (aSet.has(t) && !out.includes(t)) out.push(t);
  }
  return out;
}

function sortPair(
  a: IaRouteSignal,
  b: IaRouteSignal,
): [IaRouteSignal, IaRouteSignal] {
  return a.file < b.file ? [a, b] : [b, a];
}

function routeRootSegment(routePath: string): string {
  const stripped = routePath.replace(/^\/+/, "");
  const slash = stripped.indexOf("/");
  return slash === -1 ? stripped : stripped.slice(0, slash);
}

function normalisePath(p: string): string {
  return p.toLowerCase().replace(/\/+$/, "");
}
