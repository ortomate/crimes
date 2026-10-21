import type { AnalysisInputs } from "../analysis-inputs.js";
/**
 * JSP contribution to the repo-wide import graph.
 *
 * Same contract as `swift.ts`: the rules live in `@crimes/language-jsp`
 * (`resolveJspProject`), and this module supplies what they need from
 * disk — parsed templates and descriptors, each web root's `web.xml`,
 * file and directory existence, and the Java class index the JVM pass
 * already built.
 *
 * A web root is a directory holding `WEB-INF`, or a library's
 * `META-INF/resources`. Found from the templates' own ancestors, so a
 * repository without templates costs nothing.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  type JspResolution,
  type ParsedJspFile,
  type ParsedTld,
  type ParsedWebXml,
  parseJspFile,
  parseTld,
  parseWebXml,
  resolveJspProject,
} from "@crimes/language-jsp";
import { type CoverageWarningLog, errnoOf } from "../discovery/coverage-warnings.js";
import { structuredSkipFor } from "../util/structured-skip.js";
import type { ImportEdge } from "./types.js";

const TEMPLATE_RE = /\.(?:jsp|jspf|tag)$/i;
const TLD_RE = /\.tld$/i;
const LIBRARY_ROOT_RE = /(?:^|\/)META-INF\/resources$/;

export interface BuildJspImportEdgesOptions {
  inputs?: AnalysisInputs;
  root: string;
  files: string[];
  maxFiles?: number;
  warnings?: CoverageWarningLog;
  /** Fully qualified Java class → declaring repo path. */
  javaClasses?: ReadonlyMap<string, string>;
}

export interface JspImportEdgeResult {
  edges: ImportEdge[];
  files: string[];
  limited: boolean;
  droppedFiles: number;
  /** Everything the resolver found, for the JSP detectors. */
  resolution: JspResolution;
}

const EMPTY: JspResolution = { references: [], dangling: [], contractBreaks: [] };

export async function buildJspImportEdges(
  options: BuildJspImportEdgesOptions,
): Promise<JspImportEdgeResult> {
  const root = resolve(options.root);
  const maxFiles = options.maxFiles ?? 5000;
  const skip = structuredSkipFor(root);
  const all = options.files.filter(
    (abs) => (TEMPLATE_RE.test(abs) || TLD_RE.test(abs)) && !skip(toRepoPath(root, abs)),
  );
  const considered = all.slice(0, maxFiles);
  if (considered.length === 0) {
    return { edges: [], files: [], limited: false, droppedFiles: 0, resolution: EMPTY };
  }

  const files = new Map<string, ParsedJspFile>();
  const tlds = new Map<string, ParsedTld>();
  await Promise.all(
    considered.map(async (abs) => {
      const file = toRepoPath(root, abs);
      let source: string;
      try {
        source = options.inputs
          ? await options.inputs.read(abs)
          : await readFile(abs, "utf8");
      } catch (err) {
        options.warnings?.record("files_unreadable", errnoOf(err), { file });
        return;
      }
      if (TLD_RE.test(abs)) {
        tlds.set(
          file,
          options.inputs ? options.inputs.tld(abs, source) : parseTld(source),
        );
      } else {
        files.set(
          file,
          options.inputs
            ? options.inputs.jsp(abs, source)
            : parseJspFile({ absolutePath: abs, source }),
        );
      }
    }),
  );

  const disk = diskFacts(root);
  const webRoots = new Set<string>();
  const rootOf = new Map<string, string | undefined>();
  for (const file of [...files.keys(), ...tlds.keys()]) {
    const found = disk.webRootFor(file);
    rootOf.set(file, found);
    if (found !== undefined) webRoots.add(found);
  }
  const webXml = new Map<string, ParsedWebXml>();
  for (const webRoot of webRoots) {
    const path = join(root, webRoot, "WEB-INF", "web.xml");
    if (!existsSync(path)) continue;
    try {
      webXml.set(webRoot, parseWebXml(readFileSync(path, "utf8")));
    } catch (err) {
      options.warnings?.record("files_unreadable", errnoOf(err), {
        file: toRepoPath(root, path),
      });
    }
  }

  const resolution = resolveJspProject({
    files,
    tlds,
    webXml,
    webRoots: [...webRoots].sort(),
    webRootOf: (file) => (rootOf.has(file) ? rootOf.get(file) : disk.webRootFor(file)),
    isFile: disk.isFile,
    isDirectory: disk.isDirectory,
    javaClass: (name) => options.javaClasses?.get(name),
  });

  const edges: ImportEdge[] = resolution.references.map((r) => ({
    from: r.from,
    to: r.to,
    specifier: r.specifier,
    external: false,
    typeOnly: false,
    dynamic: false,
  }));
  return {
    edges,
    files: [...files.keys(), ...tlds.keys()].sort(),
    limited: all.length > considered.length,
    droppedFiles: all.length - considered.length,
    resolution,
  };
}

/** Cached existence checks, confined to the repository. */
function diskFacts(root: string): {
  isFile(path: string): boolean;
  isDirectory(path: string): boolean;
  webRootFor(file: string): string | undefined;
} {
  const kinds = new Map<string, "file" | "dir" | "none">();
  const kind = (path: string): "file" | "dir" | "none" => {
    const cached = kinds.get(path);
    if (cached !== undefined) return cached;
    let found: "file" | "dir" | "none" = "none";
    if (!path.startsWith("..") && !isAbsolute(path)) {
      try {
        const stat = statSync(join(root, path));
        found = stat.isFile() ? "file" : stat.isDirectory() ? "dir" : "none";
      } catch {
        found = "none";
      }
    }
    kinds.set(path, found);
    return found;
  };
  const roots = new Map<string, string | undefined>();
  const webRootFor = (file: string): string | undefined => {
    const chain: string[] = [];
    let found: string | undefined;
    for (let dir = parentOf(file); dir !== undefined; dir = parentOf(dir)) {
      if (roots.has(dir)) {
        found = roots.get(dir);
        break;
      }
      chain.push(dir);
      if (
        LIBRARY_ROOT_RE.test(dir) ||
        kind(dir === "" ? "WEB-INF" : `${dir}/WEB-INF`) === "dir"
      ) {
        found = dir;
        break;
      }
    }
    for (const dir of chain) {
      // A directory below the root it found shares that root; the root
      // itself is its own.
      roots.set(dir, found);
    }
    return found;
  };
  return {
    isFile: (path) => kind(path) === "file",
    isDirectory: (path) => kind(path) === "dir",
    webRootFor,
  };
}

/** `a/b/c.jsp` → `a/b` → `a` → `""` → undefined. */
function parentOf(path: string): string | undefined {
  if (path === "") return undefined;
  const d = dirname(path);
  return d === "." ? "" : d;
}

function toRepoPath(root: string, abs: string): string {
  const rel = isAbsolute(abs) ? relative(root, abs) : abs;
  return rel.split(sep).join("/");
}
