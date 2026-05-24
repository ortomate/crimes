import type { LanguageJsDetector } from "../detector.js";
import type { PreFinding as Finding, Severity } from "../finding.js";
import type { ImportEdge, ImportGraph } from "../imports/types.js";

/**
 * Fires when a file imports from another package's deep internal path
 * (e.g. `import { x } from "@scope/lib/dist/internal/_private/x"`).
 * One finding per importing file; the count of offending edges drives
 * severity.
 *
 * Skips relative imports (`./`, `../`) and type-only imports. Imports
 * resolved through the local source tree (anything we have an in-repo
 * resolution for) are not considered deep — those are project-internal,
 * not third-party reach-in.
 */
export const deepImportDetector: LanguageJsDetector = {
  id: "deep_import",
  name: "Deep Import Abuse",
  description:
    "Flags imports that reach into another package's deep internal " +
    "structure (`pkg/dist/internal/_private/x`).",
  whyItMatters:
    "Deep imports bypass the published surface a package's authors " +
    "agreed to maintain. They become silent breakage vectors on every " +
    "upgrade, and agents copy them forward without realising the " +
    "import path is private API.",

  pack: "language-js",
  run(ctx) {
    if (!ctx.imports) return [];
    const outEdges = ctx.imports.out.get(ctx.file) ?? [];
    if (outEdges.length === 0) return [];

    const offenders: ImportEdge[] = [];
    for (const edge of outEdges) {
      if (!isDeepCandidate(edge)) continue;
      offenders.push(edge);
    }
    if (offenders.length === 0) return [];

    const severity = pickSeverity(offenders.length);
    const confidence = 0.85;
    const distinctPackages = new Set(
      offenders.map((e) => packageOf(e.specifier)).filter(Boolean),
    );

    const evidence: string[] = [
      `${offenders.length} deep import${offenders.length === 1 ? "" : "s"} ` +
        `across ${distinctPackages.size} package${distinctPackages.size === 1 ? "" : "s"}`,
    ];
    for (const edge of offenders.slice(0, 5)) {
      evidence.push(`specifier: ${edge.specifier}`);
    }
    if (offenders.length > 5) {
      evidence.push(`+${offenders.length - 5} more deep specifier(s)`);
    }

    const finding: Finding = {
      id: "",
      type: "deep_import",
      charge: "Deep Import Abuse",
      severity,
      confidence,
      file: ctx.file,
      summary:
        `${ctx.file} imports from ${offenders.length} deep package path` +
        `${offenders.length === 1 ? "" : "s"}. Reaching past a package's ` +
        "published surface ties this file to its private internals; the " +
        "next upgrade may move or remove them silently.",
      evidence,
      effort: "quick",
      fix_shape: "import from the package boundary, not the internals",
      scores: {
        severity: severityScore(severity),
        confidence,
      },
      suggested_actions: [
        {
          kind: "use_public_entry",
          description:
            "Prefer the package's documented entry point. If the symbol is " +
            "not exported, file an upstream issue rather than coding around it.",
          risk: "low",
        },
      ],
    };

    return [finding];
  },
};

/**
 * A deep-import candidate is a bare specifier (not relative, not aliased
 * to an in-repo file) whose path past the package name has at least three
 * extra segments AND mentions a marker that signals private structure
 * (`dist`, `internal`, `_private`, `lib/cjs`, `lib/esm`, etc.). The
 * two-condition check keeps `@scope/pkg/feature` (a legitimate
 * sub-export) out of the false-positive set.
 */
function isDeepCandidate(edge: ImportEdge): boolean {
  if (edge.typeOnly) return false;
  if (!edge.external) return false;
  const spec = edge.specifier;
  if (spec.startsWith("./") || spec.startsWith("../")) return false;
  if (spec.startsWith("node:")) return false;

  // Tokens past the package name. `@scope/pkg/a/b/c` → ["a","b","c"].
  const tail = stripPackagePrefix(spec);
  if (tail.length < 3) return false;

  return tail.some((seg) => PRIVATE_MARKERS.has(seg));
}

const PRIVATE_MARKERS: ReadonlySet<string> = new Set([
  "dist",
  "internal",
  "internals",
  "_private",
  "private",
  "build",
  "src",
  "lib",
  "esm",
  "cjs",
]);

function stripPackagePrefix(specifier: string): string[] {
  const parts = specifier.split("/").filter((s) => s.length > 0);
  if (parts.length === 0) return [];
  // Scoped (`@scope/pkg/...`) eats the first two segments; unscoped
  // (`pkg/...`) eats one.
  const prefixCount = parts[0]!.startsWith("@") ? 2 : 1;
  return parts.slice(prefixCount);
}

function packageOf(specifier: string): string {
  const parts = specifier.split("/").filter((s) => s.length > 0);
  if (parts.length === 0) return "";
  if (parts[0]!.startsWith("@") && parts.length >= 2) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0]!;
}

function pickSeverity(count: number): Severity {
  if (count >= 10) return "high";
  if (count >= 3) return "medium";
  return "low";
}

function severityScore(s: Severity): number {
  return s === "high" ? 0.85 : s === "medium" ? 0.6 : 0.35;
}
