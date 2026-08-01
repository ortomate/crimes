/**
 * Build a repo-wide import graph from a set of discovered source files.
 *
 * The graph is best-effort and never throws on a single bad file: a parse
 * failure or an unresolvable specifier is recorded as an edge with empty
 * `to` (when the specifier could not be resolved), or skipped silently
 * (when the file itself cannot be parsed). Cycles are walked safely;
 * dynamic `import()` calls with literal specifiers are included, non-literal
 * dynamic imports are dropped.
 *
 * Built once per scan and attached to `DetectorContext.imports`. Detectors
 * must never re-walk imports themselves.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { buildPythonImportEdges } from "./python.js";
import type { ImportEdge, ImportGraph } from "./types.js";

const SOURCE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const CANDIDATE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".d.ts",
] as const;

export interface BuildImportGraphOptions {
  /** Absolute repo root. */
  root: string;
  /**
   * Absolute paths of every file the scan already discovered. The graph
   * only includes edges whose source is in this set; targets outside the
   * set are still resolved when possible but never contribute in-edges.
   */
  files: string[];
  /**
   * Maximum number of source files to walk. Above the limit, the build
   * truncates and sets `limited` on the returned graph. Defaults to the
   * spec's 200ms-on-1k-files budget — 5000 files.
   */
  maxFiles?: number;
}

interface TsconfigPaths {
  /** Absolute base directory (the directory containing tsconfig.json). */
  baseUrl: string;
  /** Map of pattern → array of relative substitutions. */
  paths: Record<string, string[]>;
}

/**
 * Build the import graph. Always returns a graph; missing edges manifest
 * as empty in/out lists rather than absent files.
 */
export async function buildImportGraph(
  options: BuildImportGraphOptions,
): Promise<ImportGraph> {
  const root = resolve(options.root);
  const maxFiles = options.maxFiles ?? 5000;
  const tsPaths = loadTsconfigPaths(root);

  const sourceFiles = options.files
    .filter((abs) => SOURCE_EXT_RE.test(abs))
    .slice(0, maxFiles);
  const limited =
    options.files.filter((abs) => SOURCE_EXT_RE.test(abs)).length > sourceFiles.length;

  // The "known set" — files we can resolve to. Used so that out-of-tree
  // resolved paths (e.g. the import landed outside the file set) are
  // demoted to "external" rather than producing dangling edges.
  const knownSet = new Set<string>(sourceFiles.map((abs) => toRepoPath(root, abs)));

  const edges: ImportEdge[] = [];
  const out = new Map<string, ImportEdge[]>();
  const inMap = new Map<string, ImportEdge[]>();
  const files = new Set<string>();

  // Python edges are resolved by `@crimes/language-py` and merged into
  // this same graph. Every downstream consumer — cycle detection, fan-in
  // / fan-out, and `scores.blast_radius` — is language-agnostic, so a
  // Python module imported by 30 others earns the same blast radius a TS
  // module would. Added in 0.14.0; before that Python scored 0.
  const python = await buildPythonImportEdges({
    root,
    files: options.files,
    maxFiles,
  });
  edges.push(...python.edges);
  // Register every Python file, not just the ones that import something —
  // a leaf module with zero imports is still a node other files point at.
  for (const abs of options.files) {
    if (/\.pyi?$/.test(abs)) files.add(toRepoPath(root, abs));
  }

  await Promise.all(
    sourceFiles.map(async (abs) => {
      const fromRel = toRepoPath(root, abs);
      files.add(fromRel);
      let source: string;
      try {
        source = readFileSync(abs, "utf8");
      } catch {
        return;
      }
      const specs = extractImportSpecifiers(abs, source);
      for (const spec of specs) {
        const edge = resolveEdge({
          root,
          fromAbs: abs,
          fromRel,
          knownSet,
          tsPaths,
          spec,
        });
        edges.push(edge);
      }
    }),
  );

  // Stable order for deterministic output.
  edges.sort((a, b) => {
    if (a.from !== b.from) return a.from.localeCompare(b.from);
    if (a.specifier !== b.specifier) {
      return a.specifier.localeCompare(b.specifier);
    }
    return a.to.localeCompare(b.to);
  });

  for (const edge of edges) {
    pushEdge(out, edge.from, edge);
    if (edge.to.length > 0 && !edge.external) {
      pushEdge(inMap, edge.to, edge);
      files.add(edge.to);
    }
  }

  const graph: ImportGraph = {
    edges,
    out,
    in: inMap,
    files,
  };
  if (limited || python.limited) {
    graph.limited = true;
    graph.limitedReason =
      `import graph truncated to first ${maxFiles} source files; ` +
      "rankings should be treated as advisory";
  }
  return graph;
}

interface RawImportSpecifier {
  specifier: string;
  typeOnly: boolean;
  dynamic: boolean;
}

/**
 * Extract every import-like specifier from a file's source.
 *
 * Captures:
 *   - `import ... from "X"`
 *   - `import "X"` (side-effect import)
 *   - `import type ... from "X"` / `import { type Foo } from "X"`
 *   - `export ... from "X"`
 *   - `import("X")` with a string-literal X
 *
 * Skips:
 *   - `import()` with a non-literal X
 *   - `require("X")` (out of scope for the v0.6.0 graph)
 *
 * Type-only inline specifiers inside a value import still mark the *edge*
 * as a value edge — the file-level decision is "did this import contribute
 * a runtime dependency?" which is conservative for cycle detection.
 */
export function extractImportSpecifiers(
  absolutePath: string,
  source: string,
): RawImportSpecifier[] {
  const scriptKind = pickScriptKind(absolutePath);
  const sf = ts.createSourceFile(
    absolutePath,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    scriptKind,
  );
  const out: RawImportSpecifier[] = [];

  ts.forEachChild(sf, (node) => {
    // `import ... from "X"` / `import "X"`
    if (ts.isImportDeclaration(node)) {
      if (!ts.isStringLiteral(node.moduleSpecifier)) return;
      const typeOnly = node.importClause?.isTypeOnly === true;
      out.push({
        specifier: node.moduleSpecifier.text,
        typeOnly,
        dynamic: false,
      });
      return;
    }
    // `export ... from "X"`
    if (ts.isExportDeclaration(node)) {
      if (
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        out.push({
          specifier: node.moduleSpecifier.text,
          typeOnly: node.isTypeOnly === true,
          dynamic: false,
        });
      }
      return;
    }
  });

  // Dynamic `import("X")` calls can appear anywhere; do a small recursive
  // walk just for those rather than scanning every node twice in the
  // top-level pass.
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const first = n.arguments[0];
      if (first && ts.isStringLiteral(first)) {
        out.push({
          specifier: first.text,
          typeOnly: false,
          dynamic: true,
        });
      }
    }
    ts.forEachChild(n, walk);
  };
  ts.forEachChild(sf, walk);

  return out;
}

function pickScriptKind(absolutePath: string): ts.ScriptKind {
  const lower = absolutePath.toLowerCase();
  if (lower.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (lower.endsWith(".ts")) return ts.ScriptKind.TS;
  if (lower.endsWith(".jsx")) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

function resolveEdge(args: {
  root: string;
  fromAbs: string;
  fromRel: string;
  knownSet: Set<string>;
  tsPaths: TsconfigPaths | undefined;
  spec: RawImportSpecifier;
}): ImportEdge {
  const { root, fromAbs, fromRel, knownSet, tsPaths, spec } = args;
  const specifier = spec.specifier;

  // 1. Relative specifier.
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const baseDir = dirname(fromAbs);
    const targetAbs = resolveOnDisk(join(baseDir, specifier));
    if (targetAbs) {
      const rel = toRepoPath(root, targetAbs);
      return {
        from: fromRel,
        to: knownSet.has(rel) ? rel : "",
        specifier,
        external: false,
        typeOnly: spec.typeOnly,
        dynamic: spec.dynamic,
      };
    }
    return {
      from: fromRel,
      to: "",
      specifier,
      external: false,
      typeOnly: spec.typeOnly,
      dynamic: spec.dynamic,
    };
  }

  // 2. tsconfig path alias (e.g. `@/lib/foo`).
  if (tsPaths) {
    const aliasResolved = resolveTsconfigAlias({
      specifier,
      tsPaths,
      knownSet,
      root,
    });
    if (aliasResolved !== undefined) {
      return {
        from: fromRel,
        to: aliasResolved,
        specifier,
        external: false,
        typeOnly: spec.typeOnly,
        dynamic: spec.dynamic,
      };
    }
  }

  // 3. Bare module — treat as external. `node:fs` and friends fall here too.
  return {
    from: fromRel,
    to: "",
    specifier,
    external: true,
    typeOnly: spec.typeOnly,
    dynamic: spec.dynamic,
  };
}

function resolveOnDisk(candidate: string): string | undefined {
  // Direct hit.
  if (existsSync(candidate) && isFile(candidate)) return candidate;
  // NodeNext / ESM-TS convention: the specifier may end in a JS-family
  // extension even though the source file on disk is the corresponding
  // TS one (`./foo.js` → `./foo.ts`, etc.). Strip and retry with the
  // candidate extensions.
  const jsExtMatch = candidate.match(/\.(jsx?|mjs|cjs)$/);
  if (jsExtMatch) {
    const base = candidate.slice(0, -jsExtMatch[0].length);
    for (const ext of CANDIDATE_EXTENSIONS) {
      const withExt = `${base}${ext}`;
      if (existsSync(withExt) && isFile(withExt)) return withExt;
    }
  }
  // Try extensions.
  for (const ext of CANDIDATE_EXTENSIONS) {
    const withExt = `${candidate}${ext}`;
    if (existsSync(withExt) && isFile(withExt)) return withExt;
  }
  // Try `/index.<ext>`.
  for (const ext of CANDIDATE_EXTENSIONS) {
    const indexPath = join(candidate, `index${ext}`);
    if (existsSync(indexPath) && isFile(indexPath)) return indexPath;
  }
  return undefined;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function resolveTsconfigAlias(args: {
  specifier: string;
  tsPaths: TsconfigPaths;
  knownSet: Set<string>;
  root: string;
}): string | undefined {
  const { specifier, tsPaths, knownSet, root } = args;
  for (const [pattern, substitutions] of Object.entries(tsPaths.paths)) {
    const match = matchTsPattern(pattern, specifier);
    if (match === undefined) continue;
    for (const sub of substitutions) {
      const subStar = sub.includes("*") ? sub.replace("*", match) : sub;
      const candidate = isAbsolute(subStar) ? subStar : resolve(tsPaths.baseUrl, subStar);
      const resolved = resolveOnDisk(candidate);
      if (resolved) {
        const rel = toRepoPath(root, resolved);
        return knownSet.has(rel) ? rel : "";
      }
    }
    return "";
  }
  return undefined;
}

/**
 * Apply a TypeScript path-mapping pattern. Returns the captured wildcard
 * substring on a match, or `""` when the pattern has no wildcard and matched
 * exactly, or `undefined` when there was no match.
 */
function matchTsPattern(pattern: string, specifier: string): string | undefined {
  const starIdx = pattern.indexOf("*");
  if (starIdx === -1) {
    return pattern === specifier ? "" : undefined;
  }
  const prefix = pattern.slice(0, starIdx);
  const suffix = pattern.slice(starIdx + 1);
  if (!specifier.startsWith(prefix)) return undefined;
  if (!specifier.endsWith(suffix)) return undefined;
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

function loadTsconfigPaths(root: string): TsconfigPaths | undefined {
  const candidate = join(root, "tsconfig.json");
  if (!existsSync(candidate)) return undefined;
  let raw: string;
  try {
    raw = readFileSync(candidate, "utf8");
  } catch {
    return undefined;
  }
  const parsed = ts.parseConfigFileTextToJson(candidate, raw);
  if (parsed.error || !parsed.config) return undefined;
  const compilerOptions = parsed.config.compilerOptions ?? {};
  const baseUrl: string = compilerOptions.baseUrl ?? ".";
  const paths: Record<string, string[]> | undefined = compilerOptions.paths;
  if (!paths || Object.keys(paths).length === 0) return undefined;
  return {
    baseUrl: resolve(root, baseUrl),
    paths,
  };
}

function pushEdge(map: Map<string, ImportEdge[]>, key: string, edge: ImportEdge): void {
  const existing = map.get(key);
  if (existing) existing.push(edge);
  else map.set(key, [edge]);
}

function toRepoPath(root: string, abs: string): string {
  const rel = isAbsolute(abs) ? relative(root, abs) : abs;
  return rel.split(sep).join("/");
}
