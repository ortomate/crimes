import { describe, expect, it } from "vitest";
import {
  normaliseTokens,
  splitTokens,
  stripRepoPrefix,
  tokenise,
  tokenisePath,
} from "./tokenise.js";

describe("splitTokens", () => {
  it("splits on path separators", () => {
    expect(splitTokens("a/b/c")).toEqual(["a", "b", "c"]);
  });

  it("splits camelCase", () => {
    expect(splitTokens("pricingPage")).toEqual(["pricing", "page"]);
  });

  it("splits PascalCase", () => {
    expect(splitTokens("PricingPage")).toEqual(["pricing", "page"]);
  });

  it("splits acronyms followed by a word", () => {
    expect(splitTokens("APIToken")).toEqual(["api", "token"]);
  });

  it("splits kebab-case and snake_case", () => {
    expect(splitTokens("my-cool_thing")).toEqual(["my", "cool", "thing"]);
  });

  it("separates digits from letters", () => {
    expect(splitTokens("billingV2")).toEqual(["billing", "v", "2"]);
  });

  it("returns [] for empty input", () => {
    expect(splitTokens("")).toEqual([]);
  });
});

describe("normaliseTokens", () => {
  it("filters stop words", () => {
    expect(normaliseTokens(["pages", "settings", "billing"])).toEqual(["billing"]);
  });

  it("singularises whitelisted plurals", () => {
    expect(normaliseTokens(["teams", "users", "plans"])).toEqual([
      "team",
      "user",
      "plan",
    ]);
  });

  it("does NOT singularise unknown plurals", () => {
    expect(normaliseTokens(["foos"])).toEqual(["foos"]);
  });

  it("drops single-character tokens", () => {
    expect(normaliseTokens(["a", "billing"])).toEqual(["billing"]);
  });
});

describe("tokenise", () => {
  it("dedupes repeated tokens", () => {
    expect(tokenise("billing/billing/Billing")).toEqual(["billing"]);
  });

  it("composes split + normalise", () => {
    expect(tokenise("src/settings/teams")).toEqual(["team"]);
  });
});

describe("stripRepoPrefix", () => {
  it("strips src/", () => {
    expect(stripRepoPrefix("src/billing.ts")).toBe("billing.ts");
  });

  it("strips packages/<x>/src/", () => {
    expect(stripRepoPrefix("packages/cli/src/index.ts")).toBe("index.ts");
  });

  it("strips apps/<x>/src/", () => {
    expect(stripRepoPrefix("apps/website/src/page.tsx")).toBe("page.tsx");
  });

  it("does not strip arbitrary first segments", () => {
    expect(stripRepoPrefix("foo/bar.ts")).toBe("foo/bar.ts");
  });
});

describe("tokenisePath", () => {
  it("strips extensions and conventional terminals", () => {
    expect(tokenisePath("src/routes/settings/billing/index.tsx")).toEqual(["billing"]);
  });

  it("captures meaningful path tokens", () => {
    expect(tokenisePath("src/team/permissions.ts")).toEqual(["team", "permission"]);
  });

  it("handles markdown paths", () => {
    expect(tokenisePath("docs/agent-usage.md")).toEqual(["docs", "agent", "usage"]);
  });
});
