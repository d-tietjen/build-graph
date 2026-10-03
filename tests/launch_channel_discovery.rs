//! Actual CLI discovery helpers must not inherit the adopted launch socket.
//! These controlled failures check descriptor lifetime, not tool qualification.
#![cfg(all(target_os = "linux", feature = "rustc-driver"))]

use std::fs::{self, File};
use std::io::Read;
use std::os::fd::AsRawFd;
use std::os::unix::{fs::MetadataExt, fs::PermissionsExt, net::UnixStream, process::CommandExt};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

static NEXT: AtomicU64 = AtomicU64::new(0);
const PROBE_ROOT: &str = "BUILD_GRAPH_DISCOVERY_PROBE_ROOT";

struct Discovery {
    root: PathBuf,
}

impl Discovery {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "build-graph-channel-discovery-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).expect("exclusive helper fixture");
        fs::write(
            root.join("rustup"),
            "#!/bin/sh\nprintf '%s\\n' \"$*\" > \"$BUILD_GRAPH_DISCOVERY_PROBE_ROOT/call\"\nexec \"$BUILD_GRAPH_DISCOVERY_PROBE_BINARY\" --exact discovery_helper_checks_exact_socket_identity --nocapture\n",
        )
        .expect("controlled first discovery helper");
        fs::set_permissions(root.join("rustup"), fs::Permissions::from_mode(0o700))
            .expect("executable helper");
        Self { root }
    }

    fn command(&self, fd: i32, root: &str) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_cargo-build-graph"));
        command
            .args([
                "build",
                "--observe-compiler-inputs",
                "--observe-definition-occurrences",
                "--nightly",
                "nightly-2026-02-27",
                "--cargo-launch-observer-fd",
            ])
            .arg(fd.to_string())
            .args(["--cargo-launch-root", root])
            .current_dir(&self.root)
            .env("PATH", &self.root)
            .env(PROBE_ROOT, &self.root)
            .env(
                "BUILD_GRAPH_DISCOVERY_PROBE_BINARY",
                std::env::current_exe().expect("actual regression helper executable"),
            );
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

    fn failed_discovery(&self, supplied_cargo: bool) {
        let (child, mut parent) = UnixStream::pair().expect("real connected launch socket");
        let metadata = fs::metadata(format!("/proc/self/fd/{}", child.as_raw_fd()))
            .expect("exact inherited socket identity");
        let mut command = self.command(child.as_raw_fd(), "opaque-discovery-root");
        command
            .env(
                "BUILD_GRAPH_DISCOVERY_SOCKET_DEV",
                metadata.dev().to_string(),
            )
            .env(
                "BUILD_GRAPH_DISCOVERY_SOCKET_INO",
                metadata.ino().to_string(),
            )
            .env(
                "BUILD_GRAPH_DISCOVERY_INCOMING_FD",
                child.as_raw_fd().to_string(),
            );
        if supplied_cargo {
            command
                .arg("--occurrence-cargo")
                .arg(self.root.join("unused-selected-cargo"));
        }
        let output = command
            .output()
            .expect("actual CLI exec and discovery failure");
        drop(child);
        assert!(
            !output.status.success(),
            "helper intentionally rejects discovery"
        );
        assert!(
            String::from_utf8_lossy(&output.stderr)
                .contains("pinned driver toolchain executable unavailable"),
            "the actual earliest helper must run"
        );
        assert_eq!(
            fs::read_to_string(self.root.join("call")).expect("earliest helper ran"),
            format!(
                "which --toolchain nightly-2026-02-27 {}\n",
                if supplied_cargo { "rustc" } else { "cargo" }
            )
        );
        assert_eq!(
            fs::read(self.root.join("result")).expect("actual helper descriptor scan"),
            b"socket_matches=0\nincoming_matches=0\n",
            "neither the supplied slot nor any duplicate may carry the exact socket"
        );
        parent
            .set_read_timeout(Some(Duration::from_secs(3)))
            .expect("bounded closure check");
        let mut byte = [0];
        assert_eq!(
            parent
                .read(&mut byte)
                .expect("failed CLI disposed its private channel"),
            0,
            "discovery failure closes the private duplicate without an operation event"
        );
        assert!(!self.root.join("target").exists());
    }
}

impl Drop for Discovery {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

// The shell shim is the CLI's actual first rustup process. It execs this probe
// without closing or changing descriptors. Only that dedicated child exits 42;
// the ordinary test entry performs no action without its fixture environment.
#[test]
fn discovery_helper_checks_exact_socket_identity() {
    let Some(root) = std::env::var_os(PROBE_ROOT) else {
        return;
    };
    let expected = (
        std::env::var("BUILD_GRAPH_DISCOVERY_SOCKET_DEV")
            .expect("fixture device")
            .parse::<u64>()
            .expect("device"),
        std::env::var("BUILD_GRAPH_DISCOVERY_SOCKET_INO")
            .expect("fixture inode")
            .parse::<u64>()
            .expect("inode"),
    );
    let incoming = std::env::var("BUILD_GRAPH_DISCOVERY_INCOMING_FD")
        .expect("fixture incoming slot")
        .parse::<i32>()
        .expect("slot");
    let descriptors: Vec<_> = fs::read_dir("/proc/self/fd")
        .expect("actual helper descriptor inventory")
        .take(4097)
        .collect::<Result<_, _>>()
        .expect("descriptor entries");
    assert!(
        descriptors.len() <= 4096,
        "bounded fixture descriptor inventory"
    );
    let matches = descriptors
        .iter()
        .filter(|entry| {
            fs::metadata(entry.path())
                .is_ok_and(|metadata| (metadata.dev(), metadata.ino()) == expected)
        })
        .count();
    let incoming_matches = fs::metadata(format!("/proc/self/fd/{incoming}"))
        .is_ok_and(|metadata| (metadata.dev(), metadata.ino()) == expected);
    fs::write(
        PathBuf::from(root).join("result"),
        format!(
            "socket_matches={matches}\nincoming_matches={}\n",
            u8::from(incoming_matches)
        ),
    )
    .expect("fixture-only result");
    std::process::exit(42);
}

#[test]
fn actual_cli_first_cargo_discovery_helper_cannot_inherit_launch_socket() {
    Discovery::new().failed_discovery(false);
}

#[test]
fn actual_cli_first_rustc_discovery_helper_with_supplied_cargo_cannot_inherit_launch_socket() {
    Discovery::new().failed_discovery(true);
}

#[test]
fn actual_cli_invalid_launch_root_closes_channel_before_any_discovery_helper() {
    let fixture = Discovery::new();
    let (child, mut parent) = UnixStream::pair().expect("actual inherited stream");
    let output = fixture
        .command(child.as_raw_fd(), "nonprintable\nroot")
        .output()
        .expect("actual CLI invalid-root admission");
    drop(child);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("launch correlation is invalid"));
    assert!(
        !fixture.root.join("call").exists(),
        "no discovery before root validation"
    );
    parent
        .set_read_timeout(Some(Duration::from_secs(3)))
        .expect("bounded channel disposal");
    assert_eq!(
        parent.read(&mut [0]).expect("invalid-root channel closed"),
        0
    );
}

#[test]
fn actual_cli_regular_fd_rejects_before_any_discovery_helper() {
    let fixture = Discovery::new();
    let file =
        File::create(fixture.root.join("unrelated-regular-file")).expect("invalid transport");
    let output = fixture
        .command(file.as_raw_fd(), "opaque-discovery-root")
        .output()
        .expect("actual CLI transport admission");
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("launch transport must be a connected Unix stream")
    );
    assert!(
        !fixture.root.join("call").exists(),
        "invalid transport never reaches a helper"
    );
    assert!(
        file.metadata().is_ok(),
        "caller process retains its own description"
    );
}
