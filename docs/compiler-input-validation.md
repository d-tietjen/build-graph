# Compiler observation validation

## Semantic stream

The distinct [semantic stream](compiler-semantic-stream.md) adds the following
source selectors to the same driver/CLI artifact job. No selector has been run
while authoring. Preserve all existing default, driver, legacy occurrence and
selected-Cargo cases.

```text
compiler_semantic::tests::empty_observed_domain_and_interruption_counts_are_distinct
compiler_semantic::tests::page_binding_order_and_terminal_totals_reject_substitution
compiler_semantic::tests::page_limits_and_unknown_fields_preserve_distinct_legacy_shape
compiler_semantic::tests::terminal_overflow_and_false_emitted_totals_reject
compiler_semantic::tests::bounded_deserialization_and_encoded_page_limit_are_independent
compiler_semantic::tests::source_versions_retain_each_association_and_reject_conflicting_version
compiler_observer::tests::semantic_page_reader_binds_actual_request_and_shares_source_work
compiler_observer::tests::semantic_page_reader_rejects_inventory_before_page_allocation
compiler_observer::tests::semantic_page_reader_rejects_changed_page_and_missing_terminal
compiler_observer::tests::semantic_streams_cannot_reset_attachment_assembly_allowance
actual_full_hir_domain_spans_pages_and_preserves_legacy_partial_record
actual_unsupported_resolution_and_long_definition_are_counted
actual_source_work_limit_is_shared_across_files_and_pages
actual_per_file_limit_reports_interruption_without_terminal_success
actual_output_overflow_keeps_committed_pages_and_interrupted_terminal
```

Use `cargo test --locked --lib compiler_semantic::tests`, the original observer
binary selectors, and the feature-enabled `compiler_semantic_flow` integration
target with the same mandatory actual `BUILD_GRAPH_DRIVER`. These are execution
instructions for the validation job, not evidence of a passing run.

## Actual driver occurrences

The optional occurrence producer adds the same-job gates below. Build the driver
against its exact pinned nightly plus `rustc-dev`, and supply the **actual** binary
through `BUILD_GRAPH_DRIVER` to the feature-enabled Linux integration suite. These
cases fail when that binary is unavailable; skipping them is not qualification.
The standalone lock copies the full serde/serde_json transitive closure already
pinned by the root lock. Its resolution and compilation remain required gates.

```bash
cargo +nightly-2026-02-27 metadata --locked --manifest-path crates/bg-driver/Cargo.toml
cargo +nightly-2026-02-27 build --locked --release --manifest-path crates/bg-driver/Cargo.toml
cargo +nightly-2026-02-27 test --locked --manifest-path crates/bg-driver/Cargo.toml occurrences::tests
cargo test --locked --lib compiler_occurrence::tests
cargo test --locked --lib compiler_invocation::tests
cargo test --locked --bin cargo-build-graph compiler_observer::tests
BUILD_GRAPH_DRIVER=/approved/bg-driver cargo test --locked --features rustc-driver --test compiler_occurrence_flow
```

Run the existing default and `rustc-driver` checks, actual CLI fixtures and all
original combined acceptance gates on the same reviewed source. When a patched
Cargo is selected, set `BUILD_GRAPH_TEST_OCCURRENCE_CARGO` to its qualified exact
matching-nightly executable and include the genuine configuration/occurrence/
original-owner consumer operation. Source metadata, build receipts and actual
selected tool identities are separate prerequisites. No prior stable Cargo
receipt is evidence for this nightly operation. See the
[occurrence contract](compiler-occurrences.md) for remaining authority gaps.

New authored selectors include:

```text
compiler_occurrence::tests::exact_occurrences_round_trip_without_attachment_ordinals
compiler_occurrence::tests::malformed_unknown_and_oversized_occurrences_reject
compiler_occurrence::tests::duplicate_conflicting_identity_and_buffer_reject
compiler_occurrence::tests::references_require_exact_both_endpoints_and_consumed_source
compiler_occurrence::tests::generated_buffer_requires_explicit_unknown_lineage
compiler_occurrence::tests::original_ranges_and_portable_buffers_are_validated
compiler_occurrence::tests::cumulative_source_buffer_budget_is_finite
compiler_invocation::tests::occurrence_absence_preserves_legacy_json_and_exact_identity_grammar
compiler_invocation::tests::occurrences_bind_successful_exact_ordered_invocation
compiler_observer::tests::fresh_callback_reader_accepts_exact_stable_source_and_success
compiler_observer::tests::callback_reader_rejects_stale_wrong_invocation_and_failed_compiler
compiler_observer::tests::callback_reader_rejects_changed_missing_and_oversized_buffers
compiler_observer::tests::callback_reader_rejects_linked_and_nonprivate_output
actual_driver_exact_definitions_ranges_and_reference_edges_bind_invocation
actual_driver_conditional_membership_is_not_shared_file_or_feature_inference
actual_driver_generated_buffers_keep_unknown_generator_and_stable_absence
actual_driver_occurrence_budget_keeps_partial_facts_or_explicit_gap
occurrences::tests::later_gap_cannot_overflow_an_accepted_definition_record
occurrences::tests::rejected_reference_retains_both_endpoints_and_reserved_gaps
pinned_rustdoc_conversion_checks_zero_overflow_and_exclusive_end
actual_driver_unicode_columns_match_pinned_rustdoc_without_byte_rebasing
actual_driver_near_cap_keeps_callback_and_explicit_budget_outcome
```

## Selected Cargo launch observations

The shared job also includes the following authored routing contracts. They use
the same CLI/driver artifacts above; no separate build is needed. All existing
default/feature selectors remain required. The actual forwarding-program case
delegates to the genuine matching Cargo and checks the selected program endpoint
without claiming that endpoint authenticates the delegated binary or ancestry.

```bash
cargo test --locked --lib compiler_invocation::tests
cargo test --locked --bin cargo-build-graph cargo_launch::tests
cargo test --locked --bin cargo-build-graph rustdoc::tests
BUILD_GRAPH_DRIVER=/approved/bg-driver cargo test --locked --features rustc-driver --test compiler_occurrence_flow
```

```text
compiler_invocation::tests::cargo_operation_absence_and_optional_round_trip_preserve_legacy_shape
compiler_invocation::tests::cargo_operation_request_kind_order_status_and_missing_facts_reject
compiler_invocation::tests::cargo_operation_bounds_and_loss_witness_are_checked_by_original_reader
cargo_launch::tests::repeated_commands_have_fresh_ordered_correlations_and_no_custody_grant
cargo_launch::tests::actual_command_overlay_removes_keys_and_withholds_sensitive_bytes
cargo_launch::tests::argument_environment_and_operation_overflow_keep_explicit_bounded_loss
cargo_launch::tests::foreign_command_and_duplicate_root_fail_before_launch
cargo_launch::tests::configured_tool_paths_and_environment_byte_cap_are_actual_and_bounded
cargo_launch::tests::actual_build_failure_and_spawn_failure_preserve_status_and_selected_program
rustdoc::tests::selected_doc_command_is_direct_and_preserves_original_flags_and_packages
actual_selected_cargo_routes_metadata_build_docs_with_fresh_request_and_cleanup
actual_default_nightly_route_records_direct_operations_without_selected_override
actual_selected_doc_failure_preserves_exit_and_original_partial_freshness_cleanup
actual_selected_build_failure_removes_owned_session_without_publishing_export
```

The tests inspect real launch outcomes, default omission, count/byte loss,
fresh correlations, selected commands, redaction and original owned cleanup.
None authenticates an installed private artifact/Session or complete input
custody. The private consumer still needs qualified outer/Cargo artifacts, actual
fork/exec/birth lineage, operation/configuration/read receipts and original
admission/lifetime binding. All execution evidence remains pending.

## Existing stable observation gates

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
