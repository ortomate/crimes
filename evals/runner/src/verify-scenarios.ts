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
 * Exit codes:
 *   0 — every scenario's referenced_findings + expected_priority
 *       appear in its fixture's scan output.
 *   1 — at least one mismatch (per-scenario detail printed to stderr).
 *   2 — environment problem (fixture missing on disk, registry
 *       unparseable, CLI bundle missing).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildScanContext, runScan } from "./scan-helpers.js";
import type { FixturesRegistry, ScanContext, Scenario } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const FIXTURES_REGISTRY = resolve(REPO_ROOT, "evals", "fixtures", "fixtures.meta.json");
const SCENARIOS_DIR = resolve(REPO_ROOT, "evals", "scenarios");
const CLI_DIST = resolve(REPO_ROOT, "packages", "cli", "dist", "index.js");

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

  const scenarios = loadScenarios();
  if (scenarios.length === 0) {
    process.stdout.write("verify-scenarios: no scenarios found — nothing to check.\n");
    return;
  }

  // Scan each fixture once and build a `type-fires-here` set.
  const typesByFixture = new Map<string, Set<string>>();
  for (const [id, dir] of fixtureDirById) {
    if (!existsSync(dir)) {
      process.stderr.write(
        `verify-scenarios: fixture ${id} (${dir}) missing on disk — skip.\n`,
      );
      continue;
    }
    const ctx = await scanContextFor(dir);
    typesByFixture.set(id, new Set(Object.values(ctx.detector_id_by_finding_id)));
  }

  const mismatches: Mismatch[] = [];
  for (const s of scenarios) {
    const fires = typesByFixture.get(s.fixture);
    if (!fires) continue; // already reported as missing
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

  if (mismatches.length === 0) {
    process.stdout.write(
      `verify-scenarios: ${scenarios.length} scenario(s) reconciled against ` +
        `${typesByFixture.size} fixture scan(s). All expected detectors fire.\n`,
    );
    return;
  }

  process.stderr.write(
    `verify-scenarios: ${mismatches.length} mismatch(es) across ${scenarios.length} scenarios.\n\n`,
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
  process.exit(1);
}

async function scanContextFor(fixtureDir: string): Promise<ScanContext> {
  const json = await runScan(fixtureDir);
  return buildScanContext(json);
}

function loadScenarios(): Scenario[] {
  if (!existsSync(SCENARIOS_DIR)) return [];
  const out: Scenario[] = [];
  for (const file of readdirSync(SCENARIOS_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const data = JSON.parse(
        readFileSync(resolve(SCENARIOS_DIR, file), "utf8"),
      ) as Scenario[];
      if (Array.isArray(data)) out.push(...data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`verify-scenarios: failed to parse ${file} — ${message}\n`);
    }
  }
  return out;
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`verify-scenarios: ${message}\n`);
  process.exit(2);
});
