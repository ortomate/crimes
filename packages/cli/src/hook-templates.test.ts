import { describe, expect, it } from "vitest";
import {
  CLAUDE_HOOK_ENTRY,
  CODEX_HOOK_DOCUMENT,
  mergeClaudeHook,
  serializeClaudeSettings,
} from "./hook-templates.js";

describe("hook-templates", () => {
  it("CLAUDE_HOOK_ENTRY is a single PreToolUse hook entry calling crimes context", () => {
    expect(CLAUDE_HOOK_ENTRY.matcher).toBe("Edit|Write|NotebookEdit");
    expect(CLAUDE_HOOK_ENTRY.hooks[0]!.command).toContain("crimes context");
    expect(CLAUDE_HOOK_ENTRY.hooks[0]!.timeout).toBe(8000);
  });

  it("CODEX_HOOK_DOCUMENT is valid JSON with a Codex placeholder _note", () => {
    const parsed = JSON.parse(CODEX_HOOK_DOCUMENT);
    expect(parsed._note).toMatch(/Codex/);
    expect(parsed.hooks.PreToolUse[0].matcher).toBe("Edit|Write|NotebookEdit");
  });

  it("mergeClaudeHook creates a new document when input is undefined", () => {
    const result = mergeClaudeHook(undefined);
    expect(result.action).toBe("created");
    expect(result.document.hooks?.PreToolUse).toHaveLength(1);
  });

  it("mergeClaudeHook skips when an existing crimes hook is present", () => {
    const existing = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Edit",
            hooks: [
              { type: "command" as const, command: "npx crimes context $FILE" },
            ],
          },
        ],
      },
    };
    const result = mergeClaudeHook(existing);
    expect(result.action).toBe("skipped");
  });

  it("mergeClaudeHook appends to existing non-crimes PreToolUse hooks", () => {
    const existing = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command" as const, command: "echo hello" }],
          },
        ],
      },
    };
    const result = mergeClaudeHook(existing);
    expect(result.action).toBe("merged");
    expect(result.document.hooks?.PreToolUse).toHaveLength(2);
    expect(result.document.hooks?.PreToolUse?.[0]!.matcher).toBe("Bash");
  });

  it("mergeClaudeHook preserves unrelated top-level keys", () => {
    const existing = { permissions: { allow: ["bash"] }, hooks: {} };
    const result = mergeClaudeHook(existing);
    expect(result.action).toBe("merged");
    expect((result.document as { permissions?: unknown }).permissions).toEqual({
      allow: ["bash"],
    });
    expect(result.document.hooks?.PreToolUse).toHaveLength(1);
  });

  it("mergeClaudeHook throws when the document shape is unexpected", () => {
    expect(() => mergeClaudeHook({ hooks: "not-an-object" } as never)).toThrow();
    expect(() =>
      mergeClaudeHook({ hooks: { PreToolUse: "not-an-array" } } as never),
    ).toThrow();
    expect(() => mergeClaudeHook("scalar" as never)).toThrow();
  });

  it("serializeClaudeSettings pretty-prints with a trailing newline", () => {
    const out = serializeClaudeSettings({
      hooks: { PreToolUse: [CLAUDE_HOOK_ENTRY] },
    });
    expect(out.endsWith("\n")).toBe(true);
    expect(out).toContain("  ");
  });
});
