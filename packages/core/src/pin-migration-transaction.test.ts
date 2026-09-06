import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyPinMigration, previewPinMigration } from "./pin-migration.js";
import {
  recoverPinUpdates,
  writePinUpdates,
  type PinUpdate,
} from "./pin-migration-transaction.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename), open: vi.fn(actual.open) };
});

const roots: string[] = [];
const updates: PinUpdate[] = [
  {
    name: "triage.json",
    before: '{"entries":[{"fingerprint":"old","reason":"keep reason"}]}\n',
    after: '{"entries":[{"fingerprint":"new","reason":"keep reason"}]}\n',
  },
  {
    name: "suppressions.json",
    before: '{"suppressions":[{"fingerprint":"old","crimes_version_pinned":"0.26"}]}\n',
    after: '{"suppressions":[{"fingerprint":"new","crimes_version_pinned":"0.26"}]}\n',
  },
];
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), "crimes-pin-transaction-"));
  roots.push(root);
  await fs.mkdir(join(root, ".crimes"));
  for (const file of updates)
    await fs.writeFile(join(root, ".crimes", file.name), file.before);
  return root;
}
async function assertOriginal(root: string) {
  for (const file of updates)
    expect(await fs.readFile(join(root, ".crimes", file.name), "utf8")).toBe(file.before);
}
async function resetFilesystem() {
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(fs.rename).mockImplementation(actual.rename);
  vi.mocked(fs.open).mockImplementation(actual.open);
}
afterEach(async () => {
  await resetFilesystem();
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("pin migration interruption and recovery", () => {
  it("stages all replacements before publishing and restores every original after a rename failure", async () => {
    const root = await fixture();
    const { rename } =
      await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let failed = false;
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (String(from).endsWith("suppressions.json.next") && !failed) {
        failed = true;
        // The first file was already replaced; the recovery must undo it.
        expect(await fs.readFile(join(root, ".crimes/triage.json"), "utf8")).toBe(
          updates[0]!.after,
        );
        throw new Error("injected rename failure");
      }
      return rename(from, to);
    });
    await expect(writePinUpdates(root, updates)).rejects.toThrow(
      "original pin files were restored",
    );
    await assertOriginal(root);
    await expect(fs.stat(join(root, ".crimes/.pin-migration"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("recovers an interrupted process with one old and one new file, preserving exact bytes", async () => {
    const root = await fixture();
    const directory = join(root, ".crimes/.pin-migration");
    await fs.mkdir(directory);
    await fs.writeFile(
      join(directory, "journal.json"),
      JSON.stringify({
        format: 1,
        files: updates.map((file) => ({ ...file, mode: 0o600 })),
      }),
    );
    await fs.writeFile(join(root, ".crimes/triage.json"), updates[0]!.after);
    await expect(previewPinMigration(root, [])).rejects.toThrow("--recover");
    await expect(applyPinMigration(root, {}, [])).rejects.toThrow();
    expect(await recoverPinUpdates(root)).toBe(2);
    await assertOriginal(root);
    expect((await fs.stat(join(root, ".crimes/triage.json"))).mode & 0o777).toBe(0o600);
  });

  it("refuses recovery before touching any file if a later edit disagrees with both versions", async () => {
    const root = await fixture();
    const directory = join(root, ".crimes/.pin-migration");
    await fs.mkdir(directory);
    await fs.writeFile(
      join(directory, "journal.json"),
      JSON.stringify({
        format: 1,
        files: updates.map((file) => ({ ...file, mode: 0o644 })),
      }),
    );
    await fs.writeFile(join(root, ".crimes/triage.json"), updates[0]!.after);
    await fs.writeFile(join(root, ".crimes/suppressions.json"), "later edit");
    await expect(recoverPinUpdates(root)).rejects.toThrow("changed outside migration");
    expect(await fs.readFile(join(root, ".crimes/triage.json"), "utf8")).toBe(
      updates[0]!.after,
    );
    expect(await fs.readFile(join(root, ".crimes/suppressions.json"), "utf8")).toBe(
      "later edit",
    );
    expect(await fs.readFile(join(directory, "journal.json"), "utf8")).toContain(
      "keep reason",
    );
  });

  it("retains a recoverable journal if rollback itself fails", async () => {
    const root = await fixture();
    const { rename } =
      await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (
        String(from).endsWith("suppressions.json.next") ||
        String(from).endsWith("triage.json.restore")
      )
        throw new Error("storage failure");
      return rename(from, to);
    });
    await expect(writePinUpdates(root, updates)).rejects.toThrow(
      "recovery files were retained",
    );
    await resetFilesystem();
    expect(await recoverPinUpdates(root)).toBe(2);
    await assertOriginal(root);
  });

  it("does not replace pins when staging fails or when a source changed", async () => {
    const root = await fixture();
    const { open } =
      await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
      if (String(path).endsWith("suppressions.json.next")) throw new Error("disk full");
      return open(path, flags, mode);
    });
    await expect(writePinUpdates(root, updates)).rejects.toThrow("restored");
    await assertOriginal(root);
    await resetFilesystem();
    await fs.writeFile(join(root, ".crimes/triage.json"), "new decision");
    await expect(writePinUpdates(root, updates)).rejects.toThrow(
      "changed while preparing",
    );
    expect(await fs.readFile(join(root, ".crimes/triage.json"), "utf8")).toBe(
      "new decision",
    );
  });

  it("rejects unsafe journal destinations and incomplete journals without touching pins", async () => {
    const root = await fixture();
    const directory = join(root, ".crimes/.pin-migration");
    await fs.mkdir(directory);
    await expect(recoverPinUpdates(root)).rejects.toThrow(
      "No complete migration journal",
    );
    await fs.writeFile(
      join(directory, "journal.json"),
      JSON.stringify({
        format: 1,
        files: [{ ...updates[0], name: "../outside.json", mode: 0o644 }],
      }),
    );
    await expect(recoverPinUpdates(root)).rejects.toThrow();
    await assertOriginal(root);
  });
});
