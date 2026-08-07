import { describe, expect, it } from "vitest";
import {
  classifyScope,
  isNeverReportable,
  isProductionScope,
  looksGeneratedSource,
  looksMinifiedSource,
  scopeConfidenceMultiplier,
} from "./scope-class.js";

describe("classifyScope", () => {
  it("recognises generated paths", () => {
    expect(classifyScope("src/__generated__/schema.ts")).toBe("generated");
    expect(classifyScope("src/api.generated.ts")).toBe("generated");
    expect(classifyScope("src/gql/generated/types.ts")).toBe("generated");
  });

  it("recognises vendored code", () => {
    expect(classifyScope("vendor/lodash/index.js")).toBe("vendored");
    expect(classifyScope("third_party/lib.ts")).toBe("vendored");
    // `_vendor/` is the Python convention — pip ships `pip/_vendor/`,
    // setuptools `setuptools/_vendor/`, and airflow
    // `providers/google/src/airflow/providers/google/_vendor/`, which
    // airflow's own ruff config excludes as `*/_vendor/*`. The leading
    // underscore meant none of them matched.
    expect(classifyScope("pip/_vendor/requests/api.py")).toBe("vendored");
    expect(
      classifyScope(
        "providers/google/src/airflow/providers/google/_vendor/json_merge_patch.py",
      ),
    ).toBe("vendored");
    expect(classifyScope("src/.vendor/lib.py")).toBe("vendored");
    // Not every leading underscore is a vendor tree.
    expect(classifyScope("src/_internal/thing.py")).toBe("production");
  });

  it("recognises migrations, including the timestamped file form", () => {
    expect(classifyScope("db/migrations/001_users.ts")).toBe("migration");
    expect(classifyScope("prisma/migrations/x/migration.ts")).toBe("migration");
    expect(classifyScope("src/20240102_add_roles.ts")).toBe("migration");
  });

  it("recognises fixtures, snapshots, and examples", () => {
    expect(classifyScope("test/fixtures/user.ts")).toBe("fixture");
    expect(classifyScope("src/__snapshots__/a.snap")).toBe("fixture");
    expect(classifyScope("examples/messy-ts-app/src/a.ts")).toBe("fixture");
  });

  it("recognises tests and config after the earlier categories", () => {
    expect(classifyScope("src/billing.test.ts")).toBe("test");
    expect(classifyScope("src/__tests__/billing.ts")).toBe("test");
    expect(classifyScope("vitest.config.ts")).toBe("config");
  });

  it("treats everything else as production", () => {
    expect(classifyScope("src/services/billing.ts")).toBe("production");
    expect(isProductionScope("packages/core/src/scan.ts")).toBe(true);
  });

  it("applies a fixed precedence so one path yields one answer", () => {
    // Generated wins over test; vendored wins over migration. Without a
    // fixed order two detectors could classify the same file differently.
    expect(classifyScope("src/__generated__/api.test.ts")).toBe("generated");
    expect(classifyScope("vendor/pkg/migrations/001.ts")).toBe("vendored");
  });

  it("normalises Windows-style separators", () => {
    expect(classifyScope("src\\__generated__\\schema.ts")).toBe("generated");
    expect(classifyScope("test\\fixtures\\user.ts")).toBe("fixture");
    expect(classifyScope("src\\billing.test.ts")).toBe("test");
  });
});

describe("classifyScope — shapes found in the corpus", () => {
  it("recognises protobuf output", () => {
    expect(classifyScope("proto/events_pb2.py")).toBe("generated");
    expect(classifyScope("proto/events_pb2_grpc.py")).toBe("generated");
    expect(classifyScope("proto/events_pb2.pyi")).toBe("generated");
  });

  it("recognises minified bundles as vendored", () => {
    // drf checks in google-code-prettify under `static/`, which no
    // vendor-directory rule catches: `prettify-min.js` and
    // `prettify-1.0.js`.
    expect(classifyScope("rest_framework/static/rest_framework/js/prettify-min.js")).toBe(
      "vendored",
    );
    expect(classifyScope("docs/theme/js/jquery.min.js")).toBe("vendored");
    expect(classifyScope("assets/app.min.css")).toBe("vendored");
  });

  it("does not mistake an ordinary file for a minified one", () => {
    expect(classifyScope("src/admin.js")).toBe("production");
    expect(classifyScope("src/terminal.ts")).toBe("production");
  });
});

describe("looksMinifiedSource", () => {
  it("recognises a bundle whose newlines were stripped", () => {
    const minified = `var q=null;${"a".repeat(900)}`;
    expect(looksMinifiedSource(minified)).toBe(true);
  });

  it("does not flag ordinary source at this repo's 90-column width", () => {
    const source = Array.from({ length: 200 }, (_, i) => `  const v${i} = ${i};`).join(
      "\n",
    );
    expect(looksMinifiedSource(source)).toBe(false);
  });

  it("does not flag an empty file", () => {
    expect(looksMinifiedSource("")).toBe(false);
  });
});

describe("reportability", () => {
  it("never reports generated or vendored code", () => {
    expect(isNeverReportable("src/__generated__/a.ts")).toBe(true);
    expect(isNeverReportable("vendor/a.ts")).toBe(true);
    expect(isNeverReportable("src/a.ts")).toBe(false);
  });

  it("zeroes confidence for scopes that must never be reported", () => {
    expect(scopeConfidenceMultiplier("src/__generated__/a.ts")).toBe(0);
    expect(scopeConfidenceMultiplier("vendor/a.ts")).toBe(0);
  });

  it("damps but does not zero fixtures and migrations", () => {
    expect(scopeConfidenceMultiplier("test/fixtures/a.ts")).toBeGreaterThan(0);
    expect(scopeConfidenceMultiplier("test/fixtures/a.ts")).toBeLessThan(1);
    expect(scopeConfidenceMultiplier("db/migrations/a.ts")).toBeLessThan(
      scopeConfidenceMultiplier("test/fixtures/a.ts"),
    );
  });

  it("leaves production confidence unchanged", () => {
    expect(scopeConfidenceMultiplier("src/a.ts")).toBe(1);
  });
});

describe("looksGeneratedSource", () => {
  it("recognises the common banner conventions", () => {
    expect(looksGeneratedSource("/** @generated */\nexport const a = 1;")).toBe(true);
    expect(
      looksGeneratedSource("// Code generated by protoc-gen-ts. DO NOT EDIT.\n"),
    ).toBe(true);
    expect(looksGeneratedSource("// AUTO-GENERATED FILE\n")).toBe(true);
    expect(looksGeneratedSource("/* DO NOT EDIT THIS FILE */\n")).toBe(true);
  });

  it("only inspects the head of the file", () => {
    const body = `${"const x = 1;\n".repeat(200)}// @generated\n`;
    expect(looksGeneratedSource(body)).toBe(false);
  });

  it("does not match ordinary source", () => {
    expect(looksGeneratedSource("export function generate() { return 1; }")).toBe(false);
  });
});
