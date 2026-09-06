import { describe, expect, it } from "vitest";
import { Command } from "commander";
import { autoInitFlags, detectAgent, shouldPromptAutoInit } from "./auto-init.js";

describe("first-run CLI flags", () => {
  it.each([
    { args: [], expected: { init: false, noInit: false } },
    { args: ["--init"], expected: { init: true, noInit: false } },
    { args: ["--no-init"], expected: { init: false, noInit: true } },
  ])("distinguishes explicit flags from defaults: $args", ({ args, expected }) => {
    const program = new Command().option("--no-init").option("--init");
    program.parse(args, { from: "user" });
    expect(autoInitFlags(program)).toEqual(expected);
  });
});

describe("detectAgent", () => {
  it("prefers CLAUDECODE env var over directories", () => {
    expect(
      detectAgent({
        env: { CLAUDECODE: "1" },
        cwd: "/tmp",
        exists: () => true,
      }),
    ).toBe("claude");
  });

  it("returns 'codex' for OPENAI_CODEX", () => {
    expect(
      detectAgent({
        env: { OPENAI_CODEX: "1" },
        cwd: "/tmp",
        exists: () => false,
      }),
    ).toBe("codex");
  });

  it("falls back to .claude/ when no env var is set", () => {
    expect(
      detectAgent({
        env: {},
        cwd: "/tmp",
        exists: (p) => p.endsWith(".claude"),
      }),
    ).toBe("claude");
  });

  it("returns 'none' when neither env nor directory signals exist", () => {
    expect(
      detectAgent({
        env: {},
        cwd: "/tmp",
        exists: () => false,
      }),
    ).toBe("none");
  });
});

describe("shouldPromptAutoInit", () => {
  it("returns false when CI is set", () => {
    expect(
      shouldPromptAutoInit({
        env: { CI: "true" },
        isTTY: true,
        configExists: false,
        markerExists: false,
        flags: { noInit: false, init: false },
      }),
    ).toBe(false);
  });

  it("returns false when stdout is not a TTY", () => {
    expect(
      shouldPromptAutoInit({
        env: {},
        isTTY: false,
        configExists: false,
        markerExists: false,
        flags: { noInit: false, init: false },
      }),
    ).toBe(false);
  });

  it("returns false when --no-init is set", () => {
    expect(
      shouldPromptAutoInit({
        env: {},
        isTTY: true,
        configExists: false,
        markerExists: false,
        flags: { noInit: true, init: false },
      }),
    ).toBe(false);
  });

  it("returns false when config already exists (unless --init)", () => {
    expect(
      shouldPromptAutoInit({
        env: {},
        isTTY: true,
        configExists: true,
        markerExists: false,
        flags: { noInit: false, init: false },
      }),
    ).toBe(false);
  });

  it("returns true when --init forces re-entry even with config present", () => {
    expect(
      shouldPromptAutoInit({
        env: {},
        isTTY: true,
        configExists: true,
        markerExists: false,
        flags: { noInit: false, init: true },
      }),
    ).toBe(true);
  });

  it("returns false when marker file exists", () => {
    expect(
      shouldPromptAutoInit({
        env: {},
        isTTY: true,
        configExists: false,
        markerExists: true,
        flags: { noInit: false, init: false },
      }),
    ).toBe(false);
  });

  it("returns true on a clean first-run path", () => {
    expect(
      shouldPromptAutoInit({
        env: {},
        isTTY: true,
        configExists: false,
        markerExists: false,
        flags: { noInit: false, init: false },
      }),
    ).toBe(true);
  });
});
