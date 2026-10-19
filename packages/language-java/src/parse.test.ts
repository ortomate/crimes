import { describe, expect, it } from "vitest";
import { parseJavaFile } from "./index.js";

const parse = (source: string) => parseJavaFile({ absolutePath: "/r/X.java", source });

describe("parseJavaFile — declarations", () => {
  it("reads the package, imports and declared types", async () => {
    const parsed = await parse(`package com.acme.om;

import java.util.List;
import static org.junit.Assert.*;
import com.acme.services.*;

@Entity
public class Film extends AbstractEntity<Film> implements Serializable {
  public enum Status { ACTIVE }
}
`);
    expect(parsed.packageName).toBe("com.acme.om");
    expect(parsed.imports).toEqual([
      { name: "java.util.List", static: false, wildcard: false, line: 3 },
      { name: "org.junit.Assert", static: true, wildcard: true, line: 4 },
      { name: "com.acme.services", static: false, wildcard: true, line: 5 },
    ]);
    expect(parsed.types.map((t) => [t.name, t.kind, t.enclosingType])).toEqual([
      ["Film", "class", undefined],
      ["Status", "enum", "Film"],
    ]);
    expect(parsed.types[0]!.annotations).toEqual(["Entity"]);
    expect(parsed.types[0]!.superclass).toBe("AbstractEntity<Film>");
  });

  it("collects referenced types, including static receivers, but not its own", async () => {
    const parsed = await parse(`package p;
class Review {
  private Film film;
  List<Viewing> viewings() { return Viewings.of(film, Status.ACTIVE, LOG); }
}
`);
    expect(parsed.referencedTypes).toEqual([
      "Film",
      "List",
      "Status",
      "Viewing",
      "Viewings",
    ]);
  });
});

describe("parseJavaFile — methods", () => {
  it("starts a method at its signature, not its annotations", async () => {
    const parsed = await parse(`class A {
  @Override
  @Transactional
  public void run() {
  }
}
`);
    expect(parsed.methods[0]).toMatchObject({
      name: "run",
      startLine: 4,
      endLine: 5,
      annotations: ["Override", "Transactional"],
      shape: "domain",
    });
  });

  it("classifies tests, constructors and JUnit 3 tests", async () => {
    const parsed = await parse(`class FilmTest extends TestCase {
  FilmTest() { super(); }
  @Test void readsTitle() { assertEquals(1, 1); }
  @org.junit.jupiter.api.Test void qualified() {}
  public void testLegacy() { assertTrue(true); }
  @Test(expected = IllegalStateException.class) void throwsOnNull() { build(); }
  @Disabled @Test void skipped() {}
}
`);
    const byName = Object.fromEntries(parsed.methods.map((m) => [m.name, m]));
    expect(byName.FilmTest!.shape).toBe("constructor");
    expect(byName.readsTitle!.shape).toBe("test_method");
    expect(byName.readsTitle!.assertionCount).toBe(1);
    expect(byName.qualified!.shape).toBe("test_method");
    expect(byName.testLegacy!.shape).toBe("test_method");
    expect(byName.throwsOnNull!.expectsException).toBe(true);
    expect(byName.throwsOnNull!.localCalls).toEqual(["build"]);
    expect(byName.skipped!.disabled).toBe(true);
  });

  it("does not deepen nesting for an else-if chain", async () => {
    const parsed = await parse(`class A {
  void f(int x) {
    if (x == 1) { a(); } else if (x == 2) { b(); } else if (x == 3) { c(); }
    for (int i = 0; i < x; i++) { try { if (i > 0) { d(); } } catch (Exception e) { throw e; } }
  }
}
`);
    expect(parsed.methods[0]!.maxNestingDepth).toBe(3);
  });

  it("gives an anonymous class's methods their own assertions", async () => {
    const parsed = await parse(`class T {
  @Test void outer() {
    run(new Runnable() { public void run() { assertTrue(true); } });
  }
}
`);
    const outer = parsed.methods.find((m) => m.name === "outer")!;
    const inner = parsed.methods.find((m) => m.name === "run")!;
    expect(outer.assertionCount).toBe(0);
    expect(inner.assertionCount).toBe(1);
  });
});

describe("parseJavaFile — catch clauses", () => {
  it("reports what each handler does with the failure", async () => {
    const parsed = await parse(`class S {
  Film load() {
    try { save(); } catch (IOException e) { }
    try { save(); } catch (IOException e) { // nothing to do
    }
    try { save(); } catch (IOException e) { log.warn("save failed"); }
    try { save(); } catch (IOException e) { log.warn("save failed", e); }
    try { return find(); } catch (NotFoundException | IllegalStateException e) { return null; }
    try { save(); } finally { try { close(); } catch (IOException ignored) { } }
  }
}
`);
    const c = parsed.catches;
    expect(c.map((x) => x.statementCount)).toEqual([0, 0, 1, 1, 1, 0]);
    expect(c[1]!.commentText).toContain("nothing to do");
    expect(c[2]!.logStatements).toBe(1);
    expect(c[2]!.usesParam).toBe(false);
    expect(c[3]!.usesParam).toBe(true);
    expect(c[4]!.caughtTypes).toEqual(["NotFoundException", "IllegalStateException"]);
    expect(c[4]!.returnsFallback).toBe(true);
    expect(c[5]!.inFinally).toBe(true);
    expect(c[5]!.param).toBe("ignored");
    expect(c[0]!.enclosingMethod).toBe("load");
    expect(c[0]!.protectedText).toContain("save()");
  });
});

describe("parseJavaFile — clock reads", () => {
  it("finds wall-clock reads but not injected clocks or elapsed timers", async () => {
    const parsed = await parse(`class C {
  void f(Clock clock) {
    long a = System.currentTimeMillis();
    Date b = new Date();
    Instant c = Instant.now();
    LocalDate d = LocalDate.now(ZoneId.of("UTC"));
    Instant e = Instant.now(clock);
    long f = System.nanoTime();
    Date g = new Date(a);
  }
}
`);
    expect(parsed.clockReads.map((r) => r.callee)).toEqual([
      "System.currentTimeMillis",
      "new Date",
      "Instant.now",
      "LocalDate.now",
    ]);
  });

  it("does not count a stopwatch as a clock read, but does count an age", async () => {
    const parsed = await parse(`class C {
  void f(Date modified) {
    final long start = System.currentTimeMillis();
    work();
    final long elapsed = System.currentTimeMillis() - start;
    final long age = System.currentTimeMillis() - modified.getTime();
  }
}
`);
    expect(parsed.clockReads.map((r) => r.line)).toEqual([6]);
  });
});

describe("parseJavaFile — what a clock reading is for", () => {
  it("tells readings that decide a branch from ones that are recorded", async () => {
    const parsed = await parse(`class C {
  void f(Date deadline, long last) {
    entity.setCreated(new Date());
    if (System.currentTimeMillis() - last > LIMIT) { refresh(); }
    boolean late = deadline.before(new Date());
    Date now = new Date();
    if (now.after(deadline)) { expire(); }
    return Instant.now().plusSeconds(60);
  }
}
`);
    expect(parsed.clockReads.map((r) => [r.line, r.usage])).toEqual([
      [3, "value"],
      [4, "compared"],
      [5, "compared"],
      [6, "compared"],
      [8, "value"],
    ]);
  });
});

describe("parseJavaFile — malformed input", () => {
  it("flags syntax it could not parse instead of throwing", async () => {
    const parsed = await parse("class A { void f( { }");
    expect(parsed.hasSyntaxErrors).toBe(true);
  });
});
