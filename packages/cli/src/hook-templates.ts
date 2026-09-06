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

// Claude Code's PreToolUse hook contract delivers tool input on stdin
// as JSON (https://code.claude.com/docs/en/hooks). Older drafts of this
// hook used a `$CLAUDE_TOOL_INPUT_file_path` env var that never existed
// in the spec — the hook silently no-op'd because the var expanded to
// "". `crimes hook` reads stdin JSON itself, so the hook command stays
// stable across hook-host shape changes.
export const CLAUDE_HOOK_ENTRY: ClaudeHookEntry = {
  matcher: "Edit|Write|NotebookEdit",
  hooks: [
    {
      type: "command",
      command: "npx -y crimes hook --format compact || true",
      timeout: 8000,
    },
  ],
};

export type MergeAction = "created" | "merged" | "skipped";

export interface MergeResult {
  action: MergeAction;
  document: ClaudeSettings;
}

// Recognise both the current ("crimes hook") and the legacy 0.11.0-draft
// ("crimes context $CLAUDE_TOOL_INPUT_file_path") shapes so we don't
// double-write into a settings.json that already has the broken legacy
// entry on disk. Only the exact shipped legacy command is safe to migrate;
// customized commands are preserved.
const CRIMES_HOOK_MARKERS = ["crimes hook", "crimes context"] as const;
const LEGACY_COMMAND =
  'npx -y crimes context "$CLAUDE_TOOL_INPUT_file_path" --format json 2>/dev/null || true';

function isCrimesEntry(entry: ClaudeHookEntry): boolean {
  return entry.hooks.some(
    (h) =>
      typeof h.command === "string" &&
      CRIMES_HOOK_MARKERS.some((marker) => h.command.includes(marker)),
  );
}

function validateEntries(entries: unknown[]): asserts entries is ClaudeHookEntry[] {
  for (const entry of entries) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("hooks" in entry) ||
      !Array.isArray(entry.hooks)
    ) {
      throw new Error("PreToolUse entries must contain a hooks array");
    }
    for (const hook of entry.hooks) {
      if (
        typeof hook !== "object" ||
        hook === null ||
        typeof hook.type !== "string" ||
        (hook.type === "command" && typeof hook.command !== "string")
      ) {
        throw new Error("Invalid PreToolUse hook");
      }
    }
  }
}

export function mergeClaudeHook(existing: ClaudeSettings | undefined): MergeResult {
  if (existing === undefined) {
    return {
      action: "created",
      document: { hooks: { PreToolUse: [CLAUDE_HOOK_ENTRY] } },
    };
  }
  if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
    throw new Error("settings document is not an object");
  }
  const hooks = (existing.hooks === undefined ? {} : existing.hooks) as Record<
    string,
    unknown
  >;
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) {
    throw new Error("settings.hooks is not an object");
  }
  const pre = (hooks.PreToolUse === undefined ? [] : hooks.PreToolUse) as unknown;
  if (!Array.isArray(pre)) {
    throw new Error("settings.hooks.PreToolUse is not an array");
  }
  validateEntries(pre);
  const entries = pre;
  if (
    entries.some((entry) => entry.hooks.some((hook) => hook.command === LEGACY_COMMAND))
  ) {
    const migrated = entries.map((entry) => ({
      ...entry,
      hooks: entry.hooks.map((hook) =>
        hook.command === LEGACY_COMMAND ? { ...CLAUDE_HOOK_ENTRY.hooks[0]! } : hook,
      ),
    }));
    return {
      action: "merged",
      document: { ...existing, hooks: { ...existing.hooks, PreToolUse: migrated } },
    };
  }
  if (entries.some(isCrimesEntry)) {
    return { action: "skipped", document: existing };
  }
  // Prefer merging into an existing entry with the exact same matcher
  // string. Two entries with the same matcher both fire on every Edit,
  // so collapsing them into one entry with two hook commands is the
  // cleaner shape (and what a user who already manages PreToolUse hooks
  // would expect).
  const matchedIdx = entries.findIndex(
    (e) => typeof e?.matcher === "string" && e.matcher === CLAUDE_HOOK_ENTRY.matcher,
  );
  let nextEntries: ClaudeHookEntry[];
  if (matchedIdx >= 0) {
    const target = entries[matchedIdx]!;
    const targetHooks = Array.isArray(target.hooks) ? target.hooks : [];
    nextEntries = entries.map((entry, idx) =>
      idx === matchedIdx
        ? { ...entry, hooks: [...targetHooks, ...CLAUDE_HOOK_ENTRY.hooks] }
        : entry,
    );
  } else {
    nextEntries = [...entries, CLAUDE_HOOK_ENTRY];
  }
  return {
    action: "merged",
    document: {
      ...existing,
      hooks: {
        ...((existing.hooks as Record<string, unknown>) ?? {}),
        PreToolUse: nextEntries,
      },
    },
  };
}

export function serializeClaudeSettings(doc: ClaudeSettings): string {
  return JSON.stringify(doc, null, 2) + "\n";
}
