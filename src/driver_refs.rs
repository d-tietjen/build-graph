//! Layer 3 (semantic) via the build-graph **rustc driver** — an alternative to
//! the rust-analyzer SCIP backend ([`crate::scip`]).
//!
//! Runs `cargo check` with the driver installed as `RUSTC_WORKSPACE_WRAPPER`.
//! The driver walks each workspace crate's HIR and writes resolved edges
//! (`kind <TAB> caller_file:line <TAB> callee_file:line`) per compilation unit;
//! here we map those `file:line` endpoints onto the Layer-2 item nodes, exactly
//! as `scip.rs` maps SCIP occurrences (same fn/other bucketing + ±1 tolerance).
//!
//! Why a driver: it is far cheaper than a cold whole-workspace SCIP index and is
//! incremental for free — cargo only re-runs the wrapper for crates it
//! recompiles. So the per-unit edge files are keyed by cargo's stable
//! `-C metadata` hash and **persisted** in the output dir; a rebuild overwrites
//! only the changed units, then the full set is re-mapped (cheap).

use std::collections::{HashMap, HashSet};
use std::process::Command;

use anyhow::{Context, Result, bail};
use camino::{Utf8Path, Utf8PathBuf};

use build_graph::Graph;

use crate::scip::{ReferenceCounts, add_member_reference_edges};

/// Locate the `bg-driver` binary, building it on demand if needed. In order:
/// `explicit` (`--driver-bin`), then `$BUILD_GRAPH_DRIVER`, then building the
/// `crates/bg-driver` crate (its own nightly pin applies) and using the result.
pub fn resolve_driver(explicit: Option<&str>) -> Result<Utf8PathBuf> {
    if let Some(p) = explicit {
        let p = Utf8PathBuf::from(p);
        if !p.as_std_path().exists() {
            bail!("--driver-bin {p} not found");
        }
        return Ok(p);
    }
    if let Some(env) = std::env::var_os("BUILD_GRAPH_DRIVER") {
        let p = Utf8PathBuf::from(env.to_string_lossy().into_owned());
        if !p.as_std_path().exists() {
            bail!("BUILD_GRAPH_DRIVER points at a missing file: {p}");
        }
        return Ok(p);
    }
    let src = driver_src().context(
        "rustc driver source not found — set BUILD_GRAPH_DRIVER to a prebuilt bg-driver binary, \
         or BUILD_GRAPH_DRIVER_SRC to the crates/bg-driver directory, or pass --driver-bin",
    )?;
    build_driver(&src)
}

/// The `crates/bg-driver` source dir: `$BUILD_GRAPH_DRIVER_SRC`, else the copy
/// baked in next to this crate (works when running a locally-built binary).
fn driver_src() -> Option<Utf8PathBuf> {
    if let Some(s) = std::env::var_os("BUILD_GRAPH_DRIVER_SRC") {
        let p = Utf8PathBuf::from(s.to_string_lossy().into_owned());
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
    loc_fn: HashMap<String, String>,
    loc_other: HashMap<String, String>,
    /// fn/method node lines per file, sorted — for enclosing-fn rollup.
    fns_by_file: HashMap<String, Vec<(i64, String)>>,
}

impl Locator {
    fn build(graph: &Graph) -> Self {
        let mut loc_fn = HashMap::new();
        let mut loc_other = HashMap::new();
        let mut fns_by_file: HashMap<String, Vec<(i64, String)>> = HashMap::new();
        for n in graph.node_values() {
            if let (Some(f), Some(l)) = (n.source_file.as_deref(), n.source_location) {
                let kind = n.attributes.get("kind").map(String::as_str).unwrap_or("");
                let is_fn = kind == "function" || kind == "method";
                let bucket = if is_fn { &mut loc_fn } else { &mut loc_other };
                bucket
                    .entry(format!("{f}:{l}"))
                    .or_insert_with(|| n.id.clone());
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
        (pos > 0).then(|| &list[pos - 1].1)
    }

    /// Resolve a `file:line` to a node id, preferring the fn or other bucket per
    /// `prefer_fn`, then the other, each with ±1 line tolerance.
    fn get(&self, prefer_fn: bool, fileline: &str) -> Option<&String> {
        let (primary, secondary) = if prefer_fn {
            (&self.loc_fn, &self.loc_other)
        } else {
            (&self.loc_other, &self.loc_fn)
        };
        let split = fileline.rsplit_once(':').and_then(|(f, l)| l.parse::<i64>().ok().map(|l| (f, l)));
        for m in [primary, secondary] {
            if let Some(v) = m.get(fileline) {
                return Some(v);
            }
            if let Some((f, l)) = split {
                if let Some(v) = m
                    .get(&format!("{f}:{}", l - 1))
                    .or_else(|| m.get(&format!("{f}:{}", l + 1)))
                {
                    return Some(v);
                }
            }
        }
        None
    }
}

fn dylib_env() -> &'static str {
    if cfg!(target_os = "macos") {
        "DYLD_FALLBACK_LIBRARY_PATH"
    } else {
        "LD_LIBRARY_PATH"
    }
}

fn sysroot(nightly: &str) -> Result<String> {
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

/// Run the driver over the workspace and (re)build the `calls`/`uses` edges from
/// its per-unit edge files, then the owner rollups. The driver binary must be
/// built against `nightly` (it links that toolchain's `rustc_driver`).
pub fn add_references_layer(
    graph: &mut Graph,
    ws_root: &Utf8Path,
    out: &Utf8Path,
    driver_bin: &Utf8Path,
    nightly: &str,
) -> Result<ReferenceCounts> {
    if !driver_bin.as_std_path().exists() {
        bail!(
            "rustc driver not found at {driver_bin} — build it (see crates/bg-driver) \
             and pass --driver-bin"
        );
    }
    let sysroot = sysroot(nightly)?;
    let edges_dir = out.join("driver-refs"); // persisted across runs (stable keys)
    let target_dir = out.join("driver-check"); // isolated + persisted -> incremental
    std::fs::create_dir_all(edges_dir.as_std_path()).ok();

    eprintln!(
        "[build-graph] references(driver): cargo +{nightly} check --all-targets via the rustc driver…"
    );
    let mut cmd = Command::new("cargo");
    cmd.arg(format!("+{nightly}"))
        .args(["check", "--all-targets", "--target-dir"])
        .arg(target_dir.as_str())
        .current_dir(ws_root.as_std_path())
        .env("RUSTC_WORKSPACE_WRAPPER", driver_bin.as_str())
        .env("BG_DRIVER_EDGES", edges_dir.as_str())
        .env(dylib_env(), format!("{sysroot}/lib"));
    free_toolchain(&mut cmd);
    let status = cmd
        .status()
        .context("running `cargo check` with the rustc driver")?;
    if !status.success() {
        bail!("`cargo check` (driver) failed (exit {status})");
    }

    // This layer is a full recompute from the persisted per-unit edge files.
    graph.remove_edges_with_relation("calls");
    graph.remove_edges_with_relation("uses");
    graph.remove_edges_with_relation("member_calls");
    graph.remove_edges_with_relation("member_uses");

    let loc = Locator::build(graph);
    let mut seen: HashSet<(String, String, &str)> = HashSet::new();
    let (mut calls, mut uses) = (0usize, 0usize);
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
            let is_call = kind == "call";
            // The caller is a fn/method/closure/const-initializer body owner. If
            // it maps to no node (a closure or const init — no Layer-2 item), roll
            // it up to the enclosing function so the edge survives.
            let Some(src) = loc.get(true, caller).or_else(|| loc.enclosing_fn(caller)) else {
                continue;
            };
            let Some(dst) = loc.get(is_call, callee) else {
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

    let (member_calls, member_uses) = add_member_reference_edges(graph);
    Ok(ReferenceCounts {
        calls,
        uses,
        member_calls,
        member_uses,
    })
}
