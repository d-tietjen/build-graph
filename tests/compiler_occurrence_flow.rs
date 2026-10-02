//! Genuine callback acceptance; the feature-enabled Linux validation job must
//! supply the already built, matching driver. Missing prerequisites fail.
#![cfg(all(target_os = "linux", feature = "rustc-driver"))]

use build_graph::compiler_invocation::{CompilerInvocationsV1, ObservationGap};
use build_graph::compiler_occurrence::{OccurrenceGap, OccurrenceRoot, fingerprint};
use build_graph::output::read_export;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);
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
            if let Some(cargo) = std::env::var_os("BUILD_GRAPH_TEST_OCCURRENCE_CARGO") {
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
        (
            source.range.begin_line,
            source.range.begin_column,
            source.range.end_line,
            source.range.end_column
        )
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
