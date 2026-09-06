import { describe, expect, it } from "vitest";
import type { EnclosingFunction, FunctionShape, SyncIoCall } from "@crimes/language-js";
import { DEFAULT_CONFIG } from "../config.js";
import type { LanguageJsDetectorContext } from "../detector.js";
import { syncIoInHotpathDetector } from "./sync-io-in-hotpath.js";

function encl(
  shape: FunctionShape,
  name: string | undefined = undefined,
  startLine = 1,
  endLine = 10,
): EnclosingFunction {
  const entry: EnclosingFunction = { shape, startLine, endLine };
  if (name !== undefined) entry.name = name;
  return entry;
}

function call(
  method: string,
  enclosingFunctions: EnclosingFunction[],
  line = 5,
): SyncIoCall {
  return {
    callee: `fs.${method}`,
    receiver: "fs",
    method,
    line,
    enclosingFunctions,
  };
}

function makeCtx(
  syncIoCalls: SyncIoCall[],
  overrides: { file?: string } = {},
): LanguageJsDetectorContext {
  return {
    kind: "language-js",
    file: overrides.file ?? "src/handler.ts",
    absolutePath: "/tmp/handler.ts",
    source: "",
    parsed: {
      lineCount: 50,
      functions: [],
      dateNowOrNewDateUses: [],
      syncIoCalls,
    },
    config: DEFAULT_CONFIG,
  };
}

describe("syncIoInHotpathDetector", () => {
  it("returns nothing on a clean file", async () => {
    const findings = await syncIoInHotpathDetector.run(makeCtx([]));
    expect(findings).toEqual([]);
  });

  it("flags readFileSync inside a route handler", async () => {
    const findings = await syncIoInHotpathDetector.run(
      makeCtx([call("readFileSync", [encl("route_handler", "GET", 2, 8)], 5)]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.type).toBe("sync_io_in_hotpath");
    expect(findings[0]!.charge).toBe("Sync I/O in Hot Path");
    expect(findings[0]!.severity).toBe("medium");
    const evidence = findings[0]!.evidence.join(" ");
    expect(evidence).toContain("`fs.readFileSync`");
    expect(evidence).toContain("`GET`");
    expect(evidence).toContain("route handler");
  });

  it("upgrades to high when multiple sync calls hit a request surface", async () => {
    const findings = await syncIoInHotpathDetector.run(
      makeCtx([
        call("readFileSync", [encl("route_handler", "GET", 1, 30)], 5),
        call("writeFileSync", [encl("route_handler", "GET", 1, 30)], 12),
      ]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("high");
  });

  it("flags sync I/O inside React components and page exports", async () => {
    const compFindings = await syncIoInHotpathDetector.run(
      makeCtx([call("readFileSync", [encl("react_component", "Profile")])]),
    );
    expect(compFindings).toHaveLength(1);
    expect(compFindings[0]!.severity).toBe("medium");

    const pageFindings = await syncIoInHotpathDetector.run(
      makeCtx([call("existsSync", [encl("page_export", "Page")])]),
    );
    expect(pageFindings).toHaveLength(1);
  });

  it("does not infer a hot path from a plain domain function, even with many calls", async () => {
    const findings = await syncIoInHotpathDetector.run(
      makeCtx([
        call("readFileSync", [encl("domain", "loadConfig")], 5),
        call("readFileSync", [encl("domain", "loadConfig")], 6),
        call("readFileSync", [encl("domain", "loadConfig")], 7),
        call("readFileSync", [encl("domain", "loadConfig")], 8),
      ]),
    );
    expect(findings).toEqual([]);
  });

  it("skips calls inside test_callback ancestors anywhere in the chain", async () => {
    const findings = await syncIoInHotpathDetector.run(
      makeCtx([call("readFileSync", [encl("unknown"), encl("test_callback")])]),
    );
    expect(findings).toEqual([]);
  });

  it("skips calls inside cli_command_registrar ancestors", async () => {
    const findings = await syncIoInHotpathDetector.run(
      makeCtx([call("readFileSync", [encl("cli_command_registrar", "action")])]),
    );
    expect(findings).toEqual([]);
  });

  it("skips top-level sync I/O (no enclosing function)", async () => {
    const findings = await syncIoInHotpathDetector.run(
      makeCtx([call("readFileSync", [])]),
    );
    expect(findings).toEqual([]);
  });

  it("skips calls whose only enclosing shape is `unknown`", async () => {
    const findings = await syncIoInHotpathDetector.run(
      makeCtx([call("readFileSync", [encl("unknown")])]),
    );
    expect(findings).toEqual([]);
  });

  it("does not infer a hot path from a callback inside an ordinary function", async () => {
    const findings = await syncIoInHotpathDetector.run(
      makeCtx([call("readFileSync", [encl("unknown"), encl("domain", "loadAll")])]),
    );
    expect(findings).toEqual([]);
  });

  it("skips test files entirely", async () => {
    const findings = await syncIoInHotpathDetector.run(
      makeCtx([call("readFileSync", [encl("route_handler", "GET")])], {
        file: "src/handler.test.ts",
      }),
    );
    expect(findings).toEqual([]);
  });

  it("emits one file-level finding aggregating all violating calls", async () => {
    const findings = await syncIoInHotpathDetector.run(
      makeCtx([
        call("readFileSync", [encl("route_handler", "GET")], 5),
        call("statSync", [encl("route_handler", "GET")], 7),
        call("writeFileSync", [encl("route_handler", "GET")], 9),
        call("existsSync", [encl("route_handler", "GET")], 11),
      ]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.lines).toEqual([5, 11]);
  });
});
