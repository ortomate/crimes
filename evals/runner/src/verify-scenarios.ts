#!/usr/bin/env tsx
/**
 * Verifies every scenario's `expected_artifacts` against the actual
 * findings produced by `crimes scan` on its fixture. Fails when a
 * scenario references a detector that the fixture doesn't produce —
 * the symptom that motivated the cluster-C work in 0.7.2 (~74% of
 * "agent failures" turned out to be scenarios checking for findings
 * the detectors never fired).
 *
 * Wire into CI alongside the structural replay so future scenario or
 * fixture drift fails the build instead of silently undercounting
 * pass rates.
 *
 * ## Every loaded scenario must be checked
 *
 * The headline used to count scenarios *loaded*, while the loop
 * skipped any scenario whose fixture was absent from disk — so a
 * checkout without `pnpm run evals:setup` reported
 * "62 scenario(s) reconciled against 15 fixture scan(s)" and exited 0
 * with fixture 16 never scanned. Reporting a number larger than the
 * number actually verified is the same vacuous pass `evals:replay`
 * had. Unchecked scenarios are now fatal, and the summary line counts
 * what was verified.
 *
 * Exit codes:
 *   0 — every scenario's referenced_findings + expected_priority
 *       appear in its fixture's scan output.
 *   1 — scenario drift: at least one mismatch, or a scenario naming a
 *       fixture the registry does not define.
 *   2 — environment problem (fixture missing on disk, registry or
 *       scenario file unparseable, CLI bundle missing).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { CLI_DIST, FIXTURES_REGISTRY, REPO_ROOT, SCENARIOS_DIR } from "./paths.js";
import { buildScanContext, runScan } from "./scan-helpers.js";
import type { FixturesRegistry, ScanContext, Scenario } from "./types.js";

interface Mismatch {
  scenario: string;
  fixture: string;
  kind: "referenced_findings" | "expected_priority";
  missing: string;
  fires: string[];
}

async function main(): Promise<void> {
  if (!existsSync(CLI_DIST)) {
    process.stderr.write(
      `verify-scenarios: ${CLI_DIST} missing — run \`pnpm --filter crimes build\` first.\n`,
    );
    process.exit(2);
    return;
  }
  if (!existsSync(FIXTURES_REGISTRY)) {
    process.stderr.write(
      `verify-scenarios: ${FIXTURES_REGISTRY} missing — run \`pnpm run evals:setup\` first.\n`,
    );
    process.exit(2);
    return;
  }
  const registry = JSON.parse(
    readFileSync(FIXTURES_REGISTRY, "utf8"),
  ) as FixturesRegistry;
  const fixtureDirById = new Map(
    registry.fixtures.map((f) => [f.id, resolve(REPO_ROOT, f.path)]),
  );

  const { scenarios, unreadable } = loadScenarios();
  if (unreadable.length > 0) {
    process.stderr.write(
      `verify-scenarios: ${unreadable.length} scenario file(s) could not be read — ` +
        "the check would silently cover fewer scenarios than the suite defines.\n" +
        unreadable.map((u) => `    ${u}\n`).join(""),
    );
    process.exit(2);
    return;
  }
  if (scenarios.length === 0) {
    process.stderr.write(
      `verify-scenarios: no scenarios found under ${SCENARIOS_DIR} — ` +
        "there is nothing to verify, which is a missing input, not a pass.\n",
    );
    process.exit(2);
    return;
  }

  // Scan each fixture once and build a `type-fires-here` set.
  const typesByFixture = new Map<string, Set<string>>();
  const missingFixtures: string[] = [];
  for (const [id, dir] of fixtureDirById) {
    if (!existsSync(dir)) {
      missingFixtures.push(`${id} (${dir})`);
      continue;
    }
    const ctx = await scanContextFor(dir);
    typesByFixture.set(id, new Set(Object.values(ctx.detector_id_by_finding_id)));
  }

  const mismatches: Mismatch[] = [];
  const unchecked: string[] = [];
  let checked = 0;
  for (const s of scenarios) {
    const fires = typesByFixture.get(s.fixture);
    if (!fires) {
      // Either its fixture is missing on disk (already collected) or
      // the scenario names a fixture id the registry never defines.
      // Both mean this scenario was not verified.
      unchecked.push(
        `${s.id} → fixture ${s.fixture}` +
          (fixtureDirById.has(s.fixture) ? " (missing on disk)" : " (not in registry)"),
      );
      continue;
    }
    checked += 1;
    const refs = s.expected_artifacts.referenced_findings ?? [];
    for (const t of refs) {
      if (!fires.has(t)) {
        mismatches.push({
          scenario: s.id,
          fixture: s.fixture,
          kind: "referenced_findings",
          missing: t,
          fires: [...fires].sort(),
        });
      }
    }
    const prio = s.expected_artifacts.expected_priority;
    if (prio !== undefined && !fires.has(prio)) {
      mismatches.push({
        scenario: s.id,
        fixture: s.fixture,
        kind: "expected_priority",
        missing: prio,
        fires: [...fires].sort(),
      });
    }
  }

  reportMismatches(mismatches, checked);

  if (unchecked.length > 0) {
    process.stderr.write(
      `verify-scenarios: ${unchecked.length} of ${scenarios.length} scenario(s) were ` +
        "never checked — this run verified less than it covers.\n",
    );
    for (const u of unchecked) process.stderr.write(`    ${u}\n`);
    if (missingFixtures.length > 0) {
      process.stderr.write(
        `\nverify-scenarios: ${missingFixtures.length} fixture(s) missing on disk — ` +
          "run `pnpm run evals:setup` to materialise them:\n",
      );
      for (const f of missingFixtures) process.stderr.write(`    ${f}\n`);
      process.exit(2);
      return;
    }
    // Every fixture is present, so the gap is a scenario naming a
    // fixture the registry does not define — authoring drift.
    process.exit(1);
    return;
  }

  if (mismatches.length > 0) {
    process.exit(1);
    return;
  }

  process.stdout.write(
    `verify-scenarios: ${checked} scenario(s) reconciled against ` +
      `${typesByFixture.size} fixture scan(s). All expected detectors fire.\n`,
  );
}

function reportMismatches(mismatches: Mismatch[], checked: number): void {
  if (mismatches.length === 0) return;
  process.stderr.write(
    `verify-scenarios: ${mismatches.length} mismatch(es) across ${checked} checked scenarios.\n\n`,
  );
  // Group by scenario for readability.
  const byScenario = new Map<string, Mismatch[]>();
  for (const m of mismatches) {
    const list = byScenario.get(m.scenario);
    if (list) list.push(m);
    else byScenario.set(m.scenario, [m]);
  }
  for (const [scenario, items] of byScenario) {
    process.stderr.write(`- ${scenario} (fixture=${items[0]!.fixture}):\n`);
    for (const it of items) {
      process.stderr.write(`    ${it.kind}: \`${it.missing}\` not in fixture scan\n`);
    }
    process.stderr.write(`    fixture fires: ${items[0]!.fires.join(", ")}\n\n`);
  }
}

async function scanContextFor(fixtureDir: string): Promise<ScanContext> {
  const json = await runScan(fixtureDir);
  return buildScanContext(json);
}

interface LoadedScenarios {
  scenarios: Scenario[];
  /** `<file> — <reason>` for every scenario file that would not parse. */
  unreadable: string[];
}

function loadScenarios(): LoadedScenarios {
  const out: LoadedScenarios = { scenarios: [], unreadable: [] };
  if (!existsSync(SCENARIOS_DIR)) return out;
  for (const file of readdirSync(SCENARIOS_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const data = JSON.parse(
        readFileSync(resolve(SCENARIOS_DIR, file), "utf8"),
      ) as Scenario[];
      if (!Array.isArray(data)) {
        out.unreadable.push(`${file} — not a JSON array of scenarios`);
        continue;
      }
      out.scenarios.push(...data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      out.unreadable.push(`${file} — ${message}`);
    }
  }
  return out;
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`verify-scenarios: ${message}\n`);
  process.exit(2);
});
