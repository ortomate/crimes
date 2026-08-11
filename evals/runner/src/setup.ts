#!/usr/bin/env tsx
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { RANKING_REFERENCE_DATE } from "./scan-helpers.js";
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

  await materialiseSyntheticHistory();

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

/**
 * Age tranches for `16-recency`, in days before
 * {@link RANKING_REFERENCE_DATE}.
 *
 * The paths are committed in this order, oldest first, so a file's
 * `recency` is a property of the tranche it sits in rather than of when
 * anybody ran setup:
 *
 * ```
 * 90d  src/legacy/    recency 0
 * 20d  src/core/      recency 0     (churn still live)
 *  9d  test/          recency ~0.71 (mid-decay)
 *  3d  src/checkout/  recency 1.0   (full boost)
 * ```
 */
const RECENCY_TRANCHES: ReadonlyArray<{
  days: number;
  paths: string[];
  message: string;
}> = [
  {
    days: 90,
    paths: ["README.md", "package.json", "src/legacy"],
    message: "legacy: settlement and payouts",
  },
  { days: 20, paths: ["src/core"], message: "core: pricing, config, shared types" },
  { days: 9, paths: ["test"], message: "test: basket coverage" },
  { days: 3, paths: ["src/checkout"], message: "checkout: new basket + session flow" },
];

/**
 * Build `16-recency`'s git history from scratch, dated relative to the
 * pinned reference date.
 *
 * ## Why this fixture needs its own repository
 *
 * `recency` is the one scoring input no eval fixture could exercise.
 * `rank_score = agent_risk * (1 + recency * 0.5)` applies a multiplier
 * larger than any single `agent_risk` term — measured at `0.25.10` it
 * reorders 99.9% of a real report — and the four deep fixtures are all
 * months old, so it is 0 on every one of their findings and
 * `rank_score` collapses to `agent_risk`. A term the metric cannot see
 * cannot be validated, tuned or removed.
 *
 * ## Why the dates are relative and the history is rebuilt
 *
 * Committing a `.git` directory would freeze the ages at authoring time
 * and they would decay past 14 days within a fortnight, taking the
 * fixture's whole purpose with them. Deriving them from
 * `RANKING_REFERENCE_DATE` instead means the tranches hold their
 * `recency` for as long as the constant does, and both move together
 * when somebody bumps it deliberately.
 *
 * Rebuilt from scratch on every run rather than updated, so the result
 * is a function of the tree and the constant alone.
 */
async function materialiseSyntheticHistory(): Promise<void> {
  const dir = resolve(FIXTURES_DIR, "16-recency");
  if (!existsSync(dir)) return;

  const refMs = Date.parse(RANKING_REFERENCE_DATE);
  if (!Number.isFinite(refMs)) {
    process.stderr.write(
      `evals:setup: RANKING_REFERENCE_DATE is unparsable (${RANKING_REFERENCE_DATE}) — skipping 16-recency history.\n`,
    );
    process.exitCode = 1;
    return;
  }

  await rm(resolve(dir, ".git"), { recursive: true, force: true });
  const git = async (...args: string[]): Promise<void> => {
    await execFileAsync("git", args, { cwd: dir });
  };
  await git("init", "--initial-branch=main", "--quiet");
  await git("config", "user.name", "crimes-fixtures");
  await git("config", "user.email", "fixtures@crimes.invalid");
  await git("config", "commit.gpgsign", "false");

  for (const tranche of RECENCY_TRANCHES) {
    const present = tranche.paths.filter((p) => existsSync(resolve(dir, p)));
    if (present.length === 0) continue;
    await git("add", "--", ...present);
    const when = new Date(refMs - tranche.days * 86_400_000).toISOString();
    await execFileAsync(
      "git",
      ["commit", "-m", tranche.message, "--quiet", "--date", when],
      {
        cwd: dir,
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: when,
          GIT_COMMITTER_DATE: when,
        },
      },
    );
  }
  process.stdout.write(
    `evals:setup: 16-recency history rebuilt at ${RANKING_REFERENCE_DATE} ` +
      `(${RECENCY_TRANCHES.length} tranches).\n`,
  );
}
