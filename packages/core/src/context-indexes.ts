import { readFile, stat } from "node:fs/promises";
import { extname, relative, sep } from "node:path";
import { parseFile } from "@crimes/language-js";
import { parsePyFile } from "@crimes/language-py";
import type { CrimesConfig } from "./config.js";
import type { CrossLanguageDetector, Detector, PackedFile } from "./detector.js";
import { resolveLanguagePackRouter } from "./discovery/language-pack-router.js";
import type { Finding } from "./finding.js";
import { buildFunctionHashIndex } from "./ast-hash/function-index.js";
import type { FunctionHashIndex } from "./ast-hash/function-index.js";
import { buildIaIndex } from "./ia/build.js";
import type { IaConceptAliasGroup, IaIndex } from "./ia/types.js";
import { buildImportGraph } from "./imports/build.js";
import type { ImportGraph } from "./imports/types.js";
import { buildJsxShapeIndex } from "./jsx/shape-index.js";
import type { JsxShapeIndex } from "./jsx/shape-index.js";
import { buildPettyIndex } from "./petty/build.js";
import type { PettyIndex } from "./petty/types.js";
import {
  buildScoringContext,
  finaliseFindingScores,
} from "./scoring/build.js";
import type { ScoringContext } from "./scoring/build.js";
import { assignPackAndDetectorId } from "./finding-finalise.js";

/**
 * The six cross-file index builders moved to `indexes.ts` in 0.12.2 —
 * `scan.ts` carried byte-identical private copies of all of them. They
 * are re-exported here so `context.ts` keeps its single import site.
 */
export {
  safelyBuildFunctionHashIndex,
  safelyBuildIaIndex,
  safelyBuildImportGraph,
  safelyBuildJsxShapeIndex,
  safelyBuildPettyIndex,
  safelyBuildScoringContext,
} from "./indexes.js";

/**
 * Run every detector on the target file, applying the cross-file
 * indexes as detector context. Returns the detector findings filtered
 * to those that are about the target file (either `file` matches or
 * the target is in `related_files`).
 */
export async function runDetectorsOnTarget(args: {
  allFiles: string[];
  targetAbs: string;
  root: string;
  config: CrimesConfig;
  detectors: Detector[];
  ia?: IaIndex;
  petty?: PettyIndex;
  imports?: ImportGraph;
  jsxShapeIndex?: JsxShapeIndex;
  functionHashIndex?: FunctionHashIndex;
  scoring?: ScoringContext;
}): Promise<Finding[]> {
  const {
    allFiles,
    targetAbs,
    root,
    config,
    detectors,
    ia,
    petty,
    imports,
    jsxShapeIndex,
    functionHashIndex,
    scoring,
  } = args;
  if (!allFiles.includes(targetAbs)) return [];

  const file = toRepoPath(relative(root, targetAbs));
  const source = await readFile(targetAbs, "utf8");
  const byteSize = (await stat(targetAbs)).size;
  const router = resolveLanguagePackRouter();
  const claimsJs = router.claims("language-js", targetAbs);
  const claimsPy = router.claims("language-py", targetAbs);
  // Parsing a `.py` file with the TS parser produces a `ParsedFile`
  // full of nothing rather than an error, which is how the Python pack
  // came to be silently absent from `crimes context` — see the
  // language-py branch below.
  const parsed = claimsJs
    ? parseFile({ absolutePath: targetAbs, source })
    : undefined;
  const parsedPy = claimsPy
    ? await parsePyFile({ absolutePath: targetAbs, source })
    : undefined;

  const findings: Finding[] = [];
  for (const detector of detectors) {
    if (detector.pack === "universal") {
      const lineCount = source.split("\n").length;
      const detectorFindings = await detector.run({
        kind: "universal",
        file,
        absolutePath: targetAbs,
        extension: extname(targetAbs).toLowerCase(),
        byteSize,
        readSource: async () => source,
        get lineCount() { return lineCount; },
        config,
        ia,
        petty,
        scoring,
      });
      findings.push(...detectorFindings.map((f) => assignPackAndDetectorId(f, detector)));
    } else if (detector.pack === "language-js") {
      if (parsed === undefined) continue;
      const detectorFindings = await detector.run({
        kind: "language-js",
        file,
        absolutePath: targetAbs,
        source,
        parsed,
        config,
        ia,
        petty,
        imports,
        jsxShapeIndex,
        functionHashIndex,
        scoring,
      });
      findings.push(...detectorFindings.map((f) => assignPackAndDetectorId(f, detector)));
    } else if (detector.pack === "language-py") {
      if (parsedPy === undefined) continue;
      const detectorFindings = await detector.run({
        kind: "language-py",
        file,
        absolutePath: targetAbs,
        source,
        parsed: parsedPy,
        config,
        ia,
        petty,
        imports,
        scoring,
      });
      findings.push(...detectorFindings.map((f) => assignPackAndDetectorId(f, detector)));
    }
  }

  // Cross-language detectors reason about the whole corpus, so they
  // cannot run from a single parsed file. They matter most here of all
  // places: `crimes context` is the pre-edit briefing, and a
  // cross-language finding is precisely the one an agent must see
  // before it edits one side of a two-sided change.
  const crossDetectors = detectors.filter(
    (d): d is CrossLanguageDetector => d.pack === "cross-language",
  );
  if (crossDetectors.length > 0) {
    findings.push(
      ...(await runCrossLanguageOnCorpus({
        root,
        allFiles,
        config,
        detectors: crossDetectors,
        router,
        ia,
        imports,
        scoring,
      })),
    );
  }

  // Backfill per-finding scores (churn / test_gap / blast_radius) and
  // recompute agent_risk from the unified formula. Detectors that ran
  // before scoring landed may have set agent_risk themselves; the
  // finalisation pass overwrites with the canonical value.
  for (const f of findings) {
    finaliseFindingScores(f, scoring);
  }

  // `crimes context <file>` must only show findings that are *about*
  // <file>. IA detectors fire at scan time using a deterministic anchor
  // file (e.g. the lex-first source file in the repo), which may not be
  // the target. Keep only findings whose `.file` or `.related_files`
  // reference the target.
  return findings.filter(
    (f) => f.file === file || (f.related_files ?? []).includes(file),
  );
}

/**
 * Parse every claimed file and run the cross-language pack over the
 * result.
 *
 * This parses the corpus, which is not free — but `context` already
 * builds the IA index, the import graph, the JSX shape index and the
 * function-hash index, every one of which walks the same files. The
 * marginal cost is one more pass, not a new order of magnitude.
 */
async function runCrossLanguageOnCorpus(args: {
  root: string;
  allFiles: string[];
  config: CrimesConfig;
  detectors: CrossLanguageDetector[];
  router: ReturnType<typeof resolveLanguagePackRouter>;
  ia?: IaIndex;
  imports?: ImportGraph;
  scoring?: ScoringContext;
}): Promise<Finding[]> {
  const packed: PackedFile[] = [];
  for (const abs of args.allFiles) {
    const rel = toRepoPath(relative(args.root, abs));
    try {
      if (args.router.claims("language-js", abs)) {
        const src = await readFile(abs, "utf8");
        packed.push({
          pack: "language-js",
          file: rel,
          absolutePath: abs,
          parsed: parseFile({ absolutePath: abs, source: src }),
        });
      } else if (args.router.claims("language-py", abs)) {
        const src = await readFile(abs, "utf8");
        packed.push({
          pack: "language-py",
          file: rel,
          absolutePath: abs,
          parsed: await parsePyFile({ absolutePath: abs, source: src }),
        });
      }
    } catch {
      // A file that won't read or parse contributes nothing rather
      // than failing the whole briefing.
    }
  }
  packed.sort((a, b) => a.file.localeCompare(b.file));

  const out: Finding[] = [];
  for (const detector of args.detectors) {
    const emitted = await detector.run({
      kind: "cross-language",
      root: args.root,
      files: packed,
      config: args.config,
      ia: args.ia,
      imports: args.imports,
      scoring: args.scoring,
    });
    out.push(...emitted.map((f) => assignPackAndDetectorId(f, detector)));
  }
  return out;
}

function toRepoPath(p: string): string {
  return p.split(sep).join("/");
}
