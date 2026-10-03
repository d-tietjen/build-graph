//! Optional Linux transport for bounded, immutable callback request bytes.
//! Descriptor numbers and sealed bytes provide no execution or custody authority.

use std::ffi::{CStr, OsStr};
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, Write};
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{FileExt, MetadataExt, OpenOptionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

pub const MAX_CONTROL_BYTES: usize = 32 * 1024;
pub const OCCURRENCE_FD_ENV: &str = "BG_DRIVER_OCCURRENCE_REQUEST_FD";
pub const SEMANTIC_FD_ENV: &str = "BG_DRIVER_SEMANTIC_REQUEST_FD";
const REQUIRED_SEALS: i32 =
    libc::F_SEAL_WRITE | libc::F_SEAL_GROW | libc::F_SEAL_SHRINK | libc::F_SEAL_SEAL;
const MAX_PATH_BYTES: usize = 4096;

#[derive(Debug)]
struct ByteLimit;
impl std::fmt::Display for ByteLimit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("callback control byte limit")
    }
}
impl std::error::Error for ByteLimit {}

/// A bounded category; callers need not log descriptor values or request bytes.
pub fn is_byte_limit(error: &io::Error) -> bool {
    error.get_ref().is_some_and(|v| v.is::<ByteLimit>())
}

fn byte_limit() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, ByteLimit)
}
fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "callback control unavailable")
}
fn pair_bytes(first: u64, second: Option<u64>) -> io::Result<usize> {
    if first == 0 || second == Some(0) {
        return Err(invalid());
    }
    let total = first
        .checked_add(second.unwrap_or(0))
        .ok_or_else(byte_limit)?;
    if total > MAX_CONTROL_BYTES as u64 {
        return Err(byte_limit());
    }
    Ok(total as usize)
}
fn same(a: &Metadata, b: &Metadata) -> bool {
    a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.mode() == b.mode()
        && a.uid() == b.uid()
        && a.nlink() == b.nlink()
        && a.len() == b.len()
        && a.mtime() == b.mtime()
        && a.mtime_nsec() == b.mtime_nsec()
        && a.ctime() == b.ctime()
        && a.ctime_nsec() == b.ctime_nsec()
}
fn same_inode(a: &Metadata, b: &Metadata) -> bool {
    a.dev() == b.dev() && a.ino() == b.ino()
}
fn uid() -> u32 {
    // SAFETY: geteuid has no arguments or memory effects in this process.
    unsafe { libc::geteuid() }
}

struct PrivateSource {
    file: File,
    parent: File,
    path: PathBuf,
    parent_path: PathBuf,
    before: Metadata,
    parent_before: Metadata,
}
impl PrivateSource {
    fn open(path: &Path) -> io::Result<Self> {
        if !path.is_absolute()
            || path.as_os_str().as_bytes().len() > MAX_PATH_BYTES
            || path.components().any(|v| matches!(v, Component::ParentDir))
        {
            return Err(invalid());
        }
        let parent_path = path.parent().ok_or_else(invalid)?;
        let name = std::ffi::CString::new(path.file_name().ok_or_else(invalid)?.as_bytes())
            .map_err(|_| invalid())?;
        let parent_before = fs::symlink_metadata(parent_path)?;
        if !parent_before.is_dir()
            || parent_before.mode() & 0o777 != 0o700
            || parent_before.uid() != uid()
            || fs::canonicalize(parent_path)? != parent_path
        {
            return Err(invalid());
        }
        let parent = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(parent_path)?;
        if !same_inode(&parent_before, &parent.metadata()?) {
            return Err(invalid());
        }
        let before = fs::symlink_metadata(path)?;
        if !before.is_file()
            || before.mode() & 0o777 != 0o600
            || before.uid() != uid()
            || before.nlink() != 1
        {
            return Err(invalid());
        }
        // SAFETY: the retained directory and terminated leaf name are live.
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: openat returned this new, exclusively owned descriptor.
        let file = unsafe { File::from_raw_fd(fd) };
        let source = Self {
            file,
            parent,
            path: path.to_owned(),
            parent_path: parent_path.to_owned(),
            before,
            parent_before,
        };
        source.check()?;
        Ok(source)
    }
    fn check(&self) -> io::Result<()> {
        let parent = fs::symlink_metadata(&self.parent_path)?;
        if !same_inode(&self.parent_before, &parent)
            || !same_inode(&self.parent_before, &self.parent.metadata()?)
            || !parent.is_dir()
            || parent.mode() & 0o777 != 0o700
            || parent.uid() != uid()
            || !same(&self.before, &self.file.metadata()?)
            || !same(&self.before, &fs::symlink_metadata(&self.path)?)
        {
            return Err(invalid());
        }
        Ok(())
    }
    fn read(&self, capacity: &mut usize) -> io::Result<Vec<u8>> {
        self.check()?;
        let raw = read_body(&self.file, self.before.len() as usize, capacity)?;
        self.check()?;
        Ok(raw)
    }
}

fn read_body(file: &File, length: usize, capacity: &mut usize) -> io::Result<Vec<u8>> {
    if length == 0 || length > *capacity {
        return Err(byte_limit());
    }
    let mut raw = Vec::new();
    raw.try_reserve_exact(length).map_err(io::Error::other)?;
    if raw.capacity() > *capacity {
        return Err(byte_limit());
    }
    *capacity -= raw.capacity();
    raw.resize(length, 0);
    let mut offset = 0;
    while offset < length {
        let count = match file.read_at(&mut raw[offset..], offset as u64) {
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            result => result?,
        };
        if count == 0 {
            return Err(io::Error::from(io::ErrorKind::UnexpectedEof));
        }
        offset += count;
    }
    let mut extra = [0];
    let extra_count = loop {
        match file.read_at(&mut extra, length as u64) {
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            result => break result?,
        }
    };
    if extra_count != 0 {
        return Err(invalid());
    }
    Ok(raw)
}
fn duplicate(file: &File) -> io::Result<File> {
    // SAFETY: duplication creates a distinct owned descriptor with CLOEXEC.
    let fd = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 3) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fcntl returned this new descriptor, not an aliasing Rust owner.
    Ok(unsafe { File::from_raw_fd(fd) })
}
fn seals(file: &File) -> io::Result<i32> {
    // SAFETY: F_GET_SEALS has no pointer argument.
    let value = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GET_SEALS) };
    if value < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(value)
}
fn descriptor(file: &File) -> io::Result<Metadata> {
    let info = file.metadata()?;
    // SAFETY: F_GETFL has no pointer argument.
    let flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFL) };
    if flags < 0
        || flags & libc::O_PATH != 0
        || !matches!(flags & libc::O_ACCMODE, libc::O_RDONLY | libc::O_RDWR)
        || !info.is_file()
        || info.uid() != uid()
        || info.mode() & 0o777 != 0o600
        || seals(file)? & REQUIRED_SEALS != REQUIRED_SEALS
    {
        return Err(invalid());
    }
    Ok(info)
}
struct SealedControl {
    file: File,
}
impl SealedControl {
    fn create(name: &CStr, raw: &[u8]) -> io::Result<Self> {
        // SAFETY: the fixed name is terminated and creation returns a new FD.
        let fd = unsafe {
            libc::memfd_create(name.as_ptr(), libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING)
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: memfd_create returned this exclusively owned descriptor.
        let mut file = unsafe { File::from_raw_fd(fd) };
        // SAFETY: fchmod changes only the newly created owned file's mode.
        if unsafe { libc::fchmod(fd, 0o600) } != 0 {
            return Err(io::Error::last_os_error());
        }
        if file.metadata()?.len() != 0 || seals(&file)? != 0 {
            return Err(invalid());
        }
        // File::write_all uses successful scalar writes; no writable mmap or
        // resizing operation participates in this delivery.
        file.write_all(raw)?;
        // SAFETY: F_ADD_SEALS accepts this integer mask, not a pointer.
        if unsafe { libc::fcntl(fd, libc::F_ADD_SEALS, REQUIRED_SEALS) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let before = descriptor(&file)?;
        if before.len() != raw.len() as u64 {
            return Err(invalid());
        }
        let mut chunk = [0; 4096];
        let mut offset = 0;
        while offset < raw.len() {
            let length = chunk.len().min(raw.len() - offset);
            let count = match file.read_at(&mut chunk[..length], offset as u64) {
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                result => result?,
            };
            if count == 0 || chunk[..count] != raw[offset..offset + count] {
                return Err(invalid());
            }
            offset += count;
        }
        if !same(&before, &descriptor(&file)?) {
            return Err(invalid());
        }
        Ok(Self { file })
    }
}

/// Two immutable data controls with one shared 32 KiB encoded-byte allowance.
/// This type is not an execution, source qualification or custody capability.
pub struct OwnedSealedControls {
    occurrence: SealedControl,
    semantic: Option<SealedControl>,
}
/// Retains original descriptors while Command independently owns delivery copies.
pub struct ControlRetention {
    _controls: OwnedSealedControls,
}
impl OwnedSealedControls {
    pub fn from_private_files(occurrence: &Path, semantic: Option<&Path>) -> io::Result<Self> {
        let occurrence = PrivateSource::open(occurrence)?;
        let semantic = semantic.map(PrivateSource::open).transpose()?;
        if semantic.as_ref().is_some_and(|source| {
            source.parent_path != occurrence.parent_path
                || same_inode(&source.before, &occurrence.before)
        }) {
            return Err(invalid());
        }
        // Admit BOTH lengths before allocating any body or first memfd.
        pair_bytes(
            occurrence.before.len(),
            semantic.as_ref().map(|s| s.before.len()),
        )?;
        let mut capacity = MAX_CONTROL_BYTES;
        let first = occurrence.read(&mut capacity)?;
        let second = semantic
            .as_ref()
            .map(|s| s.read(&mut capacity))
            .transpose()?;
        let occurrence = SealedControl::create(c"build-graph-occurrence-control-v1", &first)?;
        let semantic = second
            .as_ref()
            .map(|raw| SealedControl::create(c"build-graph-semantic-control-v1", raw))
            .transpose()?;
        Ok(Self {
            occurrence,
            semantic,
        })
    }

    pub fn configure_child(self, command: &mut Command) -> io::Result<ControlRetention> {
        // Construct all owned copies before mutating the Command. Its hook
        // owns these copies even if the caller drops ControlRetention early.
        let occurrence = duplicate(&self.occurrence.file)?;
        let semantic = self
            .semantic
            .as_ref()
            .map(|v| duplicate(&v.file))
            .transpose()?;
        command
            .env(OCCURRENCE_FD_ENV, occurrence.as_raw_fd().to_string())
            .env_remove(SEMANTIC_FD_ENV);
        if let Some(file) = &semantic {
            command.env(SEMANTIC_FD_ENV, file.as_raw_fd().to_string());
        }
        // SAFETY: the child hook only calls async-signal-safe fcntl on fixed
        // OWNED copies. No Arc, allocation, formatting, lock or deserialization
        // occurs after fork. Parent copies retain CLOEXEC.
        unsafe {
            command.pre_exec(move || {
                if libc::fcntl(occurrence.as_raw_fd(), libc::F_SETFD, 0) != 0 {
                    return Err(io::Error::last_os_error());
                }
                if let Some(file) = &semantic {
                    if libc::fcntl(file.as_raw_fd(), libc::F_SETFD, 0) != 0 {
                        return Err(io::Error::last_os_error());
                    }
                }
                Ok(())
            });
        }
        Ok(ControlRetention { _controls: self })
    }
}

#[derive(Debug)]
pub struct ControlReadError {
    kind: io::ErrorKind,
}
impl ControlReadError {
    pub fn kind(&self) -> io::ErrorKind {
        self.kind
    }
}
impl std::fmt::Display for ControlReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("sealed callback control unavailable")
    }
}
impl std::error::Error for ControlReadError {}

pub enum InheritedControls {
    LegacyPath,
    Sealed(ReceivedSealedControls),
    Unavailable(ControlReadError),
}
/// Held bytes and descriptors; only bounded borrowed reads are exposed.
pub struct ReceivedSealedControls {
    occurrence: Vec<u8>,
    semantic: Option<Vec<u8>>,
    _occurrence_file: File,
    _semantic_file: Option<File>,
}
impl ReceivedSealedControls {
    pub fn occurrence_bytes(&self) -> &[u8] {
        &self.occurrence
    }
    pub fn semantic_bytes(&self) -> Option<&[u8]> {
        self.semantic.as_deref()
    }
}

fn parse_selector(value: &OsStr) -> io::Result<RawFd> {
    let raw = value.as_bytes();
    if raw.is_empty()
        || raw.len() > 10
        || raw.len() > 1 && raw[0] == b'0'
        || !raw.iter().all(u8::is_ascii_digit)
    {
        return Err(invalid());
    }
    let mut fd = 0i32;
    for digit in raw {
        fd = fd
            .checked_mul(10)
            .and_then(|v| v.checked_add(i32::from(digit - b'0')))
            .ok_or_else(invalid)?;
    }
    if fd < 3 {
        return Err(invalid());
    }
    Ok(fd)
}
unsafe fn claim_descriptor(fd: RawFd) -> io::Result<File> {
    // SAFETY: caller transferred ownership of this non-stdio descriptor.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    // Take ownership before a failing fcntl, so errors dispose the transfer.
    // SAFETY: this is the unique Rust owner of the transferred descriptor.
    let file = unsafe { File::from_raw_fd(fd) };
    // SAFETY: CLOEXEC restoration precedes all helper/thread creation.
    if unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(file)
}
unsafe fn receive_selectors(
    occurrence: Option<&OsStr>,
    semantic: Option<&OsStr>,
) -> io::Result<ReceivedSealedControls> {
    let first = occurrence.map(parse_selector).transpose();
    let second = semantic.map(parse_selector).transpose();
    // Claim parsed transfers even when another selector is malformed. Aliased
    // numbers are claimed exactly once. Invalid stdio values are never claimed.
    // SAFETY: the caller transfers each distinct parsed FD's ownership once.
    let first_file = match &first {
        Ok(Some(fd)) => unsafe { claim_descriptor(*fd) }.map(Some),
        _ => Ok(None),
    };
    let second_file = match &second {
        Ok(Some(fd)) if first.as_ref().ok().copied().flatten() != Some(*fd) => {
            unsafe { claim_descriptor(*fd) }.map(Some)
        }
        _ => Ok(None),
    };
    let first = first?;
    let second = second?;
    if first.is_none() || first == second {
        return Err(invalid());
    }
    let occurrence = first_file?.ok_or_else(invalid)?;
    let second_file = second_file?;
    let before = descriptor(&occurrence)?;
    let semantic_before = second_file.as_ref().map(descriptor).transpose()?;
    if semantic_before
        .as_ref()
        .is_some_and(|v| same_inode(&before, v))
    {
        return Err(invalid());
    }
    pair_bytes(before.len(), semantic_before.as_ref().map(Metadata::len))?;
    let mut capacity = MAX_CONTROL_BYTES;
    let first_raw = read_body(&occurrence, before.len() as usize, &mut capacity)?;
    let second_raw = second_file
        .as_ref()
        .zip(semantic_before.as_ref())
        .map(|(file, info)| read_body(file, info.len() as usize, &mut capacity))
        .transpose()?;
    if !same(&before, &descriptor(&occurrence)?) {
        return Err(invalid());
    }
    if let Some((file, info)) = second_file.as_ref().zip(semantic_before.as_ref()) {
        if !same(info, &descriptor(file)?) {
            return Err(invalid());
        }
    }
    Ok(ReceivedSealedControls {
        occurrence: first_raw,
        semantic: second_raw,
        _occurrence_file: occurrence,
        _semantic_file: second_file,
    })
}

/// Adopt the optional data descriptors before any compiler, threads or helpers.
/// An explicit invalid FD mode NEVER falls back to ordinary pathname reads.
///
/// # Safety
/// Call once at process entry. Each distinct non-stdio descriptor named by these
/// variables transfers ownership to this function, with no other Rust owner in
/// this process. This is the child side of `configure_child`, not a general way
/// to adopt a borrowed caller descriptor. Descriptor numbers grant no authority.
pub unsafe fn adopt_inherited_controls() -> InheritedControls {
    let first = std::env::var_os(OCCURRENCE_FD_ENV);
    let second = std::env::var_os(SEMANTIC_FD_ENV);
    if first.is_none() && second.is_none() {
        return InheritedControls::LegacyPath;
    }
    // SAFETY: forwarded one-time process-entry ownership contract above.
    match unsafe { receive_selectors(first.as_deref(), second.as_deref()) } {
        Ok(value) => InheritedControls::Sealed(value),
        Err(error) => InheritedControls::Unavailable(ControlReadError { kind: error.kind() }),
    }
}

#[cfg(test)]
#[path = "held_callback_control_tests.rs"]
mod tests;
