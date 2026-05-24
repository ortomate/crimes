import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import type { LanguageJsDetector, LanguageJsDetectorContext } from "../detector.js";
import type {
  IaFileSignals,
  IaIndex,
  IaLabelSignal,
} from "../ia/types.js";
import { copyIaDriftDetector as _copyIaDriftDetector } from "./copy-ia-drift.js";
const copyIaDriftDetector = _copyIaDriftDetector as LanguageJsDetector;

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

describe("copyIaDriftDetector", () => {
  it("fires on three JSX labels using delete/remove/archive across multiple files", async () => {
    const jsx = (v: string): IaLabelSignal => ({
      value: v,
      line: 1,
      kind: "jsx_label",
      source: "Button",
    });
    const ia = buildIndex({
      "src/a.tsx": [jsx("Delete"), jsx("Remove")],
      "src/b.tsx": [jsx("Archive"), jsx("Delete")],
      "src/c.tsx": [jsx("Remove"), jsx("Archive")],
    });
    const anchor = Object.keys(ia.files).sort()[0]!;
    const findings = await copyIaDriftDetector.run(ctxFor(anchor, ia));
    const drift = findings.find((f) => f.type === "copy_ia_drift");
    expect(drift).toBeDefined();
    expect(drift!.charge).toBe("Copy / IA Drift");
  });

  it("does not fire on non-JSX labels (e.g. document_title)", async () => {
    const title = (v: string): IaLabelSignal => ({
      value: v,
      line: 1,
      kind: "document_title",
    });
    const ia = buildIndex({
      "src/a.tsx": [title("Delete"), title("Remove")],
      "src/b.tsx": [title("Archive")],
      "src/c.tsx": [title("Delete"), title("Remove")],
    });
    const anchor = Object.keys(ia.files).sort()[0]!;
    const findings = await copyIaDriftDetector.run(ctxFor(anchor, ia));
    expect(findings).toEqual([]);
  });

  it("emits nothing when ctx.ia is absent", async () => {
    const findings = await copyIaDriftDetector.run({
      kind: "language-js",
      file: "src/a.tsx",
      absolutePath: "/tmp/src/a.tsx",
      source: "",
      parsed: { lineCount: 0, functions: [], dateNowOrNewDateUses: [] },
      config: DEFAULT_CONFIG,
    });
    expect(findings).toEqual([]);
  });
});
