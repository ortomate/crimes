#!/usr/bin/env tsx
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { OssFixtureMeta } from "./types.js";

const execFileAsync = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const FIXTURES_DIR = resolve(REPO_ROOT, "evals", "fixtures");
const META_FILENAME = ".crimes-eval-meta.json";

/**
 * `pnpm run evals:setup` entry. Walks `evals/fixtures/<NN>-<name>/`
 * directories, reads `.crimes-eval-meta.json` per directory, and
 * clones each OSS upstream at its pinned SHA. Idempotent — directories
 * with the body already present are skipped.
 *
 * Hand-crafted and symlink fixtures need no setup; they're already in
 * the tree. The script is a no-op when no OSS meta files exist.
 */
async function main(): Promise<void> {
  if (!existsSync(FIXTURES_DIR)) {
    process.stdout.write(
      `evals:setup: ${FIXTURES_DIR} does not exist — nothing to set up.\n`,
    );
    return;
  }

  const subdirs = readdirSync(FIXTURES_DIR).filter((name) => {
    const full = resolve(FIXTURES_DIR, name);
    try {
      return statSync(full).isDirectory();
    } catch {
      return false;
    }
  });

  const ossEntries: Array<{ dir: string; meta: OssFixtureMeta }> = [];
  for (const name of subdirs) {
    const metaPath = resolve(FIXTURES_DIR, name, META_FILENAME);
    if (!existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as OssFixtureMeta;
      ossEntries.push({ dir: resolve(FIXTURES_DIR, name), meta });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`evals:setup: failed to parse ${metaPath} — ${message}\n`);
    }
  }

  if (ossEntries.length === 0) {
    process.stdout.write(
      "evals:setup: no OSS clone meta files found — nothing to clone.\n",
    );
    return;
  }

  for (const { dir, meta } of ossEntries) {
    if (meta.archived) {
      process.stdout.write(`evals:setup: ${dir} archived — skipping.\n`);
      continue;
    }
    const hasBody = readdirSync(dir).some(
      (entry) => entry !== META_FILENAME && !entry.startsWith("."),
    );
    if (hasBody) {
      process.stdout.write(
        `evals:setup: ${dir} body already present — skipping clone.\n`,
      );
      continue;
    }
    process.stdout.write(
      `evals:setup: cloning ${meta.upstream}@${meta.sha} into ${dir}\n`,
    );
    try {
      await cloneIntoExistingFixture(dir, meta);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `evals:setup: clone failed for ${meta.upstream}@${meta.sha} — ${message}\n`,
      );
      process.exitCode = 1;
    }
  }
}

/**
 * Clone the upstream into a fixture directory that already exists (it
 * holds the `.crimes-eval-meta.json`). `git clone` refuses to operate on
 * a non-empty dir, so we clone into a tempdir and copy the contents in,
 * preserving the meta file. The .git directory is dropped to keep the
 * fixture body free of upstream commit history (the meta file pins the
 * SHA; we don't need history at runtime).
 */
async function cloneIntoExistingFixture(
  dir: string,
  meta: OssFixtureMeta,
): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), "crimes-eval-clone-"));
  const cloneDir = join(temp, "clone");
  try {
    await execFileAsync("git", ["clone", meta.upstream, cloneDir]);
    await execFileAsync("git", ["-C", cloneDir, "checkout", meta.sha]);
    await rm(join(cloneDir, ".git"), { recursive: true, force: true });
    // Move every entry in cloneDir into dir, preserving the existing
    // meta file. Skip any name collision (shouldn't happen — the
    // fixture dir contains only `.crimes-eval-meta.json` at this point).
    for (const entry of readdirSync(cloneDir)) {
      const src = join(cloneDir, entry);
      const dest = join(dir, entry);
      if (existsSync(dest)) continue;
      await rename(src, dest);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`evals:setup: ${message}\n`);
  process.exit(1);
});
