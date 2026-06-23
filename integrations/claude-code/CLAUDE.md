# build-graph code navigation (Claude Code template)

Copy this into the `CLAUDE.md` of a Rust project you analyze with Claude Code.
Claude Code loads `CLAUDE.md` as project memory and can run shell commands, so
this is all it needs - no plugin.

---

## Code navigation with build-graph

This workspace has a **build-graph** knowledge graph of its Rust code, built from
the compiler's output (crate/dep graph, rustdoc symbols) plus, with Layer 3
enabled, semantic `calls`/`uses` edges from rust-analyzer or the rustc driver and
owner-level `member_calls`/`member_uses` rollups for structs/enums/traits/modules.
To find where a symbol lives and how it connects (definition, callers/callees,
trait impls, type usage, across crates), prefer `cargo build-graph` over
`grep`/`rg`: the edges are resolved and exact, so it is faster and more complete
than text search.

If `ARCHITECTURE.md` exists, read it before inspecting code. Its build-graph
section is generated from the same graph and should be treated as the current
high-level map of crates, symbols, and relationships. Use the CLI queries below
to verify details or pivot into exact source locations.

**Prerequisite.** The graph is at `target/build-graph/graph.json.gz` (or a plain
`graph.json` if built with `--no-compress`; either is read transparently). If it
is missing, ask the human before building it. A full build is slow, needs a
nightly toolchain for the rich symbol layer, and may need network/toolchain
access. Prefer the rustc driver when `build-graph` was installed or built with
`--features rustc-driver`; otherwise fall back to rust-analyzer SCIP:

```bash
cargo build-graph build --rich --driver
# or:
cargo build-graph build --rich --references
```

Do not rebuild per query - the graph already exists if that file is present.
Rebuilds are incremental (only changed crates). Only `build` writes or may need
network/toolchain access; `find` and `refs` are read-only.

**Querying is read-only and safe to run any time.** `find`/`refs` only read the
graph file. Pass `--out target/build-graph` to read it directly (a pure file
read, no `cargo` subprocess; auto-finds `graph.json.gz`/`graph.json`), which also
works under a restrictive sandbox.

**The API is bounded: lead with `find` (counts), then `refs` for specifics.**
Pass `--json` whenever parsing the output; omit it for a quick human read.

- `cargo build-graph find <name> --json` locates symbols. Each match has
  `source_file` + `source_location` (open it) and `relationships`: a total plus
  per-relation counts split into `outgoing`/`incoming`. Read the counts to decide
  what is worth expanding. Many matches? It reports `total_matches` vs
  `returned`; narrow with `--exact`, `--kind <k>`, `--crate <c>`, `--limit`.
- `cargo build-graph refs <name|id> --json` expands one symbol's edges, bounded
  (default 50, hard cap 200) and filterable: `--relation <r>`,
  `--incoming`/`--outgoing`, `--match <substr>`, `--kind`, `--crate`. It reports
  `total_matching` vs `returned`. Pass a node `id` from `find` to target an
  exact symbol when a name is ambiguous.

**Common queries**

| Goal | Command |
|------|---------|
| Where is `X`, and how connected is it | `find X --json`, then `refs X --json` |
| Who implements a trait | `refs <Trait> --relation implements --incoming --json` |
| Who calls a function | `refs <fn> --relation calls --incoming --json` |
| What a function calls | `refs <fn> --relation calls --outgoing --json` |
| What types/consts a function uses | `refs <fn> --relation uses --outgoing --json` |
| What a struct/enum/trait's members call | `refs <type> --relation member_calls --outgoing --json` |
| What a struct/enum/trait's members use | `refs <type> --relation member_uses --outgoing --json` |
| Narrow a huge list | add `--crate <c>` / `--match <substr>` / `--kind <k>` |

Follow the `source_file:source_location` values from the results instead of
searching, then pivot by querying a neighbor you found. The `calls`/`uses` and
`member_calls`/`member_uses` edges exist only if the graph was built with
`--driver` or `--references`; without one of those Layer 3 backends you still
have definitions and structural edges (`implements`, `has_method`,
`takes`/`returns`, ...) but not the body-level call/use graph.
