import {
  type Stats,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";

export interface SetupFile {
  path: string;
  before: string | undefined;
  after: string;
}

/** Check ancestors as well as the file: setup never follows project symlinks. */
export function readSetupFile(root: string, path: string): string | undefined {
  const rel = relative(resolve(root), resolve(root, path));
  if (rel.startsWith(`..${sep}`) || rel === "..")
    throw new Error("Setup path escapes root");
  const parts = rel.split(sep);
  let cursor = resolve(root);
  for (let i = 0; i < parts.length; i++) {
    cursor = join(cursor, parts[i]!);
    let stat: Stats;
    try {
      stat = lstatSync(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const valid = i === parts.length - 1 ? stat.isFile() : stat.isDirectory();
    if (stat.isSymbolicLink() || !valid) {
      throw new Error(
        `${path}: expected regular files/directories, not links or other types`,
      );
    }
  }
  return readFileSync(resolve(root, path), "utf8");
}

interface StagedFile {
  plan: SetupFile;
  target: string;
  staged: string;
  backup?: string;
}

function unchanged(root: string, plan: SetupFile): void {
  if (readSetupFile(root, plan.path) !== plan.before) {
    throw new Error(`${plan.path} changed during setup; retry after reviewing it`);
  }
}

function stageFile(root: string, plan: SetupFile, temporary: string[]): StagedFile {
  unchanged(root, plan);
  const target = resolve(root, plan.path);
  mkdirSync(dirname(target), { recursive: true });
  const staged = join(dirname(target), `.crimes-setup-${randomUUID()}`);
  const mode = plan.before === undefined ? 0o644 : lstatSync(target).mode & 0o777;
  temporary.push(staged);
  writeFileSync(staged, plan.after, { flag: "wx", mode });
  let backup: string | undefined;
  if (plan.before !== undefined) {
    backup = `${staged}.backup`;
    temporary.push(backup);
    writeFileSync(backup, plan.before, { flag: "wx", mode });
  }
  return { plan, target, staged, backup };
}

function rollback(root: string, committed: StagedFile[], temporary: string[]): void {
  const failures: string[] = [];
  for (const entry of committed.reverse()) {
    try {
      if (readSetupFile(root, entry.plan.path) !== entry.plan.after) {
        throw new Error("file changed after setup wrote it");
      }
      if (entry.backup) renameSync(entry.backup, entry.target);
      else rmSync(entry.target);
    } catch {
      if (entry.backup) temporary.splice(temporary.indexOf(entry.backup), 1);
      failures.push(
        `${entry.plan.path}${entry.backup ? ` (original retained at ${entry.backup})` : " (new file retained)"}`,
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(`Setup failed and could not restore: ${failures.join(", ")}`);
  }
}

/** Stage every file first; roll back completed replacements on a write error. */
export function applySetupFiles(root: string, plans: SetupFile[]): void {
  const temporary: string[] = [];
  const committed: StagedFile[] = [];
  try {
    const staged = plans.map((plan) => stageFile(root, plan, temporary));
    for (const entry of staged) {
      unchanged(root, entry.plan);
      renameSync(entry.staged, entry.target);
      committed.push(entry);
    }
  } catch (error) {
    rollback(root, committed, temporary);
    throw error;
  } finally {
    for (const path of temporary) rmSync(path, { force: true });
  }
}
