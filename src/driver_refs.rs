//! Layer 3 (semantic) via the build-graph **rustc driver** — an alternative to
//! the rust-analyzer SCIP backend ([`crate::scip`]).
//!
//! Runs `cargo check` with the driver installed as `RUSTC_WORKSPACE_WRAPPER`.
//! The driver walks each workspace crate's HIR and writes resolved edges
//! (`kind <TAB> caller_file:line <TAB> callee_file:line`, plus resolved def
//! paths in newer files) per compilation unit; here we map those endpoints onto
//! the Layer-2 item nodes. The path columns are important for macro-expanded
//! items whose spans can point at macro definitions or share an invocation line.
//!
//! Why a driver: it is far cheaper than a cold whole-workspace SCIP index and is
//! incremental for free — cargo only re-runs the wrapper for crates it
//! recompiles. So the per-unit edge files are keyed by cargo's stable
//! `-C metadata` hash and **persisted** in the output dir; a rebuild overwrites
//! only the changed units, then the full set is re-mapped (cheap).

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::BufReader;
use std::process::{Command, Stdio};

use anyhow::{Context, Result, anyhow, bail};
use camino::{Utf8Path, Utf8PathBuf};
use cargo_metadata::{Message, Metadata, Package};
use serde::{Deserialize, Serialize};

use build_graph::{Graph, Node, item_id, norm};

use crate::scip::{ReferenceCounts, add_member_reference_edges};

#[path = "bundled_driver.rs"]
mod bundled;

#[derive(Serialize, Deserialize)]
struct ArtifactIndex {
    version: u32,
    rust_artifacts: Vec<RustArtifact>,
    native_links: Vec<NativeLinks>,
}

#[derive(Serialize, Deserialize)]
struct RustArtifact {
    package_id: String,
    target_name: String,
    target_kind: Vec<String>,
    target_src_path: String,
    filenames: Vec<String>,
    #[serde(default)]
    features: Vec<String>,
    #[serde(default)]
    profile: serde_json::Value,
    #[serde(default)]
    fresh: Option<bool>,
}

#[derive(Serialize, Deserialize)]
struct NativeLinks {
    package_id: String,
    linked_libs: Vec<String>,
    linked_paths: Vec<String>,
    out_dir: String,
    #[serde(default)]
    environment_names: Vec<String>,
}

fn capture_artifacts(mut cmd: Command, out: &Utf8Path) -> Result<ArtifactIndex> {
    cmd.stdout(Stdio::piped());
    let mut child = cmd
        .spawn()
        .context("running `cargo check` with the rustc driver")?;
    let stdout = child
        .stdout
        .take()
        .context("cargo check produced no stdout")?;
    let mut index = ArtifactIndex {
        version: 1,
        rust_artifacts: Vec::new(),
        native_links: Vec::new(),
    };
    for message in Message::parse_stream(BufReader::new(stdout)) {
        match message.context("reading cargo compiler artifact stream")? {
            Message::CompilerArtifact(artifact) => index.rust_artifacts.push(RustArtifact {
                package_id: artifact.package_id.repr,
                target_name: artifact.target.name,
                target_kind: artifact
                    .target
                    .kind
                    .iter()
                    .map(ToString::to_string)
                    .collect(),
                target_src_path: artifact.target.src_path.into_string(),
                filenames: artifact
                    .filenames
                    .into_iter()
                    .map(|path| path.into_string())
                    .collect(),
                features: artifact.features.iter().map(ToString::to_string).collect(),
                profile: serde_json::to_value(&artifact.profile)?,
                fresh: Some(artifact.fresh),
            }),
            Message::BuildScriptExecuted(script) => index.native_links.push(NativeLinks {
                package_id: script.package_id.repr,
                linked_libs: script
                    .linked_libs
                    .into_iter()
                    .map(|path| path.into_string())
                    .collect(),
                linked_paths: script
                    .linked_paths
                    .into_iter()
                    .map(|path| path.into_string())
                    .collect(),
                out_dir: script.out_dir.into_string(),
                environment_names: script.env.into_iter().map(|(name, _)| name).collect(),
            }),
            Message::CompilerMessage(message) => {
                if let Some(rendered) = message.message.rendered {
                    eprint!("{rendered}");
                }
            }
            _ => {}
        }
    }
    let status = child.wait().context("waiting for cargo check")?;
    if !status.success() {
        bail!("`cargo check` (driver) failed (exit {status})");
    }
    std::fs::write(
        out.join("driver-artifacts-v1.json"),
        serde_json::to_vec_pretty(&index)?,
    )?;
    Ok(index)
}

/// Locate the `bg-driver` binary, building it on demand if needed. In order:
/// `explicit` (`--driver-bin`), then `$BUILD_GRAPH_DRIVER`, then building the
/// source checkout or embedded bundle (its own nightly pin applies).
pub fn resolve_driver(explicit: Option<&str>) -> Result<Utf8PathBuf> {
    if let Some(p) = explicit {
        let p = absolute_path(&Utf8PathBuf::from(p))?;
        if !p.as_std_path().exists() {
            bail!("--driver-bin {p} not found");
        }
        return Ok(p);
    }
    if let Some(env) = std::env::var_os("BUILD_GRAPH_DRIVER") {
        let p = absolute_path(&Utf8PathBuf::from(env.to_string_lossy().into_owned()))?;
        if !p.as_std_path().exists() {
            bail!("BUILD_GRAPH_DRIVER points at a missing file: {p}");
        }
        return Ok(p);
    }
    let src = match driver_src() {
        Some(source) => source,
        None => bundled::materialize()?,
    };
    build_driver(&src)
}

/// The `crates/bg-driver` source dir: `$BUILD_GRAPH_DRIVER_SRC`, else the copy
/// baked in next to this crate (works when running a locally-built binary).
fn driver_src() -> Option<Utf8PathBuf> {
    if let Some(s) = std::env::var_os("BUILD_GRAPH_DRIVER_SRC") {
        let p = absolute_path(&Utf8PathBuf::from(s.to_string_lossy().into_owned())).ok()?;
        if p.join("Cargo.toml").as_std_path().exists() {
            return Some(p);
        }
    }
    let baked = Utf8PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("crates/bg-driver");
    baked
        .join("Cargo.toml")
        .as_std_path()
        .exists()
        .then_some(baked)
}

fn absolute_path(path: &Utf8Path) -> Result<Utf8PathBuf> {
    if path.is_absolute() {
        return Ok(path.to_path_buf());
    }
    let cwd = std::env::current_dir().context("resolving current directory")?;
    Utf8PathBuf::from_path_buf(cwd.join(path.as_std_path()))
        .map_err(|p| anyhow!("path is not valid UTF-8: {}", p.display()))
}

/// Strip the rustup/cargo toolchain selectors that a parent `cargo build-graph`
/// invocation leaks into child processes (`RUSTUP_TOOLCHAIN`, `RUSTC`,
/// `RUSTDOC`). Without this, running build-graph under a project pinned to
/// stable (or any non-driver toolchain) forces the nested driver build/check
/// onto that toolchain instead of the driver crate's pinned nightly, and
/// `#![feature(rustc_private)]` fails to compile.
fn free_toolchain(cmd: &mut std::process::Command) {
    cmd.env_remove("RUSTUP_TOOLCHAIN")
        .env_remove("RUSTC")
        .env_remove("RUSTDOC");
}

/// Build the driver crate (its `rust-toolchain.toml` selects the nightly). Cargo
/// caches, so this is a fast no-op after the first run.
fn build_driver(src: &Utf8Path) -> Result<Utf8PathBuf> {
    let bin = src.join("target/release/bg-driver");
    eprintln!("[build-graph] driver: ensuring {src} is built (cargo caches)…");
    let mut cmd = std::process::Command::new("cargo");
    cmd.args(["build", "--release"])
        .current_dir(src.as_std_path()); // so bg-driver's nightly toolchain pin applies
    free_toolchain(&mut cmd);
    let status = cmd.status().context("building the bg-driver crate")?;
    if !status.success() {
        bail!("building bg-driver failed (needs the pinned nightly + rustc-dev component)");
    }
    if !bin.as_std_path().exists() {
        bail!("bg-driver built but binary missing at {bin}");
    }
    Ok(bin)
}

/// `file:line -> node id`, split fn vs other so a trait and a method defined on
/// the same line don't collide; lookups allow ±1 line — same convention scip.rs
/// uses to bridge rustdoc's item line and the reference tool's name line.
struct Locator {
    loc_fn: HashMap<String, Vec<String>>,
    loc_other: HashMap<String, Vec<String>>,
    path_fn: HashMap<String, Vec<String>>,
    path_other: HashMap<String, Vec<String>>,
    /// fn/method node lines per file, sorted — for enclosing-fn rollup.
    fns_by_file: HashMap<String, Vec<(i64, String)>>,
}

impl Locator {
    fn insert(bucket: &mut HashMap<String, Vec<String>>, key: String, id: &str) {
        let ids = bucket.entry(key).or_default();
        if !ids.iter().any(|candidate| candidate == id) {
            ids.push(id.to_string());
        }
    }

    fn unique(ids: &[String]) -> Option<&String> {
        (ids.len() == 1).then(|| &ids[0])
    }

    fn build(graph: &Graph) -> Self {
        let mut loc_fn = HashMap::new();
        let mut loc_other = HashMap::new();
        let mut path_fn = HashMap::new();
        let mut path_other = HashMap::new();
        let mut fns_by_file: HashMap<String, Vec<(i64, String)>> = HashMap::new();
        for n in graph.node_values() {
            let kind = n.attributes.get("kind").map(String::as_str).unwrap_or("");
            let is_fn = kind == "function" || kind == "method";
            if let Some(path) = n.attributes.get("path") {
                let bucket = if is_fn { &mut path_fn } else { &mut path_other };
                Self::insert(bucket, path.to_string(), &n.id);
                if let Some(krate) = n.attributes.get("crate") {
                    let rustc_crate = krate.replace('-', "_");
                    Self::insert(bucket, format!("{rustc_crate}::{path}"), &n.id);
                    Self::insert(bucket, format!("{}::{path}", norm(krate)), &n.id);
                }
            }
            if let (Some(f), Some(l)) = (n.source_file.as_deref(), n.source_location) {
                let bucket = if is_fn { &mut loc_fn } else { &mut loc_other };
                Self::insert(bucket, format!("{f}:{l}"), &n.id);
                if is_fn {
                    fns_by_file
                        .entry(f.to_string())
                        .or_default()
                        .push((l as i64, n.id.clone()));
                }
            }
        }
        for v in fns_by_file.values_mut() {
            v.sort();
        }
        Locator {
            loc_fn,
            loc_other,
            path_fn,
            path_other,
            fns_by_file,
        }
    }

    /// The nearest fn/method defined at or before `file:line` — used to roll a
    /// caller that lands inside a closure or const initializer (which has no
    /// graph node) up to its enclosing function, so the edge isn't lost.
    fn enclosing_fn(&self, fileline: &str) -> Option<&String> {
        let (f, l) = fileline.rsplit_once(':')?;
        let l: i64 = l.parse().ok()?;
        let list = self.fns_by_file.get(f)?;
        let pos = list.partition_point(|(ln, _)| *ln <= l);
        if pos == 0 {
            return None;
        }
        let line = list[pos - 1].0;
        let start = list.partition_point(|(ln, _)| *ln < line);
        (pos - start == 1).then(|| &list[pos - 1].1)
    }

    /// Resolve a `file:line` to a node id, preferring the fn or other bucket per
    /// `prefer_fn`, then the other, each with ±1 line tolerance.
    fn get(&self, prefer_fn: bool, fileline: &str) -> Option<&String> {
        let (primary, secondary) = if prefer_fn {
            (&self.loc_fn, &self.loc_other)
        } else {
            (&self.loc_other, &self.loc_fn)
        };
        let split = fileline
            .rsplit_once(':')
            .and_then(|(f, l)| l.parse::<i64>().ok().map(|l| (f, l)));
        for m in [primary, secondary] {
            if let Some(ids) = m.get(fileline) {
                return Self::unique(ids);
            }
            if let Some((f, l)) = split {
                let mut nearby: Vec<&String> = [l - 1, l + 1]
                    .into_iter()
                    .filter_map(|line| m.get(&format!("{f}:{line}")))
                    .flat_map(|ids| ids.iter())
                    .collect();
                nearby.sort();
                nearby.dedup();
                if !nearby.is_empty() {
                    return (nearby.len() == 1).then(|| nearby[0]);
                }
            }
        }
        None
    }

    /// Resolve a rustc `def_path_str` to a node id, preferring the fn or other
    /// bucket per `prefer_fn`, then falling back to the other bucket. This is the
    /// macro-safe path: expanded items can share a callsite line or point at the
    /// macro definition line, but their resolved def path is still precise.
    fn get_path(&self, prefer_fn: bool, path: &str) -> Option<&String> {
        let (primary, secondary) = if prefer_fn {
            (&self.path_fn, &self.path_other)
        } else {
            (&self.path_other, &self.path_fn)
        };
        primary
            .get(path)
            .or_else(|| secondary.get(path))
            .and_then(|ids| Self::unique(ids))
    }

    fn path_ambiguous(&self, prefer_fn: bool, path: &str) -> bool {
        let (primary, secondary) = if prefer_fn {
            (&self.path_fn, &self.path_other)
        } else {
            (&self.path_other, &self.path_fn)
        };
        primary
            .get(path)
            .or_else(|| secondary.get(path))
            .is_some_and(|ids| ids.len() > 1)
    }

    fn location_ambiguous(&self, prefer_fn: bool, fileline: &str) -> bool {
        let (primary, secondary) = if prefer_fn {
            (&self.loc_fn, &self.loc_other)
        } else {
            (&self.loc_other, &self.loc_fn)
        };
        let nearby = fileline
            .rsplit_once(':')
            .and_then(|(file, line)| line.parse::<i64>().ok().map(|line| (file, line)));
        for bucket in [primary, secondary] {
            if let Some(ids) = bucket.get(fileline) {
                return ids.len() > 1;
            }
            let Some((file, line)) = nearby else {
                continue;
            };
            let mut ids: Vec<_> = [line - 1, line + 1]
                .into_iter()
                .filter_map(|line| bucket.get(&format!("{file}:{line}")))
                .flat_map(|ids| ids.iter())
                .collect();
            ids.sort();
            ids.dedup();
            if !ids.is_empty() {
                return ids.len() > 1;
            }
        }
        false
    }
}

fn dylib_env() -> &'static str {
    if cfg!(target_os = "macos") {
        "DYLD_FALLBACK_LIBRARY_PATH"
    } else {
        "LD_LIBRARY_PATH"
    }
}

pub fn sysroot(nightly: &str) -> Result<String> {
    let out = Command::new("rustc")
        .arg(format!("+{nightly}"))
        .args(["--print", "sysroot"])
        .output()
        .context("running `rustc --print sysroot`")?;
    if !out.status.success() {
        bail!("could not determine sysroot for toolchain `{nightly}`");
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

pub fn tool_program(nightly: &str, tool: &str) -> Result<std::path::PathBuf> {
    let output = Command::new("rustup")
        .args(["which", "--toolchain", nightly, tool])
        .output()
        .context("locating pinned driver toolchain executable")?;
    if !output.status.success() {
        bail!("pinned driver toolchain executable unavailable");
    }
    Ok(std::path::PathBuf::from(
        std::str::from_utf8(&output.stdout)?.trim(),
    ))
}

/// Run the driver over the workspace and (re)build the `calls`/`uses` edges from
/// its per-unit edge files, then the owner rollups. The driver binary must be
/// built against `nightly` (it links that toolchain's `rustc_driver`).
pub fn add_references_layer(
    graph: &mut Graph,
    meta: &Metadata,
    ws_root: &Utf8Path,
    out: &Utf8Path,
    driver_bin: &Utf8Path,
    nightly: &str,
) -> Result<ReferenceCounts> {
    let out = absolute_path(out)?;
    let driver_bin = absolute_path(driver_bin)?;
    if !driver_bin.as_std_path().exists() {
        bail!(
            "rustc driver not found at {driver_bin} — build it (see crates/bg-driver) \
             and pass --driver-bin"
        );
    }
    let sysroot = sysroot(nightly)?;
    let edges_dir = out.join("driver-refs-v4");
    let flows_dir = out.join("driver-flows-v11");
    let target_dir = out.join("driver-check-v13"); // force all resolved units through the wrapper
    std::fs::create_dir_all(edges_dir.as_std_path()).ok();
    std::fs::create_dir_all(flows_dir.as_std_path()).ok();

    eprintln!(
        "[build-graph] references(driver): cargo +{nightly} check --workspace --all-targets via the rustc driver…"
    );
    let mut cmd = Command::new("cargo");
    cmd.arg(format!("+{nightly}"))
        .args([
            "check",
            "--workspace",
            "--all-targets",
            "--message-format=json-render-diagnostics",
            "--target-dir",
        ])
        .arg(target_dir.as_str())
        .current_dir(ws_root.as_std_path())
        .env("RUSTC_WRAPPER", driver_bin.as_str())
        .env("BG_DRIVER_EDGES", edges_dir.as_str())
        .env("BG_DRIVER_FLOWS", flows_dir.as_str())
        .env(dylib_env(), format!("{sysroot}/lib"));
    free_toolchain(&mut cmd);
    let artifact_index = capture_artifacts(cmd, &out)?;
    for package in &meta.packages {
        let evidence = serde_json::json!({
            "schemaVersion": 1,
            "artifacts": artifact_index.rust_artifacts.iter().filter(|artifact| artifact.package_id == package.id.repr).collect::<Vec<_>>(),
            "scripts": artifact_index.native_links.iter().filter(|script| script.package_id == package.id.repr).collect::<Vec<_>>(),
            "script_report_semantics": "Cargo build-script-executed output report; cached output may be replayed; fresh script execution unproven",
        });
        for node in graph
            .node_values()
            .filter(|node| {
                node.attributes.get("kind").map(String::as_str) == Some("crate")
                    && node.attributes.get("package_id") == Some(&package.id.repr)
            })
            .map(|node| node.id.clone())
            .collect::<Vec<_>>()
        {
            graph
                .node_mut(&node)
                .unwrap()
                .attributes
                .insert("cargo_build_evidence".into(), evidence.to_string());
        }
    }

    let counts = read_reference_edges(graph, &edges_dir)?;
    let workspace: HashSet<_> = meta.workspace_members.iter().collect();
    let targets_by_package: HashMap<String, HashSet<String>> = meta
        .packages
        .iter()
        .filter(|package| workspace.contains(&package.id))
        .map(|package| {
            (
                norm(&package.name),
                package
                    .targets
                    .iter()
                    .map(|target| target.name.replace('-', "_"))
                    .collect(),
            )
        })
        .collect();
    add_flow_nodes_with_artifacts(
        graph,
        Some(meta),
        ws_root,
        &flows_dir,
        &targets_by_package,
        Some(&artifact_index),
    )?;
    Ok(counts)
}

/// Supplied-tools variant of the existing separate driver pass. No discovery
/// or driver build occurs; the original edge reader and partial outcomes apply.
pub fn add_references_layer_selected(
    graph: &mut Graph,
    ws_root: &Utf8Path,
    out: &Utf8Path,
    driver_bin: &Utf8Path,
    selected: &mut crate::cargo_launch::CargoLaunchSession,
) -> Result<ReferenceCounts> {
    let out = absolute_path(out)?;
    let driver_bin = absolute_path(driver_bin)?;
    if !selected.has_explicit_tools() || !driver_bin.as_std_path().is_file() {
        bail!("explicit driver pass requires the supplied tools and prebuilt driver");
    }
    let edges_dir = out.join("driver-refs-v2");
    let target_dir = out.join("driver-check");
    std::fs::create_dir_all(edges_dir.as_std_path()).ok();
    let command =
        selected_reference_command(ws_root, &edges_dir, &target_dir, &driver_bin, selected)?;
    eprintln!(
        "[build-graph] references(driver): selected Cargo check --all-targets via the supplied driver…"
    );
    let mut child = selected.launch_reference_check(command)?;
    let status = child
        .wait()
        .context("waiting for selected Cargo check with the rustc driver")?;
    drop(child);
    if !status.success() {
        bail!("selected Cargo check (driver) failed (exit {status})");
    }
    read_reference_edges(graph, &edges_dir)
}

pub(crate) fn selected_reference_command(
    ws_root: &Utf8Path,
    edges_dir: &Utf8Path,
    target_dir: &Utf8Path,
    driver_bin: &Utf8Path,
    selected: &crate::cargo_launch::CargoLaunchSession,
) -> Result<Command> {
    let mut command = Command::new(&selected.cargo);
    command
        .args(["check", "--all-targets", "--target-dir"])
        .arg(target_dir.as_str())
        .current_dir(ws_root.as_std_path())
        .env("RUSTC_WORKSPACE_WRAPPER", driver_bin.as_str())
        .env("BG_DRIVER_EDGES", edges_dir.as_str());
    selected.configure(&mut command, true);
    selected.configure_explicit_flags(&mut command)?;
    Ok(command)
}

fn read_reference_edges(graph: &mut Graph, edges_dir: &Utf8Path) -> Result<ReferenceCounts> {
    // This layer is a full recompute from the persisted per-unit edge files.
    graph.remove_nodes_with_kind_and_incident_edges("flow_function");
    graph.remove_edges_with_relation("calls");
    graph.remove_edges_with_relation("uses");
    graph.remove_edges_with_relation("member_calls");
    graph.remove_edges_with_relation("member_uses");

    let loc = Locator::build(graph);
    let mut seen: HashSet<(String, String, &str)> = HashSet::new();
    let (mut calls, mut uses) = (0usize, 0usize);
    let mut ambiguous_refs = 0usize;
    for entry in std::fs::read_dir(edges_dir.as_std_path())
        .with_context(|| format!("reading driver edges in {edges_dir}"))?
        .flatten()
    {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("tsv") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        for line in text.lines() {
            let mut it = line.split('\t');
            let (Some(kind), Some(caller), Some(callee)) = (it.next(), it.next(), it.next()) else {
                continue;
            };
            let caller_path = it.next();
            let callee_path = it.next();
            let is_call = kind == "call";
            if caller_path.is_some_and(|path| loc.path_ambiguous(true, path))
                || callee_path.is_some_and(|path| loc.path_ambiguous(is_call, path))
                || (caller_path
                    .and_then(|path| loc.get_path(true, path))
                    .is_none()
                    && loc.location_ambiguous(true, caller))
                || (callee_path
                    .and_then(|path| loc.get_path(is_call, path))
                    .is_none()
                    && loc.location_ambiguous(is_call, callee))
            {
                ambiguous_refs += 1;
                continue;
            }
            // The caller is a fn/method/closure/const-initializer body owner. If
            // it maps to no node (a closure or const init — no Layer-2 item), roll
            // it up to the enclosing function so the edge survives.
            let Some(src) = caller_path
                .and_then(|path| loc.get_path(true, path))
                .or_else(|| loc.get(true, caller))
                .or_else(|| loc.enclosing_fn(caller))
            else {
                continue;
            };
            let Some(dst) = callee_path
                .and_then(|path| loc.get_path(is_call, path))
                .or_else(|| loc.get(is_call, callee))
            else {
                continue;
            };
            if src == dst {
                continue;
            }
            let rel = if is_call { "calls" } else { "uses" };
            let (src, dst) = (src.clone(), dst.clone());
            if seen.insert((src.clone(), dst.clone(), rel)) {
                graph.add_edge(src, dst, rel, None, None);
                if is_call {
                    calls += 1;
                } else {
                    uses += 1;
                }
            }
        }
    }

    eprintln!("[build-graph] references(driver): {ambiguous_refs} ambiguous endpoints skipped");

    let (member_calls, member_uses) = add_member_reference_edges(graph);
    Ok(ReferenceCounts {
        calls,
        uses,
        member_calls,
        member_uses,
    })
}

#[derive(Deserialize)]
struct FlowUnit {
    version: u32,
    krate: String,
    #[serde(default)]
    unit_key: Option<String>,
    #[serde(default)]
    manifest_dir: Option<String>,
    #[serde(default)]
    package_name: Option<String>,
    #[serde(default)]
    package_version: Option<String>,
    #[serde(default)]
    out_dir: Option<String>,
    #[serde(default)]
    crate_root: Option<String>,
    #[serde(default)]
    build_context: Option<serde_json::Value>,
    flows: Vec<FlowRecord>,
}

#[derive(Deserialize)]
struct FlowRecord {
    function: String,
    #[serde(default)]
    compiler_entry: Option<String>,
    #[serde(default)]
    definition_source: Option<serde_json::Value>,
    #[serde(default)]
    function_id: Option<String>,
    owner_kind: String,
    source_file: Option<String>,
    source_location: Option<u32>,
    source_digest: Option<String>,
    #[serde(default)]
    link_symbol: Option<String>,
    #[serde(default)]
    impl_self: Option<String>,
    #[serde(default)]
    impl_trait: Option<String>,
    flow: serde_json::Value,
}

struct PreparedFlow {
    record: FlowRecord,
    rel: String,
    package: String,
    package_id: Option<String>,
    unit_key: Option<String>,
    capture_scope: &'static str,
    target_name: Option<String>,
    target_kind: Vec<String>,
    target_src_path: Option<String>,
    target_artifacts: Vec<String>,
    build_context: Option<serde_json::Value>,
    source_scope: &'static str,
    generated_source: Option<serde_json::Value>,
}

struct FlowTargetIdentity<'a> {
    package_id: &'a str,
    name: &'a str,
    kind: &'a [String],
    src_path: &'a str,
}

fn source_digest(path: &Utf8Path) -> Option<String> {
    let bytes = std::fs::read(path.as_std_path()).ok()?;
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in bytes {
        hash = (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3);
    }
    Some(format!("{hash:016x}"))
}

fn workspace_source_rel<'a>(ws_root: &Utf8Path, source: &'a str) -> Option<(&'a str, String)> {
    let path = Utf8Path::new(source);
    let rel = if path.is_absolute() {
        path.strip_prefix(ws_root).ok()?.as_str()
    } else {
        source.trim_start_matches("./")
    };
    if rel.is_empty() {
        return None;
    }
    let root = std::fs::canonicalize(ws_root.as_std_path()).ok()?;
    let resolved = std::fs::canonicalize(ws_root.join(rel).as_std_path()).ok()?;
    let canonical_rel = resolved.strip_prefix(root).ok()?.to_str()?.to_string();
    Some((rel, canonical_rel))
}

fn manifest_package_for<'a>(roots: &'a [(String, String)], rel: &str) -> Option<&'a String> {
    let mut longest = None;
    let mut package: Option<&String> = None;
    let mut ambiguous = false;
    for (root, candidate) in roots {
        if !root.is_empty() && !rel.starts_with(&format!("{root}/")) {
            continue;
        }
        match longest {
            Some(length) if root.len() < length => continue,
            Some(length) if root.len() == length => {
                if package.is_some_and(|current| current != candidate) {
                    ambiguous = true;
                }
            }
            _ => {
                longest = Some(root.len());
                package = Some(candidate);
                ambiguous = false;
            }
        }
    }
    (!ambiguous).then_some(package).flatten()
}

fn canonical(path: &Utf8Path) -> Option<Utf8PathBuf> {
    Utf8PathBuf::from_path_buf(std::fs::canonicalize(path.as_std_path()).ok()?).ok()
}

fn unit_root_matches(ws_root: &Utf8Path, unit: &FlowUnit, artifact: &RustArtifact) -> bool {
    let Some(root) = unit.crate_root.as_deref() else {
        return false;
    };
    let Some(expected) = canonical(Utf8Path::new(&artifact.target_src_path)) else {
        return false;
    };
    let root = Utf8Path::new(root);
    if root.is_absolute() {
        return canonical(root).as_ref() == Some(&expected);
    }
    canonical(&ws_root.join(root)).as_ref() == Some(&expected)
        || unit.manifest_dir.as_deref().is_some_and(|manifest_dir| {
            canonical(&Utf8Path::new(manifest_dir).join(root)).as_ref() == Some(&expected)
        })
}

fn v2_package<'a>(
    meta: &'a Metadata,
    unit: &FlowUnit,
    artifacts: &ArtifactIndex,
) -> Option<&'a Package> {
    let manifest_dir = canonical(Utf8Path::new(unit.manifest_dir.as_deref()?))?;
    unit.crate_root.as_deref()?;
    let mut matches = meta.packages.iter().filter(|package| {
        package.name == unit.package_name.as_deref().unwrap_or("")
            && package.version.to_string() == unit.package_version.as_deref().unwrap_or("")
            && package.manifest_path.parent().and_then(canonical).as_ref() == Some(&manifest_dir)
            && artifacts.rust_artifacts.iter().any(|artifact| {
                artifact.package_id == package.id.repr
                    && artifact.target_name.replace('-', "_") == unit.krate
                    && unit_root_matches(&meta.workspace_root, unit, artifact)
            })
    });
    let package = matches.next()?;
    matches.next().is_none().then_some(package)
}

fn dependency_source(
    ws_root: &Utf8Path,
    source: &str,
    package: &Package,
    unit: &FlowUnit,
    artifacts: &ArtifactIndex,
) -> Option<Utf8PathBuf> {
    let package_root = canonical(package.manifest_path.parent()?)?;
    let out_dir = unit
        .out_dir
        .as_deref()
        .and_then(|path| canonical(Utf8Path::new(path)));
    let trusted_out = out_dir.as_ref().is_some_and(|out| {
        artifacts.native_links.iter().any(|link| {
            link.package_id == package.id.repr
                && canonical(Utf8Path::new(&link.out_dir)).as_ref() == Some(out)
        })
    });
    let mut paths = Vec::new();
    let source_path = Utf8Path::new(source);
    if source_path.is_absolute() {
        paths.push(source_path.to_path_buf());
    } else {
        paths.push(ws_root.join(source));
        paths.push(package_root.join(source));
    }
    let mut accepted = paths
        .into_iter()
        .filter_map(|path| canonical(&path))
        .filter(|path| {
            path.strip_prefix(&package_root).is_ok()
                || (trusted_out
                    && out_dir
                        .as_ref()
                        .is_some_and(|out| path.strip_prefix(out).is_ok()))
        });
    let first = accepted.next()?;
    accepted.all(|path| path == first).then_some(first)
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum SymbolMatch {
    Mapped(String),
    Ambiguous,
    Unmapped,
}

fn flow_path_segments(path: &str) -> Option<Vec<String>> {
    let mut segments = Vec::new();
    let mut segment = String::new();
    let mut chars = path.chars().peekable();
    let mut depth = 0usize;
    while let Some(ch) = chars.next() {
        if ch == ':' && depth == 0 && chars.peek() == Some(&':') {
            chars.next();
            segments.push(std::mem::take(&mut segment));
            continue;
        }
        if ch == '<' {
            depth += 1;
        } else if ch == '>' {
            depth = depth.checked_sub(1)?;
        }
        segment.push(ch);
    }
    if depth != 0 {
        return None;
    }
    segments.push(segment);
    Some(segments)
}

// Retain the concrete owner of a qualified impl path while removing ordinary
// type arguments. The original compiler path remains the flow identity; a
// rich link is withheld below if multiple bodies reduce to one rich symbol.
fn flow_path_without_generics(path: &str) -> Option<String> {
    let mut plain = Vec::new();
    for segment in flow_path_segments(path)? {
        if let Some(inner) = segment.strip_prefix('<').and_then(|s| s.strip_suffix('>')) {
            if let Some((owner, trait_path)) = inner.split_once(" as ") {
                if owner.is_empty() || trait_path.is_empty() {
                    return None;
                }
                plain.push(flow_path_without_generics(owner)?);
                continue;
            }
            if let Some(owner) = inner.strip_prefix("impl ") {
                plain.push(flow_path_without_generics(owner)?);
                continue;
            }
            if !plain.is_empty() {
                continue;
            }
            return None;
        }
        if let Some((base, _)) = segment.split_once('<') {
            if !base.is_empty() && segment.ends_with('>') && !segment.contains(" as ") {
                plain.push(base.to_string());
                continue;
            }
            return None;
        }
        plain.push(segment);
    }
    Some(plain.join("::"))
}

// rustc's `<impl module::Type>` and `<impl Trait for module::Type>` owners are
// crate-qualified. Their source expansion module is not part of the type
// path; use the full owner only when a rich symbol proves the exact target.
fn qualified_impl_owner_path(path: &str) -> Option<String> {
    let segments = flow_path_segments(path)?;
    let method = segments.last()?;
    let parent = segments.get(segments.len().checked_sub(2)?)?;
    let spec = parent.strip_prefix("<impl ")?.strip_suffix('>')?;
    let mut depth = 0usize;
    let mut separator = None;
    for (index, ch) in spec.char_indices() {
        if depth == 0 && spec[index..].starts_with(" for ") {
            if separator.replace(index).is_some() {
                return None;
            }
        }
        if ch == '<' {
            depth += 1;
        } else if ch == '>' {
            depth = depth.checked_sub(1)?;
        }
    }
    if depth != 0 || (spec.contains(" for ") && separator.is_none()) {
        return None;
    }
    let owner = separator.map_or(spec, |index| &spec[index + " for ".len()..]);
    let owner = flow_path_without_generics(owner)?;
    if !owner.contains("::") {
        return None;
    }
    let context = if segments.first().is_some_and(|part| part == "bin") {
        format!("bin::{}::", segments.get(1)?)
    } else {
        String::new()
    };
    Some(format!("{context}{owner}::{method}"))
}

fn flow_symbol_for(
    graph: &Graph,
    locator: &Locator,
    path: &str,
    rel: &str,
    line: Option<u32>,
    package: &str,
) -> SymbolMatch {
    let name = path.rsplit("::").next();
    let plain_path = flow_path_without_generics(path);
    let eligible = |id: &String| {
        graph.node(id).is_some_and(|node| {
            matches!(
                node.attributes.get("kind").map(String::as_str),
                Some("function" | "method")
            ) && node.source_file.as_deref() == Some(rel)
                && node
                    .attributes
                    .get("crate")
                    .is_some_and(|krate| norm(krate) == norm(package))
                && node
                    .attributes
                    .get("path")
                    .and_then(|p| p.rsplit("::").next())
                    == name
        })
    };
    let same_owner = |id: &&String| {
        let Some(node_path) = graph.node(id).and_then(|node| node.attributes.get("path")) else {
            return false;
        };
        plain_path.as_deref().is_some_and(|plain| {
            plain == node_path.as_str()
                || (!plain.starts_with("bin::")
                    && plain
                        .split_once("::")
                        .is_some_and(|(_, rest)| rest == node_path.as_str()))
        })
    };
    let classify = |ids: Vec<&String>| match ids.as_slice() {
        [id] => SymbolMatch::Mapped((*id).clone()),
        [] => SymbolMatch::Unmapped,
        _ => SymbolMatch::Ambiguous,
    };
    if let Some(ids) = locator.path_fn.get(path) {
        let exact: Vec<_> = ids.iter().filter(|id| eligible(id)).collect();
        if !exact.is_empty() {
            return classify(exact);
        }
    }
    if let Some(plain) = plain_path.as_deref() {
        if let Some(ids) = locator.path_fn.get(plain) {
            let qualified: Vec<_> = ids
                .iter()
                .filter(|id| eligible(id) && same_owner(id))
                .collect();
            if !qualified.is_empty() {
                return classify(qualified);
            }
        }
    }
    if let (Some(owner_path), Some(line)) = (qualified_impl_owner_path(path), line) {
        if let Some(ids) = locator.path_fn.get(&owner_path) {
            let matches: Vec<_> = ids
                .iter()
                .filter(|id| {
                    eligible(id)
                        && graph.node(id).is_some_and(|node| {
                            node.attributes.get("path").map(String::as_str)
                                == Some(owner_path.as_str())
                                && node
                                    .source_location
                                    .is_some_and(|candidate| candidate.abs_diff(line) <= 1)
                        })
                })
                .collect();
            if !matches.is_empty() {
                return classify(matches);
            }
        }
    }
    let Some(line) = line else {
        return SymbolMatch::Unmapped;
    };
    for lines in [
        vec![line],
        vec![line.saturating_sub(1), line.saturating_add(1)],
    ] {
        let mut candidates: Vec<&String> = lines
            .into_iter()
            .filter_map(|line| locator.loc_fn.get(&format!("{rel}:{line}")))
            .flat_map(|ids| ids.iter())
            .filter(|id| eligible(id) && same_owner(id))
            .collect();
        candidates.sort();
        candidates.dedup();
        if !candidates.is_empty() {
            return classify(candidates);
        }
    }
    SymbolMatch::Unmapped
}

fn flow_symbol_for_record(
    graph: &Graph,
    locator: &Locator,
    record: &FlowRecord,
    rel: &str,
    package: &str,
) -> SymbolMatch {
    flow_symbol_for_record_path(graph, locator, record, &record.function, rel, package)
}

fn flow_symbol_for_captured_target(
    graph: &Graph,
    locator: &Locator,
    record: &FlowRecord,
    rel: &str,
    package: &str,
    target: Option<FlowTargetIdentity<'_>>,
) -> SymbolMatch {
    let Some((compiler_target, item_path)) = record
        .function
        .strip_prefix("bin::")
        .and_then(|rest| rest.split_once("::"))
    else {
        return flow_symbol_for_record(graph, locator, record, rel, package);
    };
    let Some(target) = target else {
        return flow_symbol_for_record(graph, locator, record, rel, package);
    };
    if !target.kind.iter().any(|kind| kind == "bin")
        || compiler_target != target.name.replace('-', "_")
    {
        return SymbolMatch::Unmapped;
    }
    // Cargo target names retain hyphens in rustdoc paths; rustc crate names
    // use underscores. Translate only this proven target prefix for matching,
    // leaving compiler function paths and DefPathHash identities unchanged.
    let declaration_path = format!("bin::{}::{item_path}", target.name);
    match flow_symbol_for_record_path(graph, locator, record, &declaration_path, rel, package) {
        SymbolMatch::Mapped(id) => {
            let exact_target = graph.node(&id).is_some_and(|node| {
                node.attributes.get("package_id").map(String::as_str) == Some(target.package_id)
                    && node.attributes.get("target_name").map(String::as_str) == Some(target.name)
                    && node.attributes.get("target_src_path").map(String::as_str)
                        == Some(target.src_path)
                    && node
                        .attributes
                        .get("target_kind")
                        .and_then(|value| serde_json::from_str::<Vec<String>>(value).ok())
                        .as_deref()
                        == Some(target.kind)
            });
            if exact_target {
                SymbolMatch::Mapped(id)
            } else {
                SymbolMatch::Unmapped
            }
        }
        other => other,
    }
}

fn flow_symbol_for_record_path(
    graph: &Graph,
    locator: &Locator,
    record: &FlowRecord,
    function: &str,
    rel: &str,
    package: &str,
) -> SymbolMatch {
    let (Some(self_type), Some(trait_name), Some(line)) = (
        record.impl_self.as_deref(),
        record.impl_trait.as_deref(),
        record.source_location,
    ) else {
        // An unqualified fallback can erase the trait owner and bind a trait
        // method to an inherent same-named method on the same source line.
        // Old records and unsupported identity shapes remain unlinked here.
        let trait_impl = flow_path_segments(function).is_some_and(|segments| {
            segments
                .get(segments.len().saturating_sub(2))
                .is_some_and(|segment| {
                    segment.starts_with('<')
                        && (segment.contains(" as ") || segment.contains(" for "))
                })
        });
        if trait_impl {
            return SymbolMatch::Unmapped;
        }
        return flow_symbol_for(
            graph,
            locator,
            function,
            rel,
            record.source_location,
            package,
        );
    };
    let name = function.rsplit("::").next();
    let binary = function
        .strip_prefix("bin::")
        .and_then(|rest| rest.split_once("::"))
        .map(|(target, _)| format!("bin::{target}::"));
    let Some(ids) = locator.loc_fn.get(&format!("{rel}:{line}")) else {
        return SymbolMatch::Unmapped;
    };
    let mut matches: Vec<_> = ids
        .iter()
        .filter(|id| {
            graph.node(id).is_some_and(|node| {
                node.attributes.get("kind").map(String::as_str) == Some("method")
                    && node.source_file.as_deref() == Some(rel)
                    && node
                        .attributes
                        .get("crate")
                        .is_some_and(|krate| norm(krate) == norm(package))
                    && node.label.as_str() == name.unwrap_or("")
                    && node.attributes.get("impl_self").map(String::as_str) == Some(self_type)
                    && node.attributes.get("impl_trait").map(String::as_str) == Some(trait_name)
                    && node
                        .attributes
                        .get("path")
                        .is_some_and(|path| match &binary {
                            Some(prefix) => path.starts_with(prefix),
                            None => !path.starts_with("bin::"),
                        })
            })
        })
        .collect();
    matches.sort();
    matches.dedup();
    match matches.as_slice() {
        [id] => SymbolMatch::Mapped((*id).clone()),
        [] => SymbolMatch::Unmapped,
        _ => SymbolMatch::Ambiguous,
    }
}

fn hex_bytes(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len() * 2);
    for byte in value.bytes() {
        encoded.push_str(&format!("{byte:02x}"));
    }
    encoded
}

fn compact_flow_token(value: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in value.bytes() {
        hash = (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn graph_flow_path(item: &PreparedFlow) -> String {
    if item.capture_scope == "workspace" {
        return item.record.function.clone();
    }
    let identity = format!(
        "{}\0{}\0{}",
        item.package_id.as_deref().unwrap_or(""),
        item.unit_key.as_deref().unwrap_or(""),
        item.record.function_id.as_deref().unwrap_or("")
    );
    format!("dep::{}", compact_flow_token(&identity))
}

fn flow_target_ids(flow: &serde_json::Value) -> Vec<String> {
    let mut targets = Vec::new();
    if let Some(blocks) = flow["blocks"].as_array() {
        for block in blocks {
            if let Some(id) = block["callee_id"].as_str() {
                targets.push(id.to_string());
            }
            if let Some(references) = block["callback_references"].as_array() {
                for reference in references {
                    if let Some(methods) = reference["targets"].as_array() {
                        for method in methods {
                            if let Some(id) = method["function_id"].as_str() {
                                targets.push(id.to_string());
                            }
                        }
                    }
                }
            }
        }
    }
    targets
}

fn flow_local_target_paths(flow: &serde_json::Value) -> Vec<String> {
    let mut targets = Vec::new();
    if let Some(blocks) = flow["blocks"].as_array() {
        for block in blocks {
            if let Some(paths) = block["callee_targets"].as_array() {
                targets.extend(
                    paths
                        .iter()
                        .filter_map(|path| path.as_str().map(str::to_string)),
                );
            }
            if let Some(args) = block["callback_args"].as_array() {
                for arg in args {
                    if let Some(paths) = arg["targets"].as_array() {
                        targets.extend(
                            paths
                                .iter()
                                .filter_map(|path| path.as_str().map(str::to_string)),
                        );
                    }
                }
            }
        }
    }
    targets
}

fn artifact_packages(index: &ArtifactIndex) -> HashMap<String, Option<String>> {
    let mut owners = HashMap::new();
    for artifact in &index.rust_artifacts {
        for filename in &artifact.filenames {
            let Some(path) = canonical(Utf8Path::new(filename)) else {
                continue;
            };
            owners
                .entry(path.to_string())
                .and_modify(|owner: &mut Option<String>| {
                    if owner.as_deref() != Some(&artifact.package_id) {
                        *owner = None;
                    }
                })
                .or_insert_with(|| Some(artifact.package_id.clone()));
        }
    }
    owners
}

fn add_flow_nodes(
    graph: &mut Graph,
    ws_root: &Utf8Path,
    dir: &Utf8Path,
    targets_by_package: &HashMap<String, HashSet<String>>,
) -> Result<usize> {
    add_flow_nodes_with_artifacts(graph, None, ws_root, dir, targets_by_package, None)
}

fn add_flow_nodes_with_artifacts(
    graph: &mut Graph,
    meta: Option<&Metadata>,
    ws_root: &Utf8Path,
    dir: &Utf8Path,
    targets_by_package: &HashMap<String, HashSet<String>>,
    artifacts: Option<&ArtifactIndex>,
) -> Result<usize> {
    // Current file nodes and symbol nodes are the live catalog. A persisted
    // unit can only contribute bodies still associated with this graph.
    let mut files: HashMap<String, Vec<String>> = HashMap::new();
    let mut manifest_roots = Vec::new();
    for node in graph.node_values() {
        let kind = node.attributes.get("kind").map(String::as_str);
        if let (Some(path), Some(pkg)) = (node.source_file.as_ref(), node.attributes.get("crate")) {
            if kind == Some("file") {
                files.entry(path.clone()).or_default().push(pkg.clone());
            } else if kind == Some("crate") {
                if let Some(root) = workspace_source_rel(ws_root, path)
                    .map(|(rel, _)| rel)
                    .filter(|path| Utf8Path::new(path).file_name() == Some("Cargo.toml"))
                    .and_then(|path| Utf8Path::new(path).parent())
                {
                    let root = if root.as_str() == "." {
                        ""
                    } else {
                        root.as_str()
                    };
                    manifest_roots.push((root.to_string(), pkg.clone()));
                }
            }
        }
    }
    let locator = Locator::build(graph);
    let mut entries: Vec<_> = std::fs::read_dir(dir.as_std_path())
        .with_context(|| format!("reading driver flows in {dir}"))?
        .flatten()
        .filter(|entry| entry.path().extension().and_then(|e| e.to_str()) == Some("json"))
        .collect();
    // Multiple target variants can define the same function. Choose a stable
    // filename order and diagnose differing bodies instead of selecting by
    // race-dependent mtime.
    entries.sort_by_key(|entry| entry.path());
    let mut seen: HashMap<String, (String, String)> = HashMap::new();
    let mut digests: HashMap<String, Option<String>> = HashMap::new();
    let mut package_counts: HashMap<(String, &'static str), (usize, usize, usize)> = HashMap::new();
    let mut prepared_units = Vec::new();
    let mut build_units: HashMap<String, Vec<serde_json::Value>> = HashMap::new();
    let (mut added, mut mapped, mut ambiguous, mut skipped, mut duplicates) =
        (0usize, 0usize, 0usize, 0usize, 0usize);
    for entry in entries {
        let unit_path = entry.path().display().to_string();
        let Ok(text) = std::fs::read_to_string(entry.path()) else {
            continue;
        };
        let Ok(mut unit) = serde_json::from_str::<FlowUnit>(&text) else {
            continue;
        };
        if unit.version != 1 && unit.version != 2 {
            continue;
        }
        let unit_package = if unit.version == 2 {
            meta.zip(artifacts)
                .and_then(|(meta, artifacts)| v2_package(meta, &unit, artifacts))
        } else {
            None
        };
        if unit.version == 2 && (unit_package.is_none() || unit.unit_key.is_none()) {
            skipped += unit.flows.len();
            continue;
        }
        let unit_artifacts: Vec<&RustArtifact> = unit_package
            .zip(artifacts)
            .map(|(package, artifacts)| {
                artifacts
                    .rust_artifacts
                    .iter()
                    .filter(|artifact| {
                        artifact.package_id == package.id.repr
                            && artifact.target_name.replace('-', "_") == unit.krate
                            && unit_root_matches(ws_root, &unit, artifact)
                    })
                    .collect()
            })
            .unwrap_or_default();
        if unit.version == 2
            && (unit_artifacts.is_empty()
                || unit_artifacts.iter().any(|artifact| {
                    artifact.target_kind != unit_artifacts[0].target_kind
                        || artifact.target_name != unit_artifacts[0].target_name
                        || artifact.target_src_path != unit_artifacts[0].target_src_path
                }))
        {
            skipped += unit.flows.len();
            continue;
        }
        if let Some(package) = unit_package {
            build_units.entry(package.id.repr.clone()).or_default().push(serde_json::json!({
                "unit_key": unit.unit_key,
                "target_name": unit_artifacts[0].target_name,
                "target_kind": unit_artifacts[0].target_kind,
                "target_src_path": unit_artifacts[0].target_src_path,
                "context": unit.build_context,
                "body_capture": "candidate bodies require source-digest validation and exact compiler identity resolution",
            }));
        }
        let workspace_unit = unit_package.is_none_or(|package| {
            meta.is_none_or(|meta| meta.workspace_members.contains(&package.id))
        });
        let build_target = unit_artifacts.first().is_some_and(|artifact| {
            artifact
                .target_kind
                .iter()
                .any(|kind| kind == "custom-build" || kind == "proc-macro")
        });
        let capture_scope = if workspace_unit {
            "workspace"
        } else if build_target {
            "build_dependency"
        } else {
            "runtime_dependency"
        };
        if let Some(package) = unit_package {
            package_counts
                .entry((package.id.repr.clone(), capture_scope))
                .or_default()
                .0 += unit.flows.len();
        }
        let mut target_artifacts: Vec<String> = unit_artifacts
            .iter()
            .flat_map(|artifact| artifact.filenames.iter().cloned())
            .collect();
        target_artifacts.sort();
        target_artifacts.dedup();
        let mut prepared = Vec::new();
        for record in std::mem::take(&mut unit.flows) {
            if record.flow["version"] != 1
                || record.flow["function"] != record.function
                || !record.flow["blocks"].is_array()
                || record
                    .function_id
                    .as_deref()
                    .is_some_and(|id| record.flow["function_id"].as_str() != Some(id))
                || !(record.function.starts_with(&format!("{}::", unit.krate))
                    || record
                        .function
                        .starts_with(&format!("bin::{}::", unit.krate)))
            {
                skipped += 1;
                continue;
            }
            let Some(source) = record.source_file.as_deref() else {
                skipped += 1;
                continue;
            };
            let scoped_source = unit_package.and_then(|package| {
                artifacts.and_then(|artifacts| {
                    dependency_source(ws_root, source, package, &unit, artifacts)
                })
            });
            let out_source = scoped_source.as_ref().is_some_and(|path| {
                unit.out_dir
                    .as_deref()
                    .and_then(|out| canonical(Utf8Path::new(out)))
                    .is_some_and(|out| path.strip_prefix(out).is_ok())
            });
            let (rel, canonical_rel, path) = if workspace_unit && !out_source {
                let Some((rel, canonical_rel)) = workspace_source_rel(ws_root, source) else {
                    skipped += 1;
                    continue;
                };
                (rel.to_string(), canonical_rel, ws_root.join(rel))
            } else {
                let Some(path) = scoped_source else {
                    skipped += 1;
                    continue;
                };
                (path.to_string(), String::new(), path)
            };
            let digest = digests
                .entry(path.to_string())
                .or_insert_with(|| source_digest(&path));
            if digest.is_none() || record.source_digest.as_ref() != digest.as_ref() {
                skipped += 1;
                continue;
            }
            let package = if let Some(package) = unit_package {
                Some(&package.name)
            } else if let Some(packages) = files.get(&rel) {
                packages
                    .iter()
                    .find(|pkg| norm(pkg) == norm(&unit.krate))
                    .or_else(|| (packages.len() == 1).then(|| &packages[0]))
            } else {
                manifest_package_for(&manifest_roots, &rel)
            };
            let Some(package) = package else {
                skipped += 1;
                continue;
            };
            if unit.version == 2
                && workspace_unit
                && !out_source
                && !files.contains_key(&rel)
                && manifest_package_for(&manifest_roots, &canonical_rel).is_none()
            {
                skipped += 1;
                continue;
            }
            if unit.version == 1
                && !targets_by_package
                    .get(&norm(package))
                    .is_some_and(|targets| targets.contains(&unit.krate))
            {
                skipped += 1;
                continue;
            }
            if workspace_unit
                && !out_source
                && manifest_package_for(&manifest_roots, &canonical_rel)
                    .is_some_and(|canonical_owner| canonical_owner != package)
            {
                let linked = match flow_symbol_for_captured_target(
                    graph,
                    &locator,
                    &record,
                    &rel,
                    package,
                    unit_artifacts.first().map(|artifact| FlowTargetIdentity {
                        package_id: &artifact.package_id,
                        name: &artifact.target_name,
                        kind: &artifact.target_kind,
                        src_path: &artifact.target_src_path,
                    }),
                ) {
                    SymbolMatch::Mapped(id) => graph
                        .node(&id)
                        .and_then(|node| node.attributes.get("has_body"))
                        .is_some_and(|has_body| has_body == "true"),
                    _ => false,
                };
                if !linked {
                    skipped += 1;
                    continue;
                }
            }
            let generated_source = record.definition_source.as_ref().and_then(|origin| {
                let file = origin["source_file"].as_str()?;
                let digest = origin["source_digest"].as_str()?;
                let path = unit_package.and_then(|package| artifacts.and_then(|artifacts| dependency_source(ws_root, file, package, &unit, artifacts)))?;
                let out = unit.out_dir.as_deref().and_then(|out| canonical(Utf8Path::new(out)))?;
                if path.strip_prefix(out).is_err() || source_digest(&path).as_deref() != Some(digest) { return None; }
                Some(serde_json::json!({"source_file":path,"source_location":origin["source_location"],"source_digest":digest,
                    "evidence":"compiler-definition-span validated against source digest; Cargo OUT_DIR scope, writer unknown"}))
            });
            let package = package.clone();
            prepared.push(PreparedFlow {
                record,
                rel,
                package,
                package_id: unit_package.map(|package| package.id.repr.clone()),
                unit_key: unit.unit_key.clone(),
                capture_scope,
                target_name: unit_artifacts
                    .first()
                    .map(|artifact| artifact.target_name.clone()),
                target_kind: unit_artifacts
                    .first()
                    .map(|artifact| artifact.target_kind.clone())
                    .unwrap_or_default(),
                target_src_path: unit_artifacts
                    .first()
                    .map(|artifact| artifact.target_src_path.clone()),
                target_artifacts: target_artifacts.clone(),
                build_context: unit.build_context.clone(),
                source_scope: if out_source {
                    "cargo-out-dir-reference"
                } else {
                    "package-source-reference"
                },
                generated_source,
            });
        }
        prepared_units.push((unit_path, prepared));
    }
    let mut by_function_id: HashMap<String, Vec<(usize, usize)>> = HashMap::new();
    let mut by_unit_path: Vec<HashMap<String, Vec<usize>>> = Vec::new();
    let mut imported = HashSet::new();
    let mut queue = VecDeque::new();
    for (unit_index, (_, prepared)) in prepared_units.iter().enumerate() {
        let mut paths: HashMap<String, Vec<usize>> = HashMap::new();
        for (record_index, item) in prepared.iter().enumerate() {
            if let Some(id) = &item.record.function_id {
                by_function_id
                    .entry(id.clone())
                    .or_default()
                    .push((unit_index, record_index));
            }
            paths
                .entry(item.record.function.clone())
                .or_default()
                .push(record_index);
            if item.capture_scope == "workspace" || item.capture_scope == "build_dependency" {
                imported.insert((unit_index, record_index));
                queue.push_back((unit_index, record_index));
            }
        }
        by_unit_path.push(paths);
    }
    while let Some((unit_index, record_index)) = queue.pop_front() {
        let flow = &prepared_units[unit_index].1[record_index].record.flow;
        for id in flow_target_ids(flow) {
            let Some(locations) = by_function_id.get(&id) else {
                continue;
            };
            if let [location] = locations.as_slice() {
                if imported.insert(*location) {
                    queue.push_back(*location);
                }
            }
        }
        for path in flow_local_target_paths(flow) {
            let Some(locations) = by_unit_path[unit_index].get(&path) else {
                continue;
            };
            if let [local_index] = locations.as_slice() {
                let location = (unit_index, *local_index);
                if imported.insert(location) {
                    queue.push_back(location);
                }
            }
        }
    }
    for (unit_index, (_, prepared)) in prepared_units.iter().enumerate() {
        for (record_index, item) in prepared.iter().enumerate() {
            if let Some(package_id) = &item.package_id {
                let entry = package_counts
                    .entry((package_id.clone(), item.capture_scope))
                    .or_default();
                entry.1 += 1;
                entry.2 += usize::from(imported.contains(&(unit_index, record_index)));
            }
        }
    }
    if let Some(parent) = dir.parent() {
        let mut counts: Vec<_> = package_counts.into_iter().collect();
        counts.sort_by(|left, right| left.0.cmp(&right.0));
        let mut scopes_by_package: HashMap<String, Vec<serde_json::Value>> = HashMap::new();
        for ((package_id, capture_scope), (captured, validated, imported)) in &counts {
            scopes_by_package
                .entry(package_id.clone())
                .or_default()
                .push(serde_json::json!({
                    "capture_scope": capture_scope,
                    "captured": captured,
                    "validated": validated,
                    "imported": imported,
                }));
        }
        let package_nodes: HashMap<String, String> = graph
            .node_values()
            .filter(|node| node.attributes.get("kind").map(String::as_str) == Some("crate"))
            .filter_map(|node| {
                node.attributes
                    .get("package_id")
                    .map(|id| (id.clone(), node.id.clone()))
            })
            .collect();
        for (package_id, scopes) in scopes_by_package {
            if let Some(node) = package_nodes
                .get(&package_id)
                .and_then(|id| graph.node_mut(id))
            {
                node.attributes.insert(
                    "capture_summary".into(),
                    serde_json::json!({
                        "policy": "workspace_and_compiler_reachable_dependencies",
                        "scopes": scopes,
                    })
                    .to_string(),
                );
            }
        }
        let report: Vec<_> = counts
            .into_iter()
            .map(
                |((package_id, capture_scope), (captured, validated, imported))| {
                    serde_json::json!({
                        "package_id": package_id,
                        "captured": captured,
                        "validated": validated,
                        "imported": imported,
                        "capture_scope": capture_scope,
                    })
                },
            )
            .collect();
        std::fs::write(
            parent.join("driver-import-report-v1.json"),
            serde_json::to_vec_pretty(&report)?,
        )?;
    }
    // Keep multiple compiler variants of a workspace body separate. A package
    // name or identical host/target triple must never merge logical units.
    let mut workspace_variants: HashMap<String, HashSet<String>> = HashMap::new();
    for location in &imported {
        let item = &prepared_units[location.0].1[location.1];
        if item.capture_scope == "workspace" {
            workspace_variants
                .entry(item.record.function.clone())
                .or_default()
                .insert(item.unit_key.clone().unwrap_or_default());
        }
    }
    let canonical_paths: HashMap<(usize, usize), String> = imported
        .iter()
        .map(|location| {
            let item = &prepared_units[location.0].1[location.1];
            let path = if workspace_variants
                .get(&item.record.function)
                .is_some_and(|units| units.len() > 1)
            {
                format!(
                    "unit::{}",
                    hex_bytes(&format!(
                        "{}\0{}\0{}",
                        item.package_id.as_deref().unwrap_or(""),
                        item.unit_key.as_deref().unwrap_or(""),
                        item.record
                            .function_id
                            .as_deref()
                            .unwrap_or(&item.record.function)
                    ))
                )
            } else {
                graph_flow_path(item)
            };
            (*location, path)
        })
        .collect();
    let function_ids: HashMap<(usize, usize), String> = imported
        .iter()
        .filter_map(|location| {
            prepared_units[location.0].1[location.1]
                .record
                .function_id
                .as_ref()
                .map(|id| (*location, id.clone()))
        })
        .collect();
    let mut namespace_owners = HashMap::<String, (String, String, String)>::new();
    for location in &imported {
        let item = &prepared_units[location.0].1[location.1];
        if item.capture_scope == "workspace" {
            continue;
        }
        let path = &canonical_paths[location];
        let identity = (
            item.package_id.clone().unwrap_or_default(),
            item.unit_key.clone().unwrap_or_default(),
            item.record.function_id.clone().unwrap_or_default(),
        );
        if let Some(previous) = namespace_owners.insert(path.clone(), identity.clone()) {
            if previous != identity {
                bail!("dependency flow namespace collision at {path}");
            }
        }
    }
    let package_ids: HashMap<(usize, usize), String> = imported
        .iter()
        .filter_map(|location| {
            prepared_units[location.0].1[location.1]
                .package_id
                .as_ref()
                .map(|id| (*location, id.clone()))
        })
        .collect();
    let artifact_owners = artifacts.map(artifact_packages).unwrap_or_default();
    // `item_id` normalizes case and punctuation. Find collisions only among
    // validated bodies, then give every distinct exact path in a collision
    // group an injective suffix. Ordinary flow IDs remain unchanged.
    let mut normalized_paths: HashMap<String, HashSet<(String, String)>> = HashMap::new();
    for (unit_index, (_, prepared)) in prepared_units.iter().enumerate() {
        for (record_index, item) in prepared.iter().enumerate() {
            if !imported.contains(&(unit_index, record_index)) {
                continue;
            }
            normalized_paths
                .entry(item_id(
                    &item.package,
                    &canonical_paths[&(unit_index, record_index)],
                    "flow_function",
                ))
                .or_default()
                .insert((
                    item.package.clone(),
                    canonical_paths[&(unit_index, record_index)].clone(),
                ));
        }
    }
    let mut imported_node_ids: HashMap<(usize, usize), String> = HashMap::new();
    for (unit_index, (unit_path, prepared)) in prepared_units.into_iter().enumerate() {
        // Keep every validated body. A rich symbol link requires a unique
        // candidate; same-line macro expansions must not depend on node order.
        let mut owner_symbols = HashMap::new();
        for item in &prepared {
            if !matches!(item.record.owner_kind.as_str(), "Fn" | "AssocFn") {
                continue;
            }
            let target = item
                .package_id
                .as_deref()
                .zip(item.target_name.as_deref())
                .zip(item.target_src_path.as_deref())
                .map(|((package_id, name), src_path)| FlowTargetIdentity {
                    package_id,
                    name,
                    kind: &item.target_kind,
                    src_path,
                });
            let symbol = if workspace_variants
                .get(&item.record.function)
                .is_some_and(|units| units.len() > 1)
            {
                // A single rustdoc declaration cannot own two compiler unit
                // variants. Keep their flow identities and roles separate.
                SymbolMatch::Ambiguous
            } else {
                flow_symbol_for_captured_target(
                    graph,
                    &locator,
                    &item.record,
                    &item.rel,
                    &item.package,
                    target,
                )
            };
            owner_symbols.insert(item.record.function.clone(), symbol);
        }
        let mut symbol_claims: HashMap<String, usize> = HashMap::new();
        for symbol in owner_symbols.values() {
            if let SymbolMatch::Mapped(id) = symbol {
                *symbol_claims.entry(id.clone()).or_default() += 1;
            }
        }
        for symbol in owner_symbols.values_mut() {
            if let SymbolMatch::Mapped(id) = symbol {
                if symbol_claims.get(id).copied().unwrap_or(0) > 1 {
                    *symbol = SymbolMatch::Ambiguous;
                }
            }
        }
        for (
            record_index,
            PreparedFlow {
                mut record,
                rel,
                package,
                package_id,
                unit_key,
                capture_scope,
                target_name,
                target_kind,
                target_src_path,
                target_artifacts,
                build_context,
                source_scope,
                generated_source,
            },
        ) in prepared.into_iter().enumerate()
        {
            if !imported.contains(&(unit_index, record_index)) {
                continue;
            }
            let canonical_path = &canonical_paths[&(unit_index, record_index)];
            let mut id = item_id(&package, canonical_path, "flow_function");
            if normalized_paths
                .get(&id)
                .is_some_and(|paths| paths.len() > 1)
            {
                id.push_str("__exact_");
                id.push_str(&hex_bytes(&format!("{package}\0{canonical_path}")));
            }
            let symbol = match record.owner_kind.as_str() {
                "Fn" | "AssocFn" => owner_symbols
                    .get(&record.function)
                    .cloned()
                    .unwrap_or(SymbolMatch::Unmapped),
                "Closure" | "SyntheticCoroutineBody" => {
                    let mut prefix = record.function.as_str();
                    let mut found = SymbolMatch::Unmapped;
                    while let Some((parent, _)) = prefix.rsplit_once("::") {
                        if let Some(symbol) = owner_symbols.get(parent) {
                            found = symbol.clone();
                            break;
                        }
                        prefix = parent;
                    }
                    found
                }
                _ => SymbolMatch::Unmapped,
            };
            let original_path = record.function.clone();
            record.flow["function"] = serde_json::json!(canonical_path);
            if canonical_path != &original_path {
                record.flow["display_path"] = serde_json::json!(original_path);
            }
            if let Some(blocks) = record.flow["blocks"].as_array_mut() {
                for block in blocks {
                    let artifact_package = block["callee_artifact"]
                        .as_str()
                        .and_then(|path| artifact_owners.get(path))
                        .and_then(Option::as_ref)
                        .cloned();
                    let id_target = block["callee_id"]
                        .as_str()
                        .and_then(|id| by_function_id.get(id))
                        .and_then(|locations| match locations.as_slice() {
                            [location] if canonical_paths.contains_key(location) => Some(*location),
                            _ => None,
                        });
                    let id_package = id_target
                        .and_then(|location| package_ids.get(&location))
                        .cloned();
                    let local_foreign_package =
                        (block["native_call"]["declaration_local"].as_bool() == Some(true))
                            .then(|| package_id.clone())
                            .flatten();
                    if artifact_package.as_ref().is_some_and(|artifact| {
                        id_package.as_ref().is_some_and(|target| target != artifact)
                    }) || local_foreign_package.as_ref().is_some_and(|local| {
                        artifact_package
                            .as_ref()
                            .is_some_and(|artifact| artifact != local)
                            || id_package.as_ref().is_some_and(|target| target != local)
                    }) {
                        block["callee_resolution"] =
                            serde_json::json!("artifact_identity_conflict");
                    } else {
                        if let Some(target) = id_target {
                            if let Some(original) = block["callee"].as_str().map(str::to_string) {
                                block["callee_display"] = serde_json::json!(original);
                            }
                            block["callee"] = serde_json::json!(canonical_paths[&target]);
                        }
                        if let Some(package_id) =
                            artifact_package.or(id_package).or(local_foreign_package)
                        {
                            block["callee_package_id"] = serde_json::json!(package_id);
                        }
                    }
                    if let Some(references) = block["callback_references"].as_array_mut() {
                        for reference in references {
                            if let Some(targets) = reference["targets"].as_array_mut() {
                                for target in targets {
                                    let location = target["function_id"]
                                        .as_str()
                                        .and_then(|id| by_function_id.get(id))
                                        .and_then(|locations| match locations.as_slice() {
                                            [location]
                                                if canonical_paths.contains_key(location) =>
                                            {
                                                Some(*location)
                                            }
                                            _ => None,
                                        });
                                    if let Some(location) = location {
                                        target["display_path"] = target["function"].clone();
                                        target["function"] =
                                            serde_json::json!(canonical_paths[&location]);
                                    }
                                }
                            }
                        }
                    }
                    if let Some(paths) = block["callee_targets"].as_array().cloned() {
                        let display_paths = paths.clone();
                        let mut rewritten = Vec::new();
                        let mut ids = Vec::new();
                        for path in paths {
                            let location = path
                                .as_str()
                                .and_then(|path| by_unit_path[unit_index].get(path))
                                .and_then(|locations| match locations.as_slice() {
                                    [index] => Some((unit_index, *index)),
                                    _ => None,
                                });
                            if let Some(location) =
                                location.filter(|location| canonical_paths.contains_key(location))
                            {
                                rewritten.push(serde_json::json!(canonical_paths[&location]));
                                if let Some(id) = function_ids.get(&location) {
                                    ids.push(serde_json::json!(id));
                                }
                            } else {
                                rewritten.push(path);
                            }
                        }
                        block["callee_targets"] = serde_json::Value::Array(rewritten);
                        if !ids.is_empty() {
                            block["callee_display_targets"] =
                                serde_json::Value::Array(display_paths);
                            block["callee_target_ids"] = serde_json::Value::Array(ids);
                        }
                    }
                    if let Some(args) = block["callback_args"].as_array_mut() {
                        for arg in args {
                            let Some(paths) = arg["targets"].as_array().cloned() else {
                                continue;
                            };
                            let mut rewritten = Vec::new();
                            let mut ids = Vec::new();
                            for path in &paths {
                                let location = path
                                    .as_str()
                                    .and_then(|path| by_unit_path[unit_index].get(path))
                                    .and_then(|locations| match locations.as_slice() {
                                        [index] => Some((unit_index, *index)),
                                        _ => None,
                                    });
                                if let Some(location) = location
                                    .filter(|location| canonical_paths.contains_key(location))
                                {
                                    rewritten.push(serde_json::json!(canonical_paths[&location]));
                                    if let Some(id) = function_ids.get(&location) {
                                        ids.push(serde_json::json!(id));
                                    }
                                } else {
                                    rewritten.push(path.clone());
                                }
                            }
                            if !ids.is_empty() {
                                arg["display_targets"] = serde_json::Value::Array(paths);
                                arg["targets"] = serde_json::Value::Array(rewritten);
                                arg["target_ids"] = serde_json::Value::Array(ids);
                            }
                        }
                    }
                }
            }
            let flow_json = serde_json::to_string(&record.flow)?;
            if let Some((first_json, first_path)) = seen.get(&id) {
                if first_json != &flow_json {
                    eprintln!(
                        "[build-graph] flow variant conflict for {}: using {}, ignoring {}",
                        record.function, first_path, unit_path
                    );
                }
                duplicates += 1;
                continue;
            }
            seen.insert(id.clone(), (flow_json.clone(), unit_path.clone()));
            let mut node = Node::new(
                id.clone(),
                record
                    .function
                    .rsplit("::")
                    .next()
                    .unwrap_or(&record.function),
                "flow_function",
            )
            .with_source(Some(rel.to_string()), record.source_location)
            .attr("crate", package)
            .attr("path", canonical_path)
            .attr("display_path", &original_path)
            .attr("language", "rust")
            .attr("capture_scope", capture_scope)
            .attr("source_reference_kind", source_scope)
            .attr("flow", flow_json)
            .attr(
                "source_digest",
                record.source_digest.as_deref().unwrap_or(""),
            );
            if let Some(reference) = &generated_source {
                node = node.attr("generated_source_reference", reference.to_string());
            }
            if let Some(context) = &build_context {
                node = node.attr("build_context", context.to_string());
            }
            if let Some(entry) = &record.compiler_entry {
                node = node.attr("compiler_entry", entry);
            }
            if let Some(function_id) = &record.function_id {
                node = node.attr("function_id", function_id);
            }
            if let Some(package_id) = &package_id {
                node = node.attr("package_id", package_id);
            }
            if let Some(unit_key) = &unit_key {
                node = node.attr("unit_key", unit_key);
            }
            if let Some(link_symbol) = &record.link_symbol {
                node = node.attr("link_symbol", link_symbol);
            }
            if let Some(target_name) = &target_name {
                node = node.attr("target_name", target_name);
            }
            if let Some(target_src_path) = &target_src_path {
                node = node.attr("target_src_path", target_src_path);
            }
            if !target_kind.is_empty() {
                node = node.attr("target_kind", serde_json::to_string(&target_kind)?);
            }
            if !target_artifacts.is_empty() {
                node = node.attr(
                    "target_artifacts",
                    serde_json::to_string(&target_artifacts)?,
                );
            }
            match symbol {
                SymbolMatch::Mapped(symbol) => {
                    node = node
                        .attr("mapping_status", "mapped")
                        .attr("symbol_id", &symbol);
                    graph.add_edge(symbol, id.clone(), "has_flow", None, None);
                    mapped += 1;
                }
                SymbolMatch::Ambiguous => {
                    node = node.attr("mapping_status", "ambiguous");
                    ambiguous += 1;
                }
                SymbolMatch::Unmapped => node = node.attr("mapping_status", "unmapped"),
            }
            graph.add_node(node);
            imported_node_ids.insert((unit_index, record_index), id);
            added += 1;
        }
    }
    let package_nodes: HashMap<String, String> = graph
        .node_values()
        .filter(|node| node.attributes.get("kind").map(String::as_str) == Some("crate"))
        .filter_map(|node| {
            node.attributes
                .get("package_id")
                .map(|id| (id.clone(), node.id.clone()))
        })
        .collect();
    for (package_id, mut units) in build_units {
        units.sort_by(|a, b| a["unit_key"].as_str().cmp(&b["unit_key"].as_str()));
        if let Some(node) = package_nodes
            .get(&package_id)
            .and_then(|id| graph.node_mut(id))
        {
            node.attributes.insert(
                "build_units".into(),
                serde_json::json!({ "schemaVersion": 1, "units": units }).to_string(),
            );
        }
    }
    let mut direct_edges = Vec::new();
    let mut contains_edges = Vec::new();
    for (location, node_id) in &imported_node_ids {
        if let Some(package_id) = package_ids.get(location) {
            if let Some(package_node) = package_nodes.get(package_id) {
                contains_edges.push((package_node.clone(), node_id.clone()));
            }
        }
        let Some(node) = graph.node(node_id) else {
            continue;
        };
        let source = node
            .attributes
            .get("symbol_id")
            .cloned()
            .unwrap_or_else(|| node_id.clone());
        let Some(flow) = node
            .attributes
            .get("flow")
            .and_then(|json| serde_json::from_str::<serde_json::Value>(json).ok())
        else {
            continue;
        };
        let Some(blocks) = flow["blocks"].as_array() else {
            continue;
        };
        for block in blocks {
            if !matches!(block["kind"].as_str(), Some("call" | "tail_call")) {
                continue;
            }
            let Some(targets) = block["callee_id"]
                .as_str()
                .and_then(|id| by_function_id.get(id))
            else {
                continue;
            };
            let [target_location] = targets.as_slice() else {
                continue;
            };
            let Some(target_id) = imported_node_ids.get(target_location) else {
                continue;
            };
            let target = graph
                .node(target_id)
                .and_then(|node| node.attributes.get("symbol_id"))
                .cloned()
                .unwrap_or_else(|| target_id.clone());
            if source != target {
                direct_edges.push((source.clone(), target));
            }
        }
    }
    for (package, callable) in contains_edges {
        graph.add_edge(package, callable, "contains", None, None);
    }
    for (source, target) in direct_edges {
        graph.add_edge(source, target, "calls", None, None);
    }
    eprintln!(
        "[build-graph] flow import: {added} validated bodies, {mapped} mapped, {ambiguous} ambiguous, {} unmapped, {skipped} skipped, {duplicates} duplicate",
        added - mapped - ambiguous
    );
    Ok(added)
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, HashSet};

    use build_graph::{Graph, Node, item_id};

    use super::{
        FlowRecord, FlowTargetIdentity, Locator, SymbolMatch, add_flow_nodes, flow_symbol_for,
        flow_symbol_for_captured_target, flow_symbol_for_record, source_digest,
        workspace_source_rel,
    };

    fn item(id: &str, label: &str, kind: &str, krate: &str, path: &str) -> Node {
        Node::new(id.to_string(), label, kind)
            .attr("crate", krate)
            .attr("path", path)
    }

    fn targets(package: &str, target: &str) -> HashMap<String, HashSet<String>> {
        HashMap::from([(package.to_string(), HashSet::from([target.to_string()]))])
    }

    #[test]
    fn workspace_compiler_variants_keep_exact_unit_identity() {
        let root = std::env::temp_dir().join(format!(
            "build-graph-build-units-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("flows")).unwrap();
        std::fs::write(
            root.join("Cargo.toml"),
            "[package]\nname='fixture'\nversion='0.1.0'\n",
        )
        .unwrap();
        std::fs::write(root.join("src/lib.rs"), "pub fn probe() {}\n").unwrap();
        let root = camino::Utf8Path::from_path(&root).unwrap();
        let source = root.join("src/lib.rs");
        let digest = source_digest(&source).unwrap();
        let package_id = "path+file:///fixture#fixture@0.1.0";
        let meta: cargo_metadata::Metadata = serde_json::from_value(serde_json::json!({
            "packages": [{"name":"fixture","version":"0.1.0","id":package_id,"manifest_path":root.join("Cargo.toml"),"dependencies":[],"targets":[],"features":{}}],
            "workspace_members":[package_id],"resolve":null,"workspace_root":root,"target_directory":root.join("target"),"version":1
        })).unwrap();
        let artifacts: super::ArtifactIndex = serde_json::from_value(serde_json::json!({
            "version":1,"native_links":[],"rust_artifacts":[{"package_id":package_id,"target_name":"fixture","target_kind":["lib"],"target_src_path":source,"filenames":[]}]
        })).unwrap();
        for key in ["host-unit", "target-unit"] {
            let id = format!("compiler-{key}");
            let unit = serde_json::json!({"version":2,"krate":"fixture","unit_key":key,"manifest_dir":root,
                "package_name":"fixture","package_version":"0.1.0","crate_root":source,
                "build_context":{"schemaVersion":1,"target_triple":"same-host-and-target","features":[],"profile":{},"test":false},
                "flows":[{"function":"fixture::probe","function_id":id,"owner_kind":"Fn","source_file":source,"source_location":1,"source_digest":digest,
                    "flow":{"version":1,"function":"fixture::probe","function_id":id,"entry":"bb0","blocks":[{"id":"bb0","kind":"return","successors":[]}]}}]});
            std::fs::write(root.join(format!("flows/{key}.json")), unit.to_string()).unwrap();
        }
        let mut graph = Graph::new();
        graph.add_node(
            Node::new("crate__fixture".into(), "fixture", "crate")
                .with_source(Some("Cargo.toml".into()), None)
                .attr("crate", "fixture")
                .attr("package_id", package_id),
        );
        graph.add_node(
            item(
                "probe-declaration",
                "probe",
                "function",
                "fixture",
                "fixture::probe",
            )
            .with_source(Some("src/lib.rs".into()), Some(1))
            .attr("package_id", package_id)
            .attr("target_name", "fixture")
            .attr("target_kind", "[\"lib\"]")
            .attr("target_src_path", source.as_str()),
        );
        assert_eq!(
            super::add_flow_nodes_with_artifacts(
                &mut graph,
                Some(&meta),
                root,
                &root.join("flows"),
                &targets("fixture", "fixture"),
                Some(&artifacts)
            )
            .unwrap(),
            2
        );
        let flows: Vec<_> = graph
            .node_values()
            .filter(|node| node.attributes.get("kind").map(String::as_str) == Some("flow_function"))
            .collect();
        assert_eq!(flows.len(), 2);
        assert_ne!(flows[0].attributes["path"], flows[1].attributes["path"]);
        assert!(
            flows
                .iter()
                .all(|node| node.attributes["mapping_status"] == "ambiguous"
                    && !node.attributes.contains_key("symbol_id"))
        );
        assert_eq!(
            flows
                .iter()
                .map(|node| node.attributes["unit_key"].as_str())
                .collect::<HashSet<_>>(),
            HashSet::from(["host-unit", "target-unit"])
        );
        let units: serde_json::Value =
            serde_json::from_str(&graph.node("crate__fixture").unwrap().attributes["build_units"])
                .unwrap();
        assert_eq!(units["units"].as_array().unwrap().len(), 2);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn captured_binary_target_spelling_binds_only_exact_declarations() {
        // Observed offline-capture shape: Cargo/rustdoc preserves a hyphen in
        // the target name while MIR uses the rustc crate's underscore spelling.
        let kinds = vec!["bin".to_string()];
        let target = || FlowTargetIdentity {
            package_id: "fixture@1",
            name: "audit-tool",
            kind: &kinds,
            src_path: "/fixture/app/src/main.rs",
        };
        let declaration = |id: &str, path: &str, kind: &str| {
            item(id, path.rsplit("::").next().unwrap(), kind, "fixture", path)
                .with_source(Some("app/src/main.rs".into()), Some(1))
                .attr("package_id", "fixture@1")
                .attr("target_name", "audit-tool")
                .attr("target_kind", "[\"bin\"]")
                .attr("target_src_path", "/fixture/app/src/main.rs")
        };
        let record = |function: &str| FlowRecord {
            function: function.into(),
            compiler_entry: None,
            definition_source: None,
            function_id: Some("captured-function-id".into()),
            owner_kind: "Fn".into(),
            source_file: Some("app/src/main.rs".into()),
            source_location: Some(1),
            source_digest: None,
            link_symbol: None,
            impl_self: None,
            impl_trait: None,
            flow: serde_json::json!({}),
        };
        let mut graph = Graph::new();
        for (id, owner, kind) in [
            ("root", "main", "function"),
            ("nested", "helper::main", "function"),
            ("associated", "Widget::main", "method"),
        ] {
            graph.add_node(declaration(id, &format!("bin::audit-tool::{owner}"), kind));
        }
        let locator = Locator::build(&graph);
        for (id, owner) in [
            ("root", "main"),
            ("nested", "helper::main"),
            ("associated", "Widget::main"),
        ] {
            let body = record(&format!("bin::audit_tool::{owner}"));
            assert_eq!(
                flow_symbol_for_captured_target(
                    &graph,
                    &locator,
                    &body,
                    "app/src/main.rs",
                    "fixture",
                    Some(target())
                ),
                SymbolMatch::Mapped(id.into())
            );
            assert!(body.function.starts_with("bin::audit_tool::"));
            assert_eq!(body.function_id.as_deref(), Some("captured-function-id"));
            assert_eq!(
                flow_symbol_for_captured_target(
                    &graph,
                    &locator,
                    &body,
                    "app/src/main.rs",
                    "fixture",
                    None
                ),
                SymbolMatch::Unmapped,
                "legacy spelling alone cannot establish a binding"
            );
        }
        for (function, rel, package) in [
            ("bin::other_tool::main", "app/src/main.rs", "fixture"),
            (
                "bin::audit_tool::absent::main",
                "app/src/main.rs",
                "fixture",
            ),
            ("bin::audit_tool::main", "other/src/main.rs", "fixture"),
            (
                "bin::audit_tool::main",
                "app/src/main.rs",
                "another-package",
            ),
        ] {
            assert_eq!(
                flow_symbol_for_captured_target(
                    &graph,
                    &locator,
                    &record(function),
                    rel,
                    package,
                    Some(target())
                ),
                SymbolMatch::Unmapped
            );
        }
        for (attribute, value) in [
            ("package_id", "fixture@2"),
            ("target_name", "audit_tool"),
            ("target_kind", "[\"lib\"]"),
            ("target_src_path", "/fixture/other/main.rs"),
        ] {
            let mut wrong = Graph::new();
            wrong.add_node(
                declaration("wrong", "bin::audit-tool::main", "function").attr(attribute, value),
            );
            assert_eq!(
                flow_symbol_for_captured_target(
                    &wrong,
                    &Locator::build(&wrong),
                    &record("bin::audit_tool::main"),
                    "app/src/main.rs",
                    "fixture",
                    Some(target())
                ),
                SymbolMatch::Unmapped,
                "{attribute}"
            );
        }
        let mut missing = Graph::new();
        missing.add_node(
            item(
                "missing-proof",
                "main",
                "function",
                "fixture",
                "bin::audit-tool::main",
            )
            .with_source(Some("app/src/main.rs".into()), Some(1)),
        );
        assert_eq!(
            flow_symbol_for_captured_target(
                &missing,
                &Locator::build(&missing),
                &record("bin::audit_tool::main"),
                "app/src/main.rs",
                "fixture",
                Some(target())
            ),
            SymbolMatch::Unmapped
        );
        graph.add_node(declaration(
            "duplicate",
            "bin::audit-tool::main",
            "function",
        ));
        assert_eq!(
            flow_symbol_for_captured_target(
                &graph,
                &Locator::build(&graph),
                &record("bin::audit_tool::main"),
                "app/src/main.rs",
                "fixture",
                Some(target())
            ),
            SymbolMatch::Ambiguous
        );

        let mut traits = Graph::new();
        traits.add_node(
            declaration(
                "trait-method",
                "bin::audit-tool::<fixture::Widget as fixture::Trait>::run",
                "method",
            )
            .attr("impl_self", "fixture::Widget")
            .attr("impl_trait", "fixture::Trait"),
        );
        let mut body = record("bin::audit_tool::<Widget as Trait>::run");
        body.owner_kind = "AssocFn".into();
        body.impl_self = Some("fixture::Widget".into());
        body.impl_trait = Some("fixture::Trait".into());
        assert_eq!(
            flow_symbol_for_captured_target(
                &traits,
                &Locator::build(&traits),
                &body,
                "app/src/main.rs",
                "fixture",
                Some(target())
            ),
            SymbolMatch::Mapped("trait-method".into())
        );
        body.impl_trait = Some("fixture::OtherTrait".into());
        assert_eq!(
            flow_symbol_for_captured_target(
                &traits,
                &Locator::build(&traits),
                &body,
                "app/src/main.rs",
                "fixture",
                Some(target())
            ),
            SymbolMatch::Unmapped
        );
    }

    #[test]
    fn resolves_def_paths_without_symbol_specific_assumptions() {
        let mut graph = Graph::new();
        graph.add_node(item(
            "entrypoint",
            "entrypoint",
            "function",
            "route-fixture",
            "generated::entrypoint",
        ));
        graph.add_node(item(
            "reexported-entrypoint",
            "entrypoint",
            "function",
            "other-fixture",
            "generated::entrypoint",
        ));
        graph.add_node(item(
            "choice",
            "Choice",
            "enum",
            "route-fixture",
            "model::Choice",
        ));
        graph.add_node(item(
            "selected",
            "Selected",
            "variant",
            "route-fixture",
            "model::Choice::Selected",
        ));

        let loc = Locator::build(&graph);

        assert_eq!(
            loc.get_path(true, "route_fixture::generated::entrypoint")
                .map(String::as_str),
            Some("entrypoint")
        );
        assert!(loc.get_path(true, "generated::entrypoint").is_none());
        assert_eq!(
            loc.get_path(false, "route_fixture::model::Choice")
                .map(String::as_str),
            Some("choice")
        );
        assert_eq!(
            loc.get_path(false, "route_fixture::model::Choice::Selected")
                .map(String::as_str),
            Some("selected")
        );
        assert_eq!(
            loc.get_path(false, "model::Choice::Selected")
                .map(String::as_str),
            Some("selected")
        );
    }

    #[test]
    fn edge_reader_maps_macro_paths_when_source_coordinates_are_shared() {
        let workspace = crate::test_support::Workspace::new(&[]);
        let edges = workspace.root.join("driver-refs-v2");
        std::fs::create_dir(&edges).expect("edge directory");
        std::fs::write(
            edges.join("unit.tsv"),
            "call\tmacro.rs:1\tmacro.rs:1\troute_fixture::generated::entrypoint\troute_fixture::generated::callee\n",
        )
        .expect("five-column edge file");
        let mut graph = Graph::new();
        graph.add_node(item(
            "entrypoint",
            "entrypoint",
            "function",
            "route-fixture",
            "generated::entrypoint",
        ));
        graph.add_node(item(
            "callee",
            "callee",
            "function",
            "route-fixture",
            "generated::callee",
        ));
        let counts =
            super::read_reference_edges(&mut graph, &edges).expect("read macro-safe driver edges");
        assert_eq!(counts.calls, 1);
        assert_eq!(counts.uses, 0);
        assert_eq!(graph.edge_count(), 1);
        let document = graph.into_doc();
        let edge = document.edges.first().expect("mapped call edge");
        assert_eq!(edge.source, "entrypoint");
        assert_eq!(edge.target, "callee");
        assert_eq!(edge.relation, "calls");
    }

    #[test]
    fn same_line_methods_require_qualified_owner_and_unique_name() {
        let mut graph = Graph::new();
        for (id, path) in [
            ("alpha-read", "module::Alpha::read"),
            ("alpha-write", "module::Alpha::write"),
            ("beta-read", "module::Beta::read"),
        ] {
            graph.add_node(
                item(id, id, "method", "fixture", path)
                    .with_source(Some("src/lib.rs".into()), Some(10)),
            );
        }
        let locator = Locator::build(&graph);
        assert!(locator.get(true, "src/lib.rs:10").is_none());
        assert!(matches!(
            flow_symbol_for(
                &graph,
                &locator,
                "fixture::module::Alpha::<T>::read",
                "src/lib.rs",
                Some(10),
                "fixture"
            ),
            SymbolMatch::Mapped(id) if id == "alpha-read"
        ));
        assert!(matches!(
            flow_symbol_for(
                &graph,
                &locator,
                "fixture::module::Beta::read",
                "src/lib.rs",
                Some(10),
                "fixture"
            ),
            SymbolMatch::Mapped(id) if id == "beta-read"
        ));
        assert!(matches!(
            flow_symbol_for(
                &graph,
                &locator,
                "fixture::module::Gamma::read",
                "src/lib.rs",
                Some(10),
                "fixture"
            ),
            SymbolMatch::Unmapped
        ));
        assert!(matches!(
            flow_symbol_for(
                &graph,
                &locator,
                "fixture::module::<Alpha as fixture::Trait>::read",
                "src/lib.rs",
                Some(10),
                "fixture"
            ),
            SymbolMatch::Mapped(id) if id == "alpha-read"
        ));
        assert!(matches!(
            flow_symbol_for(
                &graph,
                &locator,
                "fixture::module::<impl Beta>::read",
                "src/lib.rs",
                Some(10),
                "fixture"
            ),
            SymbolMatch::Mapped(id) if id == "beta-read"
        ));

        let mut binary_graph = Graph::new();
        for (id, path) in [
            ("binary-method", "bin::demo::Widget::work"),
            ("library-method", "Widget::work"),
        ] {
            binary_graph.add_node(
                item(id, "work", "method", "fixture", path)
                    .with_source(Some("src/bin/demo.rs".into()), Some(10)),
            );
        }
        let binary_locator = Locator::build(&binary_graph);
        assert!(matches!(
            flow_symbol_for(
                &binary_graph,
                &binary_locator,
                "bin::demo::<Widget as Trait>::work",
                "src/bin/demo.rs",
                Some(100),
                "fixture"
            ),
            SymbolMatch::Mapped(id) if id == "binary-method"
        ));
        assert!(matches!(
            flow_symbol_for(
                &binary_graph,
                &binary_locator,
                "fixture::<Widget as Trait>::work",
                "src/bin/demo.rs",
                Some(10),
                "fixture"
            ),
            SymbolMatch::Mapped(id) if id == "library-method"
        ));
        let mut library_only = Graph::new();
        library_only.add_node(
            item(
                "module-library-method",
                "work",
                "method",
                "fixture",
                "demo::Widget::work",
            )
            .with_source(Some("src/bin/demo.rs".into()), Some(10)),
        );
        assert!(matches!(
            flow_symbol_for(
                &library_only,
                &Locator::build(&library_only),
                "bin::demo::<Widget as Trait>::work",
                "src/bin/demo.rs",
                Some(10),
                "fixture"
            ),
            SymbolMatch::Unmapped
        ));
        binary_graph.add_node(
            item(
                "second-library-method",
                "work",
                "method",
                "fixture",
                "Widget::work",
            )
            .with_source(Some("src/bin/demo.rs".into()), Some(10)),
        );
        assert!(matches!(
            flow_symbol_for(
                &binary_graph,
                &Locator::build(&binary_graph),
                "fixture::<Widget as Trait>::work",
                "src/bin/demo.rs",
                Some(100),
                "fixture"
            ),
            SymbolMatch::Ambiguous
        ));
    }

    #[test]
    fn qualified_impl_owner_omits_expansion_scope_only_with_rich_proof() {
        let mut graph = Graph::new();
        graph.add_node(
            item(
                "rich-owner",
                "work",
                "method",
                "fixture",
                "model::Widget::work",
            )
            .with_source(Some("src/lib.rs".into()), Some(10)),
        );
        graph.add_node(
            item(
                "unrelated-owner",
                "work",
                "method",
                "fixture",
                "other::Widget::work",
            )
            .with_source(Some("src/lib.rs".into()), Some(10)),
        );
        graph.add_node(
            item(
                "binary-owner",
                "work",
                "method",
                "fixture",
                "bin::demo::model::Widget::work",
            )
            .with_source(Some("src/bin/demo.rs".into()), Some(10)),
        );
        let locator = Locator::build(&graph);
        assert!(matches!(
            flow_symbol_for(
                &graph,
                &locator,
                "fixture::expansion::<impl model::Widget>::work",
                "src/lib.rs",
                Some(11),
                "fixture"
            ),
            SymbolMatch::Mapped(id) if id == "rich-owner"
        ));
        assert!(matches!(
            flow_symbol_for(
                &graph,
                &locator,
                "fixture::expansion::<impl marker::Trait<for<'a> fn(&'a u8)> for model::Widget>::work",
                "src/lib.rs",
                Some(10),
                "fixture"
            ),
            SymbolMatch::Mapped(id) if id == "rich-owner"
        ));
        assert!(matches!(
            flow_symbol_for(
                &graph,
                &locator,
                "bin::demo::expansion::<impl model::Widget>::work",
                "src/bin/demo.rs",
                Some(10),
                "fixture"
            ),
            SymbolMatch::Mapped(id) if id == "binary-owner"
        ));
        for path in [
            "fixture::expansion::<impl missing::Widget>::work",
            "fixture::expansion::<impl Widget>::work",
            "fixture::expansion::<impl marker::Trait for missing::Widget>::work",
        ] {
            assert!(matches!(
                flow_symbol_for(&graph, &locator, path, "src/lib.rs", Some(10), "fixture"),
                SymbolMatch::Unmapped
            ));
        }
        assert!(matches!(
            flow_symbol_for(
                &graph,
                &locator,
                "fixture::expansion::<impl model::Widget>::work",
                "src/lib.rs",
                Some(20),
                "fixture"
            ),
            SymbolMatch::Unmapped
        ));
        graph.add_node(
            item(
                "duplicate-owner",
                "work",
                "method",
                "fixture",
                "model::Widget::work",
            )
            .with_source(Some("src/lib.rs".into()), Some(10)),
        );
        assert!(matches!(
            flow_symbol_for(
                &graph,
                &Locator::build(&graph),
                "fixture::expansion::<impl model::Widget>::work",
                "src/lib.rs",
                Some(10),
                "fixture"
            ),
            SymbolMatch::Ambiguous
        ));
    }

    #[test]
    fn source_alias_must_resolve_inside_workspace() {
        let root = std::env::temp_dir().join(format!(
            "build-graph-source-alias-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let outside = root.with_extension("outside");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(root.join("src/lib.rs"), "fn inside() {}\n").unwrap();
        std::fs::write(outside.join("outside.rs"), "fn outside() {}\n").unwrap();
        let root_path = camino::Utf8Path::from_path(&root).unwrap();
        assert_eq!(
            workspace_source_rel(root_path, "src/../src/lib.rs"),
            Some(("src/../src/lib.rs", "src/lib.rs".to_string()))
        );
        let sibling = format!(
            "../{}/outside.rs",
            outside.file_name().unwrap().to_string_lossy()
        );
        assert!(workspace_source_rel(root_path, &sibling).is_none());
        assert!(workspace_source_rel(root_path, outside.to_str().unwrap()).is_none());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, root.join("external-link")).unwrap();
            assert!(workspace_source_rel(root_path, "external-link/outside.rs").is_none());
        }
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn shared_workspace_source_needs_rich_package_proof() {
        let root = std::env::temp_dir().join(format!(
            "build-graph-shared-source-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let source = root.join("crates/owner/src/body.rs");
        let rel = "crates/consumer/src/../../owner/src/body.rs";
        let flows = root.join("flows");
        std::fs::create_dir_all(source.parent().unwrap()).unwrap();
        std::fs::create_dir_all(root.join("crates/consumer/src")).unwrap();
        std::fs::create_dir_all(&flows).unwrap();
        std::fs::write(
            root.join("crates/owner/Cargo.toml"),
            "[package]\nname='owner'\nversion='0.1.0'\n",
        )
        .unwrap();
        std::fs::write(
            root.join("crates/consumer/Cargo.toml"),
            "[package]\nname='consumer'\nversion='0.1.0'\n",
        )
        .unwrap();
        std::fs::write(&source, "struct Body;\n").unwrap();
        let digest = source_digest(camino::Utf8Path::from_path(&source).unwrap()).unwrap();
        let record = |function: &str, canonical: bool| {
            serde_json::json!({
                "function": function,
                "owner_kind": "AssocFn",
                "source_file": rel,
                "source_location": 1,
                "source_digest": digest.clone(),
                "impl_self": canonical.then_some("consumer::Body"),
                "impl_trait": canonical.then_some("consumer::Trait"),
                "flow": {
                    "version": 1,
                    "function": function,
                    "entry": "bb0",
                    "blocks": [{"id":"bb0","kind":"return","label":"return","source_file":rel,"source_location":1,"callee":null,"successors":[]}]
                }
            })
        };
        let accepted = "consumer::<Body as Trait>::run";
        let rejected = "consumer::<Body as Trait>::hidden";
        std::fs::write(
            flows.join("unit.json"),
            serde_json::to_vec(&serde_json::json!({
                "version": 1,
                "krate": "consumer",
                "flows": [record(accepted, true), record(rejected, false)]
            }))
            .unwrap(),
        )
        .unwrap();
        let mut graph = Graph::new();
        for (package, manifest) in [
            ("owner", "crates/owner/Cargo.toml"),
            ("consumer", "crates/consumer/Cargo.toml"),
        ] {
            graph.add_node(
                Node::new(format!("crate__{package}"), package, "crate")
                    .with_source(Some(manifest.into()), None)
                    .attr("crate", package),
            );
        }
        graph.add_node(
            item(
                "rich-method",
                "run",
                "method",
                "consumer",
                "<consumer::Body as consumer::Trait>::run",
            )
            .with_source(Some(rel.into()), Some(1))
            .attr("impl_self", "consumer::Body")
            .attr("impl_trait", "consumer::Trait")
            .attr("has_body", "true"),
        );
        let root = camino::Utf8Path::from_path(&root).unwrap();
        assert_eq!(
            add_flow_nodes(
                &mut graph,
                root,
                &root.join("flows"),
                &targets("consumer", "consumer"),
            )
            .unwrap(),
            1
        );
        assert!(graph.contains(&item_id("consumer", accepted, "flow_function")));
        assert!(!graph.contains(&item_id("consumer", rejected, "flow_function")));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn validated_unmapped_body_and_closure_remain_distinct() {
        let root = std::env::temp_dir().join(format!(
            "build-graph-unmapped-flow-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let rel = "examples/demo.rs";
        let source = root.join(rel);
        let flows = root.join("flows");
        std::fs::create_dir_all(source.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&flows).unwrap();
        std::fs::write(
            root.join("Cargo.toml"),
            "[package]\nname = \"fixture\"\nversion = \"0.1.0\"\n",
        )
        .unwrap();
        std::fs::write(&source, "fn present() {}\nfn omitted() { let _ = || 1; }\n").unwrap();
        let digest = source_digest(camino::Utf8Path::from_path(&source).unwrap()).unwrap();
        let record = |function: &str, function_id: &str, kind: &str| {
            serde_json::json!({
                "function": function,
                "function_id": function_id,
                "owner_kind": kind,
                "source_file": rel,
                "source_location": 2,
                "source_digest": digest.clone(),
                "flow": {
                    "version": 1,
                    "function": function,
                    "function_id": function_id,
                    "entry": "bb0",
                    "blocks": [{"id":"bb0","kind":"return","label":"return","source_file":rel,"source_location":2,"callee":null,"successors":[]}]
                }
            })
        };
        let unit = serde_json::json!({
            "version": 1,
            "krate": "example_fixture",
            "flows": [
                record("bin::example_fixture::omitted::{closure#0}", "closure-id", "Closure"),
                record("bin::example_fixture::omitted", "owner-id", "Fn")
            ]
        });
        std::fs::write(flows.join("unit.json"), serde_json::to_vec(&unit).unwrap()).unwrap();
        let mut graph = Graph::new();
        graph.add_node(
            Node::new("crate__fixture".into(), "fixture", "crate")
                .with_source(Some("Cargo.toml".into()), None)
                .attr("crate", "fixture"),
        );
        graph.add_node(
            item("present", "present", "function", "fixture", "present")
                .with_source(Some(rel.into()), Some(1)),
        );
        let root = camino::Utf8Path::from_path(&root).unwrap();
        assert_eq!(
            add_flow_nodes(
                &mut graph,
                root,
                &root.join("flows"),
                &targets("fixture", "unrelated_target"),
            )
            .unwrap(),
            0
        );
        assert_eq!(
            add_flow_nodes(
                &mut graph,
                root,
                &root.join("flows"),
                &targets("fixture", "example_fixture"),
            )
            .unwrap(),
            2
        );
        for (function, expected_id) in [
            ("bin::example_fixture::omitted", "owner-id"),
            ("bin::example_fixture::omitted::{closure#0}", "closure-id"),
        ] {
            let id = item_id("fixture", function, "flow_function");
            let node = graph.node(&id).expect("validated compiler body");
            assert_eq!(
                node.attributes.get("mapping_status").map(String::as_str),
                Some("unmapped")
            );
            assert_eq!(
                node.attributes.get("function_id").map(String::as_str),
                Some(expected_id)
            );
            assert!(!node.attributes.contains_key("symbol_id"));
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_qualified_impl_bodies_do_not_claim_one_rich_symbol() {
        let root = std::env::temp_dir().join(format!(
            "build-graph-qualified-flow-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let rel = "src/lib.rs";
        let source = root.join(rel);
        let flows = root.join("flows");
        std::fs::create_dir_all(source.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&flows).unwrap();
        std::fs::write(
            &source,
            "struct Widget; // macro expands two methods here\n",
        )
        .unwrap();
        let digest = source_digest(camino::Utf8Path::from_path(&source).unwrap()).unwrap();
        let record = |function: &str| {
            serde_json::json!({
                "function": function,
                "owner_kind": "AssocFn",
                "source_file": rel,
                "source_location": 1,
            "source_digest": digest.clone(),
                "flow": {
                    "version": 1,
                    "function": function,
                    "entry": "bb0",
                    "blocks": [{"id":"bb0","kind":"return","label":"return","source_file":rel,"source_location":1,"callee":null,"successors":[]}]
                }
            })
        };
        let first = "fixture::expansion::<impl First for model::Widget>::build";
        let second = "fixture::expansion::<impl Second for model::Widget>::build";
        let unit = serde_json::json!({
            "version": 1,
            "krate": "fixture",
            "flows": [record(first), record(second)]
        });
        std::fs::write(flows.join("unit.json"), serde_json::to_vec(&unit).unwrap()).unwrap();
        let mut graph = Graph::new();
        graph.add_node(
            Node::new("file".into(), rel, "file")
                .with_source(Some(rel.into()), None)
                .attr("crate", "fixture"),
        );
        graph.add_node(
            item(
                "rich-method",
                "build",
                "method",
                "fixture",
                "model::Widget::build",
            )
            .with_source(Some(rel.into()), Some(1)),
        );
        let root = camino::Utf8Path::from_path(&root).unwrap();
        assert_eq!(
            add_flow_nodes(
                &mut graph,
                root,
                &root.join("flows"),
                &targets("fixture", "fixture"),
            )
            .unwrap(),
            2
        );
        for function in [first, second] {
            let node = graph
                .node(&item_id("fixture", function, "flow_function"))
                .expect("qualified compiler body retained");
            assert_eq!(
                node.attributes.get("mapping_status").map(String::as_str),
                Some("unmapped")
            );
            assert!(!node.attributes.contains_key("symbol_id"));
        }
        assert!(!graph.edge_values().any(|edge| edge.relation == "has_flow"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn imports_closure_under_generic_method_from_validated_parent() {
        let root = std::env::temp_dir().join(format!(
            "build-graph-generic-closure-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let rel = "crates/generic_fixture/src/native.rs";
        let source = root.join(rel);
        let flows = root.join("flows");
        std::fs::create_dir_all(source.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&flows).unwrap();
        std::fs::write(&source, "fn inspect() {\n\n\n\n    || { || {} };\n}\n").unwrap();
        let digest = source_digest(camino::Utf8Path::from_path(&source).unwrap()).unwrap();
        let parent = "generic_fixture::native::Container::<K, V>::inspect";
        let closure = format!("{parent}::{{closure#0}}");
        let nested = format!("{closure}::{{closure#0}}");
        let record = |function: &str, kind: &str, line: u32| {
            serde_json::json!({
                "function": function,
                "owner_kind": kind,
                "source_file": rel,
                "source_location": line,
                "source_digest": digest.clone(),
                "flow": {
                    "version": 1,
                    "function": function,
                    "entry": "bb0",
                    "blocks": [{"id":"bb0","kind":"return","label":"return","source_file":rel,"source_location":line,"callee":null,"successors":[]}]
                }
            })
        };
        // Deliberately place nested closures first and farther than the
        // locator's ±1 line tolerance from their ordinary parent.
        let unit = serde_json::json!({
            "version": 1,
            "krate": "generic_fixture",
            "flows": [
                record(&nested, "Closure", 5),
                record(&closure, "Closure", 5),
                record(parent, "AssocFn", 1)
            ]
        });
        std::fs::write(flows.join("unit.json"), serde_json::to_vec(&unit).unwrap()).unwrap();
        let mut graph = Graph::new();
        graph.add_node(
            Node::new("native-file".into(), rel, "file")
                .with_source(Some(rel.into()), None)
                .attr("crate", "generic_fixture"),
        );
        graph.add_node(
            item(
                "inspect-symbol",
                "inspect",
                "method",
                "generic_fixture",
                "native::Container::inspect",
            )
            .with_source(Some(rel.into()), Some(1)),
        );
        let root = camino::Utf8Path::from_path(&root).unwrap();
        assert_eq!(
            add_flow_nodes(
                &mut graph,
                root,
                &root.join("flows"),
                &targets("generic_fixture", "generic_fixture"),
            )
            .unwrap(),
            3
        );
        for path in [&closure, &nested] {
            let id = item_id("generic_fixture", path, "flow_function");
            let node = graph.node(&id).expect("generic method closure flow");
            assert_eq!(
                node.attributes.get("symbol_id").map(String::as_str),
                Some("inspect-symbol")
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stale_body_with_mismatched_digest_is_rejected() {
        let root = std::env::temp_dir().join(format!(
            "build-graph-stale-flow-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let source = root.join("src/lib.rs");
        let flows = root.join("flows");
        std::fs::create_dir_all(source.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&flows).unwrap();
        std::fs::write(&source, "fn fresh() {}\n").unwrap();
        let unit = serde_json::json!({
            "version": 1,
            "krate": "fixture",
            "flows": [{
                "function": "fixture::removed",
                "owner_kind": "Fn",
                "source_file": "src/lib.rs",
                "source_location": 1,
                "source_digest": "stale-digest",
                "flow": {
                    "version": 1,
                    "function": "fixture::removed",
                    "entry": "bb0",
                    "blocks": [{"id":"bb0","kind":"return","label":"return","source_file":"src/lib.rs","source_location":1,"callee":null,"successors":[]}]
                }
            }]
        });
        std::fs::write(flows.join("stale.json"), serde_json::to_vec(&unit).unwrap()).unwrap();
        let mut graph = Graph::new();
        graph.add_node(
            Node::new("file__fixture__src_lib_rs".into(), "src/lib.rs", "file")
                .with_source(Some("src/lib.rs".into()), None)
                .attr("crate", "fixture"),
        );
        graph.add_node(
            item("fresh", "fresh", "function", "fixture", "fresh")
                .with_source(Some("src/lib.rs".into()), Some(1)),
        );
        let root = camino::Utf8Path::from_path(&root).unwrap();
        assert_eq!(
            add_flow_nodes(
                &mut graph,
                root,
                &root.join("flows"),
                &targets("fixture", "fixture"),
            )
            .unwrap(),
            0
        );
        assert!(!graph.contains(&item_id("fixture", "fixture::removed", "flow_function")));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn canonical_impl_identity_disambiguates_same_named_bodies() {
        let mut graph = Graph::new();
        let entries = [
            (
                "debug",
                "fmt",
                "fixture::fmt::Debug",
                "bin::app::<fixture::Widget as fixture::fmt::Debug>::fmt",
            ),
            (
                "display",
                "fmt",
                "fixture::fmt::Display",
                "bin::app::<fixture::Widget as fixture::fmt::Display>::fmt",
            ),
            ("inherent", "fmt", "", "bin::app::Widget::fmt"),
            (
                "from_upper",
                "from",
                "fixture::convert::From<fixture::Alpha>",
                "bin::app::<fixture::Widget as fixture::convert::From<fixture::Alpha>>::from",
            ),
            (
                "from_lower",
                "from",
                "fixture::convert::From<fixture::alpha>",
                "bin::app::<fixture::Widget as fixture::convert::From<fixture::alpha>>::from",
            ),
        ];
        for (id, label, trait_name, path) in entries {
            let mut node = item(id, label, "method", "fixture", path)
                .with_source(Some("src/main.rs".into()), Some(10));
            if !trait_name.is_empty() {
                node = node
                    .attr("impl_self", "fixture::Widget")
                    .attr("impl_trait", trait_name);
            }
            graph.add_node(node);
        }
        let locator = Locator::build(&graph);
        let record = |function: &str, trait_name: &str| FlowRecord {
            function: function.into(),
            compiler_entry: None,
            definition_source: None,
            function_id: None,
            owner_kind: "AssocFn".into(),
            source_file: Some("src/main.rs".into()),
            source_location: Some(10),
            source_digest: None,
            link_symbol: None,
            impl_self: Some("fixture::Widget".into()),
            impl_trait: Some(trait_name.into()),
            flow: serde_json::json!({}),
        };
        for (function, trait_name, expected) in [
            (
                "bin::app::<Widget as fmt::Debug>::fmt",
                "fixture::fmt::Debug",
                "debug",
            ),
            (
                "bin::app::<Widget as fmt::Display>::fmt",
                "fixture::fmt::Display",
                "display",
            ),
            (
                "bin::app::<impl From<Alpha> for Widget>::from",
                "fixture::convert::From<fixture::Alpha>",
                "from_upper",
            ),
            (
                "bin::app::<impl From<alpha> for Widget>::from",
                "fixture::convert::From<fixture::alpha>",
                "from_lower",
            ),
        ] {
            assert_eq!(
                flow_symbol_for_record(
                    &graph,
                    &locator,
                    &record(function, trait_name),
                    "src/main.rs",
                    "fixture"
                ),
                SymbolMatch::Mapped(expected.into())
            );
        }
        assert_eq!(
            flow_symbol_for_record(
                &graph,
                &locator,
                &record(
                    "bin::app::<Widget as unrelated::Debug>::fmt",
                    "unrelated::Debug"
                ),
                "src/main.rs",
                "fixture",
            ),
            SymbolMatch::Unmapped
        );
        let mut legacy_trait = record(
            "bin::app::<Widget as fmt::Debug>::fmt",
            "fixture::fmt::Debug",
        );
        legacy_trait.impl_self = None;
        legacy_trait.impl_trait = None;
        assert_eq!(
            flow_symbol_for_record(&graph, &locator, &legacy_trait, "src/main.rs", "fixture"),
            SymbolMatch::Unmapped
        );
        let mut inherent_only = Graph::new();
        inherent_only.add_node(
            item(
                "inherent",
                "fmt",
                "method",
                "fixture",
                "bin::app::Widget::fmt",
            )
            .with_source(Some("src/main.rs".into()), Some(10)),
        );
        let inherent_locator = Locator::build(&inherent_only);
        assert_eq!(
            flow_symbol_for_record(
                &inherent_only,
                &inherent_locator,
                &legacy_trait,
                "src/main.rs",
                "fixture"
            ),
            SymbolMatch::Unmapped
        );
        graph.add_node(
            item(
                "duplicate-debug",
                "fmt",
                "method",
                "fixture",
                "bin::app::<fixture::Widget as fixture::fmt::Debug>::fmt",
            )
            .with_source(Some("src/main.rs".into()), Some(10))
            .attr("impl_self", "fixture::Widget")
            .attr("impl_trait", "fixture::fmt::Debug"),
        );
        let locator = Locator::build(&graph);
        assert_eq!(
            flow_symbol_for_record(
                &graph,
                &locator,
                &record(
                    "bin::app::<Widget as fmt::Debug>::fmt",
                    "fixture::fmt::Debug"
                ),
                "src/main.rs",
                "fixture",
            ),
            SymbolMatch::Ambiguous
        );
    }

    #[test]
    fn normalized_flow_id_collisions_keep_every_distinct_compiler_body() {
        let root = std::env::temp_dir().join(format!(
            "build-graph-flow-identity-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let source = root.join("src/lib.rs");
        let flows = root.join("flows");
        std::fs::create_dir_all(source.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&flows).unwrap();
        std::fs::write(&source, "// same-line macro expansions\n").unwrap();
        let digest = source_digest(camino::Utf8Path::from_path(&source).unwrap()).unwrap();
        let entries = [
            ("Run", "fixture::CaseTrait", "id-run-upper"),
            ("run", "fixture::CaseTrait", "id-run-lower"),
            (
                "convert",
                "fixture::Convert<fixture::Alpha>",
                "id-alpha-upper",
            ),
            (
                "convert",
                "fixture::Convert<fixture::alpha>",
                "id-alpha-lower",
            ),
        ];
        let mut graph = Graph::new();
        graph.add_node(
            Node::new("file__fixture__src_lib_rs".into(), "src/lib.rs", "file")
                .with_source(Some("src/lib.rs".into()), None)
                .attr("crate", "fixture"),
        );
        let mut records = Vec::new();
        for (index, (name, trait_name, function_id)) in entries.iter().enumerate() {
            let function = format!("fixture::<Widget as {trait_name}>::{name}");
            graph.add_node(
                item(
                    &format!("rich-{index}"),
                    name,
                    "method",
                    "fixture",
                    &function,
                )
                .with_source(Some("src/lib.rs".into()), Some(1))
                .attr("impl_self", "fixture::Widget")
                .attr("impl_trait", *trait_name)
                .attr("has_body", "true"),
            );
            records.push(serde_json::json!({
                "function": function,
                "function_id": function_id,
                "owner_kind": "AssocFn",
                "source_file": "src/lib.rs",
                "source_location": 1,
                "source_digest": digest,
                "impl_self": "fixture::Widget",
                "impl_trait": trait_name,
                "flow": {
                    "version": 1,
                    "function": function,
                    "function_id": function_id,
                    "entry": "bb0",
                    "blocks": [{"id":"bb0","kind":"return","label":"return","successors":[]}]
                }
            }));
        }
        let unit = serde_json::json!({"version":1,"krate":"fixture","flows":records});
        std::fs::write(
            flows.join("fixture.json"),
            serde_json::to_vec(&unit).unwrap(),
        )
        .unwrap();
        let root = camino::Utf8Path::from_path(&root).unwrap();
        assert_eq!(
            add_flow_nodes(
                &mut graph,
                root,
                &root.join("flows"),
                &targets("fixture", "fixture")
            )
            .unwrap(),
            4
        );
        let bodies: Vec<_> = graph
            .node_values()
            .filter(|node| node.attributes.get("kind").map(String::as_str) == Some("flow_function"))
            .collect();
        assert_eq!(bodies.len(), 4);
        let ids: HashSet<_> = bodies
            .iter()
            .filter_map(|node| node.attributes.get("function_id"))
            .collect();
        assert_eq!(ids.len(), 4);
        assert!(bodies.iter().all(
            |node| node.attributes.get("mapping_status").map(String::as_str) == Some("mapped")
        ));
        std::fs::remove_dir_all(root).unwrap();
    }
}
