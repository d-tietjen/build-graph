//! Pure selection and argument checks; these paths create no qualified role.
use super::*;
use crate::{Cli, Cmd, test_support::Workspace};
use clap::Parser;
use std::ffi::OsString;

fn arguments(root: &Path) -> Vec<OsString> {
    let tool = std::env::current_exe().expect("actual fixture executable");
    vec![
        "cargo-build-graph".into(),
        "build".into(),
        "--observe-compiler-inputs".into(),
        "--observe-definition-occurrences".into(),
        "--occurrence-cargo".into(),
        tool.clone().into_os_string(),
        "--occurrence-rustc".into(),
        tool.clone().into_os_string(),
        "--occurrence-rustdoc".into(),
        tool.clone().into_os_string(),
        "--occurrence-sysroot".into(),
        root.as_os_str().to_owned(),
        "--driver-bin".into(),
        tool.into_os_string(),
    ]
}
fn common(arguments: Vec<OsString>) -> CommonArgs {
    let Cmd::Build(build) = Cli::try_parse_from(arguments)
        .expect("complete CLI set")
        .cmd
    else {
        panic!("build");
    };
    build.common
}

#[test]
fn explicit_cli_requires_every_supplied_tool_sysroot_and_prebuilt_driver() {
    let workspace = Workspace::new(&[("demo", "demo")]);
    for name in [
        "--occurrence-cargo",
        "--occurrence-rustc",
        "--occurrence-rustdoc",
        "--occurrence-sysroot",
        "--driver-bin",
    ] {
        let mut args = arguments(workspace.root.as_std_path());
        let index = args.iter().position(|value| value == name).expect("option");
        args.drain(index..index + 2);
        assert!(Cli::try_parse_from(args).is_err(), "incomplete {name}");
    }
}

#[test]
fn explicit_cli_requires_both_actual_observation_options() {
    let workspace = Workspace::new(&[("demo", "demo")]);
    for name in [
        "--observe-compiler-inputs",
        "--observe-definition-occurrences",
    ] {
        let mut args = arguments(workspace.root.as_std_path());
        args.retain(|value| value != name);
        assert!(Cli::try_parse_from(args).is_err());
    }
}

#[test]
fn absent_explicit_options_and_legacy_cargo_selection_remain_absent() {
    for mut args in [
        vec!["cargo-build-graph", "build"],
        vec![
            "cargo-build-graph",
            "build",
            "--observe-compiler-inputs",
            "--observe-definition-occurrences",
        ],
    ] {
        if args.len() > 2 {
            args.extend(["--occurrence-cargo", "legacy-cargo"]);
        }
        let selected = common(args.into_iter().map(OsString::from).collect());
        assert!(
            ExplicitToolchain::selected(&selected)
                .expect("omitted new inputs")
                .is_none()
        );
    }
}

#[test]
fn complete_explicit_selection_retains_exact_paths_without_discovery() {
    let workspace = Workspace::new(&[("demo", "demo")]);
    std::fs::create_dir(workspace.root.join("lib")).expect("sysroot library");
    let selected = common(arguments(workspace.root.as_std_path()));
    let tools = ExplicitToolchain::selected(&selected)
        .expect("selection")
        .expect("explicit mode");
    assert_eq!(tools.cargo, std::env::current_exe().unwrap());
    assert_eq!(tools.rustc, tools.cargo);
    assert_eq!(tools.rustdoc, tools.cargo);
    assert_eq!(tools.sysroot, workspace.root.as_std_path());
}

#[test]
fn explicit_paths_reject_relative_traversal_controls_and_text_overflow() {
    assert!(validate_path(Path::new("relative/tool")).is_err());
    let root = std::env::temp_dir();
    for suffix in [
        "../tool".to_owned(),
        "tool\n".into(),
        "x".repeat(build_graph::compiler_invocation::MAX_TEXT_BYTES + 1),
    ] {
        assert!(validate_path(&root.join(suffix)).is_err());
    }
}

#[test]
fn explicit_selection_rejects_missing_tools_directories_and_incomplete_sysroot() {
    let workspace = Workspace::new(&[("demo", "demo")]);
    let mut selected = common(arguments(workspace.root.as_std_path()));
    assert!(ExplicitToolchain::selected(&selected).is_err());
    std::fs::create_dir(workspace.root.join("lib")).expect("sysroot library");
    selected.occurrence_rustc = Some(workspace.root.join("missing-rustc").to_string());
    assert!(ExplicitToolchain::selected(&selected).is_err());
    selected.occurrence_rustc = Some(workspace.root.to_string());
    assert!(ExplicitToolchain::selected(&selected).is_err());
}

#[cfg(unix)]
#[test]
fn explicit_selection_rejects_nonexecutable_supplied_compiler() {
    use std::os::unix::fs::PermissionsExt;
    let workspace = Workspace::new(&[("demo", "demo")]);
    std::fs::create_dir(workspace.root.join("lib")).unwrap();
    let path = workspace.root.join("not-executable");
    std::fs::write(&path, "fixture bytes").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    let mut selected = common(arguments(workspace.root.as_std_path()));
    selected.occurrence_rustc = Some(path.to_string());
    assert!(ExplicitToolchain::selected(&selected).is_err());
}
