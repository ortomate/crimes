import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import type { UniversalDetectorContext } from "../detector.js";
import { commentedOutCodeUniversalDetector } from "./commented-out-code-universal.js";

function makeCtx(file: string, source: string): UniversalDetectorContext {
  return {
    kind: "universal",
    file,
    absolutePath: `/tmp/${file}`,
    extension: file.match(/\.[^./]+$/)?.[0] ?? "",
    byteSize: source.length,
    readSource: async () => source,
    get lineCount() {
      return source.split("\n").length;
    },
    config: DEFAULT_CONFIG,
  };
}

describe("commentedOutCodeUniversalDetector", () => {
  it("skips JS files (the AST variant handles those)", async () => {
    const findings = await commentedOutCodeUniversalDetector.run(
      makeCtx(
        "src/x.ts",
        "// const x = 1;\n// const y = 2;\n// const z = 3;\n// const a = 4;",
      ),
    );
    expect(findings).toEqual([]);
  });

  it("fires on a .py file with multiple consecutive `# def`-shaped comments", async () => {
    const findings = await commentedOutCodeUniversalDetector.run(
      makeCtx(
        "src/x.py",
        [
          "# def old_function(x):",
          "#     return x + 1",
          "# def helper():",
          "#     pass",
          "active_code = 1",
        ].join("\n"),
      ),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.type).toBe("commented_out_code");
  });

  it("does not fire on prose comments", async () => {
    const findings = await commentedOutCodeUniversalDetector.run(
      makeCtx(
        "src/notes.py",
        [
          "# This module handles user authentication.",
          "# It exposes a single function `login`.",
          "# See ADR-007 for the full design.",
          "def login(): pass",
        ].join("\n"),
      ),
    );
    expect(findings).toEqual([]);
  });

  it("does not flag an Apache licence header", async () => {
    // 41% of airflow's entire report was this block. It matched because
    // three English prepositions — "for additional information", "may
    // not use this file", "the License for the specific language" — were
    // on the bare-word code-token list.
    const findings = await commentedOutCodeUniversalDetector.run(
      makeCtx(
        "airflow/config.py",
        [
          "# Licensed to the Apache Software Foundation (ASF) under one",
          "# or more contributor license agreements.  See the NOTICE file",
          "# distributed with this work for additional information",
          "# regarding copyright ownership.  The ASF licenses this file",
          "# to you under the Apache License, Version 2.0 (the",
          '# "License"); you may not use this file except in compliance',
          "# with the License.  You may obtain a copy of the License at",
          "#",
          "#   http://www.apache.org/licenses/LICENSE-2.0",
          "#",
          "# Unless required by applicable law or agreed to in writing,",
          "# software distributed under the License is distributed on an",
          '# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY',
          "# KIND, either express or implied.  See the License for the",
          "# specific language governing permissions and limitations",
          "# under the License.",
          "from __future__ import annotations",
        ].join("\n"),
      ),
    );
    expect(findings).toEqual([]);
  });

  it("does not flag prose that merely contains keywords", async () => {
    // `use`, `for`, `if`, `match`, `class` and `return` are ordinary
    // English. Presence of the word is not evidence of code.
    const findings = await commentedOutCodeUniversalDetector.run(
      makeCtx(
        "src/notes.py",
        [
          "# Use this helper for the common case; it will match whichever",
          "# class of request arrives first and return the cached value.",
          "# If the cache is cold we fall back to the slow path, which is",
          "# fine for the volumes we see while the import job is running.",
          "# See the design note for the reasoning behind that trade-off.",
          "def go(): pass",
        ].join("\n"),
      ),
    );
    expect(findings).toEqual([]);
  });

  it("does not flag Rust doc comments", async () => {
    // `///` and `//!` are documentation, not disabled code — and their
    // examples are full of `use` and `fn` by construction.
    const findings = await commentedOutCodeUniversalDetector.run(
      makeCtx(
        "src/lib.rs",
        [
          "/// Parses a config file.",
          "///",
          "/// ```",
          "/// use crimes::parse;",
          '/// let cfg = parse("x = 1");',
          "/// assert!(cfg.is_ok());",
          "/// ```",
          "pub fn parse(s: &str) {}",
        ].join("\n"),
      ),
    );
    expect(findings).toEqual([]);
  });

  it("fires on a .rs file with bracketed commented code", async () => {
    const findings = await commentedOutCodeUniversalDetector.run(
      makeCtx(
        "src/x.rs",
        [
          "// fn old() -> i32 {",
          "//   return 42;",
          "// }",
          "// let unused = 1;",
          "fn current() {}",
        ].join("\n"),
      ),
    );
    expect(findings).toHaveLength(1);
  });
});

describe("commented_out_code (universal) — fingerprint uniqueness", () => {
  // The language-js twin has carried a block-text hash as its
  // discriminator since 0.17.0; this variant never got one, so every
  // block in a Python or Go file shared `commented_out_code::<file>::`
  // and `crimes ignore` on one silenced the rest. Measured: 18 of
  // airflow's 184 colliding findings and 21 of zulip's 39 —
  // `zproject/prod_settings_template.py` alone carries 18 blocks under
  // one fingerprint.
  const block = (n: number) =>
    [
      `# def old_${n}(x):`,
      `#     y = x + ${n}`,
      `#     return helper_${n}(y)`,
      `# result_${n} = old_${n}(1)`,
    ].join("\n");

  it("separates two blocks in one file", async () => {
    const source = [block(1), "active = 1", "", block(2), "more = 2"].join("\n");
    const findings = await commentedOutCodeUniversalDetector.run(
      makeCtx("src/settings.py", source),
    );
    expect(findings).toHaveLength(2);
    const discriminators = findings.map((f) => f.discriminator);
    expect(discriminators.every((d) => typeof d === "string" && d.length > 0)).toBe(true);
    expect(new Set(discriminators).size).toBe(2);
  });

  // **Reversed in `0.25.0`, deliberately.** This used to assert that a
  // lone block keeps an empty discriminator, on the `0.22.0` reasoning
  // that a file with one block was never ambiguous so its fingerprint
  // must not move. That reasoning holds only for a tree that never
  // changes. Discarding the candidate hash makes a finding's identity a
  // function of how many *neighbours* it has, so a second block
  // appearing anywhere in the file re-fingerprints the first one and
  // breaks a suppression the user already wrote. Churning 43 universal
  // single-block findings once is the cheaper of the two.
  it("identifies a lone block rather than leaving it anonymous", async () => {
    const findings = await commentedOutCodeUniversalDetector.run(
      makeCtx("src/one.py", [block(1), "active = 1"].join("\n")),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.discriminator).toMatch(/^[0-9a-f]{12}$/);
  });

  it("tie-breaks two byte-identical blocks by start line", async () => {
    const source = [block(1), "active = 1", "", block(1), "more = 2"].join("\n");
    const findings = await commentedOutCodeUniversalDetector.run(
      makeCtx("src/twice.py", source),
    );
    expect(findings).toHaveLength(2);
    expect(new Set(findings.map((f) => f.discriminator)).size).toBe(2);
  });
});

describe("discriminator stability (C — the two variants unified)", () => {
  const BLOCK_A = [
    "# result = compute(a, b)",
    "# if result is None:",
    "#     raise ValueError(result)",
    "#     return result",
  ].join("\n");
  const BLOCK_B = [
    "# handler = build_handler(cfg)",
    "# handler.register(name)",
    "#     handler.start()",
    "#     return handler",
  ].join("\n");

  it("gives a lone block a discriminator of its own", async () => {
    const [only] = await commentedOutCodeUniversalDetector.run(
      makeCtx("svc/a.py", `x = 1\n${BLOCK_A}\ny = 2\n`),
    );
    // Through 0.24.0 this was dropped, so the fingerprint was
    // `commented_out_code::svc/a.py::` — an identity that says nothing
    // about which block it is.
    expect(only?.discriminator, "a lone block should still be identified").toBeTruthy();
  });

  it("does not change a block's identity when an unrelated block appears", async () => {
    // The defect the conditional policy carried: identity depended on how
    // many *other* findings shared the file, so commenting out something
    // elsewhere silently re-fingerprinted a finding a user had already
    // triaged, and their `crimes ignore` entry stopped matching.
    const before = await commentedOutCodeUniversalDetector.run(
      makeCtx("svc/a.py", `x = 1\n${BLOCK_A}\ny = 2\n`),
    );
    const after = await commentedOutCodeUniversalDetector.run(
      makeCtx("svc/a.py", `x = 1\n${BLOCK_A}\ny = 2\n${BLOCK_B}\nz = 3\n`),
    );
    const firstBefore = before[0];
    const firstAfter = after.find((f) => f.lines?.[0] === firstBefore?.lines?.[0]);
    expect(after.length).toBe(2);
    expect(firstAfter?.discriminator).toBe(firstBefore?.discriminator);
  });

  it("still separates two blocks in one file", async () => {
    const findings = await commentedOutCodeUniversalDetector.run(
      makeCtx("svc/a.py", `x = 1\n${BLOCK_A}\ny = 2\n${BLOCK_B}\nz = 3\n`),
    );
    const ds = findings.map((f) => f.discriminator);
    expect(new Set(ds).size).toBe(findings.length);
  });

  it("matches the language-js twin's policy of always identifying a block", async () => {
    // The two variants disagreed only for single-block files. Unified
    // toward "always", because the alternative makes identity a function
    // of unrelated findings — see the test above.
    const findings = await commentedOutCodeUniversalDetector.run(
      makeCtx("svc/solo.py", `x = 1\n${BLOCK_A}\n`),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.discriminator).toMatch(/^[0-9a-f]{12}$/);
  });
});
