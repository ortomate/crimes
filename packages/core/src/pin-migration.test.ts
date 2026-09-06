import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendSuppression, loadSuppressions } from "./suppressions.js";
import type { Finding } from "./finding.js";
import { applyPinMigration, previewPinMigration } from "./pin-migration.js";

const roots: string[] = [];
const old = "large_function::src/a.ts::calculate";
const current = (claim = "too_long", discriminator?: string) =>
  ({
    type: "large_function",
    file: "src/a.ts",
    symbol: "calculate",
    claim,
    discriminator,
    fingerprint: `large_function/${claim}::src/a.ts::calculate${discriminator ? `::${discriminator}` : ""}`,
  }) as Finding;
async function rootWithPin() {
  const root = await mkdtemp(join(tmpdir(), "crimes-migration-"));
  roots.push(root);
  await mkdir(join(root, ".crimes"));
  await writeFile(
    join(root, ".crimes/triage.json"),
    JSON.stringify({
      entries: [
        {
          fingerprint: old,
          disposition: "wont-fix",
          reason: "reviewed orchestration",
          owner: "owner",
          date: "2026-08-01",
        },
      ],
    }),
  );
  return root;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("reviewed pin migration", () => {
  it("previews without writing and preserves the decision when applied", async () => {
    const root = await rootWithPin();
    const path = join(root, ".crimes/triage.json");
    const before = await readFile(path, "utf8");
    const plan = await previewPinMigration(root, [current()]);
    expect(plan.entries[0]?.to).toBe(current().fingerprint);
    expect(await readFile(path, "utf8")).toBe(before);
    expect(await applyPinMigration(root, plan, [current()])).toBe(1);
    expect(JSON.parse(await readFile(path, "utf8")).entries[0]).toMatchObject({
      fingerprint: current().fingerprint,
      claim: "too_long",
      disposition: "wont-fix",
      reason: "reviewed orchestration",
      owner: "owner",
      date: "2026-08-01",
    });
  });

  it("does not choose among distinct claims or discriminator siblings", async () => {
    const root = await rootWithPin();
    for (const findings of [
      [current(), current("deeply_nested")],
      [current("too_long", "one"), current("too_long", "two")],
    ]) {
      const plan = await previewPinMigration(root, findings);
      expect(plan.entries[0]).toMatchObject({ status: "ambiguous" });
      expect(plan.entries[0]?.to).toBeUndefined();
      expect(await applyPinMigration(root, plan, findings)).toBe(0);
    }
  });

  it("rejects a changed source or destination before writing", async () => {
    const root = await rootWithPin();
    const plan = await previewPinMigration(root, [current()]);
    await expect(
      applyPinMigration(root, plan, [current("deeply_nested")]),
    ).rejects.toThrow("no longer matches");
    await writeFile(join(root, ".crimes/triage.json"), '{"entries":[]}');
    await expect(applyPinMigration(root, plan, [current()])).rejects.toThrow(
      "changed since",
    );
  });

  it("does not delete an absent finding or refresh a feedback expiry pin", async () => {
    const root = await rootWithPin();
    const path = join(root, ".crimes/suppressions.json");
    await appendSuppression(
      path,
      {
        fingerprint: old,
        type: "large_function",
        file: "src/a.ts",
        reason: "known false positive",
        crimes_version_pinned: "0.26",
        source: "feedback",
      },
      { now: () => new Date("2026-08-01T00:00:00Z") },
    );
    const absent = await previewPinMigration(root, []);
    expect(absent.entries.every((entry) => entry.status === "not_reported")).toBe(true);
    expect(await applyPinMigration(root, absent, [])).toBe(0);
    await applyPinMigration(root, await previewPinMigration(root, [current()]), [
      current(),
    ]);
    expect(loadSuppressions(path).entries[0]).toMatchObject({
      crimes_version_pinned: "0.26",
      reason: "known false positive",
      created_at: "2026-08-01T00:00:00.000Z",
    });
  });
});
