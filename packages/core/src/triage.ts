import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { systemClock } from "./clock.js";
import { SCHEMA_VERSION } from "./finding.js";

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
const ACCEPTED_TRIAGE_SCHEMA_VERSIONS = ["0.2.0", "0.3.0", "0.4.0", "0.5.0"] as const;

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

export const TriageEntrySchema = z
  .object({
    fingerprint: z.string().min(1),
    type: z.string().min(1),
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
