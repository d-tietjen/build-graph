//! Layer 1a — the crate dependency graph, from `cargo metadata`.
//!
//! Produces one node per workspace crate and a `depends_on` edge for every
//! resolved dependency *between workspace members* (external registry crates
//! are intentionally omitted to keep the architecture view readable).

use std::collections::{HashMap, HashSet};

use anyhow::{Context, Result, bail};
use camino::Utf8Path;
use cargo_metadata::{Metadata, MetadataCommand, Package, PackageId};

use build_graph::{Graph, Node, crate_id};

/// Run `cargo metadata` (with the resolved dependency graph) for a workspace.
pub fn load(manifest_path: Option<&Utf8Path>) -> Result<Metadata> {
    let mut cmd = MetadataCommand::new();
    if let Some(mp) = manifest_path {
        cmd.manifest_path(mp);
    }
    cmd.exec().context("`cargo metadata` failed")
}

/// Use the library's actual command/JSON parser with the selected Cargo. Legacy
/// absence keeps MetadataCommand::exec unchanged; no shadow resolution runs.
pub fn load_routed(
    manifest_path: Option<&Utf8Path>,
    selected: Option<&mut crate::cargo_launch::CargoLaunchSession>,
) -> Result<Metadata> {
    let Some(selected) = selected else {
        return load(manifest_path);
    };
    let mut metadata = MetadataCommand::new();
    metadata.cargo_path(&selected.cargo);
    if let Some(manifest) = manifest_path {
        metadata.manifest_path(manifest);
    }
    let mut command = metadata.cargo_command();
    selected.configure(&mut command, false);
    #[cfg(target_os = "linux")]
    if selected.has_launch_observer() {
        command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let mut child = selected.launch(
            command,
            build_graph::compiler_invocation::CargoOperationKind::Metadata,
        )?;
        let output = child.output()?;
        if !output.status.success() {
            bail!("selected Cargo metadata failed");
        }
        let stdout = std::str::from_utf8(&output.stdout)?
            .lines()
            .find(|line| line.starts_with('{'))
            .context("Cargo metadata produced no JSON")?;
        return MetadataCommand::parse(stdout).context("selected Cargo metadata JSON failed");
    }
    let operation = selected.begin(
        &mut command,
        build_graph::compiler_invocation::CargoOperationKind::Metadata,
    )?;
    let output = command.output();
    selected.complete(operation, output.as_ref().ok().map(|output| output.status));
    let output = output.context("failed to spawn selected Cargo metadata")?;
    if !output.status.success() {
        bail!(
            "selected Cargo metadata failed (exit {:?})",
            output.status.code()
        );
    }
    let stdout = std::str::from_utf8(&output.stdout)?
        .lines()
        .find(|line| line.starts_with('{'))
        .context("Cargo metadata produced no JSON")?;
    MetadataCommand::parse(stdout).context("selected Cargo metadata JSON failed")
}

/// Add crate nodes + `depends_on` edges for workspace members.
pub fn add_crate_layer(graph: &mut Graph, meta: &Metadata) {
    let workspace: HashSet<&PackageId> = meta.workspace_members.iter().collect();
    let by_id: HashMap<&PackageId, &Package> = meta.packages.iter().map(|p| (&p.id, p)).collect();

    for pid in &meta.workspace_members {
        let Some(pkg) = by_id.get(pid) else { continue };
        let manifest_rel = pkg
            .manifest_path
            .strip_prefix(&meta.workspace_root)
            .ok()
            .map(|p| p.as_str().to_string());
        graph.add_node(
            Node::new(crate_id(&pkg.name), pkg.name.clone(), "crate")
                .with_source(manifest_rel, None)
                .attr("crate", pkg.name.clone())
                .attr("version", pkg.version.to_string()),
        );
    }

    let Some(resolve) = &meta.resolve else { return };
    for node in &resolve.nodes {
        if !workspace.contains(&node.id) {
            continue;
        }
        let Some(from) = by_id.get(&node.id) else {
            continue;
        };
        for dep in &node.dependencies {
            if !workspace.contains(dep) {
                continue;
            }
            let Some(to) = by_id.get(dep) else { continue };
            graph.add_edge(
                crate_id(&from.name),
                crate_id(&to.name),
                "depends_on",
                None,
                None,
            );
        }
    }
}
