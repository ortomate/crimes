import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFile } from "@crimes/language-js";
import { DEFAULT_CONFIG } from "../config.js";
import type { LanguageJsDetector, LanguageJsDetectorContext } from "../detector.js";
import { accessibleInteractionRiskDetector as _accessibleInteractionRiskDetector } from "./accessible-interaction-risk.js";
const accessibleInteractionRiskDetector = _accessibleInteractionRiskDetector as LanguageJsDetector;

async function ctxFromSource(source: string): Promise<LanguageJsDetectorContext> {
  const dir = await mkdtemp(join(tmpdir(), "crimes-air-"));
  const abs = join(dir, "Component.tsx");
  await writeFile(abs, source, "utf8");
  const parsed = parseFile({ absolutePath: abs, source });
  return {
    kind: "language-js",
    file: "Component.tsx",
    absolutePath: abs,
    source,
    parsed,
    config: DEFAULT_CONFIG,
  };
}

describe("accessibleInteractionRiskDetector", () => {
  it("fires on a <div onClick> with no a11y metadata", async () => {
    const ctx = await ctxFromSource(
      `export default function App() {\n` +
        `  return <div onClick={() => {}}>click me</div>;\n` +
        `}\n`,
    );
    const findings = await accessibleInteractionRiskDetector.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.type).toBe("accessible_interaction_risk");
    expect(findings[0]!.severity).toBe("medium");
  });

  it("does not fire when role and aria-label are present", async () => {
    const ctx = await ctxFromSource(
      `export default function App() {\n` +
        `  return <div role="button" aria-label="Save" onClick={() => {}}>X</div>;\n` +
        `}\n`,
    );
    const findings = await accessibleInteractionRiskDetector.run(ctx);
    expect(findings).toEqual([]);
  });

  it("does not fire on a native <button>", async () => {
    const ctx = await ctxFromSource(
      `export default function App() {\n` +
        `  return <button onClick={() => {}}>Save</button>;\n` +
        `}\n`,
    );
    const findings = await accessibleInteractionRiskDetector.run(ctx);
    expect(findings).toEqual([]);
  });

  it("does not fire on an <a href> with onClick", async () => {
    const ctx = await ctxFromSource(
      `export default function App() {\n` +
        `  return <a href="/x" onClick={() => {}}>link</a>;\n` +
        `}\n`,
    );
    const findings = await accessibleInteractionRiskDetector.run(ctx);
    expect(findings).toEqual([]);
  });

  it("fires on multiple offenders with capped evidence + overflow line", async () => {
    const onclicks = Array.from({ length: 7 })
      .map(() => `<div onClick={() => {}} />`)
      .join("");
    const ctx = await ctxFromSource(
      `export default function App() { return <>${onclicks}</>; }\n`,
    );
    const findings = await accessibleInteractionRiskDetector.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.evidence.some((e) => e.includes("+2 more"))).toBe(true);
  });
});
