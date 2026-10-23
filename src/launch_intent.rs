//! Opt-in launch observations over a caller-owned connected channel.
//!
//! Correlations, digests, descriptors and acknowledgements authenticate no
//! executable, process ancestry, custody or completeness. A separate original
//! parent must establish those facts. Environment values stay off exports/logs.

use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::path::PathBuf;
use std::process::Command;

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const VERSION: u32 = 1;
pub const MAX_EVENT_BYTES: usize = 32 * 1024;
pub const MAX_SESSION_BYTES: usize = 256 * 1024;
pub const MAX_OPERATIONS: u64 = 16;
pub const MAX_ENVIRONMENT_BYTES: usize = 64 * 1024;
pub const MAX_ENVIRONMENT_ENTRIES: usize = 1024;
pub const MAX_COMMAND_BYTES: usize = 8 * 1024;
pub const MAX_COMMAND_ARGUMENTS: usize = 256;
pub const MAX_OVERLAY_ENTRIES: usize = 32;
pub const MAX_OVERLAY_BYTES: usize = 8 * 1024;
pub const CARRIER_NAME: &str = "build-graph-launch-intent-v1";
pub const ENVIRONMENT_DOMAIN: &[u8] = b"build-graph:launch-environment:v1\0";

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::{Channel, Frame, Observer, PreparedLaunch, RoutedIntent};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    pub session: String,
    pub operation: u64,
    pub request: String,
    pub root: String,
    pub kind: String,
}

impl Binding {
    pub fn validate(&self) -> Result<()> {
        if self.operation == 0
            || self.operation > MAX_OPERATIONS
            || [&self.session, &self.request, &self.root, &self.kind]
                .into_iter()
                .any(|text| {
                    text.is_empty()
                        || text.len() > 256
                        || !text.bytes().all(|byte| (32..127).contains(&byte))
                })
        {
            bail!("launch correlation is invalid or exceeds bounds");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnvironmentDigest {
    pub sha256: String,
    pub entries: u32,
    pub bytes: u32,
    /// Describes observation availability, never an eligibility claim.
    pub complete: bool,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommandIntent {
    pub schema_version: u32,
    pub binding: Binding,
    pub program: Vec<u8>,
    /// Includes the actual selected program at argv[0], in original order.
    pub argv: Vec<Vec<u8>>,
    pub cwd: Vec<u8>,
    pub environment: EnvironmentDigest,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnvironmentChange {
    pub name: Vec<u8>,
    /// None removes the key. Values are never attached to graph exports.
    pub value: Option<Vec<u8>>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FinalIntent {
    pub intent: CommandIntent,
    pub route_nonce: String,
    pub route_response_sha256: String,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case", deny_unknown_fields)]
pub enum Event {
    Route {
        intent: CommandIntent,
        request_sha256: String,
    },
    Intent {
        binding: Binding,
        route_nonce: String,
        route_response_sha256: String,
        carrier_bytes: u32,
        carrier_sha256: String,
    },
    Spawned {
        binding: Binding,
        pid: u32,
    },
    SpawnFailed {
        binding: Binding,
    },
    Completed {
        binding: Binding,
        exit_code: Option<i32>,
        signal: Option<i32>,
    },
    Cancelled {
        binding: Binding,
        pid: Option<u32>,
        exit_code: Option<i32>,
        signal: Option<i32>,
    },
    Unavailable {
        binding: Binding,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "response", rename_all = "snake_case", deny_unknown_fields)]
pub enum Response {
    Route {
        binding: Binding,
        request_sha256: String,
        /// A distinct consistency nonce per operation, not a capability.
        route_nonce: String,
        environment: Vec<EnvironmentChange>,
    },
    Acknowledged {
        binding: Binding,
        event_sha256: String,
    },
    Denied {
        binding: Binding,
    },
}

/// Strict versioned transport envelope. These records never enter graph exports.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope<T> {
    pub schema_version: u32,
    pub payload: T,
}

pub fn event_bytes(event: &Event) -> Result<Vec<u8>> {
    encoded(&Envelope {
        schema_version: VERSION,
        payload: event,
    })
}

pub fn response_bytes(response: &Response) -> Result<Vec<u8>> {
    encoded(&Envelope {
        schema_version: VERSION,
        payload: response,
    })
}

pub fn read_event(bytes: &[u8]) -> Result<Event> {
    if bytes.is_empty() || bytes.len() > MAX_EVENT_BYTES {
        bail!("launch event size exceeds bound");
    }
    let envelope: Envelope<Event> =
        serde_json::from_slice(bytes).map_err(|_| anyhow::anyhow!("launch event is malformed"))?;
    if envelope.schema_version != VERSION {
        bail!("launch event version is unsupported");
    }
    Ok(envelope.payload)
}

pub fn read_response(bytes: &[u8]) -> Result<Response> {
    if bytes.is_empty() || bytes.len() > MAX_EVENT_BYTES {
        bail!("launch response size exceeds bound");
    }
    let envelope: Envelope<Response> = serde_json::from_slice(bytes)
        .map_err(|_| anyhow::anyhow!("launch response is malformed"))?;
    if envelope.schema_version != VERSION {
        bail!("launch response version is unsupported");
    }
    Ok(envelope.payload)
}

pub fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn encoded<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    crate::compiler_invocation::bounded_json_size(value, MAX_EVENT_BYTES)?;
    Ok(serde_json::to_vec(value)?)
}

pub fn digest_environment(environment: &BTreeMap<Vec<u8>, Vec<u8>>) -> Result<EnvironmentDigest> {
    let mut bytes = 0usize;
    if environment.len() > MAX_ENVIRONMENT_ENTRIES {
        bail!("launch environment count exceeds bound");
    }
    for (name, value) in environment {
        bytes = bytes
            .checked_add(name.len())
            .and_then(|size| size.checked_add(value.len()))
            .ok_or_else(|| anyhow::anyhow!("launch environment size overflow"))?;
        if name.is_empty()
            || name.contains(&0)
            || name.contains(&b'=')
            || value.contains(&0)
            || bytes > MAX_ENVIRONMENT_BYTES
        {
            bail!("launch environment is invalid or exceeds bound");
        }
    }
    let mut digest = Sha256::new();
    digest.update(ENVIRONMENT_DOMAIN);
    digest.update((environment.len() as u64).to_le_bytes());
    for (name, value) in environment {
        digest.update((name.len() as u64).to_le_bytes());
        digest.update(name);
        digest.update((value.len() as u64).to_le_bytes());
        digest.update(value);
    }
    Ok(EnvironmentDigest {
        sha256: format!("{:x}", digest.finalize()),
        entries: environment.len() as u32,
        bytes: bytes as u32,
        complete: true,
    })
}

/// Freeze the actual final environment on this opt-in route. The existing
/// Session callers construct inheriting Commands; explicit overlays/removals
/// replace that inherited snapshot. After this point ambient changes cannot
/// alter exec delivery. A caller using a cleared base must select `inherit=false`.
/// Final preparation repeats this freeze with `inherit=false` on the owned
/// command, restoring selected argv[0] and disabling replacement inheritance.
#[cfg(unix)]
pub fn freeze_environment(command: &mut Command, inherit: bool) -> Result<()> {
    use std::os::unix::ffi::{OsStrExt, OsStringExt};
    use std::os::unix::process::CommandExt;
    let cwd = command
        .get_current_dir()
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(std::env::current_dir)?;
    let cwd = if cwd.is_absolute() {
        cwd
    } else {
        std::env::current_dir()?.join(cwd)
    };
    command.current_dir(cwd);
    // Standard Session callers use the selected program as argv[0]. Freeze
    // that actual delivery explicitly instead of guessing a hidden arg0 override.
    if command.get_program().as_bytes().len() > MAX_COMMAND_BYTES {
        bail!("launch program exceeds bound before retention");
    }
    command.arg0(command.get_program().to_os_string());
    let mut environment = BTreeMap::new();
    let mut bytes = 0usize;
    let mut add = |name: &OsStr, value: &OsStr| -> Result<()> {
        let (name, value) = (name.as_bytes(), value.as_bytes());
        let size = name
            .len()
            .checked_add(value.len())
            .ok_or_else(|| anyhow::anyhow!("launch environment size overflow"))?;
        if environment.len() >= MAX_ENVIRONMENT_ENTRIES
            || size > MAX_ENVIRONMENT_BYTES.saturating_sub(bytes)
        {
            bail!("launch environment exceeds bound before retention");
        }
        bytes += size;
        environment.insert(name.to_vec(), value.to_vec());
        Ok(())
    };
    if inherit {
        for (name, value) in std::env::vars_os() {
            if !command.get_envs().any(|(key, _)| key == name) {
                add(&name, &value)?;
            }
        }
    }
    for (name, value) in command.get_envs() {
        if let Some(value) = value {
            add(name, value)?;
        }
    }
    digest_environment(&environment)?;
    command.env_clear();
    command.envs(
        environment
            .into_iter()
            .map(|(name, value)| (OsString::from_vec(name), OsString::from_vec(value))),
    );
    Ok(())
}

/// Describe a command after `freeze_environment` selected its argv[0] and
/// cleared inheritance. This readonly helper cannot inspect Unix arg0 overrides
/// or hidden environment inheritance; the Observer repeats the actual freeze
/// immediately before checking and acknowledging its owned command.
#[cfg(unix)]
pub fn command_intent(command: &Command, binding: Binding) -> Result<CommandIntent> {
    use std::os::unix::ffi::OsStrExt;
    binding.validate()?;
    let mut argv = Vec::new();
    let mut bytes = 0usize;
    for argument in std::iter::once(command.get_program()).chain(command.get_args()) {
        let raw = argument.as_bytes();
        if raw.contains(&0)
            || argv.len() >= MAX_COMMAND_ARGUMENTS
            || raw.len() > MAX_COMMAND_BYTES.saturating_sub(bytes)
        {
            bail!("launch command exceeds bound before retention");
        }
        bytes += raw.len();
        argv.push(raw.to_vec());
    }
    let cwd = command
        .get_current_dir()
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(std::env::current_dir)?;
    let cwd = if cwd.is_absolute() {
        cwd
    } else {
        std::env::current_dir()?.join(cwd)
    };
    let raw_cwd = cwd.as_os_str().as_bytes();
    if raw_cwd.len() > MAX_COMMAND_BYTES.saturating_sub(bytes) {
        bail!("launch cwd exceeds bound");
    }
    let mut environment = BTreeMap::new();
    let mut env_bytes = 0usize;
    for (name, value) in command.get_envs() {
        let Some(value) = value else {
            bail!("launch environment was not frozen");
        };
        let (name, value) = (name.as_bytes(), value.as_bytes());
        let size = name
            .len()
            .checked_add(value.len())
            .ok_or_else(|| anyhow::anyhow!("launch environment size overflow"))?;
        if environment.len() >= MAX_ENVIRONMENT_ENTRIES
            || size > MAX_ENVIRONMENT_BYTES.saturating_sub(env_bytes)
        {
            bail!("launch environment exceeds bound before retention");
        }
        env_bytes += size;
        environment.insert(name.to_vec(), value.to_vec());
    }
    let result = CommandIntent {
        schema_version: VERSION,
        binding,
        program: argv[0].clone(),
        argv,
        cwd: raw_cwd.to_vec(),
        environment: digest_environment(&environment)?,
    };
    encoded(&result)?;
    Ok(result)
}
