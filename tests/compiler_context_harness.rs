//! Genuine matching compiler controls. The shared Linux job supplies the actual
//! driver, rustc and sysroot; a missing tool is a failure, never a skipped pass.
#![cfg(all(target_os = "linux", feature = "rustc-driver"))]
use build_graph::compiler_context::TargetFeatureInventory;
use build_graph::compiler_occurrence::{CallbackRequest, OCCURRENCES_VERSION, fingerprint};
use build_graph::compiler_semantic::*;
use build_graph::compiler_test_harness::*;
use build_graph::held_callback_control::OwnedSealedControls;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new(source: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "compiler-context-harness-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let root = fs::canonicalize(root).unwrap();
        fs::create_dir(root.join("target")).unwrap();
        fs::write(root.join("lib.rs"), source).unwrap();
        Self(root)
    }
    fn run(&self, domain: SemanticDomain, test: bool, extra: &[&str]) -> SemanticStreamV1 {
        let driver =
            std::env::var_os("BUILD_GRAPH_DRIVER").expect("actual matching driver required");
        let rustc = std::env::var_os("BUILD_GRAPH_TEST_EXPLICIT_RUSTC")
            .expect("actual matching rustc required");
        let sysroot = std::env::var_os("BUILD_GRAPH_TEST_EXPLICIT_SYSROOT")
            .expect("actual matching sysroot required");
        assert!(
            Path::new(&driver).is_file()
                && Path::new(&rustc).is_file()
                && Path::new(&sysroot).is_dir()
        );
        let request = CallbackRequest {
            schema_version: OCCURRENCES_VERSION,
            nonce: "actual-context-harness-callback".into(),
            command_fingerprint: fingerprint(b"actual compiler operation"),
            crate_name: "context_demo".into(),
            metadata: Some("context_harness".into()),
            source: self.0.join("lib.rs"),
            source_root: self.0.clone(),
            target_root: self.0.join("target"),
            output: self.0.join("occurrences.json"),
        };
        let binding = SemanticBindingV1 {
            schema_version: 1,
            nonce: request.nonce.clone(),
            command_fingerprint: request.command_fingerprint.clone(),
            crate_name: request.crate_name.clone(),
            metadata: request.metadata.clone(),
            domain,
        };
        let semantic = SemanticRequest {
            binding: binding.clone(),
            output_directory: self.0.join("semantic"),
            budget_directory: self.0.clone(),
        };
        for (path, body) in [
            (
                self.0.join("callback.json"),
                serde_json::to_vec(&request).unwrap(),
            ),
            (
                self.0.join("semantic-request.json"),
                serde_json::to_vec(&semantic).unwrap(),
            ),
        ] {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(path)
                .unwrap();
            file.write_all(&body).unwrap();
            file.sync_all().unwrap();
        }
        let controls = OwnedSealedControls::from_private_files(
            &self.0.join("callback.json"),
            Some(&self.0.join("semantic-request.json")),
        )
        .unwrap();
        let mut command = Command::new(driver);
        command
            .arg(rustc)
            .args([
                "--crate-name",
                "context_demo",
                "--edition=2024",
                "--emit=metadata",
                "-C",
                "metadata=context_harness",
                "--sysroot",
            ])
            .arg(&sysroot)
            .arg("--out-dir")
            .arg(self.0.join("target"))
            .arg(&request.source)
            .env("LD_LIBRARY_PATH", Path::new(&sysroot).join("lib"))
            .env("BG_DRIVER_OCCURRENCE_REQUEST", self.0.join("callback.json"))
            .env(
                "BG_DRIVER_SEMANTIC_REQUEST",
                self.0.join("semantic-request.json"),
            )
            .env("BG_DRIVER_COMPILER_CONTEXT_OBSERVATION", "1")
            .env_remove("BG_DRIVER_TEST_HARNESS_OBSERVATION")
            .env_remove("BG_DRIVER_EDGES")
            .env_remove("BG_DRIVER_DEFS")
            .env_remove("BG_DRIVER_LOG")
            .current_dir(&self.0);
        if test {
            command.arg("--test");
        } else {
            command.args(["--crate-type", "lib"]);
        }
        if domain == SemanticDomain::LocalHirWithTestHarness {
            command.env("BG_DRIVER_TEST_HARNESS_OBSERVATION", "1");
        }
        command.args(extra);
        let _retained = controls.configure_child(&mut command).unwrap();
        let result = command.output().unwrap();
        assert!(
            result.status.success(),
            "actual driver failed: {}",
            String::from_utf8_lossy(&result.stderr)
        );
        let raw = fs::read(semantic.output_directory.join("index.json"))
            .expect("actual after-analysis index");
        let index: SemanticIndexV1 = serde_json::from_slice(&raw).unwrap();
        assert_eq!(index.binding, binding);
        let mut pages = vec![];
        let mut total = raw.len();
        for entry in &index.pages {
            let raw = fs::read(
                semantic
                    .output_directory
                    .join(format!("page-{}.json", entry.ordinal)),
            )
            .unwrap();
            total += raw.len();
            assert!(total <= MAX_STREAM_BYTES);
            assert_eq!(raw.len(), entry.bytes);
            assert_eq!(page_fingerprint(&raw), entry.content_fingerprint);
            pages.push(SemanticPageV1::from_json(&raw).unwrap());
        }
        let stream = SemanticStreamV1 {
            binding,
            pages,
            terminal: Some(index.terminal),
        };
        stream.validate().unwrap();
        stream
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn targets(value: &SemanticStreamV1) -> impl Iterator<Item = &SemanticTarget> {
    value
        .pages
        .iter()
        .flat_map(|page| page.references.iter().map(|row| &row.target))
}
fn descriptors(value: &SemanticStreamV1) -> Vec<&TestDescriptorObservation> {
    targets(value)
        .filter_map(|target| match target {
            SemanticTarget::TestHarnessDescriptor { descriptor } => Some(descriptor.as_ref()),
            _ => None,
        })
        .collect()
}
#[test]
fn actual_session_cfg_includes_profile_defaults_and_explicit_values() {
    let value = Fixture::new("pub fn ordinary()->u32{1}\n").run(
        SemanticDomain::LocalHirWithCompilerContext,
        false,
        &[
            "--cfg",
            "context_probe=\"actual\"",
            "-C",
            "debug-assertions=yes",
        ],
    );
    assert!(targets(&value).any(|target|matches!(target,SemanticTarget::CompilerContext {context} if !context.rustc_version.is_empty())));
    assert!(targets(&value).any(|target|matches!(target,SemanticTarget::EffectiveCfg {cfg} if cfg.name=="debug_assertions" && cfg.value.is_none())));
    assert!(targets(&value).any(|target|matches!(target,SemanticTarget::EffectiveCfg {cfg} if cfg.name=="context_probe" && cfg.value.as_deref()==Some("actual"))));
    assert!(
        !value
            .terminal
            .as_ref()
            .unwrap()
            .gaps
            .contains(&SemanticGap::CompilerContextUnavailable)
    );
}
#[test]
fn actual_target_feature_codegen_changes_same_session_inventory() {
    let value = Fixture::new("pub fn ordinary(){}\n").run(
        SemanticDomain::LocalHirWithCompilerContext,
        false,
        &["-C", "target-feature=+sse4.2"],
    );
    assert!(targets(&value).any(|target|matches!(target,SemanticTarget::TargetFeature {feature} if feature.inventory==TargetFeatureInventory::Stable && feature.name=="sse4.2")));
    assert!(targets(&value).any(|target|matches!(target,SemanticTarget::EffectiveCfg {cfg} if cfg.name=="target_feature" && cfg.value.as_deref()==Some("sse4.2"))));
}
#[test]
fn actual_test_harness_policies_order_constants_and_used_sysroot() {
    let source = "#[test] fn z(){}\n#[test] #[ignore=\"why\"] fn a(){}\n#[test] #[should_panic(expected=\"message\")] fn p(){panic!(\"message\")}\n#[test] #[should_panic] fn q(){panic!()}\n";
    let value = Fixture::new(source).run(SemanticDomain::LocalHirWithTestHarness, true, &[]);
    let rows = descriptors(&value);
    assert_eq!(
        rows.iter().map(|row| row.name.as_str()).collect::<Vec<_>>(),
        ["a", "p", "q", "z"]
    );
    assert!(rows[0].ignore);
    assert_eq!(rows[0].ignore_message.as_deref(), Some("why"));
    assert_eq!(
        rows[1].should_panic,
        TestPanicExpectation::Message {
            value: "message".into()
        }
    );
    assert_eq!(rows[2].should_panic, TestPanicExpectation::Yes);
    for (ordinal, row) in rows.iter().enumerate() {
        assert_eq!(row.table_ordinal, ordinal as u64);
        assert_eq!(row.kind, TestDescriptorKind::Test);
        assert!(!row.compile_fail && !row.no_run);
        assert!(row.start_line > 0);
        assert_ne!(row.function.def_path_hash, row.closure.def_path_hash);
    }
    assert!(targets(&value).any(|target|matches!(target,SemanticTarget::TestHarnessEntry {entry} if entry.table_entries==4 && entry.test_crate.crate_name=="test" && !entry.test_crate.members.is_empty())));
    assert!(
        !value
            .terminal
            .as_ref()
            .unwrap()
            .gaps
            .iter()
            .any(|gap| matches!(
                gap,
                SemanticGap::TestHarnessUnsupportedDescriptor | SemanticGap::TestHarnessUnavailable
            ))
    );
}
#[test]
fn actual_empty_harness_has_generated_entry_and_zero_table() {
    let value =
        Fixture::new("pub fn helper(){}\n").run(SemanticDomain::LocalHirWithTestHarness, true, &[]);
    assert!(targets(&value).any(
        |target| matches!(target,SemanticTarget::TestHarnessEntry {entry} if entry.table_entries==0)
    ));
    assert!(descriptors(&value).is_empty());
}
#[test]
fn actual_ordinary_unit_preserves_unavailable_harness_gap() {
    let value = Fixture::new("pub fn helper(){}\n").run(
        SemanticDomain::LocalHirWithTestHarness,
        false,
        &[],
    );
    assert!(
        value
            .terminal
            .as_ref()
            .unwrap()
            .gaps
            .contains(&SemanticGap::TestHarnessUnavailable)
    );
    assert!(targets(&value).any(|target| matches!(target, SemanticTarget::CompilerContext { .. })));
    assert!(
        !targets(&value).any(|target| matches!(target, SemanticTarget::TestHarnessEntry { .. }))
    );
}
#[test]
fn actual_custom_runner_is_not_standard_libtest() {
    let source = "#![feature(custom_test_frameworks)]\n#![test_runner(custom)]\nfn custom(_: &[&dyn Fn()]){}\n#[test_case] fn sample(){}\n";
    let value = Fixture::new(source).run(SemanticDomain::LocalHirWithTestHarness, true, &[]);
    assert!(
        value
            .terminal
            .as_ref()
            .unwrap()
            .gaps
            .contains(&SemanticGap::TestHarnessCustomRunner)
    );
    assert!(descriptors(&value).is_empty());
}
#[test]
fn actual_bench_descriptor_resolves_real_assertion_closure() {
    let source = "#![feature(test)]\nextern crate test;\n#[bench] fn bench(b:&mut test::Bencher){b.iter(||1)}\n";
    let value = Fixture::new(source).run(SemanticDomain::LocalHirWithTestHarness, true, &[]);
    let rows = descriptors(&value);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].kind, TestDescriptorKind::Bench);
    assert_eq!(rows[0].name, "bench");
    assert!(
        rows[0]
            .assertion_wrapper
            .compiler_path
            .ends_with("assert_test_result")
    );
}
#[test]
fn actual_large_generated_table_pages_under_shared_limits() {
    let mut source = String::new();
    for index in 0..100 {
        source.push_str(&format!("#[test] fn test_{index:03}(){{}}\n"));
    }
    let value = Fixture::new(&source).run(SemanticDomain::LocalHirWithTestHarness, true, &[]);
    assert!(value.pages.len() > 1);
    let rows = descriptors(&value);
    assert_eq!(rows.len(), 100);
    for (ordinal, row) in rows.iter().enumerate() {
        assert_eq!(row.table_ordinal, ordinal as u64);
        assert_eq!(row.name, format!("test_{ordinal:03}"));
    }
    assert!(serde_json::to_vec(&value).unwrap().len() <= MAX_STREAM_BYTES);
}

#[test]
fn actual_selected_cargo_wrapper_exports_the_opted_harness_domain() {
    let fixture = Fixture::new("#[test] #[ignore=\"compiler policy\"] fn selected(){}\n");
    fs::write(fixture.0.join("Cargo.toml"),"[package]\nname='context_demo'\nversion='0.1.0'\nedition='2024'\n[lib]\npath='lib.rs'\n[workspace]\n").unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_cargo-build-graph"));
    command
        .args(["build", "--manifest-path"])
        .arg(fixture.0.join("Cargo.toml"))
        .args([
            "--observe-compiler-inputs",
            "--observe-definition-occurrences",
            "--observe-semantic-stream",
            "--observe-test-harness",
            "--held-callback-controls",
        ]);
    for (flag, key) in [
        ("--driver-bin", "BUILD_GRAPH_DRIVER"),
        ("--occurrence-cargo", "BUILD_GRAPH_TEST_OCCURRENCE_CARGO"),
        ("--occurrence-rustc", "BUILD_GRAPH_TEST_EXPLICIT_RUSTC"),
        ("--occurrence-rustdoc", "BUILD_GRAPH_TEST_EXPLICIT_RUSTDOC"),
        ("--occurrence-sysroot", "BUILD_GRAPH_TEST_EXPLICIT_SYSROOT"),
    ] {
        let path =
            std::env::var_os(key).unwrap_or_else(|| panic!("shared job must supply actual {key}"));
        command.arg(flag).arg(path);
    }
    command
        .args(["--", "--tests"])
        .env_remove("RUSTC_WRAPPER")
        .env_remove("RUSTC_WORKSPACE_WRAPPER")
        .env("CARGO_ENCODED_RUSTFLAGS", "-C\x1fdebug-assertions=yes")
        .current_dir(&fixture.0);
    let result = command.output().unwrap();
    assert!(
        result.status.success(),
        "actual selected Cargo failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    let facts = build_graph::output::read_export(&fixture.0.join("target/build-graph"))
        .unwrap()
        .compiler_invocations
        .expect("actual attachment");
    facts.validate().unwrap();
    let stream = &facts
        .semantic_streams
        .iter()
        .find(|stream| {
            stream.stream.binding.crate_name == "context_demo"
                && targets(&stream.stream)
                    .any(|target| matches!(target, SemanticTarget::TestHarnessEntry { .. }))
        })
        .expect("actual opted wrapper export")
        .stream;
    assert_eq!(
        stream.binding.domain,
        SemanticDomain::LocalHirWithTestHarness
    );
    let rows = descriptors(stream);
    assert_eq!(rows.len(), 1);
    assert!(rows[0].ignore);
    assert_eq!(rows[0].ignore_message.as_deref(), Some("compiler policy"));
    assert!(targets(stream).any(
        |target| matches!(target,SemanticTarget::EffectiveCfg {cfg} if cfg.name=="debug_assertions")
    ));
}
