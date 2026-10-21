/**
 * Resolve what LESS files reach: the files they import, and the files
 * that define the variables and mixins they use.
 *
 * Pure: the file system arrives through {@link LessProject}. Paths are
 * repo-relative with forward slashes.
 *
 * Imports resolve as `lessc` resolves them by default: relative to the
 * importing file, with `.less` added when the path has no extension.
 * `~package` imports, absolute paths, URLs and interpolated paths are
 * outside the repository's control and are skipped.
 *
 * Usage edges exist because a partial compiled inside a bundle uses
 * names the bundle's root imported before it, and never imports them
 * itself. A name a file defines itself draws no edge (its own definition
 * is in scope). A name defined in more than {@link MAX_DEFINERS} files
 * draws none either: at that point it is a convention — every theme
 * defines `@primary` — and an edge to each definer invents coupling.
 */

import { dirname, extname, join, normalize } from "node:path/posix";
import type { ParsedLessFile } from "./types.js";

const MAX_DEFINERS = 3;

export interface LessProject {
  files: ReadonlyMap<string, ParsedLessFile>;
  isFile(path: string): boolean;
}

export type LessReferenceKind = "import" | "variable" | "mixin";

export interface LessReference {
  from: string;
  to: string;
  /** The import path as written, or `@name` / `.name`. */
  specifier: string;
  kind: LessReferenceKind;
}

export interface LessResolution {
  references: LessReference[];
  /** Imports of repository paths that do not exist. */
  unresolvedImports: { file: string; line: number; path: string }[];
}

export function resolveLessProject(project: LessProject): LessResolution {
  const files = [...project.files.keys()].sort();
  const references = new Map<string, LessReference>();
  const unresolvedImports: LessResolution["unresolvedImports"] = [];
  const add = (ref: LessReference): void => {
    if (ref.from === ref.to) return;
    const key = `${ref.from}\0${ref.to}`;
    if (!references.has(key)) references.set(key, ref);
  };

  const variableDefiners = new Map<string, string[]>();
  const mixinDefiners = new Map<string, string[]>();
  for (const file of files) {
    const parsed = project.files.get(file)!;
    for (const name of new Set(parsed.variables.map((v) => v.name))) {
      push(variableDefiners, name, file);
    }
    for (const name of new Set(parsed.mixins.map((m) => m.name)))
      push(mixinDefiners, name, file);
  }

  for (const file of files) {
    const parsed = project.files.get(file)!;
    for (const imp of parsed.imports) {
      if (isExternal(imp.path)) continue;
      const found = resolveImport(project, file, imp.path);
      if (found !== undefined)
        add({ from: file, to: found, specifier: imp.path, kind: "import" });
      else unresolvedImports.push({ file, line: imp.line, path: imp.path });
    }
    const ownVariables = new Set(parsed.variables.map((v) => v.name));
    for (const name of parsed.variableRefs) {
      if (ownVariables.has(name)) continue;
      const definers = variableDefiners.get(name);
      if (definers === undefined || definers.length > MAX_DEFINERS) continue;
      for (const to of definers)
        add({ from: file, to, specifier: `@${name}`, kind: "variable" });
    }
    const ownMixins = new Set(parsed.mixins.map((m) => m.name));
    for (const name of parsed.mixinCalls) {
      if (ownMixins.has(name)) continue;
      const definers = mixinDefiners.get(name);
      if (definers === undefined || definers.length > MAX_DEFINERS) continue;
      for (const to of definers)
        add({ from: file, to, specifier: `.${name}`, kind: "mixin" });
    }
  }

  return {
    references: [...references.values()].sort(
      (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
    ),
    unresolvedImports,
  };
}

function isExternal(path: string): boolean {
  return (
    path.startsWith("~") ||
    path.startsWith("/") ||
    /^[a-z][\w+.-]*:/i.test(path) ||
    path.includes("@{")
  );
}

function resolveImport(
  project: LessProject,
  from: string,
  path: string,
): string | undefined {
  const ext = extname(path).toLowerCase();
  const base = join(dirname(from), path);
  const candidates = ext === ".less" || ext === ".css" ? [base] : [`${base}.less`, base];
  for (const c of candidates) {
    const normal = normalize(c);
    if (normal.startsWith("../")) continue;
    if (project.isFile(normal)) return normal;
  }
  return undefined;
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
