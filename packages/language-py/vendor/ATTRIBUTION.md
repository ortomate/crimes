# Vendored third-party assets

## `tree-sitter-python.wasm`

- **Upstream:** [`tree-sitter/tree-sitter-python`](https://github.com/tree-sitter/tree-sitter-python)
- **npm package:** `tree-sitter-python`
- **Version:** `0.25.0`
- **License:** MIT — full text in [`LICENSE.tree-sitter-python`](./LICENSE.tree-sitter-python)

The file is the prebuilt WebAssembly grammar shipped in the upstream npm
tarball, copied verbatim. It is not modified.

### Why it is vendored rather than depended on

`packages/cli` publishes as a single self-contained bundle: tsup inlines
every workspace package into `dist/index.js`, and the only real runtime
dependency is `typescript`. That rules out the native `tree-sitter`
addon, which cannot be bundled.

Depending on the `tree-sitter-python` npm package instead would pull 7.5
MB unpacked, ship per-platform `.node` prebuilds this pack never loads,
and run a `node-gyp-build` install script that falls back to compiling
from source when no prebuild matches the host. For a CLI whose canonical
first run is `npx crimes scan`, that is an install-failure mode we are
not willing to take on.

Vendoring the 448 KB grammar gives us a pinned, reproducible artefact
with no install scripts and no native code. The runtime that executes it,
`web-tree-sitter`, is a normal external dependency — also pure JS + WASM.

### Updating

1. `npm pack tree-sitter-python@<version>` and extract
   `tree-sitter-python.wasm` from the tarball.
2. Overwrite the file here and bump the **Version** field above.
3. Refresh `LICENSE.tree-sitter-python` if upstream changed it.
4. Run `pnpm verify` — the parser tests in `packages/language-py` cover
   every node type the detectors depend on, so a grammar change that
   renames or restructures a node fails there rather than silently
   producing zero findings.
