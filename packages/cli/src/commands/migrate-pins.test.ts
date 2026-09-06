import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { appendSuppression, loadSuppressions } from "@crimes/core";

const cli = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
function run(root: string, args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });
}

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
