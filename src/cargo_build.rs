//! Layer 0 — drive `cargo build` and read its JSON message stream.
//!
//! This is the refresh trigger for the CLI: run the real build, then extract
//! the graph from the artifacts it produced. The stream also tells us which
//! crates were actually (re)compiled (`fresh == false`), which feeds the
//! incremental refresh of the rich layer.

use std::io::BufReader;
use std::process::{Command, Stdio};

use anyhow::{Context, Result, bail};
use camino::Utf8Path;
use cargo_metadata::Message;

/// A target that the build stream reported compiling.
// `package_id`/`target_name` are consumed by the incremental rich-layer refresh.
#[allow(dead_code)]
pub struct CompiledTarget {
    pub package_id: cargo_metadata::PackageId,
    pub target_name: String,
    /// `true` if cargo reused a cached artifact (crate unchanged this build).
    pub fresh: bool,
}

impl CompiledTarget {
    /// Crates that were actually recompiled this run.
    pub fn changed(&self) -> bool {
        !self.fresh
    }
}

/// Run `cargo build` with a JSON message stream and collect compiled targets.
/// Compiler diagnostics still render to stderr for the user.
pub fn run_build(
    manifest_path: Option<&Utf8Path>,
    release: bool,
    packages: &[String],
    extra_args: &[String],
    mut observation: Option<&mut crate::compiler_observer::Session>,
    mut selected: Option<&mut crate::cargo_launch::CargoLaunchSession>,
) -> Result<Vec<CompiledTarget>> {
    let mut cmd = Command::new(
        selected
            .as_ref()
            .map(|selected| selected.cargo.as_path())
            .or_else(|| observation.as_ref().and_then(|s| s.cargo_program()))
            .unwrap_or_else(|| std::path::Path::new("cargo")),
    );
    cmd.arg("build")
        .arg("--message-format=json-render-diagnostics");
    if let Some(mp) = manifest_path {
        cmd.arg("--manifest-path").arg(mp.as_str());
    }
    if release {
        cmd.arg("--release");
    }
    for pkg in packages {
        cmd.arg("-p").arg(pkg);
    }
    cmd.args(extra_args);
    cmd.stdout(Stdio::piped());
    if let Some(session) = observation.as_mut() {
        session.configure(&mut cmd)?;
    }

    let operation = if let Some(selected) = selected.as_mut() {
        selected.configure(&mut cmd, true);
        selected.begin(
            &mut cmd,
            build_graph::compiler_invocation::CargoOperationKind::Build,
        )?
    } else {
        None
    };

    let spawned = cmd.spawn();
    if spawned.is_err() {
        if let Some(selected) = selected.as_mut() {
            selected.complete(operation, None);
        }
    }
    let mut child = spawned.context("failed to spawn `cargo build`")?;
    if let Some(selected) = selected.as_mut() {
        selected.spawned(operation);
    }
    // Close the actual pipe and reap the same Child even on a read error. The
    // parser error remains the result; it cannot leave this launch unrecorded.
    let stdout = child.stdout.take().expect("piped Cargo stdout");
    let reader = BufReader::new(stdout);

    let mut compiled = Vec::new();
    let mut stream_error = None;
    for message in Message::parse_stream(reader) {
        let message = match message {
            Ok(message) => message,
            Err(error) => {
                if stream_error.is_none() {
                    stream_error = Some(error);
                }
                break;
            }
        };
        if let Some(session) = observation.as_mut() {
            match &message {
                Message::CompilerArtifact(artifact) => session.artifact(artifact),
                Message::BuildScriptExecuted(script) => session.build_script(script),
                _ => {}
            }
        }
        if let Message::CompilerArtifact(artifact) = message {
            compiled.push(CompiledTarget {
                package_id: artifact.package_id,
                target_name: artifact.target.name,
                fresh: artifact.fresh,
            });
        }
    }

    let waited = child.wait();
    if let Some(selected) = selected.as_mut() {
        selected.complete(operation, waited.as_ref().ok().copied());
    }
    let status = waited.context("waiting on `cargo build` failed")?;
    if let Some(error) = stream_error {
        return Err(error).context("failed to read cargo message stream");
    }
    if !status.success() {
        bail!(
            "`cargo build` failed (exit {}); graph not updated",
            status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "signal".into())
        );
    }
    Ok(compiled)
}
