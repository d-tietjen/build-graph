//! Actual producer acceptance; run only in the engineering validation environment.

#![cfg(target_os = "linux")]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

use build_graph::compiler_invocation::{FileRole, ObservationGap};
use build_graph::output::read_export;

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "compiler-input-flow-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).expect("exclusive fixture");
        Self(path)
    }
    fn wrapper_entry(&self) -> PathBuf {
        let entry = self.0.join("compiler-wrapper");
        if !entry.exists() {
            std::os::unix::fs::symlink(env!("CARGO_BIN_EXE_cargo-build-graph"), &entry)
                .expect("private wrapper entrypoint");
        }
        entry
    }
    fn write(&self, path: &str, value: &str) {
        let path = self.0.join(path);
        fs::create_dir_all(path.parent().expect("fixture parent")).expect("fixture directory");
        fs::write(path, value).expect("fixture source");
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn build(root: &Path, observe: bool, feature: bool) {
    let mut command = Command::new(env!("CARGO_BIN_EXE_cargo-build-graph"));
    command
        .args(["build", "--manifest-path"])
        .arg(root.join("Cargo.toml"));
    if observe {
        command.arg("--observe-compiler-inputs");
    }
    if feature {
        command.args(["--", "--features", "selected"]);
    }
    let output = command
        .env_remove("RUSTC_WRAPPER")
        .env_remove("RUSTC_WORKSPACE_WRAPPER")
        .env(
            "BUILD_GRAPH_COMPILER_OBSERVER",
            "inherited-cli-observer-config",
        )
        .env("GRAPH_CLI", env!("CARGO_BIN_EXE_cargo-build-graph"))
        .output()
        .expect("actual CLI producer");
    assert!(
        output.status.success(),
        "fixture CLI failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn actual_cargo_rustc_generated_and_proc_macro_facts_are_bound_without_legacy_reuse() {
    let fixture = Fixture::new();
    fixture.write("Cargo.toml", "[package]\nname='observed_demo'\nversion='0.1.0'\nedition='2024'\n[workspace]\nmembers=['macro_helper']\n[dependencies]\nmacro_helper={path='macro_helper'}\n[features]\nselected=[]\n");
    fixture.write("src/lib.rs", "include!(concat!(env!(\"OUT_DIR\"), \"/generated.rs\"));\n#[macro_helper::pass]\npub struct Public;\n");
    fixture.write("build.rs", "fn main(){let cli=std::env::var_os(\"GRAPH_CLI\").unwrap();for args in [vec![\"--help\"],vec![\"build-graph\",\"--help\"]]{assert!(std::process::Command::new(&cli).args(args).status().unwrap().success());}let out=std::env::var(\"OUT_DIR\").unwrap();std::fs::write(std::path::Path::new(&out).join(\"generated.rs\"),\"pub const GENERATED:u32=1;\").unwrap();println!(\"cargo:rerun-if-changed=build.rs\");}\n");
    fixture.write(
        "macro_helper/Cargo.toml",
        "[package]\nname='macro_helper'\nversion='0.1.0'\nedition='2024'\n[lib]\nproc-macro=true\n",
    );
    fixture.write("macro_helper/src/lib.rs", "extern crate proc_macro;\n#[proc_macro_attribute]\npub fn pass(_:proc_macro::TokenStream,item:proc_macro::TokenStream)->proc_macro::TokenStream{item}\n");
    build(&fixture.0, false, false);
    let out = fixture.0.join("target/build-graph");
    assert!(
        read_export(&out)
            .expect("legacy export")
            .compiler_invocations
            .is_none()
    );
    // Force a real invocation; a cached artifact alone must not manufacture one.
    fixture.write("src/lib.rs", "include!(concat!(env!(\"OUT_DIR\"), \"/generated.rs\"));\n#[macro_helper::pass]\npub struct Changed;\n");
    build(&fixture.0, true, false);
    let export = read_export(&out).expect("observed export");
    let facts = export
        .compiler_invocations
        .expect("optional actual attachment");
    facts.validate().expect("bounded observations");
    let unit = facts
        .invocations
        .iter()
        .find(|v| {
            v.unit.cargo.as_ref().is_some_and(|c| {
                c.package_name == "observed_demo" && c.target_kinds.iter().any(|k| k == "lib")
            })
        })
        .expect("actual Cargo/source/artifact join");
    assert_eq!(
        unit.unit.source.as_ref().expect("source").relative,
        "src/lib.rs"
    );
    assert!(unit.success && unit.exit_code == Some(0));
    assert!(
        unit.inputs
            .iter()
            .any(|i| i.role == FileRole::DepInfo && i.after.is_some())
    );
    assert!(unit.inputs.iter().any(|i| i.role == FileRole::ProcMacro));
    assert!(unit.inputs.iter().any(|i| {
        i.path
            .as_ref()
            .is_some_and(|p| p.relative.ends_with("generated.rs"))
    }));
    assert!(
        unit.gaps
            .contains(&ObservationGap::UnobservedExecutionInputs)
    );
    let raw = serde_json::to_string(&facts).expect("portable JSON");
    assert!(!raw.contains(fixture.0.to_str().expect("fixture path")));
    let first_key = unit.unit_key.clone();
    build(&fixture.0, true, true);
    let second = read_export(&out)
        .expect("feature export")
        .compiler_invocations
        .expect("feature attachment");
    let selected = second
        .invocations
        .iter()
        .find(|v| {
            v.unit.cargo.as_ref().is_some_and(|c| {
                c.package_name == "observed_demo" && c.features.iter().any(|f| f == "selected")
            })
        })
        .expect("observed selected feature");
    assert_ne!(first_key, selected.unit_key);
    build(&fixture.0, true, true);
    let cached = read_export(&out)
        .expect("cached export")
        .compiler_invocations
        .expect("cached attachment");
    assert!(cached.invocations.is_empty());
    assert!(
        cached
            .gaps
            .contains(&ObservationGap::CachedArtifactNotInvoked)
    );
    build(&fixture.0, false, true);
    assert!(
        read_export(&out)
            .expect("legacy again")
            .compiler_invocations
            .is_none()
    );
}

fn bounded_cli(
    fixture: &Fixture,
    args: &[impl AsRef<std::ffi::OsStr>],
) -> (std::process::ExitStatus, String) {
    use std::process::Stdio;
    use std::time::{Duration, Instant};
    let stderr = fixture.0.join("cli.stderr");
    let mut child = Command::new(env!("CARGO_BIN_EXE_cargo-build-graph"))
        .args(args)
        .current_dir(&fixture.0)
        .env(
            "BUILD_GRAPH_COMPILER_OBSERVER",
            fixture.0.join("config.json"),
        )
        .env("RUSTC_WRAPPER", fixture.wrapper_entry())
        .env("CLI_EXEC_RECEIPT", fixture.0.join("cli-exec.receipt"))
        .env_remove("RUSTC_WORKSPACE_WRAPPER")
        .stdout(Stdio::null())
        .stderr(fs::File::create(&stderr).expect("stderr receipt"))
        .spawn()
        .expect("CLI process");
    let deadline = Instant::now() + Duration::from_secs(3);
    let status = loop {
        if let Some(status) = child.try_wait().expect("CLI status") {
            break status;
        }
        if Instant::now() >= deadline {
            child.kill().expect("stop timed out CLI");
            child.wait().expect("reap timed out CLI");
            panic!("CLI failed to terminate before the bounded deadline");
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    (status, fs::read_to_string(stderr).expect("stderr"))
}

#[test]
fn inherited_observer_environment_preserves_direct_and_cargo_cli_dispatch() {
    let fixture = Fixture::new();
    for command in [
        "build", "watch", "update", "find", "refs", "context", "view", "serve",
    ] {
        assert!(
            bounded_cli(&fixture, &[command, "--help"]).0.success(),
            "direct {command}"
        );
        assert!(
            bounded_cli(&fixture, &["build-graph", command, "--help"])
                .0
                .success(),
            "cargo plugin {command}"
        );
    }
    assert!(!fixture.0.join("target").exists());
}

#[test]
fn inherited_observer_configuration_does_not_execute_non_utf8_cli_arguments() {
    use std::os::unix::ffi::OsStringExt;
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    let compiler = fixture.0.join(std::ffi::OsString::from_vec(vec![
        b'c', b'u', b's', b't', b'o', b'm', 0xff,
    ]));
    fs::write(
        &compiler,
        "#!/bin/sh\nprintf invoked > \"$CLI_EXEC_RECEIPT\"\n",
    )
    .expect("custom executable");
    fs::set_permissions(&compiler, fs::Permissions::from_mode(0o700)).expect("custom permissions");
    // A direct CLI positional argument is not an implicit executable command.
    let args = [
        compiler.into_os_string(),
        std::ffi::OsString::from_vec(vec![b'x', 0xff, b'y']),
    ];
    let (status, _) = bounded_cli(&fixture, &args);
    assert!(!status.success());
    assert!(!fixture.0.join("cli-exec.receipt").exists());
    assert!(!fixture.0.join("target").exists());
}

#[test]
fn watch_no_build_observation_conflict_rejects_before_metadata_or_watch() {
    let fixture = Fixture::new();
    for args in [
        vec!["watch", "--no-build", "--observe-compiler-inputs"],
        vec![
            "build-graph",
            "watch",
            "--observe-compiler-inputs",
            "--no-build",
        ],
    ] {
        let (status, stderr) = bounded_cli(&fixture, &args);
        assert!(!status.success());
        assert!(stderr.contains("cannot be used with"));
        assert!(stderr.contains("--no-build") && stderr.contains("--observe-compiler-inputs"));
        assert!(!stderr.contains("watch: watching"));
        assert!(!stderr.contains("watch: initial refresh"));
        assert!(!fixture.0.join("target").exists());
    }
}

#[test]
fn real_and_nested_wrapper_dispatch_preserves_original_os_arguments() {
    use std::os::unix::ffi::{OsStrExt, OsStringExt};
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    fixture.write(
        "workspace-wrapper",
        "#!/bin/sh\nprintf '%s\\000' \"$@\" > \"$WRAPPER_RECEIPT\"\nexec \"$@\"\n",
    );
    let wrapper = fixture.0.join("workspace-wrapper");
    fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o700))
        .expect("workspace wrapper executable");
    let names = [
        std::ffi::OsString::from("rustc"),
        std::ffi::OsString::from("custom-compiler"),
        std::ffi::OsString::from("build"),
        std::ffi::OsString::from_vec(vec![b'c', b'u', b's', b't', b'o', b'm', b'-', 0xff]),
    ];
    let args = [
        std::ffi::OsString::from("--fixture-argument"),
        std::ffi::OsString::from_vec(vec![b'x', 0xff, b'y']),
    ];
    let expected: Vec<u8> = args
        .iter()
        .flat_map(|arg| {
            arg.as_os_str()
                .as_bytes()
                .iter()
                .copied()
                .chain(std::iter::once(0))
        })
        .collect();
    for name in names {
        let compiler = fixture.0.join(name);
        fs::write(
            &compiler,
            "#!/bin/sh\nprintf '%s\\000' \"$@\" > \"$ARG_RECEIPT\"\nexit \"$FIXTURE_EXIT\"\n",
        )
        .expect("compiler executable");
        fs::set_permissions(&compiler, fs::Permissions::from_mode(0o700))
            .expect("compiler permissions");
        for nested in [false, true] {
            for exit in [0, 23] {
                let mut command = Command::new(fixture.wrapper_entry());
                if nested {
                    command.arg(&wrapper);
                }
                let status = command
                    .arg(&compiler)
                    .args(&args)
                    .env(
                        "BUILD_GRAPH_COMPILER_OBSERVER",
                        fixture.0.join("absent-config.json"),
                    )
                    .env("ARG_RECEIPT", fixture.0.join("compiler.args"))
                    .env("WRAPPER_RECEIPT", fixture.0.join("wrapper.args"))
                    .env("FIXTURE_EXIT", exit.to_string())
                    .status()
                    .expect("actual wrapper delegation");
                assert_eq!(status.code(), Some(exit));
                assert_eq!(
                    fs::read(fixture.0.join("compiler.args")).expect("compiler original args"),
                    expected
                );
                if nested {
                    let mut nested_expected = compiler.as_os_str().as_bytes().to_vec();
                    nested_expected.push(0);
                    nested_expected.extend_from_slice(&expected);
                    assert_eq!(
                        fs::read(fixture.0.join("wrapper.args"))
                            .expect("workspace wrapper original args"),
                        nested_expected
                    );
                }
            }
        }
    }
}

fn actual_custom_compiler_build(nested: bool) {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    fixture.write(
        "Cargo.toml",
        "[package]\nname='custom_compiler_demo'\nversion='0.1.0'\nedition='2024'\n[workspace]\n",
    );
    fixture.write("src/lib.rs", "pub struct ThroughCustomCompiler;\n");
    fixture.write("build.rs", "fn main(){let cli=std::env::var_os(\"GRAPH_CLI\").unwrap();for args in [vec![\"build\",\"--help\"],vec![\"build-graph\",\"build\",\"--help\"]]{assert!(std::process::Command::new(&cli).args(args).status().unwrap().success());}println!(\"cargo:rerun-if-changed=build.rs\");}\n");
    fixture.write("custom-compiler", "#!/bin/sh\nfor arg in \"$@\"; do\ncase \"$arg\" in -vV) printf 'query\\n' >> \"$CUSTOM_RECEIPT\" ;; --crate-name) printf 'compile\\n' >> \"$CUSTOM_RECEIPT\" ;; esac\ndone\nexec \"$REAL_RUSTC\" \"$@\"\n");
    fixture.write(
        "workspace-wrapper",
        "#!/bin/sh\nprintf 'workspace\\n' >> \"$WORKSPACE_RECEIPT\"\nexec \"$@\"\n",
    );
    for name in ["custom-compiler", "workspace-wrapper"] {
        fs::set_permissions(fixture.0.join(name), fs::Permissions::from_mode(0o700))
            .expect("forwarding executable");
    }
    let real_compiler = std::env::var_os("RUSTC")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "rustc".into());
    // Keep a configured relative path anchored to the shared job's cwd when
    // the actual Cargo fixture moves to its own workspace. Preserve aliases.
    let compiler_path = Path::new(&real_compiler);
    let real_compiler = if compiler_path.is_relative() && compiler_path.components().count() > 1 {
        std::env::current_dir()
            .expect("job cwd")
            .join(compiler_path)
            .into_os_string()
    } else {
        real_compiler
    };
    let mut command = Command::new(env!("CARGO_BIN_EXE_cargo-build-graph"));
    command
        .current_dir(&fixture.0)
        .args(["build", "--observe-compiler-inputs"])
        .env_remove("RUSTC_WRAPPER")
        .env_remove("RUSTC_WORKSPACE_WRAPPER")
        .env(
            "BUILD_GRAPH_COMPILER_OBSERVER",
            "inherited-cli-observer-config",
        )
        .env("RUSTC", fixture.0.join("custom-compiler"))
        .env("REAL_RUSTC", real_compiler)
        .env("GRAPH_CLI", env!("CARGO_BIN_EXE_cargo-build-graph"))
        .env("CUSTOM_RECEIPT", fixture.0.join("compiler.receipt"))
        .env("WORKSPACE_RECEIPT", fixture.0.join("workspace.receipt"));
    if nested {
        command.env(
            "RUSTC_WORKSPACE_WRAPPER",
            fixture.0.join("workspace-wrapper"),
        );
    }
    let output = command
        .output()
        .expect("actual Cargo custom compiler build");
    assert!(
        output.status.success(),
        "actual custom compiler build failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let receipt =
        fs::read_to_string(fixture.0.join("compiler.receipt")).expect("actual compiler receipt");
    assert!(receipt.lines().any(|line| line == "query"));
    assert!(receipt.lines().any(|line| line == "compile"));
    if nested {
        assert!(
            fs::read_to_string(fixture.0.join("workspace.receipt"))
                .expect("workspace receipt")
                .lines()
                .any(|line| line == "workspace")
        );
    }
    let facts = read_export(&fixture.0.join("target/build-graph"))
        .expect("actual custom compiler export")
        .compiler_invocations
        .expect("actual optional attachment");
    facts
        .validate()
        .expect("valid unknown compiler observations");
    assert!(
        facts.invocations.is_empty(),
        "unrecognized compiler shape must not fabricate qualified units"
    );
    assert!(
        facts
            .gaps
            .contains(&ObservationGap::CompilerIdentityUnavailable)
    );
    assert!(
        facts
            .gaps
            .contains(&ObservationGap::UnobservedExecutionInputs)
    );
    let runs: Vec<_> = fs::read_dir(fixture.0.join("target/build-graph-observer"))
        .expect("observer parent")
        .collect();
    assert!(
        runs.is_empty(),
        "owned per-run alias and config must be removed"
    );
}

#[test]
fn actual_cargo_direct_custom_rustc_keeps_queries_build_and_inherited_cli() {
    actual_custom_compiler_build(false);
}

#[test]
fn actual_cargo_nested_custom_rustc_keeps_queries_build_and_inherited_cli() {
    actual_custom_compiler_build(true);
}
