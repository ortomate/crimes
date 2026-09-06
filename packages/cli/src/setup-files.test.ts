import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applySetupFiles, readSetupFile } from "./setup-files.js";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

const roots: string[] = [];
function workspace(): string {
  const root = fs.mkdtempSync(join(tmpdir(), "crimes-setup-files-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.mocked(fs.renameSync).mockClear();
});

describe("setup file transaction", () => {
  it("rejects unsafe destinations before replacing an earlier file", () => {
    const root = workspace();
    fs.writeFileSync(join(root, "config"), "custom");
    fs.mkdirSync(join(root, "skill"));
    expect(() =>
      applySetupFiles(root, [
        { path: "config", before: "custom", after: "new" },
        { path: "skill", before: undefined, after: "skill text" },
      ]),
    ).toThrow("expected regular");
    expect(fs.readFileSync(join(root, "config"), "utf8")).toBe("custom");
    expect(fs.readdirSync(root).sort()).toEqual(["config", "skill"]);
  });

  it("rejects symlinked skills and skill directories without touching the target", () => {
    const root = workspace();
    const outside = workspace();
    fs.writeFileSync(join(outside, "SKILL.md"), "custom");
    fs.symlinkSync(outside, join(root, "skills"));
    expect(() => readSetupFile(root, "skills/SKILL.md")).toThrow("not links");
    fs.symlinkSync(join(outside, "SKILL.md"), join(root, "SKILL.md"));
    expect(() => readSetupFile(root, "SKILL.md")).toThrow("not links");
    expect(fs.readFileSync(join(outside, "SKILL.md"), "utf8")).toBe("custom");
  });

  it("refuses stale plans instead of replacing an intervening edit", () => {
    const root = workspace();
    fs.writeFileSync(join(root, "skill"), "concurrent edit");
    expect(() =>
      applySetupFiles(root, [{ path: "skill", before: "old", after: "new" }]),
    ).toThrow("changed during setup");
    expect(fs.readFileSync(join(root, "skill"), "utf8")).toBe("concurrent edit");
  });

  it("rolls back earlier replacements and cleans staged files on a rename failure", () => {
    const root = workspace();
    fs.writeFileSync(join(root, "existing"), "custom", { mode: 0o600 });
    const rename = fs.renameSync;
    const actual = vi.mocked(rename).getMockImplementation()!;
    vi.mocked(rename)
      .mockImplementationOnce(actual)
      .mockImplementationOnce(() => {
        throw new Error("simulated rename failure");
      });
    expect(() =>
      applySetupFiles(root, [
        { path: "existing", before: "custom", after: "new" },
        { path: "created", before: undefined, after: "new" },
      ]),
    ).toThrow("simulated rename failure");
    expect(fs.readFileSync(join(root, "existing"), "utf8")).toBe("custom");
    expect(fs.statSync(join(root, "existing")).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(root)).toEqual(["existing"]);
  });

  it("retains the original backup if restoration itself fails", () => {
    const root = workspace();
    fs.writeFileSync(join(root, "existing"), "original");
    const actual = vi.mocked(fs.renameSync).getMockImplementation()!;
    vi.mocked(fs.renameSync)
      .mockImplementationOnce(actual)
      .mockImplementationOnce(() => {
        throw new Error("write failure");
      })
      .mockImplementationOnce(() => {
        throw new Error("restore failure");
      });
    expect(() =>
      applySetupFiles(root, [
        { path: "existing", before: "original", after: "replacement" },
        { path: "second", before: undefined, after: "new" },
      ]),
    ).toThrow("original retained at");
    const backup = fs.readdirSync(root).find((name) => name.endsWith(".backup"));
    expect(backup).toBeDefined();
    expect(fs.readFileSync(join(root, backup!), "utf8")).toBe("original");
  });
});
