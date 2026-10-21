# Templates and stylesheets: JSP and LESS packs (0.31)

Status: implemented in 0.31.0 (unreleased); measurements in
[calibration follow-ups](../../calibration-followups.md#0310-jsp-and-less-packs).
Roadmap item: "0.31 milestone: templates and stylesheets".

## Why

Older Java web estates keep a large share of their behaviour in
server-rendered views and stylesheets. On the estate behind 0.30 the main
web application has about 1,090 JSP, JSP fragment and tag files and 965
LESS files. Before this milestone none of them was even discovered: the
default `include` did not list their extensions, so an agent asking
`crimes context` about a tag file learned nothing, and a Java class used
only from templates scored a blast radius of zero.

What these files hide from an agent is **indirection**, not style:

- A page uses a tag through a prefix declared in a fragment that a
  different fragment includes. `grep` for the tag's file name finds
  nothing; the link is `<x:card>` → prefix `x` → `tagdir` →
  `card.tag`.
- One fragment of taglib declarations is included by nearly every page
  (861 of 1,089 files on the estate; 76 of 92 JSPs in Apache Roller).
  Editing it is the widest-reaching change in the application, and
  nothing about the file says so.
- JSP compiles at request time. An include of a moved file, a tag that
  no longer exists, or a required tag attribute a caller does not pass
  all build cleanly and fail on the first request.
- A LESS partial uses variables and mixins it never imports: they are
  in scope because the bundle root imported them first. The file that
  defines `@brand` has one importer and hundreds of users.

## Decisions

### Deterministic lexical scanners, no grammar

Neither language has a tree-sitter grammar that fits. `tree-sitter-html`
plus `embedded-template` approximates JSP's markup but not its
directives, actions or custom tags, and there is no maintained LESS
grammar. Both languages are regular enough at the level we need —
directives, tags, attributes, `@import`, top-level variable and mixin
definitions — that a hand-written scanner is smaller, faster and more
predictable than an approximate grammar. They are pure TypeScript: no
WASM, nothing to load lazily.

The scanners extract *facts*, never a tree. Anything they cannot read
with certainty (an include whose path is an EL expression, an import
built by interpolation) is skipped rather than guessed.

### Two packs

- `@crimes/language-jsp` claims `.jsp`, `.jspf`, `.tag` and `.tld`. TLD
  files are XML, but they are the only place a taglib URI is bound to tag
  and function classes, so the pack that resolves taglibs owns them.
  The XML syntaxes (`.jspx`, `.tagx`) are not claimed.
- `@crimes/language-less` claims `.less`. Plain `.css` is not claimed in
  0.31: it would add every JavaScript repository's stylesheets to the
  report for an `@import` graph of little value.

### Graph edges

Edges join the one shared import graph, so blast radius, fan-in and
`context` importers work unchanged.

JSP, resolved against the web root (the nearest ancestor directory that
contains `WEB-INF`):

| Construct | Edge |
| --- | --- |
| `<%@ include file="…" %>`, `<jsp:include page="…">`, `<c:import url="…">` with a literal relative or root path | page → included file |
| `<%@ taglib prefix="p" tagdir="/WEB-INF/tags/x" %>` then `<p:name …>` | page → `x/name.tag` |
| `<%@ taglib uri="…" %>` naming a TLD path, or a TLD's `<uri>` | page → `.tld` |
| TLD `<tag-class>`, `<function-class>`, `<tag-file><path>` | `.tld` → Java class or tag file |
| `<%@ page import="…" %>`, `<jsp:useBean class="…">` | page → Java class |

Prefixes are resolved through includes: a page that includes the
fragment declaring `p` can use `<p:…>`, as JSP's translation unit does.

LESS:

| Construct | Edge |
| --- | --- |
| `@import "…"` (any options, `.less` implied) | file → imported file |
| use of `@name` defined at top level elsewhere | file → defining file |
| call of a mixin `.name(…);` or `.name;` defined elsewhere | file → defining file |

A variable or mixin defined in more than three files draws no usage
edge, as Swift's type references do not: at that point the name is a
convention, and an edge to every definer invents coupling.

JavaScript imports of `.less` files already resolve on disk; they become
edges once LESS files are graph nodes.

### Scoring

Templates and stylesheets have no unit-test convention crimes can map, so
they are **outside the test-gap population**: `test_gap` is 0 for them,
as for documentation, and they do not shift the quartiles of the code
around them. Their blast radius is real and is scored.

### Detectors

Chosen for what fails silently, not for style. No escaping, scriptlet or
selector rules.

- `dangling_template_reference` (JSP): a literal include whose target
  does not exist; a `tagdir` tag with no `.tag` file; a call to a tag
  file that omits a `required="true"` attribute or passes one the tag
  does not declare (unless it declares `dynamic-attributes`). Each fails
  only at request time. Attributes passed as `<jsp:attribute name="…">`
  children count as passed.

Universal detectors (`large_file`, `todo_density`, `commented_out_code`
for LESS `//` comments) apply as they do to every discovered file.

A LESS override detector (a variable defined in several files of one
bundle, where lazy evaluation makes the last definition win everywhere)
was considered and deferred: theme files override variables on purpose,
and the estate has 204 multiply-defined names. It needs bundle import
order and a measured precision before it ships.

## Evaluation

- Apache Roller (fixture 17) already contains 92 JSPs; its results move.
- A public LESS code base is added as a fixture to measure the LESS graph
  and precision.
- The estate run is the acceptance check: include and tag resolution
  rates, and whether the top of `context` for a widely used tag lists its
  real users.
