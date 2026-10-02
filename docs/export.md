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

## Optional compiler observations

`build --observe-compiler-inputs` adds `compiler_invocations` to the same sidecar.
Its independent `schema_version` is `1`; types are in
`build_graph::compiler_invocation` (the attachment and invocation types are also
re-exported from `export`). Without the flag the field is omitted, and the
existing graph, sidecar version, field order and compiler outcome retain their
legacy meanings. Old sidecars remain readable. Rust callers constructing
`ExportManifest` literals must add `compiler_invocations: None`.

The CLI installs its own stable `RUSTC_WRAPPER` only for that Cargo build. It
forwards the original argument vector unchanged, observes before/after files,
and joins each invocation to a non-fresh Cargo artifact by crate name, exact
source and output path. Ambiguous joins remain unbound. An existing nonempty
`RUSTC_WRAPPER` is rejected rather than replaced. A nested workspace wrapper is
forwarded; it may change the compiler command internally, which is outside this
observer's coverage. `update` and `watch --no-build` cannot create observations.
Each build has a new private run directory; cached artifacts never acquire old
invocations, and the directory is removed after collection. A subsequent build
without the flag removes the attachment.

The attachment also records actual normalized Cargo argv/cwd, allowlisted Cargo
environment and wrapper launch-executable observation. Each invocation records
ordered allowlisted arguments, cwd, source/unit and
Cargo package/manifest/target/profile/resolved-feature binding, actual queried
compiler identity/sysroot, configuration candidates, allowlisted effective env,
observed source/dep-info/extern/proc-macro/output bytes, mode and FNV marker, and
actual process exit outcome. Cargo build-script messages provide directive and
output observations; arbitrary generator subprocess commands and inputs remain
unknown. A Cargo feature-selection mode is also unknown. Rustc response files
are observed as files, **not expanded into a purported effective argument list**.

Paths are relative to named roots: `source`, `target`, `sysroot`, `dependencies`,
`host_tools`, `cargo_config`. Source/target come from Cargo metadata, sysroot from
the actual compiler query, tool paths from declared approved roots, and
Cargo-home dependency/config roots from the current environment. Additional roots
can be declared with repeated `--compiler-input-root NAME=PATH` for
`dependencies`, `host_tools` or `cargo_config`. Undeclared external paths become
gaps. Program aliases such as a rustup `rustc` shim preserve an `argv0=rustc`
prefix alongside their normalized resolved executable path. They are not silently
queried as the resolved shim's different program name.

Only known flags, semantic cfg values, target/profile/version values and declared
relative paths are exported. Unknown arguments and arbitrary cfg/env values are
withheld with gaps. There is no inherited environment dump. FNV markers for
withheld allowlisted env or directive values describe consistency only; they do
not reveal a complete execution meaning or qualify undisclosed inputs. Run config
contains machine paths privately with mode `0600`, in an exclusive `0700`
directory; it is not part of the export.

Linux file reads traverse held approved-root descriptors with `O_NOFOLLOW`, bind
the named leaf to its opened descriptor, and recheck root/ancestors/leaf after
reading. Replacement, symlink aliases or instability yield gaps without an
exported file fingerprint. On other platforms these file/identity observations
remain unavailable. Identity queries use nonblocking bounded reads, exact owned
process-group cleanup before reaping, and one three-second deadline including
cleanup. Failure to establish exit, pipe closure and group absence yields an
unavailable identity; no query retry is made.

Budgets are 128 invocations/build scripts, 512 arguments per invocation,
128 files/env entries per record, 4 KiB text, 32 KiB serialized invocation,
8 MiB serialized attachment, 8 MiB per file and 32 MiB read bytes per phase.
Oversized argument vectors emit only a bounded budget witness, without a
truncated command/unit that could hide differing argument tails. Every dropped
collection records `truncations` with `collection`, `observed`, `retained`, and
`count_exact`; an inexact count is a lower bound. Oversized generated directory
scopes drop that scope rather than retain an arbitrary enumeration subset.
Malformed, stale, conflicting or oversized attachments reject through
`CompilerInvocationsV1::from_json`/`validate` and the export read/write helpers.

The attachment always retains `unobserved_execution_inputs`; it is **observation,
not completeness, authenticity, trust or reuse authority**. Dep-info discovered
inputs are often observable only after execution. Sysroot membership, Cargo
configuration resolution, output membership, arbitrary env, response expansion,
nested wrapper modifications, rich rustdoc/reference passes and generator
subprocesses require independent qualification. A successful process or opaque
fingerprint cannot remove these gaps. Bind consumers to the exact outer sidecar
bytes as well as its graph, then independently qualify roots, bytes, toolchains,
external/runtime/test closure and all missing facts before narrowing work.
