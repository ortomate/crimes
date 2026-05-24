import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { LanguageJsDetector, DetectorContext } from "../detector.js";
import type { Finding } from "../finding.js";
import type { IaIndex } from "../ia/types.js";

/**
 * Fires when a docs page references a CLI subcommand that the project's
 * declared `bin` no longer implements.
 *
 * Reads the bin entry from the repo-root `package.json` (already
 * captured in `ia.agentContext.declaredBins`), scans that bin file for
 * Commander-style `.command("…")` registrations, and walks every
 * referenced command extracted from docs (fenced code blocks whose
 * first token is a declared bin name) looking for references that do
 * not appear in the advertised set.
 *
 * One finding per docs file with at least one missing reference.
 */
export const commandDriftDocsCodeDriftDetector: LanguageJsDetector = {
  id: "command_drift_docs_code_drift",
  name: "Docs Reference Missing Command",
  description:
    "Flags docs that reference a CLI subcommand the published bin no " +
    "longer advertises.",
  whyItMatters:
    "When the docs mention a subcommand that no longer exists, users " +
    "and agents reading the docs issue commands that fail or, worse, " +
    "fall through to a half-implemented surface. The fix is mechanical " +
    "but only if someone notices.",

  pack: "language-js",
  run(ctx) {
    if (!ctx.ia) return [];
    if (!isPrimaryAnchor(ctx)) return [];
    return analyse(ctx.ia);
  },
};

interface BinSurface {
  bin: string;
  advertised: Set<string>;
}

interface RefHit {
  ref: string;
  bin: string;
  sub: string;
  line: number;
}

function analyse(ia: IaIndex): Finding[] {
  const bins = ia.agentContext.declaredBins;
  if (bins.length === 0) return [];

  const surfaces = bins
    .map((bin) => loadBinSurface(ia.root, bin))
    .filter((s): s is BinSurface => s !== undefined && s.advertised.size > 0);
  if (surfaces.length === 0) return [];

  const findings: Finding[] = [];
  for (const doc of ia.docs) {
    const refs = collectReferencedCommands(doc);
    if (refs.length === 0) continue;
    const missing: RefHit[] = [];
    for (const ref of refs) {
      const surface = surfaces.find((s) => s.bin === ref.bin);
      if (!surface) continue;
      if (surface.advertised.has(ref.sub)) continue;
      missing.push(ref);
    }
    if (missing.length === 0) continue;

    const evidence: string[] = [];
    const advertisedList = surfaces
      .map((s) => `${s.bin}: ${[...s.advertised].sort().join(", ")}`)
      .join(" · ");
    for (const m of missing.slice(0, 5)) {
      evidence.push(`${doc.file}:${m.line} references "${m.bin} ${m.sub}"`);
    }
    if (missing.length > 5) {
      evidence.push(`+${missing.length - 5} more reference(s)`);
    }
    evidence.push(`advertised: ${advertisedList}`);

    findings.push({
      id: "",
      type: "command_drift_docs_code_drift",
      charge: "Docs Reference Missing Command",
      severity: "low",
      confidence: 0.8,
      file: doc.file,
      summary:
        `${doc.file} references ${missing.length} CLI subcommand` +
        `${missing.length === 1 ? "" : "s"} that the published bin no longer ` +
        "advertises. Readers following the docs will get a 'command not " +
        "found' error.",
      evidence,
      effort: "small",
      fix_shape: "regenerate command docs from code or codify them in CI",
      scores: {
        severity: 0.4,
        confidence: 0.8,
      },
      suggested_actions: [
        {
          kind: "update_or_remove_reference",
          description:
            "Update the doc to point at the current command surface, or " +
            "remove the reference if the command has been retired.",
          risk: "low",
        },
      ],
    });
  }

  findings.sort((a, b) => a.file.localeCompare(b.file));
  return findings;
}

function collectReferencedCommands(
  doc: IaIndex["docs"][number],
): RefHit[] {
  const out: RefHit[] = [];
  for (const cmd of doc.fencedCommands) {
    if (cmd.deferred) continue;
    const parts = cmd.command.split(/\s+/);
    const first = parts[0];
    const second = parts[1];
    if (!first || !second || second.startsWith("-")) continue;
    out.push({
      ref: `${first} ${second}`,
      bin: first,
      sub: second.replace(/^-+/, ""),
      line: cmd.line,
    });
  }
  return out;
}

function loadBinSurface(
  iaRoot: string,
  bin: string,
): BinSurface | undefined {
  const pkgPath = join(iaRoot, "package.json");
  if (!existsSync(pkgPath)) return undefined;
  let pkg: { bin?: string | Record<string, string>; name?: string };
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as typeof pkg;
  } catch {
    return undefined;
  }
  const binPath = resolveBinPath(iaRoot, pkg, bin);
  if (!binPath) return undefined;
  if (!existsSync(binPath)) return undefined;

  let source: string;
  try {
    source = readFileSync(binPath, "utf8");
  } catch {
    return undefined;
  }

  const advertised = new Set<string>();
  for (const match of source.matchAll(
    /\.command\(\s*["']([a-z][a-z0-9_-]*)/g,
  )) {
    advertised.add(match[1]!);
  }
  return { bin, advertised };
}

function resolveBinPath(
  root: string,
  pkg: { bin?: string | Record<string, string>; name?: string },
  bin: string,
): string | undefined {
  const binField = pkg.bin;
  if (!binField) return undefined;
  if (typeof binField === "string") {
    if (pkg.name !== bin) return undefined;
    return absJoin(root, binField);
  }
  const path = binField[bin];
  if (!path) return undefined;
  return absJoin(root, path);
}

function absJoin(root: string, p: string): string {
  if (isAbsolute(p)) return p;
  return join(root, p);
}

function isPrimaryAnchor(ctx: DetectorContext): boolean {
  if (!ctx.ia) return false;
  const files = Object.keys(ctx.ia.files).sort();
  return files.length > 0 && files[0] === ctx.file;
}
