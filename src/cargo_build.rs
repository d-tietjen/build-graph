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
) -> Result<Vec<CompiledTarget>> {
    let mut cmd = Command::new("cargo");
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

    let mut child = cmd.spawn().context("failed to spawn `cargo build`")?;
    let stdout = child
        .stdout
        .take()
        .context("cargo build produced no stdout")?;
    let reader = BufReader::new(stdout);

    let mut compiled = Vec::new();
    for message in Message::parse_stream(reader) {
        let message = message.context("failed to read cargo message stream")?;
        if let Message::CompilerArtifact(artifact) = message {
            compiled.push(CompiledTarget {
                package_id: artifact.package_id,
                target_name: artifact.target.name,
                fresh: artifact.fresh,
            });
        }
    }

    let status = child.wait().context("waiting on `cargo build` failed")?;
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
