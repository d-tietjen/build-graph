//! Final selected commands keep explicit flag precedence and bounds.
use super::*;
use crate::test_support::Workspace;

fn command() -> Command {
    let mut command = Command::new("selected-cargo");
    for name in [
        "RUSTFLAGS",
        "RUSTDOCFLAGS",
        "CARGO_ENCODED_RUSTFLAGS",
        "CARGO_ENCODED_RUSTDOCFLAGS",
    ] {
        command.env_remove(name);
    }
    command
}
fn root(workspace: &Workspace) -> PathBuf {
    workspace
        .root
        .join("sysroot with spaces")
        .into_std_path_buf()
}

#[test]
fn explicit_sysroot_preserves_plain_compiler_and_rustdoc_flags_as_encoded_arguments() {
    let workspace = Workspace::new(&[("demo", "demo")]);
    let sysroot = root(&workspace);
    let mut command = command();
    command
        .env("RUSTFLAGS", "--cfg selected -C opt-level=1")
        .env(
            "RUSTDOCFLAGS",
            "-Z unstable-options --output-format json --document-private-items",
        );
    apply_sysroot(&mut command, &sysroot).expect("composed flags");
    assert_eq!(
        command_value(&command, "CARGO_ENCODED_RUSTFLAGS").unwrap(),
        format!(
            "--cfg\x1fselected\x1f-C\x1fopt-level=1\x1f--sysroot={}",
            sysroot.display()
        )
    );
    assert_eq!(
        command_value(&command, "CARGO_ENCODED_RUSTDOCFLAGS").unwrap(),
        format!(
            "-Z\x1funstable-options\x1f--output-format\x1fjson\x1f--document-private-items\x1f--sysroot={}",
            sysroot.display()
        )
    );
}

#[test]
fn explicit_sysroot_preserves_encoded_precedence_spaces_and_empty_arguments() {
    let workspace = Workspace::new(&[("demo", "demo")]);
    let sysroot = root(&workspace);
    let mut command = command();
    command.env("RUSTFLAGS", "--sysroot=/ignored-plain").env(
        "CARGO_ENCODED_RUSTFLAGS",
        "--cfg\x1fvalue with spaces\x1f\x1f-C\x1fopt-level=2",
    );
    apply_sysroot(&mut command, &sysroot).unwrap();
    assert_eq!(
        command_value(&command, "CARGO_ENCODED_RUSTFLAGS").unwrap(),
        format!(
            "--cfg\x1fvalue with spaces\x1f\x1f-C\x1fopt-level=2\x1f--sysroot={}",
            sysroot.display()
        )
    );
}

#[test]
fn matching_explicit_sysroot_is_idempotent_in_both_flag_forms() {
    let workspace = Workspace::new(&[("demo", "demo")]);
    let sysroot = root(&workspace);
    for flags in [
        format!("--sysroot\x1f{}", sysroot.display()),
        format!("--sysroot={}", sysroot.display()),
    ] {
        let mut command = command();
        command.env("CARGO_ENCODED_RUSTFLAGS", &flags);
        apply_sysroot(&mut command, &sysroot).unwrap();
        apply_sysroot(&mut command, &sysroot).unwrap();
        assert_eq!(
            command_value(&command, "CARGO_ENCODED_RUSTFLAGS").unwrap(),
            flags
        );
    }
}

#[test]
fn conflicting_duplicate_or_incomplete_sysroot_flags_fail_before_operation() {
    let workspace = Workspace::new(&[("demo", "demo")]);
    let sysroot = root(&workspace);
    for flags in [
        "--sysroot=/different".into(),
        "--sysroot".into(),
        format!(
            "--sysroot={}\x1f--sysroot={}",
            sysroot.display(),
            sysroot.display()
        ),
    ] {
        for name in ["CARGO_ENCODED_RUSTFLAGS", "CARGO_ENCODED_RUSTDOCFLAGS"] {
            let mut command = command();
            command.env(name, &flags);
            assert!(apply_sysroot(&mut command, &sysroot).is_err());
        }
    }
}

#[test]
fn explicit_sysroot_addition_obeys_final_argument_and_text_caps() {
    let workspace = Workspace::new(&[("demo", "demo")]);
    for flags in [
        std::iter::repeat_n("x", MAX_ARGUMENTS)
            .collect::<Vec<_>>()
            .join("\x1f"),
        "x".repeat(MAX_TEXT_BYTES),
        "x".repeat(MAX_TEXT_BYTES + 1),
    ] {
        let mut command = command();
        command.env("CARGO_ENCODED_RUSTFLAGS", flags);
        assert!(apply_sysroot(&mut command, &root(&workspace)).is_err());
    }
}

#[cfg(unix)]
#[test]
fn explicit_sysroot_rejects_nonutf8_flags_without_executing_command() {
    use std::os::unix::ffi::OsStringExt;
    let workspace = Workspace::new(&[("demo", "demo")]);
    let mut command = command();
    command.env("CARGO_ENCODED_RUSTFLAGS", OsString::from_vec(vec![0xff]));
    assert!(apply_sysroot(&mut command, &root(&workspace)).is_err());
}

#[test]
fn selected_session_checks_final_flags_before_ordinal_or_route_and_keeps_exact_tools() {
    let workspace = Workspace::new(&[("demo", "demo")]);
    let sysroot = root(&workspace);
    let mut session = CargoLaunchSession::new(
        "selected-cargo".into(),
        "supplied-rustc".into(),
        "supplied-rustdoc".into(),
        "matching-toolchain".into(),
        sysroot.join("lib"),
        &[],
    )
    .unwrap();
    session.explicit_sysroot = Some(sysroot.clone());
    session.explicit_flags = Some([
        OsString::from(format!("--sysroot={}", sysroot.display())),
        OsString::from(format!("--sysroot={}", sysroot.display())),
    ]);
    let mut rejected = command();
    rejected.env("CARGO_ENCODED_RUSTDOCFLAGS", "--sysroot=/different");
    assert!(
        session
            .begin(&mut rejected, CargoOperationKind::Metadata)
            .is_err()
    );
    assert_eq!(session.ordinal, 0);
    assert!(session.operations.is_empty());
    for kind in [
        CargoOperationKind::Metadata,
        CargoOperationKind::Build,
        CargoOperationKind::Docs,
    ] {
        let mut command = Command::new("selected-cargo");
        session.configure(&mut command, false);
        session.begin(&mut command, kind).unwrap();
        assert_eq!(command_value(&command, "RUSTC").unwrap(), "supplied-rustc");
        assert_eq!(
            command_value(&command, "RUSTDOC").unwrap(),
            "supplied-rustdoc"
        );
        for name in ["CARGO_ENCODED_RUSTFLAGS", "CARGO_ENCODED_RUSTDOCFLAGS"] {
            assert_eq!(
                command_value(&command, name).unwrap(),
                format!("--sysroot={}", sysroot.display())
            );
        }
    }
    assert!(
        session.set_explicit_sysroot(sysroot).is_err(),
        "cannot change after operation one"
    );
}

#[test]
fn complete_flag_baseline_requires_both_roles_but_accepts_explicit_empty_values() {
    let mut command = command();
    assert!(require_explicit_flag_baseline(&command).is_err());
    command.env("RUSTFLAGS", "");
    assert!(require_explicit_flag_baseline(&command).is_err());
    command.env("CARGO_ENCODED_RUSTDOCFLAGS", "");
    assert!(require_explicit_flag_baseline(&command).is_ok());
}

#[test]
fn rich_doc_flags_append_to_the_complete_encoded_baseline_without_losing_it() {
    let workspace = Workspace::new(&[("demo", "demo")]);
    let sysroot = root(&workspace);
    let baseline = [
        OsString::from(format!(
            "--cfg\x1fselected\x1f--sysroot={}",
            sysroot.display()
        )),
        OsString::from(format!(
            "--cfg\x1fdoc_selected\x1f--sysroot={}",
            sysroot.display()
        )),
    ];
    let mut command = Command::new("selected-cargo");
    command.env(
        "RUSTDOCFLAGS",
        "-Z unstable-options --output-format json --document-private-items",
    );
    compose_explicit_flag_baseline(&mut command, &baseline).unwrap();
    apply_sysroot(&mut command, &sysroot).unwrap();
    assert_eq!(
        command_value(&command, "CARGO_ENCODED_RUSTFLAGS").unwrap(),
        baseline[0]
    );
    assert_eq!(
        command_value(&command, "CARGO_ENCODED_RUSTDOCFLAGS").unwrap(),
        format!(
            "{}\x1f-Z\x1funstable-options\x1f--output-format\x1fjson\x1f--document-private-items",
            baseline[1].to_str().unwrap()
        )
    );
}

#[cfg(target_os = "linux")]
#[test]
fn routed_overlays_cannot_change_tools_remove_sysroot_or_add_conflicting_sysroots() {
    let workspace = Workspace::new(&[("demo", "demo")]);
    let sysroot = root(&workspace);
    let mut command = command();
    command
        .env("RUSTC", "supplied-rustc")
        .env("RUSTDOC", "supplied-rustdoc");
    apply_sysroot(&mut command, &sysroot).unwrap();
    require_final_explicit_selection(
        &command,
        &sysroot,
        Path::new("supplied-rustc"),
        Path::new("supplied-rustdoc"),
    )
    .unwrap();
    command.env("RUSTC", "different-rustc");
    assert!(
        require_final_explicit_selection(
            &command,
            &sysroot,
            Path::new("supplied-rustc"),
            Path::new("supplied-rustdoc")
        )
        .is_err()
    );
    command
        .env("RUSTC", "supplied-rustc")
        .env("CARGO_ENCODED_RUSTFLAGS", "--cfg\x1fchanged");
    assert!(
        require_final_explicit_selection(
            &command,
            &sysroot,
            Path::new("supplied-rustc"),
            Path::new("supplied-rustdoc")
        )
        .is_err()
    );
    command.env("CARGO_ENCODED_RUSTFLAGS", "--sysroot=/different");
    assert!(
        require_final_explicit_selection(
            &command,
            &sysroot,
            Path::new("supplied-rustc"),
            Path::new("supplied-rustdoc")
        )
        .is_err()
    );
}

#[test]
fn plain_flags_reject_encoded_separator_instead_of_changing_argument_semantics() {
    let workspace = Workspace::new(&[("demo", "demo")]);
    let mut command = command();
    command.env("RUSTFLAGS", "--cfg\x1fselected");
    assert!(apply_sysroot(&mut command, &root(&workspace)).is_err());
}
