//! Actual observer configuration/delegation controls. These shims are failure
//! controls; genuine compiler positives live in the separate integration suite.
use super::*;
use crate::test_support::Workspace;
use std::os::unix::fs::PermissionsExt;

fn configured(workspace: &Workspace) -> Session {
    let mut session = Session::new(
        workspace.meta.clone(),
        workspace.root.join("target").as_std_path(),
        &[],
    )
    .unwrap();
    session.config.occurrences = true;
    fs::remove_file(&session.path).unwrap();
    exclusive_write(&session.path, &serde_json::to_vec(&session.config).unwrap()).unwrap();
    session
}
#[test]
fn default_config_bytes_omit_fd_mode_and_match_original_field_order() {
    let workspace = Workspace::new(&[("demo", "demo_lib")]);
    let session = Session::new(
        workspace.meta.clone(),
        workspace.root.join("target").as_std_path(),
        &[],
    )
    .unwrap();
    #[derive(Serialize)]
    struct Legacy<'a> {
        directory: &'a Path,
        roots: &'a [RootBinding],
        occurrences: bool,
        semantic_stream: bool,
    }
    let expected = serde_json::to_vec(&Legacy {
        directory: &session.config.directory,
        roots: &session.config.roots,
        occurrences: false,
        semantic_stream: false,
    })
    .unwrap();
    assert_eq!(serde_json::to_vec(&session.config).unwrap(), expected);
    assert_eq!(fs::read(&session.path).unwrap(), expected);
    assert!(serde_json::from_slice::<Config>(&expected).is_ok_and(|v| !v.held_callback_controls));
}
#[test]
fn held_controls_require_occurrence_and_enable_only_before_actual_launch() {
    let workspace = Workspace::new(&[("demo", "demo_lib")]);
    let mut session = Session::new(
        workspace.meta.clone(),
        workspace.root.join("target").as_std_path(),
        &[],
    )
    .unwrap();
    let original = fs::read(&session.path).unwrap();
    assert!(session.enable_held_callback_controls().is_err());
    assert_eq!(fs::read(&session.path).unwrap(), original);
    session.config.occurrences = true;
    session.enable_held_callback_controls().unwrap();
    let actual: Config = serde_json::from_slice(&fs::read(&session.path).unwrap()).unwrap();
    assert!(actual.occurrences && actual.held_callback_controls && !actual.semantic_stream);
    session.enable_semantic_stream().unwrap();
    let actual: Config = serde_json::from_slice(&fs::read(&session.path).unwrap()).unwrap();
    assert!(actual.semantic_stream && actual.held_callback_controls);
}
fn delegation_failure(status: i32, held: bool) {
    let workspace = Workspace::new(&[("demo", "demo_lib")]);
    let mut session = configured(&workspace);
    if held {
        session.enable_held_callback_controls().unwrap();
    }
    // This is an intentionally non-compiler failure/control executable. It
    // cannot prove a successful analysis callback or source qualification.
    let program = workspace.root.join("rustc");
    fs::write(&program,format!("#!/bin/sh\ncase \"$*\" in -vV*) printf 'rustc fixture\\nhost: x86_64-unknown-linux-gnu\\n'; exit 0;; --print*) printf '%s\\n' \"$BUILD_GRAPH_CONTROL_WRAPPER_ROOT/sysroot\"; exit 0;; esac\nprintf '%s\\n' \"${{BG_DRIVER_OCCURRENCE_REQUEST-unset}}\" \"${{BG_DRIVER_SEMANTIC_REQUEST-unset}}\" \"${{BG_DRIVER_OCCURRENCE_REQUEST_FD-unset}}\" \"${{BG_DRIVER_SEMANTIC_REQUEST_FD-unset}}\" > \"$BUILD_GRAPH_CONTROL_WRAPPER_ROOT/delegated\"\nexit {status}\n")).unwrap();
    fs::set_permissions(&program, fs::Permissions::from_mode(0o700)).unwrap();
    if held {
        fs::set_permissions(&session.config.directory, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let args = vec![
        program.to_string(),
        "--crate-name".into(),
        "demo_lib".into(),
        workspace.root.join("demo/src/lib.rs").to_string(),
        "--crate-type".into(),
        "lib".into(),
    ];
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "compiler_observer::held_callback_wrapper_tests::wrapper_child",
            "--ignored",
            "--test-threads=1",
        ])
        .env(CONFIG_ENV, &session.path)
        .env(
            "BUILD_GRAPH_CONTROL_WRAPPER_ARGS",
            serde_json::to_string(&args).unwrap(),
        )
        .env("BUILD_GRAPH_CONTROL_WRAPPER_ROOT", workspace.root.as_str())
        .env("BG_DRIVER_OCCURRENCE_REQUEST_FD", "foreign")
        .env("BG_DRIVER_SEMANTIC_REQUEST_FD", "foreign")
        .current_dir(&workspace.root);
    assert_eq!(command.status().unwrap().code(), Some(status));
    let delegated = fs::read_to_string(workspace.root.join("delegated")).unwrap();
    let values: Vec<_> = delegated.lines().collect();
    assert_eq!(
        &values[2..],
        &["unset", "unset"],
        "ambient FD selectors removed from exact delegated command"
    );
    if held {
        assert_eq!(
            &values[..2],
            &["unset", "unset"],
            "explicit setup failure never falls back to paths"
        );
        let unit = fs::read_dir(&session.config.directory)
            .unwrap()
            .filter_map(|v| v.ok())
            .map(|e| e.path())
            .find(|p| {
                p.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("unit-")
            })
            .expect("actual wrapper observation");
        let actual: CompilerInvocation = serde_json::from_slice(&fs::read(unit).unwrap()).unwrap();
        assert_eq!(actual.exit_code, Some(status));
        assert_eq!(actual.success, status == 0);
        assert!(actual.occurrences.is_none());
        assert!(actual.gaps.contains(&ObservationGap::ReadFailed));
        assert!(
            actual
                .gaps
                .contains(&ObservationGap::OccurrenceCallbackRejected)
        );
    } else {
        assert_ne!(
            values[0], "unset",
            "unchanged legacy request route selected"
        );
    }
}
#[test]
fn actual_explicit_setup_failure_delegates_same_compiler_success_without_path_fallback() {
    delegation_failure(0, true);
}
#[test]
fn actual_explicit_setup_failure_preserves_compiler_nonzero_and_unavailable_gap() {
    delegation_failure(7, true);
}
#[test]
fn actual_default_wrapper_keeps_path_route_and_clears_only_new_ambient_selectors() {
    delegation_failure(0, false);
}

#[test]
#[ignore = "actual parent wrapper relay, not an independent passing positive"]
fn wrapper_child() {
    let args: Vec<String> = serde_json::from_str(
        &std::env::var("BUILD_GRAPH_CONTROL_WRAPPER_ARGS").expect("actual parent args"),
    )
    .unwrap();
    let args: Vec<OsString> = args.into_iter().map(OsString::from).collect();
    std::process::exit(wrapper(&args));
}
