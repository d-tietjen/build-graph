# CLI, Layers, and Query Reference

This page keeps the details out of the main README while preserving the full
operational reference for `cargo build-graph`.

## CLI Commands

```bash
cargo install build-graph --locked

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
cargo install build-graph --locked --features rustc-driver
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

The driver reads resolved HIR references and MIR control flow during
`cargo check`. Cargo reuses compilation and capture artifacts for unchanged
units. Install the pinned nightly with its driver components before using it.

```bash
rustup toolchain install nightly-2026-02-27 --component rustc-dev --component llvm-tools-preview
cargo install build-graph --locked --features rustc-driver
cargo build-graph build --driver --nightly nightly-2026-02-27
cargo build-graph watch --driver --nightly nightly-2026-02-27
```

`--driver` builds the driver on demand the first time and Cargo caches it after
that. Source checkouts use [`crates/bg-driver`](../crates/bg-driver); registry
installs unpack embedded sources under `$XDG_CACHE_HOME/build-graph/drivers`
(or `$HOME/.cache/build-graph/drivers`), keyed by their content digest. No Git
checkout is required. These sources and build outputs remain useful while that
installed driver version is used. Pass `--driver-bin <path>` or set
`BUILD_GRAPH_DRIVER` to use a prebuilt binary; `BUILD_GRAPH_DRIVER_SRC` retains
its source-override precedence.

For release verification, run `python3 scripts/verify_packaged_driver.py`
with Python 3.11 or later. It installs the Cargo archive, removes the extracted
source, and checks a resolved method call and captured MIR flow.

The driver stores per-unit references and MIR alongside the graph output.
Resolved definition paths let it map macro-expanded code even when several
items share a source location. Dependency ownership uses exact Cargo package
IDs. Native analysis follows FFI links and direct calls where compiled
artifacts provide evidence.

## Explore the Viewer

Run `cargo build-graph view` from the captured workspace. If you set
`--out` during capture, pass it to `view` as well. Small graphs embed their
data in `graph.html`. For larger captures, the viewer serves the HTML and
graph data together over local HTTP.

### Browse Structure and Calls

In **Graph controls**, choose **Field** to show architecture relationships or
**Function graph** to focus on callable nodes and directed edges. Choose
**Network**, **Radial**, or **Tree · left to right** to arrange the graph. Node
and connection type filters refine the preset. The package tree groups Rust
toolchain code, workspace code, and dependencies. Select a folder to focus it,
or use its eye icon to change visibility. **Show all** and **Hide all** reset
folder visibility. Use the minimap to navigate while keeping the main zoom.

Select a function to inspect its source and the connected callers and callees.
To connect two functions, use **Use as call-path start** and **Use as call-path
destination** on graph nodes, then select **Find connecting calls** in **Call
paths**. The result includes intermediate functions and source-linked
callsites. Graph filters can hide intermediate nodes without changing the
captured call-path query.

From a source checkout, use
`node scripts/audit-call-graph.cjs --graph path/to/graph.json --out path/to/audit`
to list callables with no captured edges. Add `--source-root` to include
identifier matches from the captured source. Review those matches and capture
coverage before deciding whether an isolated callable is unused.

### Explore Execution

**Execution flow** opens the statechart for every recorded MIR block and
successor in the selected build configuration. Zoom into a procedure to see
branches, loops, calls, returns, and unwind paths. Pin multiple procedures to
highlight recorded routes that include all pins. Binary entry points anchor
application flow. External or dynamic calls remain marked where their target
or body is uncertain.

From a function's details, open **Flamegraph** or **UML sequence** for bounded
request variants. Select a variant, then expand a frame to inspect the full
captured execution flow. The call-order view uses compiled-event steps. The
aggregate flamegraph groups matching stacks. Import benchmark or profiling
data in **Performance measurements** to view measured performance.
Compiler capture covers the selected targets and configuration. Structural
routes may include branches whose runtime feasibility is unknown. Use
`--driver` to collect MIR. SCIP captures support the architecture and
reference views.

### Choose an Analysis Tab

| Tab | Start here |
| --- | --- |
| **Graph controls** | Choose what to show and how to lay out the graph. |
| **Call paths** | Pick a start and destination to see the captured connecting calls. |
| **Dependency advisories** | Load a local OSV snapshot and check whether captured routes reach affected dependencies. |
| **Comments and documentation** | Search by keyword and select a match to open its symbol or source. Expand semantic options to configure a trusted embedding endpoint. |
| **Performance measurements** | Load a measurement snapshot or import request, then choose a benchmark or profile. |
| **Entry points and effects** | Select an entry to follow reachable effects, or select an effect to trace possible entries. |
| **Compare builds** | Export the current build with its query selectors, then compare two snapshots. |
| **Test candidates** | Provide a function signature, expected behavior, and sample inputs to generate a reviewable Rust test. |
| **Resources and concurrency** | Specify operations and any known bounds to inspect allocation, loop, or lock-order candidates. |
| **Failure and cleanup** | Declare resource transitions and permitted exit states to check captured cleanup paths. |
| **Required guards** | Identify the operation, guard callsites, and the arguments that must match. |
| **Value flow** | Specify source and destination value positions to inspect supported flow through recorded operations. |
| **Ordered paths** | Start at a function or entry and list the captured events in order. Add exclusions when needed. |

Model-based analyses use editable JSON templates with exact captured IDs.
Select a procedure or callsite in **Execution flow** to inspect its ID.
Expand the evidence below a result for coverage, source references, and a
replay request. Explicit embedding actions send comment or query text to the
configured endpoint. The [agent analysis reference](agent-analysis.md)
describes the request schemas and what each result can establish.

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
- `graph-export.json` - definition identities, complete source spans where
  captured, and extraction provenance. See [export metadata](export.md).
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
`.git`. A burst of saves coalesces into one rebuild. On save, watch runs one
flattened extraction pass across every enabled graph layer, so Layer 1/2/3 stay
in lockstep even though they remain separate concepts in the output graph.
Cargo, rustdoc, and the rustc-driver backend still reuse their own caches under
that pass. Pass `--no-build` to re-extract from the current `target/`,
`--debounce <ms>` to tune the settle window, and normal build flags such as
`--rich`, `-p`, and `--release` to control each cycle.

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

## Observing compiler inputs

With the `rustc-driver` feature, `--observe-definition-occurrences` additionally
captures actual analysis-callback definitions/references in that original build.
It requires `--observe-compiler-inputs`, matching nightly Cargo/rustc-dev and a
matching `bg-driver`. `--occurrence-cargo PATH` can select the actual matching
Cargo producer for actual metadata, build and rich docs launches. Matching rustc
and rustdoc are delivered explicitly. Optional bounded `cargo_operations` records
the actual per-pass launch requests and outcomes; paths/requests are observational
and cannot authenticate nested process lineage. See
[the occurrence contract](compiler-occurrences.md).

`--observe-semantic-stream` additionally traverses the whole local HIR domain
into bounded pages and an observational terminal. It requires both observation
options above. Legacy occurrence records remain partial, and all optional streams
share the original attachment allowance. See the
[semantic stream contract](compiler-semantic-stream.md).

```bash
cargo build-graph build --observe-compiler-inputs
cargo build-graph build --observe-compiler-inputs \
  --compiler-input-root dependencies=/approved/dependencies -- --features selected
```

This stable opt-in observes the actual build's compiler invocations and attaches
portable, bounded facts to `graph-export.json`. It does not need `rustc-driver`.
Existing `RUSTC_WRAPPER` configurations must be removed or left unobserved;
the CLI refuses to replace them. `update` and `watch --no-build` reject this flag.
See [the observation contract](export.md#optional-compiler-observations) for root
names, redaction, explicit gaps, budgets and compatibility.
