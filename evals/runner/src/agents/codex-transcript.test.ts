import { describe, expect, it } from "vitest";
import { extractCodexResponse } from "./codex-transcript.js";

function event(obj: unknown): string {
  return JSON.stringify(obj);
}

const AGENT_MSG = (text: string) =>
  event({ type: "item.completed", item: { id: "m", type: "agent_message", text } });

const TOOL_OUTPUT = (output: string) =>
  event({
    type: "item.completed",
    item: {
      id: "t",
      type: "command_execution",
      command: "/bin/zsh -lc 'cat SKILL.md'",
      aggregated_output: output,
      exit_code: 0,
    },
  });

describe("extractCodexResponse", () => {
  it("returns only the agent's messages from a JSONL transcript", () => {
    const stdout = [
      event({ type: "thread.started", thread_id: "abc" }),
      event({ type: "turn.started" }),
      AGENT_MSG("I'll check the scan output."),
      TOOL_OUTPUT("locale_drift direct_date large_function"),
      AGENT_MSG("The helper to avoid is prettyDueDate."),
      event({ type: "turn.completed", usage: {} }),
    ].join("\n");

    const out = extractCodexResponse(stdout);
    expect(out).toContain("I'll check the scan output.");
    expect(out).toContain("The helper to avoid is prettyDueDate.");
  });

  it("drops tool output so detector slugs the agent only read are not credited", () => {
    // The regression this exists for: SKILL.md names detector slugs,
    // and `cat`ing it used to make the scorer think the agent had
    // referenced them.
    const stdout = [
      event({ type: "thread.started", thread_id: "abc" }),
      TOOL_OUTPUT("locale_drift is a detector. See src/secret-path.ts"),
      AGENT_MSG("No findings worth reporting."),
    ].join("\n");

    const out = extractCodexResponse(stdout);
    expect(out).not.toContain("locale_drift");
    expect(out).not.toContain("src/secret-path.ts");
    expect(out).toBe("No findings worth reporting.");
  });

  it("leaves plain prose untouched (claude runner output)", () => {
    const prose = "The file src/date.ts has a locale_drift finding.";
    expect(extractCodexResponse(prose)).toBe(prose);
  });

  it("is idempotent — extracting twice equals extracting once", () => {
    const stdout = [
      event({ type: "thread.started", thread_id: "abc" }),
      AGENT_MSG("Answer text."),
    ].join("\n");
    const once = extractCodexResponse(stdout);
    expect(extractCodexResponse(once)).toBe(once);
  });

  it("falls back to the raw transcript when no agent_message is present", () => {
    // Shape changed upstream: better to score the transcript badly than
    // to silently score an empty string as total failure.
    const stdout = [
      event({ type: "thread.started", thread_id: "abc" }),
      TOOL_OUTPUT("some output"),
    ].join("\n");
    expect(extractCodexResponse(stdout)).toBe(stdout);
  });

  it("skips unparseable lines without throwing", () => {
    const stdout = [
      event({ type: "thread.started", thread_id: "abc" }),
      "{ this is not valid json",
      AGENT_MSG("Still got here."),
    ].join("\n");
    expect(extractCodexResponse(stdout)).toBe("Still got here.");
  });

  it("preserves ordering across multiple agent messages", () => {
    const stdout = [
      event({ type: "thread.started", thread_id: "abc" }),
      AGENT_MSG("first"),
      AGENT_MSG("second"),
      AGENT_MSG("third"),
    ].join("\n");
    expect(extractCodexResponse(stdout)).toBe("first\n\nsecond\n\nthird");
  });
});
