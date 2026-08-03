import { describe, expect, it } from "vitest";
import { parseFile } from "@crimes/language-js";
import { unsafeRetryDetector } from "./unsafe-retry.js";
import { DEFAULT_CONFIG, type CrimesConfig } from "../config.js";
import type { LanguageJsDetectorContext } from "../detector.js";
import type { PreFinding } from "../finding.js";
import { configWithOptions } from "../risk/test-harness.js";

function run(
  source: string,
  file = "src/services/orders.ts",
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
  return unsafeRetryDetector.run(ctx) as PreFinding[];
}

const RETRIED_POST = `
export async function submitOrder(order) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await api.post("/orders", order);
    } catch (e) {
      continue;
    }
  }
}
`;

describe("unsafe_retry — positive cases", () => {
  it("reports a retried POST with no idempotency key", () => {
    const findings = run(RETRIED_POST);
    expect(findings).toHaveLength(1);
    const finding = findings[0]!;
    expect(finding.type).toBe("unsafe_retry");
    expect(finding.charge).toBe("Double Jeopardy");
    expect(finding.symbol).toBe("submitOrder → post");
  });

  it("names the retry construct, the mutation, and the missing safeguard", () => {
    const evidence = run(RETRIED_POST)[0]!.evidence.join("\n");
    expect(evidence).toMatch(/retry construct: attempt loop: for \(let attempt = 0/);
    expect(evidence).toContain("retried mutation — api.post at line 5 (HTTP POST)");
    expect(evidence).toContain(
      "missing safeguard (primary): no idempotency or deduplication key",
    );
  });

  it("lists the safeguards that ARE present rather than only what is missing", () => {
    const evidence = run(RETRIED_POST)[0]!.evidence.join("\n");
    expect(evidence).toContain("safeguards visible at this site:");
    expect(evidence).toContain("bounded attempt count: loop bounded at 3 attempt(s)");
    expect(evidence).toContain("attempt bound: 3");
    expect(evidence).toMatch(/also absent: error classification, delay/);
  });

  it("escalates severity for a payment operation", () => {
    const [finding] = run(`
      export async function charge(order) {
        for (let attempt = 0; attempt < 3; attempt++) {
          try { return await stripe.charges.create({ amount: order.total }); }
          catch (e) { continue; }
        }
      }
    `);
    expect(finding!.severity).toBe("high");
    expect(finding!.evidence.join("\n")).toContain("boundary: payment");
    expect(finding!.suggested_actions![0]!.description).toContain(
      "idempotency key derived from the business operation",
    );
  });

  it("reports a retry helper wrapping a database write", () => {
    const [finding] = run(`
      export async function save(order) {
        return withRetry(async () => db.orders.insert(order), { retries: 5 });
      }
    `);
    expect(finding!.evidence.join("\n")).toContain("retry helper: withRetry(…)");
    expect(finding!.evidence.join("\n")).toContain("retried mutation — db.orders.insert");
  });

  it("reports SDK-level retry configuration", () => {
    const [finding] = run(`
      export function makeClient(key) {
        return new PaymentClient(key, { maxRetries: 3 });
      }
    `);
    expect(finding!.evidence.join("\n")).toContain("client configured with maxRetries");
  });

  it("reports a function that recurses from its own catch", () => {
    const [finding] = run(`
      export async function publishOrder(order) {
        try { return await queue.publish(order); }
        catch (e) { return publishOrder(order); }
      }
    `);
    expect(finding!.evidence.join("\n")).toContain(
      "publishOrder() calls itself from its catch block",
    );
    expect(finding!.score_rationale!.join("\n")).toContain("no visible attempt bound");
  });
});

describe("unsafe_retry — complete defences", () => {
  it("says nothing when an idempotency key is visible", () => {
    expect(
      run(`
        export async function charge(order) {
          for (let attempt = 0; attempt < 3; attempt++) {
            await stripe.charges.create({ amount: 1 }, { idempotencyKey: order.id });
          }
        }
      `),
    ).toHaveLength(0);
  });

  it("accepts an Idempotency-Key header spelling", () => {
    expect(
      run(`
        export async function submit(order) {
          for (let attempt = 0; attempt < 3; attempt++) {
            await api.post("/orders", order, { headers: { "Idempotency-Key": order.id } });
          }
        }
      `),
    ).toHaveLength(0);
  });

  it("says nothing when the retry only reads", () => {
    expect(
      run(`
        export async function load(id) {
          for (let attempt = 0; attempt < 3; attempt++) {
            const row = await db.orders.findUnique(id);
            if (row) return row;
          }
        }
      `),
    ).toHaveLength(0);
  });

  it("says nothing about an ordinary iteration loop", () => {
    expect(
      run(`
        export async function saveAll(orders) {
          for (const order of orders) { await db.orders.insert(order); }
        }
      `),
    ).toHaveLength(0);
  });

  it("says nothing when retries are disabled", () => {
    expect(run(`const c = createClient({ retries: 0 });`)).toHaveLength(0);
  });

  it("never fires in test or fixture files", () => {
    expect(run(RETRIED_POST, "src/orders.test.ts")).toHaveLength(0);
    expect(run(RETRIED_POST, "test/fixtures/orders.ts")).toHaveLength(0);
  });
});

describe("unsafe_retry — configuration", () => {
  it("honours transactionCountsAsIdempotent", () => {
    const source = `
      export async function save(order) {
        for (let attempt = 0; attempt < 3; attempt++) {
          await db.$transaction(async (tx) => { await tx.orders.insert(order); });
        }
      }
    `;
    expect(run(source)).toHaveLength(1);
    expect(
      run(
        source,
        "src/a.ts",
        configWithOptions("unsafe_retry", { transactionCountsAsIdempotent: true }),
      ),
    ).toHaveLength(0);
  });

  it("honours reportDelete", () => {
    const source = `
      export async function remove(id) {
        for (let attempt = 0; attempt < 3; attempt++) {
          try { return await api.delete("/orders/" + id); } catch (e) { continue; }
        }
      }
    `;
    expect(run(source)).toHaveLength(1);
    expect(
      run(source, "src/a.ts", configWithOptions("unsafe_retry", { reportDelete: false })),
    ).toHaveLength(0);
  });

  it("honours idempotentCalls", () => {
    expect(
      run(
        RETRIED_POST,
        "src/a.ts",
        configWithOptions("unsafe_retry", { idempotentCalls: ["post"] }),
      ),
    ).toHaveLength(0);
  });

  it("honours mutatingCalls for a project-specific write", () => {
    const source = `
      export async function append(entry) {
        for (let attempt = 0; attempt < 3; attempt++) {
          try { return await ledger.append(entry); } catch (e) { continue; }
        }
      }
    `;
    // `append` is not in the built-in mutating vocabulary.
    expect(run(source)).toHaveLength(0);
    expect(
      run(
        source,
        "src/a.ts",
        configWithOptions("unsafe_retry", { mutatingCalls: ["ledger.append"] }),
      ),
    ).toHaveLength(1);
  });

  it("validates its options schema", () => {
    const schema = unsafeRetryDetector.optionsSchema!;
    expect(schema.safeParse({ reportDelete: false }).success).toBe(true);
    expect(schema.safeParse({ mutatingCalls: ["a"] }).success).toBe(true);
    expect(schema.safeParse({ mutatingCalls: "a" }).success).toBe(false);
    expect(schema.safeParse({ wrong: 1 }).success).toBe(false);
  });
});

describe("unsafe_retry — stability", () => {
  it("is deterministic across runs", () => {
    expect(JSON.stringify(run(RETRIED_POST))).toBe(JSON.stringify(run(RETRIED_POST)));
  });

  it("gives two retry sites in one function distinct symbols", () => {
    const findings = run(`
      export async function sync(order) {
        for (let attempt = 0; attempt < 3; attempt++) {
          try { await api.post("/a", order); } catch (e) { continue; }
        }
        for (let retry = 0; retry < 3; retry++) {
          try { await queue.publish(order); } catch (e) { continue; }
        }
      }
    `);
    expect(findings).toHaveLength(2);
    expect(new Set(findings.map((f) => f.symbol)).size).toBe(2);
  });

  it("sorts safeguard evidence so lines do not shuffle between runs", () => {
    const evidence = run(`
      export async function submit(order) {
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            await sleep(100 * attempt);
            if (isRetryable(lastError)) await api.post("/orders", order);
          } catch (e) { continue; }
        }
      }
    `)[0]!.evidence;
    const start = evidence.indexOf("safeguards visible at this site:");
    expect(start).toBeGreaterThan(-1);
    const safeguardLines: string[] = [];
    for (let i = start + 1; i < evidence.length; i++) {
      if (!evidence[i]!.startsWith("  ")) break;
      safeguardLines.push(evidence[i]!);
    }
    expect(safeguardLines.length).toBeGreaterThan(1);
    expect([...safeguardLines].sort()).toEqual(safeguardLines);
  });
});
