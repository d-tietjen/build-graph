# Changelog

All notable changes to this project are documented here. The format loosely
follows [Keep a Changelog](https://keepachangelog.com/); this project uses
semantic versioning.

## 0.2.1

### Added

- **Agent integration templates** for Codex and Claude Code, with drop-in
  `AGENTS.md`/`CLAUDE.md` guidance for using bounded `find`/`refs` queries
  instead of text-searching blindly.
- **GitHub Action backend selection** — `references-backend: rustc-driver`
  installs the opt-in driver feature and runs the compiler-backed Layer 3 path;
  `references-backend: rust-analyzer` remains the default for existing
  workflows.

### Changed

- Streamlined the README into a shorter landing page and moved detailed CLI,
  layer, output, and query reference material to `docs/cli-reference.md`.
- **Watch refresh calculation** now flattens the enabled extraction layers on
  save: the graph still has Layer 1/2/3 semantics, but a save runs one full
  enabled-layer extraction pass instead of skipping per cached layer.

### Fixed

- **Live viewer refreshes** now keep the page mounted and patch in fresh graph
  data from VS Code / JetBrains live views, preserving layout and avoiding a
  full GPU/WebGL rebuild when the topology did not change.
- **rustc-driver reference coverage** now includes item-level signatures,
  fields, variants, trait/impl/foreign items, and constructor-qualified enum
  paths such as `EnumName::VariantName`.
- **Macro-expanded references** are now included in the rustc-driver backend.
  Driver edge files include resolved def paths, so declarative macros,
  function-like proc macros, attribute macros, and derive-generated methods can
  map onto graph nodes even when expansion spans point at macro definitions or
  shared invocation lines.

## 0.2.0

### Added

- **`cargo build-graph watch`** — watch the workspace and refresh the graph on
  every save. Reuses the existing per-crate incremental machinery (only changed
  crates are re-scanned/re-documented), excludes `target/`, the output dir, and
  `.git` to avoid feedback loops, and coalesces a burst of saves into one
  rebuild. Flags: `--no-build` (re-extract only) and `--debounce <ms>`.
- **rustc-driver references backend** (opt-in `rustc-driver` Cargo feature) — an
  alternative to the rust-analyzer SCIP backend for Layer 3. A clippy-style
  `RUSTC_WORKSPACE_WRAPPER` (the new `crates/bg-driver` crate) reads the
  compiler's HIR during `cargo check`, so references are **incremental for free**
  — cargo only re-runs it for the crates it recompiles. Enable per run with
  `--driver` (the driver is built on demand; cargo caches it) or point at a
  prebuilt binary with `--driver-bin`/`$BUILD_GRAPH_DRIVER`. Works in `build` and
  `watch`.
  - On a 108-crate workspace this turned a fixed **~328s** per-edit reference
    refresh (rust-analyzer re-indexes the whole workspace every time) into a
    **~12s incremental** one (~28× faster per edit, ~3.5× faster cold).
  - Tradeoff: the driver indexes the *semantic def-reference graph* rather than
    rust-analyzer's *syntactic occurrence graph* — its resolution is validated
    against ground truth (~88% call / ~80% use callee coverage vs scip), but it
    is **not** byte-identical (it sees through `use` imports and leaves
    item-level type declarations to Layer 2). Treat it as a faster,
    compiler-grounded reference source, not a drop-in rust-analyzer clone.
- **Per-layer timing** in the build output (e.g. `layer 3: … (rustc driver,
  11.8s)`), so backend choice and incremental behavior are visible at a glance.
- **Editor integrations** under `integrations/` — a VS Code extension (builds and
  runs) and a JetBrains/RustRover plugin scaffold. Each runs `watch` and shows
  the live architecture graph in-editor; neither duplicates the IDE's own
  go-to-def / find-usages.

### Notes

- The `rustc-driver` feature is **off by default**; the default build is
  unchanged and needs no nightly. The driver itself is a separate
  `#![feature(rustc_private)]` crate pinned to the same nightly as Layer 2.

## 0.1.0

- Initial release: Layer 1 (crates + source files from `cargo metadata` and
  dep-info), Layer 2 (`--rich`, nightly rustdoc JSON items), Layer 3
  (`--references`, rust-analyzer SCIP calls/uses), the `find`/`refs`/`context`
  graph queries, the bundled HTML viewer, the build-script `Builder` helper, and
  the `ARCHITECTURE.md` GitHub Action.
