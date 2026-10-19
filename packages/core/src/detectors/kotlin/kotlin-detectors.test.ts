import { parseKotlinFile } from "@crimes/language-kotlin";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../config.js";
import type {
  LanguageKotlinDetector,
  LanguageKotlinDetectorContext,
} from "../../detector.js";
import type { PreFinding } from "../../finding.js";
import { discoverFiles } from "../../discovery/files.js";
import { buildImportGraph } from "../../imports/build.js";
import { scan } from "../../scan.js";
import {
  directDateKotlinDetector,
  largeFunctionKotlinDetector,
  swallowedErrorKotlinDetector,
  weakTestSignalKotlinDetector,
} from "./index.js";

async function run(
  detector: LanguageKotlinDetector,
  file: string,
  source: string,
): Promise<PreFinding[]> {
  const absolutePath = `/repo/${file}`;
  const ctx: LanguageKotlinDetectorContext = {
    kind: "language-kotlin",
    file,
    absolutePath,
    source,
    parsed: await parseKotlinFile({ absolutePath, source }),
    config: DEFAULT_CONFIG,
  };
  return detector.run(ctx);
}

const body = (n: number) => Array.from({ length: n }, (_, i) => `    a${i}()`).join("\n");
const MAIN = "app/src/main/java/com/acme/Service.kt";

describe("large_function.kt", () => {
  it("flags a long function, and gives a @Composable the component budget", async () => {
    const domain = await run(
      largeFunctionKotlinDetector,
      MAIN,
      `class Service {\n  fun sync() {\n${body(70)}\n  }\n}\n`,
    );
    expect(domain).toHaveLength(1);
    expect(domain[0]!.evidence[0]).toContain('shape "domain"');
    const composable = await run(
      largeFunctionKotlinDetector,
      MAIN,
      `@Composable\nfun FilmScreen() {\n${body(150)}\n}\n`,
    );
    expect(composable).toEqual([]);
  });
});

describe("swallowed_error.kt", () => {
  const wrap = (handler: string) =>
    `class Service {\n  fun load(): Film? {\n    try { parse(v) } ${handler}\n    return null\n  }\n}\n`;

  it("flags an empty catch and an Android log without the throwable", async () => {
    const [empty] = await run(
      swallowedErrorKotlinDetector,
      MAIN,
      wrap("catch (e: Exception) { }"),
    );
    expect(empty).toMatchObject({ claim: "empty", severity: "medium" });
    const [logged] = await run(
      swallowedErrorKotlinDetector,
      MAIN,
      wrap('catch (e: IOException) { Log.w(TAG, "parse failed") }'),
    );
    expect(logged?.claim).toBe("log_without_error");
  });

  it("flags try-as-expression that turns any exception into null", async () => {
    const [finding] = await run(
      swallowedErrorKotlinDetector,
      MAIN,
      "class S {\n  fun f() = try { parse(v) } catch (e: Exception) { null }\n}\n",
    );
    expect(finding?.claim).toBe("bland_fallback");
  });

  it("leaves handlers that log the throwable or recover a specific case", async () => {
    for (const handler of [
      'catch (e: IOException) { Timber.e(e, "parse failed") }',
      "catch (e: NumberFormatException) { return null }",
      "catch (ignored: IOException) { }",
    ]) {
      expect(await run(swallowedErrorKotlinDetector, MAIN, wrap(handler))).toEqual([]);
    }
  });
});

describe("direct_date.kt", () => {
  it("reports wall-clock reads, including kotlinx Clock.System", async () => {
    const [finding] = await run(
      directDateKotlinDetector,
      MAIN,
      "class Service {\n  fun touch() { val a = Clock.System.now(); val b = Date() }\n}\n",
    );
    expect(finding!.evidence[0]).toBe("1× Clock.System.now(), 1× Date()");
  });
});

describe("weak_test_signal.kt", () => {
  it("reports tests that assert nothing; credits Kotest and MockK", async () => {
    const [finding] = await run(
      weakTestSignalKotlinDetector,
      "app/src/test/java/com/acme/ServiceTest.kt",
      `class ServiceTest {
  @Test fun saves() { service.save(film) }
  @Test fun title() { film.title shouldBe "x" }
  @Test fun notifies() { service.save(film); verify { mailer.send(any()) } }
}
`,
    );
    expect(finding).toMatchObject({ claim: "file_asserts_nothing", symbol: "saves" });
    expect(finding!.evidence[0]).toBe("1 of 3 test functions contain no assertion");
  });
});

describe("Kotlin and Java in one scan", () => {
  it("links a Kotlin file to a same-package Java class it uses without an import", async () => {
    const root = await mkdtemp(join(tmpdir(), "crimes-kotlin-scan-"));
    const files: Record<string, string> = {
      "app/src/main/java/com/acme/om/Film.java": `package com.acme.om;\npublic class Film {\n  void sync() {\n${body(70).replace(/\(\)/g, "();")}\n  }\n}\n`,
      "app/src/main/java/com/acme/om/Review.kt":
        "package com.acme.om\nclass Review(val film: Film)\n",
      "app/src/main/java/com/acme/util/Slug.kt":
        "package com.acme.util\nfun String.slug() = lowercase()\n",
      "app/src/main/java/com/acme/om/Title.kt":
        "package com.acme.om\nimport com.acme.util.slug\nclass Title(val t: String) { fun s() = t.slug() }\n",
    };
    for (const [path, source] of Object.entries(files)) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), source);
    }
    const report = await scan({ root });
    expect(report.coverage?.files_by_language).toMatchObject({ java: 1, kotlin: 3 });
    const film = report.findings.find((f) => f.detector_id === "large_function.java");
    expect(film?.scores.blast_radius_direct_importers).toBe(1);

    // An imported top-level extension function lands on the file declaring it.
    const graph = await buildImportGraph({
      root,
      files: await discoverFiles({
        root,
        include: DEFAULT_CONFIG.include,
        exclude: DEFAULT_CONFIG.exclude,
      }),
    });
    expect(
      graph.out.get("app/src/main/java/com/acme/om/Title.kt")?.map((e) => e.to),
    ).toContain("app/src/main/java/com/acme/util/Slug.kt");
  });
});
