//! CLI option admission on every supported platform, without tool execution.
use std::process::Command;

#[cfg(not(feature = "rustc-driver"))]
#[test]
fn explicit_occurrence_inputs_remain_feature_gated_before_any_tool_spawn() {
    for name in [
        "--occurrence-rustc",
        "--occurrence-rustdoc",
        "--occurrence-sysroot",
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_cargo-build-graph"))
            .args(["build", name, "unused"])
            .output()
            .expect("actual CLI option parsing");
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("unexpected argument"));
    }
}

#[cfg(feature = "rustc-driver")]
#[test]
fn actual_cli_incomplete_explicit_inputs_fail_option_admission_on_every_platform() {
    for name in [
        "--occurrence-rustc",
        "--occurrence-rustdoc",
        "--occurrence-sysroot",
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_cargo-build-graph"))
            .args([
                "build",
                "--observe-compiler-inputs",
                "--observe-definition-occurrences",
                name,
                "unused",
            ])
            .output()
            .expect("actual CLI option parsing");
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("required arguments"));
    }
}

#[test]
fn ordinary_cli_help_remains_available_without_toolchain_inputs_or_discovery() {
    let output = Command::new(env!("CARGO_BIN_EXE_cargo-build-graph"))
        .args(["build", "--help"])
        .output()
        .expect("ordinary CLI help");
    assert!(output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains("--manifest-path"));
}
