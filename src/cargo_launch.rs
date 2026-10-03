//! Direct selected-Cargo launches and bounded observational correlations.
//! Neither labels nor endpoint reads authenticate the executed tool or ancestry.

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Output};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::compiler_observer::{
    RootBinding, env_allowed, file_observation, normalize_cargo_command, normalized, safe_env_value,
};
use anyhow::{Result, bail};
use build_graph::compiler_invocation::*;
#[cfg(target_os = "linux")]
use build_graph::launch_intent::{Binding, Observer, PreparedLaunch, RoutedIntent};

pub const REQUEST_ENV: &str = "BUILD_GRAPH_CARGO_OPERATION";
static NEXT_SESSION: AtomicU64 = AtomicU64::new(0);

struct RawOperation {
    value: CargoOperationObservation,
    arguments: Option<Vec<OsString>>,
    cwd: Option<PathBuf>,
    tools: [Option<PathBuf>; 4],
}

/// One outer pass, not a private installed-owner capability. The actual kernel
/// must independently bind outer artifact, fork/exec lineage and qualified Cargo.
pub struct CargoLaunchSession {
    pub cargo: PathBuf,
    pub rustc: PathBuf,
    pub rustdoc: PathBuf,
    pub toolchain: String,
    pub library: PathBuf,
    label: String,
    ordinal: u64,
    roots: Vec<RootBinding>,
    operations: Vec<RawOperation>,
    retained: usize,
    read_budget: u64,
    lost: u64,
    #[cfg(target_os = "linux")]
    observer: Option<Observer>,
    #[cfg(target_os = "linux")]
    routed: Option<RoutedIntent>,
}

impl CargoLaunchSession {
    pub fn new(
        cargo: PathBuf,
        rustc: PathBuf,
        rustdoc: PathBuf,
        toolchain: String,
        library: PathBuf,
        approved: &[String],
    ) -> Result<Self> {
        for name in ["RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER"] {
            if std::env::var_os(name).is_some_and(|value| !value.is_empty()) {
                bail!("occurrence capture cannot replace an existing compiler wrapper");
            }
        }
        if [&cargo, &rustc, &rustdoc, &library]
            .iter()
            .any(|path| path.as_os_str().as_encoded_bytes().len() > MAX_TEXT_BYTES)
        {
            bail!("selected tool path exceeds observation bound");
        }
        if toolchain.len() > MAX_TEXT_BYTES {
            bail!("selected toolchain exceeds observation bound");
        }
        let mut roots = Vec::new();
        let mut declared = BTreeSet::new();
        for entry in approved {
            let Some((name, path)) = entry.split_once('=') else {
                bail!("approved root must be NAME=PATH");
            };
            let kind = match name {
                "host_tools" => InputRoot::HostTools,
                "dependencies" => InputRoot::Dependencies,
                "cargo_config" => InputRoot::CargoConfig,
                _ => bail!("unsupported approved compiler root"),
            };
            if !declared.insert(kind) {
                bail!("duplicate approved compiler root");
            }
            roots.push(RootBinding::new(kind, Path::new(path))?);
        }
        let label = format!(
            "{}-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos(),
            NEXT_SESSION.fetch_add(1, Ordering::Relaxed)
        );
        Ok(Self {
            cargo,
            rustc,
            rustdoc,
            toolchain,
            library,
            label,
            ordinal: 0,
            roots,
            operations: Vec::new(),
            retained: 0,
            read_budget: 32 * 1024 * 1024,
            lost: 0,
            #[cfg(target_os = "linux")]
            observer: None,
            #[cfg(target_os = "linux")]
            routed: None,
        })
    }

    pub fn configure(&self, command: &mut Command, compiler_wrappers: bool) {
        command
            .env("RUSTUP_TOOLCHAIN", &self.toolchain)
            .env("RUSTC", &self.rustc)
            .env("RUSTDOC", &self.rustdoc)
            .env(
                if cfg!(target_os = "macos") {
                    "DYLD_FALLBACK_LIBRARY_PATH"
                } else {
                    "LD_LIBRARY_PATH"
                },
                &self.library,
            );
        if !compiler_wrappers {
            command
                .env_remove("RUSTC_WRAPPER")
                .env_remove("RUSTC_WORKSPACE_WRAPPER")
                .env_remove("BUILD_GRAPH_COMPILER_OBSERVER");
        }
    }

    pub fn set_roots(&mut self, roots: &[RootBinding]) {
        self.roots = roots.to_vec();
    }

    #[cfg(target_os = "linux")]
    pub fn set_launch_observer(&mut self, observer: Observer) -> Result<()> {
        if self.ordinal != 0 || self.observer.is_some() {
            bail!("launch observer must precede every selected Cargo operation");
        }
        self.observer = Some(observer);
        Ok(())
    }

    pub fn has_launch_observer(&self) -> bool {
        #[cfg(target_os = "linux")]
        {
            self.observer.is_some()
        }
        #[cfg(not(target_os = "linux"))]
        {
            false
        }
    }

    /// Consume the configured Command so no caller can mutate it after the
    /// final-intent ACK. The same guard retains carrier/Child through actual
    /// wait or synchronous cancellation; this proves no descendant extinction.
    pub fn launch(
        &mut self,
        mut command: Command,
        kind: CargoOperationKind,
    ) -> Result<CargoChild<'_>> {
        let operation = self.begin(&mut command, kind)?;
        #[cfg(target_os = "linux")]
        if let Some(observer) = &mut self.observer {
            let routed = self
                .routed
                .take()
                .ok_or_else(|| anyhow::anyhow!("launch intent routing missing"))?;
            let prepared = observer.prepare(command, routed)?;
            let (child, prepared) = match prepared.spawn() {
                Ok(value) => value,
                Err((error, prepared)) => {
                    let result = observer.spawn_failed(prepared);
                    self.complete(operation, None);
                    result?;
                    return Err(error.into());
                }
            };
            let fault = observer.spawned(&prepared, child.id()).err();
            self.spawned(operation);
            let mut owned = CargoChild {
                child,
                session: self,
                operation,
                waited: false,
                prepared: Some(prepared),
                fault,
            };
            if owned.fault.is_some() {
                // A child already exists: retain this same owner and carrier,
                // cancel synchronously, and prove actual wait before error.
                owned.cancel_owned();
                return Err(owned
                    .fault
                    .take()
                    .unwrap_or_else(|| anyhow::anyhow!("launch observer failed")));
            }
            return Ok(owned);
        }
        let child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                self.complete(operation, None);
                return Err(error.into());
            }
        };
        self.spawned(operation);
        Ok(CargoChild {
            child,
            session: self,
            operation,
            waited: false,
            #[cfg(target_os = "linux")]
            prepared: None,
            fault: None,
        })
    }

    pub fn begin(
        &mut self,
        command: &mut Command,
        kind: CargoOperationKind,
    ) -> Result<Option<usize>> {
        if command.get_program() != self.cargo.as_os_str() {
            bail!("selected Cargo command differs from launch session");
        }
        self.ordinal = self
            .ordinal
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("Cargo operation ordinal exhausted"))?;
        let request = format!("{}-{}", self.label, self.ordinal);
        command.env(REQUEST_ENV, &request);
        #[cfg(target_os = "linux")]
        if let Some(observer) = &mut self.observer {
            if self.operations.len() >= MAX_CARGO_OPERATIONS {
                bail!("launch intent operation bound exhausted");
            }
            self.routed = Some(
                observer.route(
                    command,
                    Binding {
                        session: self.label.clone(),
                        operation: self.ordinal,
                        request: request.clone(),
                        root: observer.root().to_owned(),
                        kind: match kind {
                            CargoOperationKind::Metadata => "metadata",
                            CargoOperationKind::Build => "build",
                            CargoOperationKind::Docs => "docs",
                        }
                        .into(),
                    },
                    true,
                )?,
            );
        }
        if self.operations.len() >= MAX_CARGO_OPERATIONS {
            self.lost = self.lost.saturating_add(1);
            return Ok(None);
        }
        let mut gaps = vec![ObservationGap::UnobservedExecutionInputs];
        let mut truncations = Vec::new();
        let count = command.get_args().count() + 1;
        let mut retained = 0;
        let arguments: Option<Vec<OsString>> = if count > MAX_ARGUMENTS {
            truncations.push(CollectionTruncation {
                collection: "cargo_operation_arguments".into(),
                observed: count as u64,
                retained: 0,
                count_exact: true,
            });
            None
        } else {
            Some(
                std::iter::once(command.get_program())
                    .chain(command.get_args())
                    .map(|argument| {
                        let bytes = argument.as_encoded_bytes().len();
                        if bytes > MAX_TEXT_BYTES
                            || bytes > MAX_CARGO_OPERATION_BYTES.saturating_sub(retained)
                        {
                            gaps.push(ObservationGap::BudgetExceeded);
                            // Preserve the argument position, without retaining secret or
                            // over-budget bytes or a fingerprint of undisclosed bytes.
                            OsString::new()
                        } else {
                            retained += bytes;
                            argument.to_owned()
                        }
                    })
                    .collect(),
            )
        };
        let environment = if self.has_launch_observer() {
            capture_explicit_environment(command, &mut retained, &mut truncations)
        } else {
            capture_environment(command, &mut retained, &mut truncations)
        };
        let cwd = command
            .get_current_dir()
            .map(Path::to_path_buf)
            .or_else(|| std::env::current_dir().ok());
        if cwd.is_none() {
            gaps.push(ObservationGap::ReadFailed);
        }
        let cwd = cwd.filter(|path| {
            let fits = path.as_os_str().as_encoded_bytes().len() <= MAX_TEXT_BYTES;
            if !fits {
                gaps.push(ObservationGap::BudgetExceeded);
            }
            fits
        });
        let tools = [
            "RUSTC",
            "RUSTDOC",
            "RUSTC_WRAPPER",
            "RUSTC_WORKSPACE_WRAPPER",
        ]
        .map(|name| {
            command_value(command, name)
                .filter(|value| {
                    let fits = value.as_encoded_bytes().len() <= MAX_TEXT_BYTES;
                    if !fits {
                        gaps.push(ObservationGap::BudgetExceeded);
                    }
                    fits
                })
                .map(PathBuf::from)
        });
        retained += cwd
            .as_ref()
            .map_or(0, |path| path.as_os_str().as_encoded_bytes().len())
            + tools
                .iter()
                .flatten()
                .map(|path| path.as_os_str().as_encoded_bytes().len())
                .sum::<usize>()
            + arguments.as_ref().map_or(0, Vec::len) * std::mem::size_of::<OsString>()
            + environment.len() * std::mem::size_of::<EnvironmentObservation>()
            + std::mem::size_of::<RawOperation>()
            + request.len();
        if retained > MAX_CARGO_SESSION_BYTES.saturating_sub(self.retained) {
            if self.has_launch_observer() {
                bail!("launch intent observation retention bound exhausted");
            }
            self.lost = self.lost.saturating_add(1);
            return Ok(None);
        }
        self.retained += retained;
        if !truncations.is_empty() {
            gaps.push(ObservationGap::BudgetExceeded);
        }
        let executable = file_observation(
            &self.cargo,
            FileRole::Compiler,
            true,
            &self.roots,
            &mut self.read_budget,
        );
        let index = self.operations.len();
        self.operations.push(RawOperation {
            value: CargoOperationObservation {
                ordinal: self.ordinal,
                request,
                kind,
                command: None,
                cwd: None,
                environment,
                executable,
                rustc: None,
                rustdoc: None,
                compiler_wrapper: None,
                workspace_wrapper: None,
                started: false,
                exit_code: None,
                success: false,
                gaps,
                truncations,
            },
            arguments,
            cwd,
            tools,
        });
        Ok(Some(index))
    }

    pub fn spawned(&mut self, operation: Option<usize>) {
        if let Some(operation) = operation {
            self.operations[operation].value.started = true;
        }
    }

    pub fn complete(&mut self, operation: Option<usize>, status: Option<ExitStatus>) {
        let Some(operation) = operation else {
            return;
        };
        let after = file_observation(
            &self.cargo,
            FileRole::Compiler,
            false,
            &self.roots,
            &mut self.read_budget,
        );
        let value = &mut self.operations[operation].value;
        value.executable.after = after.after;
        value.executable.gaps.extend(after.gaps);
        if value.executable.before.is_some()
            && value.executable.after.is_some()
            && value.executable.before != value.executable.after
        {
            value.executable.gaps.push(ObservationGap::UnstableFile);
        }
        if let Some(status) = status {
            value.started = true;
            value.exit_code = status.code();
            value.success = status.success();
        } else {
            value.gaps.push(ObservationGap::ReadFailed);
        }
    }

    pub fn finish(&self, roots: &[RootBinding]) -> CargoOperationsV1 {
        let mut result = CargoOperationsV1 {
            schema_version: 1,
            session: self.label.clone(),
            operations: Vec::new(),
            gaps: vec![ObservationGap::UnobservedExecutionInputs],
            truncations: Vec::new(),
        };
        let mut lost = self.lost;
        for raw in &self.operations {
            let mut value = raw.value.clone();
            value.command = raw
                .arguments
                .as_ref()
                .map(|arguments| normalize_cargo_command(arguments, roots));
            value.cwd = raw.cwd.as_ref().and_then(|path| normalized(path, roots));
            value.rustc = raw.tools[0]
                .as_ref()
                .and_then(|path| normalized(path, roots));
            value.rustdoc = raw.tools[1]
                .as_ref()
                .and_then(|path| normalized(path, roots));
            value.compiler_wrapper = raw.tools[2]
                .as_ref()
                .and_then(|path| normalized(path, roots));
            value.workspace_wrapper = raw.tools[3]
                .as_ref()
                .and_then(|path| normalized(path, roots));
            if raw.cwd.is_some() && value.cwd.is_none()
                || raw
                    .tools
                    .iter()
                    .zip([
                        &value.rustc,
                        &value.rustdoc,
                        &value.compiler_wrapper,
                        &value.workspace_wrapper,
                    ])
                    .any(|(raw, portable)| raw.is_some() && portable.is_none())
            {
                value.gaps.push(ObservationGap::PathOutsideRoots);
            }
            value.gaps.sort();
            value.gaps.dedup();
            value.executable.gaps.sort();
            value.executable.gaps.dedup();
            if bounded_json_size(&value, MAX_CARGO_OPERATION_BYTES).is_err() {
                lost += 1;
                continue;
            }
            result.operations.push(value);
            if bounded_json_size(&result, MAX_CARGO_SESSION_BYTES - 1024).is_err() {
                result.operations.pop();
                lost += 1;
            }
        }
        if lost > 0 {
            result.gaps.push(ObservationGap::BudgetExceeded);
            result.truncations.push(CollectionTruncation {
                collection: "cargo_operations".into(),
                observed: self.ordinal,
                retained: result.operations.len() as u64,
                count_exact: true,
            });
        }
        // A normalization/serialization defect must never publish a record the
        // original bounded reader rejects. Preserve a typed missing outcome.
        if result.validate().is_err() {
            result.operations.clear();
            result.gaps = vec![
                ObservationGap::UnobservedExecutionInputs,
                ObservationGap::MalformedObservation,
            ];
            result.truncations.clear();
        }
        result
    }
}

/// Actual opt-in Child owner. A post-spawn observer error is retained until
/// the same Child is waited; it cannot permit another launch or success export.
pub struct CargoChild<'a> {
    pub child: Child,
    session: &'a mut CargoLaunchSession,
    operation: Option<usize>,
    waited: bool,
    #[cfg(target_os = "linux")]
    prepared: Option<PreparedLaunch>,
    fault: Option<anyhow::Error>,
}

impl CargoChild<'_> {
    pub fn wait(&mut self) -> Result<ExitStatus> {
        let status = match self.child.wait() {
            Ok(status) => status,
            Err(error) => {
                self.fault = Some(error.into());
                self.cancel_owned();
                return Err(self
                    .fault
                    .take()
                    .unwrap_or_else(|| anyhow::anyhow!("selected Cargo wait failed")));
            }
        };
        self.waited = true;
        self.session.complete(self.operation, Some(status));
        #[cfg(target_os = "linux")]
        if let Some(prepared) = self.prepared.take() {
            let result = self
                .session
                .observer
                .as_mut()
                .ok_or_else(|| anyhow::anyhow!("launch observer lost original owner"))?
                .complete(prepared, status);
            if self.fault.is_none() {
                self.fault = result.err();
            }
        }
        if let Some(error) = self.fault.take() {
            return Err(error);
        }
        Ok(status)
    }

    /// Wait errors never release the Child/carrier. After one cancellation
    /// attempt this original stack remains observation-only until actual wait
    /// succeeds or its external owner disposes the entire caller scope.
    fn retained_wait(&mut self) -> ExitStatus {
        loop {
            match self.child.wait() {
                Ok(status) => return status,
                Err(error) => {
                    if self.fault.is_none() {
                        self.fault = Some(error.into());
                    }
                    std::thread::park_timeout(std::time::Duration::from_millis(10));
                }
            }
        }
    }

    fn cancel_owned(&mut self) {
        if self.waited {
            return;
        }
        let pid = self.child.id();
        let _ = self.child.kill();
        let status = self.retained_wait();
        self.waited = true;
        self.session.complete(self.operation, Some(status));
        #[cfg(target_os = "linux")]
        if let Some(prepared) = self.prepared.take() {
            if let Some(observer) = &mut self.session.observer {
                if let Err(error) = observer.cancel(prepared, pid, Some(status)) {
                    if self.fault.is_none() {
                        self.fault = Some(error);
                    }
                }
            }
        }
    }

    #[cfg(target_os = "linux")]
    pub fn output(&mut self) -> Result<Output> {
        use std::io::{self, Read};
        use std::os::fd::AsRawFd;
        // One synchronous owner drains both pipes. No reader thread can outlive
        // the Child/carrier or prevent same-stack rollback on setup failure.
        let mut stdout = self
            .child
            .stdout
            .take()
            .ok_or_else(|| anyhow::anyhow!("selected Cargo stdout missing"))?;
        let mut stderr = self
            .child
            .stderr
            .take()
            .ok_or_else(|| anyhow::anyhow!("selected Cargo stderr missing"))?;
        let mut buffers = [Vec::new(), Vec::new()];
        let mut done = [false; 2];
        let descriptors = [stdout.as_raw_fd(), stderr.as_raw_fd()];
        for descriptor in descriptors {
            let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFL) };
            if flags < 0
                || unsafe { libc::fcntl(descriptor, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
            {
                self.fault = Some(io::Error::last_os_error().into());
                self.cancel_owned();
                return Err(self
                    .fault
                    .take()
                    .unwrap_or_else(|| anyhow::anyhow!("selected Cargo pipe setup failed")));
            }
        }
        let mut overflow = false;
        while !done.into_iter().all(|value| value) {
            let mut poll = [
                libc::pollfd {
                    fd: descriptors[0],
                    events: libc::POLLIN,
                    revents: 0,
                },
                libc::pollfd {
                    fd: descriptors[1],
                    events: libc::POLLIN,
                    revents: 0,
                },
            ];
            for (index, entry) in poll.iter_mut().enumerate() {
                if done[index] {
                    entry.fd = -1;
                }
            }
            let result = unsafe { libc::poll(poll.as_mut_ptr(), 2, -1) };
            if result < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                self.fault = Some(error.into());
                self.cancel_owned();
                return Err(self
                    .fault
                    .take()
                    .unwrap_or_else(|| anyhow::anyhow!("selected Cargo pipe poll failed")));
            }
            for index in 0..2 {
                if done[index] || poll[index].revents == 0 {
                    continue;
                }
                let mut chunk = [0u8; 4096];
                let read = if index == 0 {
                    stdout.read(&mut chunk)
                } else {
                    stderr.read(&mut chunk)
                };
                match read {
                    Ok(0) => done[index] = true,
                    Ok(count) => {
                        if count <= (8 * 1024 * 1024usize).saturating_sub(buffers[index].len())
                            && !overflow
                        {
                            buffers[index].extend_from_slice(&chunk[..count]);
                        } else {
                            if !overflow {
                                let _ = self.child.kill();
                            }
                            overflow = true;
                        }
                    }
                    Err(error)
                        if matches!(
                            error.kind(),
                            io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
                        ) => {}
                    Err(error) => {
                        self.fault = Some(error.into());
                        self.cancel_owned();
                        return Err(self.fault.take().unwrap_or_else(|| {
                            anyhow::anyhow!("selected Cargo pipe read failed")
                        }));
                    }
                }
            }
        }
        let status = self.wait()?;
        if overflow {
            bail!("selected Cargo output exceeds bound");
        }
        let [stdout, stderr] = buffers;
        Ok(Output {
            status,
            stdout,
            stderr,
        })
    }
}

impl Drop for CargoChild<'_> {
    fn drop(&mut self) {
        if !self.waited && self.session.has_launch_observer() {
            self.cancel_owned();
        }
    }
}

fn capture_explicit_environment(
    command: &Command,
    retained: &mut usize,
    truncations: &mut Vec<CollectionTruncation>,
) -> Vec<EnvironmentObservation> {
    let mut environment = Vec::new();
    let mut observed = 0u64;
    for (name, value) in command.get_envs() {
        let Some(name) = name.to_str().filter(|name| env_allowed(name)) else {
            continue;
        };
        let Some(value) = value else {
            continue;
        };
        observed += 1;
        let value = value
            .to_str()
            .filter(|value| value.len() <= MAX_TEXT_BYTES && safe_env_value(name, value));
        let bytes = name.len().saturating_add(value.map_or(0, str::len));
        if name.len() > MAX_TEXT_BYTES
            || environment.len() >= MAX_FILES
            || bytes > MAX_CARGO_OPERATION_BYTES.saturating_sub(*retained)
        {
            continue;
        }
        *retained += bytes;
        environment.push(EnvironmentObservation {
            name: name.to_owned(),
            present: true,
            gap: value
                .is_none()
                .then_some(ObservationGap::EnvironmentWithheld),
            value: value.map(str::to_owned),
            path: None,
            content_fingerprint: None,
        });
    }
    if observed > environment.len() as u64 {
        truncations.push(CollectionTruncation {
            collection: "cargo_operation_environment".into(),
            observed,
            retained: environment.len() as u64,
            count_exact: true,
        });
    }
    environment
}

fn capture_environment(
    command: &Command,
    retained: &mut usize,
    truncations: &mut Vec<CollectionTruncation>,
) -> Vec<EnvironmentObservation> {
    let mut environment = BTreeMap::new();
    let mut observed = 0u64;
    let mut retain = |name: &std::ffi::OsStr, value: &std::ffi::OsStr| {
        let Some(name) = name.to_str().filter(|name| env_allowed(name)) else {
            return;
        };
        observed = observed.saturating_add(1);
        let value = value
            .to_str()
            .filter(|value| value.len() <= MAX_TEXT_BYTES && safe_env_value(name, value));
        let bytes = name.len().saturating_add(value.map_or(0, str::len));
        if name.len() > MAX_TEXT_BYTES
            || environment.len() >= MAX_FILES
            || bytes > MAX_CARGO_OPERATION_BYTES.saturating_sub(*retained)
        {
            return;
        }
        *retained += bytes;
        environment.insert(name.to_owned(), value.map(str::to_owned));
    };
    // A Command overlay replaces/removes its inherited key. Count the final
    // delivered environment once, including keys withheld by a byte/count cap.
    for (name, value) in std::env::vars_os() {
        if !command.get_envs().any(|(key, _)| key == name.as_os_str()) {
            retain(&name, &value);
        }
    }
    for (name, value) in command.get_envs() {
        if let Some(value) = value {
            retain(name, value);
        }
    }
    if observed > environment.len() as u64 {
        truncations.push(CollectionTruncation {
            collection: "cargo_operation_environment".into(),
            observed,
            retained: environment.len() as u64,
            count_exact: true,
        });
    }
    environment
        .into_iter()
        .map(|(name, value)| EnvironmentObservation {
            name,
            present: true,
            gap: value
                .is_none()
                .then_some(ObservationGap::EnvironmentWithheld),
            value,
            path: None,
            content_fingerprint: None,
        })
        .collect()
}

fn command_value(command: &Command, name: &str) -> Option<OsString> {
    command
        .get_envs()
        .find(|(key, _)| *key == name)
        .map(|(_, value)| value.map(OsString::from))
        .unwrap_or_else(|| std::env::var_os(name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::Workspace;

    fn session(workspace: &Workspace) -> CargoLaunchSession {
        CargoLaunchSession::new(
            workspace.root.join("cargo").into_std_path_buf(),
            workspace.root.join("rustc").into_std_path_buf(),
            workspace.root.join("rustdoc").into_std_path_buf(),
            "nightly-fixture".into(),
            workspace.root.join("lib").into_std_path_buf(),
            &[],
        )
        .expect("observational fixture")
    }

    #[test]
    fn repeated_commands_have_fresh_ordered_correlations_and_no_custody_grant() {
        let workspace = Workspace::new(&[("demo", "demo")]);
        let mut session = session(&workspace);
        let roots = [RootBinding::new(InputRoot::Source, workspace.root.as_std_path()).unwrap()];
        for kind in [
            CargoOperationKind::Metadata,
            CargoOperationKind::Build,
            CargoOperationKind::Metadata,
            CargoOperationKind::Docs,
        ] {
            let mut command = Command::new(&session.cargo);
            command
                .arg(match kind {
                    CargoOperationKind::Metadata => "metadata",
                    CargoOperationKind::Build => "build",
                    CargoOperationKind::Docs => "doc",
                })
                .current_dir(&workspace.root);
            session.configure(&mut command, false);
            let operation = session.begin(&mut command, kind).unwrap();
            let value = &session.operations[operation.unwrap()].value;
            assert_eq!(
                command_value(&command, REQUEST_ENV).unwrap(),
                OsString::from(&value.request)
            );
            session.complete(operation, None);
        }
        let facts = session.finish(&roots);
        facts.validate().expect("bounded original reader");
        assert_eq!(facts.operations.len(), 4);
        let labels: BTreeSet<_> = facts
            .operations
            .iter()
            .map(|value| &value.request)
            .collect();
        assert_eq!(labels.len(), 4);
        for (index, value) in facts.operations.iter().enumerate() {
            assert_eq!(value.ordinal, index as u64 + 1);
            assert!(!value.started && !value.success && value.exit_code.is_none());
            assert!(
                value
                    .gaps
                    .contains(&ObservationGap::UnobservedExecutionInputs)
            );
            assert!(value.gaps.contains(&ObservationGap::ReadFailed));
            assert!(value.workspace_wrapper.is_none());
        }
        assert_ne!(facts.session, self::session(&workspace).label);
    }

    #[test]
    fn actual_command_overlay_removes_keys_and_withholds_sensitive_bytes() {
        let workspace = Workspace::new(&[("demo", "demo")]);
        let mut session = session(&workspace);
        let mut command = Command::new(&session.cargo);
        command
            .arg("metadata")
            .env("PROFILE", "release")
            .env_remove("TARGET")
            .env("RUSTFLAGS", "--cfg secret=credential")
            .env("AWS_SECRET_ACCESS_KEY", "credential")
            .env("RUSTC_WRAPPER", "foreign-wrapper");
        session.configure(&mut command, false);
        let operation = session
            .begin(&mut command, CargoOperationKind::Metadata)
            .unwrap();
        let environment = &session.operations[operation.unwrap()].value.environment;
        assert_eq!(
            environment
                .iter()
                .find(|value| value.name == "PROFILE")
                .unwrap()
                .value
                .as_deref(),
            Some("release")
        );
        assert!(
            !environment
                .iter()
                .any(|value| value.name == "TARGET" || value.name == "AWS_SECRET_ACCESS_KEY")
        );
        let withheld = environment
            .iter()
            .find(|value| value.name == "RUSTFLAGS")
            .unwrap();
        assert_eq!(withheld.gap, Some(ObservationGap::EnvironmentWithheld));
        assert!(withheld.value.is_none() && withheld.content_fingerprint.is_none());
        assert!(command_value(&command, "RUSTC_WRAPPER").is_none());
        let roots = [RootBinding::new(InputRoot::Source, workspace.root.as_std_path()).unwrap()];
        let bytes = serde_json::to_vec(&session.finish(&roots)).unwrap();
        assert!(!String::from_utf8(bytes).unwrap().contains("credential"));
    }

    #[test]
    fn argument_environment_and_operation_overflow_keep_explicit_bounded_loss() {
        let workspace = Workspace::new(&[("demo", "demo")]);
        let mut session = session(&workspace);
        for _ in 0..MAX_CARGO_OPERATIONS + 3 {
            let mut command = Command::new(&session.cargo);
            command
                .arg("build")
                .args(std::iter::repeat_n("--locked", MAX_ARGUMENTS));
            for index in 0..MAX_FILES + 3 {
                command.env(format!("CARGO_FEATURE_SELECTED_{index}"), "1");
            }
            session
                .begin(&mut command, CargoOperationKind::Build)
                .unwrap();
        }
        let facts = session.finish(&[]);
        facts.validate().expect("explicit bounded loss");
        assert!(facts.operations.len() <= MAX_CARGO_OPERATIONS);
        assert!(bounded_json_size(&facts, MAX_CARGO_SESSION_BYTES).is_ok());
        assert!(facts.gaps.contains(&ObservationGap::BudgetExceeded));
        let loss = &facts.truncations[0];
        assert_eq!(loss.observed, (MAX_CARGO_OPERATIONS + 3) as u64);
        assert_eq!(loss.retained, facts.operations.len() as u64);
        for value in &facts.operations {
            assert!(value.command.is_none());
            assert!(
                value
                    .truncations
                    .iter()
                    .any(|gap| gap.collection == "cargo_operation_arguments")
            );
            assert!(
                value
                    .truncations
                    .iter()
                    .any(|gap| gap.collection == "cargo_operation_environment")
            );
            assert!(value.environment.len() <= MAX_FILES);
        }
    }

    #[test]
    fn foreign_command_and_duplicate_root_fail_before_launch() {
        let workspace = Workspace::new(&[("demo", "demo")]);
        let mut session = session(&workspace);
        assert!(
            session
                .begin(&mut Command::new("rustup"), CargoOperationKind::Metadata)
                .is_err()
        );
        assert_eq!(session.ordinal, 0);
        let roots = vec![
            format!("host_tools={}", workspace.root),
            format!("host_tools={}", workspace.root),
        ];
        assert!(
            CargoLaunchSession::new(
                session.cargo,
                session.rustc,
                session.rustdoc,
                session.toolchain,
                session.library,
                &roots
            )
            .is_err()
        );
    }

    #[test]
    fn configured_tool_paths_and_environment_byte_cap_are_actual_and_bounded() {
        let workspace = Workspace::new(&[("demo", "demo")]);
        let session = session(&workspace);
        let mut command = Command::new(&session.cargo);
        session.configure(&mut command, false);
        assert_eq!(
            command_value(&command, "RUSTC").unwrap(),
            session.rustc.as_os_str()
        );
        assert_eq!(
            command_value(&command, "RUSTDOC").unwrap(),
            session.rustdoc.as_os_str()
        );
        assert!(command_value(&command, "BUILD_GRAPH_COMPILER_OBSERVER").is_none());
        for index in 0..MAX_FILES {
            command.env(
                format!("CARGO_FEATURE_{index}_{}", "A".repeat(MAX_TEXT_BYTES - 32)),
                "1",
            );
        }
        let mut retained = 0;
        let mut losses = Vec::new();
        let environment = capture_environment(&command, &mut retained, &mut losses);
        assert!(retained <= MAX_CARGO_OPERATION_BYTES);
        assert!(environment.len() < MAX_FILES);
        let loss = losses
            .iter()
            .find(|value| value.collection == "cargo_operation_environment")
            .unwrap();
        assert!(loss.observed > loss.retained && loss.count_exact);
    }

    #[cfg(unix)]
    #[test]
    fn actual_build_failure_and_spawn_failure_preserve_status_and_selected_program() {
        use std::os::unix::fs::PermissionsExt;
        let workspace = Workspace::new(&[("demo", "demo")]);
        let mut session = session(&workspace);
        std::fs::write(&session.cargo, "#!/bin/sh\nexit 7\n").unwrap();
        std::fs::set_permissions(&session.cargo, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(
            crate::cargo_build::run_build(None, false, &[], &[], None, Some(&mut session)).is_err()
        );
        let roots = [RootBinding::new(InputRoot::Source, workspace.root.as_std_path()).unwrap()];
        let first = session.finish(&roots);
        assert!(first.operations[0].started && !first.operations[0].success);
        assert_eq!(first.operations[0].exit_code, Some(7));
        std::fs::remove_file(&session.cargo).unwrap();
        assert!(
            crate::cargo_build::run_build(None, false, &[], &[], None, Some(&mut session)).is_err()
        );
        let facts = session.finish(&roots);
        facts.validate().unwrap();
        assert!(!facts.operations[1].started && facts.operations[1].exit_code.is_none());
        assert!(
            facts.operations[1]
                .gaps
                .contains(&ObservationGap::ReadFailed)
        );
    }
}

#[cfg(all(test, target_os = "linux"))]
#[path = "cargo_launch_tests.rs"]
mod launch_guard_tests;
