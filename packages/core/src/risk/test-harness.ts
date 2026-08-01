import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseFile } from "@crimes/language-js";
import { DEFAULT_CONFIG, type CrimesConfig } from "../config.js";
import type { LanguageJsDetectorContext, UniversalDetectorContext } from "../detector.js";
import { discoverFiles } from "../discovery/index.js";
import { buildAgentConfigIndex } from "../agents/build.js";
import { buildIaIndex } from "../ia/build.js";
import { buildImportGraph } from "../imports/build.js";
import { buildManifestIndex } from "../manifest/build.js";
import { buildRiskIndex } from "./build.js";
import { discoverEnvInventoryFiles } from "./env-inventory.js";

/**
 * Shared harness for the 0.16.0 detector tests.
 *
 * Every one of these detectors needs a *repo*, not a source string: they
 * read cross-file indexes, manifests, or agent configuration. Writing a
 * temp tree and building the real indexes — rather than hand-stubbing
 * them — is what makes the tests meaningful. A stubbed index would pass
 * while the builder that produces it in production was broken.
 *
 * Not exported from the package index: this is test infrastructure, and
 * shipping it would make it part of the public contract.
 */

export interface TestRepo {
  root: string;
  files: string[];
}

/** Write a temp repo from a `{ path: contents }` map. */
export async function makeRepo(
  files: Record<string, string>,
  prefix = "crimes-risk-",
): Promise<TestRepo> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  const discovered = await discoverFiles({
    root,
    include: DEFAULT_CONFIG.include,
    exclude: DEFAULT_CONFIG.exclude,
  });
  return { root, files: discovered };
}

/**
 * A language-js detector context for one file in a temp repo, with every
 * cross-file index built for real.
 */
export async function jsContext(
  repo: TestRepo,
  file: string,
  config: CrimesConfig = DEFAULT_CONFIG,
): Promise<LanguageJsDetectorContext> {
  const absolutePath = join(repo.root, file);
  const source = await readSource(absolutePath);
  const envInventoryFiles = await discoverEnvInventoryFiles(repo.root);
  const risk = await buildRiskIndex({
    root: repo.root,
    files: repo.files,
    envInventoryFiles,
  });
  return {
    kind: "language-js",
    file,
    absolutePath,
    source,
    parsed: parseFile({ absolutePath, source }),
    config,
    risk,
  };
}

/**
 * A universal detector context for one file in a temp repo. Builds the
 * manifest, agent-config, IA, and import indexes — the four a
 * universal-pack 0.16.0 detector can read.
 */
export async function universalContext(
  repo: TestRepo,
  file: string,
  config: CrimesConfig = DEFAULT_CONFIG,
): Promise<UniversalDetectorContext> {
  const absolutePath = join(repo.root, file);
  const source = await readSource(absolutePath);
  const [manifest, agentConfig, ia, imports] = await Promise.all([
    buildManifestIndex({ root: repo.root }),
    buildAgentConfigIndex({ root: repo.root }),
    buildIaIndex({ root: repo.root, files: repo.files }),
    buildImportGraph({ root: repo.root, files: repo.files }),
  ]);
  const lineCount = source.split(/\r?\n/).length;
  return {
    kind: "universal",
    file,
    absolutePath,
    extension: extensionOf(file),
    readSource: async () => source,
    byteSize: Buffer.byteLength(source),
    lineCount,
    config,
    ia,
    imports,
    manifest,
    agentConfig,
  };
}

/**
 * The repo-level anchor file — the lexicographically first file in the
 * IA index. Repo-level detectors only emit when `ctx.file` is this, so
 * tests must ask rather than guess.
 */
export async function repoAnchorFile(repo: TestRepo): Promise<string> {
  const ia = await buildIaIndex({ root: repo.root, files: repo.files });
  const files = Object.keys(ia.files).sort();
  if (files[0] === undefined) {
    throw new Error("test repo produced no IA-indexed files");
  }
  return files[0];
}

/** Build a config carrying options for one detector. */
export function configWithOptions(detectorId: string, options: unknown): CrimesConfig {
  return {
    ...DEFAULT_CONFIG,
    detectors: { options: { [detectorId]: options } },
  };
}

async function readSource(absolutePath: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(absolutePath, "utf8");
}

function extensionOf(file: string): string {
  const idx = file.lastIndexOf(".");
  return idx === -1 ? "" : file.slice(idx).toLowerCase();
}
