/**
 * The agent's working directory must not be this repository.
 *
 * Round protocol rule 3 is "never run from inside the crimes working
 * tree", and the 0.29.1 round proved why: `evals/fixtures/15-risky-service`
 * is a symlink to `examples/risky-service`, the runner passed no `cwd`, and
 * a codex agent asked to add a field to a fixture edited the real file and
 * committed it — twice, reproducibly. These guard the isolation that stops it.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentWorkspace } from "./workspace.js";

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "crimes-workspace-test-"));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("createAgentWorkspace", () => {
  it("copies the fixture's files into a directory outside the source", async () => {
    const source = join(scratch, "fixture");
    mkdirSync(join(source, "src"), { recursive: true });
    writeFileSync(join(source, "src", "schema.ts"), "export const a = 1;\n");

    const workspace = await createAgentWorkspace(source);
    try {
      expect(workspace.dir.startsWith(resolve(source))).toBe(false);
      expect(readFileSync(join(workspace.dir, "src", "schema.ts"), "utf8")).toBe(
        "export const a = 1;\n",
      );
    } finally {
      await workspace.cleanup();
    }
  });

  it("dereferences a symlinked fixture so writes cannot travel back to it", async () => {
    // The exact shape of fixture 15: the fixture directory is a symlink
    // to a real tree elsewhere in the repo.
    const real = join(scratch, "examples", "risky-service");
    mkdirSync(join(real, "repo"), { recursive: true });
    writeFileSync(join(real, "repo", "user-schema.ts"), "original\n");
    const link = join(scratch, "fixtures", "15-risky-service");
    mkdirSync(join(scratch, "fixtures"), { recursive: true });
    symlinkSync(real, link);

    const workspace = await createAgentWorkspace(link);
    try {
      const copied = join(workspace.dir, "repo", "user-schema.ts");
      expect(lstatSync(copied).isSymbolicLink()).toBe(false);

      // An agent edits what it believes is the fixture.
      writeFileSync(copied, "edited by an agent\n");

      expect(readFileSync(join(real, "repo", "user-schema.ts"), "utf8")).toBe(
        "original\n",
      );
    } finally {
      await workspace.cleanup();
    }
  });

  it("removes the workspace on cleanup", async () => {
    const source = join(scratch, "fixture");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "a.ts"), "a\n");

    const workspace = await createAgentWorkspace(source);
    expect(existsSync(workspace.dir)).toBe(true);
    await workspace.cleanup();
    expect(existsSync(workspace.dir)).toBe(false);
  });

  it("does not carry the source's git history into the workspace", async () => {
    // An agent that finds a .git directory can commit. It found one.
    const source = join(scratch, "fixture");
    mkdirSync(join(source, ".git"), { recursive: true });
    writeFileSync(join(source, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(source, "a.ts"), "a\n");

    const workspace = await createAgentWorkspace(source);
    try {
      expect(existsSync(join(workspace.dir, ".git"))).toBe(false);
      expect(existsSync(join(workspace.dir, "a.ts"))).toBe(true);
    } finally {
      await workspace.cleanup();
    }
  });
});
