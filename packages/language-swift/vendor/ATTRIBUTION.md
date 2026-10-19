# Vendored third-party assets

## `tree-sitter-swift.wasm`

- **Upstream:** [`alex-pinkus/tree-sitter-swift`](https://github.com/alex-pinkus/tree-sitter-swift)
- **Release:** [`0.7.3`](https://github.com/alex-pinkus/tree-sitter-swift/releases/tag/0.7.3), asset `tree-sitter-swift.wasm`
- **SHA-256:** `0258a7ef17303a8079ffe0748b3583d59656b5c3e8653fca7b6451b3e6689eb2`
- **License:** MIT — full text in [`LICENSE.tree-sitter-swift`](./LICENSE.tree-sitter-swift)

The prebuilt WebAssembly grammar published on the upstream GitHub
release, copied verbatim and not modified. The npm package
(`tree-sitter-swift`) ships only a native addon and a `node-gyp-build`
install step, so the release asset is the WASM source. Vendored for the
reasons in `packages/language-py/vendor/ATTRIBUTION.md`. It loads on the
shared `web-tree-sitter` runtime (grammar ABI 15).

### Measured

On a private iOS app, 1,604 `.swift` files (264k lines) parse in 3.7 s; 68
(4%) report syntax errors — chained `as?` casts with `??`, and some
generic `typealias … where` clauses. They are reported under
`files_partial_parse` with subject `language-swift`.

### Updating

1. Download `tree-sitter-swift.wasm` from the new release's assets.
2. Overwrite the file here and update **Release** and **SHA-256**.
3. Refresh `LICENSE.tree-sitter-swift` if upstream changed it.
4. Run `pnpm verify`.
