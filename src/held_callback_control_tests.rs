//! Real Linux descriptor/lifecycle controls. No source or execution authority is
//! minted by these generic transport fixtures. Actual compiler gates are separate.
use super::*;
use std::os::fd::IntoRawFd;
use std::os::unix::fs::PermissionsExt;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "held-control-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(fs::canonicalize(path).unwrap())
    }
    fn body(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let path = self.0.join(name);
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .unwrap();
        file.write_all(bytes).unwrap();
        file.sync_all().unwrap();
        path
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn unsealed(raw: &[u8], allow: bool) -> File {
    let flags = libc::MFD_CLOEXEC | if allow { libc::MFD_ALLOW_SEALING } else { 0 };
    // SAFETY: fixed terminated name and exclusively owned returned FD.
    let fd = unsafe { libc::memfd_create(c"generic-control-negative".as_ptr(), flags) };
    assert!(fd >= 3);
    let mut file = unsafe { File::from_raw_fd(fd) };
    assert_eq!(unsafe { libc::fchmod(fd, 0o600) }, 0);
    file.write_all(raw).unwrap();
    file
}
fn transferred(file: &File) -> std::ffi::OsString {
    duplicate(file).unwrap().into_raw_fd().to_string().into()
}
fn receive(first: &File, second: Option<&File>) -> io::Result<ReceivedSealedControls> {
    let a = transferred(first);
    let b = second.map(transferred);
    // SAFETY: each distinct duplicate was transferred, with no other Rust owner.
    unsafe { receive_selectors(Some(&a), b.as_deref()) }
}
fn child_command(mode: &str) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "held_callback_control::tests::transfer_child",
            "--ignored",
            "--test-threads=1",
        ])
        .env("BUILD_GRAPH_CONTROL_FIXTURE_MODE", mode)
        .env_remove(OCCURRENCE_FD_ENV)
        .env_remove(SEMANTIC_FD_ENV);
    command
}
fn same_fd_identity(fd: RawFd, info: &Metadata) -> bool {
    let copy = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 3) };
    if copy < 0 {
        return false;
    }
    let file = unsafe { File::from_raw_fd(copy) };
    file.metadata().is_ok_and(|m| same_inode(&m, info))
}

#[test]
fn freeze_pair_exact_private_bytes_and_full_seals() {
    let fixture = Fixture::new();
    let a = fixture.body("occurrence", b"actual occurrence bytes");
    let b = fixture.body("semantic", b"actual semantic bytes");
    let controls = OwnedSealedControls::from_private_files(&a, Some(&b)).unwrap();
    let received = receive(
        &controls.occurrence.file,
        controls.semantic.as_ref().map(|v| &v.file),
    )
    .unwrap();
    assert_eq!(received.occurrence_bytes(), b"actual occurrence bytes");
    assert_eq!(
        received.semantic_bytes(),
        Some(b"actual semantic bytes".as_slice())
    );
    assert_eq!(
        seals(&received._occurrence_file).unwrap() & REQUIRED_SEALS,
        REQUIRED_SEALS
    );
    assert_ne!(
        received._occurrence_file.metadata().unwrap().ino(),
        received
            ._semantic_file
            .as_ref()
            .unwrap()
            .metadata()
            .unwrap()
            .ino()
    );
}
#[test]
fn shared32k_pair_exact_limit_and_overflow_admitted_before_first_memfd() {
    let fixture = Fixture::new();
    let a = fixture.body("a", &vec![b'a'; MAX_CONTROL_BYTES - 1]);
    let b = fixture.body("b", b"b");
    let controls = OwnedSealedControls::from_private_files(&a, Some(&b)).unwrap();
    let received = receive(
        &controls.occurrence.file,
        controls.semantic.as_ref().map(|v| &v.file),
    )
    .unwrap();
    assert_eq!(
        received.occurrence.len() + received.semantic.as_ref().unwrap().len(),
        MAX_CONTROL_BYTES
    );
    let c = fixture.body("c", b"cc");
    let error = OwnedSealedControls::from_private_files(&a, Some(&c))
        .err()
        .unwrap();
    assert!(is_byte_limit(&error));
    assert_eq!(
        pair_bytes((MAX_CONTROL_BYTES - 1) as u64, Some(2))
            .unwrap_err()
            .kind(),
        io::ErrorKind::InvalidData
    );
}
#[test]
fn actual_body_capacity_is_shared_and_no_duplicate_full_readback_buffer() {
    let fixture = Fixture::new();
    let a = fixture.body("a", b"first");
    let b = fixture.body("b", b"second");
    let controls = OwnedSealedControls::from_private_files(&a, Some(&b)).unwrap();
    let received = receive(
        &controls.occurrence.file,
        controls.semantic.as_ref().map(|v| &v.file),
    )
    .unwrap();
    assert!(
        received.occurrence.capacity() + received.semantic.as_ref().unwrap().capacity()
            <= MAX_CONTROL_BYTES
    );
    let file = &controls.occurrence.file;
    let mut remaining = 4;
    assert!(is_byte_limit(
        &read_body(file, 5, &mut remaining).unwrap_err()
    ));
    assert_eq!(remaining, 4);
}
#[test]
fn private_source_hardlink_and_replacement_fail_before_body_allocation() {
    let fixture = Fixture::new();
    let a = fixture.body("a", b"owned bytes");
    let source = PrivateSource::open(&a).unwrap();
    fs::hard_link(&a, fixture.0.join("alias")).unwrap();
    let mut capacity = MAX_CONTROL_BYTES;
    assert!(source.read(&mut capacity).is_err());
    assert_eq!(
        capacity, MAX_CONTROL_BYTES,
        "rejected before allocation/body read"
    );
    fs::remove_file(fixture.0.join("alias")).unwrap();
    let source = PrivateSource::open(&a).unwrap();
    fs::rename(&a, fixture.0.join("original")).unwrap();
    fixture.body("a", b"owned bytes");
    assert!(source.read(&mut capacity).is_err());
    assert_eq!(capacity, MAX_CONTROL_BYTES);
    fs::remove_file(&a).unwrap();
    fs::rename(fixture.0.join("original"), &a).unwrap();
    assert!(
        source.read(&mut capacity).is_err(),
        "restoration changed original inode ctime"
    );
    assert_eq!(capacity, MAX_CONTROL_BYTES);
}
#[test]
fn private_source_symlink_mode_parent_and_same_inode_pair_are_rejected() {
    let fixture = Fixture::new();
    let a = fixture.body("a", b"data");
    std::os::unix::fs::symlink(&a, fixture.0.join("link")).unwrap();
    assert!(OwnedSealedControls::from_private_files(&fixture.0.join("link"), None).is_err());
    assert!(OwnedSealedControls::from_private_files(&a, Some(&a)).is_err());
    fs::set_permissions(&a, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(OwnedSealedControls::from_private_files(&a, None).is_err());
    fs::set_permissions(&a, fs::Permissions::from_mode(0o600)).unwrap();
    fs::set_permissions(&fixture.0, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(OwnedSealedControls::from_private_files(&a, None).is_err());
}
#[test]
fn actual_source_content_mutation_and_parent_replacement_are_detected() {
    let fixture = Fixture::new();
    let a = fixture.body("a", b"initial");
    let source = PrivateSource::open(&a).unwrap();
    fs::write(&a, b"changed").unwrap();
    let mut capacity = MAX_CONTROL_BYTES;
    assert!(source.read(&mut capacity).is_err());
    assert_eq!(capacity, MAX_CONTROL_BYTES);
    let source = PrivateSource::open(&a).unwrap();
    let old = fixture.0.with_extension("old");
    fs::rename(&fixture.0, &old).unwrap();
    fs::create_dir(&fixture.0).unwrap();
    fs::set_permissions(&fixture.0, fs::Permissions::from_mode(0o700)).unwrap();
    fixture.body("a", b"changed");
    assert!(source.read(&mut capacity).is_err());
    assert_eq!(capacity, MAX_CONTROL_BYTES);
    fs::remove_dir_all(&old).unwrap();
}
#[test]
fn actual_empty_oversized_and_short_descriptor_reads_rejected() {
    let empty = SealedControl::create(c"empty-control", b"").unwrap();
    assert!(receive(&empty.file, None).is_err());
    let oversized =
        SealedControl::create(c"oversized-control", &vec![0; MAX_CONTROL_BYTES + 1]).unwrap();
    assert!(is_byte_limit(
        &receive(&oversized.file, None).err().unwrap()
    ));
    let file = unsealed(b"short", true);
    let mut capacity = MAX_CONTROL_BYTES;
    assert_eq!(
        read_body(&file, 9, &mut capacity).unwrap_err().kind(),
        io::ErrorKind::UnexpectedEof
    );
}
#[test]
fn every_missing_seal_and_future_write_instead_of_write_is_rejected() {
    for missing in [
        libc::F_SEAL_WRITE,
        libc::F_SEAL_GROW,
        libc::F_SEAL_SHRINK,
        libc::F_SEAL_SEAL,
    ] {
        let file = unsealed(b"data", true);
        let mask = REQUIRED_SEALS & !missing;
        assert_eq!(
            unsafe { libc::fcntl(file.as_raw_fd(), libc::F_ADD_SEALS, mask) },
            0
        );
        assert!(receive(&file, None).is_err());
    }
    let file = unsealed(b"data", true);
    assert_eq!(
        unsafe {
            libc::fcntl(
                file.as_raw_fd(),
                libc::F_ADD_SEALS,
                libc::F_SEAL_FUTURE_WRITE
                    | libc::F_SEAL_GROW
                    | libc::F_SEAL_SHRINK
                    | libc::F_SEAL_SEAL,
            )
        },
        0
    );
    assert!(receive(&file, None).is_err());
    assert!(receive(&unsealed(b"data", false), None).is_err());
}
#[test]
fn actual_all_sealed_write_truncate_grow_and_further_seals_fail_eperm() {
    let control = SealedControl::create(c"write-control", b"bytes").unwrap();
    let fd = control.file.as_raw_fd();
    for result in [
        unsafe { libc::pwrite(fd, b"x".as_ptr().cast(), 1, 0) },
        unsafe { libc::ftruncate(fd, 0) } as isize,
        unsafe { libc::ftruncate(fd, 999) } as isize,
        unsafe { libc::fcntl(fd, libc::F_ADD_SEALS, libc::F_SEAL_FUTURE_WRITE) } as isize,
    ] {
        assert_eq!(result, -1);
    }
    // Check errno at each actual operation, not a stale final observation.
    assert_eq!(unsafe { libc::pwrite(fd, b"x".as_ptr().cast(), 1, 0) }, -1);
    assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::EPERM));
    assert_eq!(unsafe { libc::ftruncate(fd, 0) }, -1);
    assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::EPERM));
    assert_eq!(unsafe { libc::ftruncate(fd, 999) }, -1);
    assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::EPERM));
    assert_eq!(
        receive(&control.file, None).unwrap().occurrence_bytes(),
        b"bytes"
    );
}
#[test]
fn actual_existing_writable_mapping_prevents_write_seal_until_unmapped() {
    let file = unsealed(&[0; 4096], true);
    let address = unsafe {
        libc::mmap(
            std::ptr::null_mut(),
            4096,
            libc::PROT_READ | libc::PROT_WRITE,
            libc::MAP_SHARED,
            file.as_raw_fd(),
            0,
        )
    };
    assert_ne!(address, libc::MAP_FAILED);
    assert_eq!(
        unsafe { libc::fcntl(file.as_raw_fd(), libc::F_ADD_SEALS, REQUIRED_SEALS) },
        -1
    );
    assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::EBUSY));
    assert!(receive(&file, None).is_err());
    assert_eq!(unsafe { libc::munmap(address, 4096) }, 0);
    assert_eq!(
        unsafe { libc::fcntl(file.as_raw_fd(), libc::F_ADD_SEALS, REQUIRED_SEALS) },
        0
    );
    assert_eq!(receive(&file, None).unwrap().occurrence_bytes().len(), 4096);
}
#[test]
fn readable_sealed_rdwr_is_immutable_and_writeonly_is_rejected() {
    let control = SealedControl::create(c"readable-control", b"immutable").unwrap();
    assert_eq!(
        unsafe { libc::fcntl(control.file.as_raw_fd(), libc::F_GETFL) } & libc::O_ACCMODE,
        libc::O_RDWR
    );
    assert_eq!(
        receive(&control.file, None).unwrap().occurrence_bytes(),
        b"immutable"
    );
    // Host regression only: production does not depend on proc or reopen.
    let writeonly = OpenOptions::new()
        .write(true)
        .open(format!("/proc/self/fd/{}", control.file.as_raw_fd()))
        .unwrap();
    assert!(receive(&writeonly, None).is_err());
    let readonly = File::open(format!("/proc/self/fd/{}", control.file.as_raw_fd())).unwrap();
    assert_eq!(
        receive(&readonly, None).unwrap().occurrence_bytes(),
        b"immutable"
    );
}
#[test]
fn actual_sealed_descriptor_mode_and_path_only_body_cannot_select_fd_mode() {
    let control = SealedControl::create(c"mode-control", b"exact immutable bytes").unwrap();
    assert_eq!(unsafe { libc::fchmod(control.file.as_raw_fd(), 0o644) }, 0);
    assert!(receive(&control.file, None).is_err());
    assert_eq!(unsafe { libc::fchmod(control.file.as_raw_fd(), 0o600) }, 0);
    assert_eq!(
        receive(&control.file, None).unwrap().occurrence_bytes(),
        b"exact immutable bytes"
    );
    // Host-only negative: production never uses proc or an O_PATH reopen.
    let path_only = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_PATH)
        .open(format!("/proc/self/fd/{}", control.file.as_raw_fd()))
        .unwrap();
    assert!(receive(&path_only, None).is_err());
}
#[test]
fn real_pipe_socket_unsealed_regular_and_directory_are_rejected() {
    let (socket, _) = std::os::unix::net::UnixStream::pair().unwrap();
    let socket = File::from(std::os::fd::OwnedFd::from(socket));
    assert!(receive(&socket, None).is_err());
    let mut pipe = [-1; 2];
    assert_eq!(
        unsafe { libc::pipe2(pipe.as_mut_ptr(), libc::O_CLOEXEC) },
        0
    );
    let read = unsafe { File::from_raw_fd(pipe[0]) };
    let _write = unsafe { File::from_raw_fd(pipe[1]) };
    assert!(receive(&read, None).is_err());
    let fixture = Fixture::new();
    let raw = fixture.body("regular", b"data");
    assert!(receive(&File::open(raw).unwrap(), None).is_err());
    assert!(receive(&File::open(&fixture.0).unwrap(), None).is_err());
}
#[test]
fn descriptor_selector_stdio_sign_whitespace_zero_prefix_and_overflow_rejected() {
    for value in [
        "",
        "0",
        "1",
        "2",
        "-3",
        "+3",
        " 3",
        "3 ",
        "03",
        "2147483648",
        "999999999999999999",
    ] {
        assert!(
            parse_selector(OsStr::new(value)).is_err(),
            "selector={value}"
        );
    }
    assert_eq!(parse_selector(OsStr::new("3")).unwrap(), 3);
    for fd in 0..3 {
        assert!(
            unsafe { libc::fcntl(fd, libc::F_GETFD) } >= 0,
            "stdio untouched"
        );
    }
}
#[test]
fn semantic_only_malformed_and_aliased_selectors_dispose_distinct_transfers() {
    let control = SealedControl::create(c"selector-control", b"data").unwrap();
    let rejected = |a: &OsStr, first: Option<&OsStr>, second: Option<&OsStr>| {
        let fd = parse_selector(a).unwrap();
        assert!(unsafe { receive_selectors(first, second) }.is_err());
        assert!(
            !same_fd_identity(fd, &control.file.metadata().unwrap()),
            "rejected transfer no longer retains this actual file (numeric reuse is harmless)"
        );
    };
    let a = transferred(&control.file);
    rejected(&a, None, Some(&a));
    let a = transferred(&control.file);
    rejected(&a, Some(&a), Some(&a));
    let a = transferred(&control.file);
    rejected(&a, Some(&a), Some(OsStr::new("invalid")));
    let a = transferred(&control.file);
    rejected(&a, Some(OsStr::new("invalid")), Some(&a));
    assert!(
        receive(&control.file, Some(&control.file)).is_err(),
        "same inode with distinct descriptors"
    );
}
#[test]
fn positional_reads_preserve_actual_shared_description_offset() {
    let control = SealedControl::create(c"offset-control", b"offset data").unwrap();
    let before = unsafe { libc::lseek(control.file.as_raw_fd(), 0, libc::SEEK_CUR) };
    assert_eq!(before, 11);
    let received = receive(&control.file, None).unwrap();
    assert_eq!(received.occurrence_bytes(), b"offset data");
    assert_eq!(
        unsafe { libc::lseek(control.file.as_raw_fd(), 0, libc::SEEK_CUR) },
        before
    );
}
#[test]
fn received_ownership_recloexec_before_helper_exec_and_keeps_exact_body() {
    let fixture = Fixture::new();
    let path = fixture.body("a", b"first");
    let controls = OwnedSealedControls::from_private_files(&path, None).unwrap();
    let mut command = child_command("leak");
    let _retention = controls.configure_child(&mut command).unwrap();
    assert!(command.status().unwrap().success());
}
#[test]
fn actual_command_owned_copy_survives_original_retention_drop() {
    let fixture = Fixture::new();
    let path = fixture.body("a", b"first");
    let controls = OwnedSealedControls::from_private_files(&path, None).unwrap();
    let mut command = child_command("read");
    let retention = controls.configure_child(&mut command).unwrap();
    drop(retention);
    assert!(command.status().unwrap().success());
}
#[test]
fn actual_child_failure_wait_preserves_parent_controls_for_result_processing() {
    let fixture = Fixture::new();
    let path = fixture.body("a", b"first");
    let controls = OwnedSealedControls::from_private_files(&path, None).unwrap();
    let mut command = child_command("fail");
    let retention = controls.configure_child(&mut command).unwrap();
    assert!(!command.status().unwrap().success());
    assert_eq!(
        receive(&retention._controls.occurrence.file, None)
            .unwrap()
            .occurrence_bytes(),
        b"first"
    );
}
#[test]
fn spawn_failure_and_partial_pair_failure_keep_no_stale_delivery() {
    let fixture = Fixture::new();
    let path = fixture.body("a", b"first");
    let missing = fixture.0.join("missing");
    assert!(OwnedSealedControls::from_private_files(&path, Some(&missing)).is_err());
    let controls = OwnedSealedControls::from_private_files(&path, None).unwrap();
    let mut command = Command::new(&missing);
    let retention = controls.configure_child(&mut command).unwrap();
    assert!(command.spawn().is_err());
    assert_eq!(
        receive(&retention._controls.occurrence.file, None)
            .unwrap()
            .occurrence_bytes(),
        b"first"
    );
    drop(command);
    drop(retention);
    let controls = OwnedSealedControls::from_private_files(&path, None).unwrap();
    let mut retry = child_command("read");
    let _retention = controls.configure_child(&mut retry).unwrap();
    assert!(retry.status().unwrap().success());
}
#[test]
fn concurrent_actual_children_keep_distinct_immutable_descriptor_bodies() {
    let first = Fixture::new();
    let second = Fixture::new();
    let a = first.body("a", b"first");
    let b = second.body("b", b"second");
    let mut one = child_command("read");
    let mut two = child_command("read");
    two.env("BUILD_GRAPH_CONTROL_EXPECT", "second");
    let _one = OwnedSealedControls::from_private_files(&a, None)
        .unwrap()
        .configure_child(&mut one)
        .unwrap();
    let _two = OwnedSealedControls::from_private_files(&b, None)
        .unwrap()
        .configure_child(&mut two)
        .unwrap();
    let mut child_one = one.spawn().unwrap();
    let mut child_two = two.spawn().unwrap();
    assert!(child_one.wait().unwrap().success());
    assert!(child_two.wait().unwrap().success());
}
#[test]
fn frozen_descriptor_keeps_exact_original_bytes_after_path_replacement() {
    let fixture = Fixture::new();
    let path = fixture.body("a", b"first");
    let controls = OwnedSealedControls::from_private_files(&path, None).unwrap();
    fs::remove_file(&path).unwrap();
    fixture.body("a", b"foreign");
    assert_eq!(
        receive(&controls.occurrence.file, None)
            .unwrap()
            .occurrence_bytes(),
        b"first"
    );
    assert_eq!(fs::read(path).unwrap(), b"foreign");
}

// This helper executes only through the actual parent controls above. It is not
// an independently passing positive and does not issue an owner capability.
#[test]
#[ignore = "owned child relay used by actual parent lifecycle controls"]
fn transfer_child() {
    let mode =
        std::env::var("BUILD_GRAPH_CONTROL_FIXTURE_MODE").expect("parent child mode required");
    if mode == "probe" {
        let fd: RawFd = std::env::var("BUILD_GRAPH_CONTROL_PROBE_FD")
            .unwrap()
            .parse()
            .unwrap();
        let dev: u64 = std::env::var("BUILD_GRAPH_CONTROL_PROBE_DEV")
            .unwrap()
            .parse()
            .unwrap();
        let ino: u64 = std::env::var("BUILD_GRAPH_CONTROL_PROBE_INO")
            .unwrap()
            .parse()
            .unwrap();
        let copy = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 3) };
        if copy >= 0 {
            let file = unsafe { File::from_raw_fd(copy) };
            let info = file.metadata().unwrap();
            assert!(
                info.dev() != dev || info.ino() != ino,
                "original control did not cross helper exec"
            );
        }
        return;
    }
    // SAFETY: this subprocess received each owned copy from configure_child;
    // no Rust owner aliases the transferred exec-time descriptors.
    let controls = unsafe { adopt_inherited_controls() };
    let InheritedControls::Sealed(value) = controls else {
        panic!("real sealed delivery required")
    };
    let expected = std::env::var("BUILD_GRAPH_CONTROL_EXPECT").unwrap_or_else(|_| "first".into());
    assert_eq!(value.occurrence_bytes(), expected.as_bytes());
    let fd = value._occurrence_file.as_raw_fd();
    assert_ne!(
        unsafe { libc::fcntl(fd, libc::F_GETFD) } & libc::FD_CLOEXEC,
        0
    );
    if mode == "leak" {
        let info = value._occurrence_file.metadata().unwrap();
        let mut probe = child_command("probe");
        probe
            .env("BUILD_GRAPH_CONTROL_PROBE_FD", fd.to_string())
            .env("BUILD_GRAPH_CONTROL_PROBE_DEV", info.dev().to_string())
            .env("BUILD_GRAPH_CONTROL_PROBE_INO", info.ino().to_string());
        assert!(probe.status().unwrap().success());
    }
    if mode == "fail" {
        panic!("intentional child failure after actual immutable read")
    }
    assert!(same_fd_identity(
        fd,
        &value._occurrence_file.metadata().unwrap()
    ));
}
