import { parseSwiftFile } from "@crimes/language-swift";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../config.js";
import type {
  LanguageSwiftDetector,
  LanguageSwiftDetectorContext,
} from "../../detector.js";
import type { PreFinding } from "../../finding.js";
import { scan } from "../../scan.js";
import {
  directDateSwiftDetector,
  largeFunctionSwiftDetector,
  swallowedErrorSwiftDetector,
  weakTestSignalSwiftDetector,
} from "./index.js";

async function run(
  detector: LanguageSwiftDetector,
  file: string,
  source: string,
): Promise<PreFinding[]> {
  const absolutePath = `/repo/${file}`;
  const ctx: LanguageSwiftDetectorContext = {
    kind: "language-swift",
    file,
    absolutePath,
    source,
    parsed: await parseSwiftFile({ absolutePath, source }),
    config: DEFAULT_CONFIG,
  };
  return detector.run(ctx);
}

const body = (n: number) => Array.from({ length: n }, (_, i) => `    a${i}()`).join("\n");
const MAIN = "App/FilmService.swift";

describe("large_function.swift", () => {
  it("flags a long function, and gives a SwiftUI body the component budget", async () => {
    const [finding] = await run(
      largeFunctionSwiftDetector,
      MAIN,
      `final class FilmService {\n  func sync() {\n${body(70)}\n  }\n}\n`,
    );
    expect(finding?.evidence[0]).toContain('shape "domain"');
    expect(
      await run(
        largeFunctionSwiftDetector,
        MAIN,
        `struct FilmCard: View {\n  var body: some View {\n${body(150)}\n  }\n}\n`,
      ),
    ).toEqual([]);
  });
});

describe("swallowed_error.swift", () => {
  const wrap = (handler: string) =>
    `final class S {\n  func load() -> Film? {\n    do { try parse(v) } ${handler}\n    return nil\n  }\n}\n`;

  it("flags an empty catch-all, and a print that drops the error", async () => {
    const [empty] = await run(swallowedErrorSwiftDetector, MAIN, wrap("catch { }"));
    expect(empty).toMatchObject({ claim: "empty", severity: "medium" });
    expect(empty!.evidence[0]).toContain("catches: everything as `error`");
    const [printed] = await run(
      swallowedErrorSwiftDetector,
      MAIN,
      wrap('catch let e as DecodingError { print("decode failed") }'),
    );
    expect(printed?.claim).toBe("log_without_error");
  });

  it("flags a catch-all that returns nil, but not a matched case", async () => {
    const [fallback] = await run(
      swallowedErrorSwiftDetector,
      MAIN,
      wrap("catch { return nil }"),
    );
    expect(fallback?.claim).toBe("bland_fallback");
    expect(
      await run(
        swallowedErrorSwiftDetector,
        MAIN,
        wrap("catch NetworkError.offline { return nil }"),
      ),
    ).toEqual([]);
  });

  it("leaves ignored cancellation alone, and does not read argument labels as boundaries", async () => {
    expect(
      await run(
        swallowedErrorSwiftDetector,
        MAIN,
        wrap("catch is CancellationError { }"),
      ),
    ).toEqual([]);
    const sleep =
      "func f() async {\n  do { try await Task.sleep(for: window) } catch {\n    // cancelled\n  }\n}\n";
    expect(await run(swallowedErrorSwiftDetector, MAIN, sleep)).toEqual([]);
    const image =
      "func f() async {\n  do { try await imageView.setImage(with: url, transition: 0.2); updateShadow() } catch {}\n}\n";
    const [finding] = await run(swallowedErrorSwiftDetector, MAIN, image);
    expect(finding?.evidence.some((e) => e.startsWith("boundary:"))).toBe(false);
    expect(finding?.severity).toBe("medium");
  });

  it("leaves handlers that interpolate or rethrow the error", async () => {
    for (const handler of [
      'catch { logger.error("failed: \\(error)") }',
      "catch { throw AppError.wrapped(error) }",
    ]) {
      expect(await run(swallowedErrorSwiftDetector, MAIN, wrap(handler))).toEqual([]);
    }
  });
});

describe("direct_date.swift", () => {
  it("reports Date() and Date.now, not an injectable default", async () => {
    const [finding] = await run(
      directDateSwiftDetector,
      MAIN,
      "func touch(at now: Date = Date()) { let a = Date(); let b = Date.now }\n",
    );
    expect(finding!.evidence[0]).toBe("1× Date(), 1× Date.now");
  });
});

describe("weak_test_signal.swift", () => {
  it("reports XCTest methods that assert nothing", async () => {
    const [finding] = await run(
      weakTestSignalSwiftDetector,
      "AppTests/FilmServiceTests.swift",
      `final class FilmServiceTests: XCTestCase {
  func testSaves() { service.save(film) }
  func testLoads() { XCTAssertEqual(service.load(1), film) }
}
`,
    );
    expect(finding).toMatchObject({ claim: "file_asserts_nothing", symbol: "testSaves" });
  });
});

describe("Swift in a scan", () => {
  it("links files through referenced types and extensions, and skips generated code", async () => {
    const root = await mkdtemp(join(tmpdir(), "crimes-swift-scan-"));
    const files: Record<string, string> = {
      ".gitattributes": "API/src/** linguist-generated=true\n",
      "App/Film.swift": `struct Film {\n  func sync() {\n${body(70)}\n  }\n}\n`,
      "App/Film+Slug.swift": 'extension Film { var slug: String { "" } }\n',
      "App/FilmCell.swift": "final class FilmCell { var film: Film? }\n",
      "API/src/Models/Film.swift": `struct ApiFilm {\n  func huge() {\n${body(90)}\n  }\n}\n`,
    };
    for (const [path, source] of Object.entries(files)) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), source);
    }
    const report = await scan({ root });
    const finding = report.findings.find((f) => f.file === "App/Film.swift");
    expect(finding?.scores.blast_radius_direct_importers).toBe(2);
    expect(report.findings.some((f) => f.file.startsWith("API/"))).toBe(false);
  });
});
