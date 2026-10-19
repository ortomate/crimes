import { describe, expect, it } from "vitest";
import { parseKotlinFile } from "./index.js";

const parse = (source: string) => parseKotlinFile({ absolutePath: "/r/X.kt", source });

describe("parseKotlinFile — declarations", () => {
  it("reads the package, imports, types and top-level declarations", async () => {
    const parsed = await parse(`package com.acme.om

import java.util.Date
import com.acme.util.*
import com.acme.net.Api as Remote

@Entity
class Film(val id: Long) : AbstractEntity(), Serializable {
  companion object { const val TAG = "film" }
}
// A one-line body ending in a nullable type (Film? }) trips the grammar.
interface Repo {
  fun find(): Film?
}
enum class Kind { A }
object Registry
typealias Ids = List<Long>
fun String.slug(): String = lowercase()
val DEFAULT_LIMIT = 20
`);
    expect(parsed.packageName).toBe("com.acme.om");
    expect(parsed.imports).toEqual([
      { name: "java.util.Date", static: false, wildcard: false, line: 3 },
      { name: "com.acme.util", static: false, wildcard: true, line: 4 },
      {
        name: "com.acme.net.Api",
        static: false,
        wildcard: false,
        alias: "Remote",
        line: 5,
      },
    ]);
    expect(parsed.types.map((t) => [t.name, t.kind])).toEqual([
      ["Film", "class"],
      ["Repo", "interface"],
      ["Kind", "enum"],
      ["Registry", "object"],
    ]);
    expect(parsed.types[0]!.superclass).toBe("AbstractEntity");
    expect(parsed.topLevelDeclarations).toEqual(["DEFAULT_LIMIT", "Ids", "slug"]);
  });

  it("collects referenced types, receivers and called functions, not its own", async () => {
    const parsed = await parse(`package p
class Review(private val film: Film) {
  fun viewings(): List<Viewing> = Viewings.of(film, Status.ACTIVE).map { it.slug() }
}
`);
    for (const name of ["Film", "List", "Viewing", "Viewings", "Status", "of", "slug"]) {
      expect(parsed.referencedNames).toContain(name);
    }
    expect(parsed.referencedNames).not.toContain("Review");
  });
});

describe("parseKotlinFile — functions", () => {
  it("classifies tests, constructors and init blocks; counts assertions", async () => {
    const parsed = await parse(`class FilmTest {
  init { setUp() }
  constructor(x: Int) : this()
  @Test fun readsTitle() { assertEquals(1, 1) }
  @Test fun kotest() { title shouldBe "x" }
  @Test(expected = IllegalStateException::class) fun rejects() { build() }
  @Ignore @Test fun later() {}
  @Test fun mockk() { verify { repo.save(any()) } }
}
`);
    const byName = Object.fromEntries(parsed.methods.map((m) => [m.name, m]));
    expect(byName.init!.shape).toBe("constructor");
    expect(byName.constructor!.shape).toBe("constructor");
    expect(byName.readsTitle).toMatchObject({ shape: "test_method", assertionCount: 1 });
    expect(byName.kotest!.assertionCount).toBe(1);
    expect(byName.rejects).toMatchObject({
      expectsException: true,
      localCalls: ["build"],
    });
    expect(byName.later!.disabled).toBe(true);
    expect(byName.mockk!.assertionCount).toBeGreaterThan(0);
  });

  it("gives a @Composable the UI component shape", async () => {
    const parsed = await parse(
      "@Composable\nfun FilmCard(film: Film) {\n  Text(film.title)\n}\n",
    );
    expect(parsed.methods[0]).toMatchObject({ shape: "ui_component", startLine: 2 });
  });

  it("starts at the signature and does not deepen nesting for else-if", async () => {
    const parsed = await parse(`class A {
  @Transactional
  fun f(x: Int) {
    if (x == 1) { a() } else if (x == 2) { b() } else { c() }
    for (i in 0..x) { when (i) { 1 -> try { d() } catch (e: Exception) { throw e } } }
  }
}
`);
    expect(parsed.methods[0]).toMatchObject({ startLine: 3, maxNestingDepth: 3 });
  });
});

describe("parseKotlinFile — assertions the grammar misreads", () => {
  it("credits generic assertions and screenshot captures", async () => {
    const parsed = await parse(`class T {
  @Test fun generic() = runTest { assertIs<Success>(result) }
  @Test fun screenshot() { composeTestRule.captureMultiTheme("Button") { NiaButton() } }
  @Test fun robo() { onRoot().captureRoboImage("x.png") }
  @Test fun captor() { val c = slot.capture() }
}
`);
    const byName = Object.fromEntries(
      parsed.methods.map((m) => [m.name, m.assertionCount]),
    );
    expect(byName.generic).toBeGreaterThan(0);
    expect(byName.screenshot).toBeGreaterThan(0);
    expect(byName.robo).toBeGreaterThan(0);
    expect(byName.captor).toBe(0);
  });
});

describe("parseKotlinFile — catch blocks", () => {
  it("reports what each handler does with the failure", async () => {
    const parsed = await parse(`class S {
  fun load(): Film? {
    try { save() } catch (e: IOException) { }
    try { save() } catch (e: IOException) { Log.w(TAG, "save failed") }
    try { save() } catch (e: IOException) { Timber.e(e, "save failed") }
    val f = try { find() } catch (e: Exception) { null }
    try { save() } finally { try { close() } catch (ignored: IOException) { } }
    return f
  }
}
`);
    const c = parsed.catches;
    expect(c.map((x) => x.statementCount)).toEqual([0, 1, 1, 1, 0]);
    expect(c[1]).toMatchObject({ logStatements: 1, usesParam: false });
    expect(c[2]!.usesParam).toBe(true);
    expect(c[3]).toMatchObject({ caughtTypes: ["Exception"], returnsFallback: true });
    expect(c[4]).toMatchObject({ inFinally: true, param: "ignored" });
    expect(c[0]).toMatchObject({ enclosingMethod: "load", enclosingType: "S" });
  });
});

describe("parseKotlinFile — what a clock reading is for", () => {
  it("tells readings that decide a branch from ones that are recorded", async () => {
    const parsed = await parse(`class C {
  fun f(deadline: Instant, last: Long) {
    entity.created = Date()
    if (System.currentTimeMillis() - last > LIMIT) refresh()
    val late = deadline.isBefore(Instant.now())
  }
}
`);
    expect(parsed.clockReads.map((r) => r.usage)).toEqual([
      "value",
      "compared",
      "compared",
    ]);
  });
});

describe("parseKotlinFile — clock reads", () => {
  it("finds wall-clock reads, not injected clocks or stopwatches", async () => {
    const parsed = await parse(`class C(private val clock: java.time.Clock) {
  fun f(modified: Date) {
    val a = System.currentTimeMillis()
    val d = Date()
    val i = Instant.now()
    val k = Clock.System.now()
    val injected = Instant.now(clock)
    val start = System.currentTimeMillis()
    val elapsed = System.currentTimeMillis() - start
  }
}
`);
    expect(parsed.clockReads.map((r) => r.callee)).toEqual([
      "System.currentTimeMillis",
      "Date",
      "Instant.now",
      "Clock.System.now",
    ]);
  });
});
