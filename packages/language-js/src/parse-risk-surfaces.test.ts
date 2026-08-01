import { describe, expect, it } from "vitest";
import { parseFile } from "./index.js";
import type { ParsedFile } from "./index.js";

/**
 * Unit tests for the 0.16.0 risk surfaces.
 *
 * These assert *semantics*, not shape: that a normalised policy from two
 * differently-named variables collides, that a `.partial()` Zod schema
 * marks its fields optional, that a catch which logs without the error
 * is distinguishable from one that logs with it. A test that only
 * counted array lengths would pass while the detector built on top
 * produced nonsense.
 */

function parse(source: string, path = "/repo/src/module.ts"): ParsedFile {
  return parseFile({ absolutePath: path, source });
}

describe("policy expressions", () => {
  it("normalises the same rule written with different local names", () => {
    const a = parse(`
      export function canEditA(user) {
        if (user.role === "admin") return true;
        return false;
      }
    `);
    const b = parse(`
      export function canEditB(member) {
        if (member.role === "admin") return true;
        return false;
      }
    `);
    const first = a.policyExpressions?.[0];
    const second = b.policyExpressions?.[0];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first?.normalized).toBe(second?.normalized);
    expect(first?.normalized).toContain('"admin"');
    expect(first?.normalized).toContain(".role");
  });

  it("keeps distinct property tails apart", () => {
    const role = parse(`function f(u) { if (u.role === "admin") return 1; return 0; }`);
    const status = parse(
      `function f(u) { if (u.status === "admin") return 1; return 0; }`,
    );
    expect(role.policyExpressions?.[0]?.normalized).not.toBe(
      status.policyExpressions?.[0]?.normalized,
    );
  });

  it("orders commutative comparisons so operand order does not matter", () => {
    const forward = parse(`function f(u) { if (u.plan === "pro") return 1; return 0; }`);
    const reversed = parse(`function f(u) { if ("pro" === u.plan) return 1; return 0; }`);
    expect(forward.policyExpressions?.[0]?.normalized).toBe(
      reversed.policyExpressions?.[0]?.normalized,
    );
  });

  it("classifies an early-return check as a guard clause", () => {
    const parsed = parse(`
      function charge(order) {
        if (order.status !== "approved") throw new Error("bad state");
        return 1;
      }
    `);
    const guard = parsed.policyExpressions?.find((p) => p.kind === "guard_clause");
    expect(guard).toBeDefined();
    expect(guard?.enclosing).toBe("charge");
    expect(guard?.literals).toContain("approved");
    expect(guard?.paths).toContain("order.status");
  });

  it("ignores trivial null and truthiness checks", () => {
    const parsed = parse(`
      function f(user, other) {
        if (!user) return 0;
        if (user == null) return 0;
        if (other) return 1;
        return 2;
      }
    `);
    expect(parsed.policyExpressions ?? []).toHaveLength(0);
  });

  it("records a multi-case switch as one ordered policy", () => {
    const parsed = parse(`
      function next(order) {
        switch (order.status) {
          case "draft": return "pending";
          case "pending": return "active";
          case "active": return "closed";
          default: return "draft";
        }
      }
    `);
    const sw = parsed.policyExpressions?.find((p) => p.kind === "switch_case");
    expect(sw).toBeDefined();
    expect(sw?.normalized).toContain("switch .status");
    expect(sw?.literals).toEqual(["active", "draft", "pending"]);
    expect(sw?.normalized).toContain("default");
  });

  it("does not record a two-case switch", () => {
    const parsed = parse(`
      function f(o) {
        switch (o.status) {
          case "a": return 1;
          case "b": return 2;
        }
      }
    `);
    expect(parsed.policyExpressions?.some((p) => p.kind === "switch_case")).toBeFalsy();
  });

  it("captures membership tests with their argument", () => {
    const parsed = parse(`
      function allowed(user) {
        return user.roles.includes("billing.admin") && user.plan !== "free";
      }
    `);
    const policy = parsed.policyExpressions?.[0];
    expect(policy?.calls).toContain("includes");
    expect(policy?.literals).toEqual(expect.arrayContaining(["billing.admin", "free"]));
  });
});

describe("object contracts", () => {
  it("reads an interface with optionality and nullability", () => {
    const parsed = parse(`
      export interface User {
        id: string;
        email?: string;
        deletedAt: Date | null;
      }
    `);
    const contract = parsed.objectContracts?.[0];
    expect(contract?.name).toBe("User");
    expect(contract?.source).toBe("interface");
    expect(contract?.exported).toBe(true);
    expect(contract?.partial).toBe(false);

    const byName = new Map(contract?.fields.map((f) => [f.name, f]));
    expect(byName.get("id")?.optional).toBe(false);
    expect(byName.get("email")?.optional).toBe(true);
    expect(byName.get("deletedAt")?.nullable).toBe(true);
    // `null` is lifted out of the union so the base type compares cleanly.
    expect(byName.get("deletedAt")?.type).toBe("Date");
  });

  it("marks an interface with a heritage clause partial", () => {
    const parsed = parse(`
      interface Admin extends Base { id: string; role: string }
    `);
    expect(parsed.objectContracts?.[0]?.partial).toBe(true);
  });

  it("collects a closed string union as enum members", () => {
    const parsed = parse(`
      type Order = { id: string; status: "draft" | "active" | "closed" };
    `);
    const status = parsed.objectContracts?.[0]?.fields.find((f) => f.name === "status");
    expect(status?.enumMembers).toEqual(["active", "closed", "draft"]);
  });

  it("reads a Zod object schema including optional and enum fields", () => {
    const parsed = parse(`
      export const UserSchema = z.object({
        id: z.string(),
        email: z.string().optional(),
        role: z.enum(["admin", "member"]),
        age: z.number().nullable(),
      });
    `);
    const contract = parsed.objectContracts?.[0];
    expect(contract?.source).toBe("zod");
    expect(contract?.name).toBe("UserSchema");
    expect(contract?.exported).toBe(true);

    const byName = new Map(contract?.fields.map((f) => [f.name, f]));
    expect(byName.get("id")?.type).toBe("string");
    expect(byName.get("email")?.optional).toBe(true);
    expect(byName.get("role")?.enumMembers).toEqual(["admin", "member"]);
    expect(byName.get("age")?.nullable).toBe(true);
  });

  it("honours .partial() by marking every field optional", () => {
    const parsed = parse(`
      const PatchSchema = z.object({ id: z.string(), name: z.string() }).partial();
    `);
    const contract = parsed.objectContracts?.[0];
    expect(contract?.fields.every((f) => f.optional)).toBe(true);
  });

  it("reads Valibot's wrapper form of optionality", () => {
    const parsed = parse(`
      const S = v.object({ id: v.string(), nickname: v.optional(v.string()) });
    `);
    const contract = parsed.objectContracts?.[0];
    expect(contract?.source).toBe("valibot");
    const byName = new Map(contract?.fields.map((f) => [f.name, f]));
    expect(byName.get("nickname")?.optional).toBe(true);
    expect(byName.get("nickname")?.type).toBe("string");
  });

  it("skips single-field declarations", () => {
    const parsed = parse(`interface Tiny { id: string }`);
    expect(parsed.objectContracts ?? []).toHaveLength(0);
  });
});

describe("error handlers", () => {
  it("flags an empty catch and names the protected operation", () => {
    const parsed = parse(`
      async function save(order) {
        try {
          await db.orders.insert(order);
        } catch (e) {}
      }
    `);
    const handler = parsed.errorHandlers?.[0];
    expect(handler?.kind).toBe("catch_clause");
    expect(handler?.body.empty).toBe(true);
    expect(handler?.protectedCalls).toContain("db.orders.insert");
    expect(handler?.enclosing).toBe("save");
  });

  it("distinguishes a comment-only catch from an empty one", () => {
    const parsed = parse(`
      function f() {
        try { risky(); } catch (e) {
          // best effort only
        }
      }
    `);
    const handler = parsed.errorHandlers?.[0];
    expect(handler?.body.empty).toBe(false);
    expect(handler?.body.commentOnly).toBe(true);
    expect(handler?.body.comment).toBe("best effort only");
  });

  it("separates logging with the error from logging without it", () => {
    const withError = parse(`
      function f() { try { go(); } catch (e) { logger.error("failed", e); } }
    `);
    const withoutError = parse(`
      function f() { try { go(); } catch (e) { logger.error("failed"); } }
    `);
    expect(withError.errorHandlers?.[0]?.body.reportsError).toBe(true);
    expect(withError.errorHandlers?.[0]?.body.reportsWithoutError).toBe(false);
    expect(withoutError.errorHandlers?.[0]?.body.reportsError).toBe(false);
    expect(withoutError.errorHandlers?.[0]?.body.reportsWithoutError).toBe(true);
  });

  it("records a bland fallback value", () => {
    const parsed = parse(`
      function f() { try { return load(); } catch (e) { return null; } }
    `);
    expect(parsed.errorHandlers?.[0]?.body.fallback).toBe("null");
  });

  it("recognises a typed result as not swallowing", () => {
    const parsed = parse(`
      function f() {
        try { return { ok: true, value: load() }; }
        catch (e) { return { ok: false, error: e }; }
      }
    `);
    const body = parsed.errorHandlers?.[0]?.body;
    expect(body?.typedResult).toBe(true);
    expect(body?.fallback).toBeUndefined();
  });

  it("recognises rethrow and error discrimination", () => {
    const parsed = parse(`
      function f() {
        try { go(); }
        catch (e) {
          if (e.code === "ENOENT") return undefined;
          throw e;
        }
      }
    `);
    const body = parsed.errorHandlers?.[0]?.body;
    expect(body?.rethrows).toBe(true);
    expect(body?.discriminates).toBe(true);
  });

  it("captures a discarded promise rejection as fire-and-forget", () => {
    const parsed = parse(`
      function f(order) {
        queue.publish(order).catch(() => {});
      }
    `);
    const handler = parsed.errorHandlers?.[0];
    expect(handler?.kind).toBe("fire_and_forget");
    expect(handler?.protectedCalls).toContain("queue.publish");
  });

  it("treats a used .catch() as a promise handler, not fire-and-forget", () => {
    const parsed = parse(`
      async function f(order) {
        const result = await queue.publish(order).catch(() => null);
        return result;
      }
    `);
    expect(parsed.errorHandlers?.[0]?.kind).toBe("promise_catch");
    expect(parsed.errorHandlers?.[0]?.body.fallback).toBe("null");
  });

  it("marks a named no-op handler as intentional", () => {
    const parsed = parse(`function f() { cleanup().catch(noop); }`);
    expect(parsed.errorHandlers?.[0]?.body.intentionalNoop).toBe(true);
  });
});

describe("retry sites", () => {
  it("finds an attempt loop around a POST and reports no idempotency key", () => {
    const parsed = parse(`
      async function submit(order) {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            return await api.post("/orders", order);
          } catch (e) {
            continue;
          }
        }
      }
    `);
    const site = parsed.retrySites?.[0];
    expect(site?.kind).toBe("loop");
    expect(site?.maxAttempts).toBe(3);
    expect(site?.mutations.map((m) => m.method)).toContain("POST");
    expect(site?.safeguards.some((s) => s.kind === "idempotency_key")).toBe(false);
    expect(site?.safeguards.some((s) => s.kind === "bounded_attempts")).toBe(true);
  });

  it("records an idempotency key when one is visible", () => {
    const parsed = parse(`
      async function submit(order) {
        for (let attempt = 0; attempt < 3; attempt++) {
          await stripe.charges.create({ amount: 1 }, { idempotencyKey: order.id });
        }
      }
    `);
    const site = parsed.retrySites?.[0];
    expect(site?.safeguards.some((s) => s.kind === "idempotency_key")).toBe(true);
  });

  it("recognises a retry helper and its bound", () => {
    const parsed = parse(`
      async function run(order) {
        return withRetry(async () => db.orders.insert(order), { retries: 5 });
      }
    `);
    const site = parsed.retrySites?.[0];
    expect(site?.kind).toBe("helper");
    expect(site?.maxAttempts).toBe(5);
    expect(site?.mutations.map((m) => m.callee)).toContain("db.orders.insert");
  });

  it("ignores an ordinary loop with no attempt signal", () => {
    const parsed = parse(`
      async function run(orders) {
        for (const order of orders) { await db.orders.insert(order); }
      }
    `);
    expect(parsed.retrySites ?? []).toHaveLength(0);
  });

  it("records a read-only retry loop but attributes no mutation to it", () => {
    // The site is a fact; whether it is *unsafe* is the detector's call.
    // Recording it is also what lets a project declare its own mutating
    // calls against `calls`.
    const parsed = parse(`
      async function run(id) {
        for (let attempt = 0; attempt < 3; attempt++) {
          const row = await db.orders.findUnique(id);
          if (row) return row;
        }
      }
    `);
    const site = parsed.retrySites?.[0];
    expect(site?.kind).toBe("loop");
    expect(site?.mutations).toEqual([]);
    expect(site?.calls).toContain("db.orders.findUnique");
  });

  it("recognises SDK-level retry configuration", () => {
    const parsed = parse(`
      const client = new Stripe(key, { maxRetries: 3 });
    `);
    const site = parsed.retrySites?.[0];
    expect(site?.kind).toBe("sdk_config");
    expect(site?.maxAttempts).toBe(3);
  });

  it("ignores retries: 0, which disables retrying", () => {
    const parsed = parse(`const client = createClient({ retries: 0 });`);
    expect(parsed.retrySites ?? []).toHaveLength(0);
  });
});

describe("env reads", () => {
  it("records parser, default, and unit", () => {
    const parsed = parse(`
      const timeout = Number(process.env.REQUEST_TIMEOUT_MS ?? "5000");
    `);
    const read = parsed.envReads?.[0];
    expect(read?.name).toBe("REQUEST_TIMEOUT_MS");
    expect(read?.via).toBe("process.env");
    expect(read?.parser).toBe("number");
    expect(read?.defaultValue).toBe('"5000"');
    expect(read?.unit).toBe("milliseconds");
  });

  it("records parseInt separately from Number", () => {
    const parsed = parse(`const port = parseInt(process.env.PORT, 10);`);
    expect(parsed.envReads?.[0]?.parser).toBe("int");
  });

  it("marks a non-null-asserted read required", () => {
    const parsed = parse(`const url = process.env.DATABASE_URL!;`);
    expect(parsed.envReads?.[0]?.required).toBe(true);
  });

  it("captures a client-exposing prefix", () => {
    const parsed = parse(`const key = import.meta.env.VITE_API_KEY;`);
    const read = parsed.envReads?.[0];
    expect(read?.via).toBe("import.meta.env");
    expect(read?.publicPrefix).toBe("VITE_");
  });

  it("captures destructured reads by their source key", () => {
    const parsed = parse(`const { PORT: port, HOST } = process.env;`);
    const names = parsed.envReads?.map((r) => r.name).sort();
    expect(names).toEqual(["HOST", "PORT"]);
    expect(parsed.envReads?.every((r) => r.via === "destructured")).toBe(true);
  });

  it("records a computed key as dynamic without inventing a name", () => {
    const parsed = parse(`function get(name) { return process.env[name]; }`);
    const read = parsed.envReads?.[0];
    expect(read?.name).toBe("*");
    expect(read?.via).toBe("dynamic");
  });

  it("recognises a boolean comparison as a boolean parse", () => {
    const parsed = parse(`const on = process.env.FEATURE_X === "true";`);
    expect(parsed.envReads?.[0]?.parser).toBe("boolean");
  });
});

describe("fan-out sites", () => {
  it("flags Promise.all over an awaited query with network work", () => {
    const parsed = parse(`
      async function run() {
        const orders = await db.orders.findMany();
        return Promise.all(orders.map((o) => fetch("/notify/" + o.id)));
      }
    `);
    const site = parsed.fanOutSites?.[0];
    expect(site?.kind).toBe("promise_all");
    expect(site?.staticallyBounded).toBe(false);
    expect(site?.work.map((w) => w.kind)).toContain("network");
    expect(site?.bounds).toHaveLength(0);
  });

  it("marks a small array literal statically bounded", () => {
    const parsed = parse(`
      async function run() { return Promise.all([a(), b(), c()]); }
    `);
    const site = parsed.fanOutSites?.[0];
    expect(site?.staticallyBounded).toBe(true);
    expect(site?.staticSize).toBe(3);
  });

  it("records a slice as a visible bound", () => {
    const parsed = parse(`
      async function run(items) {
        return Promise.all(items.slice(0, 10).map((i) => fetch(i.url)));
      }
    `);
    const site = parsed.fanOutSites?.[0];
    expect(site?.bounds.some((b) => b.kind === "slice")).toBe(true);
  });

  it("records a query limit option as a bound", () => {
    const parsed = parse(`
      async function run() {
        const rows = await db.orders.findMany({ take: 50 });
        return Promise.all(rows.map((r) => api.post("/x", r)));
      }
    `);
    const site = parsed.fanOutSites?.[0];
    expect(site?.bounds.some((b) => b.kind === "limit_option")).toBe(true);
  });

  it("classifies database and queue work distinctly", () => {
    const parsed = parse(`
      async function run(ids) {
        return Promise.all(ids.map(async (id) => {
          const row = await db.orders.findUnique(id);
          await queue.publish(row);
        }));
      }
    `);
    const kinds = parsed.fanOutSites?.[0]?.work.map((w) => w.kind).sort();
    expect(kinds).toEqual(["database", "queue"]);
  });

  it("ignores Promise.all over a non-map expression", () => {
    const parsed = parse(`async function run() { return Promise.all(makePromises()); }`);
    expect(parsed.fanOutSites ?? []).toHaveLength(0);
  });
});

describe("test surfaces", () => {
  const TEST_PATH = "/repo/src/billing.test.ts";

  it("only collects test surfaces in test files", () => {
    const source = `it("works", () => { expect(1).toBe(1); });`;
    expect(parse(source, "/repo/src/billing.ts").testCases).toBeUndefined();
    expect(parse(source, TEST_PATH).testCases).toHaveLength(1);
  });

  it("categorises assertions by what they prove", () => {
    const parsed = parse(
      `
      it("charges the customer", () => {
        expect(charge).toHaveBeenCalledWith("cus_1");
        expect(result.total).toBe(500);
        expect(() => boom()).toThrow();
        expect(x).toBeTruthy();
      });
      `,
      TEST_PATH,
    );
    const categories = parsed.testCases?.[0]?.assertions.map((a) => a.category);
    expect(categories).toEqual(["mock_interaction", "value", "error", "truthiness"]);
  });

  it("records enclosing describe titles outermost first", () => {
    const parsed = parse(
      `
      describe("billing", () => {
        describe("charge", () => {
          it("works", () => { expect(1).toBe(1); });
        });
      });
      `,
      TEST_PATH,
    );
    expect(parsed.testCases?.[0]?.suite).toEqual(["billing", "charge"]);
  });

  it("marks a factory of bare vi.fn() as hollow", () => {
    const parsed = parse(
      `vi.mock("./db", () => ({ save: vi.fn(), load: vi.fn() }));`,
      TEST_PATH,
    );
    const mock = parsed.mockDeclarations?.[0];
    expect(mock?.kind).toBe("module");
    expect(mock?.target).toBe("./db");
    expect(mock?.hollow).toBe(true);
    expect(mock?.autoMocked).toBe(false);
  });

  it("does not mark a factory with an implementation hollow", () => {
    const parsed = parse(
      `vi.mock("./db", () => ({ save: vi.fn(async () => ({ id: 1 })) }));`,
      TEST_PATH,
    );
    expect(parsed.mockDeclarations?.[0]?.hollow).toBe(false);
  });

  it("marks a factory-less module mock auto-mocked", () => {
    const parsed = parse(`jest.mock("./db");`, TEST_PATH);
    expect(parsed.mockDeclarations?.[0]?.autoMocked).toBe(true);
    expect(parsed.mockDeclarations?.[0]?.hollow).toBe(true);
  });

  it("records a spy with its target", () => {
    const parsed = parse(`vi.spyOn(billing, "charge");`, TEST_PATH);
    const mock = parsed.mockDeclarations?.[0];
    expect(mock?.kind).toBe("spy");
    expect(mock?.target).toBe("billing.charge");
  });

  it("counts calls that program the doubles", () => {
    const parsed = parse(
      `
      it("t", () => {
        db.save.mockResolvedValue({ id: 1 });
        db.load.mockReturnValue(null);
        expect(db.save).toHaveBeenCalled();
      });
      `,
      TEST_PATH,
    );
    expect(parsed.testCases?.[0]?.mockConfigurations).toBe(2);
  });
});

describe("pass-through functions", () => {
  it("records an identical forward", () => {
    const parsed = parse(`
      export function saveUser(user) { return repository.saveUser(user); }
    `);
    const fn = parsed.passThroughFunctions?.[0];
    expect(fn?.name).toBe("saveUser");
    expect(fn?.target).toBe("repository.saveUser");
    expect(fn?.forwarding).toBe("identical");
    expect(fn?.exported).toBe(true);
    expect(fn?.sameName).toBe(true);
    expect(fn?.adds).toEqual([]);
  });

  it("records what a wrapper adds", () => {
    const parsed = parse(`
      export async function saveUser(user) { return await repository.save(user, "v2"); }
    `);
    const fn = parsed.passThroughFunctions?.[0];
    expect(fn?.adds).toEqual(
      expect.arrayContaining(["awaits the result", "binds a constant argument"]),
    );
    expect(fn?.forwarding).toBe("partial");
  });

  it("recognises a rest-argument forward", () => {
    const parsed = parse(`const wrap = (...args) => inner(...args);`);
    const fn = parsed.passThroughFunctions?.[0];
    expect(fn?.forwarding).toBe("identical");
    expect(fn?.target).toBe("inner");
  });

  it("ignores recursion", () => {
    const parsed = parse(`function f(x) { return f(x); }`);
    expect(parsed.passThroughFunctions ?? []).toHaveLength(0);
  });

  it("ignores a function that transforms rather than forwards", () => {
    const parsed = parse(`function f(x) { return inner(x.id, x.name); }`);
    const fn = parsed.passThroughFunctions?.[0];
    // Arguments derive from the parameter but are not the parameter, so
    // nothing from the signature reaches the call unchanged.
    expect(fn).toBeUndefined();
  });

  it("records the receiver for a member forward", () => {
    const parsed = parse(`
      class Service {
        save(order) { return this.repo.save(order); }
      }
    `);
    const fn = parsed.passThroughFunctions?.[0];
    expect(fn?.viaMember).toBe("this.repo");
    expect(fn?.sameName).toBe(true);
  });
});

describe("parser resilience", () => {
  it("does not throw on malformed source", () => {
    expect(() => parse(`function broken( { if (x === ) { return`)).not.toThrow();
  });

  it("produces no risk surfaces for an empty file", () => {
    const parsed = parse("");
    expect(parsed.policyExpressions).toBeUndefined();
    expect(parsed.errorHandlers).toBeUndefined();
    expect(parsed.envReads).toBeUndefined();
  });

  it("is deterministic across repeated parses", () => {
    const source = `
      export function canEdit(user, doc) {
        if (user.role === "admin") return true;
        if (user.id === doc.ownerId) return true;
        return false;
      }
      const timeout = Number(process.env.TIMEOUT_MS ?? "1000");
    `;
    const first = JSON.stringify(parse(source));
    const second = JSON.stringify(parse(source));
    expect(first).toBe(second);
  });
});
