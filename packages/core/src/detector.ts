import type { ParsedFile } from "@crimes/language-js";
import type { z } from "zod";
import type { FunctionHashIndex } from "./ast-hash/function-index.js";
import type { CrimesConfig } from "./config.js";
import type { Finding } from "./finding.js";
import type { IaIndex } from "./ia/types.js";
import type { ImportGraph } from "./imports/types.js";
import type { JsxShapeIndex } from "./jsx/shape-index.js";
import type { PettyIndex } from "./petty/types.js";
import type { ScoringContext } from "./scoring/build.js";

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
   * Optional zod schema for per-detector exemption config under
   * `detectors.options.<id>` in `crimes.config.json`. When set, the
   * config loader validates the user's options against this schema at
   * load time — typos surface immediately rather than at scan time.
   * Detectors that do not accept options leave this undefined; the
   * loader rejects any `detectors.options.<id>` block for such
   * detectors.
   */
  optionsSchema?: z.ZodType<unknown>;
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
      run(ctx: UniversalDetectorContext): Promise<Finding[]> | Finding[];
    })
  | (BaseDetector & {
      pack: "language-js";
      run(ctx: LanguageJsDetectorContext): Promise<Finding[]> | Finding[];
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
  run(ctx: AssetDetectorContext): Promise<Finding[]> | Finding[];
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
 *  - (future) `kind: "language-py"` → 0.13.0
 *  - (future) `kind: "cross-language"` → 0.14.0
 *
 * Detectors declare the kind they expect via their `pack` field;
 * the registry only feeds them the matching context.
 */
export type DetectorContext = UniversalDetectorContext | LanguageJsDetectorContext;

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
}
