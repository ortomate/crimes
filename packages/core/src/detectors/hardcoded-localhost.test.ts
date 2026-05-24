import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import type { CrimesConfig } from "../config.js";
import type { LanguageJsDetector, LanguageJsDetectorContext } from "../detector.js";
import { hardcodedLocalhostDetector as _hardcodedLocalhostDetector } from "./hardcoded-localhost.js";
const hardcodedLocalhostDetector = _hardcodedLocalhostDetector as LanguageJsDetector;

function makeCtx(
  source: string,
  overrides: { file?: string; config?: CrimesConfig } = {},
): LanguageJsDetectorContext {
  return {
    kind: "language-js",
    file: overrides.file ?? "src/api.ts",
    absolutePath: "/tmp/api.ts",
    source,
    parsed: {
      lineCount: source.split("\n").length,
      functions: [],
      dateNowOrNewDateUses: [],
    },
    config: overrides.config ?? DEFAULT_CONFIG,
  };
}

describe("hardcodedLocalhostDetector", () => {
  it("returns nothing on a clean file", async () => {
    const findings = await hardcodedLocalhostDetector.run(
      makeCtx("export const ok = 1;\n"),
    );
    expect(findings).toEqual([]);
  });

  it("flags `localhost:3000`", async () => {
    const findings = await hardcodedLocalhostDetector.run(
      makeCtx('const url = "http://localhost:3000/api";\n'),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.type).toBe("hardcoded_localhost");
    expect(findings[0]!.charge).toBe("Dev-Server URL");
    expect(findings[0]!.severity).toBe("medium");
    expect(findings[0]!.evidence.join(" ")).toContain("localhost:3000");
  });

  it("flags 127.0.0.1:NNNN and 0.0.0.0:NNNN", async () => {
    const a = await hardcodedLocalhostDetector.run(
      makeCtx('const url = "http://127.0.0.1:8080/health";\n'),
    );
    expect(a).toHaveLength(1);

    const b = await hardcodedLocalhostDetector.run(
      makeCtx('const url = "http://0.0.0.0:5432/db";\n'),
    );
    expect(b).toHaveLength(1);
  });

  it("flags IPv6 loopback `[::1]:NNNN`", async () => {
    const findings = await hardcodedLocalhostDetector.run(
      makeCtx('const url = "http://[::1]:8080";\n'),
    );
    expect(findings).toHaveLength(1);
  });

  it("ignores `localhost` without a port", async () => {
    const findings = await hardcodedLocalhostDetector.run(
      makeCtx('const url = "https://localhost/api";\n'),
    );
    expect(findings).toEqual([]);
  });

  it("ignores non-loopback addresses on the same port", async () => {
    const findings = await hardcodedLocalhostDetector.run(
      makeCtx('const url = "http://api.example.com:3000/api";\n'),
    );
    expect(findings).toEqual([]);
  });

  it("upgrades to high severity when 3+ hits are in one file", async () => {
    const findings = await hardcodedLocalhostDetector.run(
      makeCtx(
        'const a = "http://localhost:3000/a";\n' +
        'const b = "http://localhost:3001/b";\n' +
        'const c = "http://127.0.0.1:8080/c";\n',
      ),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("high");
  });

  it("skips test files", async () => {
    const findings = await hardcodedLocalhostDetector.run(
      makeCtx('const url = "http://localhost:3000";\n', {
        file: "src/api.test.ts",
      }),
    );
    expect(findings).toEqual([]);
  });

  it("skips files under scripts/, examples/, docs/, fixtures/, test/, tests/", async () => {
    for (const file of [
      "scripts/dev.ts",
      "examples/messy-ts-app/src/api.ts",
      "docs/getting-started.md",
      "fixtures/dev-urls.json",
      "test/setup.ts",
      "tests/api.ts",
      "__tests__/setup.ts",
    ]) {
      const findings = await hardcodedLocalhostDetector.run(
        makeCtx('const url = "http://localhost:3000";\n', { file }),
      );
      expect(findings).toEqual([]);
    }
  });

  it("skips config-style basenames (.env*, *.config.*, docker-compose*, Dockerfile, README, CHANGELOG)", async () => {
    for (const file of [
      ".env",
      ".env.local",
      ".env.example",
      "next.config.js",
      "vite.config.ts",
      "vitest.config.mjs",
      "webpack.config.cjs",
      "docker-compose.yml",
      "docker-compose.override.yaml",
      "Dockerfile",
      "Dockerfile.dev",
      "README.md",
      "CHANGELOG.md",
    ]) {
      const findings = await hardcodedLocalhostDetector.run(
        makeCtx('const url = "http://localhost:3000";\n', { file }),
      );
      expect(findings).toEqual([]);
    }
  });

  it("still flags localhost inside a non-config file in the same directory", async () => {
    const findings = await hardcodedLocalhostDetector.run(
      makeCtx('const url = "http://localhost:3000";\n', {
        file: "apps/web/src/api.ts",
      }),
    );
    expect(findings).toHaveLength(1);
  });

  it("honours detectors.options.hardcoded_localhost.allowedUrls", async () => {
    const config: CrimesConfig = {
      ...DEFAULT_CONFIG,
      detectors: {
        ...DEFAULT_CONFIG.detectors,
        options: {
          hardcoded_localhost: { allowedUrls: ["localhost:9229"] },
        },
      },
    };
    const findings = await hardcodedLocalhostDetector.run(
      makeCtx('const inspector = "http://localhost:9229/debug";\n', { config }),
    );
    expect(findings).toEqual([]);
  });

  it("emits one file-level finding aggregating multiple hits", async () => {
    const findings = await hardcodedLocalhostDetector.run(
      makeCtx(
        'const a = "http://localhost:3000";\n' +
        'const b = "http://127.0.0.1:8080";\n',
      ),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.lines).toEqual([1, 2]);
  });
});
