import { describe, expect, it } from "vitest";
import { parsePyFile } from "./parse/index.js";
import type { ParsedPyFile } from "./parse/types.js";

async function parse(source: string, path = "/repo/src/billing.py"): Promise<ParsedPyFile> {
  return parsePyFile({ absolutePath: path, source });
}

describe("parsePyFile — functions", () => {
  it("captures name, line range, params, and nesting depth", async () => {
    const parsed = await parse(`
def compute_total(items, discount):
    total = 0
    for item in items:
        if item.taxable:
            total += item.price
    return total
`);
    expect(parsed.functions).toHaveLength(1);
    const fn = parsed.functions[0]!;
    expect(fn.name).toBe("compute_total");
    expect(fn.kind).toBe("function");
    expect(fn.startLine).toBe(2);
    expect(fn.endLine).toBe(7);
    expect(fn.paramCount).toBe(2);
    expect(fn.maxNestingDepth).toBe(2);
  });

  it("excludes self from the parameter count and records the class", async () => {
    const parsed = await parse(`
class Billing:
    def charge(self, customer, amount):
        return amount
`);
    const fn = parsed.functions[0]!;
    expect(fn.paramCount).toBe(2);
    expect(fn.kind).toBe("method");
    expect(fn.className).toBe("Billing");
  });

  it("marks async functions", async () => {
    const parsed = await parse(`
async def fetch(url):
    return url
`);
    expect(parsed.functions[0]!.kind).toBe("async_function");
  });

  it("does not count a flat if/elif chain as increasing depth", async () => {
    const parsed = await parse(`
def pick(x):
    if x == 1:
        return "a"
    elif x == 2:
        return "b"
    elif x == 3:
        return "c"
    return "z"
`);
    expect(parsed.functions[0]!.maxNestingDepth).toBe(1);
  });

  it("measures a nested function's depth separately from its parent", async () => {
    const parsed = await parse(`
def outer(x):
    if x:
        def inner(y):
            for i in y:
                if i:
                    return i
        return inner
`);
    const outer = parsed.functions.find((f) => f.name === "outer")!;
    const inner = parsed.functions.find((f) => f.name === "inner")!;
    expect(outer.maxNestingDepth).toBe(1);
    expect(inner.maxNestingDepth).toBe(2);
  });
});

describe("parsePyFile — function shapes", () => {
  it("classifies FastAPI and Flask route handlers", async () => {
    const parsed = await parse(`
@app.get("/api/users")
async def list_users():
    return []

@router.post("/items")
def create_item(payload):
    return payload

@bp.route("/legacy")
def legacy():
    return "ok"
`);
    for (const fn of parsed.functions) {
      expect(fn.shape).toBe("route_handler");
    }
    expect(parsed.functions[0]!.shapeEvidence).toEqual(['decorated @app.get']);
  });

  it("classifies Click and Typer commands", async () => {
    const parsed = await parse(`
@click.command()
def build(target):
    pass

@app.command()
def serve(port):
    pass
`);
    expect(parsed.functions.map((f) => f.shape)).toEqual([
      "cli_command",
      "cli_command",
    ]);
  });

  it("classifies pytest and unittest tests", async () => {
    const parsed = await parse(
      `
def test_totals():
    assert True

class BillingTests(unittest.TestCase):
    def check_amount(self):
        pass

@pytest.fixture
def client():
    return None
`,
      "/repo/tests/test_billing.py",
    );
    expect(parsed.functions.map((f) => f.shape)).toEqual([
      "test_function",
      "test_function",
      "test_function",
    ]);
  });

  it("classifies Django views by base class and by request parameter", async () => {
    const parsed = await parse(`
class UserList(ListView):
    def get_queryset(self):
        return []

def profile(request, user_id):
    return user_id
`);
    expect(parsed.functions.map((f) => f.shape)).toEqual([
      "django_view",
      "django_view",
    ]);
  });

  it("classifies dunder methods, but framework shape wins over dunder", async () => {
    const parsed = await parse(`
class Plain:
    def __init__(self, a):
        self.a = a

class UserList(ListView):
    def __init__(self):
        pass
`);
    expect(parsed.functions[0]!.shape).toBe("dunder");
    expect(parsed.functions[1]!.shape).toBe("django_view");
  });

  it("does not mistake a project-local cache.get for a route", async () => {
    const parsed = await parse(`
@cache.get("key")
def lookup(k):
    return k
`);
    expect(parsed.functions[0]!.shape).toBe("domain");
  });
});

describe("parsePyFile — imports", () => {
  it("captures plain, aliased, and dotted imports", async () => {
    const parsed = await parse(`
import os
import os.path as osp
`);
    expect(parsed.imports).toEqual([
      {
        kind: "import",
        module: "os",
        relativeLevel: 0,
        names: [],
        wildcard: false,
        line: 2,
        depth: 1,
      },
      {
        kind: "import",
        module: "os.path",
        relativeLevel: 0,
        names: [],
        wildcard: false,
        line: 3,
        depth: 2,
        alias: "osp",
      },
    ]);
  });

  it("captures relative import levels", async () => {
    const parsed = await parse(`
from . import sibling
from .. import parent_thing
from ..pkg.sub import thing, other
`);
    expect(parsed.imports.map((i) => [i.module, i.relativeLevel, i.names])).toEqual([
      ["", 1, ["sibling"]],
      ["", 2, ["parent_thing"]],
      ["pkg.sub", 2, ["thing", "other"]],
    ]);
  });

  it("records dotted depth including relative dots", async () => {
    const parsed = await parse(`
from a.b.c.d import deep
from ..a.b import shallow
`);
    expect(parsed.imports.map((i) => i.depth)).toEqual([4, 4]);
  });

  it("captures wildcard imports", async () => {
    const parsed = await parse(`from pkg.mod import *`);
    expect(parsed.imports[0]!.wildcard).toBe(true);
  });

  it("skips __future__ directives", async () => {
    const parsed = await parse(`
from __future__ import annotations
import os
`);
    expect(parsed.imports.map((i) => i.module)).toEqual(["os"]);
  });
});

describe("parsePyFile — date calls", () => {
  it("recognises the datetime clock surface", async () => {
    const parsed = await parse(`
import datetime
a = datetime.datetime.now()
b = datetime.utcnow()
c = date.today()
d = time.time()
`);
    expect(parsed.dateCalls.map((c) => [c.kind, c.callee])).toEqual([
      ["now", "datetime.datetime.now"],
      ["utcnow", "datetime.utcnow"],
      ["today", "date.today"],
      ["time", "time.time"],
    ]);
  });

  it("marks a tz-aware now() as timezone aware", async () => {
    const parsed = await parse(`
a = datetime.now(timezone.utc)
b = datetime.datetime.now(tz=timezone.utc)
c = datetime.now()
`);
    expect(parsed.dateCalls.map((c) => c.timezoneAware)).toEqual([true, true, false]);
  });

  it("never treats utcnow as timezone aware", async () => {
    const parsed = await parse(`a = datetime.utcnow()`);
    expect(parsed.dateCalls[0]!.timezoneAware).toBe(false);
  });

  it("ignores an unrelated now() on a project object", async () => {
    const parsed = await parse(`
a = clock.now()
b = self.now()
`);
    expect(parsed.dateCalls).toEqual([]);
  });
});

describe("parsePyFile — io calls", () => {
  it("recognises file, network, subprocess, and sleep families", async () => {
    const parsed = await parse(`
def handler():
    with open("/tmp/x") as f:
        pass
    requests.get("http://x")
    subprocess.run(["ls"])
    time.sleep(1)
    urllib.request.urlopen("http://y")
`);
    expect(parsed.ioCalls.map((c) => [c.callee, c.family])).toEqual([
      ["open", "file"],
      ["requests.get", "network"],
      ["subprocess.run", "subprocess"],
      ["time.sleep", "sleep"],
      ["urllib.request.urlopen", "network"],
    ]);
  });

  it("captures the enclosing function chain innermost first", async () => {
    const parsed = await parse(`
@app.get("/x")
def outer():
    def inner():
        open("/tmp/x")
    return inner
`);
    const call = parsed.ioCalls[0]!;
    expect(call.enclosingFunctions.map((f) => f.name)).toEqual(["inner", "outer"]);
    expect(call.enclosingFunctions[1]!.shape).toBe("route_handler");
  });

  it("carries each enclosing function's kind so async-ness is answerable from the chain", async () => {
    const parsed = await parse(`
@app.get("/x")
async def handler():
    def helper():
        open("/tmp/x")
    return helper()
`);
    expect(parsed.ioCalls[0]!.enclosingFunctions.map((f) => f.kind)).toEqual([
      "function",
      "async_function",
    ]);
  });

  it("records module-level io with an empty chain", async () => {
    const parsed = await parse(`CONFIG = open("/etc/app.conf").read()`);
    expect(parsed.ioCalls[0]!.enclosingFunctions).toEqual([]);
  });
});

describe("parsePyFile — assignments", () => {
  it("classifies boolean-producing right-hand sides", async () => {
    const parsed = await parse(`
a = True
b = not ready
c = x == 1
d = x in items
e = x is None
f = "text"
g = 3
h = [1]
i = None
j = compute()
`);
    expect(parsed.assignments.map((x) => [x.name, x.initializerKind])).toEqual([
      ["a", "boolean_literal"],
      ["b", "negation"],
      ["c", "comparison"],
      ["d", "membership"],
      ["e", "identity"],
      ["f", "string"],
      ["g", "number"],
      ["h", "collection"],
      ["i", "none"],
      ["j", "call"],
    ]);
  });

  it("captures annotations and self-attribute targets", async () => {
    const parsed = await parse(`
class A:
    def __init__(self):
        self.ready = True
        count: int = 0
`);
    expect(parsed.assignments.map((x) => [x.name, x.attributeTarget, x.annotation])).toEqual([
      ["ready", true, undefined],
      ["count", false, "int"],
    ]);
  });

  it("skips tuple and subscript targets", async () => {
    const parsed = await parse(`
a, b = f()
d["k"] = True
other.attr = True
`);
    expect(parsed.assignments).toEqual([]);
  });

  it("records the enclosing function name", async () => {
    const parsed = await parse(`
def process():
    ready = True
`);
    expect(parsed.assignments[0]!.functionName).toBe("process");
  });
});

describe("parsePyFile — assertions", () => {
  it("counts bare assert, unittest methods, and pytest.raises", async () => {
    const parsed = await parse(
      `
def test_a():
    assert 1 == 1

class T(unittest.TestCase):
    def test_b(self):
        self.assertEqual(1, 1)
        self.assertTrue(True)

def test_c():
    with pytest.raises(ValueError):
        pass
`,
      "/repo/tests/test_x.py",
    );
    expect(parsed.assertions.map((a) => a.kind)).toEqual([
      "assert_statement",
      "unittest_method",
      "unittest_method",
      "pytest_raises",
    ]);
    expect(parsed.assertions[1]!.method).toBe("assertEqual");
    expect(parsed.assertions[0]!.functionName).toBe("test_a");
  });
});

describe("parsePyFile — robustness", () => {
  it("does not throw on malformed source and flags the error", async () => {
    const parsed = await parse(`
def broken(:
    return
`);
    expect(parsed.hasSyntaxErrors).toBe(true);
  });

  it("returns an empty surface for an empty file", async () => {
    const parsed = await parse("");
    expect(parsed.functions).toEqual([]);
    expect(parsed.imports).toEqual([]);
    expect(parsed.hasSyntaxErrors).toBe(false);
  });

  it("sorts every collection by line", async () => {
    const parsed = await parse(`
import a
def one():
    x = True
    open("/tmp/1")
def two():
    y = False
    open("/tmp/2")
`);
    const lines = parsed.ioCalls.map((c) => c.line);
    expect([...lines].sort((a, b) => a - b)).toEqual(lines);
    const assignLines = parsed.assignments.map((a) => a.line);
    expect([...assignLines].sort((a, b) => a - b)).toEqual(assignLines);
  });
});
