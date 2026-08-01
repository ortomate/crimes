import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import type { CrimesConfig } from "../config.js";
import type { UniversalDetectorContext } from "../detector.js";
import { hardcodedLocalPathDetector } from "./hardcoded-local-path.js";

function makeCtx(
  source: string,
  overrides: { file?: string; config?: CrimesConfig } = {},
): UniversalDetectorContext {
  const file = overrides.file ?? "src/loader.ts";
  return {
    kind: "universal",
    file,
    absolutePath: `/tmp/${file}`,
    extension: file.match(/\.[^./]+$/)?.[0] ?? "",
    byteSize: source.length,
    readSource: async () => source,
    get lineCount() {
      return source.split("\n").length;
    },
    config: overrides.config ?? DEFAULT_CONFIG,
  };
}

describe("hardcodedLocalPathDetector", () => {
  it("returns nothing on a clean file", async () => {
    const findings = await hardcodedLocalPathDetector.run(
      makeCtx("export const ok = 1;\n"),
    );
    expect(findings).toEqual([]);
  });

  it("flags a single macOS user-home path", async () => {
    const findings = await hardcodedLocalPathDetector.run(
      makeCtx('const cfg = "/Users/andrew/dev/app/config.json";\n'),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.type).toBe("hardcoded_local_path");
    expect(findings[0]!.charge).toBe("Localhost-on-Disk");
    expect(findings[0]!.severity).toBe("medium");
    expect(findings[0]!.evidence.join(" ")).toContain(
      "/Users/andrew/dev/app/config.json",
    );
  });

  it("flags a single Linux user-home path", async () => {
    const findings = await hardcodedLocalPathDetector.run(
      makeCtx('const cfg = "/home/alex/projects/app/config.json";\n'),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.evidence.join(" ")).toContain(
      "/home/alex/projects/app/config.json",
    );
  });

  it("flags a Windows user-home path in backslash form", async () => {
    const findings = await hardcodedLocalPathDetector.run(
      makeCtx('const cfg = "C:\\\\Users\\\\bob\\\\app\\\\config.json";\n'),
    );
    expect(findings).toHaveLength(1);
    const evidence = findings[0]!.evidence.join(" ");
    expect(evidence).toMatch(/C:[\\/]+Users[\\/]+bob/);
  });

  it("flags a Windows user-home path in forward-slash form", async () => {
    const findings = await hardcodedLocalPathDetector.run(
      makeCtx('const cfg = "C:/Users/bob/app/config.json";\n'),
    );
    expect(findings).toHaveLength(1);
  });

  it("upgrades to high severity when 3+ hits are in one file", async () => {
    const findings = await hardcodedLocalPathDetector.run(
      makeCtx(
        'const a = "/Users/andrew/a";\n' +
          'const b = "/Users/andrew/b";\n' +
          'const c = "/Users/andrew/c";\n',
      ),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("high");
  });

  it("requires `/home/<name>/<more>` — bare `/home/page` (no trailing segment) is ignored", async () => {
    const findings = await hardcodedLocalPathDetector.run(
      makeCtx('const route = "/home/page";\n'),
    );
    expect(findings).toEqual([]);
  });

  it("does not match `/home` substring inside a longer identifier path", async () => {
    const findings = await hardcodedLocalPathDetector.run(
      makeCtx('const url = "at/home/page";\n'),
    );
    expect(findings).toEqual([]);
  });

  it("does not match system paths (`/tmp`, `/var`, `/etc`, `/usr/local`)", async () => {
    const findings = await hardcodedLocalPathDetector.run(
      makeCtx(
        'const a = "/tmp/cache";\n' +
          'const b = "/var/log/app";\n' +
          'const c = "/etc/hosts";\n' +
          'const d = "/usr/local/bin/node";\n',
      ),
    );
    expect(findings).toEqual([]);
  });

  it("skips test files", async () => {
    const findings = await hardcodedLocalPathDetector.run(
      makeCtx('const cfg = "/Users/andrew/test/fix.json";\n', {
        file: "src/loader.test.ts",
      }),
    );
    expect(findings).toEqual([]);
  });

  it("skips files under scripts/, examples/, fixtures/, test/, tests/", async () => {
    for (const file of [
      "scripts/build.ts",
      "examples/messy-ts-app/src/x.ts",
      "fixtures/loader-input.ts",
      "test/helpers.ts",
      "tests/setup.ts",
    ]) {
      const findings = await hardcodedLocalPathDetector.run(
        makeCtx('const cfg = "/Users/andrew/x";\n', { file }),
      );
      expect(findings).toEqual([]);
    }
  });

  it("honours detectors.options.hardcoded_local_path.allowedPaths exemptions", async () => {
    const config: CrimesConfig = {
      ...DEFAULT_CONFIG,
      detectors: {
        ...DEFAULT_CONFIG.detectors,
        options: {
          hardcoded_local_path: { allowedPaths: ["/Users/andrew/sample"] },
        },
      },
    };
    const findings = await hardcodedLocalPathDetector.run(
      makeCtx('const cfg = "/Users/andrew/sample/data.json";\n', { config }),
    );
    expect(findings).toEqual([]);
  });

  it("captures path in comments too — the literal is still a portability bug", async () => {
    const findings = await hardcodedLocalPathDetector.run(
      makeCtx("// see /Users/andrew/dev/app for the live copy\n"),
    );
    expect(findings).toHaveLength(1);
  });

  it("emits one file-level finding aggregating multiple paths", async () => {
    const findings = await hardcodedLocalPathDetector.run(
      makeCtx('const a = "/Users/andrew/a";\n' + 'const b = "/home/alex/b";\n'),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.lines).toEqual([1, 2]);
  });

  it("fires on a Python file containing /Users/alice/...", async () => {
    const findings = await hardcodedLocalPathDetector.run(
      makeCtx('PATH = "/Users/alice/secret.py"\n', { file: "src/config.py" }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.type).toBe("hardcoded_local_path");
    expect(findings[0]!.evidence.join(" ")).toContain("/Users/alice/secret.py");
  });
});
