import { describe, expect, it } from "vitest";
import { parseFile } from "@crimes/language-js";
import { swallowedErrorDetector } from "./swallowed-error.js";
import { DEFAULT_CONFIG, type CrimesConfig } from "../config.js";
import type { LanguageJsDetectorContext } from "../detector.js";
import type { PreFinding } from "../finding.js";
import { configWithOptions } from "../risk/test-harness.js";

/**
 * `swallowed_error` is file-local: it reads `ctx.parsed` and nothing
 * else, so a synthetic context is faithful rather than a shortcut.
 */
function run(
  source: string,
  file = "src/services/billing.ts",
  config: CrimesConfig = DEFAULT_CONFIG,
): PreFinding[] {
  const absolutePath = `/repo/${file}`;
  const ctx: LanguageJsDetectorContext = {
    kind: "language-js",
    file,
    absolutePath,
    source,
    parsed: parseFile({ absolutePath, source }),
    config,
  };
  return swallowedErrorDetector.run(ctx) as PreFinding[];
}

describe("swallowed_error — positive cases", () => {
  it("reports an empty catch around a database write", () => {
    const findings = run(`
      export async function persist(order) {
        try {
          await db.orders.insert(order);
        } catch (e) {}
      }
    `);
    expect(findings).toHaveLength(1);
    const finding = findings[0]!;
    expect(finding.type).toBe("swallowed_error");
    expect(finding.charge).toBe("Catch and Release");
    expect(finding.severity).toBe("medium");

    const evidence = finding.evidence.join("\n");
    expect(evidence).toContain("protected operation: await db.orders.insert(order);");
    expect(evidence).toContain("calls inside the protected region: db.orders.insert");
    expect(evidence).toContain("what happens to the failure: the handler body is empty");
    expect(evidence).toContain("boundary: database write");
    expect(evidence).toMatch(/missing signal: no rethrow.*no logging.*never inspected/s);
  });

  it("escalates a swallowed payment to high severity", () => {
    const [finding] = run(`
      export async function charge(order) {
        try {
          await stripe.charges.create({ amount: order.total });
        } catch (e) {}
      }
    `);
    expect(finding!.severity).toBe("high");
    expect(finding!.evidence.join("\n")).toMatch(
      /severity raised by:.*payment operation/,
    );
  });

  it("reports a comment-only catch and quotes the comment", () => {
    const [finding] = run(`
      export function f() {
        try { riskyWrite(); } catch (e) {
          // TODO handle this later
        }
      }
    `);
    expect(finding!.evidence.join("\n")).toContain(
      "the handler contains only a comment (TODO handle this later)",
    );
  });

  it("reports a discarded promise rejection", () => {
    const [finding] = run(`
      export function notify(order) {
        queue.publish(order).catch(() => {});
      }
    `);
    expect(finding!.evidence.join("\n")).toContain(
      "handler kind: discarded promise rejection",
    );
    expect(finding!.evidence.join("\n")).toContain("boundary: queue publish");
  });

  it("reports a bland fallback and suggests a typed result", () => {
    const [finding] = run(`
      export async function load(id) {
        try { return await api.post("/load", id); } catch (e) { return null; }
      }
    `);
    const evidence = finding!.evidence.join("\n");
    expect(evidence).toContain("the handler returns `null` without inspecting the error");
    const actions = finding!.suggested_actions ?? [];
    expect(actions.some((a) => a.kind === "return_typed_result")).toBe(true);
  });

  it("reports a log call that never receives the error", () => {
    const [finding] = run(`
      export async function persist(order) {
        try { await db.orders.insert(order); }
        catch (e) { logger.error("could not save order"); }
      }
    `);
    const evidence = finding!.evidence.join("\n");
    expect(evidence).toContain("the handler logs a message but never passes the error");
    expect(evidence).toContain(
      "a log call is present but the error value is not passed to it",
    );
    expect((finding!.suggested_actions ?? [])[0]!.kind).toBe("pass_error_to_logger");
  });

  it("notes when the catch declares no binding at all", () => {
    const [finding] = run(`
      export async function persist(o) { try { await db.orders.insert(o); } catch {} }
    `);
    expect(finding!.evidence.join("\n")).toContain("the catch declares no binding");
  });
});

describe("swallowed_error — complete defences", () => {
  it("says nothing when the handler rethrows", () => {
    expect(run(`function f() { try { go(); } catch (e) { throw e; } }`)).toHaveLength(0);
  });

  it("says nothing when the handler logs with the error", () => {
    expect(
      run(`function f() { try { go(); } catch (e) { logger.error("failed", e); } }`),
    ).toHaveLength(0);
  });

  it("says nothing when the handler returns a typed result", () => {
    expect(
      run(`
        function f() {
          try { return { ok: true, value: go() }; }
          catch (e) { return { ok: false, error: e }; }
        }
      `),
    ).toHaveLength(0);
  });

  it("says nothing when the handler inspects the error before recovering", () => {
    expect(
      run(`
        function f() {
          try { return read(); }
          catch (e) { if (e.code === "ENOENT") return undefined; throw e; }
        }
      `),
    ).toHaveLength(0);
  });

  it("says nothing when the handler returns a rejected promise", () => {
    expect(
      run(`function f() { try { go(); } catch (e) { return Promise.reject(e); } }`),
    ).toHaveLength(0);
  });
});

describe("swallowed_error — down-ranked cases", () => {
  it("damps a handler whose comment marks it best-effort", () => {
    const plain = run(`
      export async function ping() { try { await api.post("/x"); } catch (e) {} }
    `);
    const documented = run(`
      export async function ping() {
        try { await api.post("/x"); } catch (e) {
          // best-effort telemetry; failure here is not fatal
        }
      }
    `);
    expect(documented[0]!.confidence).toBeLessThan(plain[0]!.confidence);
    expect(documented[0]!.evidence.join("\n")).toContain("this appears deliberate");
  });

  it("damps a cleanup path", () => {
    const [finding] = run(`
      export async function shutdown() { try { await server.close(); } catch (e) {} }
    `);
    expect(finding!.severity).toBe("low");
    expect(finding!.evidence.join("\n")).toContain("this appears deliberate");
  });

  it("damps a function whose name announces best-effort behaviour", () => {
    const [finding] = run(`
      export async function safelyBuildIndex(files) {
        try { return await build(files); } catch (e) { return undefined; }
      }
    `);
    expect(finding!.evidence.join("\n")).toContain("`safelyBuildIndex`");
    expect(finding!.severity).toBe("low");
  });

  it("treats a named no-op as a deliberate choice", () => {
    const [finding] = run(`export function f() { cleanupTemp().catch(noop); }`);
    expect(finding!.evidence.join("\n")).toContain("the handler is a named no-op");
  });
});

describe("swallowed_error — exclusions", () => {
  it("never fires in test files", () => {
    expect(
      run(`it("x", () => { try { go(); } catch (e) {} });`, "src/a.test.ts"),
    ).toHaveLength(0);
  });

  it("never fires in generated or vendored code", () => {
    const source = `function f() { try { go(); } catch (e) {} }`;
    expect(run(source, "src/__generated__/a.ts")).toHaveLength(0);
    expect(run(source, "vendor/a.ts")).toHaveLength(0);
  });
});

describe("swallowed_error — configuration", () => {
  const LOG_ONLY = `
    export async function persist(o) {
      try { await db.orders.insert(o); } catch (e) { logger.error("nope"); }
    }
  `;
  const FALLBACK = `
    export async function load(id) {
      try { return await db.orders.find(id); } catch (e) { return null; }
    }
  `;

  it("honours reportLogWithoutError", () => {
    expect(run(LOG_ONLY)).toHaveLength(1);
    expect(
      run(
        LOG_ONLY,
        "src/a.ts",
        configWithOptions("swallowed_error", {
          reportLogWithoutError: false,
        }),
      ),
    ).toHaveLength(0);
  });

  it("honours reportFallbackReturns", () => {
    expect(run(FALLBACK)).toHaveLength(1);
    expect(
      run(
        FALLBACK,
        "src/a.ts",
        configWithOptions("swallowed_error", {
          reportFallbackReturns: false,
        }),
      ),
    ).toHaveLength(0);
  });

  it("honours treatCommentAsIntent", () => {
    const source = `function f() { try { go(); } catch (e) { /* known flaky */ } }`;
    expect(run(source)).toHaveLength(1);
    expect(
      run(
        source,
        "src/a.ts",
        configWithOptions("swallowed_error", {
          treatCommentAsIntent: true,
        }),
      ),
    ).toHaveLength(0);
  });

  it("honours allowedFunctions", () => {
    const source = `export function drain() { try { go(); } catch (e) {} }`;
    expect(run(source)).toHaveLength(1);
    expect(
      run(
        source,
        "src/a.ts",
        configWithOptions("swallowed_error", {
          allowedFunctions: ["drain"],
        }),
      ),
    ).toHaveLength(0);
  });

  it("validates its options schema", () => {
    const schema = swallowedErrorDetector.optionsSchema!;
    expect(schema.safeParse({ reportLogWithoutError: false }).success).toBe(true);
    expect(schema.safeParse({ reportLogWithoutError: "no" }).success).toBe(false);
    expect(schema.safeParse({ typo: true }).success).toBe(false);
  });
});

describe("swallowed_error — stability", () => {
  it("gives two handlers in one function distinct symbols", () => {
    const findings = run(`
      export async function sync(order) {
        try { await db.orders.insert(order); } catch (e) {}
        try { await queue.publish(order); } catch (e) {}
      }
    `);
    expect(findings).toHaveLength(2);
    const symbols = findings.map((f) => f.symbol);
    expect(new Set(symbols).size).toBe(2);
    expect(symbols).toEqual(["sync → insert", "sync → publish"]);
  });

  it("orders findings by line", () => {
    const findings = run(`
      export async function a(o) { try { await db.orders.insert(o); } catch (e) {} }
      export async function b(o) { try { await queue.publish(o); } catch (e) {} }
    `);
    expect(findings.map((f) => f.lines?.[0])).toEqual(
      [...findings.map((f) => f.lines?.[0] ?? 0)].sort((x, y) => x - y),
    );
  });

  it("is deterministic across runs", () => {
    const source = `
      export async function persist(o) {
        try { await db.orders.insert(o); } catch (e) {}
      }
    `;
    expect(JSON.stringify(run(source))).toBe(JSON.stringify(run(source)));
  });

  it("separates two handlers whose symbol is identical", () => {
    // Same enclosing function, same protected callee, so
    // `<enclosing> → <call>` cannot tell them apart. What differs is the
    // operation each one guards.
    const findings = run(`
      export async function persist(order) {
        try { await db.orders.insert(order); } catch (e) {}
        try { await db.orders.insert(order.child); } catch (e) {}
      }
    `);
    expect(findings).toHaveLength(2);
    expect(new Set(findings.map((f) => f.symbol)).size).toBe(1);
    expect(new Set(findings.map((f) => f.discriminator)).size).toBe(2);
  });

  it("falls back to the start line for two identical protected operations", () => {
    const findings = run(`
      export async function persist(order) {
        try { await db.orders.insert(order); } catch (e) {}
        try { await db.orders.insert(order); } catch (e) {}
      }
    `);
    expect(findings).toHaveLength(2);
    expect(new Set(findings.map((f) => f.discriminator)).size).toBe(2);
    for (const finding of findings) {
      expect(finding.discriminator).toMatch(/@L\d+$/);
    }
  });

  it("leaves an unambiguous handler with no discriminator", () => {
    const findings = run(`
      export async function persist(order) {
        try { await db.orders.insert(order); } catch (e) {}
      }
    `);
    expect(findings[0]!.discriminator).toBeUndefined();
  });
});
