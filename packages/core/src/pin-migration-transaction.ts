import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const PIN_FILES = ["triage.json", "suppressions.json", "baseline.json"] as const;
export type PinFile = (typeof PIN_FILES)[number];
export interface PinUpdate {
  name: PinFile;
  before: string;
  after: string;
}
const DIRECTORY = ".pin-migration";
const journalSchema = z
  .object({
    format: z.literal(1),
    files: z
      .array(
        z
          .object({
            name: z.enum(PIN_FILES),
            before: z.string(),
            after: z.string(),
            mode: z.number().int().min(0).max(0o777),
          })
          .strict(),
      )
      .min(1)
      .max(3),
  })
  .strict();

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function assertNoPendingMigration(root: string): Promise<void> {
  try {
    await stat(join(root, ".crimes", DIRECTORY));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(
    "Unfinished pin migration; stop other migration processes, then run crimes migrate-pins --recover.",
  );
}

/** Stage everything and retain original bytes before replacing the first pin. */
export async function writePinUpdates(root: string, updates: PinUpdate[]): Promise<void> {
  if (updates.length === 0) return;
  const directory = join(root, ".crimes", DIRECTORY);
  try {
    await mkdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      await assertNoPendingMigration(root);
    }
    throw error;
  }
  let journalReady = false;
  try {
    const files = [];
    for (const update of updates) {
      const path = join(root, ".crimes", update.name);
      if (hash(await readFile(path, "utf8")) !== hash(update.before)) {
        throw new Error(
          "Pin files changed while preparing migration; review a new plan.",
        );
      }
      files.push({ ...update, mode: (await stat(path)).mode & 0o777 });
    }
    await durableWrite(
      join(directory, "journal.tmp"),
      JSON.stringify({ format: 1, files }),
      0o600,
    );
    await rename(join(directory, "journal.tmp"), join(directory, "journal.json"));
    journalReady = true;
    for (const file of files) {
      await durableWrite(join(directory, `${file.name}.next`), file.after, file.mode);
    }
    // Recheck every source after staging, before any destination is replaced.
    await validateCurrent(root, files, false);
    for (const file of files) {
      await rename(
        join(directory, `${file.name}.next`),
        join(root, ".crimes", file.name),
      );
    }
    await rm(directory, { recursive: true });
  } catch (error) {
    if (!journalReady) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    try {
      await recoverPinUpdates(root);
    } catch {
      throw new Error(
        "Pin migration interrupted; recovery files were retained. Stop other migration processes, then run crimes migrate-pins --recover. Recovery refuses to overwrite later edits.",
        { cause: error },
      );
    }
    throw new Error(
      "Pin migration failed; original pin files were restored. Generate and review a new plan before retrying.",
      { cause: error },
    );
  }
}

/** Explicit crash recovery. Validate ALL files before restoring ANY file. */
export async function recoverPinUpdates(root: string): Promise<number> {
  const directory = join(root, ".crimes", DIRECTORY);
  let raw: string;
  try {
    raw = await readFile(join(directory, "journal.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // No complete journal means this protocol has not replaced any pins.
    // Keep incomplete artifacts for inspection instead of guessing ownership.
    throw new Error(
      "No complete migration journal. Inspect .crimes/.pin-migration; no pin replacement starts before journal.json is complete.",
    );
  }
  const journal = journalSchema.parse(JSON.parse(raw));
  if (new Set(journal.files.map((file) => file.name)).size !== journal.files.length) {
    throw new Error("Duplicate file in migration recovery journal.");
  }
  await validateCurrent(root, journal.files, true);
  for (const file of journal.files) {
    const temporary = join(directory, `${file.name}.restore`);
    await rm(temporary, { force: true });
    await durableWrite(temporary, file.before, file.mode);
  }
  for (const file of journal.files) {
    await rename(
      join(directory, `${file.name}.restore`),
      join(root, ".crimes", file.name),
    );
  }
  await rm(directory, { recursive: true });
  return journal.files.length;
}

async function validateCurrent(
  root: string,
  files: PinUpdate[],
  allowMigrated: boolean,
): Promise<void> {
  for (const file of files) {
    const current = hash(await readFile(join(root, ".crimes", file.name), "utf8"));
    if (
      current !== hash(file.before) &&
      (!allowMigrated || current !== hash(file.after))
    ) {
      throw new Error(
        `Pin file changed outside migration: ${file.name}. Preserve the later edit and reconcile the retained journal manually.`,
      );
    }
  }
}

async function durableWrite(path: string, contents: string, mode: number): Promise<void> {
  const handle = await open(path, "wx", mode);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}
