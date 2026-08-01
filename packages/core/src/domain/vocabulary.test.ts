import { describe, expect, it } from "vitest";
import {
  classifyBoundary,
  conceptsIn,
  criticalFieldReason,
  domainTokensAcross,
  domainTokensIn,
  isCriticalField,
  isDomainBearing,
  isStronglyDomainBearing,
  looksMutating,
  splitIdentifier,
  strongDomainTokensAcross,
  strongDomainTokensIn,
} from "./vocabulary.js";

describe("splitIdentifier", () => {
  it("splits camelCase, snake_case, and dotted paths into lowercase words", () => {
    expect(splitIdentifier("billingPlanTier")).toEqual(["billing", "plan", "tier"]);
    expect(splitIdentifier("user_role_id")).toEqual(["user", "role", "id"]);
    expect(splitIdentifier("ctx.session.user.role")).toEqual([
      "ctx",
      "session",
      "user",
      "role",
    ]);
  });

  it("keeps consecutive capitals together", () => {
    expect(splitIdentifier("ACLEntry")).toEqual(["acl", "entry"]);
    expect(splitIdentifier("parseHTTPResponse")).toEqual(["parse", "http", "response"]);
  });

  it("returns nothing for an empty name", () => {
    expect(splitIdentifier("")).toEqual([]);
  });
});

describe("domain token matching", () => {
  it("matches whole words, never substrings", () => {
    // The substring trap: `rolled`, `planet`, `statusquo` must not match.
    expect(domainTokensIn("rolledBack")).toEqual([]);
    expect(domainTokensIn("planetScale")).toEqual([]);
    expect(domainTokensIn("userRole")).toEqual(["user", "role"]);
  });

  it("deduplicates and preserves first-appearance order", () => {
    expect(domainTokensIn("rolePermissionRole")).toEqual(["role", "permission"]);
  });

  it("names the concept family", () => {
    expect(conceptsIn("userRole")).toContain("authorization");
    expect(conceptsIn("billingPlan")).toContain("billing");
    expect(conceptsIn("tenantId")).toContain("tenancy");
    expect(conceptsIn("retryCount")).toEqual([]);
  });

  it("aggregates across a collection of names, sorted", () => {
    expect(domainTokensAcross(["user.role", "order.status", "n"])).toEqual([
      "role",
      "status",
      "user",
    ]);
  });
});

describe("the strong tier", () => {
  /**
   * The whole point of the strong tier is that generic programming
   * vocabulary cannot reach a gated detector. These are the exact words
   * that produced 188 false positives before the tier existed.
   */
  it("rejects general programming vocabulary that the broad tier accepts", () => {
    for (const name of [
      "items.length",
      "retryCount",
      "bufferState",
      "isValid",
      "flagEnabled",
    ]) {
      expect(strongDomainTokensIn(name), name).toEqual([]);
    }
    // `state`, `valid`, and `flag` are in the broad catalogue on purpose —
    // they are useful for raising confidence, just not for gating.
    expect(isDomainBearing("bufferState")).toBe(true);
    expect(isStronglyDomainBearing("bufferState")).toBe(false);
  });

  it("accepts unambiguously-business vocabulary", () => {
    expect(strongDomainTokensIn("user.role")).toEqual(["role"]);
    expect(strongDomainTokensIn("subscription.tier")).toEqual(["subscription", "tier"]);
    expect(strongDomainTokensIn("order.status")).toEqual(["status"]);
    expect(strongDomainTokensIn("workspace.entitlements")).toEqual([
      "workspace",
      "entitlements",
    ]);
  });

  it("is a strict subset of the broad tier", () => {
    for (const name of ["role", "permission", "plan", "tenant", "status", "invoice"]) {
      expect(isStronglyDomainBearing(name), name).toBe(true);
      expect(isDomainBearing(name), name).toBe(true);
    }
  });

  it("aggregates and sorts across names", () => {
    expect(strongDomainTokensAcross(["user.role", "n.length", "plan"])).toEqual([
      "plan",
      "role",
    ]);
  });
});

describe("critical fields", () => {
  it("recognises identifier, timestamp, money, tenancy, permission, and status fields", () => {
    expect(criticalFieldReason("userId")).toBe("identifier field");
    expect(criticalFieldReason("uuid")).toBe("identifier field");
    expect(criticalFieldReason("createdAt")).toBe("timestamp field");
    expect(criticalFieldReason("totalAmount")).toBe("money field");
    expect(criticalFieldReason("tenantSlug")).toBe("tenancy field");
    expect(criticalFieldReason("permissions")).toBe("permission field");
    expect(criticalFieldReason("status")).toBe("status field");
  });

  it("leaves ordinary fields alone", () => {
    expect(criticalFieldReason("displayName")).toBeUndefined();
    expect(criticalFieldReason("avatarUrl")).toBeUndefined();
    expect(isCriticalField("nickname")).toBe(false);
  });

  it("resolves a fixed category order so the reason is deterministic", () => {
    // `tenantId` is both an identifier and a tenancy field; identifier
    // wins because the `id` suffix is checked first, and it must win the
    // same way on every run.
    expect(criticalFieldReason("tenantId")).toBe("identifier field");
    expect(criticalFieldReason("tenantId")).toBe(criticalFieldReason("tenantId"));
  });
});

describe("boundary classification", () => {
  it("names the most consequential boundary an expression touches", () => {
    expect(classifyBoundary("stripe.charges.create")?.id).toBe("payment");
    expect(classifyBoundary("db.orders.insert")?.id).toBe("persistence");
    expect(classifyBoundary("queue.publish")?.id).toBe("queue");
    expect(classifyBoundary("fs.writeFile")?.id).toBe("filesystem");
  });

  it("prefers payment over persistence when both appear", () => {
    // Ordering is fixed in RISKY_BOUNDARIES so the answer never depends
    // on which token happened to be scanned first.
    const boundary = classifyBoundary("db.stripeCharges.insert");
    expect(boundary?.id).toBe("payment");
  });

  it("returns nothing for plumbing", () => {
    expect(classifyBoundary("array.map")).toBeUndefined();
    expect(classifyBoundary("formatDate")).toBeUndefined();
  });

  it("matches on whole words so a substring cannot trigger it", () => {
    expect(classifyBoundary("authorship")).toBeUndefined();
    expect(classifyBoundary("dbschema")).toBeUndefined();
  });
});

describe("looksMutating", () => {
  it("recognises write-shaped call names", () => {
    expect(looksMutating("db.orders.insert")).toBe(true);
    expect(looksMutating("queue.publish")).toBe(true);
    expect(looksMutating("chargeCustomer")).toBe(true);
  });

  it("treats read-shaped names as non-mutating", () => {
    expect(looksMutating("db.orders.findMany")).toBe(false);
    expect(looksMutating("getUser")).toBe(false);
  });
});
