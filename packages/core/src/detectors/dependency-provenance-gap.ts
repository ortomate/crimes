import { z } from "zod";
import { isBuiltin } from "node:module";
import type { UniversalDetector, UniversalDetectorContext } from "../detector.js";
import type { PreFinding as Finding } from "../finding.js";
import type { ImportEdge } from "../imports/types.js";
import type {
  DeclaredDependency,
  ManifestIndex,
  PackageManifest,
} from "../manifest/types.js";
import { isPinnedGitSpecifier } from "../manifest/build.js";
import { ConfidenceLadder, SeverityLadder } from "../scoring/confidence.js";
import { classifyScope } from "../util/scope-class.js";

/**
 * Phantom Accomplice — imports and dependencies this repository cannot
 * account for.
 *
 * ## Scope: local provenance only
 *
 * This detector performs **no registry lookups**. It never claims a
 * package is malicious, hallucinated, abandoned, typo-squatted, or
 * unknown to npm — those are claims about the world, and answering them
 * would require the network access this tool promises not to use. Every
 * finding is a statement about *this repository's own records*:
 *
 *  - an external module is imported but no applicable `package.json`
 *    declares it
 *  - a declared dependency has no entry in the committed lockfile
 *  - a dependency points at a mutable git branch or a bare URL, so two
 *    installs can produce different code
 *  - a version specifier is a wildcard, so the resolved version is
 *    whatever the registry served that day
 *  - a `file:` / `link:` dependency crosses out of the repository
 *
 * ## Monorepo handling
 *
 * Every `package.json` in the tree is inventoried. An import resolves
 * against the nearest enclosing manifest, then walks up through parent
 * manifests to the root — which is how both pnpm workspaces and npm
 * hoisting actually behave. Workspace package names are recognised as
 * internal and never reported as undeclared.
 *
 * ## What is excluded
 *
 * Node built-ins (with and without the `node:` prefix), relative and
 * absolute-path imports, TypeScript path aliases, subpath imports
 * (`#internal/*`), deep subpaths of a declared package
 * (`lodash/fp` counts as `lodash`), scoped-package subpaths, and
 * type-only imports of `@types/*` packages. Test and fixture files may
 * import dev dependencies freely.
 */

const optionsSchema = z
  .object({
    /** Report imports with no declaring manifest. Default true. */
    reportUndeclaredImports: z.boolean().optional(),
    /** Report declared dependencies missing from the lockfile. Default true. */
    reportMissingFromLock: z.boolean().optional(),
    /** Report mutable git / URL / wildcard specifiers. Default true. */
    reportUnpinnedSpecifiers: z.boolean().optional(),
    /** Package names to treat as always available (globals, ambient types). */
    allowedPackages: z.array(z.string().min(1)).optional(),
  })
  .strict();

type Options = z.infer<typeof optionsSchema>;

const MAX_FINDINGS = 8;

/**
 * Specifier prefixes that are never a package: relative paths, absolute
 * paths, URLs, Node's subpath-import protocol, and data URIs.
 *
 * The `(\/|$)` matters. Requiring a trailing slash excluded `./x` and
 * `../x` while letting the bare directory specifiers `.` and `..`
 * through — which is how cal.com came to be accused of depending on
 * undeclared packages named `.` and `..`.
 */
const NON_PACKAGE_RE = /^(\.{1,2}(\/|$)|\/|#|[a-z][a-z0-9+.-]*:)/i;

/**
 * Path-alias shapes that resolve through tsconfig / bundler config
 * rather than through `node_modules`. Reporting these as undeclared
 * packages would be wrong in most TypeScript repositories.
 */
const PATH_ALIAS_RE = /^(@\/|~\/|~[a-z]|\$[a-z]|src\/|app\/)/i;

export const dependencyProvenanceGapDetector: UniversalDetector = {
  id: "dependency_provenance_gap",
  name: "Phantom Accomplice",
  description:
    "Flags external imports with no declaring package.json, declared " +
    "dependencies absent from the lockfile, and dependency specifiers " +
    "that resolve differently on different days (mutable git refs, bare " +
    "URLs, wildcards).",
  whyItMatters:
    "A dependency the repository cannot account for is a dependency " +
    "nobody reviewed. An import with no manifest entry works on the " +
    "machine where it was written — hoisted from a transitive dependency " +
    "— and fails on a clean install. A branch or wildcard specifier means " +
    "two installs of the same commit can produce different code, which " +
    "makes every other guarantee in CI conditional. Agents introduce " +
    "these routinely: an import is added to satisfy a compile error " +
    "without the manifest being touched.",

  pack: "universal",
  optionsSchema,

  run(ctx) {
    const manifest = ctx.manifest;
    const imports = ctx.imports;
    if (!manifest || manifest.manifests.length === 0) return [];

    // Repo-level finding, emitted once per scan.
    //
    // Two different files are involved and it matters which is which.
    // `package.json` is not in the scan's include globs, so this detector
    // never runs *on* a manifest — emission is gated on the same
    // lexicographically-first source file the other repo-level detectors
    // use. The finding's `file`, however, points at the manifest, because
    // that is what a reader opens and what the fingerprint should key on.
    if (!isRepoAnchorFile(ctx)) return [];
    const anchor = anchorManifest(manifest);
    if (anchor === undefined) return [];

    const options = readOptions(ctx.config);
    const allowed = new Set((options.allowedPackages ?? []).map((p) => p.toLowerCase()));

    const findings: Finding[] = [];

    if (options.reportUndeclaredImports !== false && imports !== undefined) {
      const finding = reportUndeclared(ctx, manifest, imports.edges, allowed, anchor);
      if (finding) findings.push(finding);
    }
    if (options.reportMissingFromLock !== false) {
      const finding = reportLockGaps(manifest, allowed, anchor);
      if (finding) findings.push(finding);
    }
    if (options.reportUnpinnedSpecifiers !== false) {
      findings.push(...reportUnpinned(manifest, anchor));
    }

    return findings.slice(0, MAX_FINDINGS);
  },
};

/* ------------------------------------------------------------------ *
 * Undeclared imports
 * ------------------------------------------------------------------ */

interface UndeclaredImport {
  packageName: string;
  file: string;
  specifier: string;
  typeOnly: boolean;
}

function reportUndeclared(
  ctx: UniversalDetectorContext,
  manifest: ManifestIndex,
  edges: ImportEdge[],
  allowed: Set<string>,
  anchor: PackageManifest,
): Finding | undefined {
  const undeclared = new Map<string, UndeclaredImport>();
  const aliasPatterns = ctx.imports?.aliasPatterns ?? [];

  for (const edge of edges) {
    if (!edge.external) continue;
    // A `package.json` governs JS/TS imports and nothing else. Checking a
    // Python import against it produced a HIGH-severity finding on zulip
    // claiming 450 undeclared packages, itemising `abc` and `_typeshed`
    // (the Python standard library) and `aioapns` (declared, in
    // pyproject.toml). Provenance for other languages needs their own
    // manifest readers; until then, silence beats a confident wrong
    // answer.
    if (!isNodeResolvedSource(edge.from)) continue;
    const packageName = packageNameOf(edge.specifier, aliasPatterns);
    if (packageName === undefined) continue;
    if (allowed.has(packageName.toLowerCase())) continue;
    if (isBuiltinModule(packageName)) continue;
    if (manifest.workspaceNames.has(packageName)) continue;

    // A file inside a non-workspace manifest (a sample app, an eval
    // fixture) is that project's business, not this repo's.
    if (!inWorkspaceScope(edge.from, manifest)) continue;
    if (isDeclaredFor(edge.from, packageName, manifest)) continue;

    // `import type { X } from "foo"` where `@types/foo` is declared is
    // accounted for — the types package is the provenance.
    if (edge.typeOnly && isDeclaredFor(edge.from, `@types/${packageName}`, manifest)) {
      continue;
    }
    // Scoped types: `@scope/pkg` → `@types/scope__pkg`.
    if (edge.typeOnly && packageName.startsWith("@")) {
      const flattened = `@types/${packageName.slice(1).replace("/", "__")}`;
      if (isDeclaredFor(edge.from, flattened, manifest)) continue;
    }

    // First occurrence wins; edges arrive in stable order.
    if (!undeclared.has(packageName)) {
      undeclared.set(packageName, {
        packageName,
        file: edge.from,
        specifier: edge.specifier,
        typeOnly: edge.typeOnly,
      });
    }
  }

  if (undeclared.size === 0) return undefined;

  const entries = [...undeclared.values()].sort((a, b) =>
    a.packageName.localeCompare(b.packageName),
  );
  const productionEntries = entries.filter((e) => classifyScope(e.file) === "production");
  const runtimeEntries = productionEntries.filter((e) => !e.typeOnly);

  const confidence = new ConfidenceLadder(0.68)
    .add(
      runtimeEntries.length > 0,
      `${runtimeEntries.length} runtime import(s) affected`,
      0.14,
    )
    .add(
      manifest.isMonorepo,
      "monorepo — resolution walks up through parent manifests",
      -0.08,
    )
    .add(
      entries.every((e) => e.typeOnly),
      "every affected import is type-only",
      -0.18,
    )
    .add(
      productionEntries.length === 0,
      "only test or fixture files are affected",
      -0.12,
    );

  const severity = new SeverityLadder(0.4)
    .add(runtimeEntries.length > 0, "runtime imports are affected", 0.22)
    .add(runtimeEntries.length >= 3, "three or more runtime packages", 0.08)
    .add(
      entries.every((e) => e.typeOnly),
      "type-only imports",
      -0.2,
    )
    .add(productionEntries.length === 0, "test-only imports", -0.15);

  const evidence: string[] = [
    `${entries.length} external package(s) imported with no declaring manifest`,
  ];
  for (const entry of entries.slice(0, 8)) {
    const kind = entry.typeOnly ? " (type-only)" : "";
    evidence.push(
      `  \`${entry.packageName}\`${kind} — imported at ${entry.file} as "${entry.specifier}"`,
    );
  }
  if (entries.length > 8) evidence.push(`  +${entries.length - 8} more`);
  evidence.push(
    `manifests searched: ${manifest.manifests
      .map((m) => m.file)
      .slice(0, 6)
      .join(", ")}` +
      (manifest.manifests.length > 6 ? `, +${manifest.manifests.length - 6} more` : ""),
  );
  evidence.push(
    "resolution walks from the importing file's nearest package.json up to " +
      "the repo root, so hoisted and workspace-root declarations are counted",
  );
  evidence.push(
    "node built-ins, relative paths, path aliases, workspace packages, and " +
      "subpaths of declared packages are excluded",
  );
  evidence.push(
    "this is a statement about this repository's records only — no registry " +
      "was contacted and no claim is made about the packages themselves",
  );
  evidence.push(confidence.explain());
  const escalation = severity.explain();
  if (escalation !== undefined) evidence.push(escalation);

  void ctx;

  return {
    id: "",
    type: "dependency_provenance_gap",
    charge: "Phantom Accomplice",
    severity: severity.severity(),
    confidence: confidence.value(),
    file: anchor.file,
    lines: [1, 1],
    symbol: "undeclared imports",
    summary:
      `${entries.length} external package(s) are imported but declared in no ` +
      "applicable package.json. They resolve today through hoisting; a clean " +
      "install can fail.",
    evidence,
    effort: "quick",
    fix_shape: "declare each imported package in the manifest that uses it",
    scores: {
      severity: severity.score(),
      confidence: confidence.value(),
    },
    suggested_actions: [
      {
        kind: "declare_dependency",
        description: `Add ${entries
          .slice(0, 3)
          .map((e) => `\`${e.packageName}\``)
          .join(", ")} to the dependencies of the package that imports them.`,
        risk: "low",
      },
    ],
    related_files: [
      ...new Set(entries.map((e) => e.file).filter((f) => f !== anchor.file)),
    ]
      .sort()
      .slice(0, 10),
  };
}

/* ------------------------------------------------------------------ *
 * Lockfile gaps
 * ------------------------------------------------------------------ */

function reportLockGaps(
  manifest: ManifestIndex,
  allowed: Set<string>,
  anchor: PackageManifest,
): Finding | undefined {
  const usable = manifest.lockfiles.filter((l) => !l.unparsed);
  if (usable.length === 0) return undefined;

  const locked = new Set<string>();
  for (const lock of usable) {
    for (const name of lock.names) locked.add(name);
  }

  const missing: DeclaredDependency[] = [];
  for (const pkg of manifest.manifests) {
    // Only workspace members are installed by this lockfile. A sample
    // app under `examples/` or an eval fixture has its own dependency
    // story and was never covered by the root lock — comparing it would
    // report every one of its dependencies as missing, which is both
    // wrong and the loudest possible way to be wrong.
    if (!pkg.inWorkspace) continue;
    for (const dep of pkg.dependencies) {
      if (allowed.has(dep.name.toLowerCase())) continue;
      // Workspace-internal packages are not lock entries.
      if (manifest.workspaceNames.has(dep.name)) continue;
      if (dep.shape === "workspace" || dep.shape === "link" || dep.shape === "file") {
        continue;
      }
      // `bundledDependencies` re-lists an already-declared name.
      if (dep.kind === "bundledDependencies") continue;
      // Peer and optional dependencies are legitimately absent from a
      // lockfile when nothing installs them.
      if (dep.kind === "peerDependencies" || dep.kind === "optionalDependencies") {
        continue;
      }
      if (locked.has(dep.name)) continue;
      missing.push(dep);
    }
  }

  if (missing.length === 0) return undefined;
  missing.sort((a, b) =>
    a.manifest === b.manifest
      ? a.name.localeCompare(b.name)
      : a.manifest.localeCompare(b.manifest),
  );

  const confidence = new ConfidenceLadder(0.7)
    .add(usable.length === 1, `single lockfile (${usable[0]!.file})`, 0.1)
    .add(
      usable.length > 1,
      `${usable.length} lockfiles present — mixed package managers`,
      -0.05,
    )
    .add(missing.length >= 5, `${missing.length} declarations affected`, 0.05);

  const severity = new SeverityLadder(0.45)
    .add(
      missing.some((d) => d.kind === "dependencies"),
      "runtime dependencies affected",
      0.18,
    )
    .add(missing.length >= 5, "five or more declarations affected", 0.08);

  const workspaceCount = manifest.manifests.filter((m) => m.inWorkspace).length;
  const evidence: string[] = [
    `lockfile(s): ${usable.map((l) => `${l.file} (${l.manager}, ${l.names.size} entries)`).join(", ")}`,
    `${workspaceCount} workspace manifest(s) compared` +
      (manifest.manifests.length > workspaceCount
        ? `; ${manifest.manifests.length - workspaceCount} manifest(s) outside the workspace were skipped (they are not installed by this lockfile)`
        : ""),
    `${missing.length} declared dependenc(ies) with no lockfile entry:`,
  ];
  for (const dep of missing.slice(0, 8)) {
    evidence.push(
      `  \`${dep.name}\`@${dep.specifier} — declared in ${dep.manifest}:${dep.line} (${dep.kind})`,
    );
  }
  if (missing.length > 8) evidence.push(`  +${missing.length - 8} more`);
  evidence.push(
    "peer, optional, bundled, workspace, `file:`, and `link:` dependencies are " +
      "excluded — none of those is required to appear in a lock",
  );
  evidence.push(
    "the manifest and the lock disagree, so `install --frozen-lockfile` in CI " +
      "will resolve differently from a local install",
  );
  evidence.push(confidence.explain());
  const escalation = severity.explain();
  if (escalation !== undefined) evidence.push(escalation);

  return {
    id: "",
    type: "dependency_provenance_gap",
    charge: "Phantom Accomplice",
    severity: severity.severity(),
    confidence: confidence.value(),
    file: anchor.file,
    lines: [1, 1],
    symbol: "manifest/lockfile disagreement",
    summary:
      `${missing.length} dependenc(ies) declared in a manifest have no entry ` +
      "in the committed lockfile. The two records disagree about what this " +
      "repo installs.",
    evidence,
    effort: "quick",
    fix_shape: "re-run the package manager's install and commit the lockfile",
    scores: {
      severity: severity.score(),
      confidence: confidence.value(),
    },
    suggested_actions: [
      {
        kind: "regenerate_lockfile",
        description:
          "Run the package manager's install so the lockfile matches the " +
          "manifests, and commit the result.",
        risk: "low",
      },
    ],
    related_files: [...new Set(missing.map((d) => d.manifest))]
      .filter((f) => f !== anchor.file)
      .sort(),
  };
}

/* ------------------------------------------------------------------ *
 * Unpinned specifiers
 * ------------------------------------------------------------------ */

function reportUnpinned(manifest: ManifestIndex, anchor: PackageManifest): Finding[] {
  const mutable: Array<{ dep: DeclaredDependency; reason: string }> = [];

  for (const pkg of manifest.manifests) {
    if (!pkg.inWorkspace) continue;
    for (const dep of pkg.dependencies) {
      if (dep.shape === "git" && !isPinnedGitSpecifier(dep.specifier)) {
        mutable.push({
          dep,
          reason: "git dependency with no commit pin — the ref can move",
        });
      } else if (dep.shape === "url") {
        mutable.push({
          dep,
          reason: "direct tarball or URL dependency — the contents can change",
        });
      } else if (dep.shape === "wildcard") {
        mutable.push({
          dep,
          reason: "wildcard version — resolves to whatever is newest",
        });
      } else if (
        (dep.shape === "file" || dep.shape === "link") &&
        escapesRepository(dep.specifier)
      ) {
        mutable.push({
          dep,
          reason: "local path dependency pointing outside the repository",
        });
      }
    }
  }

  if (mutable.length === 0) return [];
  mutable.sort((a, b) =>
    a.dep.manifest === b.dep.manifest
      ? a.dep.name.localeCompare(b.dep.name)
      : a.dep.manifest.localeCompare(b.dep.manifest),
  );

  const runtime = mutable.filter((m) => m.dep.kind === "dependencies");

  const confidence = new ConfidenceLadder(0.85).add(
    true,
    "specifier shape is read directly from the manifest",
    0.05,
  );

  const severity = new SeverityLadder(0.4)
    .add(runtime.length > 0, "runtime dependencies affected", 0.2)
    .add(
      mutable.some((m) => m.dep.shape === "url"),
      "direct URL dependency",
      0.12,
    )
    .add(
      mutable.some((m) => m.dep.shape === "git"),
      "unpinned git dependency",
      0.1,
    );

  const evidence: string[] = [
    `${mutable.length} dependency specifier(s) that can resolve differently between installs:`,
  ];
  for (const { dep, reason } of mutable.slice(0, 8)) {
    evidence.push(
      `  \`${dep.name}\`: "${dep.specifier}" in ${dep.manifest}:${dep.line} (${dep.kind}) — ${reason}`,
    );
  }
  if (mutable.length > 8) evidence.push(`  +${mutable.length - 8} more`);
  evidence.push(
    "a lockfile pins today's resolution, but any lockfile refresh re-resolves " +
      "these against a moving target",
  );
  evidence.push(
    "no registry was contacted; this is a reading of the specifier text only",
  );
  evidence.push(confidence.explain());
  const escalation = severity.explain();
  if (escalation !== undefined) evidence.push(escalation);

  return [
    {
      id: "",
      type: "dependency_provenance_gap",
      charge: "Phantom Accomplice",
      severity: severity.severity(),
      confidence: confidence.value(),
      file: anchor.file,
      lines: [
        mutable[0]!.dep.manifest === anchor.file ? mutable[0]!.dep.line : 1,
        mutable[0]!.dep.manifest === anchor.file ? mutable[0]!.dep.line : 1,
      ],
      symbol: "unpinned specifiers",
      summary:
        `${mutable.length} dependency specifier(s) are not pinned to immutable ` +
        "content. Two installs of this commit can produce different code.",
      evidence,
      effort: "quick",
      fix_shape: "pin to a commit, a published version, or a vendored copy",
      scores: {
        severity: severity.score(),
        confidence: confidence.value(),
      },
      suggested_actions: [
        {
          kind: "pin_specifier",
          description:
            "Replace each mutable specifier with an immutable one — a commit " +
            "SHA for git dependencies, a published version for URLs, an " +
            "explicit range for wildcards.",
          risk: "low",
        },
      ],
      related_files: [...new Set(mutable.map((m) => m.dep.manifest))]
        .filter((f) => f !== anchor.file)
        .sort(),
    },
  ];
}

/* ------------------------------------------------------------------ *
 * Resolution helpers
 * ------------------------------------------------------------------ */

/**
 * Is `packageName` declared in any manifest governing `file`?
 *
 * Walks from the file's nearest enclosing manifest up to the repo root.
 * That mirrors how both pnpm workspaces and npm hoisting resolve, so a
 * dependency declared at the workspace root satisfies an import in a
 * child package.
 */
function isDeclaredFor(file: string, packageName: string, index: ManifestIndex): boolean {
  for (const manifest of index.manifests) {
    if (!governs(manifest.dir, file)) continue;
    if (manifest.dependencies.some((d) => d.name === packageName)) return true;
  }
  return false;
}

/**
 * Is this file governed by a workspace manifest?
 *
 * Resolution finds the *nearest* enclosing manifest; if that one is
 * outside the workspace the file belongs to a self-contained project
 * this repo merely stores.
 */
function inWorkspaceScope(file: string, index: ManifestIndex): boolean {
  let nearest: PackageManifest | undefined;
  for (const manifest of index.manifests) {
    if (!governs(manifest.dir, file)) continue;
    if (nearest === undefined || manifest.dir.length > nearest.dir.length) {
      nearest = manifest;
    }
  }
  return nearest === undefined ? true : nearest.inWorkspace;
}

/** Does a manifest directory contain this repo-relative file? */
function governs(dir: string, file: string): boolean {
  if (dir === "") return true;
  return file === dir || file.startsWith(`${dir}/`);
}

/**
 * The package name a specifier refers to.
 *
 * `lodash/fp` → `lodash`; `@scope/pkg/sub` → `@scope/pkg`. Returns
 * `undefined` for anything that is not a bare package specifier.
 */
export function packageNameOf(
  specifier: string,
  aliasPatterns: readonly string[] = [],
): string | undefined {
  if (specifier.length === 0) return undefined;
  if (NON_PACKAGE_RE.test(specifier) && !specifier.startsWith("node:")) {
    return undefined;
  }
  if (specifier.startsWith("node:")) return specifier;
  if (PATH_ALIAS_RE.test(specifier)) return undefined;
  // Aliases the repo actually declares, from any tsconfig — not just the
  // shapes hardcoded above. cal.com declares `@components/*` in a nested
  // tsconfig and has no root one at all.
  if (matchesAliasPattern(specifier, aliasPatterns)) return undefined;

  const parts = specifier.split("/");
  if (specifier.startsWith("@")) {
    if (parts.length < 2) return undefined;
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0];
}

/**
 * Does the specifier match a declared tsconfig `paths` key? Patterns
 * carry at most one `*`, per the TypeScript spec.
 */
function matchesAliasPattern(specifier: string, patterns: readonly string[]): boolean {
  for (const pattern of patterns) {
    const star = pattern.indexOf("*");
    if (star === -1) {
      if (specifier === pattern) return true;
      continue;
    }
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (
      specifier.length >= prefix.length + suffix.length &&
      specifier.startsWith(prefix) &&
      specifier.endsWith(suffix)
    ) {
      return true;
    }
  }
  return false;
}

function isBuiltinModule(packageName: string): boolean {
  const bare = packageName.startsWith("node:")
    ? packageName.slice("node:".length)
    : packageName;
  // `isBuiltin` accepts both forms, but calling it with the bare name
  // keeps behaviour identical across the Node versions this supports.
  return isBuiltin(bare) || isBuiltin(`node:${bare}`);
}

/** Does a `file:` / `link:` target climb out of the repository? */
function escapesRepository(specifier: string): boolean {
  const target = specifier.replace(/^(file|link):/, "");
  if (target.startsWith("/") || /^[A-Za-z]:[\\/]/.test(target)) return true;
  return target.startsWith("../..");
}

/** The manifest a repo-level finding anchors on: root first, else first. */
function anchorManifest(index: ManifestIndex): PackageManifest | undefined {
  return index.manifests.find((m) => m.dir === "") ?? index.manifests[0];
}

/**
 * Emit repo-level findings exactly once per scan.
 *
 * The per-file detector loop calls every detector for every file, so a
 * repo-level detector needs a deterministic emission point. The
 * lexicographically first file in the IA index is the convention this
 * codebase already uses (`missing_agent_context`), and it is stable
 * across runs and platforms.
 */
function isRepoAnchorFile(ctx: UniversalDetectorContext): boolean {
  if (!ctx.ia) return false;
  const files = Object.keys(ctx.ia.files).sort();
  return files.length > 0 && files[0] === ctx.file;
}

function readOptions(config: {
  detectors?: { options?: Record<string, unknown> };
}): Options {
  const raw = config.detectors?.options?.dependency_provenance_gap;
  if (raw === undefined) return {};
  const parsed = optionsSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

/**
 * Files whose imports are resolved by Node / a JS bundler, and therefore
 * governed by a `package.json`. Anything else — Python, Go, Rust — has
 * its own manifest system that this detector does not read.
 */
const NODE_RESOLVED_EXT = /\.(?:[cm]?[jt]sx?|vue|svelte)$/i;

function isNodeResolvedSource(file: string): boolean {
  return NODE_RESOLVED_EXT.test(file);
}
