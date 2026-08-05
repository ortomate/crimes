import { parseFile } from "@crimes/language-js";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import type { LanguageJsDetectorContext } from "../detector.js";
import { nameBehaviorMismatchDetector } from "./name-behavior-mismatch.js";

function makeCtx(source: string, file = "src/billing.ts"): LanguageJsDetectorContext {
  return {
    kind: "language-js",
    file,
    absolutePath: `/tmp/${file}`,
    source,
    parsed: parseFile({ absolutePath: `/tmp/${file}`, source }),
    config: DEFAULT_CONFIG,
  };
}

describe("nameBehaviorMismatchDetector", () => {
  it("detects safe-sounding functions that perform side effects", async () => {
    const source = `
export async function calculateInvoice(order: Order) {
  const invoice = buildInvoice(order);
  await saveInvoice(invoice);
  await sendInvoiceEmail(invoice);
  return invoice.total;
}
`;
    const findings = await nameBehaviorMismatchDetector.run(makeCtx(source));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.type).toBe("name_behavior_mismatch");
    expect(findings[0]!.symbol).toBe("calculateInvoice");
    expect(findings[0]!.severity).toBe("medium");
    expect(findings[0]!.evidence.join(" ")).toContain("saveInvoice");
  });

  it("ignores names that disclose mutation", async () => {
    const source = `
export async function getOrCreateUser(id: string) {
  const existing = await findUser(id);
  if (existing) return existing;
  return createUser(id);
}
`;
    const findings = await nameBehaviorMismatchDetector.run(makeCtx(source));
    expect(findings).toEqual([]);
  });

  it("ignores pure transformations", async () => {
    const source = `
export function formatLabel(value: string) {
  return value.trim().toUpperCase();
}
`;
    const findings = await nameBehaviorMismatchDetector.run(makeCtx(source));
    expect(findings).toEqual([]);
  });

  it("ignores test files", async () => {
    const source = `
function calculateInvoice(order: Order) {
  saveInvoice(order);
  sendInvoiceEmail(order);
}
`;
    const findings = await nameBehaviorMismatchDetector.run(
      makeCtx(source, "src/billing.test.ts"),
    );
    expect(findings).toEqual([]);
  });

  it("separates two same-named functions in one file", async () => {
    // n8n has four `build` functions in one model-factory file and two
    // `render` functions in each of several .stories.ts files; every
    // group shared one fingerprint.
    const source = `
const a = {
  async build(order: Order) {
    const invoice = buildInvoice(order);
    await saveInvoice(invoice);
    await sendInvoiceEmail(invoice);
    return invoice.total;
  },
};
const b = {
  async build(order: Order) {
    const receipt = buildReceipt(order);
    await saveReceipt(receipt);
    await sendReceiptEmail(receipt);
    return receipt.total;
  },
};
`;
    const findings = await nameBehaviorMismatchDetector.run(makeCtx(source));
    expect(findings).toHaveLength(2);
    expect(new Set(findings.map((f) => f.symbol)).size).toBe(1);
    expect(new Set(findings.map((f) => f.discriminator)).size).toBe(2);
  });

  it("leaves a uniquely-named function with no discriminator", async () => {
    const source = `
export async function calculateInvoice(order: Order) {
  const invoice = buildInvoice(order);
  await saveInvoice(invoice);
  await sendInvoiceEmail(invoice);
  return invoice.total;
}
`;
    const findings = await nameBehaviorMismatchDetector.run(makeCtx(source));
    expect(findings[0]!.discriminator).toBeUndefined();
  });
});

/**
 * Building the thing you read *through* is not a side effect.
 *
 * Field notes from choreograph.cc: `getChoreoByDate() → calls
 * createClient` fired five times in `src/lib/api.ts` alone, "because a
 * `get*` function makes a side-effect-like call — but `createClient()`
 * is constructing the client in order to *do the read*. Every
 * data-access layer in every Next.js app has this shape."
 *
 * The rule is about the shape, not the name: a `create*` whose result is
 * bound and then dereferenced is a factory. A `createClient` allowlist
 * would be a treadmill — the next framework calls it `getConnection` or
 * `makePool` — and would bake one ecosystem's vocabulary into a detector
 * about naming in general.
 */
describe("nameBehaviorMismatchDetector — factory calls", () => {
  it("does not charge a reader for constructing its own client", async () => {
    const source = `
export async function getChoreoByDate(person: string, date: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('choreograph_posts')
    .select('*')
    .eq('person', person)
    .single();
  if (error) return null;
  return data;
}
`;
    const findings = await nameBehaviorMismatchDetector.run(makeCtx(source));
    expect(findings).toHaveLength(0);
  });

  it("works for any factory name, not a `createClient` allowlist", async () => {
    // Same shape, different name. `makeConnectionPool` would be a
    // meaningless test here — it never matched the side-effect regex in
    // the first place, so it would pass with or without the rule.
    const source = `
export async function getRows(id: string) {
  const pool = await createConnectionPool();
  const rows = await pool.query('select 1');
  await pool.release();
  return rows;
}
`;
    const findings = await nameBehaviorMismatchDetector.run(makeCtx(source));
    expect(findings).toHaveLength(0);
  });

  it("still charges a reader that also performs a real side effect", async () => {
    // Only the factory call is discounted. A `get*` that builds a client
    // AND deletes a row is exactly what this charge is for.
    const source = `
export async function getAndPurge(id: string) {
  const supabase = await createClient();
  await supabase.from('posts').select('*');
  await deleteRecord(id);
  await sendEmail(id);
  return true;
}
`;
    const findings = await nameBehaviorMismatchDetector.run(makeCtx(source));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.evidence.join(" ")).toMatch(/deleteRecord|sendEmail/);
  });

  it("still charges a create* call made for its effect", async () => {
    // The return value is not used as a receiver — nothing is built to
    // be read through, so this is a mutation with a reader's name.
    const source = `
export async function getCheckout(cartId: string) {
  await createOrder(cartId);
  await sendReceipt(cartId);
  return true;
}
`;
    const findings = await nameBehaviorMismatchDetector.run(makeCtx(source));
    expect(findings).toHaveLength(1);
  });

  it("does not discount a factory whose result is only returned", async () => {
    // `const x = createThing(); return x;` binds but never dereferences,
    // so the shape rule does not fire — and it should not, because the
    // function is not reading *through* anything.
    const source = `
export async function getThing(id: string) {
  const made = await createThing(id);
  await updateIndex(id);
  return made;
}
`;
    const findings = await nameBehaviorMismatchDetector.run(makeCtx(source));
    expect(findings).toHaveLength(1);
  });
});

describe("nameBehaviorMismatchDetector — the factory rule stays narrow", () => {
  it("does not discount fetch just because the response is read", async () => {
    // `const res = await fetch(url)` then `res.json()` fits the
    // bound-and-dereferenced shape exactly, and a network call is a side
    // effect whatever you do with the response. Caught on the corpus:
    // the first version of the factory rule silently dropped a real
    // `fetch` finding in `integrations/google-oauth.ts`.
    const source = `
export async function getTokens(code: string) {
  const res = await fetch('https://oauth.example/token', { method: 'POST' });
  const json = await res.json();
  await saveTokens(json);
  return json;
}
`;
    const findings = await nameBehaviorMismatchDetector.run(makeCtx(source));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.evidence.join(" ")).toMatch(/fetch/);
  });

  it("does not treat a past-tense `created` binding as a factory", async () => {
    const source = `
export async function getSummary(id: string) {
  const created = await createdAtFor(id);
  await deleteStale(id);
  await sendDigest(id);
  return created;
}
`;
    const findings = await nameBehaviorMismatchDetector.run(makeCtx(source));
    expect(findings).toHaveLength(1);
  });
});
