import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import type { LanguageJsDetectorContext } from "../detector.js";
import type {
  IaFileSignals,
  IaIndex,
  IaLabelSignal,
} from "../ia/types.js";
import { actionLabelDriftDetector } from "./action-label-drift.js";

function buildIndex(
  fileLabels: Record<string, IaLabelSignal[]>,
): IaIndex {
  const files: Record<string, IaFileSignals> = {};
  for (const [file, labels] of Object.entries(fileLabels)) {
    files[file] = {
      file,
      tokens: [],
      componentName: undefined,
      routes: [],
      labels,
      navEntries: [],
      permissions: [],
      isNavSource: false,
    };
  }
  return {
    root: "/tmp/repo",
    files,
    routes: [],
    navSources: [],
    docs: [],
    agentContext: {
      agentsMdPath: undefined,
      claudeMdPath: undefined,
      claudeSkills: [],
      declaredBins: [],
      referencedCommands: [],
    },
    aliasGroups: [],
  };
}

function ctxFor(file: string, ia: IaIndex): LanguageJsDetectorContext {
  return {
    kind: "language-js",
    file,
    absolutePath: `/tmp/repo/${file}`,
    source: "",
    parsed: { lineCount: 0, functions: [], dateNowOrNewDateUses: [] },
    config: DEFAULT_CONFIG,
    ia,
  };
}

function jsxLabel(value: string, source = "Button"): IaLabelSignal {
  return { value, line: 1, kind: "jsx_label", source };
}

describe("actionLabelDriftDetector", () => {
  it("fires when three or more delete-group aliases appear across multiple files", async () => {
    const ia = buildIndex({
      "src/pages/team/Settings.tsx": [jsxLabel("Delete user"), jsxLabel("Remove member")],
      "src/pages/billing/Subscription.tsx": [jsxLabel("Archive plan"), jsxLabel("Delete plan")],
      "src/components/Modal.tsx": [jsxLabel("Remove account"), jsxLabel("Archive workspace")],
    });
    const anchor = Object.keys(ia.files).sort()[0]!;
    const findings = await actionLabelDriftDetector.run(ctxFor(anchor, ia));
    const drift = findings.find((f) => f.type === "action_label_drift");
    expect(drift).toBeDefined();
    expect(drift!.evidence.some((e) => e.startsWith("group: delete"))).toBe(true);
    expect(drift!.evidence.some((e) => e.includes("delete"))).toBe(true);
    expect(drift!.evidence.some((e) => e.includes("remove"))).toBe(true);
    expect(drift!.evidence.some((e) => e.includes("archive"))).toBe(true);
  });

  it("does not fire when the same alias appears repeatedly (no drift)", async () => {
    const ia = buildIndex({
      "src/pages/a.tsx": [jsxLabel("Delete"), jsxLabel("Delete")],
      "src/pages/b.tsx": [jsxLabel("Delete")],
    });
    const anchor = Object.keys(ia.files).sort()[0]!;
    const findings = await actionLabelDriftDetector.run(ctxFor(anchor, ia));
    expect(findings).toEqual([]);
  });

  it("does not fire when only two distinct aliases appear", async () => {
    const ia = buildIndex({
      "src/pages/a.tsx": [jsxLabel("Delete"), jsxLabel("Remove")],
      "src/pages/b.tsx": [jsxLabel("Delete"), jsxLabel("Remove")],
    });
    const anchor = Object.keys(ia.files).sort()[0]!;
    const findings = await actionLabelDriftDetector.run(ctxFor(anchor, ia));
    expect(findings).toEqual([]);
  });

  it("emits nothing when ctx.ia is absent", async () => {
    const findings = await actionLabelDriftDetector.run({
      kind: "language-js",
      file: "src/pages/a.tsx",
      absolutePath: "/tmp/repo/src/pages/a.tsx",
      source: "",
      parsed: { lineCount: 0, functions: [], dateNowOrNewDateUses: [] },
      config: DEFAULT_CONFIG,
    });
    expect(findings).toEqual([]);
  });
});
