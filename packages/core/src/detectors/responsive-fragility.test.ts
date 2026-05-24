import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFile } from "@crimes/language-js";
import { DEFAULT_CONFIG } from "../config.js";
import type { LanguageJsDetector, LanguageJsDetectorContext } from "../detector.js";
import { responsiveFragilityDetector as _responsiveFragilityDetector } from "./responsive-fragility.js";
const responsiveFragilityDetector = _responsiveFragilityDetector as LanguageJsDetector;

async function ctxFromSource(source: string): Promise<LanguageJsDetectorContext> {
  const dir = await mkdtemp(join(tmpdir(), "crimes-rf-"));
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

describe("responsiveFragilityDetector", () => {
  it("fires on fixed-width + font-size + grid template values", async () => {
    const ctx = await ctxFromSource(
      `export default function App() {\n` +
        `  return (\n` +
        `    <div style={{ width: 800, fontSize: 24, gridTemplateColumns: "200px 200px" }}>\n` +
        `      hi\n` +
        `    </div>\n` +
        `  );\n` +
        `}\n`,
    );
    const findings = await responsiveFragilityDetector.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.type).toBe("responsive_fragility");
    expect(findings[0]!.severity).toBe("low");
  });

  it("does not fire when there are fewer than 3 hits", async () => {
    const ctx = await ctxFromSource(
      `export default function App() {\n` +
        `  return <div style={{ width: 500 }} />;\n` +
        `}\n`,
    );
    const findings = await responsiveFragilityDetector.run(ctx);
    expect(findings).toEqual([]);
  });

  it("does not fire on small widths or font sizes that pass the threshold", async () => {
    const ctx = await ctxFromSource(
      `export default function App() {\n` +
        `  return <div style={{ width: 200, fontSize: 14 }} />;\n` +
        `}\n`,
    );
    const findings = await responsiveFragilityDetector.run(ctx);
    expect(findings).toEqual([]);
  });

  it("suppresses font-size warnings when a @media query is in the file", async () => {
    const ctx = await ctxFromSource(
      `// @media (max-width: 600px) {} -- referenced via CSS-in-JS\n` +
        `export default function App() {\n` +
        `  return <div style={{ fontSize: 24 }} />;\n` +
        `}\n`,
    );
    const findings = await responsiveFragilityDetector.run(ctx);
    // Only one hit (no width / grid), and @media suppresses the font-size,
    // so under threshold → no finding.
    expect(findings).toEqual([]);
  });

  it("emits nothing on a file with no JSX", async () => {
    const ctx = await ctxFromSource(`export const x = 1;`);
    const findings = await responsiveFragilityDetector.run(ctx);
    expect(findings).toEqual([]);
  });
});
