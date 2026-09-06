import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { appendSuppression, loadSuppressions } from "@crimes/core";

const cli = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
function run(root: string, args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });
}

it("recovers interrupted pins without requiring a successful repository scan", async () => {
  const root = await mkdtemp(join(tmpdir(), "crimes-pin-recovery-cli-"));
  try {
    await mkdir(join(root, ".crimes/.pin-migration"), { recursive: true });
    const before = '{"entries":[]}\n';
    const after = '{"entries":[{"fingerprint":"migrated"}]}\n';
    await writeFile(join(root, ".crimes/triage.json"), after);
    await writeFile(
      join(root, ".crimes/.pin-migration/journal.json"),
      JSON.stringify({
        format: 1,
        files: [{ name: "triage.json", before, after, mode: 0o644 }],
      }),
    );
    await writeFile(join(root, "crimes.config.json"), "not valid JSON");
    const result = run(root, ["migrate-pins", "--recover", "--format", "json"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      schema_version: "0.8.0",
      report_type: "pin_migration_recovery",
      restored_files: 1,
    });
    expect(await readFile(join(root, ".crimes/triage.json"), "utf8")).toBe(before);
    const conflicting = run(root, ["migrate-pins", "--recover", "--apply", "plan.json"]);
    expect(conflicting.status).toBe(2);
    expect(conflicting.stderr).toContain("either --apply or --recover");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("round-trips a real suppression through preview and reviewed apply", async () => {
  const root = await mkdtemp(join(tmpdir(), "crimes-pin-cli-"));
  try {
    await writeFile(
      join(root, "billing.ts"),
      "export async function save() { try { await db.orders.insert(order); } catch (e) {} }",
    );
    const scanned = run(root, ["scan", "--format", "json"]);
    expect(scanned.status).toBe(0);
    const finding = JSON.parse(scanned.stdout).findings.find(
      (f: { type: string }) => f.type === "swallowed_error",
    );
    expect(finding).toBeDefined();
    const path = join(root, ".crimes/suppressions.json");
    await appendSuppression(path, {
      fingerprint: finding.fingerprint.replace(`/${finding.claim}`, ""),
      type: finding.type,
      file: finding.file,
      symbol: finding.symbol,
      reason: "reviewed failure tolerance",
      source: "feedback",
      crimes_version_pinned: "0.26",
    });
    const before = await readFile(path, "utf8");
    const preview = run(root, ["migrate-pins", "--format", "json"]);
    expect(preview.status).toBe(0);
    expect(JSON.parse(preview.stdout).entries[0].to).toBe(finding.fingerprint);
    expect(await readFile(path, "utf8")).toBe(before);
    await writeFile(join(root, "plan.json"), preview.stdout);
    const applied = run(root, [
      "migrate-pins",
      "--apply",
      "plan.json",
      "--format",
      "json",
    ]);
    expect(applied.status).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({
      report_type: "pin_migration_apply",
      migrated: 1,
    });
    expect(loadSuppressions(path).entries[0]).toMatchObject({
      fingerprint: finding.fingerprint,
      reason: "reviewed failure tolerance",
      crimes_version_pinned: "0.26",
    });
    const stale = run(root, ["migrate-pins", "--apply", "plan.json", "--format", "json"]);
    expect(stale.status).toBe(2);
    expect(stale.stdout).toBe("");
    expect(stale.stderr).toContain("changed since");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
