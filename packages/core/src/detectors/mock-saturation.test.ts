import { describe, expect, it } from "vitest";
import { parseFile } from "@crimes/language-js";
import { mockSaturationDetector } from "./mock-saturation.js";
import { DEFAULT_CONFIG, type CrimesConfig } from "../config.js";
import type { LanguageJsDetectorContext } from "../detector.js";
import type { PreFinding } from "../finding.js";
import { configWithOptions } from "../risk/test-harness.js";

function run(
  source: string,
  file = "src/services/billing.test.ts",
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
  return mockSaturationDetector.run(ctx) as PreFinding[];
}

const SATURATED = `
import { describe, it, expect, vi } from "vitest";
import { chargeCustomer } from "./billing.js";
import { db } from "./db.js";
import { stripe } from "./stripe.js";

vi.mock("./db.js", () => ({ insert: vi.fn(), find: vi.fn() }));
vi.mock("./stripe.js", () => ({ charge: vi.fn() }));

describe("chargeCustomer", () => {
  it("charges the customer", async () => {
    await chargeCustomer({ total: 100 });
    expect(stripe.charge).toHaveBeenCalled();
    expect(db.insert).toHaveBeenCalledWith({ total: 100 });
  });
});
`;

describe("mock_saturation — positive cases", () => {
  it("reports a test that mocks every collaborator and asserts only on mocks", () => {
    const findings = run(SATURATED);
    expect(findings).toHaveLength(1);
    const finding = findings[0]!;
    expect(finding.type).toBe("mock_saturation");
    expect(finding.charge).toBe("Mock Alibi");
    expect(finding.symbol).toBe("chargeCustomer › charges the customer");
  });

  it("names the subject, the doubles, and the assertion categories", () => {
    const evidence = run(SATURATED)[0]!.evidence.join("\n");
    expect(evidence).toContain('test case: "chargeCustomer › charges the customer"');
    expect(evidence).toContain("subject under test: ./billing.js");
    expect(evidence).toMatch(
      /mocked collaborators \(2\):.*\.\/db\.js \(no implementation\)/,
    );
    expect(evidence).toContain("mocked boundaries: database write, payment");
    expect(evidence).toContain(
      "assertion categories observed: mock_interaction (2 mock-interaction, 0 behavioural)",
    );
    expect(evidence).toMatch(/line \d+: toHaveBeenCalled → mock_interaction/);
  });

  it("explains why the test cannot observe behaviour", () => {
    const evidence = run(SATURATED)[0]!.evidence.join("\n");
    expect(evidence).toContain(
      "every assertion inspects a double's calls or arguments; none inspects a value",
    );
  });

  it("escalates severity when the doubles cover consequential boundaries", () => {
    const [finding] = run(SATURATED);
    expect(finding!.evidence.join("\n")).toMatch(
      /severity raised by:.*mocks stand in for database write, payment/,
    );
  });

  it("flags a test that mocks the subject itself at high severity", () => {
    const [finding] = run(`
      import { it, expect, vi } from "vitest";
      import { chargeCustomer } from "./billing.js";
      import { db } from "./db.js";
      vi.mock("./billing.js", () => ({ chargeCustomer: vi.fn() }));
      vi.mock("./db.js", () => ({ insert: vi.fn() }));
      it("charges", async () => {
        await chargeCustomer({});
        expect(chargeCustomer).toHaveBeenCalled();
      });
    `);
    expect(finding!.summary).toContain("mock the subject under test itself");
    expect(finding!.evidence.join("\n")).toContain(
      "the module under test is itself among the mocked specifiers",
    );
  });

  it("recommends a behaviour assertion without demanding the mocks go away", () => {
    const actions = run(SATURATED)[0]!.suggested_actions ?? [];
    expect(actions[0]!.kind).toBe("assert_observable_outcome");
    expect(actions[0]!.description).toContain("Keep this test");
    expect(actions[1]!.kind).toBe("add_boundary_test");
  });
});

describe("mock_saturation — false-positive boundaries", () => {
  it("says nothing when the test asserts a returned value", () => {
    expect(
      run(`
        import { it, expect, vi } from "vitest";
        import { total } from "./billing.js";
        import { db } from "./db.js";
        vi.mock("./db.js", () => ({ find: vi.fn() }));
        vi.mock("./tax.js", () => ({ rate: vi.fn() }));
        it("totals", () => {
          expect(total({ items: [] })).toBe(0);
          expect(db.find).toHaveBeenCalled();
        });
      `),
    ).toHaveLength(0);
  });

  it("says nothing when the test asserts a thrown error", () => {
    expect(
      run(`
        import { it, expect, vi } from "vitest";
        import { charge } from "./billing.js";
        vi.mock("./db.js", () => ({ insert: vi.fn() }));
        vi.mock("./stripe.js", () => ({ charge: vi.fn() }));
        it("rejects", () => {
          expect(() => charge(null)).toThrow();
        });
      `),
    ).toHaveLength(0);
  });

  it("says nothing about a focused unit test with one mock", () => {
    expect(
      run(`
        import { it, expect, vi } from "vitest";
        import { stamp } from "./billing.js";
        import { clock } from "./clock.js";
        vi.mock("./clock.js", () => ({ now: vi.fn() }));
        it("stamps", () => {
          stamp({});
          expect(clock.now).toHaveBeenCalled();
        });
      `),
    ).toHaveLength(0);
  });

  it("does not count mocked infrastructure toward saturation", () => {
    expect(
      run(`
        import { it, expect, vi } from "vitest";
        import { write } from "./billing.js";
        import { real } from "./real.js";
        vi.mock("node:fs", () => ({ writeFileSync: vi.fn() }));
        vi.mock("node:crypto", () => ({ randomUUID: vi.fn() }));
        it("writes", () => {
          write({});
          expect(real.saw).toHaveBeenCalled();
        });
      `),
    ).toHaveLength(0);
  });

  it("does not report a test with no assertions — that is weak_test_signal", () => {
    expect(
      run(`
        import { it, vi } from "vitest";
        import { charge } from "./billing.js";
        vi.mock("./db.js", () => ({ insert: vi.fn() }));
        vi.mock("./stripe.js", () => ({ charge: vi.fn() }));
        it("runs", async () => { await charge({}); });
      `),
    ).toHaveLength(0);
  });

  it("does not report doubles that carry a real implementation", () => {
    expect(
      run(`
        import { it, expect, vi } from "vitest";
        import { charge } from "./billing.js";
        import { db } from "./db.js";
        vi.mock("./db.js", () => ({ insert: vi.fn(async () => ({ id: 1 })) }));
        vi.mock("./stripe.js", () => ({ charge: vi.fn(async () => ({ ok: true })) }));
        it("charges", async () => {
          await charge({});
          expect(db.insert).toHaveBeenCalled();
        });
      `),
    ).toHaveLength(0);
  });

  it("never fires outside a test file", () => {
    expect(run(SATURATED, "src/services/billing.ts")).toHaveLength(0);
  });
});

describe("mock_saturation — configuration", () => {
  it("honours minMockedCollaborators", () => {
    expect(run(SATURATED)).toHaveLength(1);
    expect(
      run(
        SATURATED,
        "src/services/billing.test.ts",
        configWithOptions("mock_saturation", { minMockedCollaborators: 5 }),
      ),
    ).toHaveLength(0);
  });

  it("honours minMockedRatio", () => {
    expect(
      run(
        SATURATED,
        "src/services/billing.test.ts",
        configWithOptions("mock_saturation", { minMockedRatio: 1 }),
      ),
    ).toHaveLength(1);
  });

  it("honours alwaysAllowedMocks", () => {
    expect(
      run(
        SATURATED,
        "src/services/billing.test.ts",
        configWithOptions("mock_saturation", {
          alwaysAllowedMocks: ["./db.js", "./stripe.js"],
        }),
      ),
    ).toHaveLength(0);
  });

  it("validates its options schema", () => {
    const schema = mockSaturationDetector.optionsSchema!;
    expect(schema.safeParse({ minMockedRatio: 0.5 }).success).toBe(true);
    expect(schema.safeParse({ minMockedRatio: 5 }).success).toBe(false);
    expect(schema.safeParse({ oops: 1 }).success).toBe(false);
  });
});

describe("mock_saturation — stability", () => {
  it("is deterministic across runs", () => {
    expect(JSON.stringify(run(SATURATED))).toBe(JSON.stringify(run(SATURATED)));
  });

  it("gives each reported case a distinct symbol", () => {
    const findings = run(`
      import { it, expect, vi } from "vitest";
      import { charge } from "./billing.js";
      import { db } from "./db.js";
      vi.mock("./db.js", () => ({ insert: vi.fn() }));
      vi.mock("./stripe.js", () => ({ charge: vi.fn() }));
      it("first", async () => { await charge({}); expect(db.insert).toHaveBeenCalled(); });
      it("second", async () => { await charge({}); expect(db.insert).toHaveBeenCalledWith({}); });
    `);
    expect(findings).toHaveLength(2);
    expect(new Set(findings.map((f) => f.symbol)).size).toBe(2);
  });
});
