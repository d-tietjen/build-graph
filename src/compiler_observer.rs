//! Opt-in stable Cargo wrapper. Private run config is never exported.

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use build_graph::compiler_invocation::*;
use build_graph::compiler_occurrence::{
    self, CallbackRequest, CompilerOccurrencesV1, OccurrenceRoot,
};
use build_graph::export::content_fingerprint;
use cargo_metadata::{Artifact, BuildScript, Metadata};
use serde::{Deserialize, Serialize};

const CONFIG_ENV: &str = "BUILD_GRAPH_COMPILER_OBSERVER";
const WRAPPER_ENTRY: &str = "compiler-wrapper";
const FILE_BYTES: u64 = 8 * 1024 * 1024;
const UNIT_READ_BYTES: u64 = 32 * 1024 * 1024;
const QUERY_BYTES: usize = 16 * 1024;

#[derive(Default)]
struct QueryOutput {
    bytes: Vec<u8>,
    unavailable: bool,
}

impl QueryOutput {
    fn retain(&mut self, bytes: &[u8]) {
        let retained = bytes.len().min(QUERY_BYTES - self.bytes.len());
        self.bytes.extend_from_slice(&bytes[..retained]);
        self.unavailable |= retained < bytes.len();
    }
}

fn read_reserved(reader: impl Read, bytes: u64) -> std::io::Result<Vec<u8>> {
    let mut raw = Vec::new();
    reader.take(bytes).read_to_end(&mut raw)?;
    Ok(raw)
}

fn reserve_read(bytes: u64, maximum: u64, budget: &mut u64) -> Result<(), ObservationGap> {
    if bytes > maximum || bytes > *budget {
        return Err(ObservationGap::BudgetExceeded);
    }
    *budget -= bytes;
    Ok(())
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct RootBinding {
    kind: InputRoot,
    path: PathBuf,
    device: u64,
    inode: u64,
}

impl RootBinding {
    pub(crate) fn new(kind: InputRoot, path: &Path) -> std::io::Result<Self> {
        let path = fs::canonicalize(path)?;
        let metadata = fs::symlink_metadata(&path)?;
        if !metadata.is_dir() {
            return Err(std::io::Error::other("observation root is not a directory"));
        }
        #[cfg(unix)]
        let (device, inode) = {
            use std::os::unix::fs::MetadataExt;
            (metadata.dev(), metadata.ino())
        };
        #[cfg(not(unix))]
        let (device, inode) = (0, 0);
        Ok(Self {
            kind,
            path,
            device,
            inode,
        })
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct Config {
    directory: PathBuf,
    roots: Vec<RootBinding>,
    #[serde(default)]
    occurrences: bool,
}

struct DriverExecution {
    binary: PathBuf,
    cargo: PathBuf,
    rustc: PathBuf,
    toolchain: String,
    library: PathBuf,
}

/// Each build gets an exclusively created directory. Old observations are never
/// loaded into a new attachment, including when Cargo reuses every artifact.
pub struct Session {
    config: Config,
    path: PathBuf,
    metadata: Metadata,
    artifacts: Vec<Artifact>,
    scripts: Vec<BuildScript>,
    artifact_count: u64,
    script_count: u64,
    cargo_command: Option<Vec<InvocationArgument>>,
    cargo_truncations: Vec<CollectionTruncation>,
    driver: Option<DriverExecution>,
}

impl Session {
    pub fn new(meta: Metadata, target: &Path, approved: &[String]) -> Result<Self> {
        #[cfg(not(unix))]
        bail!(
            "compiler observation requires a Unix wrapper entrypoint; ordinary CLI remains available"
        );
        if std::env::var_os("RUSTC_WRAPPER").is_some_and(|v| !v.is_empty()) {
            bail!("compiler observation cannot replace an existing RUSTC_WRAPPER");
        }
        fs::create_dir_all(target).context("creating Cargo target directory")?;
        let parent = target.join("build-graph-observer");
        fs::create_dir_all(&parent).context("creating compiler observation directory")?;
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
        let directory = parent.join(format!("run-{}-{nonce}", std::process::id()));

        let mut roots = vec![
            RootBinding::new(InputRoot::Source, meta.workspace_root.as_std_path())?,
            RootBinding::new(InputRoot::Target, target)?,
        ];
        if let Some(home) = std::env::var_os("CARGO_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".cargo")))
            .and_then(|p| fs::canonicalize(p).ok())
        {
            roots.push(RootBinding::new(InputRoot::Dependencies, &home)?);
            roots.push(RootBinding::new(InputRoot::CargoConfig, &home)?);
        }
        let mut declared = BTreeSet::new();
        for value in approved {
            let (name, path) = value
                .split_once('=')
                .context("approved root must be NAME=PATH")?;
            let kind = match name {
                "dependencies" => InputRoot::Dependencies,
                "host_tools" => InputRoot::HostTools,
                "cargo_config" => InputRoot::CargoConfig,
                _ => bail!("approved root name must be dependencies, host_tools or cargo_config"),
            };
            if !declared.insert(kind) {
                bail!("duplicate approved compiler root");
            }
            let path = fs::canonicalize(path).context("opening approved compiler root")?;
            roots.retain(|root| root.kind != kind);
            roots.push(RootBinding::new(kind, &path)?);
        }
        fs::create_dir(&directory).context("creating exclusive compiler observation run")?;
        if let Err(error) = private_mode(&directory, 0o700) {
            let _ = fs::remove_dir(&directory);
            return Err(error.into());
        }
        let config = Config {
            directory,
            roots,
            occurrences: false,
        };
        let path = config.directory.join("config.json");
        if let Err(error) = exclusive_write(&path, &serde_json::to_vec(&config)?) {
            let _ = fs::remove_dir_all(&config.directory);
            return Err(error.into());
        }
        if let Err(error) = create_wrapper_entry(&config.directory.join(WRAPPER_ENTRY)) {
            let _ = fs::remove_dir_all(&config.directory);
            return Err(error).context("creating the private compiler wrapper entrypoint");
        }
        Ok(Self {
            config,
            path,
            metadata: meta,
            artifacts: vec![],
            scripts: vec![],
            artifact_count: 0,
            script_count: 0,
            cargo_command: None,
            cargo_truncations: vec![],
            driver: None,
        })
    }

    pub fn enable_driver(
        &mut self,
        binary: PathBuf,
        cargo: PathBuf,
        rustc: PathBuf,
        toolchain: String,
        library: PathBuf,
    ) -> Result<()> {
        if std::env::var_os("RUSTC_WORKSPACE_WRAPPER").is_some_and(|v| !v.is_empty()) {
            bail!("occurrence capture cannot replace an existing workspace wrapper");
        }
        self.config.occurrences = true;
        // Replace only our unconsumed local request configuration before Cargo
        // starts. All per-invocation requests and callback outputs are exclusive.
        fs::remove_file(&self.path)?;
        exclusive_write(&self.path, &serde_json::to_vec(&self.config)?)?;
        self.driver = Some(DriverExecution {
            binary,
            cargo,
            rustc,
            toolchain,
            library,
        });
        Ok(())
    }

    pub fn cargo_program(&self) -> Option<&Path> {
        self.driver.as_ref().map(|d| d.cargo.as_path())
    }

    pub(crate) fn roots(&self) -> &[RootBinding] {
        &self.config.roots
    }

    pub fn configure(&mut self, command: &mut Command) -> Result<()> {
        if let Some(driver) = &self.driver {
            command
                .env("RUSTUP_TOOLCHAIN", &driver.toolchain)
                .env("RUSTC", &driver.rustc)
                .env_remove("RUSTDOC")
                .env("RUSTC_WORKSPACE_WRAPPER", &driver.binary)
                .env(
                    if cfg!(target_os = "macos") {
                        "DYLD_FALLBACK_LIBRARY_PATH"
                    } else {
                        "LD_LIBRARY_PATH"
                    },
                    &driver.library,
                );
        }
        let args: Vec<OsString> = std::iter::once(command.get_program().to_owned())
            .chain(command.get_args().map(OsString::from))
            .collect();
        if args
            .iter()
            .any(|arg| arg.as_encoded_bytes().len() > MAX_TEXT_BYTES)
        {
            note_truncation(
                &mut self.cargo_truncations,
                "cargo_argument_text_bytes",
                args.iter()
                    .map(|arg| arg.as_encoded_bytes().len() as u64)
                    .max()
                    .unwrap_or(0),
                0,
                true,
            );
        } else if args.len() > MAX_ARGUMENTS {
            note_truncation(
                &mut self.cargo_truncations,
                "cargo_command_arguments",
                args.len() as u64,
                0,
                true,
            );
        } else {
            self.cargo_command = Some(normalize_cargo_command(&args, &self.config.roots));
        }
        command
            .env("RUSTC_WRAPPER", self.config.directory.join(WRAPPER_ENTRY))
            .env(CONFIG_ENV, &self.path);
        Ok(())
    }

    pub fn artifact(&mut self, artifact: &Artifact) {
        self.artifact_count = self.artifact_count.saturating_add(1);
        if self.artifacts.len() < MAX_INVOCATIONS * 4
            && artifact.features.len() <= MAX_FILES
            && artifact.filenames.len() <= MAX_FILES
            && bounded_json_size(artifact, MAX_INVOCATION_BYTES).is_ok()
        {
            self.artifacts.push(artifact.clone());
        }
    }

    pub fn build_script(&mut self, script: &BuildScript) {
        self.script_count = self.script_count.saturating_add(1);
        if self.scripts.len() < MAX_INVOCATIONS
            && script.env.len() <= MAX_FILES
            && script.cfgs.len() <= MAX_FILES
            && script.linked_libs.len() <= MAX_FILES
            && script.linked_paths.len() <= MAX_FILES
            && bounded_json_size(script, MAX_INVOCATION_BYTES).is_ok()
        {
            self.scripts.push(script.clone());
        }
    }

    pub fn finish(&self) -> CompilerInvocationsV1 {
        self.finish_with_operations(None)
    }

    pub fn finish_with_operations(
        &self,
        cargo_operations: Option<CargoOperationsV1>,
    ) -> CompilerInvocationsV1 {
        let mut budget = UNIT_READ_BYTES;
        let mut result = CompilerInvocationsV1 {
            schema_version: COMPILER_INVOCATIONS_VERSION,
            cargo: tool_identity(
                self.driver
                    .as_ref()
                    .and_then(|d| d.cargo.to_str())
                    .unwrap_or("cargo"),
                &self.config.roots,
                &mut budget,
            ),
            cargo_command: self.cargo_command.clone(),
            cargo_cwd: std::env::current_dir()
                .ok()
                .and_then(|p| normalized(&p, &self.config.roots)),
            cargo_environment: vec![],
            wrapper: std::env::current_exe().ok().map(|path| ToolObservation {
                executable: Some(file_observation(
                    &path,
                    FileRole::Compiler,
                    true,
                    &self.config.roots,
                    &mut budget,
                )),
                verbose_identity: BTreeMap::new(),
                gaps: vec![ObservationGap::UnobservedExecutionInputs],
            }),
            invocations: vec![],
            generators: vec![],
            gaps: vec![
                ObservationGap::UnobservedExecutionInputs,
                ObservationGap::OtherCompilerPhasesNotObserved,
            ],
            truncations: self.cargo_truncations.clone(),
            cargo_operations,
        };
        result.cargo_environment = environment(
            &self.config.roots,
            "cargo_environment",
            &mut result.truncations,
        );
        if let Some(driver) = &self.driver {
            result
                .cargo_environment
                .retain(|e| e.name != "RUSTUP_TOOLCHAIN");
            result.cargo_environment.push(EnvironmentObservation {
                name: "RUSTUP_TOOLCHAIN".into(),
                present: true,
                value: Some(driver.toolchain.clone()),
                content_fingerprint: None,
                path: None,
                gap: None,
            });
            result.cargo_environment.sort_by(|a, b| a.name.cmp(&b.name));
        }
        note_truncation(
            &mut result.truncations,
            "cargo_artifacts",
            self.artifact_count,
            self.artifacts.len(),
            true,
        );
        note_truncation(
            &mut result.truncations,
            "cargo_build_scripts",
            self.script_count,
            self.scripts.len(),
            true,
        );
        let mut paths: Vec<_> = fs::read_dir(&self.config.directory)
            .into_iter()
            .flatten()
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|s| s.to_str())
                    .is_some_and(|s| s.starts_with("unit-") && s.ends_with(".json"))
            })
            .take(MAX_INVOCATIONS + 1)
            .collect();
        paths.sort();
        note_truncation(
            &mut result.truncations,
            "invocation_files",
            paths.len() as u64,
            MAX_INVOCATIONS.min(paths.len()),
            false,
        );
        for entry in fs::read_dir(&self.config.directory)
            .into_iter()
            .flatten()
            .filter_map(|e| e.ok())
            .take(MAX_INVOCATIONS * 3 + 32)
        {
            if entry
                .file_name()
                .to_str()
                .is_some_and(|n| n.starts_with("budget-"))
            {
                if let Ok(bytes) = bounded_read(&entry.path(), 1024)
                    && let Ok(witness) = serde_json::from_slice::<CollectionTruncation>(&bytes)
                {
                    result.truncations.push(witness);
                } else {
                    result.gaps.push(ObservationGap::MalformedObservation);
                }
            }
        }
        if self.config.directory.join("compiler-unrecognized").exists() {
            result
                .gaps
                .push(ObservationGap::CompilerIdentityUnavailable);
        }
        if self.config.directory.join("observation-failed").exists() {
            result.gaps.push(ObservationGap::ReadFailed);
        }
        let slots = fs::read_dir(&self.config.directory)
            .into_iter()
            .flatten()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_str()
                    .is_some_and(|n| n.starts_with("slot-"))
            })
            .take(MAX_INVOCATIONS + 1)
            .count();
        if slots > paths.len() {
            result.gaps.push(ObservationGap::MalformedObservation);
        }
        let mut keys = BTreeSet::new();
        let mut assembly = AssemblyBudget::new(&result);
        for path in paths.into_iter().take(MAX_INVOCATIONS) {
            let raw = match bounded_read(&path, MAX_INVOCATION_BYTES as u64) {
                Ok(raw) => raw,
                Err(_) => {
                    result.gaps.push(ObservationGap::MalformedObservation);
                    continue;
                }
            };
            let mut invocation: CompilerInvocation = match serde_json::from_slice(&raw) {
                Ok(value) => value,
                Err(_) => {
                    result.gaps.push(ObservationGap::MalformedObservation);
                    continue;
                }
            };
            if invocation.validate().is_err() {
                result.gaps.push(ObservationGap::MalformedObservation);
                continue;
            }
            let bindings: Vec<_> = self
                .artifacts
                .iter()
                .filter(|artifact| {
                    !artifact.fresh
                        && artifact.target.name.replace('-', "_") == invocation.unit.crate_name
                        && invocation.unit.source.is_some()
                        && normalized(artifact.target.src_path.as_std_path(), &self.config.roots)
                            == invocation.unit.source
                        && artifact.filenames.iter().any(|filename| {
                            let path = normalized(filename.as_std_path(), &self.config.roots);
                            path.is_some()
                                && invocation
                                    .outputs
                                    .iter()
                                    .any(|output| output.after.is_some() && output.path == path)
                        })
                })
                .collect();
            if self.artifact_count > self.artifacts.len() as u64 {
                invocation.gaps.push(ObservationGap::CargoUnitUnbound);
            } else if let [artifact] = bindings.as_slice() {
                invocation.unit.cargo = Some(self.cargo_unit(artifact));
            } else {
                invocation.gaps.push(if bindings.is_empty() {
                    ObservationGap::CargoUnitUnbound
                } else {
                    ObservationGap::ConflictingUnit
                });
            }
            let Some(bytes) = assembly.admissible_size(
                &invocation,
                MAX_INVOCATION_BYTES,
                !result.invocations.is_empty(),
            ) else {
                assembly.dropped_invocations += 1;
                continue;
            };
            if invocation.bind_unit_key().is_err() || !keys.insert(invocation.unit_key.clone()) {
                result.gaps.push(ObservationGap::ConflictingUnit);
                continue;
            }
            if invocation.validate().is_err() {
                result.gaps.push(ObservationGap::MalformedObservation);
                continue;
            }
            assembly.bytes += bytes;
            result.invocations.push(invocation);
        }
        if self.artifacts.iter().any(|a| a.fresh) {
            result.gaps.push(ObservationGap::CachedArtifactNotInvoked);
        }
        for script in &self.scripts {
            let mut budget = UNIT_READ_BYTES;
            let mut env = Vec::new();
            let mut truncations = vec![];
            note_truncation(
                &mut truncations,
                "generator_environment",
                script.env.len() as u64,
                script.env.len().min(MAX_FILES),
                true,
            );
            for (key, value) in script.env.iter().take(MAX_FILES) {
                if env_allowed(key) {
                    env.push(EnvironmentObservation {
                        name: key.clone(),
                        present: true,
                        value: None,
                        content_fingerprint: Some(content_fingerprint(value.as_bytes())),
                        path: None,
                        gap: Some(ObservationGap::EnvironmentWithheld),
                    });
                }
            }
            let mut outputs = Vec::new();
            if let Ok(entries) = fs::read_dir(script.out_dir.as_std_path()) {
                let mut entries: Vec<_> = entries
                    .filter_map(|e| e.ok())
                    .map(|e| e.path())
                    .take(MAX_FILES + 1)
                    .collect();
                entries.sort();
                note_truncation(
                    &mut truncations,
                    "generated_entries",
                    entries.len() as u64,
                    if entries.len() > MAX_FILES {
                        0
                    } else {
                        entries.len()
                    },
                    false,
                );
                if entries.len() > MAX_FILES {
                    entries.clear();
                }
                for path in entries {
                    if path.is_file() {
                        outputs.push(file_observation(
                            &path,
                            FileRole::Generated,
                            false,
                            &self.config.roots,
                            &mut budget,
                        ));
                    }
                }
            }
            let directive_fingerprint = serde_json::to_vec(&(
                &script.cfgs,
                &script.linked_libs,
                script
                    .linked_paths
                    .iter()
                    .map(|p| normalized(p.as_std_path(), &self.config.roots))
                    .collect::<Vec<_>>(),
                &env,
                script
                    .env
                    .iter()
                    .map(|(key, value)| {
                        (
                            content_fingerprint(key.as_bytes()),
                            content_fingerprint(value.as_bytes()),
                        )
                    })
                    .collect::<Vec<_>>(),
            ))
            .ok()
            .map(|b| content_fingerprint(&b));
            let generator = GeneratorObservation {
                package: {
                    let matches: Vec<_> = self
                        .artifacts
                        .iter()
                        .filter(|a| {
                            a.package_id == script.package_id
                                && a.target
                                    .kind
                                    .iter()
                                    .any(|k| k.to_string() == "custom-build")
                        })
                        .collect();
                    if let [artifact] = matches.as_slice() {
                        Some(self.cargo_unit(artifact))
                    } else {
                        None
                    }
                },
                out_dir: normalized(script.out_dir.as_std_path(), &self.config.roots),
                command: None,
                inputs: vec![],
                outputs,
                environment: env,
                // Directives can contain sensitive values: retain a consistency
                // marker only, and explicitly withhold their execution meaning.
                directive_fingerprint,
                gaps: vec![
                    ObservationGap::GeneratorCommandNotObserved,
                    ObservationGap::GeneratorInputsNotObserved,
                    ObservationGap::EnvironmentWithheld,
                    ObservationGap::UnobservedExecutionInputs,
                ]
                .into_iter()
                .chain((!truncations.is_empty()).then_some(ObservationGap::BudgetExceeded))
                .collect(),
                truncations,
            };
            let Some(bytes) = assembly.admissible_size(
                &generator,
                MAX_ATTACHMENT_BYTES,
                !result.generators.is_empty(),
            ) else {
                assembly.dropped_generators += 1;
                continue;
            };
            if generator.validate().is_err() {
                result.gaps.push(ObservationGap::MalformedObservation);
                continue;
            }
            assembly.bytes += bytes;
            result.generators.push(generator);
        }
        if !result.truncations.is_empty() {
            result.gaps.push(ObservationGap::BudgetExceeded);
        }
        result
            .invocations
            .sort_by(|a, b| a.unit_key.cmp(&b.unit_key));
        result
            .generators
            .sort_by_cached_key(|v| serde_json::to_vec(v).unwrap_or_default());
        result
            .truncations
            .sort_by(|a, b| a.collection.cmp(&b.collection));
        result.gaps.sort();
        result.gaps.dedup();
        assembly.finish(result)
    }

    fn cargo_unit(&self, artifact: &Artifact) -> CargoUnitObservation {
        let package = self
            .metadata
            .packages
            .iter()
            .find(|p| p.id == artifact.package_id);
        let manifest = normalized(artifact.manifest_path.as_std_path(), &self.config.roots);
        let name = package.map(|p| p.name.clone()).unwrap_or_default();
        let version = package.map(|p| p.version.to_string()).unwrap_or_default();
        let resolver_identity = manifest
            .as_ref()
            .map(|path| format!("{}@{}:{:?}:{}", name, version, path.root, path.relative));
        let mut features = artifact.features.clone();
        features.sort();
        features.dedup();
        CargoUnitObservation {
            package_name: name,
            package_version: version,
            resolver_identity,
            manifest,
            target_name: artifact.target.name.clone(),
            target_kinds: artifact
                .target
                .kind
                .iter()
                .map(ToString::to_string)
                .collect(),
            crate_types: artifact
                .target
                .crate_types
                .iter()
                .map(ToString::to_string)
                .collect(),
            edition: artifact.target.edition.to_string(),
            source: normalized(artifact.target.src_path.as_std_path(), &self.config.roots),
            features,
            profile: BTreeMap::from([
                ("opt_level".into(), artifact.profile.opt_level.clone()),
                ("debuginfo".into(), artifact.profile.debuginfo.to_string()),
                (
                    "debug_assertions".into(),
                    artifact.profile.debug_assertions.to_string(),
                ),
                (
                    "overflow_checks".into(),
                    artifact.profile.overflow_checks.to_string(),
                ),
                ("test".into(), artifact.profile.test.to_string()),
            ]),
            feature_mode: None,
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.config.directory);
    }
}

/// Charge the encoded empty arrays once, then each record and its comma. No
/// oversized record is serialized into a Vec or retained in the attachment.
struct AssemblyBudget {
    bytes: usize,
    dropped_invocations: u64,
    dropped_generators: u64,
}

impl AssemblyBudget {
    fn new(header: &CompilerInvocationsV1) -> Self {
        Self {
            bytes: bounded_json_size(header, MAX_ATTACHMENT_BYTES).unwrap_or(MAX_ATTACHMENT_BYTES),
            dropped_invocations: 0,
            dropped_generators: 0,
        }
    }

    fn admissible_size(
        &self,
        record: &impl Serialize,
        maximum: usize,
        comma: bool,
    ) -> Option<usize> {
        let bytes = bounded_json_size(record, maximum)
            .ok()?
            .checked_add(usize::from(comma))?;
        (bytes <= MAX_ATTACHMENT_BYTES.saturating_sub(self.bytes)).then_some(bytes)
    }

    fn losses(&self, result: &mut CompilerInvocationsV1) {
        result.truncations.retain(|v| {
            !matches!(
                v.collection.as_str(),
                "assembled_invocations" | "assembled_generators"
            )
        });
        note_truncation(
            &mut result.truncations,
            "assembled_invocations",
            result.invocations.len() as u64 + self.dropped_invocations,
            result.invocations.len(),
            true,
        );
        note_truncation(
            &mut result.truncations,
            "assembled_generators",
            result.generators.len() as u64 + self.dropped_generators,
            result.generators.len(),
            true,
        );
        if !result.truncations.is_empty() {
            result.gaps.push(ObservationGap::BudgetExceeded);
        }
        result.gaps.sort();
        result.gaps.dedup();
    }

    fn finish(mut self, mut result: CompilerInvocationsV1) -> CompilerInvocationsV1 {
        // Loss witnesses also occupy bytes. Evict records when necessary to
        // fit those exact counts, rather than silently losing the attachment.
        loop {
            self.losses(&mut result);
            if bounded_json_size(&result, MAX_ATTACHMENT_BYTES).is_ok() {
                break;
            }
            if result.generators.pop().is_some() {
                self.dropped_generators += 1;
            } else if result.invocations.pop().is_some() {
                self.dropped_invocations += 1;
            } else {
                note_truncation(
                    &mut result.truncations,
                    "attachment_metadata_bytes",
                    (MAX_ATTACHMENT_BYTES + 1) as u64,
                    0,
                    false,
                );
                result.gaps.push(ObservationGap::BudgetExceeded);
                return gap_attachment(result);
            }
        }
        result
            .truncations
            .sort_by(|a, b| a.collection.cmp(&b.collection));
        if result.validate().is_err() {
            result.gaps.push(ObservationGap::MalformedObservation);
            return gap_attachment(result);
        }
        result
    }
}

fn gap_attachment(mut result: CompilerInvocationsV1) -> CompilerInvocationsV1 {
    let observed = result.truncations.len();
    result.truncations.retain(|v| {
        v.observed > v.retained
            && !v.collection.is_empty()
            && v.collection.len() <= 64
            && v.collection
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_')
    });
    result.truncations.truncate(MAX_FILES - 1);
    for witness in &mut result.truncations {
        if matches!(
            witness.collection.as_str(),
            "assembled_invocations" | "assembled_generators"
        ) {
            witness.retained = 0;
        }
    }
    let retained = result.truncations.len();
    note_truncation(
        &mut result.truncations,
        "budget_witnesses",
        observed as u64,
        retained,
        true,
    );
    if !result.truncations.is_empty() {
        result.gaps.push(ObservationGap::BudgetExceeded);
    }
    result.gaps.sort();
    result.gaps.dedup();
    result.cargo = ToolObservation {
        executable: None,
        verbose_identity: BTreeMap::new(),
        gaps: vec![ObservationGap::CompilerIdentityUnavailable],
    };
    result.cargo_command = None;
    result.cargo_cwd = None;
    result.cargo_environment.clear();
    result.cargo_operations = None;
    result.wrapper = None;
    result.invocations.clear();
    result.generators.clear();
    result
}

fn private_mode(path: &Path, mode: u32) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
    }
    Ok(())
}

fn exclusive_write(path: &Path, raw: &[u8]) -> std::io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(raw)?;
    file.sync_all()
}

fn bounded_read(path: &Path, maximum: u64) -> std::io::Result<Vec<u8>> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.len() > maximum {
        return Err(std::io::Error::other("file observation unavailable"));
    }
    let mut raw = Vec::new();
    File::open(path)?.take(maximum + 1).read_to_end(&mut raw)?;
    if raw.len() as u64 > maximum {
        return Err(std::io::Error::other("file observation budget exceeded"));
    }
    Ok(raw)
}

pub(crate) fn normalized(path: &Path, roots: &[RootBinding]) -> Option<ObservedPath> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().ok()?.join(path)
    };
    // Lexical parent components and symlink escapes are never exported under a
    // misleading workspace root. Missing outputs are normalized lexically.
    if absolute
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return None;
    }
    let resolved = fs::canonicalize(&absolute).unwrap_or(absolute);
    let root = roots
        .iter()
        .filter(|r| resolved.starts_with(&r.path))
        .max_by_key(|r| r.path.components().count())?;
    let relative = resolved
        .strip_prefix(&root.path)
        .ok()?
        .to_str()?
        .replace('\\', "/");
    let path = ObservedPath {
        root: root.kind,
        relative,
    };
    path.is_portable().then_some(path)
}

fn mark_budget(config: &Config, collection: &str, observed: u64, retained: usize, exact: bool) {
    let witness = CollectionTruncation {
        collection: collection.into(),
        observed,
        retained: retained as u64,
        count_exact: exact,
    };
    if let Ok(raw) = serde_json::to_vec(&witness) {
        let _ = exclusive_write(
            &config.directory.join(format!("budget-{collection}.json")),
            &raw,
        );
    }
}

fn note_truncation(
    out: &mut Vec<CollectionTruncation>,
    collection: &str,
    observed: u64,
    retained: usize,
    exact: bool,
) {
    if observed > retained as u64 {
        out.push(CollectionTruncation {
            collection: collection.into(),
            observed,
            retained: retained as u64,
            count_exact: exact,
        });
    }
}

fn lexical_binding(
    path: &Path,
    roots: &[RootBinding],
) -> Option<(ObservedPath, RootBinding, PathBuf)> {
    let absolute = if path.is_absolute() {
        path.into()
    } else {
        std::env::current_dir().ok()?.join(path)
    };
    if absolute
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return None;
    }
    let root = roots
        .iter()
        .filter(|r| absolute.starts_with(&r.path))
        .max_by_key(|r| r.path.components().count())?;
    let relative = absolute
        .strip_prefix(&root.path)
        .ok()?
        .components()
        .filter_map(|c| match c {
            Component::Normal(value) => Some(value),
            _ => None,
        })
        .collect::<PathBuf>();
    let portable = ObservedPath {
        root: root.kind,
        relative: relative.to_str()?.into(),
    };
    portable
        .is_portable()
        .then_some((portable, root.clone(), relative))
}

#[cfg(target_os = "linux")]
mod linux_owned {
    use std::ffi::CString;
    use std::fs::File;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;
    unsafe extern "C" {
        fn openat(dirfd: i32, pathname: *const std::ffi::c_char, flags: i32, ...) -> i32;
        fn kill(pid: i32, signal: i32) -> i32;
        fn fcntl(fd: i32, operation: i32, ...) -> i32;
    }
    pub const DIRECTORY: i32 = 0o200000;
    pub const PATH_ONLY: i32 = 0o10000000;
    pub fn open(parent: Option<&File>, path: &Path, extra: i32) -> std::io::Result<File> {
        let name = CString::new(path.as_os_str().as_bytes())
            .map_err(|_| std::io::Error::other("invalid observation path"))?;
        // O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK; held parent descriptor prevents
        // an ancestor rename from redirecting the next component.
        let fd = unsafe {
            openat(
                parent.map(AsRawFd::as_raw_fd).unwrap_or(-100),
                name.as_ptr(),
                extra | 0o400000 | 0o2000000 | 0o4000,
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: openat returned a new descriptor, uniquely owned here.
        Ok(unsafe { File::from_raw_fd(fd) })
    }
    pub fn signal_group(pid: u32, signal: i32) -> std::io::Result<()> {
        let pid = i32::try_from(pid).map_err(|_| std::io::Error::other("invalid owned PID"))?;
        if unsafe { kill(-pid, signal) } == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }
    pub fn nonblocking(file: &impl AsRawFd) -> std::io::Result<()> {
        let old = unsafe { fcntl(file.as_raw_fd(), 3) };
        if old < 0 || unsafe { fcntl(file.as_raw_fd(), 4, old | 0o4000) } < 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
}

#[cfg(unix)]
fn same_identity(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    a.dev() == b.dev() && a.ino() == b.ino()
}

#[cfg(target_os = "linux")]
fn anchored_read(
    root: &RootBinding,
    relative: &Path,
    maximum: u64,
    budget: &mut u64,
    after_open: impl FnOnce(),
) -> Result<(Vec<u8>, fs::Metadata), ObservationGap> {
    use std::os::unix::fs::MetadataExt;
    let fail = |_| ObservationGap::ReadFailed;
    let root_file = linux_owned::open(None, &root.path, linux_owned::DIRECTORY).map_err(fail)?;
    let anchor = root_file.metadata().map_err(fail)?;
    if anchor.dev() != root.device || anchor.ino() != root.inode {
        return Err(ObservationGap::UnstableFile);
    }
    let components: Vec<_> = relative
        .components()
        .filter_map(|c| match c {
            Component::Normal(c) => Some(PathBuf::from(c)),
            _ => None,
        })
        .collect();
    let (leaf, parents) = components.split_last().ok_or(ObservationGap::ReadFailed)?;
    let mut held = vec![root_file];
    for component in parents {
        let next =
            linux_owned::open(held.last(), component, linux_owned::DIRECTORY).map_err(fail)?;
        held.push(next);
    }
    let named = linux_owned::open(held.last(), leaf, linux_owned::PATH_ONLY).map_err(fail)?;
    let named_before = named.metadata().map_err(fail)?;
    if !named_before.is_file() {
        return Err(ObservationGap::ReadFailed);
    }
    let file = linux_owned::open(held.last(), leaf, 0).map_err(fail)?;
    let start = file.metadata().map_err(fail)?;
    if !same_identity(&named_before, &start)
        || named_before.ctime() != start.ctime()
        || named_before.ctime_nsec() != start.ctime_nsec()
    {
        return Err(ObservationGap::UnstableFile);
    }
    // Reserve the complete descriptor size before any read or test hook. A
    // failed/short/unstable read never refunds work. Read only this size; the
    // descriptor and named-chain rechecks reject growth without an extra byte.
    reserve_read(start.len(), maximum, budget)?;
    after_open();
    let raw = read_reserved(&file, start.len()).map_err(fail)?;
    let end = file.metadata().map_err(fail)?;
    // Reopen the complete chain from the named root and compare to every held
    // directory. An ancestor replacement cannot turn an outside read into an
    // approved-root observation, even when the original directory still exists.
    let mut check = linux_owned::open(None, &root.path, linux_owned::DIRECTORY).map_err(fail)?;
    if !same_identity(&check.metadata().map_err(fail)?, &anchor) {
        return Err(ObservationGap::UnstableFile);
    }
    for (index, component) in parents.iter().enumerate() {
        check = linux_owned::open(Some(&check), component, linux_owned::DIRECTORY).map_err(fail)?;
        if !same_identity(
            &check.metadata().map_err(fail)?,
            &held[index + 1].metadata().map_err(fail)?,
        ) {
            return Err(ObservationGap::UnstableFile);
        }
    }
    let after = linux_owned::open(Some(&check), leaf, linux_owned::PATH_ONLY)
        .map_err(fail)?
        .metadata()
        .map_err(fail)?;
    if !same_identity(&start, &end)
        || !same_identity(&end, &after)
        || start.len() != raw.len() as u64
        || start.len() != end.len()
        || start.len() != after.len()
        || start.mtime() != end.mtime()
        || start.mtime_nsec() != end.mtime_nsec()
        || end.mtime() != after.mtime()
        || end.mtime_nsec() != after.mtime_nsec()
        || start.ctime() != end.ctime()
        || start.ctime_nsec() != end.ctime_nsec()
        || end.ctime() != after.ctime()
        || end.ctime_nsec() != after.ctime_nsec()
    {
        return Err(ObservationGap::UnstableFile);
    }
    Ok((raw, end))
}

#[cfg(not(target_os = "linux"))]
fn anchored_read(
    _: &RootBinding,
    _: &Path,
    _: u64,
    _: &mut u64,
    _: impl FnOnce(),
) -> Result<(Vec<u8>, fs::Metadata), ObservationGap> {
    // Unsupported descriptor semantics are uncertainty, never a weaker read.
    Err(ObservationGap::ReadFailed)
}

fn observed_bytes(
    path: &Path,
    roots: &[RootBinding],
    maximum: u64,
    budget: &mut u64,
) -> Result<(ObservedPath, Vec<u8>, fs::Metadata), ObservationGap> {
    let (portable, root, relative) =
        lexical_binding(path, roots).ok_or(ObservationGap::PathOutsideRoots)?;
    let (bytes, metadata) = anchored_read(&root, &relative, maximum, budget, || {})?;
    Ok((portable, bytes, metadata))
}

pub(crate) fn file_observation(
    path: &Path,
    role: FileRole,
    before: bool,
    roots: &[RootBinding],
    budget: &mut u64,
) -> FileObservation {
    let mut result = FileObservation {
        path: lexical_binding(path, roots).map(|v| v.0),
        role,
        before: None,
        after: None,
        gaps: vec![],
    };
    match observed_bytes(path, roots, FILE_BYTES, budget) {
        Ok((_, bytes, metadata)) => {
            #[cfg(unix)]
            let mode = {
                use std::os::unix::fs::MetadataExt;
                Some(metadata.mode() & 0o7777)
            };
            #[cfg(not(unix))]
            let mode = {
                let _ = metadata;
                None
            };
            let file = ObservedFile {
                bytes: bytes.len() as u64,
                mode,
                content_fingerprint: content_fingerprint(&bytes),
            };
            if before {
                result.before = Some(file)
            } else {
                result.after = Some(file)
            }
        }
        Err(gap) => result.gaps.push(gap),
    }
    result
}

pub(crate) fn env_allowed(name: &str) -> bool {
    matches!(
        name,
        "CARGO_PKG_NAME"
            | "CARGO_PKG_VERSION"
            | "CARGO_MANIFEST_DIR"
            | "OUT_DIR"
            | "PROFILE"
            | "OPT_LEVEL"
            | "DEBUG"
            | "HOST"
            | "TARGET"
            | "NUM_JOBS"
            | "RUSTFLAGS"
            | "CARGO_ENCODED_RUSTFLAGS"
            | "RUSTUP_TOOLCHAIN"
    ) || name.starts_with("CARGO_CFG_")
        || name.starts_with("CARGO_FEATURE_")
}

/// Never capture arbitrary inherited variables or plaintext flag values.
fn environment(
    roots: &[RootBinding],
    collection: &str,
    truncations: &mut Vec<CollectionTruncation>,
) -> Vec<EnvironmentObservation> {
    let mut result = Vec::new();
    let mut values: Vec<_> = std::env::vars_os()
        .filter(|(name, _)| name.to_str().is_some_and(env_allowed))
        .collect();
    values.sort_by(|a, b| a.0.cmp(&b.0));
    note_truncation(
        truncations,
        collection,
        values.len() as u64,
        values.len().min(MAX_FILES),
        true,
    );
    for (name, value) in values.into_iter().take(MAX_FILES) {
        let Some(name) = name.to_str() else { continue };
        if !env_allowed(name) || name.len() > MAX_TEXT_BYTES {
            continue;
        }
        let path = matches!(name, "CARGO_MANIFEST_DIR" | "OUT_DIR")
            .then(|| normalized(Path::new(&value), roots))
            .flatten();
        let fingerprint = path
            .as_ref()
            .and_then(|p| serde_json::to_vec(p).ok())
            .map(|bytes| content_fingerprint(&bytes))
            .or_else(|| {
                value
                    .to_str()
                    .filter(|v| v.len() <= MAX_TEXT_BYTES)
                    .map(|v| content_fingerprint(v.as_bytes()))
            });
        let disclosed = value
            .to_str()
            .filter(|v| safe_env_value(name, v))
            .map(str::to_owned);
        let gap = if value.as_encoded_bytes().len() > MAX_TEXT_BYTES {
            Some(ObservationGap::BudgetExceeded)
        } else {
            (disclosed.is_none() && path.is_none()).then_some(ObservationGap::EnvironmentWithheld)
        };
        result.push(EnvironmentObservation {
            name: name.into(),
            present: true,
            content_fingerprint: fingerprint,
            value: disclosed,
            path,
            gap,
        });
    }
    result.sort_by(|a, b| a.name.cmp(&b.name));
    result
}

pub(crate) fn safe_env_value(name: &str, value: &str) -> bool {
    let semantic = matches!(
        name,
        "CARGO_PKG_NAME"
            | "CARGO_PKG_VERSION"
            | "PROFILE"
            | "OPT_LEVEL"
            | "DEBUG"
            | "HOST"
            | "TARGET"
            | "NUM_JOBS"
            | "RUSTUP_TOOLCHAIN"
            | "CARGO_CFG_TARGET_ARCH"
            | "CARGO_CFG_TARGET_ENDIAN"
            | "CARGO_CFG_TARGET_ENV"
            | "CARGO_CFG_TARGET_FAMILY"
            | "CARGO_CFG_TARGET_FEATURE"
            | "CARGO_CFG_TARGET_HAS_ATOMIC"
            | "CARGO_CFG_TARGET_OS"
            | "CARGO_CFG_TARGET_POINTER_WIDTH"
            | "CARGO_CFG_TARGET_VENDOR"
            | "CARGO_CFG_DEBUG_ASSERTIONS"
            | "CARGO_CFG_PANIC"
    );
    (semantic && value.len() <= 256 && (value.is_empty() || value.split(',').all(identifier)))
        || (name.starts_with("CARGO_FEATURE_") && value == "1")
}

fn resolve_program(program: &str) -> Option<PathBuf> {
    let path = Path::new(program);
    if path.components().count() > 1 {
        return fs::canonicalize(path).ok();
    }
    std::env::split_paths(&std::env::var_os("PATH")?).find_map(|dir| {
        let candidate = dir.join(path);
        let metadata = fs::metadata(&candidate).ok()?;
        if !metadata.is_file() {
            return None;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if metadata.mode() & 0o111 == 0 {
                return None;
            }
        }
        fs::canonicalize(candidate).ok()
    })
}

/// One monotonic deadline covers exit, bounded nonblocking drain, cancellation
/// and reap. The leader is not reaped until its exact new group is signalled,
/// so a recycled PID/group can never receive cleanup signals.
#[cfg(target_os = "linux")]
fn query(program: &Path, args: &[&str]) -> Option<String> {
    use std::os::unix::process::CommandExt;
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    let work_deadline = deadline - Duration::from_secs(1);
    let mut child = Command::new(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .ok()?;
    let pid = child.id();
    let mut pipe = child.stdout.take()?;
    if linux_owned::nonblocking(&pipe).is_err() {
        let _ = linux_owned::signal_group(pid, 9);
        while std::time::Instant::now() < deadline {
            if child.try_wait().ok().flatten().is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        return None;
    }
    let mut output = QueryOutput::default();
    let mut eof = false;
    let mut cancelled = false;
    let mut status = None;
    while std::time::Instant::now() < deadline {
        if !eof {
            let mut buffer = [0u8; 1024];
            match pipe.read(&mut buffer) {
                Ok(0) => eof = true,
                Ok(count) => output.retain(&buffer[..count]),
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(_) => {
                    eof = true;
                    output.unavailable = true;
                }
            }
        }
        // Linux proc state inspection does not reap: the zombie leader keeps
        // this newly created group identity reserved until cancellation.
        let mut state = String::new();
        let exited = File::open(format!("/proc/{pid}/stat"))
            .ok()
            .and_then(|file| file.take(4096).read_to_string(&mut state).ok())
            .map(|_| state)
            .and_then(|text| {
                text.rsplit_once(") ")
                    .map(|(_, tail)| tail.starts_with('Z'))
            })
            .unwrap_or(false);
        if !cancelled
            && (exited || output.unavailable || std::time::Instant::now() >= work_deadline)
        {
            cancelled = true;
            let _ = linux_owned::signal_group(pid, 9);
        }
        if cancelled {
            if status.is_none() {
                if let Ok(Some(found)) = child.try_wait() {
                    status = Some(found);
                }
            }
            if status.is_some() && eof {
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    // Never signal after try_wait reaps. This non-mutating check can only make
    // qualification more conservative if the old group number was recycled.
    let group_absent =
        linux_owned::signal_group(pid, 0).is_err_and(|e| e.raw_os_error() == Some(3));
    if !eof || !group_absent || output.unavailable || !status?.success() {
        return None;
    }
    String::from_utf8(output.bytes).ok()
}

#[cfg(not(target_os = "linux"))]
fn query(_: &Path, _: &[&str]) -> Option<String> {
    None
}

fn tool_identity(program: &str, roots: &[RootBinding], budget: &mut u64) -> ToolObservation {
    let mut result = ToolObservation {
        executable: None,
        verbose_identity: BTreeMap::new(),
        gaps: vec![],
    };
    let Some(path) = resolve_program(program) else {
        result
            .gaps
            .push(ObservationGap::CompilerIdentityUnavailable);
        return result;
    };
    result.executable = Some(file_observation(
        &path,
        FileRole::Compiler,
        true,
        &roots,
        budget,
    ));
    if let Some(text) = query(Path::new(program), &["-vV"]) {
        for line in text.lines() {
            if let Some((key, value)) = line.split_once(": ")
                && matches!(
                    key,
                    "release" | "commit-hash" | "commit-date" | "host" | "LLVM version"
                )
                && value.len() <= 256
                && value
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || " ._+-".contains(c))
            {
                result.verbose_identity.insert(key.into(), value.into());
            }
        }
    }
    if result.verbose_identity.is_empty() {
        result
            .gaps
            .push(ObservationGap::CompilerIdentityUnavailable);
        result.gaps.push(ObservationGap::QueryCleanupUnavailable);
    }
    result
}

fn create_wrapper_entry(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        // A symlink keeps the existing executable bytes and permissions. It is
        // private routing state, not an approved root or a file observation.
        std::os::unix::fs::symlink(std::env::current_exe()?, path)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "compiler wrapper entrypoint unavailable",
        ))
    }
}

fn is_wrapper_entry(program: &std::ffi::OsStr, config: &std::ffi::OsStr) -> bool {
    // Cargo executes the dedicated absolute entrypoint installed for this run.
    // Inherited env alone never changes the original CLI's dispatch. Avoid
    // canonicalization: it would collapse this alias back to the CLI binary.
    let Some(parent) = Path::new(config).parent() else {
        return false;
    };
    Path::new(program) == parent.join(WRAPPER_ENTRY)
}

pub fn is_wrapper(args: &[OsString]) -> bool {
    std::env::var_os(CONFIG_ENV).is_some_and(|config| {
        args.first()
            .is_some_and(|program| is_wrapper_entry(program, &config))
    })
}

// Recognizing an observer-supported shape never decides whether to execute.
// Other compiler names remain explicitly unknown while delegation stays exact.
fn wrapper_compiler_index(command: &[OsString]) -> Option<usize> {
    if command
        .first()
        .and_then(|arg| arg.to_str())
        .is_some_and(|arg| {
            arg.starts_with('-')
                || matches!(
                    arg,
                    "build"
                        | "watch"
                        | "update"
                        | "find"
                        | "refs"
                        | "context"
                        | "view"
                        | "serve"
                        | "build-graph"
                        | "help"
                )
        })
    {
        return None;
    }
    command.iter().take(2).position(|arg| {
        Path::new(arg)
            .file_stem()
            .is_some_and(|name| name == "rustc")
    })
}

/// Delegation uses the original OsString vector, never the normalized export.
/// Failed observation is reported as a gap; it never substitutes a compiler.
pub fn wrapper(args: &[OsString]) -> i32 {
    let Some(program) = args.first() else {
        return 1;
    };
    let config = std::env::var_os(CONFIG_ENV)
        .and_then(|path| bounded_read(Path::new(&path), MAX_ATTACHMENT_BYTES as u64).ok())
        .and_then(|bytes| serde_json::from_slice::<Config>(&bytes).ok());
    // This heuristic affects observation only. Cargo is allowed to supply any
    // compiler executable name and an optional workspace wrapper; dispatch and
    // delegation already selected the dedicated entrypoint independently.
    let capture = config.as_ref().and_then(|config| {
        if let Some(compiler_index) = wrapper_compiler_index(args) {
            prepare(
                config,
                args,
                compiler_index,
                args.get(compiler_index + 1..).unwrap_or_default(),
            )
        } else {
            let _ = exclusive_write(
                &config.directory.join("compiler-unrecognized"),
                b"compiler observation unavailable",
            );
            None
        }
    });
    let request = config.as_ref().zip(capture.as_ref()).and_then(
        |(config, (invocation, roots, files, _, slot))| {
            callback_request(config, invocation, roots, files, *slot).ok()
        },
    );
    let mut command = Command::new(program);
    command
        .args(&args[1..])
        .env_remove("BG_DRIVER_OCCURRENCE_REQUEST");
    if let Some((path, _)) = &request {
        command.env("BG_DRIVER_OCCURRENCE_REQUEST", path);
    }
    let status = command.status();
    let code = status.as_ref().ok().and_then(|status| status.code());
    if let (Some(config), Some((mut invocation, roots, files, outputs, slot))) =
        (config.as_ref(), capture)
    {
        invocation.exit_code = code;
        invocation.success = status.as_ref().is_ok_and(|status| status.success());
        let mut budget = UNIT_READ_BYTES;
        if let Some(driver) = invocation.occurrence_driver.as_mut() {
            let after = file_observation(
                Path::new(program),
                FileRole::Compiler,
                false,
                &roots,
                &mut budget,
            );
            driver.after = after.after;
            driver.gaps.extend(after.gaps);
            if driver.before != driver.after {
                driver.gaps.push(ObservationGap::UnstableFile);
            }
        }
        for (path, role) in files {
            let after = file_observation(&path, role, false, &roots, &mut budget);
            if let Some(before) = invocation
                .inputs
                .iter_mut()
                .find(|before| before.path == after.path && before.role == after.role)
            {
                before.after = after.after;
                before.gaps.extend(after.gaps);
                if before.before != before.after {
                    before.gaps.push(ObservationGap::UnstableFile);
                }
            }
        }
        let mut dep_seen = false;
        for path in &outputs {
            if !path.exists() {
                continue;
            }
            invocation.outputs.push(file_observation(
                path,
                FileRole::Output,
                false,
                &roots,
                &mut budget,
            ));
            if path.extension().is_some_and(|ext| ext == "d") {
                let dep_info =
                    file_observation(path, FileRole::DepInfo, false, &roots, &mut budget);
                dep_seen |= dep_info.after.is_some();
                invocation.inputs.push(dep_info);
                match observed_bytes(path, &roots, FILE_BYTES, &mut budget) {
                    Ok((_, raw, _)) => {
                        if let Ok(text) = String::from_utf8(raw) {
                            let (paths, limited) = dep_inputs(&text);
                            if limited {
                                note_truncation(
                                    &mut invocation.truncations,
                                    "dep_info_membership",
                                    (MAX_FILES + 1) as u64,
                                    MAX_FILES,
                                    false,
                                );
                            }
                            for path in paths.into_iter().take(MAX_FILES) {
                                let path = PathBuf::from(path);
                                if invocation
                                    .inputs
                                    .iter()
                                    .any(|input| input.path == normalized(&path, &roots))
                                {
                                    continue;
                                }
                                let mut input = file_observation(
                                    &path,
                                    FileRole::Source,
                                    false,
                                    &roots,
                                    &mut budget,
                                );
                                input.gaps.push(ObservationGap::InputObservedOnlyAfter);
                                invocation.inputs.push(input);
                            }
                            if text.lines().any(|line| line.starts_with("# env-dep:")) {
                                invocation.gaps.push(ObservationGap::EnvironmentWithheld);
                            }
                        } else {
                            invocation.gaps.push(ObservationGap::NonUtf8);
                        }
                    }
                    Err(gap) => invocation.gaps.push(gap),
                }
            }
        }
        if !dep_seen {
            invocation.gaps.push(ObservationGap::MissingDepInfo);
        }
        note_truncation(
            &mut invocation.truncations,
            "post_compile_inputs",
            invocation.inputs.len() as u64,
            invocation.inputs.len().min(MAX_FILES),
            true,
        );
        note_truncation(
            &mut invocation.truncations,
            "compiler_outputs",
            invocation.outputs.len() as u64,
            invocation.outputs.len().min(MAX_FILES),
            true,
        );
        if !invocation.truncations.is_empty() {
            invocation.gaps.push(ObservationGap::BudgetExceeded);
        }
        invocation.inputs.truncate(MAX_FILES);
        invocation.outputs.truncate(MAX_FILES);
        if config.occurrences {
            match request
                .as_ref()
                .and_then(|(_, request)| read_callback(request, &invocation, &roots).ok())
            {
                Some(value) => {
                    eprintln!(
                        "[build-graph] occurrences: accepted {} definitions, {} references",
                        value.definitions.len(),
                        value.references.len()
                    );
                    invocation.occurrences = Some(value);
                }
                None => {
                    eprintln!("[build-graph] occurrences: callback unavailable or rejected");
                    invocation.gaps.push(if request.is_some() {
                        ObservationGap::OccurrenceCallbackRejected
                    } else {
                        ObservationGap::OccurrenceCallbackUnavailable
                    });
                }
            }
            if bounded_json_size(&invocation, MAX_INVOCATION_BYTES).is_err() {
                invocation.occurrences = None;
                invocation.gaps.push(ObservationGap::BudgetExceeded);
            }
        }
        invocation.gaps.sort();
        invocation.gaps.dedup();
        let _ = invocation.bind_unit_key();
        if invocation.occurrences.is_some()
            && bounded_json_size(&invocation, MAX_INVOCATION_BYTES).is_err()
        {
            invocation.occurrences = None;
            invocation.gaps.push(ObservationGap::BudgetExceeded);
            invocation.gaps.sort();
            invocation.gaps.dedup();
        }
        if bounded_json_size(&invocation, MAX_INVOCATION_BYTES).is_ok()
            && let Ok(bytes) = serde_json::to_vec(&invocation)
        {
            let path = config.directory.join(format!("unit-{slot}.json"));
            if exclusive_write(&path, &bytes).is_err() {
                let _ = exclusive_write(
                    &config.directory.join("observation-failed"),
                    b"write failed",
                );
            }
        } else {
            mark_budget(
                config,
                "invocation_serialization",
                (MAX_INVOCATION_BYTES + 1) as u64,
                0,
                false,
            );
        }
    }
    code.unwrap_or(1)
}

type Prepared = (
    CompilerInvocation,
    Vec<RootBinding>,
    Vec<(PathBuf, FileRole)>,
    Vec<PathBuf>,
    usize,
);

fn callback_request(
    config: &Config,
    invocation: &CompilerInvocation,
    roots: &[RootBinding],
    files: &[(PathBuf, FileRole)],
    slot: usize,
) -> Result<(PathBuf, CallbackRequest)> {
    if !config.occurrences {
        bail!("callback not requested");
    }
    let source = fs::canonicalize(
        files
            .iter()
            .find(|(_, role)| *role == FileRole::Source)
            .context("callback source unavailable")?
            .0
            .clone(),
    )?;
    let source_root = roots
        .iter()
        .find(|r| r.kind == InputRoot::Source)
        .context("callback source root unavailable")?
        .path
        .clone();
    let target_root = roots
        .iter()
        .find(|r| r.kind == InputRoot::Target)
        .context("callback target root unavailable")?
        .path
        .clone();
    let nonce = format!(
        "{}-{slot}-{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos()
    );
    let request = CallbackRequest {
        schema_version: compiler_occurrence::OCCURRENCES_VERSION,
        nonce,
        command_fingerprint: content_fingerprint(&serde_json::to_vec(&invocation.command)?),
        crate_name: invocation.unit.crate_name.clone(),
        metadata: invocation.unit.metadata.clone(),
        source,
        source_root,
        target_root,
        output: config.directory.join(format!("occurrences-{slot}.json")),
    };
    if request.output.exists() {
        bail!("callback output already exists");
    }
    let path = config.directory.join(format!("callback-{slot}.json"));
    bounded_json_size(&request, MAX_INVOCATION_BYTES)
        .map_err(|_| anyhow::anyhow!("callback request exceeds budget"))?;
    exclusive_write(&path, &serde_json::to_vec(&request)?)?;
    Ok((path, request))
}

fn read_callback(
    request: &CallbackRequest,
    invocation: &CompilerInvocation,
    roots: &[RootBinding],
) -> Result<CompilerOccurrencesV1> {
    if !invocation.success || invocation.exit_code != Some(0) {
        bail!("callback compiler failed");
    }
    let mut output_budget = compiler_occurrence::MAX_OCCURRENCE_BYTES as u64;
    let (_, raw, metadata) = observed_bytes(
        &request.output,
        roots,
        compiler_occurrence::MAX_OCCURRENCE_BYTES as u64,
        &mut output_budget,
    )
    .map_err(|_| anyhow::anyhow!("callback output unavailable"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let parent = fs::symlink_metadata(
            request
                .output
                .parent()
                .context("callback parent unavailable")?,
        )?;
        if metadata.mode() & 0o777 != 0o600
            || metadata.nlink() != 1
            || metadata.uid() != parent.uid()
        {
            bail!("callback output ownership changed");
        }
    }
    let value = CompilerOccurrencesV1::from_json(&raw)
        .map_err(|_| anyhow::anyhow!("malformed callback output"))?;
    if value.nonce != request.nonce
        || value.command_fingerprint != request.command_fingerprint
        || value.command_fingerprint
            != content_fingerprint(&serde_json::to_vec(&invocation.command)?)
        || value.crate_name != invocation.unit.crate_name
        || value.metadata != invocation.unit.metadata
    {
        bail!("callback invocation changed");
    }
    let mut checked = BTreeSet::new();
    let mut budget = compiler_occurrence::MAX_SOURCE_TOTAL_BYTES as u64;
    for definition in &value.definitions {
        let input = &definition.input;
        if !checked.insert(input) {
            continue;
        }
        let (kind, base) = match input.root {
            OccurrenceRoot::Source => (InputRoot::Source, &request.source_root),
            OccurrenceRoot::Target => (InputRoot::Target, &request.target_root),
        };
        let (portable, bytes, _) =
            observed_bytes(&base.join(&input.relative), roots, FILE_BYTES, &mut budget)
                .map_err(|_| anyhow::anyhow!("callback source unavailable"))?;
        if portable.root != kind
            || portable.relative != input.relative
            || bytes.len() as u64 != input.bytes
            || content_fingerprint(&bytes) != input.content_fingerprint
        {
            bail!("callback source buffer changed");
        }
    }
    Ok(value)
}

fn prepare(
    config: &Config,
    command: &[OsString],
    compiler_index: usize,
    args: &[OsString],
) -> Option<Prepared> {
    if command.len() > MAX_ARGUMENTS {
        mark_budget(config, "command_arguments", command.len() as u64, 0, true);
        return None;
    }
    if let Some(size) = command
        .iter()
        .map(|arg| arg.as_encoded_bytes().len())
        .find(|size| *size > MAX_TEXT_BYTES)
    {
        mark_budget(config, "argument_text_bytes", size as u64, 0, true);
        return None;
    }
    let text: Vec<_> = args.iter().map(|arg| arg.to_str()).collect();
    let Some(crate_name) = option(&text, "--crate-name") else {
        if text.iter().flatten().any(|arg| arg.starts_with('@')) {
            let _ = exclusive_write(
                &config.directory.join("observation-failed"),
                b"response file cannot bind unit",
            );
        }
        return None;
    };
    if !identifier(crate_name) {
        return None;
    }
    let mut slot = None;
    for index in 0..MAX_INVOCATIONS {
        match exclusive_write(&config.directory.join(format!("slot-{index}")), b"") {
            Ok(()) => {
                slot = Some(index);
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => {
                let _ = exclusive_write(
                    &config.directory.join("observation-failed"),
                    b"slot write unavailable",
                );
                return None;
            }
        }
    }
    let Some(slot) = slot else {
        mark_budget(
            config,
            "compiler_slots",
            (MAX_INVOCATIONS + 1) as u64,
            MAX_INVOCATIONS,
            false,
        );
        return None;
    };
    let mut roots = config.roots.clone();
    let program = command.get(compiler_index)?.to_str()?;
    resolve_program(program)?;
    let sysroot_path = option(&text, "--sysroot").map(PathBuf::from).or_else(|| {
        query(Path::new(program), &["--print", "sysroot"]).map(|text| PathBuf::from(text.trim()))
    });
    if let Some(path) = sysroot_path.as_ref().and_then(|p| fs::canonicalize(p).ok()) {
        if let Ok(root) = RootBinding::new(InputRoot::Sysroot, &path) {
            roots.push(root);
        }
    }
    let source = text
        .iter()
        .flatten()
        .find(|arg| !arg.starts_with('-') && arg.ends_with(".rs"))
        .map(|path| PathBuf::from(*path));
    let mut files: Vec<_> = source
        .clone()
        .into_iter()
        .map(|path| (path, FileRole::Source))
        .collect();
    for value in argument_values(&text, "--extern") {
        if let Some((_, path)) = value.split_once('=') {
            let path = PathBuf::from(path);
            let role = if path
                .extension()
                .is_some_and(|ext| ext == "so" || ext == "dylib" || ext == "dll")
            {
                FileRole::ProcMacro
            } else {
                FileRole::External
            };
            files.push((path, role));
        }
    }
    for argument in text
        .iter()
        .flatten()
        .filter_map(|arg| arg.strip_prefix('@'))
    {
        files.push((PathBuf::from(argument), FileRole::Configuration));
    }
    let mut outputs = Vec::new();
    if let Some(output) = option(&text, "-o") {
        outputs.push(PathBuf::from(output));
    }
    let extra = codegen(&text, "extra-filename").unwrap_or("");
    if let Some(directory) = option(&text, "--out-dir") {
        let stem = format!("{crate_name}{extra}");
        // Exact compiler unit name, not newest dep-info for a crate. Membership
        // is observed after this actual process; no artifact freshness inferred.
        for prefix in [&stem, &format!("lib{stem}")] {
            for suffix in [".d", ".rlib", ".rmeta", ".so", ".dylib", ".dll", ".exe", ""] {
                let path = Path::new(directory).join(format!("{prefix}{suffix}"));
                outputs.push(path);
            }
        }
    }
    if let Some(emit) = option(&text, "--emit") {
        for output in emit
            .split(',')
            .filter_map(|value| value.split_once('=').map(|(_, path)| path))
        {
            outputs.push(PathBuf::from(output));
        }
    }
    outputs.sort();
    outputs.dedup();
    let mut budget = UNIT_READ_BYTES;
    let mut truncations = vec![];
    note_truncation(
        &mut truncations,
        "pre_compile_inputs",
        files.len() as u64,
        files.len().min(MAX_FILES),
        true,
    );
    let inputs = files
        .iter()
        .take(MAX_FILES)
        .map(|(path, role)| file_observation(path, *role, true, &roots, &mut budget))
        .collect();
    let mut config_files = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        note_truncation(
            &mut truncations,
            "configuration_ancestors",
            cwd.ancestors().count() as u64,
            cwd.ancestors().count().min(64),
            true,
        );
        for parent in cwd.ancestors().take(64) {
            for name in [".cargo/config", ".cargo/config.toml"] {
                let path = parent.join(name);
                if path.exists() {
                    config_files.push(file_observation(
                        &path,
                        FileRole::Configuration,
                        true,
                        &roots,
                        &mut budget,
                    ));
                }
            }
        }
    }
    if let Some(root) = roots.iter().find(|r| r.kind == InputRoot::CargoConfig) {
        for name in ["config", "config.toml"] {
            let path = root.path.join(name);
            if path.exists() {
                config_files.push(file_observation(
                    &path,
                    FileRole::Configuration,
                    true,
                    &roots,
                    &mut budget,
                ));
            }
        }
    }
    note_truncation(
        &mut truncations,
        "cargo_configuration_files",
        config_files.len() as u64,
        config_files.len().min(MAX_FILES),
        true,
    );
    config_files.truncate(MAX_FILES);
    let environment = environment(&roots, "compiler_environment", &mut truncations);
    let normalized_command = normalize_command(command, &roots);
    let compiler_identity = tool_identity(program, &roots, &mut budget);
    let target_triple = option(&text, "--target")
        .filter(|s| identifier(s))
        .map(str::to_owned)
        .or_else(|| compiler_identity.verbose_identity.get("host").cloned());
    let mut invocation = CompilerInvocation {
        unit_key: String::new(),
        unit: CompilerUnit {
            crate_name: crate_name.into(),
            metadata: codegen(&text, "metadata")
                .filter(|s| identifier(s))
                .map(str::to_owned),
            source: source.as_ref().and_then(|p| normalized(p, &roots)),
            target_triple,
            cargo: None,
        },
        command: normalized_command,
        cwd: std::env::current_dir()
            .ok()
            .and_then(|p| normalized(&p, &roots)),
        compiler: compiler_identity,
        sysroot: sysroot_path.as_ref().and_then(|p| normalized(p, &roots)),
        environment,
        config_files,
        inputs,
        outputs: vec![],
        exit_code: None,
        success: false,
        gaps: vec![
            ObservationGap::SysrootTreeNotObserved,
            ObservationGap::UnobservedExecutionInputs,
            ObservationGap::ConfigurationResolutionUnknown,
        ]
        .into_iter()
        .chain((!truncations.is_empty()).then_some(ObservationGap::BudgetExceeded))
        .collect(),
        truncations,
        occurrences: None,
        occurrence_driver: config.occurrences.then(|| {
            file_observation(
                Path::new(&command[0]),
                FileRole::Compiler,
                true,
                &roots,
                &mut budget,
            )
        }),
    };
    if text.iter().flatten().any(|arg| arg.starts_with('@')) {
        invocation
            .gaps
            .push(ObservationGap::ResponseFileNotExpanded);
    }
    invocation
        .gaps
        .push(ObservationGap::OutputMembershipUnknown);
    Some((invocation, roots, files, outputs, slot))
}

fn option<'a>(args: &[Option<&'a str>], key: &str) -> Option<&'a str> {
    args.iter().enumerate().find_map(|(index, arg)| match arg {
        Some(value) if *value == key => args.get(index + 1).copied().flatten(),
        Some(value) => value
            .strip_prefix(key)
            .and_then(|value| value.strip_prefix('=')),
        None => None,
    })
}

fn argument_values<'a>(args: &[Option<&'a str>], key: &str) -> Vec<&'a str> {
    args.iter()
        .enumerate()
        .filter_map(|(index, arg)| match arg {
            Some(value) if *value == key => args.get(index + 1).copied().flatten(),
            Some(value) => value
                .strip_prefix(key)
                .and_then(|value| value.strip_prefix('=')),
            None => None,
        })
        .collect()
}

fn codegen<'a>(args: &[Option<&'a str>], key: &str) -> Option<&'a str> {
    args.iter().enumerate().find_map(|(index, arg)| {
        let value = match arg {
            Some("-C") => args.get(index + 1).copied().flatten(),
            Some(arg) => arg.strip_prefix("-C"),
            None => None,
        }?;
        value.strip_prefix(key)?.strip_prefix('=')
    })
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_-+.".contains(c))
}

fn token(value: &str) -> InvocationArgument {
    InvocationArgument {
        token: Some(value.into()),
        path: None,
        path_prefix: None,
        gap: None,
    }
}

fn hidden() -> InvocationArgument {
    InvocationArgument {
        token: None,
        path: None,
        path_prefix: None,
        gap: Some(ObservationGap::ArgumentWithheld),
    }
}

fn path_argument(path: &str, prefix: Option<String>, roots: &[RootBinding]) -> InvocationArgument {
    let path = normalized(Path::new(path), roots);
    let gap = path.is_none().then_some(ObservationGap::PathOutsideRoots);
    InvocationArgument {
        token: None,
        path,
        path_prefix: prefix,
        gap,
    }
}

fn safe_cfg(value: &str) -> bool {
    identifier(value)
        || value
            .strip_prefix("feature=\"")
            .and_then(|v| v.strip_suffix('"'))
            .is_some_and(identifier)
}

fn safe_check_cfg(value: &str) -> bool {
    if matches!(value, "cfg(docsrs,test)" | "cfg(docsrs)" | "cfg(test)") {
        return true;
    }
    value
        .strip_prefix("cfg(feature, values(")
        .and_then(|v| v.strip_suffix("))"))
        .is_some_and(|values| {
            values.is_empty()
                || values.split(',').all(|value| {
                    value
                        .trim()
                        .strip_prefix('"')
                        .and_then(|v| v.strip_suffix('"'))
                        .is_some_and(identifier)
                })
        })
}

/// Positive allowlist. Unknown flags/values and arbitrary --cfg values are not
/// copied into a graph export, even if they happen to look like normal text.
fn normalize_command(args: &[OsString], roots: &[RootBinding]) -> Vec<InvocationArgument> {
    let mut result = Vec::new();
    let mut previous = "";
    if args.len() > MAX_ARGUMENTS {
        return vec![InvocationArgument {
            token: None,
            path: None,
            path_prefix: None,
            gap: Some(ObservationGap::BudgetExceeded),
        }];
    }
    for (index, argument) in args.iter().enumerate() {
        let Some(value) = argument.to_str().filter(|v| v.len() <= MAX_TEXT_BYTES) else {
            result.push(hidden());
            previous = "";
            continue;
        };
        let observed = if index == 0
            || (index == 1 && Path::new(value).file_stem().is_some_and(|s| s == "rustc"))
        {
            resolve_program(value)
                .and_then(|p| p.to_str().map(str::to_owned))
                .map(|p| {
                    let basename = Path::new(value)
                        .file_name()
                        .and_then(|s| s.to_str())
                        .filter(|s| identifier(s));
                    path_argument(&p, basename.map(|name| format!("argv0={name}")), roots)
                })
                .unwrap_or_else(hidden)
        } else if matches!(previous, "--out-dir" | "--sysroot" | "-o") {
            path_argument(value, None, roots)
        } else if previous == "--extern" {
            value
                .split_once('=')
                .filter(|(name, _)| identifier(name))
                .map(|(name, path)| path_argument(path, Some(format!("{name}=")), roots))
                .unwrap_or_else(hidden)
        } else if previous == "-L" || value.starts_with("-L") {
            let value = if previous == "-L" { value } else { &value[2..] };
            let (prefix, path) = value.split_once('=').unwrap_or(("", value));
            if prefix.is_empty()
                || matches!(
                    prefix,
                    "dependency" | "native" | "crate" | "framework" | "all"
                )
            {
                path_argument(
                    path,
                    Some(if previous == "-L" {
                        format!("{prefix}=")
                    } else {
                        format!("-L{prefix}=")
                    }),
                    roots,
                )
            } else {
                hidden()
            }
        } else if previous == "--cfg" {
            if safe_cfg(value) {
                token(value)
            } else {
                hidden()
            }
        } else if previous == "--check-cfg" {
            if safe_check_cfg(value) {
                token(value)
            } else {
                hidden()
            }
        } else if previous == "-C" || value.starts_with("-C") {
            let prefix = if previous == "-C" { "" } else { "-C" };
            let value = value.strip_prefix(prefix).unwrap_or(value);
            if let Some((key, setting)) = value.split_once('=') {
                if key == "incremental" {
                    path_argument(setting, Some(format!("{prefix}{key}=")), roots)
                } else if matches!(
                    key,
                    "metadata"
                        | "extra-filename"
                        | "opt-level"
                        | "debuginfo"
                        | "debug-assertions"
                        | "overflow-checks"
                        | "codegen-units"
                        | "panic"
                        | "embed-bitcode"
                        | "strip"
                ) && identifier(setting)
                {
                    token(&format!("{prefix}{value}"))
                } else {
                    hidden()
                }
            } else {
                hidden()
            }
        } else if matches!(
            value,
            "--crate-name"
                | "--crate-type"
                | "--edition"
                | "--emit"
                | "--target"
                | "--sysroot"
                | "--out-dir"
                | "--extern"
                | "--cfg"
                | "--cap-lints"
                | "--error-format"
                | "--json"
                | "--color"
                | "-C"
                | "-L"
                | "-o"
                | "--test"
                | "--check-cfg"
        ) {
            token(value)
        } else if matches!(
            previous,
            "--crate-name"
                | "--crate-type"
                | "--edition"
                | "--target"
                | "--cap-lints"
                | "--error-format"
                | "--json"
                | "--color"
                | "--emit"
        ) && value.split(',').all(identifier)
        {
            token(value)
        } else if let Some(path) = value.strip_prefix('@') {
            path_argument(path, Some("@".into()), roots)
        } else if !previous.starts_with('-') && value.ends_with(".rs") && Path::new(value).is_file()
        {
            path_argument(value, None, roots)
        } else {
            hidden()
        };
        result.push(observed);
        previous = value;
    }
    result
}

pub(crate) fn normalize_cargo_command(
    args: &[OsString],
    roots: &[RootBinding],
) -> Vec<InvocationArgument> {
    let mut result = normalize_command(args, roots);
    let mut previous = "";
    for (index, arg) in args.iter().enumerate() {
        let Some(value) = arg.to_str().filter(|v| v.len() <= MAX_TEXT_BYTES) else {
            previous = "";
            continue;
        };
        if index != 0 {
            result[index] = if matches!(
                value,
                "build"
                    | "metadata"
                    | "doc"
                    | "--format-version"
                    | "--lib"
                    | "--no-deps"
                    | "--keep-going"
                    | "--release"
                    | "--locked"
                    | "--offline"
                    | "--frozen"
                    | "--workspace"
                    | "--all-features"
                    | "--no-default-features"
                    | "--manifest-path"
                    | "--target-dir"
                    | "--target"
                    | "--profile"
                    | "--features"
                    | "-p"
                    | "--package"
            ) || value == "--message-format=json-render-diagnostics"
            {
                token(value)
            } else if matches!(previous, "--manifest-path" | "--target-dir") {
                path_argument(value, None, roots)
            } else if matches!(
                previous,
                "--features" | "-p" | "--package" | "--target" | "--profile" | "--format-version"
            ) && value.split(',').all(identifier)
            {
                token(value)
            } else {
                hidden()
            };
        }
        previous = value;
    }
    result
}

/// Make-style escaping, continuations and multiple rules are handled without
/// exposing dep-info env-dep values. This records membership, not coverage.
fn dep_inputs(text: &str) -> (BTreeSet<String>, bool) {
    let text = text.replace("\\\n", "");
    let mut files = BTreeSet::new();
    for line in text.lines().filter(|line| !line.starts_with('#')) {
        let Some((_, dependencies)) = line.split_once(": ") else {
            continue;
        };
        let mut token = String::new();
        let mut escaped = false;
        for ch in dependencies.chars().chain(std::iter::once(' ')) {
            if escaped {
                token.push(ch);
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch.is_whitespace() {
                if !token.is_empty() {
                    files.insert(std::mem::take(&mut token));
                }
            } else {
                token.push(ch);
            }
            if files.len() > MAX_FILES || token.len() > MAX_TEXT_BYTES {
                return (files, true);
            }
        }
    }
    (files, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::Workspace;
    use serde_json::json;

    fn invocation() -> CompilerInvocation {
        let mut value: CompilerInvocation = serde_json::from_value(json!({
            "unit_key":"", "unit":{"crate_name":"demo_lib", "metadata":"abc", "source":{"root":"source", "relative":"demo/src/lib.rs"}, "target_triple":"x86_64-unknown-linux-gnu", "cargo":null},
            "command":[{"token":"--crate-name","path":null,"path_prefix":null,"gap":null},{"token":"demo_lib","path":null,"path_prefix":null,"gap":null}],
            "cwd":{"root":"source","relative":""}, "compiler":{"executable":null,"verbose_identity":{},"gaps":["compiler_identity_unavailable"]}, "sysroot":null,
            "environment":[], "config_files":[], "inputs":[], "outputs":[{"path":{"root":"target","relative":"debug/deps/libdemo_lib-abc.rlib"},"role":"output","before":null,"after":{"bytes":1,"mode":420,"content_fingerprint":"fnv1a64:0000000000000000"},"gaps":[]}],
            "exit_code":0,"success":true,"gaps":["unobserved_execution_inputs"],"truncations":[]
        })).expect("fixture invocation");
        value.bind_unit_key().expect("fixture key");
        value
    }

    fn session(workspace: &Workspace) -> Session {
        let directory = workspace
            .root
            .join("target/observer-fixture")
            .into_std_path_buf();
        fs::create_dir_all(&directory).expect("observer fixture directory");
        let roots = vec![
            RootBinding::new(InputRoot::Source, workspace.root.as_std_path()).expect("source root"),
            RootBinding::new(
                InputRoot::Target,
                workspace.root.join("target").as_std_path(),
            )
            .expect("target root"),
        ];
        Session {
            config: Config {
                directory: directory.clone(),
                roots,
                occurrences: false,
            },
            path: directory.join("config.json"),
            metadata: workspace.meta.clone(),
            artifacts: vec![],
            scripts: vec![],
            artifact_count: 0,
            script_count: 0,
            cargo_command: None,
            cargo_truncations: vec![],
            driver: None,
        }
    }

    fn callback_fixture() -> (
        Workspace,
        Session,
        CompilerInvocation,
        CallbackRequest,
        CompilerOccurrencesV1,
    ) {
        let workspace = Workspace::new(&[("demo", "demo")]);
        fs::write(
            workspace.root.join("demo/src/lib.rs"),
            b"pub fn source() {}",
        )
        .expect("source bytes");
        let mut session = session(&workspace);
        session.config.occurrences = true;
        let mut invocation = invocation();
        invocation.success = true;
        invocation.exit_code = Some(0);
        let files = vec![(
            workspace.root.join("demo/src/lib.rs").into_std_path_buf(),
            FileRole::Source,
        )];
        let (_, request) = callback_request(
            &session.config,
            &invocation,
            &session.config.roots,
            &files,
            0,
        )
        .expect("fresh callback request");
        let mut value = compiler_occurrence::tests::fixture();
        value.nonce = request.nonce.clone();
        value.command_fingerprint = request.command_fingerprint.clone();
        value.crate_name = request.crate_name.clone();
        value.metadata = request.metadata.clone();
        value.definitions[0].input.relative = "demo/src/lib.rs".into();
        exclusive_write(&request.output, &serde_json::to_vec(&value).expect("JSON"))
            .expect("callback output");
        (workspace, session, invocation, request, value)
    }

    #[test]
    fn fresh_callback_reader_accepts_exact_stable_source_and_success() {
        let (_workspace, session, invocation, request, value) = callback_fixture();
        assert_eq!(
            read_callback(&request, &invocation, &session.config.roots).expect("original reader"),
            value
        );
        assert!(
            callback_request(
                &session.config,
                &invocation,
                &session.config.roots,
                &[(request.source.clone(), FileRole::Source)],
                0
            )
            .is_err()
        );
    }
    #[test]
    fn callback_reader_rejects_stale_wrong_invocation_and_failed_compiler() {
        let (_workspace, session, mut invocation, mut request, _) = callback_fixture();
        request.nonce.push_str("-stale");
        assert!(read_callback(&request, &invocation, &session.config.roots).is_err());
        request.nonce.truncate(request.nonce.len() - 6);
        invocation.unit.crate_name.push_str("wrong");
        assert!(read_callback(&request, &invocation, &session.config.roots).is_err());
        invocation.unit.crate_name = request.crate_name.clone();
        invocation.success = false;
        assert!(read_callback(&request, &invocation, &session.config.roots).is_err());
    }
    #[test]
    fn callback_reader_rejects_changed_missing_and_oversized_buffers() {
        let (_workspace, session, invocation, request, _) = callback_fixture();
        fs::write(&request.source, b"pub fn other_() {}").expect("changed bytes");
        assert!(read_callback(&request, &invocation, &session.config.roots).is_err());
        fs::remove_file(&request.source).expect("missing source");
        assert!(read_callback(&request, &invocation, &session.config.roots).is_err());
        fs::write(
            &request.output,
            vec![b' '; compiler_occurrence::MAX_OCCURRENCE_BYTES + 1],
        )
        .expect("oversized proof");
        assert!(read_callback(&request, &invocation, &session.config.roots).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn callback_reader_rejects_linked_and_nonprivate_output() {
        use std::os::unix::fs::PermissionsExt;
        let (_workspace, session, invocation, request, _) = callback_fixture();
        fs::set_permissions(&request.output, fs::Permissions::from_mode(0o644)).expect("mode");
        assert!(read_callback(&request, &invocation, &session.config.roots).is_err());
        fs::set_permissions(&request.output, fs::Permissions::from_mode(0o600)).expect("mode");
        let alias = request.output.with_extension("alias");
        fs::hard_link(&request.output, &alias).expect("hardlink");
        assert!(read_callback(&request, &invocation, &session.config.roots).is_err());
        fs::remove_file(&request.output).expect("unlink");
        std::os::unix::fs::symlink(&alias, &request.output).expect("symlink");
        assert!(read_callback(&request, &invocation, &session.config.roots).is_err());
    }

    fn artifact(workspace: &Workspace, fresh: bool) -> Artifact {
        let package = &workspace.meta.packages[0];
        serde_json::from_value(json!({"package_id":package.id,"manifest_path":package.manifest_path,
            "target":package.targets[0],"profile":{"opt_level":"0","debuginfo":2,"debug_assertions":true,"overflow_checks":true,"test":false},
            "features":["selected"],"filenames":[workspace.root.join("target/debug/deps/libdemo_lib-abc.rlib")],"executable":null,"fresh":fresh})).expect("artifact fixture")
    }

    #[test]
    fn current_invocation_joins_exact_source_and_artifact_not_name_alone() {
        let workspace = Workspace::new(&[("demo", "demo_lib")]);
        let mut session = session(&workspace);
        exclusive_write(
            &session.config.directory.join("unit-0.json"),
            &serde_json::to_vec(&invocation()).expect("fixture JSON"),
        )
        .expect("unit witness");
        session.artifact(&artifact(&workspace, false));
        let result = session.finish();
        let bound = result.invocations[0]
            .unit
            .cargo
            .as_ref()
            .expect("actual source/artifact binding");
        assert_eq!(bound.package_name, "demo");
        assert_eq!(bound.features, ["selected"]);
        assert_eq!(
            bound.manifest.as_ref().expect("manifest").relative,
            "demo/Cargo.toml"
        );
        assert_eq!(bound.profile["opt_level"], "0");
        assert_eq!(bound.source, result.invocations[0].unit.source);
        session.artifacts[0].target.src_path = workspace.root.join("other.rs");
        assert!(session.finish().invocations[0].unit.cargo.is_none());
        session.artifacts[0] = artifact(&workspace, false);
        let mut unknown = invocation();
        unknown.unit.source = None;
        for output in &mut unknown.outputs {
            output.path = None;
        }
        unknown.bind_unit_key().expect("unknown key");
        fs::write(
            session.config.directory.join("unit-0.json"),
            serde_json::to_vec(&unknown).expect("unknown JSON"),
        )
        .expect("unknown witness");
        assert!(
            session.finish().invocations[0].unit.cargo.is_none(),
            "unknown paths cannot join by None equality"
        );
        fs::write(
            session.config.directory.join("unit-0.json"),
            serde_json::to_vec(&invocation()).expect("fixture JSON"),
        )
        .expect("restore witness");
        session.artifacts[0] = artifact(&workspace, true);
        let cached = session.finish();
        assert!(cached.invocations[0].unit.cargo.is_none());
        assert!(
            cached
                .gaps
                .contains(&ObservationGap::CachedArtifactNotInvoked)
        );
    }

    #[test]
    fn conflicting_and_dropped_cargo_candidates_never_bind_a_unit() {
        let workspace = Workspace::new(&[("demo", "demo_lib")]);
        let mut session = session(&workspace);
        exclusive_write(
            &session.config.directory.join("unit-0.json"),
            &serde_json::to_vec(&invocation()).expect("fixture JSON"),
        )
        .expect("unit witness");
        let artifact = artifact(&workspace, false);
        session.artifact(&artifact);
        session.artifact(&artifact);
        assert!(
            session.finish().invocations[0]
                .gaps
                .contains(&ObservationGap::ConflictingUnit)
        );
        for _ in 0..MAX_INVOCATIONS * 4 {
            session.artifact(&artifact);
        }
        let result = session.finish();
        assert!(result.gaps.contains(&ObservationGap::BudgetExceeded));
        assert!(result.invocations[0].unit.cargo.is_none());
        assert!(
            result
                .truncations
                .iter()
                .any(|t| t.collection == "cargo_artifacts"
                    && t.observed > t.retained
                    && t.count_exact)
        );
    }

    #[test]
    fn ordered_arguments_redact_secrets_unknown_cfg_and_host_paths() {
        let workspace = Workspace::new(&[("demo", "demo_lib")]);
        let root = RootBinding::new(InputRoot::Source, workspace.root.as_std_path()).expect("root");
        let source = workspace.root.join("demo/src/lib.rs");
        let args: Vec<OsString> = [
            "/bin/false",
            "--crate-name",
            "demo_lib",
            source.as_str(),
            "--cfg",
            "api_key=\"private-credential\"",
            "--unknown-secret",
            "/private/host-secret",
            "--cfg",
            "feature=\"selected\"",
        ]
        .iter()
        .map(OsString::from)
        .collect();
        let command = normalize_command(&args, &[root]);
        let raw = serde_json::to_string(&command).expect("command");
        assert_eq!(command.len(), args.len());
        assert!(raw.contains("selected"));
        assert!(
            !raw.contains("credential")
                && !raw.contains("host-secret")
                && !raw.contains(workspace.root.as_str())
        );
        assert!(command[5].gap.is_some());
        assert_eq!(
            command[3].path.as_ref().expect("source argument").relative,
            "demo/src/lib.rs"
        );
    }

    #[test]
    fn argument_tail_overflow_emits_gap_only_count_not_colliding_unit() {
        let workspace = Workspace::new(&[("demo", "demo_lib")]);
        let session = session(&workspace);
        let mut args = vec![OsString::from("/bin/false"); MAX_ARGUMENTS + 1];
        args[1] = "--crate-name".into();
        args[2] = "demo_lib".into();
        assert!(prepare(&session.config, &args, 0, &args[1..]).is_none());
        let result = session.finish();
        assert!(result.invocations.is_empty());
        assert!(result.gaps.contains(&ObservationGap::BudgetExceeded));
        let count = result
            .truncations
            .iter()
            .find(|t| t.collection == "command_arguments")
            .expect("actual argument count");
        assert_eq!(
            (count.observed, count.retained, count.count_exact),
            ((MAX_ARGUMENTS + 1) as u64, 0, true)
        );
    }

    #[test]
    fn dep_info_escaping_and_membership_caps_are_explicit() {
        let (paths, limited) = dep_inputs(
            "out: src/a\\ b.rs src/c.rs\\\n src/d.rs\n# env-dep:SECRET=private-credential\n",
        );
        assert!(!limited);
        assert!(paths.contains("src/a b.rs"));
        assert_eq!(paths.len(), 3);
        let many = format!(
            "out: {}",
            (0..MAX_FILES + 1)
                .map(|n| format!("src/{n}.rs"))
                .collect::<Vec<_>>()
                .join(" ")
        );
        assert!(dep_inputs(&many).1);
    }

    #[test]
    fn generator_output_and_script_caps_leave_precise_partial_witnesses() {
        let workspace = Workspace::new(&[("demo", "demo_lib")]);
        let mut session = session(&workspace);
        let out = workspace.root.join("target/generated");
        fs::create_dir_all(&out).expect("generated directory");
        for n in 0..MAX_FILES + 1 {
            fs::write(out.join(format!("{n}.txt")), "generated").expect("generated output");
        }
        let script: BuildScript = serde_json::from_value(json!({"package_id":workspace.meta.packages[0].id,"linked_libs":[],"linked_paths":[],"cfgs":[],"env":[],"out_dir":out})).expect("script fixture");
        for _ in 0..MAX_INVOCATIONS + 1 {
            session.build_script(&script);
        }
        let result = session.finish();
        assert!(result.gaps.contains(&ObservationGap::BudgetExceeded));
        assert_eq!(result.generators.len(), MAX_INVOCATIONS);
        assert!(result.generators[0].outputs.is_empty());
        assert!(
            result.generators[0]
                .gaps
                .contains(&ObservationGap::BudgetExceeded)
        );
        assert!(
            result.generators[0]
                .truncations
                .iter()
                .any(|t| t.collection == "generated_entries" && !t.count_exact)
        );
        assert!(result.generators[0].command.is_none());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn descriptor_bound_reads_reject_leaf_and_ancestor_replacements() {
        use std::os::unix::fs::symlink;
        let workspace = Workspace::new(&[("demo", "demo_lib")]);
        let root = RootBinding::new(InputRoot::Source, workspace.root.as_std_path()).expect("root");
        let file = workspace.root.join("demo/src/lib.rs");
        let mut budget = UNIT_READ_BYTES;
        let result = anchored_read(
            &root,
            Path::new("demo/src/lib.rs"),
            FILE_BYTES,
            &mut budget,
            || {
                fs::rename(&file, file.with_extension("old")).expect("replace leaf");
                symlink("/etc/passwd", &file).expect("outside symlink");
            },
        );
        assert!(result.is_err());
        fs::remove_file(&file).expect("remove alias");
        fs::write(&file, "original").expect("restore");
        let directory = workspace.root.join("demo/src");
        let result = anchored_read(
            &root,
            Path::new("demo/src/lib.rs"),
            FILE_BYTES,
            &mut budget,
            || {
                fs::rename(&directory, workspace.root.join("demo/held-src"))
                    .expect("move ancestor");
                fs::create_dir(&directory).expect("replace ancestor");
                fs::write(directory.join("lib.rs"), "outside replacement")
                    .expect("replacement file");
            },
        );
        assert!(result.is_err());
        let mut budget = UNIT_READ_BYTES;
        symlink("/etc/passwd", workspace.root.join("outside.rs")).expect("outside leaf");
        let observation = file_observation(
            workspace.root.join("outside.rs").as_std_path(),
            FileRole::Source,
            true,
            &[root],
            &mut budget,
        );
        assert!(observation.before.is_none());
        assert!(!observation.gaps.is_empty());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn file_bytes_modes_and_budget_are_observed_with_stable_descriptors() {
        let workspace = Workspace::new(&[("demo", "demo_lib")]);
        let root = RootBinding::new(InputRoot::Source, workspace.root.as_std_path()).expect("root");
        let file = workspace.root.join("demo/src/lib.rs");
        let mut budget = UNIT_READ_BYTES;
        let before = file_observation(
            file.as_std_path(),
            FileRole::Source,
            true,
            &[root.clone()],
            &mut budget,
        );
        assert!(before.before.is_some());
        fs::write(&file, "changed source").expect("change source");
        let after = file_observation(
            file.as_std_path(),
            FileRole::Source,
            false,
            &[root.clone()],
            &mut budget,
        );
        assert_ne!(before.before, after.after);
        let denied = file_observation(file.as_std_path(), FileRole::Source, true, &[root], &mut 0);
        assert!(denied.gaps.contains(&ObservationGap::BudgetExceeded));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn query_deadline_covers_closed_stdout_overflow_and_descendant_pipe() {
        for source in [
            "exec 1>&-; sleep 30",
            "head -c 1048576 /dev/zero; sleep 30",
            "sleep 30 & printf 'host: fixture\\n'; exit 0",
        ] {
            let start = std::time::Instant::now();
            let result = query(Path::new("/bin/sh"), &["-c", source]);
            assert!(start.elapsed() < Duration::from_secs(4));
            if source.starts_with("exec") || source.starts_with("head") {
                assert!(result.is_none());
            }
        }
        assert_eq!(
            query(Path::new("/bin/sh"), &["-c", "printf 'release: 1.0\\n'"]).as_deref(),
            Some("release: 1.0\n")
        );
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn query_timeout_reaps_exact_owned_leader_and_leaves_group_absent() {
        let workspace = Workspace::new(&[("demo", "demo_lib")]);
        let receipt = workspace.root.join("query.pid");
        let result = query(
            Path::new("/bin/sh"),
            &[
                "-c",
                "printf '%s' $$ > \"$1\"; exec 1>&-; exec /bin/sleep 30",
                "fixture",
                receipt.as_str(),
            ],
        );
        assert!(result.is_none());
        let pid: u32 = fs::read_to_string(receipt)
            .expect("actual owned PID")
            .parse()
            .expect("PID");
        assert!(linux_owned::signal_group(pid, 0).is_err_and(|e| e.raw_os_error() == Some(3)));
    }

    fn attachment() -> CompilerInvocationsV1 {
        CompilerInvocationsV1 {
            schema_version: COMPILER_INVOCATIONS_VERSION,
            cargo: ToolObservation {
                executable: None,
                verbose_identity: BTreeMap::new(),
                gaps: vec![],
            },
            cargo_command: None,
            cargo_cwd: None,
            cargo_environment: vec![],
            wrapper: None,
            invocations: vec![],
            generators: vec![],
            gaps: vec![ObservationGap::UnobservedExecutionInputs],
            truncations: vec![],
            cargo_operations: None,
        }
    }

    fn sized_invocation(bytes: usize) -> CompilerInvocation {
        let mut record = invocation();
        record.command.extend((0..8).map(|_| token("")));
        let mut padding = bytes - bounded_json_size(&record, bytes).expect("base invocation");
        for argument in record.command.iter_mut().skip(2) {
            let length = padding.min(MAX_TEXT_BYTES);
            argument.token = Some("x".repeat(length));
            padding -= length;
        }
        assert_eq!(padding, 0);
        record.bind_unit_key().expect("padded key");
        assert_eq!(
            bounded_json_size(&record, bytes).expect("exact record"),
            bytes
        );
        record.validate().expect("valid padded record");
        record
    }

    fn sized_generator(bytes: usize) -> GeneratorObservation {
        let mut record = GeneratorObservation {
            package: None,
            out_dir: None,
            command: None,
            inputs: vec![],
            outputs: vec![
                FileObservation {
                    path: Some(ObservedPath {
                        root: InputRoot::Target,
                        relative: String::new()
                    }),
                    role: FileRole::Generated,
                    before: None,
                    after: None,
                    gaps: vec![ObservationGap::ReadFailed],
                };
                MAX_FILES
            ],
            environment: vec![],
            directive_fingerprint: None,
            gaps: vec![ObservationGap::GeneratorInputsNotObserved],
            truncations: vec![],
        };
        let mut padding = bytes - bounded_json_size(&record, bytes).expect("base generator");
        for file in &mut record.outputs {
            let length = padding.min(MAX_TEXT_BYTES);
            file.path.as_mut().expect("path").relative = "x".repeat(length);
            padding -= length;
        }
        assert_eq!(padding, 0);
        record.validate().expect("valid padded generator");
        assert_eq!(
            bounded_json_size(&record, bytes).expect("exact generator"),
            bytes
        );
        record
    }

    #[test]
    fn query_retention_discards_all_bytes_after_the_exact_cap() {
        let mut output = QueryOutput::default();
        for _ in 0..QUERY_BYTES / 1024 {
            output.retain(&[b'x'; 1024]);
        }
        assert_eq!(output.bytes.len(), QUERY_BYTES);
        assert!(!output.unavailable);
        for _ in 0..1024 {
            output.retain(&[b'y'; 1024]);
            assert_eq!(output.bytes.len(), QUERY_BYTES);
        }
        assert!(output.unavailable);
        assert!(output.bytes.iter().all(|byte| *byte == b'x'));
    }

    #[test]
    fn wrapper_shape_preserves_direct_cli_and_nested_compiler_arguments() {
        let config = std::ffi::OsStr::new("/private-run/config.json");
        assert!(is_wrapper_entry(
            std::ffi::OsStr::new("/private-run/compiler-wrapper"),
            config
        ));
        assert!(!is_wrapper_entry(
            std::ffi::OsStr::new("/tools/cargo-build-graph"),
            config
        ));
        for compiler in ["rustc", "custom-compiler", "build", "--compiler"] {
            // Only argv[0] and the saved entrypoint decide routing; arbitrary
            // compiler values and nested positions cannot turn it into a CLI.
            let args = [
                OsString::from("/private-run/compiler-wrapper"),
                OsString::from(compiler),
                OsString::from("-vV"),
            ];
            assert!(is_wrapper_entry(&args[0], config));
        }
        assert_eq!(
            wrapper_compiler_index(&["/tools/custom-compiler".into(), "-vV".into()]),
            None
        );
        assert_eq!(
            wrapper_compiler_index(&[
                "/tools/workspace-wrapper".into(),
                "/tools/custom-compiler".into(),
                "-vV".into()
            ]),
            None
        );
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStringExt;
            let directory = OsString::from_vec(vec![b'/', b'r', b'u', b'n', b'/', 0xff]);
            let config = Path::new(&directory).join("config.json");
            let entry = Path::new(&directory).join(WRAPPER_ENTRY);
            assert!(is_wrapper_entry(entry.as_os_str(), config.as_os_str()));
            assert!(!is_wrapper_entry(
                std::ffi::OsStr::new("/tools/cargo-build-graph"),
                config.as_os_str()
            ));
        }
        for command in [
            "build",
            "watch",
            "update",
            "find",
            "refs",
            "context",
            "view",
            "serve",
            "build-graph",
            "--help",
            "--version",
        ] {
            let args = [OsString::from(command), OsString::from("--help")];
            assert_eq!(wrapper_compiler_index(&args), None);
            assert_eq!(
                wrapper_compiler_index(&[command.into(), "rustc".into()]),
                None
            );
        }
        assert_eq!(
            wrapper_compiler_index(&["/toolchain/bin/rustc".into(), "-vV".into()]),
            Some(0)
        );
        assert_eq!(
            wrapper_compiler_index(&[
                "/tools/workspace-wrapper".into(),
                "/toolchain/bin/rustc".into(),
                "--crate-name".into(),
                "demo".into()
            ]),
            Some(1)
        );
    }

    #[cfg(unix)]
    #[test]
    fn private_wrapper_entry_is_not_an_observed_root_grant_and_cleanup_unlinks_it() {
        let workspace = Workspace::new(&[("demo", "demo_lib")]);
        let session = session(&workspace);
        let directory = session.config.directory.clone();
        let entry = directory.join(WRAPPER_ENTRY);
        let executable = std::env::current_exe().expect("existing executable");
        create_wrapper_entry(&entry).expect("owned private alias");
        assert!(
            fs::symlink_metadata(&entry)
                .expect("alias metadata")
                .file_type()
                .is_symlink()
        );
        assert_eq!(fs::read_link(&entry).expect("alias target"), executable);
        let mut budget = UNIT_READ_BYTES;
        let observed = file_observation(
            &entry,
            FileRole::Compiler,
            true,
            &session.config.roots,
            &mut budget,
        );
        assert!(
            observed.before.is_none(),
            "routing alias cannot bypass descriptor nofollow"
        );
        assert!(!observed.gaps.is_empty());
        drop(session);
        assert!(!directory.exists());
        assert!(
            executable.is_file(),
            "owned cleanup must not follow the alias target"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn failed_and_unstable_reads_spend_quota_and_compiler_shares_it() {
        struct PartialFailure(bool);
        impl Read for PartialFailure {
            fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
                if self.0 {
                    return Err(std::io::Error::other("fixture partial failure"));
                }
                self.0 = true;
                bytes[0] = b'x';
                Ok(1)
            }
        }
        let mut budget = 8;
        reserve_read(8, FILE_BYTES, &mut budget).expect("read reservation");
        assert!(read_reserved(PartialFailure(false), 8).is_err());
        assert_eq!(budget, 0, "partial failure cannot refund admitted work");
        assert_eq!(
            reserve_read(1, FILE_BYTES, &mut budget),
            Err(ObservationGap::BudgetExceeded)
        );

        let workspace = Workspace::new(&[("demo", "demo_lib")]);
        let root = RootBinding::new(InputRoot::Source, workspace.root.as_std_path()).expect("root");
        let path = workspace.root.join("demo/src/lib.rs");
        let mut budget = UNIT_READ_BYTES;
        for _ in 0..4 {
            fs::write(&path, vec![b'x'; FILE_BYTES as usize]).expect("large source");
            let read = anchored_read(
                &root,
                Path::new("demo/src/lib.rs"),
                FILE_BYTES,
                &mut budget,
                || {
                    fs::write(&path, b"changed").expect("unstable source");
                },
            );
            assert_eq!(read.err(), Some(ObservationGap::UnstableFile));
        }
        assert_eq!(budget, 0);
        let read = file_observation(
            path.as_std_path(),
            FileRole::Source,
            true,
            &[root.clone()],
            &mut budget,
        );
        assert_eq!(read.gaps, [ObservationGap::BudgetExceeded]);
        assert!(read.before.is_none());

        let compiler = workspace.root.join("rustc");
        fs::write(&compiler, b"compiler fixture").expect("compiler source");
        let identity = tool_identity(compiler.as_str(), &[root], &mut budget);
        let executable = identity.executable.expect("compiler observation");
        assert!(executable.before.is_none());
        assert_eq!(executable.gaps, [ObservationGap::BudgetExceeded]);
        assert_eq!(budget, 0, "compiler cannot create a fresh phase quota");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn read_reservation_preserves_empty_exact_and_over_budget_boundaries() {
        let workspace = Workspace::new(&[("demo", "demo_lib")]);
        let root = RootBinding::new(InputRoot::Source, workspace.root.as_std_path()).expect("root");
        let path = workspace.root.join("demo/src/lib.rs");
        fs::write(&path, b"").expect("empty source");
        let empty = file_observation(
            path.as_std_path(),
            FileRole::Source,
            true,
            &[root.clone()],
            &mut 0,
        );
        assert_eq!(empty.before.expect("zero byte read").bytes, 0);
        fs::write(&path, b"exact").expect("source");
        let mut budget = 5;
        let exact = observed_bytes(path.as_std_path(), &[root.clone()], FILE_BYTES, &mut budget)
            .expect("exact admitted read");
        assert_eq!(exact.1, b"exact");
        assert_eq!(budget, 0);
        assert_eq!(
            observed_bytes(path.as_std_path(), &[root.clone()], FILE_BYTES, &mut budget).err(),
            Some(ObservationGap::BudgetExceeded)
        );
        let mut budget = 4;
        assert_eq!(
            observed_bytes(path.as_std_path(), &[root], FILE_BYTES, &mut budget).err(),
            Some(ObservationGap::BudgetExceeded)
        );
        assert_eq!(budget, 4, "a denied read performs no read work");
    }

    #[test]
    fn cargo_join_size_loss_keeps_exact_count_and_budget_gap() {
        let workspace = Workspace::new(&[("demo", "demo_lib")]);
        let mut session = session(&workspace);
        let record = sized_invocation(MAX_INVOCATION_BYTES - 1);
        exclusive_write(
            &session.config.directory.join("unit-0.json"),
            &serde_json::to_vec(&record).expect("record JSON"),
        )
        .expect("record");
        session.artifact(&artifact(&workspace, false));
        let result = session.finish();
        result.validate().expect("bounded gap attachment");
        assert!(result.invocations.is_empty());
        assert!(result.gaps.contains(&ObservationGap::BudgetExceeded));
        assert!(!result.gaps.contains(&ObservationGap::MalformedObservation));
        let witness = result
            .truncations
            .iter()
            .find(|v| v.collection == "assembled_invocations")
            .expect("joined record loss");
        assert_eq!(
            (witness.observed, witness.retained, witness.count_exact),
            (1, 0, true)
        );
    }

    #[test]
    fn exact_record_and_aggregate_limits_preserve_facts_and_account_for_overflow() {
        let mut result = attachment();
        let mut budget = AssemblyBudget::new(&result);
        let record = sized_invocation(MAX_INVOCATION_BYTES);
        let bytes = budget
            .admissible_size(&record, MAX_INVOCATION_BYTES, false)
            .expect("exact record limit");
        budget.bytes += bytes;
        result.invocations.push(record);
        let result = budget.finish(result);
        assert_eq!(result.invocations.len(), 1);
        assert!(result.truncations.is_empty());

        let mut result = attachment();
        let mut budget = AssemblyBudget::new(&result);
        for _ in 0..15 {
            let record = sized_generator(512 * 1024);
            let bytes = budget
                .admissible_size(&record, MAX_ATTACHMENT_BYTES, !result.generators.is_empty())
                .expect("generator fits");
            budget.bytes += bytes;
            result.generators.push(record);
        }
        let record = sized_generator(MAX_ATTACHMENT_BYTES - budget.bytes - 1);
        let bytes = budget
            .admissible_size(&record, MAX_ATTACHMENT_BYTES, true)
            .expect("exact aggregate boundary");
        budget.bytes += bytes;
        result.generators.push(record);
        assert_eq!(budget.bytes, MAX_ATTACHMENT_BYTES);
        let exact = budget.finish(result);
        exact.validate().expect("valid exact aggregate");
        assert_eq!(
            bounded_json_size(&exact, MAX_ATTACHMENT_BYTES).expect("bounded exact aggregate"),
            MAX_ATTACHMENT_BYTES
        );
        assert_eq!(exact.generators.len(), 16);
        assert!(exact.truncations.is_empty());

        let mut budget = AssemblyBudget::new(&exact);
        assert!(
            budget
                .admissible_size(&sized_generator(512 * 1024), MAX_ATTACHMENT_BYTES, true)
                .is_none()
        );
        budget.dropped_generators = 1;
        let bounded = budget.finish(exact);
        bounded.validate().expect("bounded overflow attachment");
        assert!(bounded.gaps.contains(&ObservationGap::BudgetExceeded));
        assert!(!bounded.gaps.contains(&ObservationGap::MalformedObservation));
        let witness = bounded
            .truncations
            .iter()
            .find(|v| v.collection == "assembled_generators")
            .expect("aggregate loss count");
        assert_eq!(witness.observed, 17);
        assert_eq!(witness.retained, bounded.generators.len() as u64);
        assert!(witness.count_exact && witness.retained < 16);
        assert!(bounded_json_size(&bounded, MAX_ATTACHMENT_BYTES).is_ok());
    }

    #[test]
    fn malformed_record_does_not_discard_other_valid_records() {
        let workspace = Workspace::new(&[("demo", "demo_lib")]);
        let session = session(&workspace);
        exclusive_write(
            &session.config.directory.join("unit-0.json"),
            &serde_json::to_vec(&invocation()).expect("record"),
        )
        .expect("unit");
        let mut malformed = invocation();
        malformed.command[0].token = Some("/invalid/host-path".into());
        malformed.bind_unit_key().expect("malformed key");
        exclusive_write(
            &session.config.directory.join("unit-1.json"),
            &serde_json::to_vec(&malformed).expect("record"),
        )
        .expect("unit");
        let result = session.finish();
        result.validate().expect("valid partial result");
        assert_eq!(result.invocations.len(), 1);
        assert!(result.gaps.contains(&ObservationGap::MalformedObservation));
        assert!(!result.gaps.contains(&ObservationGap::BudgetExceeded));
    }
}
