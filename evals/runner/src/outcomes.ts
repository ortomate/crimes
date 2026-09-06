import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { outcomeCases, type OutcomeCase } from "./outcome-cases.js";
import { runProcess } from "./agents/claude.js";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const cli = resolve(repo, "packages/cli/dist/index.js");
const runAgents = process.argv.includes("--run");
const repeatsIndex = process.argv.indexOf("--repeats");
const repeats = repeatsIndex < 0 ? 1 : Number(process.argv[repeatsIndex + 1]);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10)
  throw new Error("--repeats must be 1–10");

interface Outcome {
  scenario: string;
  repeat: number;
  arm: "without" | "with";
  acceptance_passed: boolean;
  unrelated_edits: string[];
  changed_files: string[];
  elapsed_ms: number;
  exit_code: number;
  transcript: string;
}

async function writeFixture(root: string, scenario: OutcomeCase) {
  for (const [path, source] of Object.entries({
    "package.json": '{"type":"module","private":true}',
    ...scenario.files,
  })) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), source);
  }
}

async function acceptance(root: string, scenario: OutcomeCase): Promise<boolean> {
  const path = join(root, "acceptance.mjs");
  await writeFile(
    path,
    'import assert from "node:assert/strict";\n' + scenario.acceptance + "\n",
  );
  const result = spawnSync(process.execPath, [path], { cwd: root, timeout: 10000 });
  await rm(path);
  return result.status === 0;
}

async function filesIn(root: string, prefix = ""): Promise<string[]> {
  const found: string[] = [];
  for (const item of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = join(prefix, item.name);
    if (item.isDirectory()) found.push(...(await filesIn(root, path)));
    else found.push(path);
  }
  return found.sort();
}

async function runArm(
  scenario: OutcomeCase,
  arm: "without" | "with",
  repeat: number,
): Promise<Outcome> {
  const root = await mkdtemp(join(tmpdir(), "crimes-outcome-"));
  try {
    await writeFixture(root, scenario);
    const originals = new Map(
      await Promise.all(
        (await filesIn(root)).map(
          async (file) => [file, await readFile(join(root, file), "utf8")] as const,
        ),
      ),
    );
    const started = Date.now();
    const briefing =
      arm === "with"
        ? spawnSync(
            process.execPath,
            [cli, "context", scenario.target, "--root", root, "--format", "json"],
            { encoding: "utf8" },
          )
        : undefined;
    if (briefing && briefing.status !== 0) throw new Error(briefing.stderr);
    const prompt = `${scenario.task}\nImplement the change in this directory. Do not commit, access the network, change package.json, or use crimes separately. Tests will be run after your edit.\n${briefing ? `Pre-edit briefing:\n${briefing.stdout}` : "Inspect the source files to plan your change."}`;
    const result = await runProcess(
      "codex",
      [
        "exec",
        "--ignore-user-config",
        "--ephemeral",
        "--sandbox",
        "workspace-write",
        "--skip-git-repo-check",
        "--cd",
        root,
        "--json",
        prompt,
      ],
      300000,
      root,
    );
    const changed: string[] = [];
    const current = await filesIn(root);
    for (const file of new Set([...originals.keys(), ...current])) {
      if (
        !current.includes(file) ||
        !originals.has(file) ||
        (await readFile(join(root, file), "utf8")) !== originals.get(file)
      )
        changed.push(file);
    }
    return {
      scenario: scenario.id,
      repeat,
      arm,
      acceptance_passed: await acceptance(root, scenario),
      unrelated_edits: changed.filter((file) => !scenario.allowed.includes(file)),
      changed_files: changed,
      elapsed_ms: Date.now() - started,
      exit_code: result.exitCode,
      transcript: result.stdout.replaceAll(root, "<workspace>"),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  // These tasks must fail before an edit; otherwise a "success" could be vacuous.
  for (const scenario of outcomeCases) {
    const root = await mkdtemp(join(tmpdir(), "crimes-outcome-check-"));
    try {
      await writeFixture(root, scenario);
      if (await acceptance(root, scenario))
        throw new Error(`${scenario.id}: acceptance already passes before any edit`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  if (!runAgents) {
    process.stdout.write(
      `${outcomeCases.length} non-vacuous outcome tasks verified; use --run for paired agent edits.\n`,
    );
    return;
  }
  const version = JSON.parse(
    await readFile(join(repo, "packages/cli/package.json"), "utf8"),
  ).version;
  const output = join(repo, "evals/results", version, "outcomes.json");
  const rows: Outcome[] = [];
  for (let repeat = 0; repeat < repeats; repeat++) {
    for (const [index, scenario] of outcomeCases.entries()) {
      const arms: Array<"with" | "without"> =
        (repeat + index) % 2 === 0 ? ["without", "with"] : ["with", "without"];
      for (const arm of arms) {
        process.stdout.write(`${scenario.id} ${arm} crimes, repeat ${repeat + 1}\n`);
        rows.push(await runArm(scenario, arm, repeat + 1));
        await mkdir(dirname(output), { recursive: true });
        await writeFile(
          output,
          JSON.stringify(
            {
              crimes_version: version,
              agent_cli: spawnSync("codex", ["--version"], {
                encoding: "utf8",
              }).stdout.trim(),
              design:
                "paired isolated edits; acceptance installed after edits; alternating arm order; default CLI model; no user config",
              rows,
            },
            null,
            2,
          ) + "\n",
        );
      }
    }
  }
  for (const arm of ["without", "with"] as const) {
    const sample = rows.filter((row) => row.arm === arm);
    process.stdout.write(
      `${arm}: ${sample.filter((row) => row.acceptance_passed).length}/${sample.length} acceptance passes; ${sample.filter((row) => row.unrelated_edits.length).length} runs with unrelated edits\n`,
    );
  }
}
await main();
