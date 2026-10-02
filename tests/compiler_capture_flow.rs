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
        .env_remove("BUILD_GRAPH_COMPILER_OBSERVER")
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
    fixture.write("build.rs", "fn main(){let out=std::env::var(\"OUT_DIR\").unwrap();std::fs::write(std::path::Path::new(&out).join(\"generated.rs\"),\"pub const GENERATED:u32=1;\").unwrap();println!(\"cargo:rerun-if-changed=build.rs\");}\n");
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
