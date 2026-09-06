import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AnalysisInputs } from "./analysis-inputs.js";
import { analyseRepository } from "./scan.js";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "crimes-inputs-"));
  roots.push(root);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await writeFile(
    join(root, "src/refund.ts"),
    "export async function refund(db: any) { try { await db.insertRefund(); } catch {} return { ok: true }; }",
  );
  await writeFile(
    join(root, "src/consumer.ts"),
    'import { refund } from "./refund.js"; export const submit = refund;',
  );
  await writeFile(
    join(root, "src/service.py"),
    "def charge(amount):\n    return amount\n",
  );
  await writeFile(
    join(root, "src/test_service.py"),
    "from service import charge\n\ndef test_charge():\n    assert charge(1) == 1\n",
  );
  return root;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("per-analysis input reuse", () => {
  it("shares parsed data only for identical path and source, including empty source", () => {
    const inputs = new AnalysisInputs();
    const source = "export const total = 1;";
    const first = inputs.js("/src/a.ts", source);
    expect(inputs.js("/src/a.ts", source)).toBe(first);
    expect(inputs.js("/src/a.ts", "export const total = 2;")).not.toBe(first);
    expect(inputs.js("/src/b.ts", source)).not.toBe(first);
    expect(inputs.js("/src/empty.ts", "").lineCount).toBe(0);
  });

  it("eviction and zero budget preserve parse results", () => {
    const source = "export function total() { return 1; }";
    const bounded = new AnalysisInputs(10);
    const uncached = new AnalysisInputs(0);
    const first = bounded.js("/src/a.ts", source);
    expect(bounded.js("/src/a.ts", source)).not.toBe(first);
    expect(first).toEqual(uncached.js("/src/a.ts", source));
  });

  it("does not retain failed reads, and fresh analyses reread changed source", async () => {
    const root = await fixture();
    const path = join(root, "src/new.ts");
    const first = new AnalysisInputs();
    await expect(first.read(path)).rejects.toThrow();
    await writeFile(path, "first");
    expect(await first.read(path)).toBe("first");
    await writeFile(path, "second");
    // A session is intentionally a single analysis snapshot, not a file watcher.
    expect(await first.read(path)).toBe("first");
    expect(await new AnalysisInputs().read(path)).toBe("second");
  });

  it("matches uncached reports after edits, renames, deletes, configuration and root changes", async () => {
    const root = await fixture();
    const compare = async (directory: string) => {
      const reused = await analyseRepository({ root: directory });
      const fresh = await analyseRepository({ root: directory }, new AnalysisInputs(0));
      expect(reused.report).toEqual(fresh.report);
      return reused.report;
    };
    const before = await compare(root);
    expect(before.findings.some((finding) => finding.type === "swallowed_error")).toBe(
      true,
    );
    await writeFile(
      join(root, "src/refund.ts"),
      "export async function refund(db: any) { await db.insertRefund(); return { ok: true }; }",
    );
    expect((await compare(root)).findings.some((f) => f.type === "swallowed_error")).toBe(
      false,
    );
    await rename(join(root, "src/refund.ts"), join(root, "src/renamed.ts"));
    await compare(root);
    await rm(join(root, "src/renamed.ts"));
    await compare(root);
    await writeFile(join(root, "crimes.config.json"), '{"exclude":["src/**"]}');
    expect((await compare(root)).findings).toEqual([]);
    const other = await fixture();
    expect(
      (await compare(other)).findings.some((f) => f.type === "swallowed_error"),
    ).toBe(true);
  });
});
