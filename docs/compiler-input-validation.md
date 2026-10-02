# Compiler observation validation

These commands are prepared for the engineering validation owner on the
Linux validation server. They have not been run as part of source authoring.
Use the shared bounded job and its exact source/toolchain/input evidence.

```bash
cargo test --locked --lib compiler_invocation::tests
cargo test --locked --bin cargo-build-graph compiler_observer::tests
cargo test --locked --bin cargo-build-graph tests::watch_observation_conflict_is_rejected_by_clap
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
Focused source-correction fixtures additionally cover the exact 16 KiB retained
query cap while overflow is discarded, conservative read reservations after
partial failures and repeated unstable files, shared compiler quotas, empty and
exact read boundaries, post-Cargo-join 32 KiB overflow, exact 8 MiB aggregate
admission and precise record loss counts. The actual Cargo fixture keeps an
inherited observer variable and invokes both CLI forms from its build script.
CLI fixtures cover all supported direct/cargo subcommands under inherited
observer configuration, original non-UTF-8 argument delegation through a nested
wrapper, and terminal `watch --no-build --observe-compiler-inputs` rejection
within a three-second test deadline before metadata or watch activity.

These source-correction selectors are part of the same shared artifacts above:

```text
compiler_invocation::tests::serialized_size_counts_exact_bytes_without_retaining_overflow
compiler_observer::tests::query_retention_discards_all_bytes_after_the_exact_cap
compiler_observer::tests::failed_and_unstable_reads_spend_quota_and_compiler_shares_it
compiler_observer::tests::read_reservation_preserves_empty_exact_and_over_budget_boundaries
compiler_observer::tests::wrapper_shape_preserves_direct_cli_and_nested_compiler_arguments
compiler_observer::tests::cargo_join_size_loss_keeps_exact_count_and_budget_gap
compiler_observer::tests::exact_record_and_aggregate_limits_preserve_facts_and_account_for_overflow
compiler_observer::tests::malformed_record_does_not_discard_other_valid_records
tests::watch_observation_conflict_is_rejected_by_clap
inherited_observer_environment_preserves_direct_and_cargo_cli_dispatch
watch_no_build_observation_conflict_rejects_before_metadata_or_watch
real_and_nested_wrapper_dispatch_preserves_original_os_arguments
compiler_observer::tests::private_wrapper_entry_is_not_an_observed_root_grant_and_cleanup_unlinks_it
inherited_observer_configuration_does_not_execute_non_utf8_cli_arguments
actual_cargo_direct_custom_rustc_keeps_queries_build_and_inherited_cli
actual_cargo_nested_custom_rustc_keeps_queries_build_and_inherited_cli
```

The PUB-004 successor uses the same shared C4 artifacts. Its actual Cargo cases
set `RUSTC` to a custom forwarding executable, exercise direct and nested workspace
wrapper routes, observe genuine compiler version queries and compilations, invoke
both normal CLI forms from the inheriting build script, check explicit unknown
observation facts, and check owned run cleanup. The delegation fixture covers
`rustc`, custom, CLI-colliding and non-UTF-8 executable names, non-UTF-8 arguments,
and unchanged zero/nonzero exit codes. An inherited direct CLI non-UTF-8 argument
must be rejected as a CLI argument rather than executed. The private alias fixture
checks that descriptor readers refuse the symlink and cleanup retains the target.

These are authored cases, not compiled counts or passing results. Retain every
existing C1–C6 requirement and the separate C7 combined acceptance requirement;
this routing correction does not qualify inputs or replace any of those checks.

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
