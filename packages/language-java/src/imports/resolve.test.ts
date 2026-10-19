import { describe, expect, it } from "vitest";
import {
  buildJavaTypeIndex,
  resolveJavaReferences,
  type JavaFileTypesInput,
} from "./resolve.js";

const file = (
  path: string,
  pkg: string,
  types: string[],
  extra: Partial<JavaFileTypesInput> = {},
): JavaFileTypesInput => ({
  file: path,
  packageName: pkg,
  types: types.map((name) => ({ name })),
  imports: [],
  referencedTypes: [],
  ...extra,
});

describe("resolveJavaReferences", () => {
  const film = file("core/om/Film.java", "com.acme.om", ["Film"]);
  const list = file("core/om/List.java", "com.acme.om", ["List"]);
  const service = file("core/svc/FilmService.java", "com.acme.svc", ["FilmService"]);
  const index = buildJavaTypeIndex([film, list, service]);

  it("draws an edge to a same-package type used without an import", () => {
    const review = file("core/om/Review.java", "com.acme.om", ["Review"], {
      referencedTypes: ["Film", "String"],
    });
    expect(resolveJavaReferences(index, review).map((e) => e.to)).toEqual([
      "core/om/Film.java",
    ]);
  });

  it("resolves single-type and on-demand imports", () => {
    const controller = file(
      "web/FilmController.java",
      "com.acme.web",
      ["FilmController"],
      {
        imports: [
          { name: "com.acme.svc.FilmService", static: false, wildcard: false },
          { name: "com.acme.om", static: false, wildcard: true },
          { name: "java.util.Map", static: false, wildcard: false },
        ],
        referencedTypes: ["FilmService", "Film", "Map"],
      },
    );
    const edges = resolveJavaReferences(index, controller);
    expect(edges.filter((e) => !e.external).map((e) => e.to)).toEqual([
      "core/om/Film.java",
      "core/svc/FilmService.java",
    ]);
    expect(edges.find((e) => e.external)?.specifier).toBe("java.util.Map");
  });

  it("lets a single-type import shadow a same-package type of the same name", () => {
    const review = file("core/om/Review.java", "com.acme.om", ["Review"], {
      imports: [{ name: "java.util.List", static: false, wildcard: false }],
      referencedTypes: ["List"],
    });
    const edges = resolveJavaReferences(index, review);
    expect(edges.some((e) => e.to === "core/om/List.java")).toBe(false);
  });

  it("resolves a static import to the type that declares the member", () => {
    const t = file("core/om/FilmTest.java", "com.acme.other", ["FilmTest"], {
      imports: [{ name: "com.acme.om.Film.of", static: true, wildcard: false }],
    });
    expect(resolveJavaReferences(index, t).map((e) => e.to)).toEqual([
      "core/om/Film.java",
    ]);
  });

  it("never draws an edge from a file to itself", () => {
    const self = file("core/om/Film.java", "com.acme.om", ["Film"], {
      referencedTypes: ["Film"],
    });
    expect(resolveJavaReferences(index, self)).toEqual([]);
  });
});
