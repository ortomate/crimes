import { describe, expect, it } from "vitest";
import { parseFile } from "@crimes/language-js";
import { unboundedAsyncFanoutDetector } from "./unbounded-async-fanout.js";
import { DEFAULT_CONFIG, type CrimesConfig } from "../config.js";
import type { LanguageJsDetectorContext } from "../detector.js";
import type { PreFinding } from "../finding.js";
import { configWithOptions } from "../risk/test-harness.js";

function run(
  source: string,
  file = "src/jobs/notify.ts",
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
  return unboundedAsyncFanoutDetector.run(ctx) as PreFinding[];
}

const UNBOUNDED = `
export async function notifyEveryone() {
  const orders = await db.orders.findMany();
  return Promise.all(orders.map((order) => api.post("/notify", order)));
}
`;

describe("unbounded_async_fanout — positive cases", () => {
  it("reports a fan-out over an unbounded query result", () => {
    const findings = run(UNBOUNDED);
    expect(findings).toHaveLength(1);
    const finding = findings[0]!;
    expect(finding.type).toBe("unbounded_async_fanout");
    expect(finding.charge).toBe("Concurrency Stampede");
    expect(finding.symbol).toBe("notifyEveryone → post");
  });

  it("names the collection source, the per-element work, and the absent bound", () => {
    const evidence = run(UNBOUNDED)[0]!.evidence.join("\n");
    expect(evidence).toContain("fan-out: Promise.all at line 4");
    expect(evidence).toContain("collection: orders (←");
    expect(evidence).toContain(
      "collection source: an awaited call (query, request, or listing)",
    );
    expect(evidence).toContain("produced by: db.orders.findMany");
    expect(evidence).toContain("network request — api.post at line 4");
    expect(evidence).toContain("no bound visible:");
    expect(evidence).toMatch(
      /if the collection holds N elements, N concurrent network request start at once/,
    );
  });

  it("resolves a collection bound one statement earlier", () => {
    // The canonical real-world shape. Without local-binding resolution
    // the collection would read as an opaque parameter.
    const evidence = run(UNBOUNDED)[0]!.evidence.join("\n");
    expect(evidence).toContain("db.orders.findMany");
  });

  it("escalates severity by the kind of per-element work", () => {
    const network = run(UNBOUNDED)[0]!;
    const subprocess = run(`
      export async function build(targets) {
        const list = await fs.readdir(targets);
        return Promise.all(list.map((t) => execa("tsc", [t])));
      }
    `)[0]!;
    expect(subprocess.scores.severity).toBeGreaterThan(network.scores.severity);
    expect(subprocess.evidence.join("\n")).toMatch(
      /severity raised by:.*per-element subprocess execution/,
    );
  });

  it("classifies database and queue work separately", () => {
    const evidence = run(`
      export async function sync(ids) {
        const rows = await db.orders.findMany();
        return Promise.all(rows.map(async (r) => {
          const full = await db.orders.findUnique(r.id);
          await queue.publish(full);
        }));
      }
    `)[0]!.evidence.join("\n");
    expect(evidence).toContain("database operation — db.orders.findUnique");
    expect(evidence).toContain("queue operation — queue.publish");
  });

  it("handles Promise.allSettled identically", () => {
    const [finding] = run(UNBOUNDED.replace("Promise.all", "Promise.allSettled"));
    expect(finding!.summary).toContain("Promise.allSettled");
  });
});

describe("unbounded_async_fanout — false-positive boundaries", () => {
  it("says nothing about a small array literal", () => {
    expect(
      run(`export async function boot() { return Promise.all([a(), b(), c()]); }`),
    ).toHaveLength(0);
  });

  it("says nothing when the source query is bounded", () => {
    expect(
      run(`
        export async function notify() {
          const orders = await db.orders.findMany({ take: 50 });
          return Promise.all(orders.map((o) => api.post("/notify", o)));
        }
      `),
    ).toHaveLength(0);
  });

  it("says nothing when the collection is sliced", () => {
    expect(
      run(`
        export async function notify(orders) {
          return Promise.all(orders.slice(0, 10).map((o) => api.post("/notify", o)));
        }
      `),
    ).toHaveLength(0);
  });

  it("says nothing when a concurrency limit is declared", () => {
    expect(
      run(`
        export async function notify(orders) {
          return Promise.all(orders.map((o) => enqueue(o, { concurrency: 5 })));
        }
      `),
    ).toHaveLength(0);
  });

  it("says nothing when the callback is a pure transform", () => {
    expect(
      run(`
        export async function shape(orders) {
          return Promise.all(orders.map((o) => ({ id: o.id, total: o.total })));
        }
      `),
    ).toHaveLength(0);
  });

  it("says nothing about Promise.all over a non-map expression", () => {
    expect(
      run(`export async function run() { return Promise.all(makePromises()); }`),
    ).toHaveLength(0);
  });

  it("never fires in tests, fixtures, or generated code", () => {
    expect(run(UNBOUNDED, "src/notify.test.ts")).toHaveLength(0);
    expect(run(UNBOUNDED, "test/fixtures/notify.ts")).toHaveLength(0);
    expect(run(UNBOUNDED, "src/__generated__/notify.ts")).toHaveLength(0);
  });
});

describe("unbounded_async_fanout — configuration", () => {
  it("honours staticallySmall", () => {
    const source = `
      export async function boot() {
        return Promise.all([a(), b(), c(), d(), e(), f(), g(), h(), i(), j()].map((x) => api.post("/x", x)));
      }
    `;
    // Ten elements is above the default bound of 8, so it reports.
    expect(run(source)).toHaveLength(1);
    expect(
      run(
        source,
        "src/a.ts",
        configWithOptions("unbounded_async_fanout", { staticallySmall: 20 }),
      ),
    ).toHaveLength(0);
  });

  it("honours boundedHelpers", () => {
    const source = `
      export async function notify() {
        const orders = await mapWithLimit();
        return Promise.all(orders.map((o) => api.post("/notify", o)));
      }
    `;
    expect(run(source)).toHaveLength(1);
    expect(
      run(
        source,
        "src/a.ts",
        configWithOptions("unbounded_async_fanout", { boundedHelpers: ["mapWithLimit"] }),
      ),
    ).toHaveLength(0);
  });

  it("honours reportUnclassifiedWork", () => {
    const source = `
      export async function shape(orders) {
        return Promise.all(orders.map((o) => transform(o)));
      }
    `;
    expect(run(source)).toHaveLength(0);
    expect(
      run(
        source,
        "src/a.ts",
        configWithOptions("unbounded_async_fanout", { reportUnclassifiedWork: true }),
      ),
    ).toHaveLength(1);
  });

  it("validates its options schema", () => {
    const schema = unboundedAsyncFanoutDetector.optionsSchema!;
    expect(schema.safeParse({ staticallySmall: 16 }).success).toBe(true);
    expect(schema.safeParse({ staticallySmall: 0 }).success).toBe(false);
    expect(schema.safeParse({ nope: true }).success).toBe(false);
  });
});

describe("unbounded_async_fanout — stability", () => {
  it("is deterministic across runs", () => {
    expect(JSON.stringify(run(UNBOUNDED))).toBe(JSON.stringify(run(UNBOUNDED)));
  });

  it("gives two fan-outs in one function distinct symbols", () => {
    const findings = run(`
      export async function sync() {
        const orders = await db.orders.findMany();
        await Promise.all(orders.map((o) => api.post("/a", o)));
        const users = await db.users.findMany();
        await Promise.all(users.map((u) => queue.publish(u)));
      }
    `);
    expect(findings).toHaveLength(2);
    expect(new Set(findings.map((f) => f.symbol)).size).toBe(2);
  });
});
