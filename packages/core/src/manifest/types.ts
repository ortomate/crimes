/**
 * Package-manifest and lockfile inventory types.
 *
 * Consumed by `dependency_provenance_gap`, which answers one question:
 * *can this repo account for every package it imports?* Not "is this
 * package safe" — that would need a registry, a network call, and a
 * judgement this tool has no business making.
 */

/** Which manifest section a dependency was declared in. */
export type DependencyKind =
  | "dependencies"
  | "devDependencies"
  | "peerDependencies"
  | "optionalDependencies"
  | "bundledDependencies";

/** How a version specifier constrains what gets installed. */
export type SpecifierShape =
  | "range"
  | "exact"
  | "wildcard"
  | "git"
  | "url"
  | "file"
  | "link"
  | "workspace"
  | "npm_alias"
  | "catalog";

export interface DeclaredDependency {
  name: string;
  /** Raw specifier as written in the manifest. */
  specifier: string;
  shape: SpecifierShape;
  kind: DependencyKind;
  /** Repo-relative path of the declaring `package.json`. */
  manifest: string;
  /** 1-based line of the declaration in the manifest, when recoverable. */
  line: number;
}

export interface PackageManifest {
  /** Repo-relative POSIX path of the `package.json`. */
  file: string;
  /**
   * True when this manifest is part of the repo's workspace — the root
   * manifest, or one whose directory a declared workspace glob covers.
   *
   * A manifest outside the workspace (a sample app under `examples/`, an
   * eval fixture, a vendored project) has its own dependency story and
   * is deliberately *not* compared against the root lockfile: it was
   * never installed by it.
   */
  inWorkspace: boolean;
  /** Directory the manifest governs, repo-relative. `""` for the root. */
  dir: string;
  name?: string;
  private: boolean;
  /** Every declared dependency across every section. */
  dependencies: DeclaredDependency[];
  /** Workspace globs declared here (`workspaces` field). */
  workspaceGlobs: string[];
}

/** A lockfile the repo commits, and the package names it pins. */
export interface Lockfile {
  file: string;
  manager: "pnpm" | "npm" | "yarn" | "bun";
  /** Package names present anywhere in the lock. */
  names: Set<string>;
  /**
   * True when the file was found but produced no names — a malformed or
   * unrecognised lock. The detector must not report "everything is
   * missing from the lockfile" in that case.
   */
  unparsed: boolean;
}

export interface ManifestIndex {
  manifests: PackageManifest[];
  lockfiles: Lockfile[];
  /** Union of workspace package names declared anywhere in the repo. */
  workspaceNames: Set<string>;
  /** Directories governed by a manifest, longest-first for lookup. */
  manifestDirs: string[];
  /** True when the repo declares workspaces (pnpm-workspace.yaml or `workspaces`). */
  isMonorepo: boolean;
  /** Every workspace glob declared, from any source. Sorted. */
  workspaceGlobs: string[];
}
