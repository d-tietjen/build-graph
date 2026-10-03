//! FD transport selection never invokes tools during option admission.
use std::process::Command;

#[cfg(not(all(target_os = "linux", feature = "rustc-driver")))]
#[test]
fn held_callback_controls_are_linux_and_driver_feature_gated() {
    let output = Command::new(env!("CARGO_BIN_EXE_cargo-build-graph"))
        .args(["build", "--held-callback-controls"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("unexpected argument"));
}
#[cfg(all(target_os = "linux", feature = "rustc-driver"))]
#[test]
fn held_callback_controls_require_actual_occurrence_route_before_tools() {
    let output = Command::new(env!("CARGO_BIN_EXE_cargo-build-graph"))
        .args(["build", "--held-callback-controls"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("required arguments"));
}
#[test]
fn ordinary_help_does_not_require_fd_controls_or_driver_adoption() {
    let output = Command::new(env!("CARGO_BIN_EXE_cargo-build-graph"))
        .args(["build", "--help"])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains("--manifest-path"));
}
