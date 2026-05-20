import type { Detector, DetectorContext } from "../detector.js";
import type { Finding } from "../finding.js";
import type { IaIndex, IaPermissionSignal } from "../ia/types.js";

/**
 * Fires when the navigation, route guards, and docs describing one
 * destination disagree about which roles or permissions reach it.
 *
 * Conservative quorum: a destination needs ≥3 distinct permission
 * sources (across nav signals, in-file permission literals, and doc
 * headings/links touching the destination) AND ≥2 distinct permission
 * tokens (e.g. `admin` vs `owner`) before the detector fires. The
 * detector emits one finding per drifting destination, anchored on the
 * lex-first contributing file so the per-file detector loop emits each
 * finding exactly once.
 */
export const permissionIaDriftDetector: Detector = {
  id: "permission_ia_drift",
  name: "Permission IA Drift",
  description:
    "Flags destinations whose nav, route-guard, and doc references " +
    "describe access using different role / permission concepts.",
  whyItMatters:
    "When the nav says one role is allowed and the route guard or docs " +
    "say a different role is, the team — and any agent extending the " +
    "access policy — has no single source of truth. The hidden mismatch " +
    "is exactly where access bugs slip in unnoticed.",

  run(ctx) {
    if (!ctx.ia) return [];
    if (!isPrimaryAnchor(ctx)) return [];
    return analyse(ctx.ia);
  },
};

interface PermissionHit {
  source: "nav" | "route_guard" | "doc";
  file: string;
  token: string;
  line?: number;
  context: string;
}

function analyse(ia: IaIndex): Finding[] {
  const hitsByDest = new Map<string, PermissionHit[]>();

  // Nav-level permission attributes (role / permission / visibleTo / etc.).
  for (const source of ia.navSources) {
    for (const lit of source.entries) {
      for (const entry of lit.entries) {
        if (!entry.destination) continue;
        const dest = normalise(entry.destination);
        for (const [attr, value] of Object.entries(entry.attributes)) {
          if (!PERMISSION_ATTR_NAMES.has(attr.toLowerCase())) continue;
          const tokens = splitPermissionValue(value);
          for (const t of tokens) {
            push(hitsByDest, dest, {
              source: "nav",
              file: source.file,
              token: t,
              line: lit.line,
              context: `nav attr ${attr}=${value}`,
            });
          }
        }
      }
    }
  }

  // Route-guard permission literals: any permission found in a route file
  // is attributed to that file's route(s).
  for (const route of ia.routes) {
    const file = ia.files[route.file];
    if (!file) continue;
    for (const p of file.permissions) {
      const dest = normalise(route.routePath);
      const tokens = permissionTokens(p);
      for (const t of tokens) {
        push(hitsByDest, dest, {
          source: "route_guard",
          file: route.file,
          token: t,
          line: p.line,
          context: `${p.kind} literal "${p.value}"`,
        });
      }
    }
  }

  // Doc-level signals: any doc that contains an internal link to a
  // route file AND any permission-like role token in its headings or
  // text contributes a permission hit for that destination.
  for (const doc of ia.docs) {
    const docPermissionTokens = collectDocPermissionTokens(doc.headings.map((h) => h.text));
    if (docPermissionTokens.length === 0) continue;
    for (const link of doc.links) {
      if (!link.isLocal) continue;
      const routeMatch = ia.routes.find(
        (r) =>
          (link.resolved !== undefined && link.resolved === r.file) ||
          normalise(link.target) === normalise(r.routePath),
      );
      if (!routeMatch) continue;
      const dest = normalise(routeMatch.routePath);
      for (const t of docPermissionTokens) {
        push(hitsByDest, dest, {
          source: "doc",
          file: doc.file,
          token: t,
          line: link.line,
          context: `doc heading mentions "${t}"`,
        });
      }
    }
  }

  const findings: Finding[] = [];
  for (const [dest, hits] of hitsByDest) {
    const files = new Set(hits.map((h) => h.file));
    const tokens = new Set(hits.map((h) => h.token));
    if (files.size < 3) continue;
    if (tokens.size < 2) continue;

    const anchor = [...files].sort()[0]!;
    findings.push(buildFinding(dest, hits, anchor));
  }

  findings.sort((a, b) => a.file.localeCompare(b.file));
  return findings;
}

function buildFinding(
  destination: string,
  hits: PermissionHit[],
  anchor: string,
): Finding {
  const tokens = Array.from(new Set(hits.map((h) => h.token))).sort();
  const files = Array.from(new Set(hits.map((h) => h.file))).sort();

  const evidence: string[] = [
    `destination: ${destination || "/"}`,
    `tokens: ${tokens.join(", ")}`,
  ];
  for (const hit of hits.slice(0, MAX_EVIDENCE)) {
    const line = hit.line !== undefined ? `:${hit.line}` : "";
    evidence.push(`${hit.source} (${hit.file}${line}): ${hit.context}`);
  }
  if (hits.length > MAX_EVIDENCE) {
    evidence.push(`+${hits.length - MAX_EVIDENCE} more signal(s)`);
  }

  const related = files.filter((f) => f !== anchor);

  return {
    id: "",
    type: "permission_ia_drift",
    charge: "Permission IA Drift",
    severity: "medium",
    confidence: 0.7,
    file: anchor,
    summary:
      `Destination ${destination || "/"} appears to be described with ${tokens.length} ` +
      `different role / permission tokens across ${files.length} files. An ` +
      "agent extending one source of access policy may leave the others stale.",
    evidence,
    effort: "small",
    fix_shape: "centralise the permission check; every caller goes through it",
    scores: {
      severity: 0.65,
      confidence: 0.7,
    },
    suggested_actions: [
      {
        kind: "consolidate_permission",
        description:
          "Pick the canonical role / permission token for this destination " +
          "and align nav, route guards, and docs.",
        risk: "medium",
      },
    ],
    related_files: related.length > 0 ? related : undefined,
  };
}

function push(
  map: Map<string, PermissionHit[]>,
  dest: string,
  hit: PermissionHit,
): void {
  const list = map.get(dest);
  if (list) list.push(hit);
  else map.set(dest, [hit]);
}

function permissionTokens(p: IaPermissionSignal): string[] {
  if (p.kind === "role") return [p.value.toLowerCase()];
  // Dotted: the noun before the final verb is the resource; the final
  // verb is the action. Keep the leading noun for grouping.
  const parts = p.value.split(".");
  return parts.length > 0 ? [parts[0]!.toLowerCase()] : [];
}

function splitPermissionValue(value: string): string[] {
  return value
    .split(/[\s,|]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

const PERMISSION_ATTR_NAMES: ReadonlySet<string> = new Set([
  "role",
  "roles",
  "permission",
  "permissions",
  "visibleto",
  "visible_to",
  "requires",
  "requiresrole",
  "requirespermission",
  "allow",
  "allowedrole",
  "allowedroles",
]);

const PERMISSION_TOKEN_VOCABULARY: ReadonlySet<string> = new Set([
  "owner",
  "admin",
  "administrator",
  "manager",
  "founder",
  "member",
  "viewer",
  "editor",
  "guest",
  "user",
  "superuser",
  "super_admin",
]);

function collectDocPermissionTokens(texts: string[]): string[] {
  const found = new Set<string>();
  for (const t of texts) {
    for (const word of t.toLowerCase().split(/[^a-z_]+/)) {
      const normalised = singularise(word);
      if (PERMISSION_TOKEN_VOCABULARY.has(normalised)) found.add(normalised);
    }
  }
  return [...found];
}

function singularise(word: string): string {
  if (word.endsWith("s") && word.length > 2) return word.slice(0, -1);
  return word;
}

const MAX_EVIDENCE = 5;

function normalise(p: string): string {
  return p.toLowerCase().replace(/\/+$/, "");
}

function isPrimaryAnchor(ctx: DetectorContext): boolean {
  if (!ctx.ia) return false;
  const files = Object.keys(ctx.ia.files).sort();
  return files.length > 0 && files[0] === ctx.file;
}
