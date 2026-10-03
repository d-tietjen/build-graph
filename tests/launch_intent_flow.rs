//! Real connected-channel, sealed-carrier and selected CLI regressions.
//! Fixtures test observations and failure ordering, never original-owner authority.
#![cfg(target_os = "linux")]

use build_graph::launch_intent::*;
use std::collections::BTreeMap;
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::net::UnixStream;
use std::process::{Command, Stdio};

fn binding(operation: u64) -> Binding {
    Binding {
        session: "fixture-session".into(),
        operation,
        request: format!("request-{operation}"),
        root: "opaque-root".into(),
        kind: "metadata".into(),
    }
}

fn pair() -> (Observer, Channel) {
    let (child, parent) = UnixStream::pair().expect("real connected stream");
    (
        Observer::new(
            Channel::new(child).expect("child channel"),
            "opaque-root".into(),
        )
        .expect("observer"),
        Channel::new(parent).expect("parent channel"),
    )
}

fn ack(channel: &mut Channel, bytes: &[u8], binding: Binding) {
    channel
        .send(
            &response_bytes(&Response::Acknowledged {
                binding,
                event_sha256: sha256(bytes),
            })
            .expect("bounded ACK"),
            None,
        )
        .expect("actual ACK");
}

fn route(channel: &mut Channel, overlay: Vec<EnvironmentChange>, nonce: String) -> Binding {
    let frame = channel.receive().expect("actual route");
    assert!(frame.descriptor.is_none());
    let Event::Route {
        intent,
        request_sha256,
    } = read_event(&frame.bytes).expect("versioned route")
    else {
        panic!("route required")
    };
    assert_eq!(intent.schema_version, VERSION);
    assert_eq!(request_sha256, sha256(&encoded(&intent).expect("intent")));
    assert_eq!(intent.argv.first(), Some(&intent.program));
    assert!(intent.cwd.starts_with(b"/"));
    let binding = intent.binding;
    channel
        .send(
            &response_bytes(&Response::Route {
                binding: binding.clone(),
                request_sha256,
                route_nonce: nonce,
                environment: overlay,
            })
            .expect("bounded route response"),
            None,
        )
        .expect("route response");
    binding
}

fn final_intent(channel: &mut Channel, expected: &Binding) -> FinalIntent {
    let frame = channel.receive().expect("actual final notice");
    let Event::Intent {
        binding,
        route_nonce,
        route_response_sha256,
        carrier_bytes,
        carrier_sha256,
    } = read_event(&frame.bytes).expect("notice")
    else {
        panic!("intent required")
    };
    assert_eq!(&binding, expected);
    let descriptor = frame.descriptor.expect("exact transferred carrier");
    let mut file = File::from(descriptor);
    assert_eq!(
        unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFD) } & libc::FD_CLOEXEC,
        libc::FD_CLOEXEC
    );
    assert_eq!(
        unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GET_SEALS) },
        libc::F_SEAL_SEAL | libc::F_SEAL_WRITE | libc::F_SEAL_GROW | libc::F_SEAL_SHRINK
    );
    assert_eq!(
        file.metadata().expect("carrier metadata").len(),
        u64::from(carrier_bytes)
    );
    assert!(carrier_bytes as usize <= MAX_EVENT_BYTES);
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(u64::from(carrier_bytes) + 1)
        .read_to_end(&mut bytes)
        .expect("bounded carrier read");
    assert_eq!(bytes.len(), carrier_bytes as usize);
    assert_eq!(carrier_sha256, sha256(&bytes));
    let result: FinalIntent = serde_json::from_slice(&bytes).expect("strict final intent");
    assert_eq!(result.intent.binding, binding);
    assert_eq!(result.route_nonce, route_nonce);
    assert_eq!(result.route_response_sha256, route_response_sha256);
    assert!(
        file.write_all(b"x").is_err(),
        "sealed carrier cannot change"
    );
    ack(channel, &frame.bytes, binding);
    result
}

fn lifecycle(channel: &mut Channel, expected: &Binding, terminal: &str) {
    let frame = channel.receive().expect("actual lifecycle event");
    assert!(frame.descriptor.is_none());
    let event = read_event(&frame.bytes).expect("versioned lifecycle");
    match (terminal, event) {
        ("spawned", Event::Spawned { binding, pid }) => {
            assert_eq!(&binding, expected);
            assert!(pid > 0);
        }
        (
            "completed",
            Event::Completed {
                binding,
                exit_code,
                signal,
            },
        ) => {
            assert_eq!(&binding, expected);
            assert_eq!(exit_code, Some(0));
            assert!(signal.is_none());
        }
        ("spawn_failed", Event::SpawnFailed { binding })
        | ("unavailable", Event::Unavailable { binding }) => assert_eq!(&binding, expected),
        _ => panic!("unexpected lifecycle"),
    }
    ack(channel, &frame.bytes, expected.clone());
}

#[test]
fn canonical_environment_hash_is_length_delimited_and_secret_values_are_omitted() {
    assert_eq!(
        sha256(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    let env = BTreeMap::from([
        (b"A".to_vec(), b"bc".to_vec()),
        (b"AB".to_vec(), b"c".to_vec()),
    ]);
    let digest = digest_environment(&env).expect("bounded environment");
    let mut canonical = ENVIRONMENT_DOMAIN.to_vec();
    canonical.extend_from_slice(&2u64.to_le_bytes());
    for (key, value) in &env {
        canonical.extend_from_slice(&(key.len() as u64).to_le_bytes());
        canonical.extend_from_slice(key);
        canonical.extend_from_slice(&(value.len() as u64).to_le_bytes());
        canonical.extend_from_slice(value);
    }
    assert_eq!(digest.sha256, sha256(&canonical));
    assert_eq!(digest.entries, 2);
    assert_eq!(digest.bytes, 7);
    let alternate = BTreeMap::from([
        (b"A".to_vec(), b"b".to_vec()),
        (b"AB".to_vec(), b"cc".to_vec()),
    ]);
    assert_ne!(
        digest.sha256,
        digest_environment(&alternate).expect("alternate").sha256
    );
    let json = serde_json::to_string(&digest).expect("digest JSON");
    assert!(!json.contains("\"bc\"") && !json.contains("\"AB\""));
}

#[test]
fn raw_non_utf8_environment_and_explicit_empty_base_keep_exact_delivery() {
    use std::os::unix::ffi::OsStringExt;
    let mut command = Command::new("/usr/bin/env");
    command.env_clear().env(
        std::ffi::OsString::from_vec(vec![b'K', 0xff]),
        std::ffi::OsString::from_vec(vec![0xfe]),
    );
    freeze_environment(&mut command, false).expect("raw environment freeze");
    let intent = command_intent(&command, binding(1)).expect("exact intent");
    assert_eq!(
        intent.environment,
        digest_environment(&BTreeMap::from([(vec![b'K', 0xff], vec![0xfe])])).expect("raw digest")
    );
    assert_eq!(intent.argv, vec![b"/usr/bin/env".to_vec()]);
    assert_eq!(
        command.output().expect("actual child").stdout,
        vec![b'K', 0xff, b'=', 0xfe, b'\n']
    );
}

#[test]
fn actual_sealed_intent_overlay_spawn_and_wait_use_the_same_operation() {
    let (mut observer, mut parent) = pair();
    let server = std::thread::spawn(move || {
        let correlation = route(
            &mut parent,
            vec![
                EnvironmentChange {
                    name: b"VISIBLE".to_vec(),
                    value: Some(b"new".to_vec()),
                },
                EnvironmentChange {
                    name: b"REMOVE".to_vec(),
                    value: None,
                },
            ],
            "1".repeat(64),
        );
        let intent = final_intent(&mut parent, &correlation);
        assert_eq!(
            intent.intent.environment,
            digest_environment(&BTreeMap::from([(b"VISIBLE".to_vec(), b"new".to_vec())]))
                .expect("final full env")
        );
        lifecycle(&mut parent, &correlation, "spawned");
        lifecycle(&mut parent, &correlation, "completed");
    });
    let mut command = Command::new("/usr/bin/env");
    command
        .env_clear()
        .env("VISIBLE", "old")
        .env("REMOVE", "removed")
        .stdout(Stdio::piped());
    let routed = observer
        .route(&mut command, binding(1), false)
        .expect("actual routing");
    let prepared = observer
        .prepare(command, routed)
        .expect("same sealed intent ACK");
    let (child, prepared) = prepared.spawn().unwrap_or_else(|_| panic!("actual spawn"));
    observer.spawned(&prepared, child.id()).expect("PID ACK");
    let output = child.wait_with_output().expect("same actual child wait");
    assert_eq!(output.stdout, b"VISIBLE=new\n");
    observer
        .complete(prepared, output.status)
        .expect("wait ACK");
    server.join().expect("parent");
}

#[test]
fn changed_command_after_overlay_cannot_obtain_final_ack_or_spawn() {
    let (mut observer, mut parent) = pair();
    let server = std::thread::spawn(move || {
        route(&mut parent, vec![], "2".repeat(64));
        assert!(parent.receive().is_err(), "no final carrier after change");
    });
    let mut command = Command::new("/usr/bin/true");
    let routed = observer
        .route(&mut command, binding(1), false)
        .expect("route");
    command.env("LATE_MUTATION", "changed");
    assert!(observer.prepare(command, routed).is_err());
    drop(observer);
    server.join().expect("parent");
}

#[test]
fn mismatched_route_and_permanent_failure_fence_prevent_a_later_operation() {
    let (mut observer, mut parent) = pair();
    let server = std::thread::spawn(move || {
        let frame = parent.receive().expect("route");
        let Event::Route {
            intent,
            request_sha256,
        } = read_event(&frame.bytes).expect("route")
        else {
            panic!("route")
        };
        parent
            .send(
                &response_bytes(&Response::Route {
                    binding: binding(2),
                    request_sha256,
                    route_nonce: "3".repeat(64),
                    environment: vec![],
                })
                .expect("response"),
                None,
            )
            .expect("response send");
        lifecycle(&mut parent, &intent.binding, "unavailable");
        let frame = parent.receive().expect("failure observation");
        assert!(matches!(
            read_event(&frame.bytes).expect("event"),
            Event::Unavailable { .. }
        ));
        ack(&mut parent, &frame.bytes, binding(2));
    });
    let mut command = Command::new("/usr/bin/true");
    assert!(observer.route(&mut command, binding(1), false).is_err());
    assert!(observer.route(&mut command, binding(2), false).is_err());
    server.join().expect("parent");
}

#[test]
fn unsupported_version_and_unknown_fields_are_rejected_without_raw_value_errors() {
    for bytes in [br#"{"schema_version":2,"payload":{"response":"denied","binding":{"session":"s","operation":1,"request":"r","root":"o","kind":"metadata"}}}"#.as_slice(), br#"{"schema_version":1,"secret":"do-not-print","payload":{"response":"denied","binding":{"session":"s","operation":1,"request":"r","root":"o","kind":"metadata"}}}"#.as_slice()] {
        let error = match read_response(bytes) { Ok(_) => panic!("invalid envelope accepted"), Err(error) => error };
        assert!(!error.to_string().contains("do-not-print"));
    }
}

#[test]
fn connected_descriptor_type_and_truncated_frames_fail_closed() {
    let file = File::open("/dev/null").expect("actual non-socket");
    let stream = unsafe { UnixStream::from_raw_fd(std::os::fd::IntoRawFd::into_raw_fd(file)) };
    assert!(Channel::new(stream).is_err());
    let (mut writer, reader) = UnixStream::pair().expect("pair");
    let mut channel = Channel::new(reader).expect("channel");
    writer
        .write_all(&[0, 0, 0, 0, 5, b'{'])
        .expect("partial frame");
    drop(writer);
    assert!(channel.receive().is_err());
    assert!(channel.receive().is_err());
}

#[test]
fn stream_split_and_coalesced_frames_keep_the_fixed_ancillary_boundary() {
    let (mut writer, reader) = UnixStream::pair().expect("pair");
    let mut channel = Channel::new(reader).expect("channel");
    let server = std::thread::spawn(move || {
        for byte in [0, 0, 0, 0, 2, b'{', b'}'] {
            writer.write_all(&[byte]).expect("split write");
        }
        writer
            .write_all(&[0, 0, 0, 0, 2, b'[', b']', 0, 0, 0, 0, 2, b'{', b'}'])
            .expect("coalesced writes");
    });
    assert_eq!(channel.receive().expect("split frame").bytes, b"{}");
    assert_eq!(channel.receive().expect("coalesced first").bytes, b"[]");
    assert_eq!(channel.receive().expect("coalesced second").bytes, b"{}");
    server.join().expect("writer");
}

#[test]
fn event_environment_overlay_and_aggregate_caps_are_independent() {
    assert!(encoded(&vec![b'x'; MAX_EVENT_BYTES]).is_err());
    assert!(
        digest_environment(&BTreeMap::from([(
            b"K".to_vec(),
            vec![b'x'; MAX_ENVIRONMENT_BYTES]
        )]))
        .is_err()
    );
    assert!(digest_environment(&BTreeMap::from([(b"BAD=KEY".to_vec(), vec![])])).is_err());
    let (stream, peer) = UnixStream::pair().expect("pair");
    let mut channel = Channel::new(stream).expect("channel");
    let server = std::thread::spawn(move || {
        let mut channel = Channel::new(peer).expect("peer");
        for _ in 0..7 {
            channel.receive().expect("charged frame");
        }
    });
    for _ in 0..7 {
        channel
            .send(&vec![b'x'; MAX_EVENT_BYTES], None)
            .expect("within cumulative cap");
    }
    assert!(channel.send(&vec![b'x'; MAX_EVENT_BYTES], None).is_err());
    server.join().expect("reader");
}

#[test]
fn real_spawn_failure_retains_carrier_through_owning_failure_ack() {
    let (mut observer, mut parent) = pair();
    let server = std::thread::spawn(move || {
        let b = route(&mut parent, vec![], "4".repeat(64));
        final_intent(&mut parent, &b);
        lifecycle(&mut parent, &b, "spawn_failed");
    });
    let mut command = Command::new("/definitely-absent-launch-intent-fixture");
    let routed = observer
        .route(&mut command, binding(1), false)
        .expect("route");
    let prepared = observer.prepare(command, routed).expect("intent");
    let (error, prepared) = match prepared.spawn() {
        Ok(_) => panic!("missing executable spawned"),
        Err(value) => value,
    };
    assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
    observer
        .spawn_failed(prepared)
        .expect("original failure ACK");
    server.join().expect("parent");
}

#[cfg(feature = "rustc-driver")]
mod cli {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);

    struct Workspace(PathBuf);
    impl Workspace {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "launch-intent-cli-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&root).expect("exclusive actual fixture");
            std::fs::create_dir(root.join("src")).expect("source directory");
            std::fs::write(root.join("Cargo.toml"), "[package]\nname='launch_intent_demo'\nversion='0.1.0'\nedition='2024'\n[workspace]\n").expect("manifest");
            std::fs::write(
                root.join("src/lib.rs"),
                "pub fn observed()->u32{1}\npub fn caller()->u32{observed()}\n",
            )
            .expect("actual source");
            std::fs::write(root.join("build.rs"), "fn main(){let token=std::env::var(\"BUILD_GRAPH_TEST_LAUNCH_TOKEN\").expect(\"routed overlay delivered\");assert!(token.starts_with(\"operation-\"));std::fs::write(\"launch-delivered.txt\",b\"present\\n\").unwrap();println!(\"cargo:rerun-if-env-changed=BUILD_GRAPH_TEST_LAUNCH_TOKEN\");}\n").expect("actual build script");
            Self(root)
        }
        fn command(&self, fd: i32) -> Command {
            use std::os::unix::process::CommandExt;
            let driver = std::env::var_os("BUILD_GRAPH_DRIVER")
                .expect("shared actual pinned driver gate required");
            assert!(
                std::path::Path::new(&driver).is_file(),
                "actual built pinned driver required"
            );
            let mut command = Command::new(env!("CARGO_BIN_EXE_cargo-build-graph"));
            command
                .args(["build", "--manifest-path"])
                .arg(self.0.join("Cargo.toml"))
                .args([
                    "--observe-compiler-inputs",
                    "--observe-definition-occurrences",
                    "--rich",
                    "--nightly",
                    "nightly-2026-02-27",
                    "--cargo-launch-observer-fd",
                ])
                .arg(fd.to_string())
                .args(["--cargo-launch-root", "opaque-cli-root"])
                .current_dir(&self.0)
                .env("BUILD_GRAPH_DRIVER", driver)
                .env_remove("RUSTC_WRAPPER")
                .env_remove("RUSTC_WORKSPACE_WRAPPER")
                .env_remove("BG_DRIVER_OCCURRENCE_REQUEST");
            if let Some(cargo) = std::env::var_os("BUILD_GRAPH_TEST_OCCURRENCE_CARGO") {
                command.arg("--occurrence-cargo").arg(cargo);
            }
            unsafe {
                command.pre_exec(move || {
                    let flags = libc::fcntl(fd, libc::F_GETFD);
                    if flags < 0 || libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
            command
        }
    }
    impl Drop for Workspace {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn actual_cli_selected_metadata_build_and_docs_all_ack_frozen_intents() {
        let workspace = Workspace::new();
        let (child, parent) = UnixStream::pair().expect("original fixture pair");
        let mut command = workspace.command(child.as_raw_fd());
        let server = std::thread::spawn(move || {
            let mut channel = Channel::new(parent).expect("parent channel");
            let mut intents = Vec::new();
            loop {
                let frame = match channel.receive() {
                    Ok(frame) => frame,
                    Err(_) => break,
                };
                assert!(frame.descriptor.is_none(), "route carries no FD");
                let Event::Route {
                    intent,
                    request_sha256,
                } = read_event(&frame.bytes).expect("actual versioned route")
                else {
                    panic!("new route required")
                };
                assert_eq!(intent.binding.operation, intents.len() as u64 + 1);
                assert_eq!(intent.binding.root, "opaque-cli-root");
                assert_eq!(
                    request_sha256,
                    sha256(&encoded(&intent).expect("exact request"))
                );
                assert_eq!(intent.argv[0], intent.program);
                let response = Response::Route {
                    binding: intent.binding.clone(),
                    request_sha256,
                    route_nonce: format!("{:064x}", intent.binding.operation),
                    environment: vec![EnvironmentChange {
                        name: b"BUILD_GRAPH_TEST_LAUNCH_TOKEN".to_vec(),
                        value: Some(format!("operation-{}", intent.binding.operation).into_bytes()),
                    }],
                };
                channel
                    .send(&response_bytes(&response).expect("response"), None)
                    .expect("response send");
                let final_value = final_intent(&mut channel, &intent.binding);
                assert_eq!(final_value.intent.program, intent.program);
                assert_eq!(final_value.intent.argv, intent.argv);
                assert_eq!(final_value.intent.cwd, intent.cwd);
                assert_ne!(
                    final_value.intent.environment.sha256, intent.environment.sha256,
                    "overlay changes delivered digest"
                );
                assert!(final_value.intent.environment.complete);
                lifecycle(&mut channel, &intent.binding, "spawned");
                lifecycle(&mut channel, &intent.binding, "completed");
                intents.push(final_value);
            }
            intents
        });
        let output = command.output().expect("actual CLI spawn/wait");
        drop(child);
        assert!(
            output.status.success(),
            "genuine selected build failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let intents = server.join().expect("original fixture owner");
        assert!(
            intents
                .iter()
                .filter(|value| value.intent.binding.kind == "metadata")
                .count()
                >= 2
        );
        assert_eq!(
            intents
                .iter()
                .filter(|value| value.intent.binding.kind == "build")
                .count(),
            1
        );
        assert_eq!(
            intents
                .iter()
                .filter(|value| value.intent.binding.kind == "docs")
                .count(),
            1
        );
        for intent in &intents {
            assert!(
                intent
                    .intent
                    .argv
                    .iter()
                    .any(|arg| arg == intent.intent.binding.kind.as_bytes()
                        || intent.intent.binding.kind == "docs" && arg == b"doc")
            );
        }
        assert_eq!(
            std::fs::read(workspace.0.join("launch-delivered.txt"))
                .expect("actual build script ran"),
            b"present\n"
        );
        let export = build_graph::output::read_export(&workspace.0.join("target/build-graph"))
            .expect("genuine original export reader");
        let observations = export
            .compiler_invocations
            .expect("actual invocation facts");
        observations.validate().expect("original validation");
        let raw = serde_json::to_vec(&observations).expect("existing DTO");
        assert!(
            !raw.windows(b"operation-1".len())
                .any(|window| window == b"operation-1"),
            "overlay value stays outside exported facts"
        );
    }

    #[test]
    fn actual_cli_denied_first_metadata_never_spawns_cargo_or_publishes_graph() {
        let workspace = Workspace::new();
        let (child, parent) = UnixStream::pair().expect("original fixture pair");
        let mut command = workspace.command(child.as_raw_fd());
        let server = std::thread::spawn(move || {
            let mut channel = Channel::new(parent).expect("channel");
            let frame = channel
                .receive()
                .expect("actual first selected metadata reached seam");
            assert!(frame.descriptor.is_none());
            let Event::Route { intent, .. } = read_event(&frame.bytes).expect("route") else {
                panic!("route")
            };
            assert_eq!(intent.binding.kind, "metadata");
            assert_eq!(intent.binding.operation, 1);
            channel
                .send(
                    &response_bytes(&Response::Denied {
                        binding: intent.binding.clone(),
                    })
                    .expect("denial"),
                    None,
                )
                .expect("denial send");
            lifecycle(&mut channel, &intent.binding, "unavailable");
            assert!(
                channel.receive().is_err(),
                "no final carrier/PID/later operation after denial"
            );
        });
        let output = command.output().expect("actual CLI ownership");
        drop(child);
        assert!(!output.status.success());
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("launch route was not accepted"),
            "must fail on actual denial rather than unrelated setup"
        );
        server.join().expect("parent");
        assert!(!workspace.0.join("target").exists());
        assert!(!workspace.0.join("launch-delivered.txt").exists());
    }
}

#[test]
fn equal_commands_cannot_transfer_pending_intents_between_concurrent_observers() {
    let (mut first, mut parent_a) = pair();
    let (mut second, mut parent_b) = pair();
    let a = std::thread::spawn(move || {
        route(&mut parent_a, vec![], "6".repeat(64));
        assert!(parent_a.receive().is_err());
    });
    let b = std::thread::spawn(move || {
        route(&mut parent_b, vec![], "6".repeat(64));
        assert!(parent_b.receive().is_err());
    });
    let mut command_a = Command::new("/usr/bin/true");
    let mut command_b = Command::new("/usr/bin/true");
    let routed_a = first
        .route(&mut command_a, binding(1), false)
        .expect("first route");
    let routed_b = second
        .route(&mut command_b, binding(1), false)
        .expect("second route");
    assert!(
        second.prepare(command_b, routed_a).is_err(),
        "equal bytes do not transfer operation ownership"
    );
    assert!(first.prepare(command_a, routed_b).is_err());
    drop(first);
    drop(second);
    a.join().expect("first parent");
    b.join().expect("second parent");
}

#[test]
fn repeated_nonce_is_rejected_after_a_genuine_first_child_completes() {
    let (mut observer, mut parent) = pair();
    let server = std::thread::spawn(move || {
        let first = route(&mut parent, vec![], "7".repeat(64));
        final_intent(&mut parent, &first);
        lifecycle(&mut parent, &first, "spawned");
        lifecycle(&mut parent, &first, "completed");
        let second = route(&mut parent, vec![], "7".repeat(64));
        lifecycle(&mut parent, &second, "unavailable");
    });
    let mut command = Command::new("/usr/bin/true");
    let routed = observer
        .route(&mut command, binding(1), false)
        .expect("first route");
    let (mut child, prepared) = observer
        .prepare(command, routed)
        .expect("first intent")
        .spawn()
        .unwrap_or_else(|_| panic!("actual first child"));
    observer.spawned(&prepared, child.id()).expect("spawn ACK");
    observer
        .complete(prepared, child.wait().expect("actual first wait"))
        .expect("terminal ACK");
    assert!(
        observer
            .route(&mut Command::new("/usr/bin/true"), binding(2), false)
            .is_err()
    );
    server.join().expect("parent");
}

#[test]
fn duplicate_keys_overlay_count_and_overlay_raw_bytes_fail_before_final_intent() {
    let cases = [
        vec![
            EnvironmentChange {
                name: b"DUP".to_vec(),
                value: Some(b"a".to_vec()),
            },
            EnvironmentChange {
                name: b"DUP".to_vec(),
                value: None,
            },
        ],
        (0..MAX_OVERLAY_ENTRIES + 1)
            .map(|i| EnvironmentChange {
                name: format!("K{i}").into_bytes(),
                value: None,
            })
            .collect(),
        vec![EnvironmentChange {
            name: b"K".to_vec(),
            value: Some(vec![1; MAX_OVERLAY_BYTES]),
        }],
    ];
    for changes in cases {
        let (mut observer, mut parent) = pair();
        let server = std::thread::spawn(move || {
            let b = route(&mut parent, changes, "8".repeat(64));
            lifecycle(&mut parent, &b, "unavailable");
        });
        assert!(
            observer
                .route(&mut Command::new("/usr/bin/true"), binding(1), false)
                .is_err()
        );
        server.join().expect("parent");
    }
}

#[test]
fn missing_final_ack_rejects_prepared_spawn_and_poisoned_observer() {
    let (mut observer, mut parent) = pair();
    let server = std::thread::spawn(move || {
        route(&mut parent, vec![], "9".repeat(64));
        let frame = parent.receive().expect("actual carrier notice");
        assert!(frame.descriptor.is_some()); /* drop channel without ACK */
    });
    let mut command = Command::new("/usr/bin/true");
    let routed = observer
        .route(&mut command, binding(1), false)
        .expect("route");
    assert!(
        observer.prepare(command, routed).is_err(),
        "no PreparedLaunch on missing ACK"
    );
    assert!(
        observer
            .route(&mut Command::new("/usr/bin/true"), binding(2), false)
            .is_err()
    );
    server.join().expect("parent");
}

#[test]
fn contradictory_final_ack_and_descriptor_response_cannot_permit_spawn() {
    for descriptor_response in [false, true] {
        let (mut observer, mut parent) = pair();
        let server = std::thread::spawn(move || {
            if descriptor_response {
                let frame = parent.receive().expect("route");
                let Event::Route {
                    intent,
                    request_sha256,
                } = read_event(&frame.bytes).expect("route")
                else {
                    panic!("route")
                };
                let file = File::open("/dev/null").expect("unexpected finite descriptor");
                parent
                    .send(
                        &response_bytes(&Response::Route {
                            binding: intent.binding.clone(),
                            request_sha256,
                            route_nonce: "a".repeat(64),
                            environment: vec![],
                        })
                        .expect("response"),
                        Some(&file),
                    )
                    .expect("descriptor response");
                lifecycle(&mut parent, &intent.binding, "unavailable");
            } else {
                let b = route(&mut parent, vec![], "b".repeat(64));
                let frame = parent.receive().expect("carrier");
                assert!(frame.descriptor.is_some());
                parent
                    .send(
                        &response_bytes(&Response::Acknowledged {
                            binding: b,
                            event_sha256: "0".repeat(64),
                        })
                        .expect("stale ACK"),
                        None,
                    )
                    .expect("stale ACK send");
            }
        });
        let mut command = Command::new("/usr/bin/true");
        match observer.route(&mut command, binding(1), false) {
            Ok(routed) => {
                assert!(!descriptor_response);
                assert!(observer.prepare(command, routed).is_err());
            }
            Err(_) => assert!(descriptor_response),
        }
        server.join().expect("parent");
    }
}
