//! The existing separate driver pass uses supplied tools in explicit mode.
use super::*;
use crate::{Cli, Cmd, driver_refs::selected_reference_command, test_support::Workspace};
use camino::Utf8PathBuf;
use clap::Parser;

#[test]
fn separate_driver_check_uses_exact_supplied_cargo_compilers_and_prebuilt_driver() {
    let workspace = Workspace::new(&[("demo", "demo")]);
    std::fs::create_dir(workspace.root.join("lib")).unwrap();
    let executable = std::env::current_exe().unwrap();
    let mut args = vec![
        std::ffi::OsString::from("cargo-build-graph"),
        "build".into(),
        "--observe-compiler-inputs".into(),
        "--observe-definition-occurrences".into(),
    ];
    for option in [
        "--occurrence-cargo",
        "--occurrence-rustc",
        "--occurrence-rustdoc",
        "--driver-bin",
    ] {
        args.push(option.into());
        args.push(executable.as_os_str().to_owned());
    }
    args.push("--occurrence-sysroot".into());
    args.push(workspace.root.as_std_path().as_os_str().to_owned());
    let Cmd::Build(parsed) = Cli::try_parse_from(args).unwrap().cmd else {
        panic!("build");
    };
    let mut selected = crate::cargo_launch::CargoLaunchSession::new(
        executable.clone(),
        executable.clone(),
        executable.clone(),
        "matching-toolchain".into(),
        workspace.root.join("lib").into_std_path_buf(),
        &[],
    )
    .unwrap();
    // This direct command fixture does not discover or claim qualified tools.
    // Exercise the original setter with a complete inherited baseline in the
    // actual CLI controls; here inspect the selected command independently.
    selected.explicit_sysroot = Some(workspace.root.as_std_path().to_owned());
    selected.explicit_flags = Some([
        OsString::from(format!("--sysroot={}", workspace.root)),
        OsString::from(format!("--sysroot={}", workspace.root)),
    ]);
    let driver = Utf8PathBuf::from_path_buf(executable.clone()).unwrap();
    let command = selected_reference_command(
        &workspace.root,
        &workspace.root.join("edges"),
        &workspace.root.join("check"),
        &driver,
        &selected,
    )
    .unwrap();
    assert_eq!(command.get_program(), executable.as_os_str());
    let args: Vec<_> = command.get_args().collect();
    assert_eq!(args[0], "check");
    assert!(
        !args
            .iter()
            .any(|arg| arg.to_string_lossy().starts_with('+'))
    );
    for name in ["RUSTC", "RUSTDOC", "RUSTC_WORKSPACE_WRAPPER"] {
        assert_eq!(
            command.get_envs().find(|(key, _)| *key == name).unwrap().1,
            Some(executable.as_os_str())
        );
    }
    assert!(
        parsed.common.driver_requested(),
        "retain original driver enablement"
    );
    assert_eq!(
        command
            .get_envs()
            .find(|(key, _)| *key == "CARGO_ENCODED_RUSTFLAGS")
            .unwrap()
            .1
            .unwrap(),
        format!("--sysroot={}", workspace.root)
    );
}

#[cfg(target_os = "linux")]
#[test]
fn distinct_driver_check_uses_same_session_carrier_child_and_wait_without_attachment_relabel() {
    use build_graph::launch_intent::*;
    use std::io::Read;
    use std::os::unix::net::UnixStream;
    let workspace = Workspace::new(&[("demo", "demo")]);
    let mut selected = CargoLaunchSession::new(
        "/bin/sh".into(),
        "/bin/sh".into(),
        "/bin/sh".into(),
        "observed-fixture".into(),
        workspace.root.join("lib").into_std_path_buf(),
        &[],
    )
    .unwrap();
    selected.explicit_sysroot = Some(workspace.root.as_std_path().to_owned());
    selected.explicit_flags = Some([
        OsString::from(format!("--sysroot={}", workspace.root)),
        OsString::from(format!("--sysroot={}", workspace.root)),
    ]);
    let (child, parent) = UnixStream::pair().unwrap();
    selected
        .set_launch_observer(
            Observer::new(Channel::new(child).unwrap(), "observed-root".into()).unwrap(),
        )
        .unwrap();
    let server = std::thread::spawn(move || {
        let mut channel = Channel::new(parent).unwrap();
        let frame = channel.receive().unwrap();
        let Event::Route {
            intent,
            request_sha256,
        } = read_event(&frame.bytes).unwrap()
        else {
            panic!("route");
        };
        assert_eq!(intent.binding.operation, 1);
        assert_eq!(intent.binding.kind, "driver_check");
        let binding = intent.binding.clone();
        channel
            .send(
                &response_bytes(&Response::Route {
                    binding: binding.clone(),
                    request_sha256,
                    route_nonce: "c".repeat(64),
                    environment: Vec::new(),
                })
                .unwrap(),
                None,
            )
            .unwrap();
        let frame = channel.receive().unwrap();
        let Event::Intent {
            carrier_bytes,
            carrier_sha256,
            ..
        } = read_event(&frame.bytes).unwrap()
        else {
            panic!("intent");
        };
        let mut carrier =
            std::fs::File::from(frame.descriptor.as_ref().unwrap().try_clone().unwrap());
        let mut bytes = Vec::new();
        carrier
            .by_ref()
            .take(u64::from(carrier_bytes) + 1)
            .read_to_end(&mut bytes)
            .unwrap();
        assert_eq!(bytes.len(), carrier_bytes as usize);
        assert_eq!(sha256(&bytes), carrier_sha256);
        let frozen: FinalIntent = serde_json::from_slice(&bytes).unwrap();
        assert!(frozen.intent == intent);
        channel
            .send(
                &response_bytes(&Response::Acknowledged {
                    binding: binding.clone(),
                    event_sha256: sha256(&frame.bytes),
                })
                .unwrap(),
                None,
            )
            .unwrap();
        let frame = channel.receive().unwrap();
        assert!(matches!(read_event(&frame.bytes).unwrap(), Event::Spawned { pid, .. } if pid > 0));
        channel
            .send(
                &response_bytes(&Response::Acknowledged {
                    binding: binding.clone(),
                    event_sha256: sha256(&frame.bytes),
                })
                .unwrap(),
                None,
            )
            .unwrap();
        let frame = channel.receive().unwrap();
        assert!(matches!(
            read_event(&frame.bytes).unwrap(),
            Event::Completed {
                exit_code: Some(17),
                signal: None,
                ..
            }
        ));
        channel
            .send(
                &response_bytes(&Response::Acknowledged {
                    binding,
                    event_sha256: sha256(&frame.bytes),
                })
                .unwrap(),
                None,
            )
            .unwrap();
    });
    let mut command = Command::new("/bin/sh");
    command.args(["-c", "exit 17"]);
    selected.configure(&mut command, true);
    let status = selected
        .launch_reference_check(command)
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(status.code(), Some(17));
    server.join().unwrap();
    assert_eq!(selected.ordinal, 1);
    assert!(
        selected.operations.is_empty(),
        "no metadata/build/docs relabel"
    );
    assert!(selected.finish(&[]).operations.is_empty());
}

#[test]
fn explicit_driver_check_preserves_original_operation_bound_before_spawn() {
    let workspace = Workspace::new(&[("demo", "demo")]);
    let mut selected = CargoLaunchSession::new(
        "must-not-spawn".into(),
        "supplied-rustc".into(),
        "supplied-rustdoc".into(),
        "observed-fixture".into(),
        workspace.root.join("lib").into_std_path_buf(),
        &[],
    )
    .unwrap();
    selected.explicit_sysroot = Some(workspace.root.as_std_path().to_owned());
    selected.explicit_flags = Some([
        OsString::from(format!("--sysroot={}", workspace.root)),
        OsString::from(format!("--sysroot={}", workspace.root)),
    ]);
    selected.ordinal = MAX_CARGO_OPERATIONS as u64;
    assert!(
        selected
            .launch_reference_check(Command::new("must-not-spawn"))
            .is_err()
    );
    assert_eq!(selected.ordinal, MAX_CARGO_OPERATIONS as u64);
    assert!(selected.operations.is_empty());
}
