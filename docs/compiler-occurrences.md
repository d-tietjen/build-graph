# Compiler occurrence observations

The distinct optional [semantic stream](compiler-semantic-stream.md) observes
the full local HIR domain with bounded pages and traversal terminals. The
legacy occurrence contract below remains unchanged.

The optional `CompilerInvocation.occurrences` field records definitions and
references visited by **that invocation's** `bg-driver` analysis callback. It
does not infer active definitions from source-file membership, Cargo features,
dep-info, a global graph, or a later rustdoc/reference pass. Older JSON omits this
field and remains readable. The graph, legacy IDs and ordinary stable capture
keep their existing behavior when occurrence capture is absent.

## Run the actual producer

Build the CLI with `rustc-driver` and supply the driver compiled against its
exact pinned `nightly-2026-02-27` toolchain and `rustc-dev` component:

```bash
cargo build --locked --features rustc-driver --bin cargo-build-graph
cargo +nightly-2026-02-27 build --locked --release --manifest-path crates/bg-driver/Cargo.toml
BUILD_GRAPH_DRIVER=/approved/bg-driver \
  /approved/cargo-build-graph build --manifest-path /approved/project/Cargo.toml \
  --observe-compiler-inputs --observe-definition-occurrences --rich
```

These commands are an execution plan; authoring has not executed them. The
occurrence option selects pinned nightly Cargo and its actual rustc for the
original build; any rich extraction uses the same selected nightly. A stable
compiler cannot load this `rustc_private` driver. `--nightly` selects a different
matching toolchain only when the supplied driver was built against it.

`--occurrence-cargo /approved/cargo` selects the **actual Cargo executable** for
that operation, including an independently qualified configuration exporter.
It defaults to the matching nightly Cargo. The actual metadata, build and rich
rustdoc Cargo launches use that selected executable directly. The matching
nightly rustc and rustdoc paths are delivered explicitly through `RUSTC` and
`RUSTDOC`; metadata/docs remove compiler observation wrappers. The build retains
its original wrapper and callback route. An executable path is an observation,
not its authentication.
The source, binary and any patched Cargo must be qualified independently for the
same operation; a stable Cargo/configuration receipt cannot be relabelled as a
nightly execution receipt. Existing workspace wrappers are rejected for this
explicit route. Ordinary stable capture continues to use its original Cargo.

For a supplied compiler, rustdoc and sysroot with no ambient discovery, see
[explicit tool inputs](explicit-toolchain-inputs.md). Omission keeps the current
discovery behavior.

### Actual Cargo operations

The optional `CompilerInvocationsV1.cargo_operations` schema-1 attachment records
the actual launch sites in one outer extraction pass: initial metadata, build,
post-build metadata, and docs when the rich layer needs a refresh. Each record
contains a monotonically increasing ordinal, kind (`metadata`, `build`, `docs`),
fresh session/request consistency marker, ordered normalized command, cwd,
allowlisted delivered environment, selected executable endpoint facts, normalized
tool/wrapper paths and the actual started/status outcome. Failed docs retain their
original partial/unknown-freshness behavior. A failed build/metadata operation
still fails the outer command and does not publish a successful export.

`BUILD_GRAPH_CARGO_OPERATION` carries the request marker on the actual command.
It has no secret values and creates no owner capability. A descendant can inherit
or copy it. A forwarding executable is recorded as the selected program; the
observer does not relabel its endpoint bytes as the delegated Cargo's identity.
Every operation and session retains `unobserved_execution_inputs`. An external
consumer needs independently qualified outer/Cargo artifacts and genuine kernel
fork, exec and birth lineage to authenticate a nested launch. There is no first
matching executable, nonce, environment or JSON authority rule.

There are at most 16 retained launches, 32 KiB per record and 256 KiB per session;
the session is also charged to the original 8 MiB attachment assembly cap. Ordered
arguments and environment keep their original count/text caps, with byte/count
loss witnesses. Executable endpoint reads share 32 MiB, at most 8 MiB per read,
through approved roots. Outside-root or oversized tools remain unknown. Exported
paths are portable and unsafe environment/argument bytes have no fingerprint.
The session stays alive until extraction/export finishes; its owned wrapper files
are removed on success and errors. Each refresh creates fresh correlations.

The optional separate semantic driver `cargo check` route, driver preparation,
tool identity queries and watch startup metadata are outside this operation
attachment. Watch startup still uses the selected Cargo; each refresh exports its
own actual extraction pass. Legacy capture omits `cargo_operations` and retains
its metadata/build/rustup-doc paths. These facts do not prove a merged Cargo
configuration, compiler consumption or complete runtime/input closure.

## Version 1 contract

The record is bound to the enclosing invocation's ordered normalized command
consistency marker, crate name and metadata, plus a fresh run/slot nonce. A
private, exclusive request names the exact source and approved source/target
roots. The driver verifies the actual compiler crate, metadata and entry source
before collecting. The wrapper retains output only after successful compiler
exit, a stable private output read and exact request correlation. It checks each
source-map buffer's byte count and marker against a stable anchored file read.
Cargo's later exact unit join is included in the final serialized invocation.
The optional `occurrence_driver` file observation separately records the actual
workspace-wrapper binary before/after execution. Cargo's supplied rustc binary
and its queried identity remain separate from the driver hosting rustc_driver.

Each definition includes:

- Original package, named definition path and extractor kind.
- The original `definition:v1:...` identity key and unchanged legacy item ID.
- Its full original compiler span: one-based lines, **zero-based character
  columns**, exclusive end. No line tolerance, enclosing-function rollup or
  coordinate rebasing is used.
- A portable source/target relative path, byte count and FNV consistency marker
  of the compiler-owned source-map buffer. This differs from a post-run `.d`
  membership observation.

References include both full definition tuples, the actually visited reference
range and source buffer, and the original relation/EXTRACTED confidence/score/
weight. Local `calls` and `uses` are observed from the original HIR visitor.
External package identities, unsupported compiler paths (such as anonymous impl
or closure paths), and source macro expansions without an exact named span stay
explicit gaps. Unobserved HIR domains remain `analysis_coverage_partial`.

These records contain **no global attachment ordinals**. A downstream adapter may
assign an ordinal only by unique exact matching against its original immutable
normalized attachment, package resolver identity and qualified byte mapping.
Same-key duplicates or ambiguous ranges remain incomplete. An adapter with a
different coordinate convention must explicitly normalize that boundary and
verify actual source-map/rustdoc agreement; it must not guess a shift.
For the pinned Rust commit `6a979b3e32522049d0acb4a47f7ae44b7c8abfd5`,
`src/librustdoc/json/conversions.rs` adds one to both compiler `CharPos`
columns when writing rustdoc JSON. The actual rich-extraction regression uses
that checked conversion, including a Unicode prefix; callback columns remain
zero-based characters and the end remains exclusive.

Target files can expose genuine generated definition buffers, but retain
`generator_lineage_unknown`. Public capture cannot authenticate an arbitrary
generator command, its inputs, output custody, or which of several identical
outputs was consumed. A separate original owner must establish those facts.

## Bounds and incomplete outcomes

Each callback record has at most 64 definitions, 64 references and 24 KiB JSON.
Compiler source buffers are limited to 8 MiB each and 32 MiB cumulatively. The
existing 32 KiB invocation and 8 MiB attachment caps still apply. Duplicate
records, malformed identities/ranges, inconsistent source buffers or packages,
unaccounted generated inputs and stale/wrong invocation outputs are rejected.
Overflow keeps bounded partial callback facts with `budget_exceeded`, or drops
the optional record with the enclosing invocation's explicit budget gap.
Before retaining each definition or reference, the driver reserves JSON space
for all callback gap kinds. A later rejected tuple can therefore add its budget
gap without invalidating the retained record. References keep their original
definition endpoints; the driver does not trim accepted definitions to make room
for gaps. The reservation may omit a tuple earlier than the raw 24 KiB limit.

Cached Cargo artifacts do not run a callback and cannot manufacture an occurrence
record. A missing, failed or unsupported callback remains an invocation gap.
FNV markers and these observations provide consistency, **not** cryptographic
integrity, complete effective configuration, process custody, execution-input
qualification or reuse permission. No new admission or execution owner is
introduced. The existing enclosing build/driver diagnostics report only bounded
counts and sanitized acceptance/publication failure categories.

See [validation selectors](compiler-input-validation.md) for the actual-driver
and reader regressions. No authored selector is passing evidence.

The optional Linux [held callback controls](held-callback-controls.md) deliver the
same request schemas through immutable descriptors before the actual driver child.
Omission retains the ordinary path handoff; the transport grants no custody.
