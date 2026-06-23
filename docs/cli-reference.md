# CLI, Layers, and Query Reference

This page keeps the details out of the main README while preserving the full
operational reference for `cargo build-graph`.

## CLI Commands

```bash
cargo install build-graph

cargo build-graph build
cargo build-graph watch
cargo build-graph update
cargo build-graph view
cargo build-graph serve

cargo build-graph build --rich
cargo build-graph build --rich --references
cargo build-graph build --driver

cargo build-graph context <name>
cargo build-graph find <name>
cargo build-graph refs <name-or-id>
```

The binary is installed as `cargo-build-graph` and invoked as
`cargo build-graph`. `build` runs `cargo build` and refreshes the graph from
`target/`; `watch` repeats that on every save; `update` re-extracts from the
current `target/`; `serve` loads the graph once so later
`find`/`refs`/`context` calls are instant.

Useful flags: `--manifest-path`, `--target-dir`, `--out <dir>`, `-p <crate>`,
`--release`, `--nightly <toolchain>`, `--no-derives`, `--references`,
`--driver`, `--driver-bin <path>`, and `--no-compress`.

`--driver` is available only when `build-graph` is built with the opt-in
`rustc-driver` Cargo feature:

```bash
cargo install build-graph --features rustc-driver
```

## Layers

| Layer | Source | Toolchain | Nodes | Edges |
|---|---|---|---|---|
| **1** | `cargo metadata` + dep-info `.d` | stable | crates, source files | `depends_on`, `contains` |
| **2** (`--rich`) | nightly rustdoc JSON | nightly | modules, structs, enums, traits, fns, methods, fields, type aliases, consts, statics | `implements`, `has_field`, `has_method`, `has_variant`, `takes`, `returns`, `uses_type`, `aliases` |
| **3** (`--references` / `--driver`) | rust-analyzer SCIP or the rustc driver | stable / pinned nightly | connects Layer 2 items | `calls`, `uses`, `member_calls`, `member_uses` |

Layer 2 items carry `source_file:line` and link up to their Layer 1 crate node.
Cross-crate type references resolve to other workspace crate nodes, so the
layers form one connected graph.

## Layer 3 Backends

rustdoc only sees signatures, so Layer 2 stops at the type level. Layer 3 reaches
into function bodies for the reference graph that makes "find every caller/use of
this symbol" work.

### rust-analyzer SCIP (`--references`)

The rust-analyzer backend runs `rust-analyzer scip` over the workspace, parses
the resulting index, maps symbols to Layer 2 nodes, attributes references to
their enclosing function, and emits `calls` or `uses` edges. Those exact
function-level references are also rolled up through the ownership graph as
`member_calls` and `member_uses`.

rust-analyzer needs to be installed (`rustup component add rust-analyzer`). If it
is absent, the layer is skipped with a message. The index is whole-workspace, so
large repositories pay the cold indexing cost on each reference refresh.

### rustc Driver (`--driver`)

The driver backend is a clippy-style `RUSTC_WORKSPACE_WRAPPER` that reads the
compiler's HIR during `cargo check`. It is incremental because cargo only re-runs
the wrapper for crates it recompiles.

```bash
cargo install build-graph --features rustc-driver
cargo build-graph build --driver
cargo build-graph watch --driver
```

`--driver` builds [`crates/bg-driver`](../crates/bg-driver) on demand the first
time and cargo caches it after that. Pass `--driver-bin <path>` or set
`BUILD_GRAPH_DRIVER` to use a prebuilt binary.

The driver replaces the SCIP pass: it runs `cargo check --all-targets` with the
driver as `RUSTC_WORKSPACE_WRAPPER`, persists per-crate edge files under
`<out>/driver-refs`, and maps them onto Layer 2 nodes. It indexes the semantic
def-reference graph, not rust-analyzer's syntactic occurrence graph, so treat it
as a faster compiler-grounded reference source rather than a byte-identical
rust-analyzer clone.

## Nightly + rustdoc-types Pin

rustdoc's JSON format is unstable and versioned. This repo pins
`rustdoc-types = "0.57"` (`FORMAT_VERSION = 57`), which matches
`nightly-2026-02-27`. The CLI checks the emitted `format_version` against the
pinned one and fails with a clear message on mismatch. Pass
`--nightly <toolchain>` to select a matching nightly, or bump the
`rustdoc-types` dependency.

Layer 1 never needs nightly, so the tool is still useful even if Layer 2 is off.

## Outputs

Written to `target/build-graph/` or `--out`:

- `graph.json.gz` - the graph data, gzip-compressed by default.
- `graph.json` - emitted instead when `--no-compress` is set.
- `graph.html` - force-directed viewer. Small graphs inline their data; large
  graphs fetch the data file beside the HTML and should be served over HTTP.
- `GRAPH_REPORT.md` - counts, largest crates, and the most-connected nodes.

Every command reads either `graph.json.gz` or `graph.json` transparently. The
format is detected by content, not extension.

Because the graph is graphify-compatible, you can also point graphify's MCP
server at a plain `graph.json`: build with `--no-compress` first, then run
`python3 -m graphify.serve target/build-graph/graph.json`.

## Querying

Two commands answer "where is this symbol and what connects to it":

- `find <name>` locates symbols and prints metadata plus relationship counts.
- `refs <name|id>` expands one symbol's relationships, bounded and filterable.

`find` reports `total_matches` vs `returned`; narrow with `--exact`,
`--kind <k>`, `--crate <c>`, and `--limit`.

```bash
cargo build-graph find OperationExecutor
cargo build-graph find Config --kind struct --json
```

`refs` supports `--relation`, `--incoming`, `--outgoing`, `--match <substr>`,
`--kind`, `--crate`, `--limit`, and `--depth N`. Pass a node id from `find` to
target one exact symbol when a name is ambiguous.

```bash
cargo build-graph refs Operation --relation implements --crate ep-azure
cargo build-graph refs Operation --relation implements --match advisor
```

Common queries:

| Goal | Command |
|---|---|
| Where is `X`, and how connected is it | `find X --json`, then `refs X --json` |
| Who implements a trait | `refs <Trait> --relation implements --incoming --json` |
| Who calls a function | `refs <fn> --relation calls --incoming --json` |
| What a function calls | `refs <fn> --relation calls --outgoing --json` |
| What types/consts a function uses | `refs <fn> --relation uses --outgoing --json` |
| What a type's members call | `refs <type> --relation member_calls --outgoing --json` |
| What a type's members use | `refs <type> --relation member_uses --outgoing --json` |

Both commands locate the graph via `--graph`, `--out`, or `--manifest-path`.
Build with `--rich` first; the symbol layer is what they search.

## Incremental Behavior

The CLI persists the graph plus a `.build-graph-cache.json` beside it. Each run
fingerprints every crate by source mtimes; unchanged crates are reused from the
prior graph, and only dirty crates are re-scanned or re-documented. Cross-crate
edges into a re-extracted crate survive because IDs are deterministic.

`cargo build-graph watch` does one refresh up front, then watches workspace
`.rs` and `Cargo.toml` files while skipping `target/`, the output dir, and
`.git`. A burst of saves coalesces into one rebuild. Pass `--no-build` to
re-extract from the current `target/`, `--debounce <ms>` to tune the settle
window, and normal build flags such as `--rich`, `-p`, and `--release` to control
each cycle.

Under `watch`, `--rich --references` still uses rust-analyzer's cold
whole-workspace SCIP index. For incremental Layer 3 refreshes, use
`cargo build-graph watch --driver`.

## Limitations

- The build-dependency produces Layer 1 only; a build script cannot safely run
  nightly rustdoc or nested cargo.
- Derive-generated impls add method nodes by default. Pass `--no-derives` to
  drop every `#[automatically_derived]` impl, its `implements` edge, and its
  methods from the rich layer.
- Without `--references` or `--driver`, body-level references (`calls`, `uses`,
  `member_calls`, `member_uses`) are not produced.
