# build-graph code navigation (Codex template)

Copy this into the `AGENTS.md` of a project you analyze with Codex (or into
`~/.codex/AGENTS.md` to enable it everywhere). Codex loads `AGENTS.md` before each
task and runs shell commands, so this is all it needs — no plugin.

---

## Code navigation with build-graph

This workspace has a **build-graph** knowledge graph of its Rust code, built from
the compiler's output (crate/dep graph, rustdoc symbols) plus — with
`--references` — semantic `calls`/`uses` edges from rust-analyzer and owner-level
`member_calls`/`member_uses` rollups for structs/enums/traits/modules. To find
where a symbol lives and how it connects (definition, callers/callees, trait
impls, type usage, across crates), prefer `cargo build-graph` over `grep`/`rg`:
the edges are resolved and exact, so it's faster and more complete than text
search.

**Prerequisite.** The graph is at `target/build-graph/graph.json.gz` (or a plain
`graph.json` if built with `--no-compress`; either is read transparently). If it's
missing, build it once (slow; needs a nightly toolchain, and `--references` needs
rust-analyzer installed):

```bash
cargo build-graph build --rich --references
```

Don't rebuild per query — the graph already exists if that file is present. Rebuilds
are incremental (only changed crates). Only `build` writes/needs the network; if it
hasn't been run, ask the human to run it rather than building it yourself.

**Querying is read-only and safe to run any time** — `find`/`refs` only read the
graph file. Pass `--out target/build-graph` to read it directly (a pure file read,
no `cargo` subprocess; auto-finds `graph.json.gz`/`graph.json`), which also works
under a restrictive sandbox.

**The API is bounded — lead with `find` (counts), then `refs` for specifics.** Pass
`--json` whenever you'll parse the output (stable shape); omit it for a quick read.

- `cargo build-graph find <name> --json` — locate symbols. Each match has
  `source_file` + `source_location` (open it) and `relationships`: a total plus
  per-relation counts split into `outgoing`/`incoming`. Read the counts to decide
  what's worth expanding. Many matches? It reports `total_matches` vs `returned`;
  narrow with `--exact`, `--kind <k>`, `--crate <c>`, `--limit`.
- `cargo build-graph refs <name|id> --json` — expand ONE symbol's edges, **bounded**
  (default 50, hard cap 200) and **filterable**: `--relation <r>`,
  `--incoming`/`--outgoing`, `--match <substr>`, `--kind`, `--crate`. It reports
  `total_matching` vs `returned`. Pass a node `id` from `find` to target an exact
  symbol when a name is ambiguous.

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
`member_calls`/`member_uses` edges (semantic, from rust-analyzer) exist only if
the graph was built with `--references`; without it you still have definitions
and structural edges (`implements`, `has_method`, `takes`/`returns`, …) but not
the body-level call/use graph.
