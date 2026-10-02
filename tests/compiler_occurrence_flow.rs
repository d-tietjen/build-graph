//! Genuine callback acceptance; the feature-enabled Linux validation job must
//! supply the already built, matching driver. Missing prerequisites fail.
#![cfg(all(target_os = "linux", feature = "rustc-driver"))]

use build_graph::compiler_invocation::{
    CargoOperationKind, CompilerInvocationsV1, InputRoot, ObservationGap,
};
use build_graph::compiler_occurrence::{
    OccurrenceGap, OccurrenceRange, OccurrenceRoot, fingerprint,
};
use build_graph::output::read_export;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);

// Pinned Rust 6a979b3e32522049d0acb4a47f7ae44b7c8abfd5:
// src/librustdoc/json/conversions.rs serializes lo.col + 1 and hi.col + 1.
// The callback retains CharPos, not byte offsets. End stays exclusive.
fn pinned_rustdoc_range(range: &OccurrenceRange) -> Option<(usize, usize, usize, usize)> {
    if range.begin_line == 0
        || (range.begin_line, range.begin_column) >= (range.end_line, range.end_column)
    {
        return None;
    }
    Some((
        range.begin_line,
        range.begin_column.checked_add(1)?,
        range.end_line,
        range.end_column.checked_add(1)?,
    ))
}

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "occurrence-flow-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).expect("exclusive fixture");
        fs::create_dir(root.join("src")).expect("source directory");
        fs::write(root.join("Cargo.toml"), "[package]\nname='occurrence_demo'\nversion='0.1.0'\nedition='2024'\n[workspace]\n[features]\nselected=[]\n").expect("manifest");
        fs::write(root.join("build.rs"), "fn main(){let out=std::env::var_os(\"OUT_DIR\").unwrap();std::fs::write(std::path::Path::new(&out).join(\"generated.rs\"),\"pub fn generated()->u32{9}\\n\").unwrap();println!(\"cargo:rerun-if-changed=build.rs\");}\n").expect("generator source");
        fs::write(root.join("src/lib.rs"), "pub fn source()->u32{1}\npub fn caller()->u32{source()}\n#[cfg(feature=\"selected\")]\npub fn conditional()->u32{2}\ninclude!(concat!(env!(\"OUT_DIR\"),\"/generated.rs\"));\n").expect("source");
        Self(root)
    }
    fn build(
        &self,
        occurrences: bool,
        selected: bool,
        rich: bool,
    ) -> build_graph::export::ExportManifest {
        self.build_with_cargo(occurrences, selected, rich, None)
    }

    fn build_with_cargo(
        &self,
        occurrences: bool,
        selected: bool,
        rich: bool,
        cargo: Option<&Path>,
    ) -> build_graph::export::ExportManifest {
        self.build_with_cargo_mode(occurrences, selected, rich, cargo, true)
    }

    fn build_with_cargo_mode(
        &self,
        occurrences: bool,
        selected: bool,
        rich: bool,
        cargo: Option<&Path>,
        use_test_selection: bool,
    ) -> build_graph::export::ExportManifest {
        let mut command = Command::new(env!("CARGO_BIN_EXE_cargo-build-graph"));
        command
            .args(["build", "--manifest-path"])
            .arg(self.0.join("Cargo.toml"))
            .arg("--observe-compiler-inputs");
        if occurrences {
            let driver = std::env::var_os("BUILD_GRAPH_DRIVER")
                .expect("shared job must supply actual pinned bg-driver");
            assert!(
                Path::new(&driver).is_file(),
                "matching built driver required"
            );
            command
                .arg("--observe-definition-occurrences")
                .env("BUILD_GRAPH_DRIVER", driver);
            if let Some(cargo) = cargo {
                command
                    .arg("--occurrence-cargo")
                    .arg(cargo)
                    .arg("--compiler-input-root")
                    .arg(format!("host_tools={}", cargo.parent().unwrap().display()));
            } else if let Some(cargo) = use_test_selection
                .then(|| std::env::var_os("BUILD_GRAPH_TEST_OCCURRENCE_CARGO"))
                .flatten()
            {
                command.arg("--occurrence-cargo").arg(cargo);
            }
        }
        if rich {
            command.arg("--rich");
        }
        command.args(["--nightly", "nightly-2026-02-27"]);
        if selected {
            command.args(["--", "--features", "selected"]);
        }
        let output = command
            .current_dir(&self.0)
            .env_remove("RUSTC_WRAPPER")
            .env_remove("RUSTC_WORKSPACE_WRAPPER")
            .env_remove("BG_DRIVER_OCCURRENCE_REQUEST")
            .output()
            .expect("actual original CLI build");
        assert!(
            output.status.success(),
            "actual build failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        read_export(&self.0.join("target/build-graph")).expect("original export reader")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn actual_driver_exact_definitions_ranges_and_reference_edges_bind_invocation() {
    let fixture = Fixture::new();
    let export = fixture.build(true, false, true);
    let facts = export
        .compiler_invocations
        .as_ref()
        .expect("actual invocation attachment");
    facts.validate().expect("original bounded reader");
    let unit = facts
        .invocations
        .iter()
        .find(|u| u.unit.crate_name == "occurrence_demo")
        .expect("actual unit");
    let occurrences = unit
        .occurrences
        .as_ref()
        .expect("actual analysis callback, no skipped positive");
    let source = occurrences
        .definitions
        .iter()
        .find(|d| d.def_path == "source")
        .expect("actual compiled definition");
    assert!(
        occurrences
            .definitions
            .iter()
            .all(|d| d.def_path != "conditional")
    );
    assert_eq!(
        source.input.content_fingerprint,
        fingerprint(&fs::read(fixture.0.join("src/lib.rs")).expect("actual source"))
    );
    let raw_def = export
        .definitions
        .iter()
        .find(|d| d.identity.key() == source.definition_key)
        .expect("actual raw identity");
    assert_eq!(raw_def.graph_node_id, source.legacy_id);
    let span = raw_def.span.as_ref().expect("actual original full span");
    assert_eq!(
        (
            span.begin.line,
            span.begin.column,
            span.end.line,
            span.end.column
        ),
        pinned_rustdoc_range(&source.range).expect("checked pinned column conversion")
    );
    let edge = occurrences
        .references
        .iter()
        .find(|r| r.source.def_path == "caller" && r.target.def_path == "source")
        .expect("actually visited reference");
    assert_eq!(edge.relation, "calls");
    assert_eq!(edge.input, edge.source.input);
    assert_eq!(
        (edge.confidence.as_str(), edge.confidence_score, edge.weight),
        ("EXTRACTED", 1, 1)
    );
    assert_eq!(
        occurrences.command_fingerprint,
        fingerprint(&serde_json::to_vec(&unit.command).expect("actual command"))
    );
    let raw = serde_json::to_vec(facts).expect("JSON");
    CompilerInvocationsV1::from_json(&raw).expect("consumer-compatible output");
    assert!(
        !String::from_utf8(raw)
            .expect("UTF8")
            .contains(fixture.0.to_str().expect("path"))
    );
}

#[test]
fn actual_driver_conditional_membership_is_not_shared_file_or_feature_inference() {
    let fixture = Fixture::new();
    let first = fixture.build(true, false, false);
    let first = first.compiler_invocations.expect("facts");
    let unit = first
        .invocations
        .iter()
        .find(|u| u.unit.crate_name == "occurrence_demo")
        .expect("unit");
    let initial = unit.occurrences.as_ref().expect("actual callback");
    assert!(
        initial
            .definitions
            .iter()
            .all(|d| d.def_path != "conditional")
    );
    let first_key = unit.unit_key.clone();
    let second = fixture
        .build(true, true, false)
        .compiler_invocations
        .expect("feature facts");
    let unit = second
        .invocations
        .iter()
        .find(|u| u.unit.crate_name == "occurrence_demo")
        .expect("feature unit");
    assert_ne!(first_key, unit.unit_key);
    assert!(
        unit.occurrences
            .as_ref()
            .expect("new actual callback")
            .definitions
            .iter()
            .any(|d| d.def_path == "conditional")
    );
    let cached = fixture
        .build(true, true, false)
        .compiler_invocations
        .expect("cached facts");
    assert!(cached.invocations.is_empty());
    assert!(
        cached
            .gaps
            .contains(&ObservationGap::CachedArtifactNotInvoked)
    );
}

#[test]
fn actual_driver_generated_buffers_keep_unknown_generator_and_stable_absence() {
    let fixture = Fixture::new();
    let generated = fixture
        .build(true, false, false)
        .compiler_invocations
        .expect("facts");
    let unit = generated
        .invocations
        .iter()
        .find(|u| u.unit.crate_name == "occurrence_demo")
        .expect("unit");
    let observations = unit.occurrences.as_ref().expect("actual callback");
    let generated = observations
        .definitions
        .iter()
        .find(|d| d.def_path == "generated")
        .expect("actual include output definition");
    assert_eq!(generated.input.root, OccurrenceRoot::Target);
    assert!(
        observations
            .gaps
            .contains(&OccurrenceGap::GeneratorLineageUnknown)
    );
    assert_eq!(
        generated.input.content_fingerprint,
        fingerprint(
            &fs::read(fixture.0.join("target").join(&generated.input.relative))
                .expect("actual generated bytes")
        )
    );
    fs::write(fixture.0.join("src/lib.rs"), "pub fn stable_only(){}\n")
        .expect("actual changed source");
    let stable = fixture
        .build(false, false, false)
        .compiler_invocations
        .expect("ordinary stable facts");
    assert!(stable.invocations.iter().all(|u| u.occurrences.is_none()));
    assert!(stable.cargo_operations.is_none());
}

fn forwarding_cargo(fixture: &Fixture, fail_docs: bool) -> (PathBuf, PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let actual = std::env::var_os("BUILD_GRAPH_TEST_OCCURRENCE_CARGO")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let output = Command::new("rustup")
                .args(["which", "--toolchain", "nightly-2026-02-27", "cargo"])
                .output()
                .expect("actual pinned Cargo path");
            assert!(
                output.status.success(),
                "matching nightly prerequisite required"
            );
            PathBuf::from(std::str::from_utf8(&output.stdout).unwrap().trim())
        });
    assert!(
        actual.is_absolute() && actual.is_file(),
        "actual matching Cargo required"
    );
    let tools = fixture.0.join("tools");
    fs::create_dir(&tools).unwrap();
    let path = tools.join("selected-cargo");
    let log = fixture.0.join("operation-log");
    let quote = |path: &Path| format!("'{}'", path.to_str().unwrap().replace('\'', "'\\''"));
    let failure = if fail_docs {
        "if [ \"$1\" = doc ]; then exit 7; fi\n"
    } else {
        ""
    };
    fs::write(&path, format!("#!/bin/sh\ncase \"$1\" in metadata|build|doc) printf '%s %s\\n' \"$1\" \"$BUILD_GRAPH_CARGO_OPERATION\" >> {};; esac\n{}exec {} \"$@\"\n", quote(&log), failure, quote(&actual))).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    (path, log)
}

#[test]
fn actual_selected_cargo_routes_metadata_build_docs_with_fresh_request_and_cleanup() {
    let fixture = Fixture::new();
    let (cargo, log) = forwarding_cargo(&fixture, false);
    let first = fixture.build_with_cargo(true, false, true, Some(&cargo));
    let operations = first
        .compiler_invocations
        .as_ref()
        .unwrap()
        .cargo_operations
        .as_ref()
        .expect("actual launches");
    operations.validate().expect("original bounded reader");
    assert_eq!(
        operations
            .operations
            .iter()
            .map(|value| value.kind)
            .collect::<Vec<_>>(),
        vec![
            CargoOperationKind::Metadata,
            CargoOperationKind::Build,
            CargoOperationKind::Metadata,
            CargoOperationKind::Docs
        ]
    );
    let log_lines: Vec<_> = fs::read_to_string(&log)
        .unwrap()
        .lines()
        .map(str::to_owned)
        .collect();
    assert_eq!(log_lines.len(), operations.operations.len());
    for (value, line) in operations.operations.iter().zip(&log_lines) {
        let name = match value.kind {
            CargoOperationKind::Metadata => "metadata",
            CargoOperationKind::Build => "build",
            CargoOperationKind::Docs => "doc",
        };
        assert_eq!(line, &format!("{name} {}", value.request));
        assert!(value.started && value.success && value.exit_code == Some(0));
        assert!(
            value
                .gaps
                .contains(&ObservationGap::UnobservedExecutionInputs)
        );
        let endpoint = value
            .executable
            .path
            .as_ref()
            .expect("selected forwarding program, not delegated Cargo");
        assert_eq!(endpoint.root, InputRoot::HostTools);
        assert_eq!(endpoint.relative, "selected-cargo");
        assert_eq!(
            value
                .environment
                .iter()
                .find(|env| env.name == "RUSTUP_TOOLCHAIN")
                .unwrap()
                .value
                .as_deref(),
            Some("nightly-2026-02-27")
        );
        // The explicitly delivered matching tools are outside this fixture's
        // approved host_tools directory; no portable identity is invented.
        assert!(value.gaps.contains(&ObservationGap::PathOutsideRoots));
        if value.kind != CargoOperationKind::Build {
            assert!(value.compiler_wrapper.is_none() && value.workspace_wrapper.is_none());
        }
    }
    let runs = fixture.0.join("target/build-graph-observer");
    assert_eq!(
        fs::read_dir(&runs).unwrap().count(),
        0,
        "original owned observer cleanup after export"
    );
    let second = fixture.build_with_cargo(true, true, true, Some(&cargo));
    let second = second
        .compiler_invocations
        .as_ref()
        .unwrap()
        .cargo_operations
        .as_ref()
        .unwrap();
    assert_ne!(second.session, operations.session);
    assert!(second.operations.iter().all(|value| {
        !operations
            .operations
            .iter()
            .any(|old| old.request == value.request)
    }));
    assert!(
        second
            .operations
            .iter()
            .any(|value| value.kind == CargoOperationKind::Docs)
    );
    assert_eq!(fs::read_dir(&runs).unwrap().count(), 0);
}

#[test]
fn actual_default_nightly_route_records_direct_operations_without_selected_override() {
    let fixture = Fixture::new();
    let facts = fixture
        .build_with_cargo_mode(true, false, true, None, false)
        .compiler_invocations
        .unwrap();
    let operations = facts.cargo_operations.expect("actual default route");
    operations.validate().unwrap();
    assert_eq!(operations.operations.len(), 4);
    for value in operations.operations {
        assert!(value.success);
        assert!(
            !value
                .command
                .unwrap()
                .iter()
                .any(|argument| argument.token.as_deref() == Some("run"))
        );
        assert!(
            value
                .gaps
                .contains(&ObservationGap::UnobservedExecutionInputs)
        );
    }
}

#[test]
fn actual_selected_doc_failure_preserves_exit_and_original_partial_freshness_cleanup() {
    use build_graph::export::{ArtifactFreshness, ExtractionStatus, Layer};
    let fixture = Fixture::new();
    let (cargo, _) = forwarding_cargo(&fixture, true);
    let export = fixture.build_with_cargo(true, false, true, Some(&cargo));
    let operations = export
        .compiler_invocations
        .as_ref()
        .unwrap()
        .cargo_operations
        .as_ref()
        .unwrap();
    let docs = operations
        .operations
        .iter()
        .find(|value| value.kind == CargoOperationKind::Docs)
        .unwrap();
    assert!(docs.started && !docs.success);
    assert_eq!(docs.exit_code, Some(7));
    let items = export
        .layers
        .iter()
        .find(|value| value.layer == Layer::Items)
        .unwrap();
    assert!(
        items
            .packages
            .iter()
            .all(|value| value.status != ExtractionStatus::Complete
                && value.freshness != ArtifactFreshness::Current)
    );
    assert_eq!(
        fs::read_dir(fixture.0.join("target/build-graph-observer"))
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn actual_selected_build_failure_removes_owned_session_without_publishing_export() {
    let fixture = Fixture::new();
    let (cargo, log) = forwarding_cargo(&fixture, true);
    let script = fs::read_to_string(&cargo)
        .unwrap()
        .replace("\"$1\" = doc", "\"$1\" = build");
    fs::write(&cargo, script).unwrap();
    let driver = std::env::var_os("BUILD_GRAPH_DRIVER")
        .expect("shared job must supply actual pinned driver");
    assert!(Path::new(&driver).is_file());
    let output = Command::new(env!("CARGO_BIN_EXE_cargo-build-graph"))
        .args(["build", "--manifest-path"])
        .arg(fixture.0.join("Cargo.toml"))
        .args([
            "--observe-compiler-inputs",
            "--observe-definition-occurrences",
            "--nightly",
            "nightly-2026-02-27",
            "--occurrence-cargo",
        ])
        .arg(&cargo)
        .current_dir(&fixture.0)
        .env("BUILD_GRAPH_DRIVER", driver)
        .env_remove("RUSTC_WRAPPER")
        .env_remove("RUSTC_WORKSPACE_WRAPPER")
        .output()
        .unwrap();
    assert!(!output.status.success());
    let launches = fs::read_to_string(log).unwrap();
    assert!(launches.lines().any(|line| line.starts_with("metadata ")));
    assert!(launches.lines().any(|line| line.starts_with("build ")));
    assert!(!launches.lines().any(|line| line.starts_with("doc ")));
    assert_eq!(
        fs::read_dir(fixture.0.join("target/build-graph-observer"))
            .unwrap()
            .count(),
        0
    );
    assert!(!fixture.0.join("target/build-graph").exists());
}

#[test]
fn actual_driver_occurrence_budget_keeps_partial_facts_or_explicit_gap() {
    let fixture = Fixture::new();
    let source: String = (0..100)
        .map(|i| format!("pub fn function_{i}()->u32{{{i}}}\n"))
        .collect();
    fs::write(fixture.0.join("src/lib.rs"), source).expect("actual oversized definition set");
    let facts = fixture
        .build(true, false, false)
        .compiler_invocations
        .expect("bounded facts");
    let unit = facts
        .invocations
        .iter()
        .find(|u| u.unit.crate_name == "occurrence_demo")
        .expect("actual unit preserved");
    match &unit.occurrences {
        Some(value) => {
            assert!(value.definitions.len() <= build_graph::compiler_occurrence::MAX_DEFINITIONS);
            assert!(value.gaps.contains(&OccurrenceGap::BudgetExceeded));
        }
        None => assert!(unit.gaps.contains(&ObservationGap::BudgetExceeded)),
    }
}

#[test]
fn pinned_rustdoc_conversion_checks_zero_overflow_and_exclusive_end() {
    let range = OccurrenceRange {
        begin_line: 1,
        begin_column: 0,
        end_line: 1,
        end_column: 8,
    };
    assert_eq!(pinned_rustdoc_range(&range), Some((1, 1, 1, 9)));
    assert_eq!(range.end_column - range.begin_column, 8);
    let next_line = OccurrenceRange {
        end_line: 2,
        end_column: 0,
        ..range.clone()
    };
    assert_eq!(pinned_rustdoc_range(&next_line), Some((1, 1, 2, 1)));
    let overflow = OccurrenceRange {
        end_column: usize::MAX,
        ..range.clone()
    };
    assert!(pinned_rustdoc_range(&overflow).is_none());
    let begin_overflow = OccurrenceRange {
        begin_column: usize::MAX,
        end_line: 2,
        end_column: 0,
        ..range.clone()
    };
    assert!(pinned_rustdoc_range(&begin_overflow).is_none());
    assert!(
        pinned_rustdoc_range(&OccurrenceRange {
            begin_line: 0,
            ..range.clone()
        })
        .is_none()
    );
    assert!(
        pinned_rustdoc_range(&OccurrenceRange {
            end_column: 0,
            ..range
        })
        .is_none()
    );
}

#[test]
fn actual_driver_unicode_columns_match_pinned_rustdoc_without_byte_rebasing() {
    let fixture = Fixture::new();
    let source = "pub mod unicode { pub const π: u32 = 1; pub fn after()->u32{π} }\n";
    fs::write(fixture.0.join("src/lib.rs"), source).expect("Unicode source");
    let export = fixture.build(true, false, true);
    let facts = export
        .compiler_invocations
        .as_ref()
        .expect("actual invocation attachment");
    let unit = facts
        .invocations
        .iter()
        .find(|u| u.unit.crate_name == "occurrence_demo")
        .expect("actual unit");
    let occurrences = unit.occurrences.as_ref().expect("actual analysis callback");
    let definition = occurrences
        .definitions
        .iter()
        .find(|d| d.def_path == "unicode::after")
        .expect("actual Unicode-preceded definition");
    let raw = export
        .definitions
        .iter()
        .find(|d| d.identity.key() == definition.definition_key)
        .expect("original rich definition");
    let span = raw.span.as_ref().expect("actual rustdoc span");
    assert_eq!(
        (
            span.begin.line,
            span.begin.column,
            span.end.line,
            span.end.column
        ),
        pinned_rustdoc_range(&definition.range).expect("checked pinned conversion")
    );
    let prefix: String = source.chars().take(definition.range.begin_column).collect();
    assert!(prefix.contains('π'));
    assert!(
        prefix.len() > definition.range.begin_column,
        "CharPos is not a byte offset"
    );
    let body: String = source
        .chars()
        .skip(definition.range.begin_column)
        .take(definition.range.end_column - definition.range.begin_column)
        .collect();
    assert!(
        body.ends_with('}'),
        "raw end excludes the following space/module brace"
    );
    assert_eq!(source.chars().nth(definition.range.end_column), Some(' '));
    assert_eq!(
        definition.input.content_fingerprint,
        fingerprint(source.as_bytes())
    );
}

#[test]
fn actual_driver_near_cap_keeps_callback_and_explicit_budget_outcome() {
    let fixture = Fixture::new();
    let mut source = String::new();
    for (i, length) in [950, 950, 950, 950, 950, 829].into_iter().enumerate() {
        let prefix = format!("f_{i}_");
        let name = format!("{prefix}{}", "a".repeat(length - prefix.len()));
        source.push_str(&format!("pub fn {name}() {{}}\n"));
    }
    source.push_str("pub fn further() {}\n");
    fs::write(fixture.0.join("src/lib.rs"), source).expect("actual near-cap source");
    let facts = fixture
        .build(true, false, false)
        .compiler_invocations
        .expect("actual facts");
    let unit = facts
        .invocations
        .iter()
        .find(|u| u.unit.crate_name == "occurrence_demo")
        .expect("original actual unit");
    let value = unit
        .occurrences
        .as_ref()
        .expect("bounded callback retained, not CallbackRejected");
    assert!(
        !value.definitions.is_empty(),
        "actual partial facts retained"
    );
    assert!(value.definitions.len() < 7, "genuine rejected definition");
    assert!(value.gaps.contains(&OccurrenceGap::BudgetExceeded));
    assert!(
        !unit
            .gaps
            .contains(&ObservationGap::OccurrenceCallbackRejected)
    );
    let raw = serde_json::to_vec(value).expect("actual callback bytes");
    assert!(raw.len() <= build_graph::compiler_occurrence::MAX_OCCURRENCE_BYTES);
    build_graph::compiler_occurrence::CompilerOccurrencesV1::from_json(&raw)
        .expect("actual bounded reader accepts partial callback");
}
