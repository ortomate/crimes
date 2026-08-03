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
