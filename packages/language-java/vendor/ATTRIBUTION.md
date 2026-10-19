# Vendored third-party assets

## `tree-sitter-java.wasm`

- **Upstream:** [`tree-sitter/tree-sitter-java`](https://github.com/tree-sitter/tree-sitter-java)
- **npm package:** `tree-sitter-java`
- **Version:** `0.23.5`
- **SHA-256:** `4fdeac4ca6ca089f06c6f7e562abcac1733cd465728cc7031ebb73c2019122c4`
- **License:** MIT — full text in [`LICENSE.tree-sitter-java`](./LICENSE.tree-sitter-java)

The file is the prebuilt WebAssembly grammar shipped in the upstream npm
tarball, copied verbatim. It is not modified. It is vendored for the
reasons recorded in `packages/language-py/vendor/ATTRIBUTION.md`: no
native addon, no install script, one pinned artefact.

### Known grammar gap

0.23.5 does not parse a `final` modifier inside a type pattern
(`case final Film film ->`, Java 21+). Files using it parse with an
`ERROR` node around that arm; the scan reports them under
`files_partial_parse` with subject `language-java`, and detectors run on
the part that parsed. On a private 2,333-file Java corpus this was 16 of 2,333
files.

### Updating

1. `npm pack tree-sitter-java@<version>` and extract
   `tree-sitter-java.wasm` from the tarball.
2. Overwrite the file here and update **Version** and **SHA-256**.
3. Refresh `LICENSE.tree-sitter-java` if upstream changed it.
4. Run `pnpm verify` — the parser tests cover every node type the
   detectors depend on.
