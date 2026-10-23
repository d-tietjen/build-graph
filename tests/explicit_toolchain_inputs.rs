//! Actual CLI selection and same-session checks. Shims prove failure ordering,
//! while genuine callback checks require the validation job's actual tools.
#![cfg(all(target_os = "linux", feature = "rustc-driver"))]

use build_graph::launch_intent::*;
use std::fs::{self, File};
use std::io::Read;
use std::os::fd::AsRawFd;
use std::os::unix::{fs::PermissionsExt, net::UnixStream, process::CommandExt};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "explicit-tools-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("ambient")).unwrap();
        fs::create_dir_all(root.join("sysroot with spaces/lib")).unwrap();
        fs::create_dir(root.join("src")).unwrap();
        fs::write(
            root.join("Cargo.toml"),
            "[package]\nname='explicit_demo'\nversion='0.1.0'\nedition='2024'\n[workspace]\n",
        )
        .unwrap();
        fs::write(
            root.join("src/lib.rs"),
            "pub fn source()->u32{1}\npub fn caller()->u32{source()}\n",
        )
        .unwrap();
        for tool in ["rustup", "rustc", "rustdoc", "cargo"] {
            Self::script(
                &root.join("ambient").join(tool),
                "#!/bin/sh\nprintf 'discovery\\n' >> \"$BUILD_GRAPH_EXPLICIT_FIXTURE/ambient-call\"\nexit 42\n",
            );
        }
        for tool in ["rustc", "rustdoc", "driver"] {
            Self::script(
                &root.join(tool),
                "#!/bin/sh\nprintf 'supplied-tool\\n' >> \"$BUILD_GRAPH_EXPLICIT_FIXTURE/unexpected-tool-call\"\nexit 42\n",
            );
        }
        Self::script(
            &root.join("cargo"),
            "#!/bin/sh\nprintf '%s\\n' \"$*\" \"$RUSTC\" \"$RUSTDOC\" \"$CARGO_ENCODED_RUSTFLAGS\" \"$CARGO_ENCODED_RUSTDOCFLAGS\" \"${LD_LIBRARY_PATH-}\" > \"$BUILD_GRAPH_EXPLICIT_FIXTURE/selected-call\"\nexit 42\n",
        );
        Self(root)
    }
    fn script(path: &std::path::Path, body: &str) {
        fs::write(path, body).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }
    fn command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_cargo-build-graph"));
        command
            .args([
                "build",
                "--observe-compiler-inputs",
                "--observe-definition-occurrences",
                "--manifest-path",
            ])
            .arg(self.0.join("Cargo.toml"));
        for (name, path) in [
            ("--occurrence-cargo", self.0.join("cargo")),
            ("--occurrence-rustc", self.0.join("rustc")),
            ("--occurrence-rustdoc", self.0.join("rustdoc")),
            ("--occurrence-sysroot", self.0.join("sysroot with spaces")),
            ("--driver-bin", self.0.join("driver")),
        ] {
            command.arg(name).arg(path);
        }
        command
            .current_dir(&self.0)
            .env("PATH", self.0.join("ambient"))
            .env("BUILD_GRAPH_EXPLICIT_FIXTURE", &self.0)
            .env("CARGO_ENCODED_RUSTFLAGS", "--cfg\x1fselected")
            .env("CARGO_ENCODED_RUSTDOCFLAGS", "--cfg\x1fdoc_selected")
            .env_remove("RUSTC_WRAPPER")
            .env_remove("RUSTC_WORKSPACE_WRAPPER")
            .env_remove("RUSTFLAGS")
            .env_remove("RUSTDOCFLAGS")
            .env_remove("LD_LIBRARY_PATH")
            .env_remove("BUILD_GRAPH_DRIVER");
        command
    }
    fn untouched(&self) {
        assert!(
            !self.0.join("ambient-call").exists(),
            "no ambient tool discovery"
        );
        assert!(
            !self.0.join("unexpected-tool-call").exists(),
            "no driver build or compiler/sysroot discovery"
        );
        assert!(
            !self.0.join("target").exists(),
            "no successful publication on failed metadata"
        );
    }
    fn assert_selected_call(&self) {
        let text =
            fs::read_to_string(self.0.join("selected-call")).expect("actual supplied Cargo ran");
        let lines: Vec<_> = text.lines().collect();
        assert!(lines[0].starts_with("metadata "));
        assert_eq!(lines[1], self.0.join("rustc").to_str().unwrap());
        assert_eq!(lines[2], self.0.join("rustdoc").to_str().unwrap());
        assert_eq!(
            lines[3],
            format!(
                "--cfg\x1fselected\x1f--sysroot={}",
                self.0.join("sysroot with spaces").display()
            )
        );
        assert_eq!(
            lines[4],
            format!(
                "--cfg\x1fdoc_selected\x1f--sysroot={}",
                self.0.join("sysroot with spaces").display()
            )
        );
        assert_eq!(
            lines[5],
            self.0.join("sysroot with spaces/lib").to_str().unwrap()
        );
        self.untouched();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn actual_cli_complete_explicit_tools_reach_selected_cargo_with_zero_discovery() {
    let fixture = Fixture::new();
    let output = fixture.command().output().expect("actual CLI");
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("selected Cargo metadata failed"));
    fixture.assert_selected_call();
}

#[test]
fn actual_cli_explicit_mode_requires_both_flag_baselines_before_any_spawn() {
    for missing in ["CARGO_ENCODED_RUSTFLAGS", "CARGO_ENCODED_RUSTDOCFLAGS"] {
        let fixture = Fixture::new();
        let output = fixture.command().env_remove(missing).output().unwrap();
        assert!(!output.status.success());
        assert!(
            String::from_utf8_lossy(&output.stderr)
                .contains("complete compiler and doc flag baseline")
        );
        assert!(!fixture.0.join("selected-call").exists());
        fixture.untouched();
    }
}

#[test]
fn actual_cli_conflicting_sysroot_rejects_before_selected_or_ambient_spawn() {
    for name in ["CARGO_ENCODED_RUSTFLAGS", "CARGO_ENCODED_RUSTDOCFLAGS"] {
        let fixture = Fixture::new();
        let output = fixture
            .command()
            .env(name, "--sysroot=/different")
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("contradict the selected sysroot")
        );
        assert!(!fixture.0.join("selected-call").exists());
        fixture.untouched();
    }
}

#[test]
fn actual_cli_missing_nonexecutable_tool_or_sysroot_rejects_before_any_spawn() {
    for kind in ["missing", "nonexecutable", "sysroot"] {
        let fixture = Fixture::new();
        if kind == "missing" {
            fs::remove_file(fixture.0.join("rustc")).unwrap();
        }
        if kind == "nonexecutable" {
            fs::set_permissions(fixture.0.join("rustc"), fs::Permissions::from_mode(0o600))
                .unwrap();
        }
        if kind == "sysroot" {
            fs::remove_dir(fixture.0.join("sysroot with spaces/lib")).unwrap();
        }
        let output = fixture.command().output().unwrap();
        assert!(!output.status.success());
        assert!(!fixture.0.join("selected-call").exists());
        fixture.untouched();
    }
}

fn ack(channel: &mut Channel, frame: &Frame, binding: Binding) {
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
}

#[test]
fn actual_cli_explicit_session_routes_freezes_acks_and_waits_the_same_selected_metadata() {
    let fixture = Fixture::new();
    let (child, parent) = UnixStream::pair().unwrap();
    let fd = child.as_raw_fd();
    let mut command = fixture.command();
    command.args([
        "--cargo-launch-observer-fd",
        &fd.to_string(),
        "--cargo-launch-root",
        "explicit-fixture-root",
    ]);
    unsafe {
        command.pre_exec(move || {
            let flags = libc::fcntl(fd, libc::F_GETFD);
            if flags < 0 || libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let cargo = fixture.0.join("cargo");
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
        assert_eq!(intent.binding.kind, "metadata");
        assert_eq!(intent.binding.operation, 1);
        assert_eq!(intent.program, cargo.as_os_str().as_encoded_bytes());
        assert_eq!(intent.argv[0], intent.program);
        let binding = intent.binding.clone();
        channel
            .send(
                &response_bytes(&Response::Route {
                    binding: binding.clone(),
                    request_sha256,
                    route_nonce: "a".repeat(64),
                    environment: Vec::new(),
                })
                .unwrap(),
                None,
            )
            .unwrap();
        let frame = channel.receive().unwrap();
        let Event::Intent {
            binding: echoed,
            carrier_bytes,
            carrier_sha256,
            ..
        } = read_event(&frame.bytes).unwrap()
        else {
            panic!("final intent");
        };
        assert_eq!(echoed, binding);
        let mut file = File::from(frame.descriptor.as_ref().unwrap().try_clone().unwrap());
        assert_eq!(
            unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GET_SEALS) },
            libc::F_SEAL_SEAL | libc::F_SEAL_WRITE | libc::F_SEAL_GROW | libc::F_SEAL_SHRINK
        );
        let mut bytes = Vec::new();
        file.by_ref()
            .take(u64::from(carrier_bytes) + 1)
            .read_to_end(&mut bytes)
            .unwrap();
        assert_eq!(bytes.len(), carrier_bytes as usize);
        assert_eq!(sha256(&bytes), carrier_sha256);
        let final_intent: FinalIntent = serde_json::from_slice(&bytes).unwrap();
        assert!(
            final_intent.intent == intent,
            "no post-route selection change"
        );
        ack(&mut channel, &frame, binding.clone());
        let spawned = channel.receive().unwrap();
        assert!(
            matches!(read_event(&spawned.bytes).unwrap(), Event::Spawned { binding: ref value, pid } if value == &binding && pid > 0)
        );
        ack(&mut channel, &spawned, binding.clone());
        let completed = channel.receive().unwrap();
        assert!(
            matches!(read_event(&completed.bytes).unwrap(), Event::Completed { binding: ref value, exit_code: Some(42), signal: None } if value == &binding)
        );
        ack(&mut channel, &completed, binding);
        assert!(
            channel.receive().is_err(),
            "no later operation on failed metadata"
        );
    });
    let output = command.output().unwrap();
    drop(child);
    assert!(!output.status.success());
    server.join().expect("same session owner completed");
    fixture.assert_selected_call();
}

#[test]
fn genuine_explicit_tools_build_rich_docs_and_callback_without_ambient_discovery() {
    let fixture = Fixture::new();
    // Exact actual inputs are required, not a skip or a shim-positive grant.
    let mut replacement = Command::new(env!("CARGO_BIN_EXE_cargo-build-graph"));
    replacement
        .args([
            "build",
            "--observe-compiler-inputs",
            "--observe-definition-occurrences",
            "--observe-semantic-stream",
            "--rich",
            "--nightly",
            "nightly-2026-02-27",
            "--manifest-path",
        ])
        .arg(fixture.0.join("Cargo.toml"));
    for (option, variable) in [
        ("--occurrence-cargo", "BUILD_GRAPH_TEST_EXPLICIT_CARGO"),
        ("--occurrence-rustc", "BUILD_GRAPH_TEST_EXPLICIT_RUSTC"),
        ("--occurrence-rustdoc", "BUILD_GRAPH_TEST_EXPLICIT_RUSTDOC"),
        ("--occurrence-sysroot", "BUILD_GRAPH_TEST_EXPLICIT_SYSROOT"),
        ("--driver-bin", "BUILD_GRAPH_DRIVER"),
    ] {
        let selected = std::env::var_os(variable)
            .expect("shared validation must supply actual matching tools");
        replacement.arg(option).arg(selected);
    }
    // Preserve the normal host linker/assembler PATH while intercepting every
    // ambient discovery executable ahead of it.
    let mut path = vec![fixture.0.join("ambient")];
    path.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    replacement
        .current_dir(&fixture.0)
        .env("PATH", std::env::join_paths(path).unwrap())
        .env("BUILD_GRAPH_EXPLICIT_FIXTURE", &fixture.0)
        .env_remove("RUSTC_WRAPPER")
        .env_remove("RUSTC_WORKSPACE_WRAPPER")
        .env_remove("RUSTFLAGS")
        .env_remove("RUSTDOCFLAGS")
        .env(
            "CARGO_ENCODED_RUSTFLAGS",
            std::env::var_os("BUILD_GRAPH_TEST_EXPLICIT_RUSTFLAGS")
                .expect("actual complete compiler baseline, possibly empty"),
        )
        .env(
            "CARGO_ENCODED_RUSTDOCFLAGS",
            std::env::var_os("BUILD_GRAPH_TEST_EXPLICIT_RUSTDOCFLAGS")
                .expect("actual complete doc baseline, possibly empty"),
        );
    let (child, parent) = UnixStream::pair().unwrap();
    let fd = child.as_raw_fd();
    replacement.args([
        "--cargo-launch-observer-fd",
        &fd.to_string(),
        "--cargo-launch-root",
        "genuine-explicit-root",
    ]);
    unsafe {
        replacement.pre_exec(move || {
            let flags = libc::fcntl(fd, libc::F_GETFD);
            if flags < 0 || libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let server = std::thread::spawn(move || {
        let mut channel = Channel::new(parent).unwrap();
        let mut kinds = Vec::new();
        while let Ok(frame) = channel.receive() {
            let Event::Route {
                intent,
                request_sha256,
            } = read_event(&frame.bytes).unwrap()
            else {
                panic!("route");
            };
            assert_eq!(intent.binding.operation, kinds.len() as u64 + 1);
            let binding = intent.binding.clone();
            channel
                .send(
                    &response_bytes(&Response::Route {
                        binding: binding.clone(),
                        request_sha256,
                        route_nonce: format!("{:064x}", binding.operation),
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
                panic!("carrier");
            };
            let mut carrier = File::from(frame.descriptor.as_ref().unwrap().try_clone().unwrap());
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
            ack(&mut channel, &frame, binding.clone());
            let frame = channel.receive().unwrap();
            assert!(
                matches!(read_event(&frame.bytes).unwrap(), Event::Spawned { pid, .. } if pid > 0)
            );
            ack(&mut channel, &frame, binding.clone());
            let frame = channel.receive().unwrap();
            assert!(matches!(
                read_event(&frame.bytes).unwrap(),
                Event::Completed {
                    exit_code: Some(0),
                    signal: None,
                    ..
                }
            ));
            ack(&mut channel, &frame, binding.clone());
            kinds.push(binding.kind);
        }
        kinds
    });
    let output = replacement.output().expect("genuine actual explicit CLI");
    drop(child);
    let phases = server.join().expect("actual same-session phase owner");
    assert_eq!(
        phases,
        ["metadata", "build", "metadata", "docs", "driver_check"]
    );
    assert!(
        output.status.success(),
        "actual build/docs failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        !fixture.0.join("ambient-call").exists(),
        "zero ambient discovery"
    );
    assert!(!fixture.0.join("unexpected-tool-call").exists());
    let export = build_graph::output::read_export(&fixture.0.join("target/build-graph")).unwrap();
    let facts = export.compiler_invocations.expect("actual compiler facts");
    facts.validate().unwrap();
    let unit = facts
        .invocations
        .iter()
        .find(|unit| unit.unit.crate_name == "explicit_demo")
        .expect("actual unit");
    let occurrences = unit
        .occurrences
        .as_ref()
        .expect("genuine analysis callback");
    assert!(
        occurrences
            .definitions
            .iter()
            .any(|definition| definition.def_path == "source")
    );
    assert!(
        occurrences
            .references
            .iter()
            .any(|reference| reference.source.def_path == "caller"
                && reference.target.def_path == "source")
    );
    let operations = facts.cargo_operations.expect("same selected Cargo session");
    assert!(
        operations
            .operations
            .iter()
            .filter(|value| value.kind
                == build_graph::compiler_invocation::CargoOperationKind::Metadata)
            .count()
            >= 2
    );
    assert_eq!(
        operations
            .operations
            .iter()
            .filter(
                |value| value.kind == build_graph::compiler_invocation::CargoOperationKind::Build
            )
            .count(),
        1
    );
    assert_eq!(operations.operations.iter().filter(|value| value.kind == build_graph::compiler_invocation::CargoOperationKind::Docs).count(), 1);
    assert!(
        operations
            .operations
            .iter()
            .all(|value| value.started && value.success)
    );
}

#[test]
fn actual_cli_routed_tool_or_flag_substitution_fails_before_carrier_or_child() {
    for (name, value) in [
        ("RUSTC", "/different-rustc"),
        ("CARGO_ENCODED_RUSTFLAGS", "--sysroot=/different"),
    ] {
        let fixture = Fixture::new();
        let (child, parent) = UnixStream::pair().unwrap();
        let fd = child.as_raw_fd();
        let mut command = fixture.command();
        command.args([
            "--cargo-launch-observer-fd",
            &fd.to_string(),
            "--cargo-launch-root",
            "substitution-fixture-root",
        ]);
        unsafe {
            command.pre_exec(move || {
                let flags = libc::fcntl(fd, libc::F_GETFD);
                if flags < 0 || libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
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
            channel
                .send(
                    &response_bytes(&Response::Route {
                        binding: intent.binding,
                        request_sha256,
                        route_nonce: "b".repeat(64),
                        environment: vec![EnvironmentChange {
                            name: name.as_bytes().to_vec(),
                            value: Some(value.as_bytes().to_vec()),
                        }],
                    })
                    .unwrap(),
                    None,
                )
                .unwrap();
            assert!(
                channel.receive().is_err(),
                "no final carrier or spawned notification"
            );
        });
        let output = command.output().unwrap();
        drop(child);
        assert!(!output.status.success());
        server.join().unwrap();
        assert!(!fixture.0.join("selected-call").exists());
        fixture.untouched();
    }
}

#[test]
fn actual_cli_explicit_empty_baselines_are_valid_and_driver_is_not_built() {
    let fixture = Fixture::new();
    let output = fixture
        .command()
        .env("CARGO_ENCODED_RUSTFLAGS", "")
        .env("CARGO_ENCODED_RUSTDOCFLAGS", "")
        .output()
        .unwrap();
    assert!(
        !output.status.success(),
        "intentional actual metadata failure"
    );
    assert!(String::from_utf8_lossy(&output.stderr).contains("selected Cargo metadata failed"));
    let call = fs::read_to_string(fixture.0.join("selected-call")).unwrap();
    let lines: Vec<_> = call.lines().collect();
    for index in [3, 4] {
        assert_eq!(
            lines[index],
            format!(
                "--sysroot={}",
                fixture.0.join("sysroot with spaces").display()
            )
        );
    }
    fixture.untouched();
}
