/**
 * The agent adapters must run the CLI in the directory they are given.
 *
 * `runProcess` has always accepted a `cwd`; nothing ever passed one, so
 * both agents inherited the runner's — inside this repo. That is the
 * defect that let a codex run edit and commit a fixture during 0.29.1.
 * These tests spawn a stub binary that reports its own working
 * directory, so they fail if the option stops being forwarded.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { invokeClaude } from "./claude.js";
import { invokeCodex } from "./codex.js";

let binDir: string;
let workDir: string;
let originalPath: string | undefined;

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "crimes-fake-bin-"));
  workDir = realpathSync(mkdtempSync(join(tmpdir(), "crimes-fake-cwd-")));
  for (const name of ["claude", "codex"]) {
    const stub = join(binDir, name);
    writeFileSync(stub, '#!/bin/sh\nprintf \'{"result":"%s"}\\n\' "$(pwd)"\n');
    chmodSync(stub, 0o755);
  }
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
});

afterEach(() => {
  process.env.PATH = originalPath;
  rmSync(binDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

describe("agent adapters honour cwd", () => {
  it("runs claude in the directory it is given", async () => {
    const result = await invokeClaude({ prompt: "hi", cwd: workDir });
    expect(result.response.trim()).toBe(workDir);
  });

  it("runs codex in the directory it is given", async () => {
    const result = await invokeCodex({ prompt: "hi", cwd: workDir });
    expect(result.response.trim()).toBe(workDir);
  });

  it("tells codex not to require a git repository", async () => {
    // The workspace is a bare copy with no `.git`, and codex refuses to
    // run outside a trusted directory: "Not inside a trusted directory
    // and --skip-git-repo-check was not specified." Without the flag the
    // isolation fix takes the whole codex half of the round down.
    const stub = join(binDir, "codex");
    writeFileSync(stub, '#!/bin/sh\nprintf \'{"result":"%s"}\\n\' "$*"\n');
    chmodSync(stub, 0o755);
    const result = await invokeCodex({ prompt: "hi", cwd: workDir });
    expect(result.response).toContain("--skip-git-repo-check");
  });
});
