import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { type Clock, systemClock } from "./clock.js";
import { SCHEMA_VERSION } from "./finding.js";
import { splitFingerprintType } from "./fingerprint.js";

export const TRIAGE_RELATIVE_PATH = ".crimes/triage.json";

export type TriageDisposition =
  | "fix-now"
  | "fix-this-PR"
  | "needs-design"
  | "wont-fix"
  | "scaffolding";

export interface TriageEntry {
  fingerprint: string;
  type: string;
  /**
   * Which claim of `type` was triaged, when the type makes more than
   * one. Denormalised from the fingerprint for the same reason `type`
   * and `file` are: so a reviewer reading `git diff .crimes/triage.json`
   * can see that somebody marked `no_assertions` wont-fix without
   * knowing how fingerprints are built — and so the next reader does not
   * read that entry as a judgement on the whole detector.
   *
   * Strictly redundant for matching, which is on `fingerprint` alone.
   */
  claim?: string;
  file: string;
  symbol?: string;
  disposition: TriageDisposition;
  /** Non-empty. */
  reason: string;
  /** May be the empty string when the user declined to set one. */
  owner: string;
  /** YYYY-MM-DD. */
  date: string;
}

/**
 * Recognised on-disk schema versions for `.crimes/triage.json`. The
 * loader accepts any prior version still in the active migration window;
 * the writer always emits the current `SCHEMA_VERSION`. Update this union
 * each time `SCHEMA_VERSION` bumps to add the previous value.
 */
const ACCEPTED_TRIAGE_SCHEMA_VERSIONS = [
  "0.2.0",
  "0.3.0",
  "0.4.0",
  "0.5.0",
  "0.6.0",
  "0.7.0",
  "0.8.0",
] as const;

export interface Triage {
  /**
   * On-disk schema version. The loader accepts any value in
   * `ACCEPTED_TRIAGE_SCHEMA_VERSIONS`; the writer always emits the
   * current `SCHEMA_VERSION`.
   */
  schema_version: (typeof ACCEPTED_TRIAGE_SCHEMA_VERSIONS)[number];
  report_type: "triage";
  created_at: string;
  updated_at: string;
  crimes_version?: string;
  entries: TriageEntry[];
}

export interface TriageListReport {
  schema_version: typeof SCHEMA_VERSION;
  report_type: "triage_list";
  entries: TriageEntry[];
}

export interface TriageApplyReport {
  schema_version: typeof SCHEMA_VERSION;
  report_type: "triage_apply";
  applied: number;
}

export interface TriageClearReport {
  schema_version: typeof SCHEMA_VERSION;
  report_type: "triage_clear";
  fingerprint: string;
  removed: number;
}

export const TriageEntrySchema = z
  .object({
    fingerprint: z.string().min(1),
    type: z.string().min(1),
    claim: z.string().min(1).optional(),
    file: z.string().min(1),
    symbol: z.string().min(1).optional(),
    disposition: z.enum([
      "fix-now",
      "fix-this-PR",
      "needs-design",
      "wont-fix",
      "scaffolding",
    ]),
    reason: z.string().min(1),
    owner: z.string(), // empty string allowed
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  })
  .strict();

export const TriageSchema = z
  .object({
    schema_version: z.enum(ACCEPTED_TRIAGE_SCHEMA_VERSIONS),
    report_type: z.literal("triage"),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
    crimes_version: z.string().min(1).optional(),
    entries: z.array(TriageEntrySchema),
  })
  .strict();

export class MalformedTriageError extends Error {
  path: string;
  constructor(path: string, reason: string) {
    super(`triage file at ${path} is malformed: ${reason}`);
    this.name = "MalformedTriageError";
    this.path = path;
  }
}

export interface LoadTriageResult {
  entries: TriageEntry[];
  /** Resolved absolute path (read or not). */
  path: string;
  /** True when the file existed and was read. */
  loaded: boolean;
  /** Present only when `loaded === true`. */
  document?: Triage;
}

export function resolveTriagePath(root: string, override?: string): string {
  if (override === undefined) {
    return resolve(root, TRIAGE_RELATIVE_PATH);
  }
  return isAbsolute(override) ? override : resolve(root, override);
}

export async function loadTriage(path: string): Promise<LoadTriageResult> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (isNodeErrnoException(err) && err.code === "ENOENT") {
      return { entries: [], path, loaded: false };
    }
    throw err;
  }

  const document = parseTriage(raw, path);
  return {
    entries: document.entries,
    path,
    loaded: true,
    document,
  };
}

/**
 * Validate a triage document supplied as a raw JSON string and return
 * the parsed shape. Throws {@link MalformedTriageError} on bad JSON or
 * shape mismatch. Pure — no filesystem access. Used by `crimes triage
 * --apply` so the CLI doesn't have to round-trip the payload through a
 * temp file just to reuse the loader's validation.
 *
 * @param raw - The JSON text to parse and validate.
 * @param sourceLabel - Optional label (typically the source file path)
 *   surfaced in error messages. Defaults to `<inline>`.
 */
export function parseTriage(raw: string, sourceLabel = "<inline>"): Triage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new MalformedTriageError(sourceLabel, `invalid JSON — ${message}`);
  }
  const result = TriageSchema.safeParse(parsed);
  if (!result.success) {
    throw new MalformedTriageError(sourceLabel, formatZodIssues(result.error.issues));
  }
  return result.data;
}

/**
 * The set of dispositions, shared by the on-disk and input schemas.
 */
const DISPOSITIONS = [
  "fix-now",
  "fix-this-PR",
  "needs-design",
  "wont-fix",
  "scaffolding",
] as const;

/** One entry as a CALLER writes it. See {@link parseTriageInput}. */
const TriageInputEntrySchema = z
  .object({
    fingerprint: z.string().min(1),
    // Derivable from the fingerprint, so optional here. A caller that
    // supplies them still wins — this only removes the obligation.
    type: z.string().min(1).optional(),
    file: z.string().min(1).optional(),
    // `""` is accepted and normalised away. The on-disk schema rejects
    // it, which reads as "you must not write an empty symbol" when what
    // it means is "omit the key" — an unhelpful distinction to discover
    // by trial.
    symbol: z.string().optional(),
    disposition: z.enum(DISPOSITIONS),
    reason: z.string().min(1),
    owner: z.string().optional(),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
      .optional(),
  })
  .strict();

/**
 * Split a fingerprint into its `<type>::<file>::<symbol>` head. The tail
 * after the third `::` is the discriminator and is not addressed here.
 * Mirrors `fingerprintFinding`; see `fingerprint.ts`.
 */
function headOfFingerprint(fingerprint: string): {
  type?: string;
  claim?: string;
  file?: string;
  symbol?: string;
} {
  const parts = fingerprint.split("::");
  if (parts.length < 3) return {};
  const [, file, symbol] = parts;
  // The leading segment is `<type>` or `<type>/<claim>`. Taking it whole
  // would record "weak_test_signal/no_assertions" in a field documented
  // as holding a detector id.
  const { type, claim } = splitFingerprintType(fingerprint);
  return {
    type: type === "" ? undefined : type,
    claim,
    file: file === "" ? undefined : file,
    symbol: symbol === "" ? undefined : symbol,
  };
}

/**
 * Validate a triage payload as a CALLER writes it — which is not the
 * same shape as a triage document as crimes stores it.
 *
 * `--apply` is the only non-interactive route into triage: `crimes
 * triage` refuses the interactive walk in CI and in any non-TTY, so
 * this is the path every agent and every scripted caller takes. It used
 * to validate against {@link TriageSchema}, the ON-DISK shape, which
 * asks for four envelope fields (`schema_version`, `report_type`,
 * `created_at`, `updated_at`) describing the file crimes writes rather
 * than anything the caller is asserting, plus `type` and `file` per
 * entry that are already inside the fingerprint. Because the error
 * formatter reports one bad field per run by design, authoring a first
 * payload without an existing file to copy cost seven round-trips —
 * measured, on a real repository, by an agent doing exactly what the
 * README suggests.
 *
 * So the envelope is optional, a bare array is accepted, whatever can be
 * derived from the fingerprint is derived, and **every** problem is
 * reported at once rather than one per run.
 *
 * @param raw - The JSON text to parse.
 * @param sourceLabel - Label surfaced in errors, typically the file path.
 * @param options.now - Clock for the `date` default. Injectable for tests.
 */
export function parseTriageInput(
  raw: string,
  sourceLabel = "<inline>",
  options: { now?: Clock } = {},
): TriageEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new MalformedTriageError(sourceLabel, `invalid JSON — ${message}`);
  }

  // Unwrap the container in plain code rather than with a `z.union`.
  // A union reports one collapsed "(root): Invalid input" for the whole
  // payload, which is the opposite of the point — the caller needs to
  // know which entry and which field. Any envelope keys around
  // `entries` are ignored, so an existing `.crimes/triage.json` is a
  // valid payload exactly as written.
  const rawRows = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && "entries" in parsed
      ? (parsed as { entries: unknown }).entries
      : undefined;
  if (rawRows === undefined) {
    throw new MalformedTriageError(
      sourceLabel,
      'expected an array of entries, or an object with an "entries" array',
    );
  }

  const result = z.array(TriageInputEntrySchema).safeParse(rawRows);
  if (!result.success) {
    throw new MalformedTriageError(
      sourceLabel,
      formatAllTriageIssues(result.error.issues),
    );
  }

  const rows = result.data;
  const today = (options.now ?? systemClock)().toISOString().slice(0, 10);

  return rows.map((row) => {
    const head = headOfFingerprint(row.fingerprint);
    const symbol =
      row.symbol !== undefined && row.symbol !== "" ? row.symbol : head.symbol;
    const entry: TriageEntry = {
      fingerprint: row.fingerprint,
      type: row.type ?? head.type ?? "",
      file: row.file ?? head.file ?? "",
      disposition: row.disposition,
      reason: row.reason,
      owner: row.owner ?? "",
      date: row.date ?? today,
    };
    if (symbol !== undefined) entry.symbol = symbol;
    return entry;
  });
}

/**
 * Report every problem, not just the first. `formatZodIssues` in
 * `config.ts` deliberately surfaces one — right for a config file a
 * person edits and re-runs, wrong for a payload a caller generates,
 * where each re-run is another round-trip.
 */
function formatAllTriageIssues(issues: z.core.$ZodIssue[]): string {
  if (issues.length === 0) return "validation failed";
  // Paths arrive relative to the entries array (`0.fingerprint`); name
  // the container so the message matches what the caller wrote.
  const lines = issues
    .map((i) => `  entries.${i.path.join(".")}: ${i.message}`)
    .filter((line, i, all) => all.indexOf(line) === i);
  return `${lines.length} problem(s):\n${lines.join("\n")}`;
}

export interface SaveTriageOptions {
  now?: () => Date;
  crimesVersion?: string;
}

export async function saveTriage(
  path: string,
  triage: Triage,
  options: SaveTriageOptions = {},
): Promise<void> {
  const now = (options.now ?? systemClock)();
  const out: Triage = {
    ...triage,
    updated_at: now.toISOString(),
  };
  if (options.crimesVersion) out.crimes_version = options.crimesVersion;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(out, null, 2) + "\n", "utf8");
}

export function upsertTriageEntry(
  triage: Triage,
  entry: TriageEntry,
  options: { now?: () => Date } = {},
): Triage {
  const now = (options.now ?? systemClock)();
  const filtered = triage.entries.filter((e) => e.fingerprint !== entry.fingerprint);
  filtered.push(entry);
  return {
    ...triage,
    updated_at: now.toISOString(),
    entries: filtered,
  };
}

export function emptyTriage(
  options: { now?: () => Date; crimesVersion?: string } = {},
): Triage {
  const now = (options.now ?? systemClock)().toISOString();
  const doc: Triage = {
    schema_version: SCHEMA_VERSION,
    report_type: "triage",
    created_at: now,
    updated_at: now,
    entries: [],
  };
  if (options.crimesVersion) doc.crimes_version = options.crimesVersion;
  return doc;
}

function formatZodIssues(issues: z.core.$ZodIssue[]): string {
  const first = issues[0];
  if (!first) return "validation failed";
  const path = first.path.length > 0 ? first.path.join(".") : "(root)";
  return `${path}: ${first.message}`;
}

function isNodeErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as { code?: unknown }).code === "string";
}
