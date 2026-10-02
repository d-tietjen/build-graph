# Compiler observation validation

These commands are prepared for the engineering validation owner on the
Linux validation server. They have not been run as part of source authoring.
Use the shared bounded job and its exact source/toolchain/input evidence.

```bash
cargo test --locked --lib compiler_invocation::tests
cargo test --locked --bin cargo-build-graph compiler_observer::tests
cargo test --locked --lib export::tests::sidecar_retains_colliding_definitions_and_binds_to_graph
cargo test --locked --test compiler_capture_flow
cargo test --locked --features rustc-driver --bin cargo-build-graph compiler_observer::tests
```

The actual CLI fixture compiles a local package with a generated include and a
proc-macro dependency. It checks legacy absence, actual ordered invocation to
Cargo/source/output binding, dep-info/proc-macro/generated observations, feature
change, cached-run non-reuse, portable serialization and attachment removal on a
later legacy run. Unit fixtures cover malformed/oversized/stale/conflicting/
partial records, change-sensitive serialized facts, secret withholding, argument
and collection cap accounting, descriptor replacement/alias rejection and query
cleanup with early stdout closure, overflow and inherited descendant pipes.

For the combined public producer → independently qualified comparison → native
planning flow, build the CLI once in the shared job and invoke the binary on the
reviewed source rather than hand-author observations:

```bash
cargo build --locked --bin cargo-build-graph
/approved/build-graph-target/debug/cargo-build-graph build \
  --manifest-path /approved/workspace/Cargo.toml \
  --observe-compiler-inputs --out /approved/output
```

The target location above is supplied by the shared job. No nightly feature is
required for compiler observation; richer rustdoc/reference passes are separate
and are explicitly outside this attachment's coverage. The downstream adapter
must bind the exact public commit and sidecar bytes, independently observe and
qualify actual execution inputs, and preserve mandatory runtime/test gates.
Public fixtures alone do not certify downstream planning reduction or authority.
