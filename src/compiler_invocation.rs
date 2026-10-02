//! Bounded, portable observations of compiler executions, not reuse authority.
//!
//! Paths name an approved root instead of a machine directory. Fingerprints use
//! the export's FNV consistency marker; a verifier must independently qualify
//! bytes, roots, toolchains and any execution inputs this observer cannot see.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;

use serde::{Deserialize, Serialize};

use crate::export::content_fingerprint;

pub const COMPILER_INVOCATIONS_VERSION: u32 = 1;
pub const MAX_INVOCATIONS: usize = 128;
pub const MAX_INVOCATION_BYTES: usize = 32 * 1024;
pub const MAX_ATTACHMENT_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_ARGUMENTS: usize = 512;
pub const MAX_FILES: usize = 128;
pub const MAX_TEXT_BYTES: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObservationSizeError {
    BudgetExceeded,
    SerializationFailed,
}

/// Count JSON bytes without allocating a serialized copy, stopping at the cap.
pub fn bounded_json_size(
    value: &impl Serialize,
    maximum: usize,
) -> Result<usize, ObservationSizeError> {
    struct Counter {
        bytes: usize,
        maximum: usize,
        exceeded: bool,
    }
    impl Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > self.maximum.saturating_sub(self.bytes) {
                self.exceeded = true;
                return Err(std::io::Error::other("observation budget exceeded"));
            }
            self.bytes += bytes.len();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter {
        bytes: 0,
        maximum,
        exceeded: false,
    };
    match serde_json::to_writer(&mut counter, value) {
        Ok(()) => Ok(counter.bytes),
        Err(_) if counter.exceeded => Err(ObservationSizeError::BudgetExceeded),
        Err(_) => Err(ObservationSizeError::SerializationFailed),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InputRoot {
    Source,
    Target,
    Sysroot,
    Dependencies,
    HostTools,
    CargoConfig,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ObservedPath {
    pub root: InputRoot,
    /// `/` separated, relative to the named root. Empty means the root itself.
    pub relative: String,
}

impl ObservedPath {
    pub fn is_portable(&self) -> bool {
        self.relative.len() <= MAX_TEXT_BYTES
            && !self.relative.starts_with('/')
            && !self.relative.contains(['\\', ':', '\0'])
            && self
                .relative
                .split('/')
                .all(|part| part != "." && part != ".." && (part != "" || self.relative.is_empty()))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ObservationGap {
    ArgumentWithheld,
    EnvironmentWithheld,
    PathOutsideRoots,
    NonUtf8,
    ReadFailed,
    BudgetExceeded,
    UnstableFile,
    MissingDepInfo,
    InputObservedOnlyAfter,
    CompilerIdentityUnavailable,
    SysrootTreeNotObserved,
    CargoUnitUnbound,
    ConflictingUnit,
    CachedArtifactNotInvoked,
    GeneratorCommandNotObserved,
    GeneratorInputsNotObserved,
    UnobservedExecutionInputs,
    MalformedObservation,
    QueryCleanupUnavailable,
    ResponseFileNotExpanded,
    OutputMembershipUnknown,
    OtherCompilerPhasesNotObserved,
    ConfigurationResolutionUnknown,
}

/// A precise cap witness. `observed` is a lower bound when enumeration stopped.
/// No digest of undisclosed argument or environment bytes is included.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CollectionTruncation {
    pub collection: String,
    pub observed: u64,
    pub retained: u64,
    pub count_exact: bool,
}

/// The position in `command` is the actual argument order. An unknown argument
/// has neither a plaintext value nor a fingerprint of potentially secret bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InvocationArgument {
    pub token: Option<String>,
    pub path: Option<ObservedPath>,
    /// Safe syntactic prefix, such as `dependency=` or a declared extern name.
    pub path_prefix: Option<String>,
    pub gap: Option<ObservationGap>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ObservedFile {
    pub bytes: u64,
    pub mode: Option<u32>,
    /// `fnv1a64:...`, a consistency marker, never an integrity assertion.
    pub content_fingerprint: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileRole {
    Source,
    DepInfo,
    External,
    ProcMacro,
    Configuration,
    Compiler,
    Output,
    Generated,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FileObservation {
    pub path: Option<ObservedPath>,
    pub role: FileRole,
    pub before: Option<ObservedFile>,
    pub after: Option<ObservedFile>,
    pub gaps: Vec<ObservationGap>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnvironmentObservation {
    /// Only execution-relevant allowlisted keys, never an inherited env dump.
    pub name: String,
    pub present: bool,
    /// Only known semantic values (version, target cfg, booleans), never secrets.
    pub value: Option<String>,
    pub content_fingerprint: Option<String>,
    pub path: Option<ObservedPath>,
    pub gap: Option<ObservationGap>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolObservation {
    pub executable: Option<FileObservation>,
    /// Allowlisted fields parsed from an actual `-vV` response.
    pub verbose_identity: BTreeMap<String, String>,
    pub gaps: Vec<ObservationGap>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CargoUnitObservation {
    pub package_name: String,
    pub package_version: String,
    /// Name/version + observed origin/manifest path, without host paths or URLs.
    pub resolver_identity: Option<String>,
    pub manifest: Option<ObservedPath>,
    pub target_name: String,
    pub target_kinds: Vec<String>,
    pub crate_types: Vec<String>,
    pub edition: String,
    pub source: Option<ObservedPath>,
    pub features: Vec<String>,
    pub profile: BTreeMap<String, String>,
    /// These are observed Cargo/rustc resolutions. The observer does not claim
    /// to know a Cargo feature-selection mode that the stream does not expose.
    pub feature_mode: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompilerUnit {
    pub crate_name: String,
    pub metadata: Option<String>,
    pub source: Option<ObservedPath>,
    pub target_triple: Option<String>,
    pub cargo: Option<CargoUnitObservation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompilerInvocation {
    /// Consistency binding to normalized unit and ordered command, not a proof.
    pub unit_key: String,
    pub unit: CompilerUnit,
    pub command: Vec<InvocationArgument>,
    pub cwd: Option<ObservedPath>,
    pub compiler: ToolObservation,
    pub sysroot: Option<ObservedPath>,
    pub environment: Vec<EnvironmentObservation>,
    pub config_files: Vec<FileObservation>,
    pub inputs: Vec<FileObservation>,
    pub outputs: Vec<FileObservation>,
    pub exit_code: Option<i32>,
    pub success: bool,
    pub gaps: Vec<ObservationGap>,
    pub truncations: Vec<CollectionTruncation>,
}

impl CompilerInvocation {
    pub fn expected_unit_key(&self) -> Result<String, serde_json::Error> {
        Ok(content_fingerprint(&serde_json::to_vec(&(
            &self.unit,
            &self.command,
            &self.truncations,
        ))?))
    }

    pub fn bind_unit_key(&mut self) -> Result<(), serde_json::Error> {
        self.unit_key = self.expected_unit_key()?;
        Ok(())
    }
}

/// Cargo reports a build script's outputs and directives, not its arbitrary
/// subprocesses. Missing actual generator commands/inputs stay explicit gaps.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GeneratorObservation {
    pub package: Option<CargoUnitObservation>,
    pub out_dir: Option<ObservedPath>,
    pub command: Option<Vec<InvocationArgument>>,
    pub inputs: Vec<FileObservation>,
    pub outputs: Vec<FileObservation>,
    pub environment: Vec<EnvironmentObservation>,
    pub directive_fingerprint: Option<String>,
    pub gaps: Vec<ObservationGap>,
    pub truncations: Vec<CollectionTruncation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompilerInvocationsV1 {
    pub schema_version: u32,
    pub cargo: ToolObservation,
    pub cargo_command: Option<Vec<InvocationArgument>>,
    pub cargo_cwd: Option<ObservedPath>,
    pub cargo_environment: Vec<EnvironmentObservation>,
    pub wrapper: Option<ToolObservation>,
    pub invocations: Vec<CompilerInvocation>,
    pub generators: Vec<GeneratorObservation>,
    pub gaps: Vec<ObservationGap>,
    pub truncations: Vec<CollectionTruncation>,
}

impl CompilerInvocationsV1 {
    /// Bounded entry point for supplemental JSON consumers. The outer export
    /// reader also validates attachments before exposing them.
    pub fn from_json(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() > MAX_ATTACHMENT_BYTES {
            return Err("compiler observation attachment exceeds budget".into());
        }
        let value: Self = serde_json::from_slice(bytes)
            .map_err(|_| "malformed compiler observation attachment".to_string())?;
        value.validate()?;
        Ok(value)
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != COMPILER_INVOCATIONS_VERSION
            || self.invocations.len() > MAX_INVOCATIONS
            || self.generators.len() > MAX_INVOCATIONS
        {
            return Err("unsupported or oversized compiler observations".into());
        }
        bounded_json_size(self, MAX_ATTACHMENT_BYTES).map_err(|error| match error {
            ObservationSizeError::BudgetExceeded => {
                "compiler observation attachment exceeds budget"
            }
            ObservationSizeError::SerializationFailed => {
                "compiler observations could not be serialized"
            }
        })?;
        validate_portable_values(
            &serde_json::to_value(self)
                .map_err(|_| "compiler observations could not be serialized".to_string())?,
        )?;
        if let Some(args) = &self.cargo_command {
            if args.len() > MAX_ARGUMENTS {
                return Err("oversized Cargo command".into());
            }
            validate_arguments(args)?;
        }
        if self.cargo_environment.len() > MAX_FILES {
            return Err("oversized Cargo environment".into());
        }
        validate_environment(&self.cargo_environment)?;
        validate_truncations(&self.truncations)?;
        let mut keys = BTreeSet::new();
        for tool in std::iter::once(&self.cargo).chain(self.wrapper.iter()) {
            tool.validate()?;
        }
        for invocation in &self.invocations {
            invocation.validate()?;
            if !keys.insert(&invocation.unit_key) {
                return Err("conflicting compiler invocation".into());
            }
        }
        for generator in &self.generators {
            generator.validate()?;
        }
        if !self.truncations.is_empty() && !self.gaps.contains(&ObservationGap::BudgetExceeded) {
            return Err("unaccounted observation truncation".into());
        }
        Ok(())
    }
}

impl CompilerInvocation {
    /// Validate one bounded record before joining it into an attachment.
    pub fn validate(&self) -> Result<(), String> {
        bounded_json_size(self, MAX_INVOCATION_BYTES)
            .map_err(|_| "oversized compiler invocation")?;
        validate_portable_values(&serde_json::to_value(self).map_err(|_| "invalid invocation")?)?;
        self.compiler.validate()?;
        validate_truncations(&self.truncations)?;
        validate_arguments(&self.command)?;
        validate_environment(&self.environment)?;
        for file in self
            .inputs
            .iter()
            .chain(&self.outputs)
            .chain(&self.config_files)
        {
            validate_file(file)?;
        }
        if self.command.len() > MAX_ARGUMENTS
            || self.inputs.len() > MAX_FILES
            || self.outputs.len() > MAX_FILES
            || self.config_files.len() > MAX_FILES
            || self.environment.len() > MAX_FILES
            || (!self.truncations.is_empty()
                && !self.gaps.contains(&ObservationGap::BudgetExceeded))
            || self
                .expected_unit_key()
                .map_err(|_| "invalid unit binding")?
                != self.unit_key
            || self
                .unit
                .cargo
                .as_ref()
                .is_some_and(|cargo| cargo.source != self.unit.source)
        {
            return Err("oversized, stale or conflicting compiler invocation".into());
        }
        Ok(())
    }
}

impl GeneratorObservation {
    /// Validate a generator within the aggregate bound before retaining it.
    pub fn validate(&self) -> Result<(), String> {
        bounded_json_size(self, MAX_ATTACHMENT_BYTES)
            .map_err(|_| "oversized generator observation")?;
        validate_portable_values(&serde_json::to_value(self).map_err(|_| "invalid generator")?)?;
        validate_truncations(&self.truncations)?;
        if let Some(args) = &self.command {
            validate_arguments(args)?;
        }
        validate_environment(&self.environment)?;
        for file in self.inputs.iter().chain(&self.outputs) {
            validate_file(file)?;
        }
        if self.inputs.len() > MAX_FILES
            || self.outputs.len() > MAX_FILES
            || self.environment.len() > MAX_FILES
            || self
                .command
                .as_ref()
                .is_some_and(|v| v.len() > MAX_ARGUMENTS)
            || (!self.truncations.is_empty()
                && !self.gaps.contains(&ObservationGap::BudgetExceeded))
        {
            return Err("oversized or unaccounted generator observations".into());
        }
        Ok(())
    }
}

impl ToolObservation {
    pub fn validate(&self) -> Result<(), String> {
        if let Some(file) = &self.executable {
            validate_file(file)?;
        }
        if self.verbose_identity.iter().any(|(key, value)| {
            !matches!(
                key.as_str(),
                "release" | "commit-hash" | "commit-date" | "host" | "LLVM version"
            ) || !value
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || " ._+-".contains(c))
        }) {
            return Err("invalid tool observation".into());
        }
        Ok(())
    }
}

fn validate_truncations(values: &[CollectionTruncation]) -> Result<(), String> {
    if values.len() > MAX_FILES
        || values.iter().any(|v| {
            v.observed <= v.retained
                || v.collection.is_empty()
                || v.collection.len() > 64
                || !v
                    .collection
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_')
        })
    {
        return Err("invalid observation budget witness".into());
    }
    Ok(())
}

fn validate_arguments(arguments: &[InvocationArgument]) -> Result<(), String> {
    for argument in arguments {
        if (argument.token.is_some() && argument.path.is_some())
            || (argument.token.is_none() && argument.path.is_none() && argument.gap.is_none())
            || argument
                .token
                .as_ref()
                .is_some_and(|v| v.contains(['/', '\\', ':', '\n', '\r']))
            || argument
                .path_prefix
                .as_ref()
                .is_some_and(|v| v.contains(['/', '\\', ':', '\n', '\r']))
        {
            return Err("invalid normalized compiler argument".into());
        }
    }
    Ok(())
}

fn fingerprint(value: &str) -> bool {
    value
        .strip_prefix("fnv1a64:")
        .is_some_and(|v| v.len() == 16 && v.chars().all(|c| c.is_ascii_hexdigit()))
}

fn validate_file(file: &FileObservation) -> Result<(), String> {
    if file
        .before
        .iter()
        .chain(&file.after)
        .any(|v| !fingerprint(&v.content_fingerprint) || v.mode.is_some_and(|mode| mode > 0o7777))
    {
        return Err("invalid file observation".into());
    }
    Ok(())
}

fn validate_environment(environment: &[EnvironmentObservation]) -> Result<(), String> {
    let mut keys = BTreeSet::new();
    for value in environment {
        let allowed = matches!(
            value.name.as_str(),
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
        ) || value.name.starts_with("CARGO_CFG_")
            || value.name.starts_with("CARGO_FEATURE_");
        if !allowed
            || !keys.insert(&value.name)
            || value
                .content_fingerprint
                .as_ref()
                .is_some_and(|v| !fingerprint(v))
            || value.value.as_ref().is_some_and(|v| {
                v.len() > 256
                    || !v
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || "_-+.,".contains(c))
            })
        {
            return Err("invalid allowlisted environment observation".into());
        }
    }
    Ok(())
}

fn validate_portable_values(value: &serde_json::Value) -> Result<(), String> {
    match value {
        serde_json::Value::String(value) => {
            if value.len() > MAX_TEXT_BYTES || value.contains('\0') {
                return Err("oversized compiler observation text".into());
            }
        }
        serde_json::Value::Array(values) => {
            if values.len() > MAX_ARGUMENTS {
                return Err("oversized compiler observation list".into());
            }
            for value in values {
                validate_portable_values(value)?;
            }
        }
        serde_json::Value::Object(values) => {
            if let (Some(root), Some(relative)) = (values.get("root"), values.get("relative")) {
                let path: ObservedPath = serde_json::from_value(serde_json::json!({
                    "root": root, "relative": relative
                }))
                .map_err(|_| "invalid observed path")?;
                if !path.is_portable() {
                    return Err("nonportable observed path".into());
                }
            }
            for value in values.values() {
                validate_portable_values(value)?;
            }
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialized_size_counts_exact_bytes_without_retaining_overflow() {
        let value = "x".repeat(MAX_ATTACHMENT_BYTES - 2);
        assert_eq!(
            bounded_json_size(&value, MAX_ATTACHMENT_BYTES),
            Ok(MAX_ATTACHMENT_BYTES)
        );
        assert_eq!(
            bounded_json_size(&value, MAX_ATTACHMENT_BYTES - 1),
            Err(ObservationSizeError::BudgetExceeded)
        );
        assert_eq!(bounded_json_size(&"", 2), Ok(2));
        assert_eq!(
            bounded_json_size(&"", 0),
            Err(ObservationSizeError::BudgetExceeded)
        );
    }

    #[test]
    fn paths_reject_host_absolute_parent_and_oversized_forms() {
        for relative in [
            "/private/secret",
            "../secret",
            "a/../secret",
            "a\\secret",
            "a//b",
            "C:secret",
        ] {
            assert!(
                !ObservedPath {
                    root: InputRoot::Source,
                    relative: relative.into()
                }
                .is_portable()
            );
        }
        assert!(
            ObservedPath {
                root: InputRoot::Source,
                relative: "src/lib.rs".into()
            }
            .is_portable()
        );
        assert!(
            !ObservedPath {
                root: InputRoot::Source,
                relative: "x".repeat(MAX_TEXT_BYTES + 1)
            }
            .is_portable()
        );
    }

    #[test]
    fn malformed_and_oversized_attachments_reject_without_echoing_payloads() {
        assert!(
            CompilerInvocationsV1::from_json(b"secret=credential")
                .unwrap_err()
                .contains("malformed")
        );
        assert!(CompilerInvocationsV1::from_json(&vec![b' '; MAX_ATTACHMENT_BYTES + 1]).is_err());
    }
    fn fixture() -> CompilerInvocationsV1 {
        let mut invocation: CompilerInvocation = serde_json::from_value(serde_json::json!({
            "unit_key":"", "unit":{"crate_name":"demo", "metadata":"abc", "source":{"root":"source","relative":"src/lib.rs"},"target_triple":"x86_64-unknown-linux-gnu","cargo":null},
            "command":[{"token":"--crate-name","path":null,"path_prefix":null,"gap":null},{"token":"demo","path":null,"path_prefix":null,"gap":null}],
            "cwd":{"root":"source","relative":""},"compiler":{"executable":null,"verbose_identity":{"release":"1.95.0"},"gaps":[]},"sysroot":{"root":"sysroot","relative":""},
            "environment":[],"config_files":[],"inputs":[],"outputs":[],"exit_code":0,"success":true,"gaps":["unobserved_execution_inputs"],"truncations":[]
        })).expect("fixture observation");
        invocation.bind_unit_key().expect("unit key");
        CompilerInvocationsV1 {
            schema_version: 1,
            cargo_command: None,
            cargo_cwd: None,
            cargo_environment: vec![],
            wrapper: None,
            cargo: ToolObservation {
                executable: None,
                verbose_identity: BTreeMap::new(),
                gaps: vec![],
            },
            invocations: vec![invocation],
            generators: vec![],
            gaps: vec![ObservationGap::UnobservedExecutionInputs],
            truncations: vec![],
        }
    }

    #[test]
    fn deterministic_partial_attachment_rejects_stale_conflicting_and_unaccounted_records() {
        let facts = fixture();
        facts.validate().expect("valid partial fixture");
        let raw = serde_json::to_vec(&facts).expect("JSON");
        assert_eq!(
            raw,
            serde_json::to_vec(&CompilerInvocationsV1::from_json(&raw).expect("roundtrip"))
                .expect("deterministic JSON")
        );
        let mut stale = facts.clone();
        stale.invocations[0].command.reverse();
        assert!(stale.validate().is_err());
        let mut duplicate = facts.clone();
        duplicate.invocations.push(duplicate.invocations[0].clone());
        assert!(duplicate.validate().is_err());
        let mut wrong_source = facts.clone();
        wrong_source.invocations[0].unit.cargo = Some(CargoUnitObservation {
            package_name: "demo".into(),
            package_version: "0.1.0".into(),
            resolver_identity: None,
            manifest: None,
            target_name: "demo".into(),
            target_kinds: vec!["lib".into()],
            crate_types: vec!["lib".into()],
            edition: "2024".into(),
            source: None,
            features: vec![],
            profile: BTreeMap::new(),
            feature_mode: None,
        });
        wrong_source.invocations[0].bind_unit_key().expect("key");
        assert!(wrong_source.validate().is_err());
        let mut unaccounted = facts;
        unaccounted.truncations.push(CollectionTruncation {
            collection: "argv".into(),
            observed: 513,
            retained: 0,
            count_exact: true,
        });
        assert!(unaccounted.validate().is_err());
    }

    #[test]
    fn command_toolchain_target_environment_and_external_facts_change_serialized_binding() {
        let facts = fixture();
        let baseline = serde_json::to_vec(&facts).expect("baseline");
        let mut variants = vec![];
        let mut command = facts.clone();
        command.invocations[0].command.push(InvocationArgument {
            token: Some("--test".into()),
            path: None,
            path_prefix: None,
            gap: None,
        });
        variants.push(command);
        let mut tool = facts.clone();
        tool.invocations[0]
            .compiler
            .verbose_identity
            .insert("release".into(), "1.96.0".into());
        variants.push(tool);
        let mut target = facts.clone();
        target.invocations[0].unit.target_triple = Some("aarch64-unknown-linux-gnu".into());
        variants.push(target);
        let mut env = facts.clone();
        env.invocations[0].environment.push(EnvironmentObservation {
            name: "PROFILE".into(),
            present: true,
            value: Some("release".into()),
            content_fingerprint: Some(content_fingerprint(b"release")),
            path: None,
            gap: None,
        });
        variants.push(env);
        for role in [
            FileRole::External,
            FileRole::Configuration,
            FileRole::Generated,
        ] {
            let mut input = facts.clone();
            input.invocations[0].inputs.push(FileObservation {
                path: Some(ObservedPath {
                    root: InputRoot::Dependencies,
                    relative: "changed.input".into(),
                }),
                role,
                before: Some(ObservedFile {
                    bytes: 7,
                    mode: Some(0o644),
                    content_fingerprint: content_fingerprint(b"changed"),
                }),
                after: None,
                gaps: vec![ObservationGap::InputObservedOnlyAfter],
            });
            variants.push(input);
        }
        for mut variant in variants {
            variant.invocations[0].bind_unit_key().expect("key");
            variant.validate().expect("changed partial observation");
            assert_ne!(
                baseline,
                serde_json::to_vec(&variant).expect("changed binding")
            );
        }
    }

    #[test]
    fn malformed_argument_paths_environment_and_version_are_rejected() {
        let mut facts = fixture();
        facts.schema_version = 2;
        assert!(facts.validate().is_err());
        let mut facts = fixture();
        facts.invocations[0].command[0].token = Some("/private/credential".into());
        facts.invocations[0].bind_unit_key().expect("key");
        assert!(facts.validate().is_err());
        let mut facts = fixture();
        facts.invocations[0]
            .environment
            .push(EnvironmentObservation {
                name: "AWS_SECRET_ACCESS_KEY".into(),
                present: true,
                value: None,
                content_fingerprint: None,
                path: None,
                gap: Some(ObservationGap::EnvironmentWithheld),
            });
        assert!(facts.validate().is_err());
        let mut facts = fixture();
        facts.invocations[0].inputs = vec![
            FileObservation {
                path: None,
                role: FileRole::External,
                before: None,
                after: None,
                gaps: vec![ObservationGap::ReadFailed]
            };
            MAX_FILES + 1
        ];
        assert!(facts.validate().is_err());
    }
}
