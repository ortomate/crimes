import { describe, expect, it } from "vitest";
import { parseSwiftFile } from "./index.js";

const parse = (source: string) => parseSwiftFile({ absolutePath: "/r/X.swift", source });

describe("parseSwiftFile — declarations", () => {
  it("reads imports, declarations, and treats an extension as a reference", async () => {
    const parsed = await parse(`import UIKit

@MainActor
final class FilmViewController: UIViewController, Delegate {
  var film: Film?
}
struct Point { let x: Int }
enum Kind { case a }
protocol Delegate {}
typealias Ids = [Int]
extension Review { func slug() -> String { "" } }
`);
    expect(parsed.imports).toEqual([{ module: "UIKit", line: 1 }]);
    expect(parsed.types.map((t) => [t.name, t.kind])).toEqual([
      ["FilmViewController", "class"],
      ["Point", "struct"],
      ["Kind", "enum"],
      ["Delegate", "protocol"],
      ["Review", "extension"],
    ]);
    expect(parsed.types[0]).toMatchObject({
      attributes: ["MainActor"],
      superclass: "UIViewController",
    });
    expect(parsed.declaredTypes).toEqual([
      "Delegate",
      "FilmViewController",
      "Ids",
      "Kind",
      "Point",
    ]);
    expect(parsed.referencedTypes).toContain("Film");
    expect(parsed.referencedTypes).toContain("Review");
    expect(parsed.referencedTypes).not.toContain("Point");
  });
});

describe("parseSwiftFile — functions", () => {
  it("classifies XCTest, Swift Testing, initialisers and SwiftUI views", async () => {
    const parsed = await parse(`class FilmTests: XCTestCase {
  func testLoads() { XCTAssertEqual(1, 1) }
  func helper() { }
}
@Test func swiftTesting() { #expect(1 == 1) }
struct FilmCard: View {
  init(film: Film) { self.film = film }
  var body: some View { Text("x") }
}
`);
    const byName = Object.fromEntries(parsed.methods.map((m) => [m.name, m]));
    expect(byName.testLoads).toMatchObject({ shape: "test_method", assertionCount: 1 });
    expect(byName.helper!.shape).toBe("domain");
    expect(byName.swiftTesting).toMatchObject({
      shape: "test_method",
      assertionCount: 1,
    });
    expect(byName.init!.shape).toBe("constructor");
    expect(byName.body!.shape).toBe("ui_component");
  });

  it("does not deepen nesting for else-if", async () => {
    const parsed = await parse(`func f(x: Int) {
  if x == 1 { a() } else if x == 2 { b() } else { c() }
  for i in 0..<x { if i > 0 { switch i { default: break } } }
}
`);
    expect(parsed.methods[0]!.maxNestingDepth).toBe(3);
  });
});

describe("parseSwiftFile — catch blocks", () => {
  it("tells catch-alls from typed catches, and sees interpolated errors", async () => {
    const parsed = await parse(`final class S {
  func load() -> Film? {
    do { try save() } catch { }
    do { try save() } catch let e as NetworkError { print("failed") }
    do { try save() } catch NetworkError.timeout { return nil }
    do { try save() } catch { logger.error("failed: \\(error)") }
    do { try save() } catch { throw AppError.wrapped(error) }
    return nil
  }
}
`);
    const c = parsed.catches;
    expect(c[0]).toMatchObject({ caughtTypes: [], param: "error", statementCount: 0 });
    expect(c[1]).toMatchObject({
      caughtTypes: ["NetworkError"],
      param: "e",
      logStatements: 1,
    });
    expect(c[2]).toMatchObject({
      caughtTypes: ["NetworkError.timeout"],
      returnsFallback: true,
    });
    expect(c[3]!.usesParam).toBe(true);
    expect(c[4]!.rethrows).toBe(true);
    expect(c[0]).toMatchObject({ enclosingMethod: "load", enclosingType: "S" });
  });
});

describe("parseSwiftFile — what a clock reading is for", () => {
  it("tells readings that decide a branch from ones that are recorded", async () => {
    const parsed = await parse(`func f(expiry: Date) {
  entry.created = Date()
  if Date() > expiry { refresh() }
  guard Date().timeIntervalSince(expiry) < 60 else { return }
}
`);
    expect(parsed.clockReads.map((r) => r.usage)).toEqual([
      "value",
      "compared",
      "compared",
    ]);
  });
});

describe("parseSwiftFile — clock reads", () => {
  it("finds Date() and Date.now, not injected defaults or stopwatches", async () => {
    const parsed = await parse(`func f(now: Date = Date()) {
  let a = Date()
  let b = Date.now
  let start = Date()
  let c = Date(timeIntervalSince1970: 0)
}
`);
    expect(parsed.clockReads.map((r) => [r.callee, r.line])).toEqual([
      ["Date", 2],
      ["Date.now", 3],
    ]);
  });
});
