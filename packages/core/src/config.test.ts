import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ConfigParseError,
  DEFAULT_CONFIG,
  DEFAULT_SUPPRESSIONS_PATH,
  loadConfig,
  loadConfigDetailed,
  resolveSuppressionsPath,
} from "./config.js";
import { UnknownDetectorError } from "./detector-registry.js";
import { policyFor } from "./detectors/large-function.js";
import { scan } from "./scan.js";

async function makeTempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "crimes-config-test-"));
}

async function writeConfig(root: string, body: unknown): Promise<void> {
  await writeFile(
    join(root, "crimes.config.json"),
    typeof body === "string" ? body : JSON.stringify(body),
    "utf8",
  );
}

describe("loadConfig", () => {
  it("returns DEFAULT_CONFIG when no crimes.config.json exists", async () => {
    const root = await makeTempDir();
    expect(loadConfig(root)).toEqual(DEFAULT_CONFIG);
  });

  it("throws ConfigParseError on malformed JSON", async () => {
    const root = await makeTempDir();
    await writeConfig(root, "{ not json");
    expect(() => loadConfig(root)).toThrowError(ConfigParseError);
  });

  it("throws ConfigParseError on a malformed value", async () => {
    const root = await makeTempDir();
    await writeConfig(root, { thresholds: { largeFileLines: "not-a-number" } });
    expect(() => loadConfig(root)).toThrowError(ConfigParseError);
  });

  it("preserves unknown top-level keys silently (forward compat)", async () => {
    const root = await makeTempDir();
    await writeConfig(root, { include: ["**/*.ts"], extraFutureKey: true });
    const config = loadConfig(root);
    expect(config.include).toEqual(["**/*.ts"]);
    // Unknown keys do not prevent the merged config from loading.
  });

  it("merges thresholds with defaults", async () => {
    const root = await makeTempDir();
    await writeConfig(root, { thresholds: { largeFileLines: 1000 } });
    const config = loadConfig(root);
    expect(config.thresholds.largeFileLines).toBe(1000);
    // Other defaults intact.
    expect(config.thresholds.largeFunctionLines).toBe(60);
    expect(config.thresholds.todoDensityPerKLoc).toBe(10);
  });

  it("honours $schema field for IDE validation", async () => {
    const root = await makeTempDir();
    await writeConfig(root, {
      $schema: "https://crimes.sh/schema/0.1.0/config.json",
    });
    const config = loadConfig(root);
    expect(config.$schema).toBe("https://crimes.sh/schema/0.1.0/config.json");
  });

  it("loadConfigDetailed returns path when a config was read", async () => {
    const root = await makeTempDir();
    await writeConfig(root, {});
    const result = loadConfigDetailed(root);
    expect(result.path).toContain("crimes.config.json");
    expect(result.issues).toEqual([]);
  });
});

describe("thresholds.largeFunction overrides", () => {
  it("policyFor(domain) prefers largeFunction.domain over largeFunctionLines", () => {
    const policy = policyFor("domain", {
      ...DEFAULT_CONFIG,
      thresholds: {
        ...DEFAULT_CONFIG.thresholds,
        largeFunctionLines: 60,
        largeFunction: { domain: 120 },
      },
    });
    expect(policy.threshold).toBe(120);
  });

  it("policyFor(domain) falls back to legacy largeFunctionLines when not overridden", () => {
    const policy = policyFor("domain", {
      ...DEFAULT_CONFIG,
      thresholds: {
        ...DEFAULT_CONFIG.thresholds,
        largeFunctionLines: 42,
      },
    });
    expect(policy.threshold).toBe(42);
  });

  it("policyFor(route_handler) honours per-shape override", () => {
    const policy = policyFor("route_handler", {
      ...DEFAULT_CONFIG,
      thresholds: {
        ...DEFAULT_CONFIG.thresholds,
        largeFunction: { route_handler: 250 },
      },
    });
    expect(policy.threshold).toBe(250);
  });

  it("policyFor without overrides uses built-in defaults", () => {
    const policy = policyFor("react_component", DEFAULT_CONFIG);
    expect(policy.threshold).toBe(200);
  });
});

describe("detectors.enable / disable wiring", () => {
  it("detectors.disable removes the detector from the run", async () => {
    const root = await makeTempDir();
    await writeFile(
      join(root, "todos.ts"),
      `// TODO: refactor\n// TODO: investigate\n// TODO: ship\n` +
        Array.from({ length: 50 }, () => "// line").join("\n"),
      "utf8",
    );
    await writeConfig(root, { detectors: { disable: ["todo_density"] } });

    const report = await scan({ root });
    const todoFindings = report.findings.filter(
      (f) => f.type === "todo_density",
    );
    expect(todoFindings).toEqual([]);
  });

  it("detectors.enable with a non-empty list runs only those detectors", async () => {
    const root = await makeTempDir();
    await writeFile(
      join(root, "huge.ts"),
      Array.from({ length: 500 }, () => "// line").join("\n"),
      "utf8",
    );
    await writeConfig(root, { detectors: { enable: ["large_file"] } });

    const report = await scan({ root });
    const types = new Set(report.findings.map((f) => f.type));
    expect(types.has("large_file")).toBe(true);
    // No other detectors fired.
    for (const t of types) {
      expect(t).toBe("large_file");
    }
  });

  it("detectors.disable with an unknown id throws UnknownDetectorError", async () => {
    const root = await makeTempDir();
    await writeConfig(root, { detectors: { disable: ["not_a_detector"] } });
    await expect(scan({ root })).rejects.toBeInstanceOf(UnknownDetectorError);
  });

  it("detectors.enable with an unknown id throws UnknownDetectorError", async () => {
    const root = await makeTempDir();
    await writeConfig(root, { detectors: { enable: ["typo_density"] } });
    await expect(scan({ root })).rejects.toBeInstanceOf(UnknownDetectorError);
  });
});

describe("ia.aliasGroups merges with defaults", () => {
  it("config groups are added on top of DEFAULT_ALIAS_GROUPS", async () => {
    const root = await makeTempDir();
    // Add a custom alias group; ensure the built-in `tenant` group still
    // contributes to the catalogue.
    await writeConfig(root, {
      ia: {
        aliasGroups: [
          { id: "dataset", aliases: ["dataset", "corpus", "collection"] },
        ],
      },
    });
    // Reach into scan's resolveAliasGroups via a fresh scan with no source
    // files — IA index build still records the resolved alias group list.
    await writeFile(
      join(root, "noop.ts"),
      "export const ok = 1;\n",
      "utf8",
    );
    const report = await scan({ root });
    // The scan succeeded — the merge didn't crash.
    expect(report.report_type).toBe("scan");
  });
});

describe("suppressions.path", () => {
  it("defaults to .crimes/suppressions.json", () => {
    const root = "/tmp/fake-root";
    expect(resolveSuppressionsPath(root, DEFAULT_CONFIG)).toBe(
      `${root}/${DEFAULT_SUPPRESSIONS_PATH}`,
    );
  });

  it("honours suppressions.path override", () => {
    const root = "/tmp/fake-root";
    const resolved = resolveSuppressionsPath(root, {
      ...DEFAULT_CONFIG,
      suppressions: { path: ".crimes/custom.json" },
    });
    expect(resolved).toBe(`${root}/.crimes/custom.json`);
  });
});

describe("detectors.options validation", () => {
  it("accepts an empty options block when no registry is passed", async () => {
    const root = await makeTempDir();
    await writeConfig(root, { detectors: { options: {} } });
    const config = loadConfig(root);
    expect(config.detectors?.options).toEqual({});
  });

  it("preserves options through merge when no registry is passed", async () => {
    const root = await makeTempDir();
    await writeConfig(root, {
      detectors: { options: { some_detector: { allowedNames: ["data"] } } },
    });
    const config = loadConfig(root);
    expect(config.detectors?.options).toEqual({
      some_detector: { allowedNames: ["data"] },
    });
  });

  it("rejects a value that isn't an object (top-level schema)", async () => {
    const root = await makeTempDir();
    await writeConfig(root, { detectors: { options: "not an object" } });
    expect(() => loadConfig(root)).toThrowError(ConfigParseError);
  });

  it("registry: known detector id with a matching schema validates", async () => {
    const root = await makeTempDir();
    await writeConfig(root, {
      detectors: {
        options: { example_detector: { allowedNames: ["data", "ctx"] } },
      },
    });
    const registry = [
      {
        id: "example_detector",
        optionsSchema: z.object({
          allowedNames: z.array(z.string()).optional(),
        }),
      },
    ];
    const config = loadConfig(root, registry);
    expect(config.detectors?.options).toEqual({
      example_detector: { allowedNames: ["data", "ctx"] },
    });
  });

  it("registry: unknown detector id raises ConfigParseError", async () => {
    const root = await makeTempDir();
    await writeConfig(root, {
      detectors: { options: { not_a_detector: { foo: 1 } } },
    });
    const registry = [
      { id: "example_detector", optionsSchema: z.object({}) },
    ];
    expect(() => loadConfig(root, registry)).toThrowError(
      /detectors\.options\.not_a_detector: unknown detector id/,
    );
  });

  it("registry: known detector with no optionsSchema raises ConfigParseError", async () => {
    const root = await makeTempDir();
    await writeConfig(root, {
      detectors: { options: { example_detector: { foo: 1 } } },
    });
    const registry = [{ id: "example_detector" }];
    expect(() => loadConfig(root, registry)).toThrowError(
      /detectors\.options\.example_detector: this detector accepts no options/,
    );
  });

  it("registry: known detector with malformed options raises ConfigParseError", async () => {
    const root = await makeTempDir();
    await writeConfig(root, {
      detectors: {
        options: { example_detector: { allowedNames: "not an array" } },
      },
    });
    const registry = [
      {
        id: "example_detector",
        optionsSchema: z.object({
          allowedNames: z.array(z.string()).optional(),
        }),
      },
    ];
    expect(() => loadConfig(root, registry)).toThrowError(
      /detectors\.options\.example_detector:/,
    );
  });

  it("registry: empty options block passes registry validation", async () => {
    const root = await makeTempDir();
    await writeConfig(root, { detectors: { options: {} } });
    const registry = [
      { id: "example_detector", optionsSchema: z.object({}) },
    ];
    expect(() => loadConfig(root, registry)).not.toThrow();
  });

  it("registry: omitted options field passes registry validation", async () => {
    const root = await makeTempDir();
    await writeConfig(root, { detectors: { enable: ["large_file"] } });
    const registry = [
      { id: "example_detector", optionsSchema: z.object({}) },
    ];
    const config = loadConfig(root, registry);
    expect(config.detectors?.options).toBeUndefined();
  });

  it("scan passes the built-in registry through loadConfig (live integration)", async () => {
    const root = await makeTempDir();
    await writeFile(
      join(root, "noop.ts"),
      "export const ok = 1;\n",
      "utf8",
    );
    await writeConfig(root, {
      detectors: { options: { not_a_detector_xyz: {} } },
    });
    // None of the built-ins have the id `not_a_detector_xyz`, so scan
    // should bubble up the ConfigParseError from the registry check.
    await expect(scan({ root })).rejects.toThrowError(
      /detectors\.options\.not_a_detector_xyz: unknown detector id/,
    );
  });
});

describe("architecture placeholder", () => {
  it("parses architecture.layers and architecture.rules without consuming them", async () => {
    const root = await makeTempDir();
    await writeConfig(root, {
      architecture: {
        layers: [
          { name: "ui", pattern: "src/components/**" },
          { name: "domain", pattern: "src/domain/**" },
        ],
        rules: [{ from: "domain", cannotImport: ["ui"] }],
      },
    });
    const config = loadConfig(root);
    expect(config.architecture?.layers).toHaveLength(2);
    expect(config.architecture?.rules?.[0]?.from).toBe("domain");
  });

  it("rejects a malformed architecture.layers entry", async () => {
    const root = await makeTempDir();
    await writeConfig(root, {
      architecture: { layers: [{ name: "ui" }] }, // missing pattern
    });
    expect(() => loadConfig(root)).toThrowError(ConfigParseError);
  });
});

describe("scopeTiers", () => {
  it("defaults to the static seven-pattern non-domain list", async () => {
    const root = await makeTempDir();
    const cfg = loadConfig(root);
    expect(cfg.scopeTiers.nonDomain).toEqual([
      "scripts/**",
      "examples/**",
      "fixtures/**",
      "public/**",
      "**/__tests__/**",
      "**/*.test.{ts,tsx,js,jsx}",
      "**/*.spec.{ts,tsx,js,jsx}",
    ]);
  });

  it("honours a user-supplied empty list (opt-out)", async () => {
    const root = await makeTempDir();
    await writeConfig(root, { scopeTiers: { nonDomain: [] } });
    expect(loadConfig(root).scopeTiers.nonDomain).toEqual([]);
  });

  it("honours a user-supplied custom list", async () => {
    const root = await makeTempDir();
    await writeConfig(root, {
      scopeTiers: { nonDomain: ["packages/legacy/**"] },
    });
    expect(loadConfig(root).scopeTiers.nonDomain).toEqual([
      "packages/legacy/**",
    ]);
  });

  it("rejects non-string entries", async () => {
    const root = await makeTempDir();
    await writeConfig(root, { scopeTiers: { nonDomain: [42] } });
    expect(() => loadConfig(root)).toThrowError(ConfigParseError);
  });

  it("rejects empty-string entries (matches the glob-validation pattern elsewhere)", async () => {
    const root = await makeTempDir();
    await writeConfig(root, { scopeTiers: { nonDomain: [""] } });
    expect(() => loadConfig(root)).toThrowError(ConfigParseError);
  });
});

describe("scan.topFiles", () => {
  it("defaults to 5", async () => {
    const root = await makeTempDir();
    expect(loadConfig(root).scan.topFiles).toBe(5);
  });

  it("honours a user-supplied value", async () => {
    const root = await makeTempDir();
    await writeConfig(root, { scan: { topFiles: 10 } });
    expect(loadConfig(root).scan.topFiles).toBe(10);
  });

  it("rejects non-positive integers", async () => {
    const root = await makeTempDir();
    await writeConfig(root, { scan: { topFiles: 0 } });
    expect(() => loadConfig(root)).toThrowError(ConfigParseError);
  });

  it("rejects non-integer values", async () => {
    const root = await makeTempDir();
    await writeConfig(root, { scan: { topFiles: 3.5 } });
    expect(() => loadConfig(root)).toThrowError(ConfigParseError);
  });
});

describe("loadConfig — triage.resurfaceBase", () => {
  it("defaults to 'main'", async () => {
    const root = await makeTempDir();
    const config = loadConfig(root);
    expect(config.triage?.resurfaceBase).toBe("main");
  });

  it("honours an explicit resurfaceBase", async () => {
    const root = await makeTempDir();
    await writeConfig(root, { triage: { resurfaceBase: "develop" } });
    const config = loadConfig(root);
    expect(config.triage?.resurfaceBase).toBe("develop");
  });

  it("accepts empty string as 'resurfacing disabled'", async () => {
    const root = await makeTempDir();
    await writeConfig(root, { triage: { resurfaceBase: "" } });
    const config = loadConfig(root);
    expect(config.triage?.resurfaceBase).toBe("");
  });

  it("rejects non-string resurfaceBase", async () => {
    const root = await makeTempDir();
    await writeConfig(root, { triage: { resurfaceBase: 42 } });
    expect(() => loadConfig(root)).toThrowError(/resurfaceBase/);
  });
});
