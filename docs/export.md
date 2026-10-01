# Export metadata

The CLI writes `graph-export.json` next to `graph.json` or `graph.json.gz`.
The graphify JSON and build-script helper keep their existing formats. This
sidecar is for consumers that need original definition identities, complete
definition spans, and extraction provenance. The build-script helper does not
produce it; absence means provenance is unknown.

The public Rust types live in `build_graph::export`. Read and write helpers are
`build_graph::output::{read_export, write_export}`. `schema_version` is currently
`1`; readers must reject unsupported versions. Fields may be added within a
version. Enum values and existing field meanings require a new version to change.

## Definitions and identities

`definitions` contains one record per modeled rustdoc item, before legacy graph
ID merging. Each record links to `graph_node_id` and retains the exact Cargo
package name, `::`-joined definition path, and extractor kind. Case and punctuation
are preserved. Several records can share a graph node ID because the existing
graph IDs lowercase and normalize punctuation. Consumers must retain all records
instead of making a map keyed only by `graph_node_id`.

`DefinitionIdentity::key()` encodes the original identity tuple as
`definition:v1:<package hex>:<path hex>:<kind hex>`. Each component uses lowercase
hex of the original UTF-8 bytes. Encoding is lossless and preserves case. Package
names are scoped to this workspace; this is not a registry-wide package key. The
extractor's paths also retain its existing associated-item ownership convention;
same-named methods from multiple trait impls can have the same identity tuple.
Keep their separate records and spans when that distinction matters.

Spans copy rustdoc's `filename`, `begin`, and exclusive `end`. Lines and columns
are **one-based**, and no coordinate rebasing is applied. Rustdoc counts columns
in characters; they are not UTF-8 byte offsets. Filenames use `/` and retain
rustdoc's relative or absolute form. A missing span remains `null`. The old
graph's `source_location` remains its start line.

## Status and freshness

Each layer reports `complete`, `skipped`, or `partial`. Item outcomes also identify
each package and its reason. A successful CLI exit can still produce partial or
skipped layers. Package restrictions, packages without library targets, and
libraries with `doc = false` are explicit skips; a mixture of complete and skipped
packages is a partial workspace layer. Documentation selects library targets only.
Retained JSON for each selected library is removed before the doc invocation, so
a successful command without newly produced JSON reports partial status with
unknown freshness. A failed `cargo doc --keep-going` run can ingest newly produced
JSON, but that output is partial with unknown freshness, even if every file parses.

`current` item freshness requires a successful doc invocation, a newly produced
parseable artifact for that package, and an unchanged, fully read observed source
set. `stale` means that observed sources changed.
`unknown` means no such association was established. Source observations cover
`.rs`, `Cargo.toml`, and `Cargo.lock` files under each package root; target/output
and hidden directories are excluded. This does not enumerate every compiler input,
environment variable, generated artifact, dependency, or non-Rust `include!`
input. Dep-info membership coverage and per-target semantic-reference coverage
are currently unmeasured, so those layers conservatively report partial status.

The compiler report records the actual Cargo build outcome and artifact messages.
Artifact `fresh` is Cargo's cache-reuse flag. `update` and `watch --no-build` report
compiler status `unknown`; they do not infer success from artifacts on disk.
Reused items without a build have unknown freshness. A new successful rustdoc
extraction can qualify its own item output independently of the build report.
Consumers requiring stronger input coverage should qualify the source set and
compiler evidence themselves.

## Binding and cache reuse

The graph and sidecar are separate atomic writes. Before consuming or reusing a
sidecar, call `ExportManifest::matches_graph(&graph)` (or implement the same check)
to ensure its graph binding matches. Missing, unsupported, or mismatched metadata
does not establish completeness. Incremental extraction only reuses provenance
that matches the graph and source observations. Partial item packages are retried.
Incremental replacement invalidates all current packages sharing a normalized
graph namespace with a changed or removed package. Definitions and provenance
are rebuilt together with those nodes; packages outside the requested item scope
report a skip and discard invalidated definitions.

Content fingerprints are stable FNV-1a 64-bit markers encoded
`fnv1a64:<16 lowercase hex digits>`. The graph marker covers its compact,
uncompressed `GraphJson` serialization. Each file marker covers its bytes. A source
snapshot marker covers files sorted by workspace-relative path, concatenating
each path and file marker as a little-endian unsigned 64-bit byte length followed
by UTF-8 bytes. These detect ordinary consistency mistakes; they are not
cryptographic hashes or authenticity proofs. Consumers needing those guarantees
must independently hash their source and graph bytes.
