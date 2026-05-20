import type { Detector } from "../detector.js";
import type { Finding } from "../finding.js";
import type { IaIndex, IaRouteSignal } from "../ia/types.js";

/**
 * Fires when a discovered route file is not reachable from any nav
 * source, internal doc link, or registry-style import edge. The
 * detector is informational only — newly-added routes in flight, or
 * routes registered through non-convention plumbing, can legitimately
 * appear "orphaned" without being a bug.
 *
 * Anchored on the route file itself so the per-file detector loop emits
 * each finding exactly once.
 */
export const orphanedDestinationDetector: Detector = {
  id: "orphaned_destination",
  name: "Orphaned Destination",
  description:
    "Flags route/page files that no nav source, internal doc link, or " +
    "in-repo import references.",
  whyItMatters:
    "Pages that nothing links to often outlive the journey they were " +
    "built for. They drift out of sync with the rest of the product, " +
    "agents updating the live flows miss them entirely, and reviewers " +
    "rediscover them months later via grep.",

  run(ctx) {
    if (!ctx.ia) return [];
    const route = ctx.ia.routes.find((r) => r.file === ctx.file);
    if (!route) return [];
    if (isReachable(route, ctx.ia, ctx.imports)) return [];

    const evidence: string[] = [
      `route path: ${route.routePath}`,
      `file: ${route.file}`,
      "no nav source references this destination",
      "no internal doc link references this destination",
      "no in-repo import targets this route file",
    ];

    const finding: Finding = {
      id: "",
      type: "orphaned_destination",
      charge: "Orphaned Destination",
      severity: "low",
      confidence: 0.65,
      file: route.file,
      summary:
        `Route ${route.routePath} appears to be unreachable from any nav, ` +
        "doc link, or in-repo import. The page may be in flight, or it may " +
        "have outlived the journey it was built for.",
      evidence,
      effort: "quick",
      fix_shape: "delete the orphan destination or wire it up",
      scores: {
        severity: 0.4,
        confidence: 0.65,
      },
      suggested_actions: [
        {
          kind: "link_or_retire",
          description:
            "Either link the destination from the relevant nav / docs, or " +
            "remove it if the flow it served is gone.",
          risk: "low",
        },
      ],
    };

    return [finding];
  },
};

function isReachable(
  route: IaRouteSignal,
  ia: IaIndex,
  imports: import("../imports/types.js").ImportGraph | undefined,
): boolean {
  const dest = normaliseDestination(route.routePath);
  if (dest.length === 0) return true; // root is always reachable

  for (const source of ia.navSources) {
    for (const lit of source.entries) {
      for (const entry of lit.entries) {
        if (!entry.destination) continue;
        if (normaliseDestination(entry.destination) === dest) return true;
      }
    }
  }

  for (const doc of ia.docs) {
    for (const link of doc.links) {
      if (link.resolved === route.file) return true;
      if (link.isLocal && stripQueryFragment(link.target) === route.routePath) {
        return true;
      }
    }
  }

  if (imports) {
    const incoming = imports.in.get(route.file) ?? [];
    if (incoming.length > 0) return true;
  }

  return false;
}

function normaliseDestination(dest: string): string {
  return dest.toLowerCase().replace(/\/+$/, "");
}

function stripQueryFragment(target: string): string {
  const noHash = target.split("#")[0]!;
  const noQuery = noHash.split("?")[0]!;
  return noQuery;
}
