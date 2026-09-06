import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { SCHEMA_VERSION, type Finding } from "./finding.js";

import {
  PIN_FILES as FILES,
  type PinFile,
  type PinUpdate,
  assertNoPendingMigration,
  writePinUpdates,
} from "./pin-migration-transaction.js";
type Pin = Record<string, unknown> & { fingerprint: string };
interface PinDocument {
  path: PinFile;
  hash: string;
  raw: string;
  body: Record<string, unknown>;
  key: string;
  pins: Pin[];
}

const rowSchema = z
  .object({
    source: z.enum(FILES),
    from: z.string(),
    status: z.enum(["unchanged", "candidate", "ambiguous", "not_reported"]),
    candidates: z.array(z.string()),
    to: z.string().optional(),
  })
  .strict();
const planSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    report_type: z.literal("pin_migration"),
    source_hashes: z.record(z.string(), z.string()),
    entries: z.array(rowSchema),
  })
  .strict();
export type PinMigrationPlan = z.infer<typeof planSchema>;

export interface PinMigrationRecoveryReport {
  schema_version: typeof SCHEMA_VERSION;
  report_type: "pin_migration_recovery";
  restored_files: number;
}

/** Preview only. No reasons, owners, dates, expiry pins or dispositions are inferred. */
export async function previewPinMigration(
  root: string,
  findings: readonly Finding[],
): Promise<PinMigrationPlan> {
  const documents = await readDocuments(root);
  return {
    schema_version: SCHEMA_VERSION,
    report_type: "pin_migration",
    source_hashes: Object.fromEntries(documents.map((doc) => [doc.path, doc.hash])),
    entries: documents.flatMap((doc) =>
      doc.pins.map((pin) => migrationRow(doc.path, pin.fingerprint, findings)),
    ),
  };
}

function migrationRow(
  source: PinFile,
  from: string,
  findings: readonly Finding[],
): z.infer<typeof rowSchema> {
  if (findings.some((finding) => finding.fingerprint === from))
    return { source, from, status: "unchanged", candidates: [] };
  const [head = "", file = "", symbol = "", ...discriminator] = from.split("::");
  const [type, claim] = head.split("/");
  const candidates = [
    ...new Set(
      findings
        .filter(
          (finding) =>
            finding.type === type &&
            finding.file === file &&
            (finding.symbol ?? "") === symbol &&
            (claim === undefined || finding.claim === claim) &&
            (discriminator.length === 0 ||
              finding.discriminator === discriminator.join("::")),
        )
        .map((finding) => finding.fingerprint),
    ),
  ].sort();
  return {
    source,
    from,
    candidates,
    status:
      candidates.length === 0
        ? "not_reported"
        : candidates.length === 1
          ? "candidate"
          : "ambiguous",
    ...(candidates.length === 1 ? { to: candidates[0]! } : {}),
  };
}

/**
 * Apply a reviewed plan. Revalidate every destination against a fresh scan
 * and every source against its digest before writing anything. Unselected
 * and no-longer-reported pins remain intact; absence never proves a fix.
 */
export async function applyPinMigration(
  root: string,
  input: unknown,
  findings: readonly Finding[],
): Promise<number> {
  const plan = planSchema.parse(input);
  const documents = await readDocuments(root);
  const currentHashes = Object.fromEntries(documents.map((doc) => [doc.path, doc.hash]));
  if (
    Object.keys(currentHashes).length !== Object.keys(plan.source_hashes).length ||
    Object.entries(currentHashes).some(
      ([path, hash]) => plan.source_hashes[path] !== hash,
    )
  ) {
    throw new Error(
      "Pin files changed since the preview; generate and review a new plan.",
    );
  }
  const updates = validateSelections(plan, documents, findings);
  let migrated = 0;
  const replacements: PinUpdate[] = [];
  for (const doc of documents) {
    const selected = updates.get(doc.path);
    if (!selected?.size) continue;
    const pins = doc.pins.map((pin) => {
      const finding = selected.get(pin.fingerprint);
      if (!finding) return pin;
      migrated += 1;
      const next: Pin = {
        ...pin,
        fingerprint: finding.fingerprint,
        type: finding.type,
        file: finding.file,
      };
      if (finding.claim) next.claim = finding.claim;
      else delete next.claim;
      if (finding.symbol) next.symbol = finding.symbol;
      else delete next.symbol;
      return next;
    });
    replacements.push({
      name: doc.path,
      before: doc.raw,
      after: JSON.stringify({ ...doc.body, [doc.key]: pins }, null, 2) + "\n",
    });
  }
  await writePinUpdates(root, replacements);
  return migrated;
}

function validateSelections(
  plan: PinMigrationPlan,
  documents: PinDocument[],
  findings: readonly Finding[],
) {
  const updates = new Map<PinFile, Map<string, Finding>>();
  const seen = new Set<string>();
  for (const row of plan.entries) {
    if (row.to === undefined) continue;
    const doc = documents.find((item) => item.path === row.source);
    if (!doc?.pins.some((pin) => pin.fingerprint === row.from))
      throw new Error(`Unknown source pin: ${row.from}`);
    const current = migrationRow(row.source, row.from, findings);
    if (!current.candidates.includes(row.to))
      throw new Error(`Destination no longer matches the recorded subject: ${row.to}`);
    const key = `${row.source}\0${row.from}`;
    if (seen.has(key)) throw new Error(`Duplicate migration for ${row.from}`);
    seen.add(key);
    const destinations = updates.get(row.source) ?? new Map<string, Finding>();
    if (
      doc.pins.some((pin) => pin.fingerprint === row.to) ||
      [...destinations.values()].some((f) => f.fingerprint === row.to)
    ) {
      throw new Error(
        `Destination already has a decision; resolve it manually: ${row.to}`,
      );
    }
    destinations.set(
      row.from,
      findings.find((finding) => finding.fingerprint === row.to)!,
    );
    updates.set(row.source, destinations);
  }
  return updates;
}

async function readDocuments(root: string): Promise<PinDocument[]> {
  await assertNoPendingMigration(root);
  const documents: PinDocument[] = [];
  for (const path of FILES) {
    let raw: string;
    try {
      raw = await readFile(join(root, ".crimes", path), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const body = z.record(z.string(), z.unknown()).parse(JSON.parse(raw));
    const key = {
      "baseline.json": "findings",
      "triage.json": "entries",
      "suppressions.json": "suppressions",
    }[path];
    const pins = z
      .array(z.object({ fingerprint: z.string() }).passthrough())
      .parse(body[key]);
    documents.push({
      path,
      raw,
      hash: createHash("sha256").update(raw).digest("hex"),
      body,
      key,
      pins,
    });
  }
  return documents;
}
