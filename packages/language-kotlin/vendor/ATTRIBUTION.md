# Vendored third-party assets

## `tree-sitter-kotlin.wasm`

- **Upstream:** [`tree-sitter-grammars/tree-sitter-kotlin`](https://github.com/tree-sitter-grammars/tree-sitter-kotlin)
- **npm package:** `@tree-sitter-grammars/tree-sitter-kotlin`
- **Version:** `1.1.0`
- **SHA-256:** `7009d69453bc8735e438b2818a633efb21c88f99782769abba60dffedfab73f7`
- **License:** MIT — full text in [`LICENSE.tree-sitter-kotlin`](./LICENSE.tree-sitter-kotlin)

The prebuilt WebAssembly grammar from the upstream npm tarball, copied
verbatim and not modified. Vendored for the reasons recorded in
`packages/language-py/vendor/ATTRIBUTION.md`: no native addon, no install
script, one pinned artefact. It loads on the `web-tree-sitter` runtime the
Python pack initialises (grammar ABI 14).

At 3.4 MB it is the largest of the vendored grammars. It loads only when
the first `.kt` / `.kts` file is parsed.

### Measured

On a private Android app, 1,645 `.kt` files (198k lines) parse in 2.4 s; 28
report syntax errors, most of them whole-file errors in the generated
OpenAPI client under `api/`. Those files are reported under
`files_partial_parse` with subject `language-kotlin`.

### Updating

1. `npm pack @tree-sitter-grammars/tree-sitter-kotlin@<version>` and
   extract `tree-sitter-kotlin.wasm`.
2. Overwrite the file here and update **Version** and **SHA-256**.
3. Refresh `LICENSE.tree-sitter-kotlin` if upstream changed it.
4. Run `pnpm verify`.
