//! Actual same-stack Child ownership; no fixture supplies original authority.
use super::*;
use build_graph::launch_intent::*;
use std::fs::File;
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;

fn actual_session(program: &str) -> (CargoLaunchSession, Channel) {
    let (child, parent) = UnixStream::pair().expect("actual connected pair");
    let mut session = CargoLaunchSession::new(
        program.into(),
        program.into(),
        program.into(),
        "fixture".into(),
        "/tmp".into(),
        &[],
    )
    .expect("observational session");
    session
        .set_launch_observer(
            Observer::new(Channel::new(child).expect("channel"), "guard-root".into())
                .expect("observer"),
        )
        .expect("install before operations");
    (session, Channel::new(parent).expect("parent"))
}

fn ack(channel: &mut Channel, frame: &[u8], binding: Binding) {
    channel
        .send(
            &response_bytes(&Response::Acknowledged {
                binding,
                event_sha256: sha256(frame),
            })
            .expect("bounded ACK"),
            None,
        )
        .expect("actual ACK");
}

fn accept(channel: &mut Channel) -> (Binding, File) {
    let frame = channel.receive().expect("route");
    let Event::Route {
        intent,
        request_sha256,
    } = read_event(&frame.bytes).expect("route")
    else {
        panic!("route required")
    };
    let binding = intent.binding;
    channel
        .send(
            &response_bytes(&Response::Route {
                binding: binding.clone(),
                request_sha256,
                route_nonce: "5".repeat(64),
                environment: vec![],
            })
            .expect("response"),
            None,
        )
        .expect("route response");
    let frame = channel.receive().expect("sealed intent");
    assert!(matches!(
        read_event(&frame.bytes).expect("intent"),
        Event::Intent { .. }
    ));
    let file = File::from(frame.descriptor.expect("actual carrier"));
    assert_eq!(
        unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GET_SEALS) },
        libc::F_SEAL_WRITE | libc::F_SEAL_GROW | libc::F_SEAL_SHRINK | libc::F_SEAL_SEAL
    );
    ack(channel, &frame.bytes, binding.clone());
    (binding, file)
}

fn direct_child_gone(pid: u32) {
    let mut status = 0;
    assert_eq!(
        unsafe { libc::waitpid(pid as i32, &mut status, libc::WNOHANG) },
        -1
    );
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ECHILD)
    );
    assert!(
        !std::path::Path::new(&format!("/proc/{pid}")).exists(),
        "actual direct child reaped"
    );
}

#[test]
fn dropping_owned_child_cancels_waits_and_retains_carrier_until_terminal_ack() {
    use std::os::unix::fs::MetadataExt;
    let (mut session, mut parent) = actual_session("/bin/sleep");
    let server = std::thread::spawn(move || {
        let (binding, carrier) = accept(&mut parent);
        let frame = parent.receive().expect("actual spawn");
        let Event::Spawned { pid, .. } = read_event(&frame.bytes).expect("spawned") else {
            panic!("spawned")
        };
        ack(&mut parent, &frame.bytes, binding.clone());
        let frame = parent.receive().expect("same-stack cancellation");
        let Event::Cancelled {
            pid: cancelled,
            exit_code,
            signal,
            ..
        } = read_event(&frame.bytes).expect("cancelled")
        else {
            panic!("cancelled")
        };
        assert_eq!(cancelled, Some(pid));
        assert_eq!(exit_code, None);
        assert_eq!(signal, Some(libc::SIGKILL));
        direct_child_gone(pid);
        let inode = carrier.metadata().expect("exact carrier").ino();
        let references = std::fs::read_dir("/proc/self/fd")
            .expect("descriptor readback")
            .filter_map(std::result::Result::ok)
            .filter(|entry| {
                std::fs::metadata(entry.path()).is_ok_and(|metadata| metadata.ino() == inode)
            })
            .count();
        assert!(
            references >= 2,
            "original sender still retains carrier before terminal ACK"
        );
        ack(&mut parent, &frame.bytes, binding);
        pid
    });
    let mut command = Command::new(&session.cargo);
    command.arg("120");
    let child = session
        .launch(command, CargoOperationKind::Build)
        .expect("actual guarded child");
    let pid = child.child.id();
    drop(child);
    assert_eq!(server.join().expect("parent"), pid);
    direct_child_gone(pid);
}

#[test]
fn post_spawn_denial_rolls_back_same_child_and_fences_future_launches() {
    let (mut session, mut parent) = actual_session("/bin/sleep");
    let server = std::thread::spawn(move || {
        let (binding, _carrier) = accept(&mut parent);
        let frame = parent.receive().expect("actual spawn");
        let Event::Spawned { pid, .. } = read_event(&frame.bytes).expect("spawned") else {
            panic!("spawned")
        };
        parent
            .send(
                &response_bytes(&Response::Denied {
                    binding: binding.clone(),
                })
                .expect("denial"),
                None,
            )
            .expect("deny after actual spawn");
        let frame = parent.receive().expect("original rollback");
        assert!(matches!(
            read_event(&frame.bytes).expect("cancelled"),
            Event::Cancelled {
                signal: Some(libc::SIGKILL),
                ..
            }
        ));
        direct_child_gone(pid);
        ack(&mut parent, &frame.bytes, binding);
        let frame = parent.receive().expect("permanent failure observation");
        let Event::Unavailable { binding } = read_event(&frame.bytes).expect("unavailable") else {
            panic!("no second route/spawn")
        };
        ack(&mut parent, &frame.bytes, binding);
        pid
    });
    let mut command = Command::new(&session.cargo);
    command.arg("120");
    assert!(session.launch(command, CargoOperationKind::Build).is_err());
    let mut command = Command::new(&session.cargo);
    command.arg("120");
    assert!(session.launch(command, CargoOperationKind::Build).is_err());
    direct_child_gone(server.join().expect("parent"));
}

#[test]
fn actual_metadata_pipe_overflow_fails_after_same_child_wait_and_terminal_ack() {
    let (mut session, mut parent) = actual_session("/usr/bin/head");
    let server = std::thread::spawn(move || {
        let (binding, _carrier) = accept(&mut parent);
        let frame = parent.receive().expect("spawned");
        let Event::Spawned { pid, .. } = read_event(&frame.bytes).expect("spawned") else {
            panic!("spawned")
        };
        ack(&mut parent, &frame.bytes, binding.clone());
        let frame = parent.receive().expect("actual wait terminal");
        assert!(matches!(
            read_event(&frame.bytes).expect("terminal"),
            Event::Completed { .. }
        ));
        direct_child_gone(pid);
        ack(&mut parent, &frame.bytes, binding);
        pid
    });
    let mut command = Command::new(&session.cargo);
    command
        .args(["-c", "9437184", "/dev/zero"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = session
        .launch(command, CargoOperationKind::Metadata)
        .expect("actual child");
    assert!(child.output().is_err());
    drop(child);
    direct_child_gone(server.join().expect("parent"));
}
