// Local publish smoke test for the `crimes` CLI.
//
// Pretends to be an end user:
//   1. Builds the workspace.
//   2. Packs the CLI into a tarball (`npm pack`).
//   3. Installs that tarball into a clean temp directory (no workspace
//      resolution magic, so this catches missing runtime deps).
//   4. Runs `crimes --help`, `crimes --version`, `crimes scan`, and
//      `crimes scan --format json` against examples/messy-ts-app.
//   5. Asserts the JSON output conforms to the documented schema shape.
//
// Run with: `pnpm --filter crimes smoke` (or `pnpm -F crimes run smoke`).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliDir = resolve(here, "..");
const repoRoot = resolve(cliDir, "..", "..");
const fixture = resolve(repoRoot, "examples", "messy-ts-app");

const pkg = JSON.parse(readFileSync(resolve(cliDir, "package.json"), "utf8"));
const expectedVersion = pkg.version;
const expectedName = pkg.name;
const expectedBin = Object.keys(pkg.bin)[0];

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`command failed (${result.status}): ${cmd} ${args.join(" ")}`);
  }
  return result;
}

function step(label) {
  process.stdout.write(`\n▸ ${label}\n`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`smoke: assertion failed — ${message}`);
  }
}

step("Sanity check");
assert(
  expectedName === "crimes",
  `package name must be "crimes" (got "${expectedName}")`,
);
assert(expectedBin === "crimes", `binary name must be "crimes" (got "${expectedBin}")`);

step("Build workspace");
// Build every package, not just the CLI: tsup bundles `@crimes/core` and
// `@crimes/reporter` into the CLI via `noExternal`, and esbuild resolves
// them through their `exports` field — which points at `dist/index.js`.
// `pnpm --filter crimes build` alone leaves those workspace deps unbuilt
// and esbuild fails to resolve them on a fresh runner.
run("pnpm", ["run", "build"], { cwd: repoRoot });

step("npm pack");
const packResult = run("npm", ["pack", "--json"], { cwd: cliDir });
const packJson = JSON.parse(packResult.stdout);
const packed = Array.isArray(packJson) ? packJson[0] : packJson[expectedName];
assert(packed?.filename, "npm pack did not report the expected package tarball");
const tarballName = packed.filename.replace(/^@.*\//, "").replace(/\//g, "-");
const tarballPath = resolve(cliDir, tarballName);
process.stdout.write(`  tarball: ${tarballName}\n`);
process.stdout.write(`  packed size: ${(packed.size / 1024).toFixed(1)} KB\n`);
process.stdout.write(`  unpacked size: ${(packed.unpackedSize / 1024).toFixed(1)} KB\n`);

const filePaths = packed.files.map((f) => f.path).sort();
process.stdout.write(`  files: ${filePaths.join(", ")}\n`);
const expectedFiles = ["LICENSE", "README.md", "dist/index.js", "package.json"];
for (const must of expectedFiles) {
  assert(filePaths.includes(must), `tarball is missing ${must}`);
}
for (const path of filePaths) {
  assert(!path.endsWith(".map"), `tarball should not ship sourcemaps (found ${path})`);
  assert(
    !path.startsWith("scripts/"),
    `tarball should not ship dev scripts (found ${path})`,
  );
  assert(!path.startsWith("src/"), `tarball should not ship raw sources (found ${path})`);
}

step("Install tarball into temp dir");
const tmp = mkdtempSync(join(tmpdir(), "crimes-smoke-"));
let installRoot;
try {
  installRoot = tmp;
  writeFileSync(
    join(installRoot, "package.json"),
    JSON.stringify({ name: "crimes-smoke", version: "0.0.0", private: true }, null, 2),
  );
  run("npm", ["install", "--no-audit", "--no-fund", "--silent", tarballPath], {
    cwd: installRoot,
  });
  const installedBin = join(installRoot, "node_modules", ".bin", "crimes");
  process.stdout.write(`  installed bin: ${installedBin}\n`);

  // npm >= 11.18 blocks install scripts by default and prints an
  // `allow-scripts` warning asking the user to approve arbitrary code
  // execution. A tool whose pitch is trustworthiness should not spend that
  // prompt — least of all on a banner npm swallows anyway. Any lifecycle
  // script in the packed manifest brings the warning back.
  step("no install lifecycle scripts");
  const installedManifest = JSON.parse(
    readFileSync(join(installRoot, "node_modules", "crimes", "package.json"), "utf8"),
  );
  const lifecycle = ["preinstall", "install", "postinstall", "prepare"];
  for (const name of lifecycle) {
    assert(
      installedManifest.scripts?.[name] === undefined,
      `packed package.json must not declare a "${name}" script (found "${installedManifest.scripts?.[name]}") — it triggers npm's allow-scripts prompt`,
    );
  }
  process.stdout.write(
    `  → scripts: ${JSON.stringify(installedManifest.scripts ?? {})}\n`,
  );

  step("crimes --version");
  const versionOut = run(installedBin, ["--version"]).stdout.trim();
  process.stdout.write(`  → ${versionOut}\n`);
  assert(
    versionOut === expectedVersion,
    `--version printed "${versionOut}", expected "${expectedVersion}"`,
  );

  step("crimes --help");
  const helpOut = run(installedBin, ["--help"]).stdout;
  assert(helpOut.includes("crimes"), "--help did not mention `crimes`");
  assert(helpOut.includes("crimes context"), "--help did not mention `crimes context`");
  assert(helpOut.includes("scan"), "--help did not list the `scan` command");
  assert(helpOut.includes("context"), "--help did not list the `context` command");
  assert(helpOut.includes("hotspots"), "--help did not list the `hotspots` command");
  assert(helpOut.includes("diff"), "--help did not list the `diff` command");

  step("crimes diff --help");
  // We can't run a real `diff` here — the smoke fixture/cwd are not a git
  // repo. But `--help` exercises the command registration and confirms
  // the new flags wired up cleanly.
  const diffHelpOut = run(installedBin, ["diff", "--help"]).stdout;
  assert(
    diffHelpOut.includes("<range>"),
    "diff --help did not mention the <range> argument",
  );
  assert(diffHelpOut.includes("--format"), "diff --help did not list --format");

  step("crimes diff in a non-git dir (should exit 2)");
  // Run the binary from the smoke install root, which is just a temp dir
  // with no git history. The diff command should fail cleanly with
  // exit 2 — not 0, not 1, not a crash.
  const diffNonGit = spawnSync(installedBin, ["diff", "main...HEAD"], {
    cwd: installRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert(
    diffNonGit.status === 2,
    `diff in non-git dir should exit 2, got ${diffNonGit.status}`,
  );
  assert(
    /not a git repository/.test(diffNonGit.stderr ?? ""),
    `diff in non-git dir should mention "not a git repository", got: ${diffNonGit.stderr}`,
  );

  step("crimes scan (human, --no-color)");
  const scanOut = run(installedBin, ["scan", fixture, "--no-color"]).stdout;
  assert(
    scanOut.includes("CRIME SCENE REPORT"),
    "human scan output missing CRIME SCENE REPORT header",
  );

  step("crimes scan --format json");
  const jsonOut = run(installedBin, ["scan", fixture, "--format", "json"]).stdout;
  const report = JSON.parse(jsonOut);
  assert(typeof report.schema_version === "string", "missing schema_version");
  assert(Array.isArray(report.findings), "findings is not an array");
  assert(typeof report.summary?.total === "number", "summary.total missing");
  assert(
    report.findings.length === report.summary.total,
    "summary.total disagrees with findings.length",
  );
  process.stdout.write(
    `  → schema ${report.schema_version}, ${report.summary.total} findings\n`,
  );

  step("crimes context (human, --no-color)");
  const ctxHumanOut = run(installedBin, [
    "context",
    "src/billing.ts",
    "--root",
    fixture,
    "--no-color",
  ]).stdout;
  assert(
    ctxHumanOut.includes("CRIMES CONTEXT"),
    "human context output missing CRIMES CONTEXT header",
  );
  assert(
    ctxHumanOut.includes("src/billing.ts"),
    "human context output should mention the file",
  );

  step("crimes context --format json");
  const ctxJsonOut = run(installedBin, [
    "context",
    "src/billing.ts",
    "--root",
    fixture,
    "--format",
    "json",
  ]).stdout;
  const ctxReport = JSON.parse(ctxJsonOut);
  for (const key of [
    "schema_version",
    "file",
    "risk",
    "findings",
    "likely_tests",
    "agent_guidance",
  ]) {
    assert(key in ctxReport, `context JSON missing required key "${key}"`);
  }
  assert(
    ctxReport.file === "src/billing.ts",
    `context.file should be "src/billing.ts", got "${ctxReport.file}"`,
  );
  process.stdout.write(
    `  → ${ctxReport.findings.length} findings, ${ctxReport.likely_tests.length} likely tests, risk=${ctxReport.risk?.level}\n`,
  );

  step("crimes hotspots (human, --no-color)");
  const hotHumanOut = run(installedBin, ["hotspots", fixture, "--no-color"]).stdout;
  assert(
    hotHumanOut.includes("CRIMES HOTSPOTS"),
    "human hotspots output missing CRIMES HOTSPOTS header",
  );

  step("crimes migrate-pins preview from installed tarball");
  const migration = JSON.parse(
    run(installedBin, ["migrate-pins", fixture, "--format", "json"]).stdout,
  );
  assert(
    migration.report_type === "pin_migration",
    "pin migration report discriminator missing",
  );
  assert(Array.isArray(migration.entries), "pin migration entries missing");

  step("crimes hotspots --format json");
  const hotJsonOut = run(installedBin, ["hotspots", fixture, "--format", "json"]).stdout;
  const hotReport = JSON.parse(hotJsonOut);
  for (const key of ["schema_version", "since", "git_available", "hotspots"]) {
    assert(key in hotReport, `hotspots JSON missing required key "${key}"`);
  }
  assert(Array.isArray(hotReport.hotspots), "hotspots JSON: hotspots is not an array");
  assert(
    hotReport.since === "90d",
    `hotspots JSON: default since should be "90d", got "${hotReport.since}"`,
  );
  for (const h of hotReport.hotspots) {
    for (const key of [
      "file",
      "change_count",
      "finding_count",
      "highest_severity",
      "risk",
    ]) {
      assert(key in h, `hotspot row missing required key "${key}"`);
    }
    assert(
      typeof h.risk === "number" && h.risk >= 0 && h.risk <= 1,
      `hotspot risk should be in [0,1], got ${h.risk}`,
    );
  }
  process.stdout.write(
    `  → ${hotReport.hotspots.length} hotspots, git_available=${hotReport.git_available}\n`,
  );

  // The Python pack is the one part of the CLI whose correctness depends on
  // files that are *not* bundled into dist/index.js: two WASM blobs that have
  // to be listed in `files`, copied into dist/ at build time, and located at
  // runtime from inside the bundle. Every other smoke assertion above would
  // still pass with all of that broken — the JS fixture never touches it — so
  // a packaging regression would ship silently. Hence: scan real Python from
  // the installed tarball and require that the pack actually claimed it.
  step("crimes scan on a Python fixture (exercises the vendored WASM grammar)");
  const pyFixture = resolve(repoRoot, "evals", "fixtures", "11-py-service");
  const pyJsonOut = run(installedBin, ["scan", pyFixture, "--format", "json"]).stdout;
  const pyReport = JSON.parse(pyJsonOut);
  assert(
    pyReport.coverage?.packs_loaded?.includes("language-py"),
    "python scan: coverage.packs_loaded is missing language-py",
  );
  assert(
    (pyReport.coverage?.files_by_language?.py ?? 0) > 0,
    "python scan: coverage.files_by_language.py is zero — the pack claimed no files",
  );
  const pyFindings = pyReport.findings.filter((f) => f.pack === "language-py");
  assert(
    pyFindings.length > 0,
    "python scan: no language-py findings — the grammar probably failed to load",
  );
  // blast_radius is derived from the Python import graph. If module
  // resolution silently returned nothing, every finding scores 0 here and the
  // whole pack quietly under-ranks — which is exactly the failure 0.14.0
  // exists to avoid, so assert the graph produced at least one edge.
  assert(
    pyFindings.some((f) => (f.scores?.blast_radius ?? 0) > 0),
    "python scan: every finding has blast_radius 0 — the Python import graph resolved nothing",
  );
  process.stdout.write(
    `  → ${pyReport.coverage.files_by_language.py} python files, ` +
      `${pyFindings.length} language-py findings, ` +
      `packs=${pyReport.coverage.packs_loaded.join("+")}\n`,
  );

  process.stdout.write(`\n✓ smoke test passed (crimes@${expectedVersion})\n`);
} finally {
  if (installRoot) rmSync(installRoot, { recursive: true, force: true });
  // The packed tarball was created in cliDir by `npm pack`; remove it so we
  // don't accidentally commit it or inflate subsequent runs.
  for (const entry of readdirSync(cliDir)) {
    if (entry.endsWith(".tgz")) {
      rmSync(resolve(cliDir, entry), { force: true });
    }
  }
}
