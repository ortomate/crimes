import { parseJavaFile } from "@crimes/language-java";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../config.js";
import type {
  LanguageJavaDetector,
  LanguageJavaDetectorContext,
} from "../../detector.js";
import type { PreFinding } from "../../finding.js";
import { scan } from "../../scan.js";
import {
  directDateJavaDetector,
  largeFunctionJavaDetector,
  swallowedErrorJavaDetector,
  weakTestSignalJavaDetector,
} from "./index.js";

async function run(
  detector: LanguageJavaDetector,
  file: string,
  source: string,
): Promise<PreFinding[]> {
  const absolutePath = `/repo/${file}`;
  const ctx: LanguageJavaDetectorContext = {
    kind: "language-java",
    file,
    absolutePath,
    source,
    parsed: await parseJavaFile({ absolutePath, source }),
    config: DEFAULT_CONFIG,
  };
  return detector.run(ctx);
}

const body = (n: number) =>
  Array.from({ length: n }, (_, i) => `    a${i}();`).join("\n");
const MAIN = "core/src/main/java/com/acme/Service.java";

describe("large_function.java", () => {
  it("flags a domain method past the configured budget", async () => {
    const findings = await run(
      largeFunctionJavaDetector,
      MAIN,
      `class Service {\n  void sync() {\n${body(70)}\n  }\n}\n`,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ type: "large_function", symbol: "sync" });
    expect(findings[0]!.evidence[0]).toContain('threshold 60 for shape "domain"');
  });

  it("gives constructors and tests their own budgets", async () => {
    const source = `class ServiceTest {\n  ServiceTest() {\n${body(70)}\n  }\n  @Test void big() {\n${body(120)}\n  }\n}\n`;
    expect(await run(largeFunctionJavaDetector, MAIN, source)).toEqual([]);
  });

  it("separates overloads that are both too long", async () => {
    const source = `class Service {\n  void save(int a) {\n${body(70)}\n  }\n  void save(int a, int b) {\n${body(70)}\n  }\n}\n`;
    const findings = await run(largeFunctionJavaDetector, MAIN, source);
    expect(findings.map((f) => f.discriminator)).toEqual(["Service(1)", "Service(2)"]);
  });
});

describe("swallowed_error.java", () => {
  const wrap = (handler: string) =>
    `class Service {\n  Film load() {\n    try { repository.save(film); } ${handler}\n    return film;\n  }\n}\n`;

  it("flags an empty catch, at medium when the catch is broad", async () => {
    const [broad] = await run(
      swallowedErrorJavaDetector,
      MAIN,
      wrap("catch (Exception e) { }"),
    );
    expect(broad).toMatchObject({ claim: "empty", symbol: "Service.load" });
    expect(broad!.severity).not.toBe("low");
    const [persistence] = await run(
      swallowedErrorJavaDetector,
      MAIN,
      wrap("catch (NumberFormatException e) { }"),
    );
    // A swallowed write is high whatever was caught.
    expect(persistence).toMatchObject({ claim: "empty", severity: "high" });
    const [specific] = await run(
      swallowedErrorJavaDetector,
      MAIN,
      "class S {\n  void f() {\n    try { n = Integer.parseInt(v); } catch (NumberFormatException e) { }\n  }\n}\n",
    );
    expect(specific).toMatchObject({ claim: "empty", severity: "low" });
  });

  it("flags logging without the exception", async () => {
    const [finding] = await run(
      swallowedErrorJavaDetector,
      MAIN,
      wrap('catch (IOException e) { LOG.warn("save failed"); }'),
    );
    expect(finding?.claim).toBe("log_without_error");
  });

  it("leaves handlers that record, rethrow, ignore by name, or recover a known case", async () => {
    for (const handler of [
      'catch (IOException e) { LOG.warn("save failed", e); }',
      "catch (IOException e) { throw new IllegalStateException(e); }",
      "catch (IOException ignored) { }",
      "catch (ObjectNotFoundException e) { return null; }",
      "catch (FormValidationException e) { /* errors already on the result */ }",
      "catch (Exception e) { // best effort, the cache refills\n }",
    ]) {
      expect(await run(swallowedErrorJavaDetector, MAIN, wrap(handler))).toEqual([]);
    }
  });

  it("reports a broad catch that returns a fallback", async () => {
    const [finding] = await run(
      swallowedErrorJavaDetector,
      MAIN,
      wrap("catch (Exception e) { return null; }"),
    );
    expect(finding?.claim).toBe("bland_fallback");
  });

  it("stays out of tests and cleanup", async () => {
    expect(
      await run(
        swallowedErrorJavaDetector,
        "core/src/test/java/com/acme/ServiceTest.java",
        wrap("catch (Exception e) { }"),
      ),
    ).toEqual([]);
    const cleanup = `class S {\n  void f() {\n    try { a(); } finally { try { c.close(); } catch (IOException e) { } }\n  }\n}\n`;
    expect(await run(swallowedErrorJavaDetector, MAIN, cleanup)).toEqual([]);
  });
});

describe("direct_date.java", () => {
  it("reports wall-clock reads in production code once per file", async () => {
    const findings = await run(
      directDateJavaDetector,
      MAIN,
      `class Service {\n  void touch() { updated = new Date(); seen = Instant.now(); }\n}\n`,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ type: "direct_date", severity: "medium" });
    expect(findings[0]!.evidence[0]).toBe("1× Instant.now(), 1× new Date()");
  });

  it("ignores tests, clock classes and injected clocks", async () => {
    const reads = "class X {\n  void f() { Date d = new Date(); }\n}\n";
    expect(
      await run(directDateJavaDetector, "core/src/test/java/XTest.java", reads),
    ).toEqual([]);
    expect(
      await run(directDateJavaDetector, "core/src/main/java/SystemClock.java", reads),
    ).toEqual([]);
    expect(
      await run(
        directDateJavaDetector,
        MAIN,
        "class X {\n  void f() { Instant.now(clock); }\n}\n",
      ),
    ).toEqual([]);
  });
});

describe("weak_test_signal.java", () => {
  const TEST = "core/src/test/java/com/acme/ServiceTest.java";

  it("reports tests that assert nothing", async () => {
    const [finding] = await run(
      weakTestSignalJavaDetector,
      TEST,
      `class ServiceTest {
  @Test void saves() { service.save(film); }
  @Test void loads() { assertEquals(film, service.load(1)); }
}
`,
    );
    expect(finding).toMatchObject({ claim: "file_asserts_nothing", symbol: "saves" });
    expect(finding!.evidence[0]).toBe("1 of 2 test methods contain no assertion");
  });

  it("credits expected exceptions, Mockito, helpers, and skips disabled tests", async () => {
    const findings = await run(
      weakTestSignalJavaDetector,
      TEST,
      `class ServiceTest {
  @Test(expected = IllegalStateException.class) void rejects() { service.save(null); }
  @Test void notifies() { service.save(film); verify(mailer).send(any()); }
  @Test void viaHelper() { checkSaved(service.save(film)); }
  @Disabled @Test void later() { service.save(film); }
  private void checkSaved(Film f) { assertNotNull(f.getId()); }
}
`,
    );
    expect(findings).toEqual([]);
  });

  it("leaves performance tests and benchmarks out", async () => {
    const findings = await run(
      weakTestSignalJavaDetector,
      "core/src/test/java/com/acme/FoldingPerformanceTest.java",
      "class FoldingPerformanceTest {\n  @Test void folds() { for (int i = 0; i < N; i++) fold(s); }\n}\n",
    );
    expect(findings).toEqual([]);
  });

  it("gives an unresolved call the benefit of the doubt in a subclass", async () => {
    const findings = await run(
      weakTestSignalJavaDetector,
      TEST,
      `class ServiceTest extends AbstractAppTest {
  @Test void saves() { assertSavedFilm(service.save(film)); }
  @Test void loads() { reloadAndCompare(film); }
}
`,
    );
    expect(findings).toEqual([]);
  });
});

describe("Java pack in a scan", () => {
  it("parses Java, links same-package classes, and finds the test", async () => {
    const root = await mkdtemp(join(tmpdir(), "crimes-java-scan-"));
    const files: Record<string, string> = {
      "core/src/main/java/com/acme/om/Film.java": `package com.acme.om;\npublic class Film {\n  void sync() {\n${body(70)}\n  }\n}\n`,
      "core/src/main/java/com/acme/om/Review.java":
        "package com.acme.om;\npublic class Review { Film film; }\n",
      "core/src/test/java/com/acme/om/FilmTest.java":
        "package com.acme.om;\nclass FilmTest { @Test void t() { assertNotNull(new Film()); } }\n",
    };
    for (const [path, source] of Object.entries(files)) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), source);
    }
    const report = await scan({ root });
    expect(report.coverage?.files_by_language.java).toBe(3);
    expect(
      report.coverage?.warnings?.some((w) => w.kind === "files_universal_only"),
    ).toBeFalsy();
    const finding = report.findings.find((f) => f.detector_id === "large_function.java");
    expect(finding?.file).toBe("core/src/main/java/com/acme/om/Film.java");
    // Review uses Film with no import; FilmTest constructs it.
    expect(finding?.scores.blast_radius_direct_importers).toBe(2);
    expect(finding?.scores.test_gap).toBe(0);
  });
});
