import { describe, expect, it } from "vitest";
import {
  JS_EXTENSIONS,
  registerPackExtensions,
  resolveLanguagePackRouter,
} from "./language-pack-router.js";

describe("LanguagePackRouter", () => {
  it("claims TS/JS extensions for language-js by default", () => {
    const router = resolveLanguagePackRouter();
    for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".cts", ".mts"]) {
      expect(router.claims("language-js", `/x/file${ext}`)).toBe(true);
    }
  });

  it("returns false for unclaimed extensions", () => {
    const router = resolveLanguagePackRouter();
    for (const ext of [".rs", ".go", ".py", ".rb", ".md", ".json", ""]) {
      expect(router.claims("language-js", `/x/file${ext}`)).toBe(false);
    }
  });

  it("returns the claiming pack id for any extension", () => {
    const router = resolveLanguagePackRouter();
    expect(router.claimingPack("/x/file.ts")).toBe("language-js");
    expect(router.claimingPack("/x/file.rs")).toBeUndefined();
  });

  it("registerPackExtensions adds extensions to a pack", () => {
    registerPackExtensions("language-py", [".py", ".pyi"]);
    const router = resolveLanguagePackRouter();
    expect(router.claims("language-py", "/x/file.py")).toBe(true);
    expect(router.claimingPack("/x/file.py")).toBe("language-py");
  });

  it("reports registered language packs, never the universal pack", () => {
    // Coverage derives `packs_loaded` from this, so the universal pack
    // must stay absent here — it claims every file and registers no
    // extensions. Callers add it back explicitly.
    const packs = resolveLanguagePackRouter().registeredPacks();
    expect(packs).toContain("language-js");
    expect(packs).not.toContain("universal");
  });

  it("exports JS_EXTENSIONS for use by other modules", () => {
    expect(JS_EXTENSIONS).toContain(".ts");
    expect(JS_EXTENSIONS).toContain(".tsx");
    expect(JS_EXTENSIONS).toContain(".mjs");
  });
});
