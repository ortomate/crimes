import { readFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { discoverFiles } from "../discovery/files.js";
import type {
  DeclaredDependency,
  DependencyKind,
  Lockfile,
  ManifestIndex,
  PackageManifest,
  SpecifierShape,
} from "./types.js";

/**
 * Build the manifest + lockfile inventory.
 *
 * Entirely local: reads files off disk, never contacts a registry. That
 * is a product constraint, not an implementation shortcut — a
 * "dependency provenance" detector that phones home would break the one
 * promise this tool makes about running anywhere.
 */

const DEPENDENCY_SECTIONS: readonly DependencyKind[] = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

/** Lockfiles this inventory can read, in the order they're preferred. */
const LOCKFILES: ReadonlyArray<{ name: string; manager: Lockfile["manager"] }> = [
  { name: "pnpm-lock.yaml", manager: "pnpm" },
  { name: "package-lock.json", manager: "npm" },
  { name: "yarn.lock", manager: "yarn" },
  { name: "bun.lock", manager: "bun" },
  { name: "bun.lockb", manager: "bun" },
];

export interface BuildManifestIndexOptions {
  root: string;
}

export async function buildManifestIndex(
  options: BuildManifestIndexOptions,
): Promise<ManifestIndex> {
  const manifestPaths = await discoverFiles({
    root: options.root,
    include: ["**/package.json"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/.next/**",
      "**/out/**",
      "**/coverage/**",
    ],
  });

  const draft: PackageManifest[] = [];
  for (const absolutePath of [...manifestPaths].sort()) {
    const manifest = await readManifest(options.root, absolutePath);
    if (manifest) draft.push(manifest);
  }
  draft.sort((a, b) => a.file.localeCompare(b.file));

  const lockfiles: Lockfile[] = [];
  for (const { name, manager } of LOCKFILES) {
    const lock = await readLockfile(options.root, join(options.root, name), manager);
    if (lock) lockfiles.push(lock);
  }

  const pnpmWorkspace = await readPnpmWorkspace(
    join(options.root, "pnpm-workspace.yaml"),
  );
  const globs = [
    ...new Set([
      ...pnpmWorkspace,
      ...draft.flatMap((m) => (m.dir === "" ? m.workspaceGlobs : [])),
    ]),
  ].sort();
  const matchers = globs.map(globToRegExp);

  const manifests = draft.map((manifest) => ({
    ...manifest,
    inWorkspace: manifest.dir === "" || matchers.some((re) => re.test(manifest.dir)),
  }));

  const workspaceNames = new Set<string>();
  for (const manifest of manifests) {
    // Only workspace members contribute an internal package name. A
    // sample app named `react` under `examples/` must not make every
    // real `react` dependency look internal.
    if (manifest.inWorkspace && manifest.name !== undefined) {
      workspaceNames.add(manifest.name);
    }
  }

  const declaresWorkspaces = globs.length > 0;

  return {
    manifests,
    lockfiles,
    workspaceNames,
    // Longest first so "which manifest governs this file?" resolves to
    // the nearest one rather than the root.
    manifestDirs: manifests.map((m) => m.dir).sort((a, b) => b.length - a.length),
    isMonorepo: declaresWorkspaces || manifests.length > 1,
    workspaceGlobs: globs,
  };
}

/**
 * Compile a workspace glob to a regular expression matching a
 * repo-relative directory.
 *
 * Workspace globs use a tiny, well-defined subset: `packages/*`,
 * `apps/**`, `evals/runner`. `*` matches one path segment, `**` matches
 * any number. Hand-compiling that subset is cheaper and more predictable
 * than pulling a matcher in for one field, and an unrecognised construct
 * degrades to a literal — which fails to match rather than
 * over-matching.
 */
function globToRegExp(glob: string): RegExp {
  const normalised = glob.replace(/\/+$/, "");
  let pattern = "";
  for (let i = 0; i < normalised.length; i++) {
    const ch = normalised[i]!;
    if (ch === "*") {
      if (normalised[i + 1] === "*") {
        pattern += "[^\\0]*";
        i += 1;
        // `**/` should also match zero segments.
        if (normalised[i + 1] === "/") i += 1;
        continue;
      }
      pattern += "[^/]*";
      continue;
    }
    pattern += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${pattern}$`);
}

async function readManifest(
  root: string,
  absolutePath: string,
): Promise<PackageManifest | undefined> {
  let raw: string;
  try {
    raw = await readFile(absolutePath, "utf8");
  } catch {
    return undefined;
  }

  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    parsed = value as Record<string, unknown>;
  } catch {
    // A malformed manifest is skipped, not fatal. Reporting "every import
    // is undeclared" because a trailing comma broke the JSON would be
    // worse than saying nothing.
    return undefined;
  }

  const file = toRepoPath(root, absolutePath);
  const dir =
    toRepoPath(root, dirname(absolutePath)) === "."
      ? ""
      : toRepoPath(root, dirname(absolutePath));
  const lines = raw.split(/\r?\n/);

  const dependencies: DeclaredDependency[] = [];
  for (const kind of DEPENDENCY_SECTIONS) {
    const section = parsed[kind];
    if (typeof section !== "object" || section === null || Array.isArray(section)) {
      continue;
    }
    for (const [name, value] of Object.entries(section as Record<string, unknown>)) {
      if (typeof value !== "string") continue;
      dependencies.push({
        name,
        specifier: value,
        shape: classifySpecifier(value),
        kind,
        manifest: file,
        line: findDeclarationLine(lines, name, value),
      });
    }
  }

  // `bundledDependencies` is an array of names with no specifier.
  const bundled = parsed.bundledDependencies ?? parsed.bundleDependencies;
  if (Array.isArray(bundled)) {
    for (const name of bundled) {
      if (typeof name !== "string") continue;
      dependencies.push({
        name,
        specifier: "(bundled)",
        shape: "range",
        kind: "bundledDependencies",
        manifest: file,
        line: findDeclarationLine(lines, name, undefined),
      });
    }
  }

  dependencies.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind.localeCompare(b.kind),
  );

  const workspaces = parsed.workspaces;
  const workspaceGlobs: string[] = Array.isArray(workspaces)
    ? workspaces.filter((w): w is string => typeof w === "string")
    : typeof workspaces === "object" &&
        workspaces !== null &&
        Array.isArray((workspaces as { packages?: unknown }).packages)
      ? (workspaces as { packages: unknown[] }).packages.filter(
          (w): w is string => typeof w === "string",
        )
      : [];

  const manifest: PackageManifest = {
    file,
    // Resolved by the caller once every manifest and every workspace
    // glob is known; a manifest cannot answer this about itself.
    inWorkspace: false,
    dir,
    private: parsed.private === true,
    dependencies,
    workspaceGlobs,
  };
  if (typeof parsed.name === "string") manifest.name = parsed.name;
  return manifest;
}

/**
 * Classify a version specifier.
 *
 * The shapes that matter to the detector are the ones that make an
 * install non-reproducible: a mutable git branch, a bare URL, and a
 * wildcard all resolve to something different tomorrow.
 */
export function classifySpecifier(specifier: string): SpecifierShape {
  const value = specifier.trim();
  if (value === "*" || value === "" || value === "latest" || value === "x") {
    return "wildcard";
  }
  if (value.startsWith("workspace:")) return "workspace";
  if (value.startsWith("catalog:")) return "catalog";
  if (value.startsWith("npm:")) return "npm_alias";
  if (value.startsWith("file:")) return "file";
  if (value.startsWith("link:")) return "link";
  if (
    value.startsWith("git+") ||
    value.startsWith("git:") ||
    value.startsWith("github:") ||
    value.startsWith("gitlab:") ||
    value.startsWith("bitbucket:") ||
    /^[\w-]+\/[\w.-]+(#.*)?$/.test(value)
  ) {
    return "git";
  }
  if (/^https?:\/\//.test(value)) return "url";
  if (/^\d+\.\d+\.\d+/.test(value)) return "exact";
  return "range";
}

/**
 * Is a git specifier pinned to an immutable commit?
 *
 * `#semver:` ranges and branch names re-resolve on every install;
 * a 40-hex commit does not.
 */
export function isPinnedGitSpecifier(specifier: string): boolean {
  const hash = specifier.indexOf("#");
  if (hash === -1) return false;
  const ref = specifier.slice(hash + 1);
  return /^[0-9a-f]{7,40}$/i.test(ref);
}

/**
 * Best-effort 1-based line of a dependency declaration.
 *
 * JSON.parse discards positions, and pulling in a position-preserving
 * parser for one evidence field is not worth the dependency. The search
 * is anchored on the quoted key so it cannot match a substring of some
 * other value; a miss returns line 1, which is still a valid anchor.
 */
function findDeclarationLine(
  lines: string[],
  name: string,
  specifier: string | undefined,
): number {
  const key = `"${name}"`;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.includes(key)) continue;
    if (specifier === undefined || line.includes(`"${specifier}"`)) return i + 1;
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.includes(key)) return i + 1;
  }
  return 1;
}

/* ------------------------------------------------------------------ *
 * Lockfiles
 * ------------------------------------------------------------------ */

async function readLockfile(
  root: string,
  absolutePath: string,
  manager: Lockfile["manager"],
): Promise<Lockfile | undefined> {
  let raw: string;
  try {
    raw = await readFile(absolutePath, "utf8");
  } catch {
    return undefined;
  }

  const file = toRepoPath(root, absolutePath);
  // `bun.lockb` is binary; its presence is a fact worth recording, but
  // its contents are not readable without Bun's own parser.
  if (absolutePath.endsWith(".lockb")) {
    return { file, manager, names: new Set(), unparsed: true };
  }

  const names =
    manager === "npm"
      ? parseNpmLock(raw)
      : manager === "yarn"
        ? parseYarnLock(raw)
        : parsePnpmLock(raw);

  return { file, manager, names, unparsed: names.size === 0 };
}

/**
 * `pnpm-lock.yaml`. Every version of the format spells a package entry as
 * `<name>@<version>` somewhere in a key, whether under `packages:`
 * (v5-v8, leading `/`) or `snapshots:` (v9). Extracting names by pattern
 * rather than by walking a YAML tree keeps this robust across format
 * revisions and avoids adding a YAML dependency for one field.
 */
function parsePnpmLock(raw: string): Set<string> {
  const names = new Set<string>();
  const entry =
    /(?:^|[\s/'"])(@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*|[a-z0-9][\w.-]*)@[\d^~><=*]/gim;
  for (const match of raw.matchAll(entry)) {
    const name = match[1];
    if (name !== undefined && name.length > 0) names.add(name);
  }
  return names;
}

/** `package-lock.json`, both the v1 `dependencies` and v2+ `packages` trees. */
function parseNpmLock(raw: string): Set<string> {
  const names = new Set<string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return names;
  }
  if (typeof parsed !== "object" || parsed === null) return names;
  const root = parsed as Record<string, unknown>;

  const packages = root.packages;
  if (typeof packages === "object" && packages !== null) {
    for (const key of Object.keys(packages as Record<string, unknown>)) {
      // Keys are install paths: `node_modules/foo`,
      // `node_modules/foo/node_modules/@scope/bar`. The package name is
      // everything after the final `node_modules/`.
      const marker = key.lastIndexOf("node_modules/");
      if (marker === -1) continue;
      const name = key.slice(marker + "node_modules/".length);
      if (name.length > 0) names.add(name);
    }
  }

  const collectV1 = (node: unknown, depth: number): void => {
    if (depth > 12) return;
    if (typeof node !== "object" || node === null) return;
    const deps = (node as Record<string, unknown>).dependencies;
    if (typeof deps !== "object" || deps === null) return;
    for (const [name, value] of Object.entries(deps as Record<string, unknown>)) {
      names.add(name);
      collectV1(value, depth + 1);
    }
  };
  collectV1(root, 0);

  return names;
}

/** `yarn.lock` (v1 and berry). Entry headers are `name@range:` lines. */
function parseYarnLock(raw: string): Set<string> {
  const names = new Set<string>();
  for (const rawLine of raw.split(/\r?\n/)) {
    // Entry headers start at column 0 and end in `:`.
    if (rawLine.length === 0 || /^\s/.test(rawLine)) continue;
    if (!rawLine.trimEnd().endsWith(":")) continue;
    const header = rawLine.trimEnd().slice(0, -1);
    for (const part of header.split(",")) {
      const spec = part.trim().replace(/^["']|["']$/g, "");
      if (spec.length === 0) continue;
      // The name is everything before the LAST `@` that isn't the scope
      // marker at position 0.
      const at = spec.lastIndexOf("@");
      if (at <= 0) continue;
      const name = spec.slice(0, at);
      if (name.length > 0) names.add(name);
    }
  }
  return names;
}

async function readPnpmWorkspace(absolutePath: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(absolutePath, "utf8");
  } catch {
    return [];
  }
  // `packages:` followed by `- "glob"` entries. Line-based rather than
  // YAML-parsed for the same reason as the lockfile: one field is not
  // worth a dependency.
  const globs: string[] = [];
  let inPackages = false;
  for (const rawLine of raw.split(/\r?\n/)) {
    if (/^packages:\s*$/.test(rawLine)) {
      inPackages = true;
      continue;
    }
    if (inPackages && /^\S/.test(rawLine)) {
      inPackages = false;
      continue;
    }
    if (!inPackages) continue;
    const match = rawLine.match(/^\s*-\s*["']?([^"'#]+?)["']?\s*$/);
    if (match?.[1]) globs.push(match[1]);
  }
  return globs;
}

function toRepoPath(root: string, abs: string): string {
  const rel = abs.startsWith(root) ? relative(root, abs) : abs;
  const posix = rel.split(sep).join("/");
  return posix.length === 0 ? "." : posix;
}
