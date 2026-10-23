//! Connected Linux transport and sealed intent carrier. These are observations,
//! not original-parent identity, executable qualification or custody proofs.

use super::*;
use std::collections::BTreeSet;
use std::fs::File;
use std::io::{self, Seek, SeekFrom, Write};
use std::mem;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStringExt;
use std::os::unix::net::UnixStream;
use std::process::{Child, ExitStatus};
use std::sync::Arc;
use std::time::{Duration, Instant};

const MAX_FRAMES: usize = MAX_OPERATIONS as usize * 8;
const TOTAL_IO_TIME: Duration = Duration::from_secs(5);
const SEALS: i32 = libc::F_SEAL_SEAL | libc::F_SEAL_SHRINK | libc::F_SEAL_GROW | libc::F_SEAL_WRITE;

pub struct Frame {
    pub bytes: Vec<u8>,
    pub descriptor: Option<OwnedFd>,
}

/// One exclusive connected stream. Each frame starts with one sendmsg byte:
/// tag 0 has no ancillary FD; tag 1 carries exactly one FD on that byte. Then
/// four big-endian length bytes and exactly that many JSON bytes follow.
/// recvmsg reads the tag separately and rejects descriptors anywhere else.
pub struct Channel {
    stream: UnixStream,
    bytes: usize,
    frames: usize,
    remaining: Duration,
    failed: bool,
}

impl Channel {
    pub fn new(stream: UnixStream) -> Result<Self> {
        for (option, expected) in [
            (libc::SO_TYPE, libc::SOCK_STREAM),
            (libc::SO_DOMAIN, libc::AF_UNIX),
        ] {
            let mut value = 0i32;
            let mut length = mem::size_of_val(&value) as libc::socklen_t;
            if unsafe {
                libc::getsockopt(
                    stream.as_raw_fd(),
                    libc::SOL_SOCKET,
                    option,
                    (&mut value as *mut i32).cast(),
                    &mut length,
                )
            } != 0
                || length as usize != mem::size_of_val(&value)
                || value != expected
            {
                bail!("launch transport must be a connected Unix stream");
            }
        }
        stream.peer_addr()?;
        stream.set_nonblocking(false)?;
        // Duplication is atomically CLOEXEC in the pinned std implementation.
        // Only this private duplicate remains after the supplied stream closes.
        let owned: OwnedFd = stream.into();
        let private = owned.try_clone()?;
        drop(owned);
        Ok(Self {
            stream: private.into(),
            bytes: 0,
            frames: 0,
            remaining: TOTAL_IO_TIME,
            failed: false,
        })
    }

    fn charge(&mut self, bytes: usize, frame: bool) -> Result<()> {
        if bytes > MAX_SESSION_BYTES.saturating_sub(self.bytes)
            || frame && self.frames >= MAX_FRAMES
        {
            bail!("launch transport aggregate bound exhausted");
        }
        self.bytes += bytes;
        self.frames += usize::from(frame);
        Ok(())
    }

    fn start(&self) -> Result<Instant> {
        if self.failed || self.remaining.is_zero() {
            bail!("launch transport is unavailable");
        }
        Instant::now()
            .checked_add(self.remaining)
            .ok_or_else(|| anyhow::anyhow!("launch transport deadline overflow"))
    }

    fn finish<T>(&mut self, started: Instant, result: Result<T>) -> Result<T> {
        self.remaining = self.remaining.saturating_sub(started.elapsed());
        if result.is_err() {
            self.failed = true;
        }
        result
    }

    fn timeout(&self, deadline: Instant) -> Result<()> {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|value| !value.is_zero())
            .ok_or_else(|| anyhow::anyhow!("launch transport deadline exhausted"))?;
        self.stream.set_read_timeout(Some(remaining))?;
        self.stream.set_write_timeout(Some(remaining))?;
        Ok(())
    }

    pub fn send(&mut self, bytes: &[u8], descriptor: Option<&File>) -> Result<()> {
        let started = Instant::now();
        let result = self.send_inner(bytes, descriptor);
        self.finish(started, result)
    }

    fn send_inner(&mut self, bytes: &[u8], descriptor: Option<&File>) -> Result<()> {
        let deadline = self.start()?;
        if bytes.is_empty() || bytes.len() > MAX_EVENT_BYTES {
            bail!("launch frame size exceeds bound");
        }
        self.charge(bytes.len() + 5, true)?;
        self.timeout(deadline)?;
        let mut tag = u8::from(descriptor.is_some());
        let mut vector = libc::iovec {
            iov_base: (&mut tag as *mut u8).cast(),
            iov_len: 1,
        };
        let mut control = [0usize; 16];
        let mut message: libc::msghdr = unsafe { mem::zeroed() };
        message.msg_iov = &mut vector;
        message.msg_iovlen = 1;
        if let Some(descriptor) = descriptor {
            message.msg_control = control.as_mut_ptr().cast();
            message.msg_controllen = unsafe { libc::CMSG_SPACE(mem::size_of::<i32>() as u32) } as _;
            unsafe {
                let header = libc::CMSG_FIRSTHDR(&message);
                (*header).cmsg_level = libc::SOL_SOCKET;
                (*header).cmsg_type = libc::SCM_RIGHTS;
                (*header).cmsg_len = libc::CMSG_LEN(mem::size_of::<i32>() as u32) as _;
                std::ptr::write_unaligned(
                    libc::CMSG_DATA(header).cast::<i32>(),
                    descriptor.as_raw_fd(),
                );
            }
        }
        loop {
            self.timeout(deadline)?;
            let result =
                unsafe { libc::sendmsg(self.stream.as_raw_fd(), &message, libc::MSG_NOSIGNAL) };
            if result == 1 {
                break;
            }
            if result < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                continue;
            }
            if result == 0 {
                bail!("launch transport closed while writing tag");
            }
            return Err(io::Error::last_os_error().into());
        }
        let length = (bytes.len() as u32).to_be_bytes();
        for part in [&length[..], bytes] {
            let mut offset = 0;
            while offset < part.len() {
                self.timeout(deadline)?;
                let result = unsafe {
                    libc::send(
                        self.stream.as_raw_fd(),
                        part[offset..].as_ptr().cast(),
                        part.len() - offset,
                        libc::MSG_NOSIGNAL,
                    )
                };
                if result < 0 {
                    let error = io::Error::last_os_error();
                    if error.kind() == io::ErrorKind::Interrupted {
                        continue;
                    }
                    return Err(error.into());
                }
                if result == 0 {
                    bail!("launch transport closed while writing");
                }
                offset += result as usize;
            }
        }
        Ok(())
    }

    pub fn receive(&mut self) -> Result<Frame> {
        let started = Instant::now();
        let result = self.receive_inner();
        self.finish(started, result)
    }

    fn receive_inner(&mut self) -> Result<Frame> {
        let deadline = self.start()?;
        self.charge(5, true)?;
        let mut tag = [0u8];
        let descriptors = self.read_part(&mut tag, true, deadline)?;
        if tag[0] > 1 || descriptors.len() != usize::from(tag[0]) {
            bail!("launch frame ancillary boundary is invalid");
        }
        let descriptor = descriptors.into_iter().next();
        let mut length = [0u8; 4];
        self.read_part(&mut length, false, deadline)?;
        let length = u32::from_be_bytes(length) as usize;
        if length == 0 || length > MAX_EVENT_BYTES {
            bail!("launch frame size exceeds bound");
        }
        self.charge(length, false)?;
        let mut bytes = vec![0; length];
        self.read_part(&mut bytes, false, deadline)?;
        Ok(Frame { bytes, descriptor })
    }

    fn read_part(
        &self,
        bytes: &mut [u8],
        allow_descriptor: bool,
        deadline: Instant,
    ) -> Result<Vec<OwnedFd>> {
        let mut offset = 0;
        let mut retained = Vec::with_capacity(32);
        while offset < bytes.len() {
            self.timeout(deadline)?;
            let mut vector = libc::iovec {
                iov_base: bytes[offset..].as_mut_ptr().cast(),
                iov_len: bytes.len() - offset,
            };
            let mut control = [0usize; 16];
            let mut message: libc::msghdr = unsafe { mem::zeroed() };
            message.msg_iov = &mut vector;
            message.msg_iovlen = 1;
            message.msg_control = control.as_mut_ptr().cast();
            message.msg_controllen = mem::size_of_val(&control) as _;
            let result = unsafe {
                libc::recvmsg(
                    self.stream.as_raw_fd(),
                    &mut message,
                    libc::MSG_CMSG_CLOEXEC,
                )
            };
            if result < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error.into());
            }
            if result == 0 {
                bail!("launch transport closed while reading");
            }
            let mut unsupported = false;
            unsafe {
                let mut header = libc::CMSG_FIRSTHDR(&message);
                while !header.is_null() {
                    if (*header).cmsg_level == libc::SOL_SOCKET
                        && (*header).cmsg_type == libc::SCM_RIGHTS
                    {
                        let base = libc::CMSG_LEN(0) as usize;
                        let payload = ((*header).cmsg_len as usize).saturating_sub(base);
                        if payload % mem::size_of::<i32>() != 0 {
                            unsupported = true;
                        }
                        for index in 0..payload / mem::size_of::<i32>() {
                            let raw = std::ptr::read_unaligned(
                                libc::CMSG_DATA(header).cast::<i32>().add(index),
                            );
                            // Kernel-delivered rights are immediately owned even
                            // when the surrounding frame will be rejected.
                            retained.push(OwnedFd::from_raw_fd(raw));
                        }
                    } else {
                        unsupported = true;
                    }
                    header = libc::CMSG_NXTHDR(&message, header);
                }
            }
            if unsupported
                || message.msg_flags & (libc::MSG_TRUNC | libc::MSG_CTRUNC) != 0
                || !allow_descriptor && !retained.is_empty()
            {
                bail!("launch transport received unsupported ancillary data");
            }
            offset += result as usize;
        }
        Ok(retained)
    }
}

pub struct RoutedIntent {
    final_intent: FinalIntent,
    session: Arc<()>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Routed,
    Prepared,
    Spawned,
}

struct Pending {
    binding: Binding,
    final_sha256: String,
    phase: Phase,
}

/// Owns the sealed carrier and the frozen Command. No mutable Command escapes
/// between final-intent acknowledgement and the actual spawn.
pub struct PreparedLaunch {
    command: Option<Command>,
    carrier: File,
    binding: Binding,
    final_sha256: String,
    session: Arc<()>,
}

impl PreparedLaunch {
    pub fn spawn(mut self) -> std::result::Result<(Child, Self), (io::Error, Self)> {
        let Some(mut command) = self.command.take() else {
            return Err((
                io::Error::new(io::ErrorKind::InvalidInput, "launch already attempted"),
                self,
            ));
        };
        match command.spawn() {
            Ok(child) => Ok((child, self)),
            Err(error) => Err((error, self)),
        }
    }
    pub fn binding(&self) -> &Binding {
        &self.binding
    }
}

pub struct Observer {
    channel: Channel,
    root: String,
    nonces: BTreeSet<String>,
    operation: u64,
    pending: Option<Pending>,
    session: Arc<()>,
    failed: bool,
}

impl Observer {
    pub fn new(channel: Channel, root: String) -> Result<Self> {
        Binding {
            session: "pending".into(),
            operation: 1,
            request: "pending".into(),
            root: root.clone(),
            kind: "pending".into(),
        }
        .validate()?;
        Ok(Self {
            channel,
            root,
            nonces: BTreeSet::new(),
            operation: 0,
            pending: None,
            session: Arc::new(()),
            failed: false,
        })
    }

    pub fn root(&self) -> &str {
        &self.root
    }

    pub fn route(
        &mut self,
        command: &mut Command,
        binding: Binding,
        inherit_environment: bool,
    ) -> Result<RoutedIntent> {
        let result = self.route_inner(command, binding.clone(), inherit_environment);
        if result.is_err() {
            self.failed = true;
            let _ = self.notify(&Event::Unavailable { binding });
        }
        result
    }

    fn route_inner(
        &mut self,
        command: &mut Command,
        binding: Binding,
        inherit_environment: bool,
    ) -> Result<RoutedIntent> {
        if self.failed
            || self.pending.is_some()
            || binding.root != self.root
            || binding.operation != self.operation + 1
        {
            bail!("launch observer correlation is unavailable");
        }
        freeze_environment(command, inherit_environment)?;
        let intent = command_intent(command, binding.clone())?;
        let request_sha256 = sha256(&encoded(&intent)?);
        self.channel.send(
            &event_bytes(&Event::Route {
                intent,
                request_sha256: request_sha256.clone(),
            })?,
            None,
        )?;
        let frame = self.channel.receive()?;
        if frame.descriptor.is_some() {
            bail!("launch route response cannot deliver descriptors");
        }
        let response_sha256 = sha256(&frame.bytes);
        let Response::Route {
            binding: echoed,
            request_sha256: request,
            route_nonce,
            environment,
        } = read_response(&frame.bytes)?
        else {
            bail!("launch route was not accepted");
        };
        if echoed != binding
            || request != request_sha256
            || route_nonce.len() != 64
            || !route_nonce
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            || self.nonces.contains(&route_nonce)
        {
            bail!("launch route response is stale or inconsistent");
        }
        if environment.len() > MAX_OVERLAY_ENTRIES {
            bail!("launch overlay count exceeds bound");
        }
        let mut names = BTreeSet::new();
        let mut bytes = 0usize;
        for change in &environment {
            bytes = bytes
                .checked_add(change.name.len())
                .and_then(|size| size.checked_add(change.value.as_ref().map_or(0, Vec::len)))
                .ok_or_else(|| anyhow::anyhow!("launch overlay size overflow"))?;
            if change.name.is_empty()
                || change.name.contains(&0)
                || change.name.contains(&b'=')
                || change
                    .value
                    .as_ref()
                    .is_some_and(|value| value.contains(&0))
                || !names.insert(&change.name)
                || bytes > MAX_OVERLAY_BYTES
            {
                bail!("launch overlay is invalid or exceeds bound");
            }
        }
        for change in environment {
            let name = OsString::from_vec(change.name);
            if let Some(value) = change.value {
                command.env(name, OsString::from_vec(value));
            } else {
                command.env_remove(name);
            }
        }
        freeze_environment(command, false)?;
        let intent = command_intent(command, binding)?;
        self.nonces.insert(route_nonce.clone());
        self.operation += 1;
        let final_intent = FinalIntent {
            intent,
            route_nonce,
            route_response_sha256: response_sha256,
        };
        self.pending = Some(Pending {
            binding: final_intent.intent.binding.clone(),
            final_sha256: sha256(&encoded(&final_intent)?),
            phase: Phase::Routed,
        });
        Ok(RoutedIntent {
            final_intent,
            session: Arc::clone(&self.session),
        })
    }

    pub fn prepare(&mut self, command: Command, routed: RoutedIntent) -> Result<PreparedLaunch> {
        let result = self.prepare_inner(command, routed);
        if result.is_err() {
            self.failed = true;
        }
        result
    }

    fn prepare_inner(
        &mut self,
        mut command: Command,
        routed: RoutedIntent,
    ) -> Result<PreparedLaunch> {
        // Reapply the selected argv[0] and exact explicit environment on the
        // owned command. A hidden arg0 override or a replacement Command's
        // default inheritance must not diverge from the carrier we acknowledge.
        freeze_environment(&mut command, false)?;
        if self.failed
            || !Arc::ptr_eq(&self.session, &routed.session)
            || !self.pending.as_ref().is_some_and(|pending| {
                pending.phase == Phase::Routed
                    && pending.binding == routed.final_intent.intent.binding
                    && encoded(&routed.final_intent)
                        .is_ok_and(|bytes| pending.final_sha256 == sha256(&bytes))
            })
            || command_intent(&command, routed.final_intent.intent.binding.clone())?
                != routed.final_intent.intent
        {
            bail!("launch command changed after routing");
        }
        let body = encoded(&routed.final_intent)?;
        let raw = unsafe {
            libc::memfd_create(
                c"build-graph-launch-intent-v1".as_ptr(),
                libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING,
            )
        };
        if raw < 0 {
            return Err(io::Error::last_os_error().into());
        }
        let mut carrier = unsafe { File::from_raw_fd(raw) };
        carrier.write_all(&body)?;
        carrier.seek(SeekFrom::Start(0))?;
        if unsafe { libc::fcntl(carrier.as_raw_fd(), libc::F_ADD_SEALS, SEALS) } != 0
            || unsafe { libc::fcntl(carrier.as_raw_fd(), libc::F_GET_SEALS) } != SEALS
        {
            bail!("launch intent carrier sealing failed");
        }
        let binding = routed.final_intent.intent.binding.clone();
        let event = Event::Intent {
            binding: binding.clone(),
            route_nonce: routed.final_intent.route_nonce,
            route_response_sha256: routed.final_intent.route_response_sha256,
            carrier_bytes: body.len() as u32,
            carrier_sha256: sha256(&body),
        };
        self.exchange(&event, Some(&carrier))?;
        let final_sha256 = sha256(&body);
        if let Some(pending) = &mut self.pending {
            pending.phase = Phase::Prepared;
        }
        Ok(PreparedLaunch {
            command: Some(command),
            carrier,
            binding,
            final_sha256,
            session: Arc::clone(&self.session),
        })
    }

    fn exchange(&mut self, event: &Event, carrier: Option<&File>) -> Result<()> {
        let bytes = event_bytes(event)?;
        self.channel.send(&bytes, carrier)?;
        let frame = self.channel.receive()?;
        if frame.descriptor.is_some() {
            bail!("launch acknowledgement cannot deliver descriptors");
        }
        let Response::Acknowledged {
            binding,
            event_sha256,
        } = read_response(&frame.bytes)?
        else {
            bail!("launch event was not acknowledged");
        };
        let expected = match event {
            Event::Intent { binding, .. }
            | Event::Spawned { binding, .. }
            | Event::SpawnFailed { binding }
            | Event::Completed { binding, .. }
            | Event::Cancelled { binding, .. }
            | Event::Unavailable { binding } => binding,
            Event::Route { intent, .. } => &intent.binding,
        };
        if binding != *expected || event_sha256 != sha256(&bytes) {
            bail!("launch acknowledgement is stale or inconsistent");
        }
        Ok(())
    }

    fn notify(&mut self, event: &Event) -> Result<()> {
        let result = self.exchange(event, None);
        if result.is_err() {
            self.failed = true;
        }
        result
    }

    fn owns(&mut self, launch: &PreparedLaunch, phase: Phase) -> Result<()> {
        if !Arc::ptr_eq(&self.session, &launch.session)
            || !self.pending.as_ref().is_some_and(|pending| {
                pending.binding == launch.binding
                    && pending.final_sha256 == launch.final_sha256
                    && pending.phase == phase
            })
        {
            self.failed = true;
            bail!("launch lifecycle correlation is inconsistent");
        }
        Ok(())
    }

    pub fn spawned(&mut self, launch: &PreparedLaunch, pid: u32) -> Result<()> {
        self.owns(launch, Phase::Prepared)?;
        if launch.command.is_some() || pid == 0 {
            self.failed = true;
            bail!("launch was not attempted");
        }
        if let Some(pending) = &mut self.pending {
            pending.phase = Phase::Spawned;
        }
        self.notify(&Event::Spawned {
            binding: launch.binding.clone(),
            pid,
        })
    }

    pub fn spawn_failed(&mut self, launch: PreparedLaunch) -> Result<()> {
        self.owns(&launch, Phase::Prepared)?;
        self.pending = None;
        let result = self.notify(&Event::SpawnFailed {
            binding: launch.binding.clone(),
        });
        drop(launch.carrier);
        result
    }

    pub fn complete(&mut self, launch: PreparedLaunch, status: ExitStatus) -> Result<()> {
        use std::os::unix::process::ExitStatusExt;
        self.owns(&launch, Phase::Spawned)?;
        let result = self.notify(&Event::Completed {
            binding: launch.binding.clone(),
            exit_code: status.code(),
            signal: status.signal(),
        });
        // The exact carrier stays owned until the same child's actual wait and
        // final ACK/error disposal. No ACK claims descendant extinction.
        drop(launch.carrier);
        self.pending = None;
        result
    }

    pub fn cancel(
        &mut self,
        launch: PreparedLaunch,
        pid: u32,
        status: Option<ExitStatus>,
    ) -> Result<()> {
        use std::os::unix::process::ExitStatusExt;
        self.owns(&launch, Phase::Spawned)?;
        let result = self.notify(&Event::Cancelled {
            binding: launch.binding.clone(),
            pid: Some(pid),
            exit_code: status.and_then(|value| value.code()),
            signal: status.and_then(|value| value.signal()),
        });
        drop(launch.carrier);
        self.pending = None;
        self.failed = true;
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::os::unix::fs::MetadataExt;

    #[test]
    fn cumulative_io_expiry_cannot_be_reset_by_a_later_frame() {
        let (stream, _idle_peer) = UnixStream::pair().expect("actual idle connected pair");
        let mut channel = Channel::new(stream).expect("channel");
        channel.remaining = Duration::from_millis(1);
        assert!(channel.receive().is_err(), "real socket timeout");
        assert!(channel.remaining.is_zero());
        assert!(
            channel.send(b"{}", None).is_err(),
            "cannot reset exhausted phase"
        );
    }

    #[test]
    fn descriptor_on_length_boundary_is_rejected_and_immediately_disposed() {
        let (mut writer, reader) = UnixStream::pair().expect("pair");
        let mut channel = Channel::new(reader).expect("channel");
        let raw = unsafe { libc::memfd_create(c"late-rights-fixture".as_ptr(), libc::MFD_CLOEXEC) };
        assert!(raw >= 0);
        let file = unsafe { File::from_raw_fd(raw) };
        let identity = file.metadata().expect("unique carrier");
        let (device, inode) = (identity.dev(), identity.ino());
        writer.write_all(&[0]).expect("descriptor-free tag");
        let mut length = 2u32.to_be_bytes();
        let mut vector = libc::iovec {
            iov_base: length.as_mut_ptr().cast(),
            iov_len: 4,
        };
        let mut control = [0usize; 16];
        let mut message: libc::msghdr = unsafe { mem::zeroed() };
        message.msg_iov = &mut vector;
        message.msg_iovlen = 1;
        message.msg_control = control.as_mut_ptr().cast();
        message.msg_controllen = unsafe { libc::CMSG_SPACE(mem::size_of::<i32>() as u32) } as _;
        unsafe {
            let header = libc::CMSG_FIRSTHDR(&message);
            (*header).cmsg_level = libc::SOL_SOCKET;
            (*header).cmsg_type = libc::SCM_RIGHTS;
            (*header).cmsg_len = libc::CMSG_LEN(mem::size_of::<i32>() as u32) as _;
            std::ptr::write_unaligned(libc::CMSG_DATA(header).cast::<i32>(), file.as_raw_fd());
        }
        assert_eq!(
            unsafe { libc::sendmsg(writer.as_raw_fd(), &message, libc::MSG_NOSIGNAL) },
            4
        );
        writer.write_all(b"{}").expect("body");
        assert!(channel.receive().is_err());
        let references = std::fs::read_dir("/proc/self/fd")
            .expect("descriptor readback")
            .filter_map(std::result::Result::ok)
            .filter(|entry| {
                std::fs::metadata(entry.path())
                    .is_ok_and(|metadata| metadata.dev() == device && metadata.ino() == inode)
            })
            .count();
        assert_eq!(
            references, 1,
            "rejected received descriptor closed; original fixture only"
        );
    }
}
