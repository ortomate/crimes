/**
 * Information Architecture (IA) signal index.
 *
 * The IA index extracts deterministic, evidence-only signals from a repo —
 * it does not interpret them. Later detectors consume the index to identify
 * places where the repo tells multiple stories about the same product
 * concept (route metadata drift, duplicated navigation sources, concept
 * alias drift, missing agent context, docs-code drift).
 *
 * No semantic claim is ever made by extraction. If a value cannot be
 * carried verbatim in finding `evidence`, the index does not record it.
 */

/** Repo-relative POSIX-style path (forward slashes). */
export type RepoPath = string;

/**
 * Per-file rolled-up IA signals, keyed by repo-relative path.
 *
 * Empty arrays mean "extracted nothing for this kind on this file" — they
 * are not the same as the file not appearing in `IaIndex.files`.
 */
export interface IaFileSignals {
  file: RepoPath;
  /** Lowercased, normalised tokens derived from the file path. */
  tokens: string[];
  /** Default-export identifier name, when recoverable. */
  componentName?: string;
  /**
   * Route paths derived from convention (e.g. `/settings/billing` from
   * `src/pages/settings/billing.tsx`). Empty for non-route files.
   */
  routes: string[];
  /**
   * Labels / page titles / breadcrumb text extracted from the file. Each
   * entry carries its origin so detectors can phrase evidence accurately.
   */
  labels: IaLabelSignal[];
  /** Nav-like entries declared anywhere in this file. */
  navEntries: IaNavSignal[];
  /** Permission-like strings observed in the file. */
  permissions: IaPermissionSignal[];
  /** Whether this file looks like a nav source (has any nav literal). */
  isNavSource: boolean;
}

export interface IaLabelSignal {
  value: string;
  line: number;
  /** AST context that produced the literal. */
  kind: "jsx_title" | "document_title" | "metadata_title" | "use_title" | "jsx_label";
  /** Tag / hook / property that surfaced the literal. */
  source?: string;
}

export interface IaNavSignal {
  /** Identifier the array is assigned to, if recoverable. */
  identifier?: string;
  /** Line of the array literal in the source file. */
  line: number;
  entries: IaNavEntry[];
}

export interface IaNavEntry {
  destination?: string;
  label?: string;
  /** Other string-typed attributes (icon, role, permission). */
  attributes: Record<string, string>;
}

export interface IaPermissionSignal {
  value: string;
  line: number;
  /** Heuristic origin: bare role name vs dotted permission. */
  kind: "role" | "dotted";
}

export interface IaRouteSignal {
  file: RepoPath;
  /** Route path string, e.g. `/settings/billing`. */
  routePath: string;
  /** Default-export name in the file, when recoverable. */
  componentName?: string;
  /** Titles extracted from the file. */
  titles: string[];
  /** All labels extracted from the file. */
  labels: string[];
}

export interface IaDocHeading {
  text: string;
  level: number;
  line: number;
}

export interface IaDocLink {
  /** Raw link target as it appears in the markdown. */
  target: string;
  line: number;
  /** True if the link is local (not http/mailto/anchor). */
  isLocal: boolean;
  /** Resolved repo-relative path for local links (if it resolves). */
  resolved?: RepoPath;
  /** True when the link is local AND its target does not exist on disk. */
  brokenLocal: boolean;
}

export interface IaDocFencedCommand {
  /** First non-blank line inside the fence, stripped. */
  command: string;
  line: number;
  /** Whether the surrounding paragraph marks this command as deferred/unimplemented. */
  deferred: boolean;
}

export interface IaDocSignal {
  file: RepoPath;
  headings: IaDocHeading[];
  links: IaDocLink[];
  fencedCommands: IaDocFencedCommand[];
}

export interface IaAgentInventory {
  /** Repo-relative path to AGENTS.md if present. */
  agentsMdPath?: RepoPath;
  /** Repo-relative path to root CLAUDE.md if present. */
  claudeMdPath?: RepoPath;
  /** All discovered .claude/skills/<name>/SKILL.md paths. */
  claudeSkills: RepoPath[];
  /** All discovered .agents/skills/<name>/SKILL.md paths. */
  codexSkills?: RepoPath[];
  /** Bin names declared by the repo-root package.json (if present). */
  declaredBins: string[];
  /** Distinct `crimes <subcommand>` / bin-name commands referenced from agent docs. */
  referencedCommands: string[];
}

export interface IaConceptAliasGroup {
  /** Stable id, e.g. `"team"`. */
  id: string;
  /** Lowercased alias tokens that count as part of the group. */
  aliases: string[];
  /** Optional preferred form for suggested-action copy. */
  preferred?: string;
}

export interface IaIndex {
  /** Repo-relative path of the scanned root (POSIX-style). */
  root: string;
  /** Per-file IA signals, keyed by repo-relative path. */
  files: Record<RepoPath, IaFileSignals>;
  /** Route files discovered by path convention. */
  routes: IaRouteSignal[];
  /** Files that contained at least one nav literal. */
  navSources: { file: RepoPath; entries: IaNavSignal[] }[];
  /** Markdown documents walked (root *.md + everything under docs/). */
  docs: IaDocSignal[];
  /** Agent-context inventory. */
  agentContext: IaAgentInventory;
  /** The alias-group catalogue used for this build (for evidence reproducibility). */
  aliasGroups: IaConceptAliasGroup[];
}
