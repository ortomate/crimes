import { parsePyFile } from "@crimes/language-py";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../config.js";
import type { LanguagePyDetector, LanguagePyDetectorContext } from "../../detector.js";
import type { PreFinding } from "../../finding.js";
import type { ImportGraph } from "../../imports/types.js";
import {
  booleanNamingDriftPyDetector,
  circularDependencyPyDetector,
  deepImportPyDetector,
  directDatePyDetector,
  largeFunctionPyDetector,
  mixedUtcLocalMethodsPyDetector,
  pythonDetectors,
  syncIoInHotpathPyDetector,
  weakTestSignalPyDetector,
} from "./index.js";

async function ctxFor(
  file: string,
  source: string,
  extra: Partial<LanguagePyDetectorContext> = {},
): Promise<LanguagePyDetectorContext> {
  const absolutePath = `/repo/${file}`;
  const parsed = await parsePyFile({ absolutePath, source });
  return {
    kind: "language-py",
    file,
    absolutePath,
    source,
    parsed,
    config: DEFAULT_CONFIG,
    ...extra,
  };
}

async function run(
  detector: LanguagePyDetector,
  file: string,
  source: string,
  extra: Partial<LanguagePyDetectorContext> = {},
): Promise<PreFinding[]> {
  return detector.run(await ctxFor(file, source, extra));
}

function graphFrom(edges: Array<[string, string]>): ImportGraph {
  const full = edges.map(([from, to]) => ({
    from,
    to,
    specifier: to,
    external: false,
    typeOnly: false,
    dynamic: false,
  }));
  const out = new Map<string, typeof full>();
  const inMap = new Map<string, typeof full>();
  for (const e of full) {
    out.set(e.from, [...(out.get(e.from) ?? []), e]);
    inMap.set(e.to, [...(inMap.get(e.to) ?? []), e]);
  }
  return {
    edges: full,
    out,
    in: inMap,
    files: new Set(full.flatMap((e) => [e.from, e.to])),
  };
}

const body = (n: number, indent = "    "): string =>
  Array.from({ length: n }, (_, i) => `${indent}x_${i} = ${i}`).join("\n");

describe("large_function.py", () => {
  it("flags a domain function past the 50-line budget", async () => {
    const found = await run(
      largeFunctionPyDetector,
      "src/billing.py",
      `def compute(a, b):\n${body(60)}\n    return a`,
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.type).toBe("large_function");
    expect(found[0]!.symbol).toBe("compute");
  });

  it("leaves a function inside the budget alone", async () => {
    const found = await run(
      largeFunctionPyDetector,
      "src/billing.py",
      `def compute(a, b):\n${body(20)}\n    return a`,
    );
    expect(found).toEqual([]);
  });

  it("gives a route handler a larger budget than a domain function", async () => {
    const source = `@app.get("/x")\ndef handler():\n${body(60)}\n    return 1`;
    expect(await run(largeFunctionPyDetector, "src/api.py", source)).toEqual([]);
  });

  it("never rates a long test above low severity", async () => {
    const source = `def test_big():\n${body(200)}\n    assert True`;
    const found = await run(largeFunctionPyDetector, "tests/test_big.py", source);
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe("low");
  });

  it("flags a short but deeply nested function", async () => {
    const source = [
      "def pick(a):",
      "    if a:",
      "        for i in a:",
      "            while i:",
      "                with open('x') as f:",
      "                    return f",
    ].join("\n");
    const found = await run(largeFunctionPyDetector, "src/deep.py", source);
    expect(found).toHaveLength(1);
    expect(found[0]!.evidence.join(" ")).toMatch(/nesting reaches 4 levels/);
  });

  it("does not claim a sub-threshold function is too big to hold in context", async () => {
    // Fired on nesting, not length. Saying "is 6 lines ... At this size an
    // agent must read the whole body" beside evidence reading "6 lines
    // (threshold 50)" is self-refuting — every blind judge in the 0.14→0.17
    // dogfooding round independently called this out.
    const source = [
      "def pick(a):",
      "    if a:",
      "        for i in a:",
      "            while i:",
      "                with open('x') as f:",
      "                    return f",
    ].join("\n");
    const found = await run(largeFunctionPyDetector, "src/deep.py", source);
    expect(found).toHaveLength(1);
    const summary = found[0]!.summary;

    expect(summary).not.toMatch(/At this size/);
    expect(summary).toMatch(/nest/i);
    // The summary must not lead with a length claim it just disproved.
    expect(summary).not.toMatch(/^`pick` is \d+ lines\./);
  });

  it("still leads with length when the function really is too long", async () => {
    const source = `def compute(a):\n${body(80)}\n    return a`;
    const found = await run(largeFunctionPyDetector, "src/long.py", source);
    expect(found).toHaveLength(1);
    expect(found[0]!.summary).toMatch(/At this size/);
    expect(found[0]!.summary).toMatch(/lines/);
  });

  it("honours a configured per-shape threshold", async () => {
    const source = `def compute(a):\n${body(60)}\n    return a`;
    const config = {
      ...DEFAULT_CONFIG,
      detectors: { options: { "large_function.py": { thresholds: { domain: 200 } } } },
    };
    expect(
      await run(largeFunctionPyDetector, "src/billing.py", source, { config }),
    ).toEqual([]);
  });
});

describe("direct_date.py", () => {
  it("flags a naive datetime.now() and says why it is naive", async () => {
    const found = await run(
      directDatePyDetector,
      "src/billing.py",
      "import datetime\n\ndef stamp():\n    return datetime.datetime.now()\n",
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.type).toBe("direct_date");
    expect(found[0]!.evidence.join(" ")).toMatch(/naive datetime/);
    expect(found[0]!.severity).toBe("medium");
  });

  it("still flags a tz-aware read, but without the naive evidence", async () => {
    const found = await run(
      directDatePyDetector,
      "src/billing.py",
      "from datetime import datetime, timezone\n\ndef stamp():\n    return datetime.now(timezone.utc)\n",
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.evidence.join(" ")).not.toMatch(/naive datetime/);
    expect(found[0]!.severity).toBe("low");
  });

  it("calls out utcnow deprecation", async () => {
    const found = await run(
      directDatePyDetector,
      "src/billing.py",
      "import datetime\nx = datetime.utcnow()\n",
    );
    expect(found[0]!.evidence.join(" ")).toMatch(/deprecated since Python 3\.12/);
  });

  it("skips test files and clock boundary modules", async () => {
    const src = "import datetime\nx = datetime.datetime.now()\n";
    expect(await run(directDatePyDetector, "tests/test_billing.py", src)).toEqual([]);
    expect(await run(directDatePyDetector, "src/clock.py", src)).toEqual([]);
  });

  it("escalates to high on many naive reads", async () => {
    const src = `import datetime\n${Array.from(
      { length: 5 },
      (_, i) => `a${i} = datetime.datetime.now()`,
    ).join("\n")}\n`;
    const found = await run(directDatePyDetector, "src/billing.py", src);
    expect(found[0]!.severity).toBe("high");
  });
});

describe("mixed_utc_local_methods.py", () => {
  it("fires only when both families appear", async () => {
    const found = await run(
      mixedUtcLocalMethodsPyDetector,
      "src/billing.py",
      "import datetime\nstart = datetime.utcnow()\nend = datetime.datetime.now()\n",
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.charge).toBe("Two Clocks, One Module");
  });

  it("stays quiet when only one family is present", async () => {
    expect(
      await run(
        mixedUtcLocalMethodsPyDetector,
        "src/a.py",
        "import datetime\na = datetime.utcnow()\nb = datetime.utcnow()\n",
      ),
    ).toEqual([]);
    expect(
      await run(
        mixedUtcLocalMethodsPyDetector,
        "src/b.py",
        "import datetime\na = datetime.datetime.now()\n",
      ),
    ).toEqual([]);
  });

  it("ignores tz-aware reads — an aware value is not part of the trap", async () => {
    expect(
      await run(
        mixedUtcLocalMethodsPyDetector,
        "src/c.py",
        "import datetime\na = datetime.utcnow()\nb = datetime.datetime.now(tz=timezone.utc)\n",
      ),
    ).toEqual([]);
  });
});

describe("sync_io_in_hotpath.py", () => {
  it("flags a blocking call inside a route handler", async () => {
    const found = await run(
      syncIoInHotpathPyDetector,
      "src/api.py",
      '@app.get("/x")\ndef handler():\n    return requests.get("http://x")\n',
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.type).toBe("sync_io_in_hotpath");
  });

  it("rates an async handler higher and says the event loop is at risk", async () => {
    const found = await run(
      syncIoInHotpathPyDetector,
      "src/api.py",
      '@app.get("/x")\nasync def handler():\n    a = requests.get("http://x")\n    b = open("/tmp/f")\n    return a\n',
    );
    expect(found[0]!.severity).toBe("high");
    expect(found[0]!.evidence.join(" ")).toMatch(/stalls the event loop/);
  });

  it("reads async-ness from the scope chain, not from line containment", async () => {
    // A blocking call in a helper nested inside an async handler still
    // runs on the event loop, so it must escalate...
    const nested = await run(
      syncIoInHotpathPyDetector,
      "src/api.py",
      [
        '@app.get("/x")',
        "async def handler():",
        "    def helper():",
        '        requests.get("http://x")',
        '        open("/f")',
        "    return helper()",
      ].join("\n"),
    );
    expect(nested[0]!.evidence.join(" ")).toMatch(/stalls the event loop/);

    // ...whereas a sync handler that merely sits below an async function
    // in the same file must not. Line-range containment cannot tell
    // these apart; the scope chain can.
    const sibling = await run(
      syncIoInHotpathPyDetector,
      "src/api2.py",
      [
        '@app.get("/a")',
        "async def a():",
        "    return 1",
        "",
        '@app.get("/b")',
        "def b():",
        '    requests.get("http://x")',
        '    open("/f")',
        "    return 2",
      ].join("\n"),
    );
    expect(sibling).toHaveLength(1);
    expect(sibling[0]!.evidence.join(" ")).not.toMatch(/stalls the event loop/);
    expect(sibling[0]!.severity).not.toBe("high");
  });

  it("exempts CLI commands and tests anywhere in the chain", async () => {
    expect(
      await run(
        syncIoInHotpathPyDetector,
        "src/cli.py",
        '@click.command()\ndef build():\n    return open("/tmp/f").read()\n',
      ),
    ).toEqual([]);
    expect(
      await run(
        syncIoInHotpathPyDetector,
        "tests/test_x.py",
        'def test_reads():\n    return open("/tmp/f").read()\n',
      ),
    ).toEqual([]);
  });

  it("ignores module-level I/O, which runs once at import", async () => {
    expect(
      await run(
        syncIoInHotpathPyDetector,
        "src/config.py",
        'CONFIG = open("/etc/app.conf").read()\n',
      ),
    ).toEqual([]);
  });
});

describe("boolean_naming_drift.py", () => {
  it("flags a boolean-bound name with no signalling prefix", async () => {
    const found = await run(
      booleanNamingDriftPyDetector,
      "src/billing.py",
      "def go(items):\n    retry = len(items) > 0\n    return retry\n",
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.evidence.join(" ")).toMatch(/`retry`/);
  });

  it("accepts the is_/has_/should_ prefixes", async () => {
    expect(
      await run(
        booleanNamingDriftPyDetector,
        "src/a.py",
        "def go(x):\n    is_ready = x > 1\n    has_items = len(x) > 0\n    should_retry = not x\n    return is_ready\n",
      ),
    ).toEqual([]);
  });

  it("accepts idiomatic bare names", async () => {
    expect(
      await run(
        booleanNamingDriftPyDetector,
        "src/a.py",
        "def go(x):\n    ok = x > 1\n    found = x in [1]\n    dry_run = not x\n    return ok\n",
      ),
    ).toEqual([]);
  });

  it("leaves module-level SHOUTED constants alone", async () => {
    expect(
      await run(
        booleanNamingDriftPyDetector,
        "src/a.py",
        "DEBUG = True\nSTRICT = False\n",
      ),
    ).toEqual([]);
  });

  it("ignores non-boolean bindings", async () => {
    expect(
      await run(
        booleanNamingDriftPyDetector,
        "src/a.py",
        "def go():\n    count = 3\n    name = 'x'\n    items = []\n    return count\n",
      ),
    ).toEqual([]);
  });

  it("counts a reassigned name once, not once per assignment", async () => {
    // The charge is per-name, and the offender count drives severity.
    const found = await run(
      booleanNamingDriftPyDetector,
      "src/a.py",
      "def go(x):\n    retry = True\n    retry = False\n    retry = x > 1\n    return retry\n",
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.evidence.filter((e) => e.includes("`retry`"))).toHaveLength(1);
    expect(found[0]!.severity).toBe("low");
  });

  it("keeps the same name in two functions as two bindings", async () => {
    const found = await run(
      booleanNamingDriftPyDetector,
      "src/a.py",
      [
        "def one(x):",
        "    retry = x > 1",
        "    return retry",
        "def two(x):",
        "    retry = x < 1",
        "    return retry",
      ].join("\n"),
    );
    expect(found[0]!.evidence.filter((e) => e.includes("`retry`"))).toHaveLength(2);
  });

  it("honours a configured allowlist", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      detectors: {
        options: { "boolean_naming_drift.py": { allowedNames: ["retry"] } },
      },
    };
    expect(
      await run(
        booleanNamingDriftPyDetector,
        "src/a.py",
        "def go(x):\n    retry = x > 1\n    return retry\n",
        { config },
      ),
    ).toEqual([]);
  });
});

describe("weak_test_signal.py", () => {
  it("flags test functions that assert nothing", async () => {
    const found = await run(
      weakTestSignalPyDetector,
      "tests/test_billing.py",
      [
        "def test_a():",
        "    compute(1)",
        "",
        "def test_b():",
        "    compute(2)",
        "",
        "def test_c():",
        "    assert compute(3) == 3",
      ].join("\n"),
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.evidence.join(" ")).toMatch(
      /2 of 3 test functions contain no assertion/,
    );
  });

  it("counts unittest assert* methods as real assertions", async () => {
    expect(
      await run(
        weakTestSignalPyDetector,
        "tests/test_billing.py",
        [
          "class T(unittest.TestCase):",
          "    def test_a(self):",
          "        self.assertEqual(1, 1)",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("counts pytest.raises as a real assertion", async () => {
    expect(
      await run(
        weakTestSignalPyDetector,
        "tests/test_billing.py",
        "def test_a():\n    with pytest.raises(ValueError):\n        boom()\n",
      ),
    ).toEqual([]);
  });

  it("counts pytest.warns as a real assertion", async () => {
    // `pytest.warns` fails when the warning is not emitted, which is
    // exactly what `pytest.raises` does for exceptions. pydantic writes
    // it 175 times in `tests/`.
    expect(
      await run(
        weakTestSignalPyDetector,
        "tests/test_config.py",
        [
          "def test_generate_schema_deprecation_warning():",
          "    with pytest.warns(PydanticDeprecatedSince210, match='deprecated'):",
          "        build()",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("counts a bare warns() the same way it counts a bare raises()", async () => {
    expect(
      await run(
        weakTestSignalPyDetector,
        "tests/test_config.py",
        "def test_a():\n    with warns(UserWarning):\n        build()\n",
      ),
    ).toEqual([]);
  });

  it("credits a test marked @pytest.mark.xfail", async () => {
    // The marker is the expectation: the test asserts that this code
    // still fails, and an unexpected pass is reported as XPASS.
    expect(
      await run(
        weakTestSignalPyDetector,
        "tests/test_meta.py",
        [
          "@pytest.mark.xfail(reason='Invalid JSON Schemas are expected to fail.')",
          "def test_invalid_json_schema_raises():",
          "    TypeAdapter(int).json_schema()",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("only runs on test files", async () => {
    expect(
      await run(weakTestSignalPyDetector, "src/billing.py", "def test_a():\n    pass\n"),
    ).toEqual([]);
  });

  it("credits an assertion made inside a local helper to the test", async () => {
    // Attribution is by line span, not by innermost enclosing function.
    // Keyed on the function name, the assert below belongs to `check`
    // and `test_totals` would read as asserting nothing.
    expect(
      await run(
        weakTestSignalPyDetector,
        "tests/test_billing.py",
        [
          "def test_totals():",
          "    def check(x):",
          "        assert x > 0",
          "    check(compute())",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("does not count a test_* function nested inside a real test", async () => {
    // zulip's `test_message_delete.py` declares four local helpers named
    // `test_delete_message_by_*` inside one real test. pytest collects
    // neither of them — a nested function is not a test — but they were
    // reported as silent tests, 9 of that file's 23 survivors.
    expect(
      await run(
        weakTestSignalPyDetector,
        "tests/test_message_delete.py",
        [
          "class T(ZulipTestCase):",
          "    def test_delete_flow(self):",
          "        def test_delete_by_admin(msg_id):",
          "            return self.client_delete(msg_id)",
          "",
          "        self.assertEqual(test_delete_by_admin(1).status_code, 200)",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("does not count a test_* function nested inside a non-test function", async () => {
    // Same rule, stated at its real boundary: pytest collects tests at
    // module or class scope. Anything declared inside *any* function is
    // out of reach regardless of what the enclosing function is called.
    expect(
      await run(
        weakTestSignalPyDetector,
        "tests/test_decorators.py",
        [
          "def build_view_suite():",
          "    @zulip_login_required",
          "    def test_view(request):",
          "        return HttpResponse('Success')",
          "",
          "    return test_view",
          "",
          "def test_real():",
          "    assert build_view_suite() is not None",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("still counts a nested test's assertions toward its enclosing test", async () => {
    // The nesting exclusion removes the inner function from the
    // denominator; it must not remove its assertions from the outer
    // test's span-based credit.
    expect(
      await run(
        weakTestSignalPyDetector,
        "tests/test_billing.py",
        [
          "def test_outer():",
          "    def test_inner():",
          "        assert compute() == 3",
          "    test_inner()",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("stays quiet when the parse was incomplete", async () => {
    // An untrustworthy assertion count must not produce a confident
    // accusation — the whole charge is a count.
    expect(
      await run(
        weakTestSignalPyDetector,
        "tests/test_broken.py",
        "def test_a(:\n    pass\n",
      ),
    ).toEqual([]);
  });

  it("credits a test that delegates its assertions to a same-file helper", async () => {
    expect(
      await run(
        weakTestSignalPyDetector,
        "tests/test_billing.py",
        [
          "def check_valid_user(user):",
          "    assert user.id",
          "    assert user.email",
          "",
          "def test_creates_user():",
          "    user = create_user()",
          "    check_valid_user(user)",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("credits a helper reached through a method on self", async () => {
    expect(
      await run(
        weakTestSignalPyDetector,
        "tests/test_events.py",
        [
          "class BaseAction(ZulipTestCase):",
          "    def verify_action(self, events):",
          "        self.assert_length(events, 1)",
          "",
          "class NormalActionsTest(BaseAction):",
          "    def test_send_message(self):",
          "        with self.verify_action():",
          "            send_message()",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("follows a helper chain two hops deep but no further", async () => {
    const twoHops = await run(
      weakTestSignalPyDetector,
      "tests/test_billing.py",
      [
        "def leaf(x):",
        "    assert x",
        "",
        "def middle(x):",
        "    leaf(x)",
        "",
        "def test_two_hops():",
        "    middle(1)",
      ].join("\n"),
    );
    expect(twoHops).toEqual([]);

    const threeHops = await run(
      weakTestSignalPyDetector,
      "tests/test_billing.py",
      [
        "def leaf(x):",
        "    assert x",
        "",
        "def middle(x):",
        "    leaf(x)",
        "",
        "def outer(x):",
        "    middle(x)",
        "",
        "def test_three_hops():",
        "    outer(1)",
      ].join("\n"),
    );
    expect(threeHops).toHaveLength(1);
    expect(threeHops[0]!.evidence.join(" ")).toMatch(/`test_three_hops`/);
  });

  it("does not credit a helper it cannot see the body of", async () => {
    // `check_valid_user` is imported from elsewhere. Crediting a call
    // we cannot read would turn the detector blind.
    const found = await run(
      weakTestSignalPyDetector,
      "tests/test_billing.py",
      [
        "from .helpers import check_valid_user",
        "",
        "def test_creates_user():",
        "    check_valid_user(create_user())",
      ].join("\n"),
    );
    expect(found).toHaveLength(1);
  });

  it("does not credit a bare-name match on an unrelated receiver", async () => {
    // `client.check` is a method on some object, not the module-level
    // `check` defined below. Matching on the trailing segment alone
    // would credit any test that happened to call something similarly
    // named.
    const found = await run(
      weakTestSignalPyDetector,
      "tests/test_billing.py",
      [
        "def check(x):",
        "    assert x",
        "",
        "def test_creates_user():",
        "    client.check(create_user())",
      ].join("\n"),
    );
    expect(found).toHaveLength(1);
  });

  it("reports how many tests were credited through a helper", async () => {
    const found = await run(
      weakTestSignalPyDetector,
      "tests/test_billing.py",
      [
        "def check(x):",
        "    assert x",
        "",
        "def test_a():",
        "    check(1)",
        "",
        "def test_b():",
        "    compute(2)",
      ].join("\n"),
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.evidence.join(" ")).toMatch(
      /1 further test asserts through a same-file helper/,
    );
  });

  it("counts self.fail as a real signal", async () => {
    expect(
      await run(
        weakTestSignalPyDetector,
        "tests/test_billing.py",
        [
          "class T(unittest.TestCase):",
          "    def test_a(self):",
          "        try:",
          "            boom()",
          "        except ValueError:",
          "            return",
          "        self.fail('expected ValueError')",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("counts model_dump_json(warnings='error') as a real signal", async () => {
    expect(
      await run(
        weakTestSignalPyDetector,
        "tests/test_billing.py",
        "def test_a():\n    build_model().model_dump_json(warnings='error')\n",
      ),
    ).toEqual([]);
  });

  it("exempts benchmarks, whether marked by decorator or by fixture", async () => {
    expect(
      await run(
        weakTestSignalPyDetector,
        "tests/benchmarks/test_speed.py",
        [
          "@pytest.mark.benchmark(group='validate')",
          "def test_marked():",
          "    run_it()",
          "",
          "def test_fixture(benchmark):",
          "    benchmark(run_it)",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("keeps benchmarks out of the denominator as well as the numerator", async () => {
    // One real test asserting nothing beside three benchmarks must read
    // as 1 of 1, not 4 of 4 — the share drives severity.
    const found = await run(
      weakTestSignalPyDetector,
      "tests/benchmarks/test_speed.py",
      [
        "def test_bench_a(benchmark):",
        "    benchmark(run_it)",
        "",
        "def test_bench_b(benchmark):",
        "    benchmark(run_it)",
        "",
        "def test_bench_c(benchmark):",
        "    benchmark(run_it)",
        "",
        "def test_real():",
        "    run_it()",
      ].join("\n"),
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.evidence[0]).toMatch(/1 of 1 test function contains no assertion/);
  });
});

describe("circular_dependency.py", () => {
  it("emits one finding anchored on the lexicographically first member", async () => {
    const imports = graphFrom([
      ["pkg/a.py", "pkg/b.py"],
      ["pkg/b.py", "pkg/a.py"],
    ]);
    const fromAnchor = await run(circularDependencyPyDetector, "pkg/a.py", "", {
      imports,
    });
    const fromOther = await run(circularDependencyPyDetector, "pkg/b.py", "", {
      imports,
    });
    expect(fromAnchor).toHaveLength(1);
    expect(fromOther).toEqual([]);
    expect(fromAnchor[0]!.related_files).toEqual(["pkg/b.py"]);
  });

  it("explains the ImportError failure mode rather than only tree-shaking", async () => {
    const imports = graphFrom([
      ["pkg/a.py", "pkg/b.py"],
      ["pkg/b.py", "pkg/a.py"],
    ]);
    const found = await run(circularDependencyPyDetector, "pkg/a.py", "", { imports });
    expect(found[0]!.evidence.join(" ")).toMatch(/half-initialised|partially initial/i);
  });

  it("rates a three-module ring high", async () => {
    const imports = graphFrom([
      ["pkg/a.py", "pkg/b.py"],
      ["pkg/b.py", "pkg/c.py"],
      ["pkg/c.py", "pkg/a.py"],
    ]);
    const found = await run(circularDependencyPyDetector, "pkg/a.py", "", { imports });
    expect(found[0]!.severity).toBe("high");
  });

  it("ignores a cycle that runs through JS files", async () => {
    const imports = graphFrom([
      ["pkg/a.py", "src/x.ts"],
      ["src/x.ts", "pkg/a.py"],
    ]);
    expect(await run(circularDependencyPyDetector, "pkg/a.py", "", { imports })).toEqual(
      [],
    );
  });

  it("does nothing without an import graph", async () => {
    expect(await run(circularDependencyPyDetector, "pkg/a.py", "")).toEqual([]);
  });
});

describe("deep_import.py", () => {
  it("flags an import past the depth threshold", async () => {
    const found = await run(
      deepImportPyDetector,
      "src/a.py",
      "from a.b.c.d.e import helper\n",
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.type).toBe("deep_import");
  });

  it("leaves a shallow import alone", async () => {
    expect(
      await run(deepImportPyDetector, "src/a.py", "from a.b import helper\nimport os\n"),
    ).toEqual([]);
  });

  it("flags a long relative climb", async () => {
    const found = await run(
      deepImportPyDetector,
      "a/b/c/d.py",
      "from ... import thing\n",
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.evidence.join(" ")).toMatch(/climb 3\+ package levels/);
  });

  it("calls out a wildcard import as unbounded coupling", async () => {
    const found = await run(
      deepImportPyDetector,
      "src/a.py",
      "from a.b.c.d.e import *\n",
    );
    expect(found[0]!.evidence.join(" ")).toMatch(/wildcard import/);
  });

  it("honours a configured maxDepth", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      detectors: { options: { "deep_import.py": { maxDepth: 10 } } },
    };
    expect(
      await run(deepImportPyDetector, "src/a.py", "from a.b.c.d.e import helper\n", {
        config,
      }),
    ).toEqual([]);
  });
});

/**
 * Blocker 3 of the 0.14.0 release.
 *
 * Since 0.13.0 the detector-supplied `scores.agent_risk` is the heaviest
 * term in the unified formula (0.40). Detectors that omit it fall back
 * to a compressed severity-derived default — deliberately lower than a
 * real judgement — so a Python detector without an opinion would rank
 * below its JS equivalent for no reason other than not having one.
 */
describe("every Python detector sets an intrinsic agent_risk", () => {
  const SAMPLES: Array<[string, string]> = [
    [
      "src/billing.py",
      `import datetime\ndef compute(a, b):\n${body(60)}\n    return datetime.datetime.now()`,
    ],
    [
      "src/mixed.py",
      "import datetime\na = datetime.utcnow()\nb = datetime.datetime.now()\n",
    ],
    [
      "src/api.py",
      '@app.get("/x")\nasync def handler():\n    a = requests.get("http://x")\n    b = open("/f")\n    return a\n',
    ],
    [
      "src/naming.py",
      "def go(x):\n    retry = x > 1\n    stale = x < 1\n    return retry\n",
    ],
    [
      "tests/test_thing.py",
      "def test_a():\n    compute(1)\n\ndef test_b():\n    compute(2)\n",
    ],
    ["src/deep.py", "from a.b.c.d.e import helper\n"],
  ];

  it("emits a numeric, in-range intrinsic on every finding", async () => {
    const imports = graphFrom([
      ["pkg/a.py", "pkg/b.py"],
      ["pkg/b.py", "pkg/a.py"],
    ]);
    const seen: string[] = [];

    for (const detector of pythonDetectors) {
      for (const [file, source] of [...SAMPLES, ["pkg/a.py", ""] as [string, string]]) {
        const findings = await run(detector, file, source, { imports });
        for (const f of findings) {
          seen.push(detector.id);
          expect(
            typeof f.scores.agent_risk,
            `${detector.id} emitted a finding without an intrinsic agent_risk`,
          ).toBe("number");
          expect(f.scores.agent_risk!).toBeGreaterThan(0);
          expect(f.scores.agent_risk!).toBeLessThanOrEqual(1);
        }
      }
    }

    // Guard the guard: if the samples stopped triggering the detectors,
    // the loop above would pass vacuously.
    expect(new Set(seen).size).toBe(pythonDetectors.length);
  });

  it("keeps the readability charge below the correctness charges", async () => {
    // boolean_naming_drift is a readability signal. It must not outrank
    // a blocked event loop or a naive-datetime comparison.
    const naming = await run(
      booleanNamingDriftPyDetector,
      "src/naming.py",
      "def go(x):\n    retry = x > 1\n    stale = x < 1\n    return retry\n",
    );
    const blocking = await run(
      syncIoInHotpathPyDetector,
      "src/api.py",
      '@app.get("/x")\nasync def handler():\n    a = requests.get("http://x")\n    b = open("/f")\n    return a\n',
    );
    expect(naming[0]!.scores.agent_risk!).toBeLessThan(blocking[0]!.scores.agent_risk!);
  });

  it("scales the intrinsic with the amount of evidence found", async () => {
    const one = await run(
      directDatePyDetector,
      "src/a.py",
      "import datetime\na = datetime.datetime.now()\n",
    );
    const many = await run(
      directDatePyDetector,
      "src/b.py",
      `import datetime\n${Array.from({ length: 6 }, (_, i) => `a${i} = datetime.datetime.now()`).join("\n")}\n`,
    );
    expect(many[0]!.scores.agent_risk!).toBeGreaterThan(one[0]!.scores.agent_risk!);
  });
});

describe("Python detector contract", () => {
  it("emits abstract finding types even though detector ids are qualified", async () => {
    const found = await run(
      directDatePyDetector,
      "src/a.py",
      "import datetime\na = datetime.datetime.now()\n",
    );
    expect(directDatePyDetector.id).toBe("direct_date.py");
    expect(found[0]!.type).toBe("direct_date");
  });

  it("declares whyItMatters and a description on every detector", () => {
    for (const d of pythonDetectors) {
      expect(d.pack).toBe("language-py");
      expect(d.whyItMatters.length).toBeGreaterThan(80);
      expect(d.description.length).toBeGreaterThan(20);
    }
  });
});
