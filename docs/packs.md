# Pack model

`crimes` groups detectors into **packs** based on what they need to
read. Each finding carries a `pack` field identifying its origin pack.

## Packs

- **`universal`** — Evidence is filename + bytes + git + IA index.
  Runs on every discovered file in every repo. Includes the asset
  pipeline (raster size, SVG content).
- **`language-js`** — Requires AST parsing via `@crimes/language-js`
  (TypeScript-ESTree). Runs only on `.ts/.tsx/.js/.jsx/.mjs/.cjs/.cts/.mts`.
- **`language-py`** (0.13.0) — Requires AST parsing via
  `@crimes/language-py` (tree-sitter-python). Runs only on `.py/.pyi`.
- **`cross-language`** (0.14.0) — Requires aligning artefacts from
  two or more language packs. Runs after every per-pack pass.

## Tier vs pack

Don't confuse `Finding.pack` (detector capability) with
`Finding.tier` (file scope). `pack` answers "what kind of evidence
produced this finding"; `tier` answers "was the file in the
domain-code scope or the non-domain scope".

## Coverage

Every `ScanReport.coverage` block reports how many files each pack
claimed:

```json
{
  "files_total": 412,
  "files_by_language": { "js": 412 },
  "files_universal_only": 0,
  "files_skipped": 0,
  "packs_loaded": ["language-js"]
}
```

The human reporter prints a one-line banner when >50% of files
were unclaimed; `--explain-coverage` prints the full breakdown.
