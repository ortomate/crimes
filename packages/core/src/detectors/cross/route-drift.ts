import type { PackedFile } from "../../detector.js";
import type { CrossLanguageDetector } from "../../detector.js";
import type { PreFinding as Finding, Severity } from "../../finding.js";
import { intrinsicFor, plural, round, severityScore } from "../py/shared.js";

/**
 * A backend route and the frontend calls that reach for it.
 *
 * The charge is a **frontend call with no matching backend route**, or a
 * **method mismatch** on a path both sides agree exists. Both are
 * places where the two halves of a product disagree about its own API,
 * which no single-language tool can see.
 *
 * What this deliberately does *not* do is resolve symbols across the
 * language boundary. The 0.15.0 design spec defers a cross-language
 * import graph, so matching is on the literal path strings both sides
 * wrote down. That means a route assembled at runtime on either side is
 * invisible here — recorded as a limitation rather than guessed at.
 */

/** Path parameter syntaxes, normalised so both sides compare equal. */
const PY_PARAM = /\{[^}]*\}/g; // FastAPI: /users/{user_id}
const FLASK_PARAM = /<[^>]*>/g; // Flask:   /users/<int:user_id>
const JS_TEMPLATE_PARAM = /\$\{[^}]*\}/g; // TS: `/users/${id}` (when literal-ish)
const DJANGO_PARAM = /<[^>]*>/g;

/**
 * Normalise a path so `/api/users/{user_id}` and `/api/users/<int:id>`
 * and `/api/users/:id` all compare equal. Parameter *names* carry no
 * cross-language meaning — only their position does.
 */
export function normalisePath(path: string): string {
  let out = path.trim();
  out = out.replace(PY_PARAM, "{}");
  out = out.replace(FLASK_PARAM, "{}");
  out = out.replace(DJANGO_PARAM, "{}");
  out = out.replace(JS_TEMPLATE_PARAM, "{}");
  out = out.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, "{}"); // Express-style /:id
  // Trailing slash is not a distinction any router treats as meaningful
  // by default, and treating it as one would manufacture drift.
  if (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out.toLowerCase();
}

interface BackendRoute {
  file: string;
  method: string;
  path: string;
  normalised: string;
  handler?: string;
  line: number;
}

interface FrontendCall {
  file: string;
  method: string;
  url: string;
  normalised: string;
  line: number;
}

export const crossLanguageRouteDriftDetector: CrossLanguageDetector = {
  id: "cross_language_route_drift",
  name: "Cross-language route drift",
  description:
    "Flags frontend fetch calls whose path no backend route declares, and paths where " +
    "the two sides disagree about the HTTP method.",
  whyItMatters:
    "The contract between a frontend and its backend is written down twice, in two " +
    "languages, and nothing checks that the two copies agree. A typo'd path or a route " +
    "renamed on one side only compiles fine on both sides and fails at runtime, usually " +
    "as a 404 that looks like a data problem rather than a wiring one. Type checkers " +
    "stop at the language boundary and neither linter can see the other half, so this " +
    "is exactly the class of mistake that survives review and reaches production — and " +
    "an agent asked to rename an endpoint will very often update one side and not the " +
    "other.",

  pack: "cross-language",
  run(ctx) {
    const backend = collectBackendRoutes(ctx.files);
    const frontend = collectFrontendCalls(ctx.files);

    // A one-sided repo cannot drift. Reporting "no backend route" for
    // every fetch in a repo with no Python at all would be noise
    // proportional to the frontend's size.
    if (backend.length === 0 || frontend.length === 0) return [];

    const byPath = new Map<string, BackendRoute[]>();
    for (const route of backend) {
      const bucket = byPath.get(route.normalised) ?? [];
      bucket.push(route);
      byPath.set(route.normalised, bucket);
    }

    const orphans: FrontendCall[] = [];
    const methodMismatches: Array<{ call: FrontendCall; routes: BackendRoute[] }> = [];

    for (const call of frontend) {
      const matches = byPath.get(call.normalised);
      if (!matches || matches.length === 0) {
        orphans.push(call);
        continue;
      }
      // `route`/`websocket` declare no verb, so they match anything.
      const methods = new Set(matches.map((m) => m.method));
      if (methods.has("route") || methods.has("websocket")) continue;
      if (!methods.has(call.method)) {
        methodMismatches.push({ call, routes: matches });
      }
    }

    const findings: Finding[] = [];
    if (orphans.length > 0) findings.push(buildOrphanFinding(orphans, backend));
    for (const mismatch of methodMismatches) {
      findings.push(buildMethodFinding(mismatch.call, mismatch.routes));
    }
    return findings;
  },
};

function collectBackendRoutes(files: PackedFile[]): BackendRoute[] {
  const out: BackendRoute[] = [];
  for (const entry of files) {
    if (entry.pack !== "language-py") continue;
    for (const route of entry.parsed.routes) {
      const item: BackendRoute = {
        file: entry.file,
        method: route.method,
        path: route.path,
        normalised: normalisePath(route.path),
        line: route.line,
      };
      if (route.handler !== undefined) item.handler = route.handler;
      out.push(item);
    }
  }
  return out;
}

function collectFrontendCalls(files: PackedFile[]): FrontendCall[] {
  const out: FrontendCall[] = [];
  for (const entry of files) {
    if (entry.pack !== "language-js") continue;
    for (const site of entry.parsed.fetchSites ?? []) {
      out.push({
        file: entry.file,
        method: site.method,
        url: site.url,
        normalised: normalisePath(site.url),
        line: site.line,
      });
    }
  }
  return out;
}

/**
 * One finding for all orphaned calls rather than one per call. They
 * share a cause — the two sides drifted — and a reader wants the list,
 * not N copies of the same charge.
 */
function buildOrphanFinding(orphans: FrontendCall[], backend: BackendRoute[]): Finding {
  const severity: Severity = orphans.length >= 3 ? "high" : "medium";
  const anchor = orphans[0]!;
  const shown = orphans.slice(0, 8);

  const evidence: string[] = [
    `${orphans.length} frontend ${plural(orphans.length, "call")} ` +
      `${orphans.length === 1 ? "reaches" : "reach"} a path no backend route declares`,
    ...shown.map((o) => `${o.file}:${o.line} — ${o.method.toUpperCase()} ${o.url}`),
    ...(orphans.length > shown.length ? [`…+${orphans.length - shown.length} more`] : []),
    `${backend.length} backend ${plural(backend.length, "route")} declared across ` +
      `${new Set(backend.map((b) => b.file)).size} ${plural(new Set(backend.map((b) => b.file)).size, "file")}`,
    "matched on literal path strings — a route or URL assembled at runtime is invisible to this check",
  ];

  const relatedFiles = [
    ...new Set([...orphans.map((o) => o.file), ...backend.map((b) => b.file)]),
  ]
    .filter((f) => f !== anchor.file)
    .sort()
    .slice(0, 8);

  return {
    id: "",
    type: "cross_language_route_drift",
    charge: "Cross-Language Route Drift",
    severity,
    confidence: 0.7,
    file: anchor.file,
    lines: [anchor.line, orphans[orphans.length - 1]!.line],
    summary:
      `${orphans.length} frontend ${plural(orphans.length, "call")} ` +
      `${orphans.length === 1 ? "targets" : "target"} a path that no backend route ` +
      "declares. Either the path is wrong or the route was renamed on one side only — " +
      "both fail at runtime as a 404 that reads like a data problem.",
    evidence,
    effort: "small",
    fix_shape: "align the path, or generate the client from the route table",
    scores: {
      severity: severityScore(severity),
      confidence: 0.7,
      agent_risk: intrinsicFor({
        count: orphans.length,
        base: 0.6,
        step: 0.07,
        cap: 0.9,
      }),
    },
    suggested_actions: [
      {
        kind: "align_api_contract",
        description:
          "Correct the mismatched path, then consider generating the client from the " +
          "backend's route table (OpenAPI, or a shared constants module) so the two " +
          "cannot drift again silently.",
        risk: "medium",
      },
    ],
    ...(relatedFiles.length > 0 ? { related_files: relatedFiles } : {}),
  };
}

function buildMethodFinding(call: FrontendCall, routes: BackendRoute[]): Finding {
  const declared = [...new Set(routes.map((r) => r.method.toUpperCase()))].sort();
  return {
    id: "",
    type: "cross_language_route_drift",
    charge: "Cross-Language Route Drift",
    severity: "medium",
    confidence: 0.75,
    file: call.file,
    lines: [call.line, call.line],
    summary:
      `The frontend calls ${call.method.toUpperCase()} ${call.url}, but the backend ` +
      `declares that path as ${declared.join(" / ")}. The path exists, so this fails as ` +
      "a 405 rather than a 404 — which is easy to misread as a permissions problem.",
    evidence: [
      `frontend: ${call.file}:${call.line} — ${call.method.toUpperCase()} ${call.url}`,
      ...routes.map(
        (r) =>
          `backend:  ${r.file}:${r.line} — ${r.method.toUpperCase()} ${r.path}` +
          (r.handler ? ` (${r.handler})` : ""),
      ),
      `methods declared: ${declared.join(", ")}`,
    ],
    effort: "quick",
    fix_shape: "use the method the route declares, or add the missing one",
    scores: {
      severity: severityScore("medium"),
      confidence: 0.75,
      // A method mismatch is a narrower, more certain claim than an
      // orphaned path — the path matched, so both sides agree the
      // endpoint exists.
      agent_risk: round(0.62),
    },
    suggested_actions: [
      {
        kind: "align_http_method",
        description:
          `Change the call to ${declared.join(" or ")}, or add a ` +
          `${call.method.toUpperCase()} handler for ${call.url} on the backend.`,
        risk: "low",
      },
    ],
    related_files: [...new Set(routes.map((r) => r.file))].filter((f) => f !== call.file),
  };
}
