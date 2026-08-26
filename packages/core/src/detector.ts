import type { ParsedFile } from "@crimes/language-js";
import type { ParsedPyFile } from "@crimes/language-py";
import type { z } from "zod";
import type { FunctionHashIndex } from "./ast-hash/function-index.js";
import type { CrimesConfig } from "./config.js";
import type { PreFinding } from "./finding.js";
import type { IaIndex } from "./ia/types.js";
import type { ImportGraph } from "./imports/types.js";
import type { PyModuleReferenceIndex } from "./detectors/py/module-references.js";
import type { PySymbolIndex } from "./py/symbol-index.js";
import type { JsxShapeIndex } from "./jsx/shape-index.js";
import type { PettyIndex } from "./petty/types.js";
import type { ScoringContext } from "./scoring/build.js";
import type { AgentConfigIndex } from "./agents/types.js";
import type { ManifestIndex } from "./manifest/types.js";
import type { RiskIndex } from "./risk/types.js";

/**
 * Common fields shared by every detector variant. The narrowed `Detector`
 * union below pairs the `pack` tag with the matching `run` signature so
 * a detector that declares `pack: "language-js"` cannot accidentally
 * receive a universal context (and vice versa).
 */
interface BaseDetector {
  /** Stable machine id, e.g. `large_function`. */
  id: string;
  /** Short human-friendly name shown in `--list-detectors` later. */
  name: string;
  /** One-line description of what this detector finds. */
  description: string;
  /**
   * One-paragraph rationale for `crimes explain`. Explains _why_ this kind
   * of finding matters to agents and reviewers, not what the detector
   * looks for (that is `description`). Deterministic — no LLM, no
   * per-finding tailoring; the same string is shown for every finding of
   * this type.
   */
  whyItMatters: string;
  /**
   * Every distinct **claim** this detector can make, as stable machine
   * ids. A claim is an assertion with its own truth value and its own
   * fix — not a wording variant of one assertion.
   *
   * Declare it when the detector emits more than one claim, and leave it
   * unset when it emits exactly one. That split is the same shape as
   * {@link Finding.discriminator}: the overwhelming majority of
   * detectors say one thing and carry no claim, and only the ones that
   * were conflating several change shape.
   *
   * The list is not documentation — three things read it:
   *
   * - `crimes.config.json`'s `detectors.disable` accepts `<id>/<claim>`
   *   and validates the claim half against this list, so a typo raises
   *   {@link UnknownDetectorError} instead of silently disabling
   *   nothing.
   * - {@link fingerprintFinding} folds `claim` into the fingerprint, so
   *   a suppression recorded against one claim cannot silence another.
   * - `detector-claims.test.ts` asserts every emitted `finding.claim`
   *   appears here, and that a detector declaring claims sets one on
   *   every finding. That test is the gate that keeps this list honest.
   *
   * Claim ids are `[a-z0-9_]+`, unique within the detector, and stable
   * across releases — they appear in users' committed config and
   * suppression files. Rename one only with the same care as renaming
   * the detector itself.
   */
  claims?: readonly string[];
  /**
   * Optional zod schema for per-detector exemption config under
   * `detectors.options.<id>` in `crimes.config.json`. When set, the
   * config loader validates the user's options against this schema at
   * load time — typos surface immediately rather than at scan time.
   * Detectors that do not accept options leave this undefined; the
   * loader rejects any `detectors.options.<id>` block for such
   * detectors.
   */
  optionsSchema?: z.ZodType<unknown>;
  /**
   * When true this detector does **not** run unless the user names it in
   * `detectors.enable`.
   *
   * Reserved for detectors whose output is dominated by one repo shape
   * badly enough that leaving them on costs more than they return, but
   * which are worth keeping for the repos they do serve. It is a product
   * decision, not a way to park a bug: a detector that is simply wrong
   * gets fixed or deleted.
   *
   * The one detector carrying it is `parallel_destination` — 2,819
   * findings on n8n's `editor-ui`, 52.8% of that package's whole report,
   * from pairing Vue composables on the token `use`, and zero findings
   * on every other repo in the corpus.
   */
  defaultOff?: true;
}

/**
 * A detector inspects parsed files and emits zero or more findings.
 *
 * Detectors are stateless and safe to call in parallel. They must not
 * write to disk or perform network I/O.
 */
export type Detector =
  | (BaseDetector & {
      pack: "universal";
      run(ctx: UniversalDetectorContext): Promise<PreFinding[]> | PreFinding[];
    })
  | (BaseDetector & {
      pack: "language-js";
      run(ctx: LanguageJsDetectorContext): Promise<PreFinding[]> | PreFinding[];
    })
  | (BaseDetector & {
      pack: "language-py";
      run(ctx: LanguagePyDetectorContext): Promise<PreFinding[]> | PreFinding[];
    })
  | (BaseDetector & {
      pack: "cross-language";
      run(ctx: CrossLanguageDetectorContext): Promise<PreFinding[]> | PreFinding[];
    });

/**
 * Convenience alias for the universal branch of the `Detector` union.
 * Use this type when you know you have a universal detector, e.g., in
 * unit tests and the universal scan branch inside the orchestrator.
 */
export type UniversalDetector = Extract<Detector, { pack: "universal" }>;

/**
 * Convenience alias for the language-js branch of the `Detector` union.
 * Use this type when you know you have a language-js detector, e.g., in
 * unit tests and in the language-js scan pipeline.
 */
export type LanguageJsDetector = Extract<Detector, { pack: "language-js" }>;

/**
 * Convenience alias for the language-py branch of the `Detector` union.
 * Use this type when you know you have a Python detector, e.g. in unit
 * tests and in the language-py scan pipeline.
 */
export type LanguagePyDetector = Extract<Detector, { pack: "language-py" }>;

/**
 * Convenience alias for the cross-language branch of the `Detector`
 * union. These detectors run once per scan rather than once per file.
 */
export type CrossLanguageDetector = Extract<Detector, { pack: "cross-language" }>;

/**
 * An asset detector inspects files that aren't TS/JS source — images,
 * SVGs, and other binary or markup assets. It runs in a separate
 * scanner pass so the source-detector pipeline doesn't have to thread
 * "parsed AST is optional" through every detector.
 *
 * Asset detectors are stateless and safe to call in parallel. The
 * orchestrator pre-fetches the file's byte size (cheap, one `fs.stat`)
 * and exposes a lazy `read()` for detectors that need the bytes. The
 * buffer is cached across detectors viewing the same file so a scan
 * never re-reads.
 */
export interface AssetDetector {
  /** Stable machine id, e.g. `oversized_raster`. */
  id: string;
  /** Short human-friendly name. */
  name: string;
  /** One-line description of what this detector finds. */
  description: string;
  /** Paragraph rationale shown by `crimes explain`. */
  whyItMatters: string;
  /**
   * Asset detectors always belong to the universal pack — their evidence
   * is file bytes + extensions, never AST. Declared explicitly so the
   * detector registry can route uniformly.
   */
  pack: "universal";
  /**
   * Every distinct claim this detector can make. Same contract as
   * {@link Detector.claims} — asset and source detectors share one id
   * namespace, so they share one claim namespace too.
   */
  claims?: readonly string[];
  /**
   * Lowercase file extensions (including the leading dot) this detector
   * applies to. The orchestrator skips the detector entirely for files
   * whose extension is not in this set, so detectors don't need to
   * recheck.
   */
  extensions: string[];
  /**
   * Optional zod schema for per-detector exemption config under
   * `detectors.options.<id>`. Same contract as {@link Detector.optionsSchema}.
   */
  optionsSchema?: z.ZodType<unknown>;
  /**
   * When true this detector does **not** run unless the user names it in
   * `detectors.enable`.
   *
   * Reserved for detectors whose output is dominated by one repo shape
   * badly enough that leaving them on costs more than they return, but
   * which are worth keeping for the repos they do serve. It is a product
   * decision, not a way to park a bug: a detector that is simply wrong
   * gets fixed or deleted.
   *
   * The one detector carrying it is `parallel_destination` — 2,819
   * findings on n8n's `editor-ui`, 52.8% of that package's whole report,
   * from pairing Vue composables on the token `use`, and zero findings
   * on every other repo in the corpus.
   */
  defaultOff?: true;
  run(ctx: AssetDetectorContext): Promise<PreFinding[]> | PreFinding[];
}

export interface AssetDetectorContext {
  /** Repo-relative path with forward slashes. */
  file: string;
  /** Absolute path on disk. */
  absolutePath: string;
  /** Lowercase extension including the leading dot (e.g. `".png"`). */
  extension: string;
  /** Byte size pre-fetched by the orchestrator (`fs.stat().size`). */
  byteSize: number;
  /**
   * Lazy reader. The orchestrator only opens the file when a detector
   * calls this; repeated calls within one scan return the same buffer
   * (cached per file). Detectors that only need byte size should not
   * call `read()` at all — the optimisation matters when scanning
   * thousands of images.
   */
  read(): Promise<Buffer>;
  /** Resolved config (already merged with defaults). */
  config: CrimesConfig;
}

/**
 * Per-file context the registry hands to a detector. The `kind` tag
 * matches the detector's declared `pack`:
 *
 *  - `kind: "universal"` → fed to detectors with `pack: "universal"`
 *  - `kind: "language-js"` → fed to detectors with `pack: "language-js"`
 *  - `kind: "language-py"` → fed to detectors with `pack: "language-py"`
 *  - `kind: "cross-language"` → fed to detectors with `pack: "cross-language"`
 *
 * Detectors declare the kind they expect via their `pack` field;
 * the registry only feeds them the matching context.
 */
export type DetectorContext =
  | UniversalDetectorContext
  | LanguageJsDetectorContext
  | LanguagePyDetectorContext
  | CrossLanguageDetectorContext;

/**
 * Every context that describes **one file**.
 *
 * Distinct from {@link DetectorContext} because the cross-language
 * context is per *scan*, so it carries no `file`. Helpers that read
 * `ctx.file` — the `isPrimaryAnchor` guard the IA detectors use to emit
 * a repo-level finding exactly once — take this instead of the full
 * union.
 */
export type PerFileDetectorContext =
  | UniversalDetectorContext
  | LanguageJsDetectorContext
  | LanguagePyDetectorContext;

export interface UniversalDetectorContext {
  kind: "universal";
  /** Repo-relative path with forward slashes. */
  file: string;
  /** Absolute path on disk. */
  absolutePath: string;
  /** Lowercase extension including the leading dot. */
  extension: string;
  /** Lazy source bytes; first call reads from disk, subsequent calls return cached. */
  readSource(): Promise<string>;
  /** Byte size from `fs.stat()`. */
  byteSize: number;
  /**
   * Number of newline-delimited lines in the source. The orchestrator
   * pre-reads `readSource()` so this is safe to read directly in
   * detector bodies.
   */
  readonly lineCount: number;
  /** Resolved config (already merged with defaults). */
  config: CrimesConfig;
  /**
   * Optional repo-level IA signal index. Populated by `scan` and `context`
   * for every detector context; absent only in direct unit-test stubs that
   * don't need cross-file analysis. IA detectors read from this; existing
   * file-local detectors ignore it.
   */
  ia?: IaIndex;
  /**
   * Optional repo-level petty-crimes signal index. Populated by `scan` and
   * `context`; absent only in direct unit-test stubs or when the index build
   * fails. Cross-file petty detectors read from this.
   */
  petty?: PettyIndex;
  /**
   * Optional per-file scoring context. Populated by `scan` and `context`;
   * absent in direct unit-test stubs. Core uses this to backfill
   * `scores.churn` / `scores.test_gap` / `scores.blast_radius` and to
   * recompute `scores.agent_risk` on every finding via the unified
   * 0.6.0 formula. Detectors do not need to read it themselves —
   * finalisation happens after `run()` returns — but it is exposed
   * here for advanced detectors that want to gate behaviour on the
   * scoring signal.
   */
  scoring?: ScoringContext;
  /**
   * Optional repo-level import graph. Present on the universal context
   * from 0.16.0 so `dependency_provenance_gap` can compare imports
   * against manifests without needing a language pack — the graph
   * already carries every pack's edges, including external specifiers.
   */
  imports?: ImportGraph;
  /**
   * Optional cross-file risk inventory (0.16.0): policy clones, object
   * contracts, environment reads, and pass-through chains. Populated by
   * `scan` and `context`; absent in unit-test stubs and when the build
   * fails. Detectors that need it treat absence as "skip", never as
   * fatal.
   */
  risk?: RiskIndex;
  /**
   * Optional package-manifest + lockfile inventory (0.16.0). Read from
   * disk, never from a registry.
   */
  manifest?: ManifestIndex;
  /**
   * Optional repository-local agent-configuration inventory (0.16.0).
   * Hooks and settings are read as text and never executed.
   */
  agentConfig?: AgentConfigIndex;
}

/**
 * Language-js context — the historical `DetectorContext` shape. Carries
 * the `ParsedFile` from `@crimes/language-js` plus all cross-file
 * indexes that depend on TS/JS parsing (JSX shape, function hashes,
 * import graph).
 */
export interface LanguageJsDetectorContext {
  kind: "language-js";
  /** Repo-relative path with forward slashes. */
  file: string;
  /** Absolute path on disk. */
  absolutePath: string;
  /** Raw file source. */
  source: string;
  /** Lazy-parsed TS/JS AST + metadata. */
  parsed: ParsedFile;
  /** Resolved config (already merged with defaults). */
  config: CrimesConfig;
  /**
   * Optional repo-level IA signal index. Populated by `scan` and `context`
   * for every detector context; absent only in direct unit-test stubs that
   * don't need cross-file analysis. IA detectors read from this; existing
   * file-local detectors ignore it.
   */
  ia?: IaIndex;
  /**
   * Optional repo-level petty-crimes signal index. Populated by `scan` and
   * `context`; absent only in direct unit-test stubs or when the index build
   * fails. Cross-file petty detectors read from this.
   */
  petty?: PettyIndex;
  /**
   * Optional repo-level import graph. Populated by `scan` and `context` for
   * every detector context; absent only in direct unit-test stubs that
   * don't exercise cross-file dependency analysis. Dependency-graph
   * detectors (`circular_dependency`, `deep_import`,
   * `high_fan_in_fan_out`), `layer_violation`, and `scores.blast_radius`
   * read from this; file-local detectors ignore it.
   */
  imports?: ImportGraph;
  /**
   * Optional repo-wide JSX shape index. Populated by `scan` and
   * `context`; absent only in stubs that don't exercise the
   * `duplicate_component_shape` detector. The index groups
   * "interesting" JSX subtrees by their structural shape hash so the
   * detector can answer "does this shape appear in ≥3 distinct files?"
   * without re-walking every file itself.
   */
  jsxShapeIndex?: JsxShapeIndex;
  /**
   * Optional repo-wide function-hash index. Populated by `scan` and
   * `context`; absent in stubs. The duplication detectors read this
   * to identify near-duplicate function bodies without re-hashing per
   * detector. Two views: `byExact` for `exact_duplicate_block`,
   * `byShape` for `near_duplicate_block`.
   */
  functionHashIndex?: FunctionHashIndex;
  /**
   * Optional per-file scoring context. Populated by `scan` and `context`;
   * absent in direct unit-test stubs. Core uses this to backfill
   * `scores.churn` / `scores.test_gap` / `scores.blast_radius` and to
   * recompute `scores.agent_risk` on every finding via the unified
   * 0.6.0 formula. Detectors do not need to read it themselves —
   * finalisation happens after `run()` returns — but it is exposed
   * here for advanced detectors that want to gate behaviour on the
   * scoring signal.
   */
  scoring?: ScoringContext;
  /**
   * Optional cross-file risk inventory (0.16.0): policy clones, object
   * contracts, environment reads, and pass-through chains. Populated by
   * `scan` and `context`; absent in unit-test stubs and when the build
   * fails. Detectors that need it treat absence as "skip", never as
   * fatal.
   */
  risk?: RiskIndex;
  /**
   * Optional package-manifest + lockfile inventory (0.16.0). Read from
   * disk, never from a registry.
   */
  manifest?: ManifestIndex;
  /**
   * Optional repository-local agent-configuration inventory (0.16.0).
   * Hooks and settings are read as text and never executed.
   */
  agentConfig?: AgentConfigIndex;
}

/**
 * Language-py context. Carries the `ParsedPyFile` from
 * `@crimes/language-py` plus the cross-file indexes that are genuinely
 * language-agnostic.
 *
 * Note what is deliberately *absent* relative to the JS context:
 * `jsxShapeIndex` and `functionHashIndex` are TS/JS-specific artefacts,
 * and threading them here "for symmetry" would be exactly the
 * JS-shaped-abstraction failure this release exists to disprove. The
 * `imports` graph, by contrast, **is** shared: `packages/core` resolves
 * Python module paths via `@crimes/language-py` and merges the resulting
 * edges into the same `ImportGraph`, so `circular_dependency.py`,
 * `deep_import.py`, and `scores.blast_radius` all read one graph
 * regardless of which pack produced a given edge.
 */
export interface LanguagePyDetectorContext {
  kind: "language-py";
  /** Repo-relative path with forward slashes. */
  file: string;
  /** Absolute path on disk. */
  absolutePath: string;
  /** Raw file source. */
  source: string;
  /** Parsed Python surface — see `@crimes/language-py`. */
  parsed: ParsedPyFile;
  /** Resolved config (already merged with defaults). */
  config: CrimesConfig;
  /**
   * Optional repo-level IA signal index. Populated by `scan` and
   * `context`; absent in unit-test stubs.
   */
  ia?: IaIndex;
  /**
   * Optional repo-level petty-crimes signal index. Populated by `scan`
   * and `context`; absent in unit-test stubs.
   */
  petty?: PettyIndex;
  /**
   * Optional repo-level import graph, carrying both JS and Python edges.
   * Populated by `scan` and `context`; absent in unit-test stubs that
   * don't exercise cross-file dependency analysis.
   */
  imports?: ImportGraph;
  /**
   * Optional repo-wide Python symbol index — classes, bases, methods,
   * and which of them assert. The only supported way to follow a call
   * out of the current file: it resolves through the importing file's
   * own imports and the module index, and returns `undefined` rather
   * than guessing when it cannot.
   *
   * Absent in unit-test stubs, and a detector must behave correctly
   * without it — the same-file answer stays the floor.
   */
  pySymbols?: PySymbolIndex;
  /**
   * Optional repo-wide count of how many files mention each Python
   * module by name — imports *and* dotted strings, because
   * `mock.patch("a.b.mod.fn")` is a reference no import graph sees.
   * Absent in unit-test stubs; a detector must behave as though every
   * module were referenced when it is missing.
   */
  pyModuleRefs?: PyModuleReferenceIndex;
  /**
   * Optional per-file scoring context. Same contract as the JS context —
   * finalisation happens after `run()` returns, so detectors rarely need
   * to read it directly.
   */
  scoring?: ScoringContext;
}

/**
 * One file's parsed output, tagged with the pack that produced it.
 *
 * Cross-language detectors receive these rather than raw `ParsedFile` /
 * `ParsedPyFile` values so they can ask "which language is this?"
 * without sniffing the shape.
 */
export type PackedFile =
  | { pack: "language-js"; file: string; absolutePath: string; parsed: ParsedFile }
  | { pack: "language-py"; file: string; absolutePath: string; parsed: ParsedPyFile };

/**
 * Cross-language context — the 0.15.0 addition.
 *
 * Unlike every other detector context, this one is **per scan, not per
 * file**. A cross-language finding is by definition a disagreement
 * between two files in different languages, so there is no single file
 * to hand the detector; it gets the whole parsed corpus and picks its
 * own anchor.
 *
 * Consequences worth knowing before writing one of these:
 *
 *  - `run()` is called **once**, after every per-language pass has
 *    completed. Detectors must not assume any particular file is
 *    "current".
 *  - Each finding still needs a `file`, because fingerprints are
 *    `<type>::<file>::<symbol>` and every downstream surface (baseline,
 *    suppressions, triage, the file-grouped report) keys off it. Pick
 *    the file a reader would edit first and put the rest in
 *    `related_files`.
 *  - The false-positive blast radius is roughly squared: two languages'
 *    worth of source can be mismatched. The 0.3.0 IA family's rule
 *    applies with extra force — require ≥3 disagreeing sources, and
 *    never emit a finding whose evidence cannot be quoted verbatim.
 */
export interface CrossLanguageDetectorContext {
  kind: "cross-language";
  /** Absolute repo root. */
  root: string;
  /**
   * Every file each language pack claimed and parsed, in stable path
   * order. Empty for a pack that claimed nothing, so a detector that
   * needs both languages should return early when either side is empty
   * rather than reporting a one-sided "drift".
   */
  files: PackedFile[];
  /** Resolved config (already merged with defaults). */
  config: CrimesConfig;
  /** Repo-level IA signal index, spanning every language it can read. */
  ia?: IaIndex;
  /** Repo-wide import graph, carrying every pack's edges. */
  imports?: ImportGraph;
  /** Per-file scoring context. Finalisation happens after `run()`. */
  scoring?: ScoringContext;
}
