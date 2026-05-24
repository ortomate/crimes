import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFile } from "@crimes/language-js";
import { DEFAULT_CONFIG } from "../config.js";
import type { LanguageJsDetector, LanguageJsDetectorContext } from "../detector.js";
import { designTokenEscapeDetector as _designTokenEscapeDetector } from "./design-token-escape.js";
const designTokenEscapeDetector = _designTokenEscapeDetector as LanguageJsDetector;

async function ctxFromSource(source: string): Promise<LanguageJsDetectorContext> {
  const dir = await mkdtemp(join(tmpdir(), "crimes-dte-"));
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

describe("designTokenEscapeDetector", () => {
  it("does not fire on a component with no style literals", async () => {
    const ctx = await ctxFromSource(
      `export default function App() { return <Button label="Save" />; }`,
    );
    const findings = await designTokenEscapeDetector.run(ctx);
    expect(findings).toEqual([]);
  });

  it("fires (low severity) on a file with 5+ raw style literals", async () => {
    const ctx = await ctxFromSource(
      `export default function App() {\n` +
        `  return (\n` +
        `    <div style={{ color: "#ff0000", background: "#00ff00", padding: "12px", margin: "16px", borderRadius: 8 }}>\n` +
        `      hi\n` +
        `    </div>\n` +
        `  );\n` +
        `}\n`,
    );
    const findings = await designTokenEscapeDetector.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.type).toBe("design_token_escape");
    expect(findings[0]!.severity).toBe("low");
  });

  it("escalates to medium at 10+ raw literals across two elements", async () => {
    const ctx = await ctxFromSource(
      `export default function App() {\n` +
        `  return (\n` +
        `    <>\n` +
        `      <div style={{ color: "#fff", background: "#000", padding: "10px", margin: "11px", borderRadius: 4, fontSize: "14px" }} />\n` +
        `      <span style={{ color: "#abcdef", background: "rgba(0,0,0,0.5)", padding: "20px", margin: "21px", borderRadius: 12 }} />\n` +
        `    </>\n` +
        `  );\n` +
        `}\n`,
    );
    const findings = await designTokenEscapeDetector.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("medium");
  });

  it("ignores allowed small px values like 0px / 1px", async () => {
    const ctx = await ctxFromSource(
      `export default function App() {\n` +
        `  return <div style={{ border: "1px", padding: "0px", margin: "1px", outline: "0px", top: "0px" }} />;\n` +
        `}\n`,
    );
    const findings = await designTokenEscapeDetector.run(ctx);
    expect(findings).toEqual([]);
  });
});
