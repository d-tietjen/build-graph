#![cfg(feature = "rustc-driver")]
use std::process::Command;
#[test]
fn compiler_context_requires_existing_semantic_route() {
    let result = Command::new(env!("CARGO_BIN_EXE_cargo-build-graph"))
        .args(["build", "--observe-compiler-context"])
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("--observe-semantic-stream"));
}
#[test]
fn test_harness_requires_existing_semantic_route() {
    let result = Command::new(env!("CARGO_BIN_EXE_cargo-build-graph"))
        .args(["build", "--observe-test-harness"])
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("--observe-semantic-stream"));
}
