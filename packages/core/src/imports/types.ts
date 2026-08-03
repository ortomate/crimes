/**
 * Repo-wide import graph types.
 *
 * Built once per scan, attached to `DetectorContext.imports`, and consumed
 * by dependency-graph detectors (`circular_dependency`, `deep_import`,
 * `high_fan_in_fan_out`), the `layer_violation` detector, and the
 * `scores.blast_radius` calculator.
 *
 * Paths are repo-relative POSIX (forward slashes).
 */
export interface ImportEdge {
  /** Repo-relative POSIX path of the source file. */
  from: string;
  /**
   * Repo-relative POSIX path of the import target. Empty string when the
   * specifier is external (a bare module like `"react"` or `"node:fs"`)
   * or could not be resolved on disk.
   */
  to: string;
  /** Raw specifier as written in source (`"./foo"`, `"@/lib/bar"`, …). */
  specifier: string;
  /** True when the specifier is a bare module (`"react"`, `"node:fs"`). */
  external: boolean;
  /** True for `import type ... from "X"` and `export type ... from "X"`. */
  typeOnly: boolean;
  /** True when the edge came from a string-literal `import("X")` call. */
  dynamic: boolean;
}

export interface ImportGraph {
  /** All edges, in stable order (by `from`, then by `specifier`). */
  edges: ImportEdge[];
  /** Repo-relative path → out-edges that resolved to another in-repo file. */
  out: Map<string, ImportEdge[]>;
  /** Repo-relative path → in-edges from in-repo files. */
  in: Map<string, ImportEdge[]>;
  /** Every file the graph knows about (sources + resolved targets). */
  files: Set<string>;
  /**
   * True when the graph was truncated because the file set exceeded the
   * configured budget. Detectors should treat their findings as advisory
   * when this is set. Surfaced to consumers via `ScanReport.imports_limited`.
   */
  limited?: boolean;
  /** Short, human-readable reason. Only set when `limited` is true. */
  limitedReason?: string;
  /**
   * Path-alias patterns declared by any `tsconfig.json` in the repo,
   * e.g. `@components/*`. Consumers use this to tell an alias from a
   * package name; it is not enough to resolve one to a file.
   */
  aliasPatterns?: string[];
}
