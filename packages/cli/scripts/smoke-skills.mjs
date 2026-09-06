import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

const skillPaths = [".agents/skills/crimes/SKILL.md", ".claude/skills/crimes/SKILL.md"];
function run(command, args, cwd, expected = 0) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CI: "true" },
  });
  assert.equal(
    result.status,
    expected,
    `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout;
}
const read = (root, path) => readFileSync(join(root, path), "utf8");

export function smokeSkills({ installedBin, tarballPath, repoRoot, temporary }) {
  process.stdout.write(
    "\n▸ Agent skills: fresh setup and published 0.28.0 / 0.28.1 → tarball upgrades\n",
  );
  const fresh = join(temporary, "fresh-skills");
  mkdirSync(fresh);
  run(installedBin, ["init", "--agents"], fresh);
  const generated = skillPaths.map((path) => read(fresh, path));
  for (const [i, path] of skillPaths.entries())
    assert.equal(generated[i], read(repoRoot, path));
  const settings = read(fresh, ".claude/settings.local.json");
  assert.ok(
    JSON.parse(settings).hooks.PreToolUse[0].hooks[0].command.includes("crimes hook"),
  );
  assert.equal(existsSync(join(fresh, ".agents/settings.local.json")), false);
  run(installedBin, ["init", "--agents"], fresh);
  assert.equal(read(fresh, ".claude/settings.local.json"), settings);
  assert.deepEqual(
    skillPaths.map((path) => read(fresh, path)),
    generated,
  );

  const unconfigured = join(temporary, "terminal-no-config");
  mkdirSync(unconfigured);
  run(
    "python3",
    [
      join(repoRoot, "packages/cli/scripts/smoke-terminal.py"),
      "--cli",
      installedBin,
      "--project",
      unconfigured,
      "--json",
    ],
    unconfigured,
  );
  assert.equal(existsSync(join(unconfigured, "crimes.config.json")), false);

  for (const previous of ["0.28.0", "0.28.1"]) {
    const upgrade = join(temporary, `upgrade-skills-${previous}`);
    mkdirSync(upgrade);
    writeFileSync(
      join(upgrade, "package.json"),
      '{"name":"crimes-skill-upgrade-test","private":true}\n',
    );
    const install = (target) =>
      run("npm", ["install", "--no-audit", "--no-fund", "--silent", target], upgrade);
    install(`crimes@${previous}`);
    assert.equal(
      skillPaths.some((path) => existsSync(join(upgrade, path))),
      false,
    );
    mkdirSync(join(upgrade, "src"));
    writeFileSync(
      join(upgrade, "src/risk.ts"),
      "export function legacyReport() {\n" +
        Array.from({ length: 230 }, (_, i) => `  const value${i} = ${i};`).join("\n") +
        "\n  return value0;\n}\n",
    );
    const binary = join(upgrade, "node_modules/.bin/crimes");
    run(binary, ["init", "--agents", "--no-hooks"], upgrade);
    const old = skillPaths.map((path) => read(upgrade, path));
    const config = '{"include":["src/**/*.ts"],"exclude":["custom/**"]}\n';
    const hooks = '{"permissions":{"allow":["Read"]},"hooks":{}}\n';
    writeFileSync(join(upgrade, "crimes.config.json"), config);
    writeFileSync(join(upgrade, ".claude/settings.local.json"), hooks);
    install(tarballPath);
    assert.deepEqual(
      skillPaths.map((path) => read(upgrade, path)),
      old,
    );
    assert.equal(read(upgrade, "crimes.config.json"), config);
    const piped = spawnSync(binary, ["scan", "--format", "json"], {
      cwd: upgrade,
      encoding: "utf8",
      env: { ...process.env, CI: "" },
    });
    assert.equal(piped.status, 0, piped.stderr);
    assert.equal(JSON.parse(piped.stdout).report_type, "scan");
    assert.ok(piped.stderr.includes("crimes init --refresh-skills"));
    assert.deepEqual(
      skillPaths.map((path) => read(upgrade, path)),
      old,
    );
    for (const [flag, env] of [
      ["--no-skill-update", { CI: "" }],
      ["--no-init", { CI: "" }],
      [undefined, { CI: "true" }],
    ]) {
      const quiet = spawnSync(
        binary,
        [...(flag ? [flag] : []), "scan", "--format", "json"],
        {
          cwd: upgrade,
          encoding: "utf8",
          env: { ...process.env, ...env },
        },
      );
      assert.equal(quiet.status, 0, quiet.stderr);
      assert.equal(JSON.parse(quiet.stdout).report_type, "scan");
      assert.ok(!quiet.stderr.includes("agent skills"), quiet.stderr);
    }
    const gated = spawnSync(
      binary,
      ["scan", "--files", "src/risk.ts", "--fail-on", "high", "--format", "json"],
      {
        cwd: upgrade,
        encoding: "utf8",
        env: { ...process.env, CI: "" },
      },
    );
    assert.equal(gated.status, 1, gated.stderr);
    assert.equal(JSON.parse(gated.stdout).failed, true);
    assert.ok(gated.stderr.includes("agent skills are outdated"));
    const invalid = spawnSync(binary, ["scan", "--not-a-real-flag"], {
      cwd: upgrade,
      encoding: "utf8",
      env: { ...process.env, CI: "" },
    });
    assert.equal(invalid.status, 2);
    assert.equal(invalid.stdout, "");
    assert.deepEqual(
      skillPaths.map((path) => read(upgrade, path)),
      old,
    );
    // JSON stays read-only even when attached to an actual terminal. A human
    // report in that terminal refreshes after completing the scan.
    const terminal = join(repoRoot, "packages/cli/scripts/smoke-terminal.py");
    run("python3", [terminal, "--cli", binary, "--project", upgrade, "--json"], upgrade);
    assert.deepEqual(
      skillPaths.map((path) => read(upgrade, path)),
      old,
    );
    run("python3", [terminal, "--cli", binary, "--project", upgrade], upgrade);
    assert.deepEqual(
      skillPaths.map((path) => read(upgrade, path)),
      generated,
    );
    for (const [i, path] of skillPaths.entries())
      writeFileSync(join(upgrade, path), old[i]);
    run(binary, ["init", "--refresh-skills", "--check"], upgrade, 1);
    assert.deepEqual(
      skillPaths.map((path) => read(upgrade, path)),
      old,
    );
    run(binary, ["init", "--refresh-skills"], upgrade);
    assert.deepEqual(
      skillPaths.map((path) => read(upgrade, path)),
      generated,
    );
    run(binary, ["init", "--refresh-skills", "--check"], upgrade);

    const customized = generated[0].replace("# crimes workflow", "# Our team workflow");
    writeFileSync(join(upgrade, skillPaths[0]), customized);
    const conflict = run(binary, ["init", "--refresh-skills"], upgrade, 2);
    assert.ok(conflict.includes("-# Our team workflow"));
    assert.equal(read(upgrade, skillPaths[0]), customized);
    assert.equal(read(upgrade, skillPaths[1]), generated[1]);
    run(binary, ["init", "--refresh-skills", "--force"], upgrade);
    assert.deepEqual(
      skillPaths.map((path) => read(upgrade, path)),
      generated,
    );
    assert.equal(read(upgrade, "crimes.config.json"), config);
    assert.equal(read(upgrade, ".claude/settings.local.json"), hooks);
  }
  process.stdout.write(
    "  → fresh install, repeat setup, npm upgrade, real terminal refresh, JSON/CI isolation and customization protection passed\n",
  );
}
