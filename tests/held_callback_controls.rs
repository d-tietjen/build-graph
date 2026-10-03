//! Genuine pinned compiler/driver controls. The shared validation job must supply
//! matching actual tools; none of these positive cases skips missing prerequisites.
#![cfg(all(target_os = "linux", feature = "rustc-driver"))]
use build_graph::compiler_occurrence::{
    CallbackRequest, CompilerOccurrencesV1, OCCURRENCES_VERSION, fingerprint,
};
use build_graph::compiler_semantic::{
    SemanticBindingV1, SemanticDomain, SemanticIndexV1, SemanticRequest, TraversalStop,
};
use build_graph::held_callback_control::{
    MAX_CONTROL_BYTES, OCCURRENCE_FD_ENV, OwnedSealedControls, SEMANTIC_FD_ENV,
};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
    occurrence: PathBuf,
    semantic: PathBuf,
    request: CallbackRequest,
    semantic_request: SemanticRequest,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "held-driver-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let root = fs::canonicalize(root).unwrap();
        fs::create_dir(root.join("target")).unwrap();
        fs::write(
            root.join("lib.rs"),
            "pub fn source()->u32{1}\npub fn caller()->u32{source()}\n",
        )
        .unwrap();
        let request = CallbackRequest {
            schema_version: OCCURRENCES_VERSION,
            nonce: format!("held-{}", root.file_name().unwrap().to_string_lossy()),
            command_fingerprint: fingerprint(b"actual owned driver arguments"),
            crate_name: "held_demo".into(),
            metadata: Some("held_control".into()),
            source: root.join("lib.rs"),
            source_root: root.clone(),
            target_root: root.join("target"),
            output: root.join("occurrences.json"),
        };
        let semantic_request = SemanticRequest {
            binding: SemanticBindingV1 {
                schema_version: 1,
                nonce: request.nonce.clone(),
                command_fingerprint: request.command_fingerprint.clone(),
                crate_name: request.crate_name.clone(),
                metadata: request.metadata.clone(),
                domain: SemanticDomain::LocalHir,
            },
            output_directory: root.join("semantic"),
            budget_directory: root.clone(),
        };
        Self {
            occurrence: root.join("callback.json"),
            semantic: root.join("semantic-request.json"),
            root,
            request,
            semantic_request,
        }
    }
    fn bodies(&self, occurrence: &[u8], semantic: Option<&[u8]>) {
        for (path, raw) in std::iter::once((&self.occurrence, occurrence))
            .chain(semantic.map(|v| (&self.semantic, v)))
        {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(path)
                .unwrap();
            file.write_all(raw).unwrap();
            file.sync_all().unwrap();
        }
    }
    fn command(&self, rustc: Option<&Path>) -> Command {
        let driver = std::env::var_os("BUILD_GRAPH_DRIVER")
            .expect("matching genuine nightly driver required");
        let supplied = std::env::var_os("BUILD_GRAPH_TEST_EXPLICIT_RUSTC")
            .expect("actual matching rustc required");
        let sysroot = std::env::var_os("BUILD_GRAPH_TEST_EXPLICIT_SYSROOT")
            .expect("actual matching sysroot required");
        assert!(Path::new(&driver).is_file());
        assert!(Path::new(&supplied).is_file());
        assert!(Path::new(&sysroot).is_dir());
        let mut command = Command::new(driver);
        command
            .arg(rustc.unwrap_or(Path::new(&supplied)))
            .args([
                "--crate-name",
                "held_demo",
                "--crate-type",
                "lib",
                "--edition=2024",
                "--emit=metadata",
                "-C",
                "metadata=held_control",
                "--sysroot",
            ])
            .arg(&sysroot)
            .arg("--out-dir")
            .arg(self.root.join("target"))
            .arg(&self.request.source)
            .env("LD_LIBRARY_PATH", Path::new(&sysroot).join("lib"))
            .env("BG_DRIVER_OCCURRENCE_REQUEST", &self.occurrence)
            .env_remove("BG_DRIVER_SEMANTIC_REQUEST")
            .env_remove(OCCURRENCE_FD_ENV)
            .env_remove(SEMANTIC_FD_ENV)
            .env_remove("BG_DRIVER_EDGES")
            .env_remove("BG_DRIVER_DEFS")
            .env_remove("BG_DRIVER_LOG")
            .current_dir(&self.root);
        command
    }
    fn run(&self, semantic: bool, rustc: Option<&Path>) {
        let controls = OwnedSealedControls::from_private_files(
            &self.occurrence,
            semantic.then_some(self.semantic.as_path()),
        )
        .unwrap();
        let mut command = self.command(rustc);
        if semantic {
            command.env("BG_DRIVER_SEMANTIC_REQUEST", &self.semantic);
        }
        let _retention = controls.configure_child(&mut command).unwrap();
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "actual driver failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            fs::read_dir(self.root.join("target")).unwrap().any(|v| v
                .unwrap()
                .path()
                .extension()
                .is_some_and(|e| e == "rmeta")),
            "actual compiler completed"
        );
    }
    fn occurrence(&self) -> CompilerOccurrencesV1 {
        let value: CompilerOccurrencesV1 = serde_json::from_slice(
            &fs::read(&self.request.output).expect("genuine actual callback"),
        )
        .unwrap();
        value.validate().unwrap();
        assert_eq!(value.nonce, self.request.nonce);
        assert!(value.definitions.iter().any(|v| v.def_path == "source"));
        assert!(
            value
                .references
                .iter()
                .any(|v| v.source.def_path == "caller" && v.target.def_path == "source")
        );
        value
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn genuine_matching_driver_occurrence_control_fd_positive() {
    let fixture = Fixture::new();
    fixture.bodies(&serde_json::to_vec(&fixture.request).unwrap(), None);
    fixture.run(false, None);
    fixture.occurrence();
    assert!(!fixture.root.join("semantic").exists());
}
#[test]
fn genuine_matching_driver_semantic_pair_fd_positive_under_shared32k() {
    let fixture = Fixture::new();
    let first = serde_json::to_vec(&fixture.request).unwrap();
    let second = serde_json::to_vec(&fixture.semantic_request).unwrap();
    assert!(first.len() + second.len() <= MAX_CONTROL_BYTES);
    fixture.bodies(&first, Some(&second));
    fixture.run(true, None);
    fixture.occurrence();
    let index: SemanticIndexV1 = serde_json::from_slice(
        &fs::read(fixture.root.join("semantic/index.json")).expect("genuine semantic publication"),
    )
    .unwrap();
    assert_eq!(index.binding, fixture.semantic_request.binding);
    assert_eq!(index.terminal.stop, TraversalStop::EndOfDomain);
    assert!(index.terminal.emitted_definitions >= 2);
    assert!(index.terminal.emitted_references >= 1);
}
#[test]
fn genuine_matching_driver_pair_exact_shared32k_transport_preserves_schema() {
    let fixture = Fixture::new();
    let mut first = serde_json::to_vec(&fixture.request).unwrap();
    let second = serde_json::to_vec(&fixture.semantic_request).unwrap();
    first.resize(MAX_CONTROL_BYTES - second.len(), b' ');
    assert_eq!(first.len() + second.len(), MAX_CONTROL_BYTES);
    fixture.bodies(&first, Some(&second));
    fixture.run(true, None);
    fixture.occurrence();
    assert!(fixture.root.join("semantic/index.json").is_file());
}
#[test]
fn genuine_driver_rejects_malformed_explicit_fd_without_valid_path_fallback() {
    let fixture = Fixture::new();
    fixture.bodies(
        &serde_json::to_vec(&fixture.request).unwrap(),
        Some(&serde_json::to_vec(&fixture.semantic_request).unwrap()),
    );
    let mut command = fixture.command(None);
    command
        .env(OCCURRENCE_FD_ENV, "invalid")
        .env("BG_DRIVER_SEMANTIC_REQUEST", &fixture.semantic);
    let output = command.output().unwrap();
    assert!(output.status.success(), "original compiler still completes");
    assert!(!fixture.request.output.exists());
    assert!(!fixture.root.join("semantic").exists());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("sealed callback control unavailable")
    );
}
#[test]
fn genuine_driver_strict_schema_crate_metadata_source_nonce_and_parent_failures() {
    for failure in [
        "schema",
        "crate",
        "metadata",
        "source",
        "empty_nonce",
        "long_nonce",
        "parent",
        "unknown",
    ] {
        let fixture = Fixture::new();
        let mut body = serde_json::to_value(&fixture.request).unwrap();
        match failure {
            "schema" => body["schema_version"] = serde_json::json!(2),
            "crate" => body["crate_name"] = serde_json::json!("foreign_unit"),
            "metadata" => body["metadata"] = serde_json::json!("foreign_metadata"),
            "source" => {
                fs::write(fixture.root.join("foreign.rs"), "pub fn other(){}\n").unwrap();
                body["source"] = serde_json::json!(fixture.root.join("foreign.rs"));
            }
            "empty_nonce" => body["nonce"] = serde_json::json!(""),
            "long_nonce" => body["nonce"] = serde_json::json!("n".repeat(129)),
            "parent" => {
                body["output"] = serde_json::json!(fixture.root.join("target/foreign.json"))
            }
            "unknown" => body["unexpected_field"] = serde_json::json!(true),
            _ => unreachable!(),
        }
        fixture.bodies(&serde_json::to_vec(&body).unwrap(), None);
        fixture.run(false, None);
        assert!(
            !fixture.request.output.exists(),
            "strict existing binding {failure}"
        );
        assert!(!fixture.root.join("target/foreign.json").exists());
    }
}
#[test]
fn genuine_driver_semantic_mismatch_never_uses_valid_path_body_instead() {
    let fixture = Fixture::new();
    let mut wrong = fixture.semantic_request.clone();
    wrong.binding.nonce.push_str("-foreign");
    fixture.bodies(
        &serde_json::to_vec(&fixture.request).unwrap(),
        Some(&serde_json::to_vec(&wrong).unwrap()),
    );
    fixture.run(true, None);
    fixture.occurrence();
    assert!(!fixture.root.join("semantic").exists());
}
#[test]
fn genuine_driver_adoption_precedes_actual_sysroot_helper_and_prevents_fd_leak() {
    let fixture = Fixture::new();
    fixture.bodies(
        &serde_json::to_vec(&fixture.request).unwrap(),
        Some(&serde_json::to_vec(&fixture.semantic_request).unwrap()),
    );
    fs::create_dir(fixture.root.join("probe")).unwrap();
    let proxy = fixture.root.join("probe/rustc");
    // Probe is an explicit failure/leak instrument, not a qualified compiler
    // artifact. It delegates to the mandatory actual matching rustc only.
    fs::write(&proxy,"#!/bin/sh\nfor fd in /proc/self/fd/*; do readlink \"$fd\" || :; done > \"$BUILD_GRAPH_CONTROL_LEAK_LOG\"\nexec \"$BUILD_GRAPH_CONTROL_ACTUAL_RUSTC\" \"$@\"\n").unwrap();
    fs::set_permissions(&proxy, fs::Permissions::from_mode(0o700)).unwrap();
    let controls =
        OwnedSealedControls::from_private_files(&fixture.occurrence, Some(&fixture.semantic))
            .unwrap();
    let mut command = fixture.command(Some(&proxy));
    command
        .env(
            "BUILD_GRAPH_CONTROL_LEAK_LOG",
            fixture.root.join("helper-fds"),
        )
        .env(
            "BUILD_GRAPH_CONTROL_ACTUAL_RUSTC",
            std::env::var_os("BUILD_GRAPH_TEST_EXPLICIT_RUSTC").expect("actual compiler required"),
        )
        .env("BG_DRIVER_SEMANTIC_REQUEST", &fixture.semantic);
    let _retention = controls.configure_child(&mut command).unwrap();
    let output = command.output().unwrap();
    assert!(output.status.success(), "actual driver/source callback");
    fixture.occurrence();
    let observed =
        fs::read_to_string(fixture.root.join("helper-fds")).expect("actual helper really ran");
    assert!(!observed.contains("build-graph-occurrence-control-v1"));
    assert!(!observed.contains("build-graph-semantic-control-v1"));
}
#[test]
fn genuine_actual_cli_wrapper_fd_pair_keeps_complete_explicit_tool_route() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.root.join("src")).unwrap();
    fs::write(
        fixture.root.join("src/lib.rs"),
        fs::read(&fixture.request.source).unwrap(),
    )
    .unwrap();
    fs::write(
        fixture.root.join("Cargo.toml"),
        "[package]\nname='held_demo'\nversion='0.1.0'\nedition='2024'\n[workspace]\n",
    )
    .unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_cargo-build-graph"));
    command
        .args([
            "build",
            "--observe-compiler-inputs",
            "--observe-definition-occurrences",
            "--observe-semantic-stream",
            "--held-callback-controls",
            "--nightly",
            "nightly-2026-02-27",
            "--manifest-path",
        ])
        .arg(fixture.root.join("Cargo.toml"));
    for (option, variable) in [
        ("--occurrence-cargo", "BUILD_GRAPH_TEST_EXPLICIT_CARGO"),
        ("--occurrence-rustc", "BUILD_GRAPH_TEST_EXPLICIT_RUSTC"),
        ("--occurrence-rustdoc", "BUILD_GRAPH_TEST_EXPLICIT_RUSTDOC"),
        ("--occurrence-sysroot", "BUILD_GRAPH_TEST_EXPLICIT_SYSROOT"),
        ("--driver-bin", "BUILD_GRAPH_DRIVER"),
    ] {
        command
            .arg(option)
            .arg(std::env::var_os(variable).expect("genuine matching tool required"));
    }
    command
        .env(
            "CARGO_ENCODED_RUSTFLAGS",
            std::env::var_os("BUILD_GRAPH_TEST_EXPLICIT_RUSTFLAGS")
                .expect("actual complete flag baseline"),
        )
        .env(
            "CARGO_ENCODED_RUSTDOCFLAGS",
            std::env::var_os("BUILD_GRAPH_TEST_EXPLICIT_RUSTDOCFLAGS")
                .expect("actual complete doc baseline"),
        )
        .env_remove("RUSTC_WRAPPER")
        .env_remove("RUSTC_WORKSPACE_WRAPPER")
        .env_remove("RUSTFLAGS")
        .env_remove("RUSTDOCFLAGS")
        .env_remove(OCCURRENCE_FD_ENV)
        .env_remove(SEMANTIC_FD_ENV)
        .current_dir(&fixture.root);
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "actual CLI: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let facts = build_graph::output::read_export(&fixture.root.join("target/build-graph"))
        .unwrap()
        .compiler_invocations
        .expect("actual attachment");
    facts.validate().unwrap();
    let (ordinal, unit) = facts
        .invocations
        .iter()
        .enumerate()
        .find(|(_, v)| v.unit.crate_name == "held_demo")
        .expect("actual unit");
    let occurrence = unit
        .occurrences
        .as_ref()
        .expect("actual wrapper sealed control consumed");
    assert!(unit.success && unit.exit_code == Some(0));
    assert!(
        occurrence
            .definitions
            .iter()
            .any(|v| v.def_path == "source")
    );
    let semantic = &facts
        .semantic_streams
        .iter()
        .find(|v| v.invocation == ordinal)
        .expect("actual semantic callback")
        .stream;
    assert_eq!(semantic.binding.nonce, occurrence.nonce);
    assert_eq!(
        semantic.terminal.as_ref().unwrap().stop,
        TraversalStop::EndOfDomain
    );
}
