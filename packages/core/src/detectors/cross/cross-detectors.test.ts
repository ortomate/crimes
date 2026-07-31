import { parseFile } from "@crimes/language-js";
import { parsePyFile } from "@crimes/language-py";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../config.js";
import type {
  CrossLanguageDetector,
  CrossLanguageDetectorContext,
  PackedFile,
} from "../../detector.js";
import type { PreFinding } from "../../finding.js";
import type { IaConceptAliasGroup, IaIndex } from "../../ia/types.js";
import {
  crossLanguageConceptAliasDriftDetector,
  crossLanguageDetectors,
  crossLanguageRouteDriftDetector,
  crossLanguageTypeDriftDetector,
} from "./index.js";
import { normalisePath } from "./route-drift.js";

/** Build a cross-language context from `{ path: source }` pairs. */
async function ctxFor(
  sources: Record<string, string>,
  aliasGroups: IaConceptAliasGroup[] = [],
): Promise<CrossLanguageDetectorContext> {
  const files: PackedFile[] = [];
  for (const [file, source] of Object.entries(sources)) {
    const absolutePath = `/repo/${file}`;
    if (file.endsWith(".py")) {
      files.push({
        pack: "language-py",
        file,
        absolutePath,
        parsed: await parsePyFile({ absolutePath, source }),
      });
    } else {
      files.push({
        pack: "language-js",
        file,
        absolutePath,
        parsed: parseFile({ absolutePath, source }),
      });
    }
  }
  files.sort((a, b) => a.file.localeCompare(b.file));

  const ia = {
    root: "/repo",
    files: {},
    routes: [],
    navSources: [],
    docs: [],
    aliasGroups,
  } as unknown as IaIndex;

  return {
    kind: "cross-language",
    root: "/repo",
    files,
    config: DEFAULT_CONFIG,
    ia,
  };
}

async function run(
  detector: CrossLanguageDetector,
  sources: Record<string, string>,
  aliasGroups: IaConceptAliasGroup[] = [],
): Promise<PreFinding[]> {
  return detector.run(await ctxFor(sources, aliasGroups));
}

describe("normalisePath", () => {
  it("treats every framework's path-parameter syntax as equivalent", () => {
    const forms = [
      "/api/users/{user_id}",
      "/api/users/<int:user_id>",
      "/api/users/:userId",
      "/api/users/${userId}",
    ];
    const normalised = forms.map(normalisePath);
    expect(new Set(normalised).size).toBe(1);
  });

  it("ignores a trailing slash and case", () => {
    expect(normalisePath("/API/Users/")).toBe(normalisePath("/api/users"));
  });

  it("keeps genuinely different paths different", () => {
    expect(normalisePath("/api/users")).not.toBe(normalisePath("/api/teams"));
  });
});

describe("cross_language_route_drift", () => {
  const backend = `
@app.get("/api/users")
def list_users():
    return []

@app.post("/api/invoices")
def create_invoice():
    return {}
`;

  it("flags a frontend call with no backend route", async () => {
    const found = await run(crossLanguageRouteDriftDetector, {
      "api/routes.py": backend,
      "src/client.ts": `await fetch("/api/teams");`,
    });
    expect(found).toHaveLength(1);
    expect(found[0]!.type).toBe("cross_language_route_drift");
    expect(found[0]!.evidence.join(" ")).toMatch(/\/api\/teams/);
  });

  it("stays quiet when every call matches a route", async () => {
    expect(
      await run(crossLanguageRouteDriftDetector, {
        "api/routes.py": backend,
        "src/client.ts": `
          await fetch("/api/users");
          await fetch("/api/invoices", { method: "POST" });
        `,
      }),
    ).toEqual([]);
  });

  it("matches across path-parameter syntaxes", async () => {
    expect(
      await run(crossLanguageRouteDriftDetector, {
        "api/routes.py": `
@app.get("/api/users/{user_id}")
def get_user(user_id):
    return {}

@app.get("/api/other")
def other():
    return {}
`,
        "src/client.ts": 'await fetch("/api/users/:id");',
      }),
    ).toEqual([]);
  });

  it("flags a method mismatch separately from a missing path", async () => {
    const found = await run(crossLanguageRouteDriftDetector, {
      "api/routes.py": backend,
      "src/client.ts": `await fetch("/api/users", { method: "DELETE" });`,
    });
    expect(found).toHaveLength(1);
    expect(found[0]!.summary).toMatch(/405/);
    expect(found[0]!.evidence.join(" ")).toMatch(/methods declared: GET/);
  });

  it("treats @app.route as matching any method", async () => {
    expect(
      await run(crossLanguageRouteDriftDetector, {
        "api/routes.py": `
@app.route("/api/thing")
def thing():
    return {}
`,
        "src/client.ts": `await fetch("/api/thing", { method: "PUT" });`,
      }),
    ).toEqual([]);
  });

  it("never fires one-sided", async () => {
    // A JS-only repo would otherwise report every fetch as orphaned.
    expect(
      await run(crossLanguageRouteDriftDetector, {
        "src/client.ts": `await fetch("/api/anything");`,
      }),
    ).toEqual([]);
    expect(
      await run(crossLanguageRouteDriftDetector, {
        "api/routes.py": backend,
      }),
    ).toEqual([]);
  });

  it("groups all orphaned calls into one finding", async () => {
    const found = await run(crossLanguageRouteDriftDetector, {
      "api/routes.py": backend,
      "src/client.ts": `
        await fetch("/api/a");
        await fetch("/api/b");
        await fetch("/api/c");
      `,
    });
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe("high");
  });
});

describe("cross_language_type_drift", () => {
  it("flags an Enum and a union that diverged", async () => {
    const found = await run(crossLanguageTypeDriftDetector, {
      "api/models.py": `
class Plan(str, Enum):
    FREE = "free"
    PRO = "pro"
    TEAM = "team"
`,
      "src/types.ts": `export type Plan = "free" | "pro" | "enterprise";`,
    });
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe("high");
    const ev = found[0]!.evidence.join(" ");
    expect(ev).toMatch(/only in Python: team/);
    expect(ev).toMatch(/only in TypeScript: enterprise/);
  });

  it("rates a one-directional gap medium", async () => {
    const found = await run(crossLanguageTypeDriftDetector, {
      "api/models.py": `
class Plan(str, Enum):
    FREE = "free"
    PRO = "pro"
    TEAM = "team"
`,
      "src/types.ts": `export type Plan = "free" | "pro";`,
    });
    expect(found[0]!.severity).toBe("medium");
  });

  it("stays quiet when the two agree", async () => {
    expect(
      await run(crossLanguageTypeDriftDetector, {
        "api/models.py": `
class Plan(str, Enum):
    FREE = "free"
    PRO = "pro"
`,
        "src/types.ts": `export type Plan = "free" | "pro";`,
      }),
    ).toEqual([]);
  });

  it("does not pair same-named sets with no overlap", async () => {
    // Two unrelated `Status` types are different concepts, not drift.
    expect(
      await run(crossLanguageTypeDriftDetector, {
        "api/models.py": `
class Status(str, Enum):
    SHIPPED = "shipped"
    RETURNED = "returned"
`,
        "src/types.ts": `export type Status = "online" | "offline";`,
      }),
    ).toEqual([]);
  });

  it("ignores classes that are not closed sets", async () => {
    expect(
      await run(crossLanguageTypeDriftDetector, {
        "api/models.py": `
class Config:
    NAME = "svc"
    RETRIES = 3
`,
        "src/types.ts": `export type Config = "a" | "b";`,
      }),
    ).toEqual([]);
  });

  it("never fires one-sided", async () => {
    expect(
      await run(crossLanguageTypeDriftDetector, {
        "src/types.ts": `export type Plan = "free" | "pro";`,
      }),
    ).toEqual([]);
  });
});

describe("cross_language_concept_alias_drift", () => {
  const GROUPS: IaConceptAliasGroup[] = [
    { id: "team", aliases: ["team", "workspace", "organisation"], preferred: "team" },
  ];

  it("flags a concept named differently in each language", async () => {
    const found = await run(
      crossLanguageConceptAliasDriftDetector,
      {
        "api/team_service.py": `
class TeamService:
    """Operations on a team."""
    def list_teams(self):
        return []
`,
        "src/WorkspaceProvider.ts": `
          export function WorkspaceProvider() { return null; }
          export function useWorkspace() { return null; }
        `,
      },
      GROUPS,
    );
    expect(found).toHaveLength(1);
    const ev = found[0]!.evidence.join(" ");
    expect(ev).toMatch(/Python uses: team/);
    expect(ev).toMatch(/TypeScript uses: workspace/);
  });

  it("stays quiet when both languages use the same name", async () => {
    expect(
      await run(
        crossLanguageConceptAliasDriftDetector,
        {
          "api/team_service.py": `
class TeamService:
    def list_teams(self):
        return []
`,
          "src/team.ts": `export function useTeam() { return null; }`,
        },
        GROUPS,
      ),
    ).toEqual([]);
  });

  it("does not match a substring that is not a word", async () => {
    // `steam` must not count as `team`.
    expect(
      await run(
        crossLanguageConceptAliasDriftDetector,
        {
          "api/steam.py": `
class SteamClient:
    def connect(self):
        return None
`,
          "src/WorkspaceProvider.ts": `export function useWorkspace() { return null; }`,
        },
        GROUPS,
      ),
    ).toEqual([]);
  });

  it("never fires one-sided", async () => {
    expect(
      await run(
        crossLanguageConceptAliasDriftDetector,
        { "src/WorkspaceProvider.ts": `export function useWorkspace() {}` },
        GROUPS,
      ),
    ).toEqual([]);
  });

  it("does nothing without alias groups", async () => {
    expect(
      await run(crossLanguageConceptAliasDriftDetector, {
        "api/team_service.py": `class TeamService:\n    pass\n`,
        "src/w.ts": `export function useWorkspace() {}`,
      }),
    ).toEqual([]);
  });
});

describe("cross-language pack contract", () => {
  it("every detector declares the pack and an unqualified id", () => {
    for (const d of crossLanguageDetectors) {
      expect(d.pack).toBe("cross-language");
      // These ids are already unique across packs — no suffix needed.
      expect(d.id).toMatch(/^cross_language_/);
      expect(d.whyItMatters.length).toBeGreaterThan(100);
    }
  });

  it("every emitted finding sets an intrinsic agent_risk and an anchor file", async () => {
    const sources = {
      "api/routes.py": `
@app.get("/api/users")
def list_users():
    return []
`,
      "api/models.py": `
class Plan(str, Enum):
    FREE = "free"
    PRO = "pro"
    TEAM = "team"
`,
      "api/team_service.py": `
class TeamService:
    def list_teams(self):
        return []
`,
      "src/client.ts": `
        await fetch("/api/teams");
        export type Plan = "free" | "pro" | "enterprise";
        export function useWorkspace() { return null; }
      `,
    };
    const groups: IaConceptAliasGroup[] = [
      { id: "team", aliases: ["team", "workspace"], preferred: "team" },
    ];

    let emitted = 0;
    for (const d of crossLanguageDetectors) {
      for (const f of await run(d, sources, groups)) {
        emitted += 1;
        expect(typeof f.scores.agent_risk, `${d.id}`).toBe("number");
        expect(f.scores.agent_risk!).toBeGreaterThan(0);
        // Fingerprints are `<type>::<file>::<symbol>`, so a
        // cross-language finding still needs a real anchor file.
        expect(f.file.length, `${d.id} emitted a finding with no file`).toBeGreaterThan(0);
      }
    }
    // Guard the guard: all three must have fired on this corpus.
    expect(emitted).toBeGreaterThanOrEqual(3);
  });
});
