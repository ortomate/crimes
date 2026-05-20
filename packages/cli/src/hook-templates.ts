export interface ClaudeHookEntry {
  matcher: string;
  hooks: Array<{ type: "command"; command: string; timeout?: number }>;
}

export interface ClaudeSettings {
  hooks?: {
    PreToolUse?: ClaudeHookEntry[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export const CLAUDE_HOOK_ENTRY: ClaudeHookEntry = {
  matcher: "Edit|Write|NotebookEdit",
  hooks: [
    {
      type: "command",
      command:
        'npx -y crimes context "$CLAUDE_TOOL_INPUT_file_path" --format json 2>/dev/null || true',
      timeout: 8000,
    },
  ],
};

export const CODEX_HOOK_DOCUMENT = JSON.stringify(
  {
    _note:
      "Forward-looking: Codex does not honour PreToolUse hooks as of crimes 0.11.0. The schema mirrors .claude/settings.local.json so this file is ready when the Codex hook surface lands. Safe to delete if your team doesn't want it.",
    hooks: {
      PreToolUse: [
        {
          matcher: "Edit|Write|NotebookEdit",
          hooks: [
            {
              type: "command",
              command:
                'npx -y crimes context "$CODEX_TOOL_INPUT_file_path" --format json 2>/dev/null || true',
              timeout: 8000,
            },
          ],
        },
      ],
    },
  },
  null,
  2,
);

export type MergeAction = "created" | "merged" | "skipped";

export interface MergeResult {
  action: MergeAction;
  document: ClaudeSettings;
}

const CRIMES_MARKER = "crimes context";

function isCrimesEntry(entry: ClaudeHookEntry): boolean {
  return entry.hooks.some(
    (h) => typeof h.command === "string" && h.command.includes(CRIMES_MARKER),
  );
}

export function mergeClaudeHook(
  existing: ClaudeSettings | undefined,
): MergeResult {
  if (existing === undefined) {
    return {
      action: "created",
      document: { hooks: { PreToolUse: [CLAUDE_HOOK_ENTRY] } },
    };
  }
  if (typeof existing !== "object" || existing === null) {
    throw new Error("settings document is not an object");
  }
  const hooks = (existing.hooks ?? {}) as Record<string, unknown>;
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) {
    throw new Error("settings.hooks is not an object");
  }
  const pre = (hooks.PreToolUse ?? []) as unknown;
  if (!Array.isArray(pre)) {
    throw new Error("settings.hooks.PreToolUse is not an array");
  }
  const entries = pre as ClaudeHookEntry[];
  if (entries.some(isCrimesEntry)) {
    return { action: "skipped", document: existing };
  }
  return {
    action: "merged",
    document: {
      ...existing,
      hooks: {
        ...((existing.hooks as Record<string, unknown>) ?? {}),
        PreToolUse: [...entries, CLAUDE_HOOK_ENTRY],
      },
    },
  };
}

export function serializeClaudeSettings(doc: ClaudeSettings): string {
  return JSON.stringify(doc, null, 2) + "\n";
}
