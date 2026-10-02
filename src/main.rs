//! `cargo-build-graph` — build a code knowledge graph directly from Rust build
//! artifacts. Install it (`cargo install build-graph`) to invoke as
//! `cargo build-graph <build|update|view>`.

mod cache;
mod cargo_build;
mod compiler_observer;
mod depinfo;
#[cfg(feature = "rustc-driver")]
mod driver_refs;
mod export_sources;
mod metadata;
mod qserve;
mod query;
mod render;
mod rustdoc;
mod scip;
mod serve;
#[cfg(test)]
mod test_support;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::ffi::OsString;

use anyhow::{Context, Result, bail};
use build_graph::export::{
    ArtifactFreshness, CompilerArtifact, CompilerReport, CompilerStatus, EXPORT_SCHEMA_VERSION,
    ExportManifest, ExtractionStatus, GraphArtifact, Layer, LayerReport, PackageReport,
    content_fingerprint,
};
use build_graph::{Graph, GraphJson, norm};
use camino::{Utf8Path, Utf8PathBuf};
use clap::{Args, Parser, Subcommand};

/// The nightly `crates/bg-driver` is pinned to (it links that toolchain's
/// `rustc_driver`) — the same nightly Layer 2's `rustdoc-types` pin matches.
/// Override with `--nightly` if you built the driver against another.
#[cfg(feature = "rustc-driver")]
const DEFAULT_DRIVER_NIGHTLY: &str = "nightly-2026-02-27";

#[derive(Parser)]
#[command(
    name = "cargo-build-graph",
    bin_name = "cargo build-graph",
    version,
    about = "Build a code knowledge graph directly from Rust build artifacts."
)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Run `cargo build` (JSON stream), then refresh the graph from target/.
    Build(BuildArgs),
    /// Watch the workspace and refresh the graph on every save (incrementally).
    Watch(WatchArgs),
    /// Re-extract the graph from the current target/ without building.
    Update(CommonArgs),
    /// Open the bundled HTML viewer for the generated graph.
    View(ViewArgs),
    /// Find symbols by name; prints their location + relationship counts.
    Find(FindArgs),
    /// Expand one node's relationships (bounded + filterable).
    Refs(RefsArgs),
    /// One-shot: a symbol's location, counts, and top callers/uses/impls/fields.
    Context(ContextArgs),
    /// Load the graph once and serve find/refs/context queries over a socket,
    /// so subsequent CLI calls are instant (they auto-connect to it).
    Serve(ServeArgs),
}

#[derive(Args, Clone)]
struct CommonArgs {
    /// Path to the Cargo.toml of the workspace to graph.
    #[arg(long)]
    manifest_path: Option<String>,
    /// Override the target directory (defaults to the workspace's).
    #[arg(long)]
    target_dir: Option<String>,
    /// Output directory (default: <target-dir>/build-graph).
    #[arg(long)]
    out: Option<String>,
    /// Also build the rich nightly rustdoc item layer (Layer 2).
    #[arg(long)]
    rich: bool,
    /// Drop derive-generated impls (clone/default/fmt/…) from the rich layer.
    #[arg(long)]
    no_derives: bool,
    /// Add semantic reference edges via rust-analyzer (implies `--rich`).
    /// Resolves method calls, calls in async fns, dyn-dispatch, and field/const
    /// uses, then rolls them up to owning structs/enums/traits/modules. Requires
    /// rust-analyzer; skipped with a message if it's absent.
    #[arg(long)]
    references: bool,
    /// Nightly toolchain for Layer 2 (default: auto-detect newest installed).
    #[arg(long)]
    nightly: Option<String>,
    /// Use the build-graph **rustc driver** for the references layer instead of
    /// rust-analyzer. The driver (`crates/bg-driver`) is built on demand; it
    /// reads the compiler's HIR during `cargo check`, so it's incremental for
    /// free (only changed crates re-run). Implies `--references`.
    #[cfg(feature = "rustc-driver")]
    #[arg(long)]
    driver: bool,
    /// Path to a prebuilt `bg-driver` binary (skips the on-demand build). Also
    /// enables the driver backend. Built against the `--nightly` toolchain.
    #[cfg(feature = "rustc-driver")]
    #[arg(long, value_name = "PATH")]
    driver_bin: Option<String>,
    /// Restrict extraction to these packages.
    #[arg(short = 'p', long = "package")]
    packages: Vec<String>,
    /// Attach portable observations from this build's actual rustc invocations.
    #[arg(long)]
    observe_compiler_inputs: bool,
    /// Additional approved input root: dependencies|host_tools|cargo_config=PATH.
    #[arg(long, value_name = "NAME=PATH", requires = "observe_compiler_inputs")]
    compiler_input_root: Vec<String>,
    /// Use the release profile.
    #[arg(long)]
    release: bool,
    /// Disable gzip compression of the graph data at rest. By default the graph
    /// is written as `graph.json.gz` (~35x smaller on a large workspace); reads
    /// auto-detect either form. Use this to emit a plain `graph.json` (e.g. for
    /// `jq` or the graphify MCP server).
    #[arg(long = "no-compress", action = clap::ArgAction::SetFalse)]
    compress: bool,
}

impl CommonArgs {
    /// Whether the rustc-driver references backend was requested. Always false
    /// when the `rustc-driver` feature is disabled (the flags don't exist).
    fn driver_requested(&self) -> bool {
        #[cfg(feature = "rustc-driver")]
        {
            self.driver || self.driver_bin.is_some()
        }
        #[cfg(not(feature = "rustc-driver"))]
        {
            false
        }
    }
}

#[derive(Args)]
struct BuildArgs {
    #[command(flatten)]
    common: CommonArgs,
    /// Extra arguments forwarded to `cargo build` (after `--`).
    #[arg(last = true)]
    cargo_args: Vec<String>,
}

#[derive(Args)]
struct WatchArgs {
    #[command(flatten)]
    common: CommonArgs,
    /// Poll/debounce interval in milliseconds between change checks (min 50).
    /// A change must hold steady for one interval before a refresh runs, so a
    /// burst of saves coalesces into a single rebuild.
    #[arg(long, default_value_t = 500)]
    debounce: u64,
    /// Don't run `cargo build` each cycle — just re-extract from the current
    /// target/. Use when your editor/rust-analyzer already drives the build and
    /// you only want the graph to track what's already compiled.
    #[arg(long, conflicts_with = "observe_compiler_inputs")]
    no_build: bool,
    /// Extra arguments forwarded to `cargo build` (after `--`).
    #[arg(last = true)]
    cargo_args: Vec<String>,
}

/// Where to read the graph.json from — shared by `find` and `refs`.
#[derive(Args)]
struct GraphLoc {
    /// Read this graph.json directly (default: <out>/graph.json).
    #[arg(long)]
    graph: Option<String>,
    /// Output directory the graph was written to (default: <target>/build-graph).
    #[arg(long)]
    out: Option<String>,
    /// Path to the Cargo.toml (used to locate the default target dir).
    #[arg(long)]
    manifest_path: Option<String>,
}

#[derive(Args)]
struct FindArgs {
    /// Symbol name (or module-path fragment) to search for. Omit when using --at.
    query: Option<String>,
    /// Reverse lookup: the symbol defined at FILE:LINE (e.g. `--at src/lib.rs:771`).
    /// Returns the nearest definition at or above the line — go from a code
    /// location straight to its graph node + reference counts.
    #[arg(long, value_name = "FILE:LINE")]
    at: Option<String>,
    /// Require an exact (case-insensitive) name match instead of a substring.
    #[arg(long)]
    exact: bool,
    /// Filter by node kind: struct, enum, trait, fn, method, field, type, …
    #[arg(long)]
    kind: Option<String>,
    /// Filter by crate name.
    #[arg(long = "crate")]
    krate: Option<String>,
    /// Maximum number of matching symbols to return (capped at 100).
    #[arg(long, default_value_t = 20)]
    limit: usize,
    /// Emit JSON (stable shape, for tools and AI agents).
    #[arg(long)]
    json: bool,
    #[command(flatten)]
    loc: GraphLoc,
}

#[derive(Args)]
struct RefsArgs {
    /// Node id (from `find`) or a symbol name to expand the relationships of.
    query: String,
    /// Only this relation (has_method, has_field, implements, takes, returns,
    /// uses_type, has_variant, contains, …).
    #[arg(long)]
    relation: Option<String>,
    /// Only incoming edges (what references the symbol). Default: both.
    #[arg(long)]
    incoming: bool,
    /// Only outgoing edges (what the symbol contains/uses). Default: both.
    #[arg(long)]
    outgoing: bool,
    /// Filter neighbors by a name/path substring (text search).
    #[arg(long = "match")]
    name_match: Option<String>,
    /// Filter neighbors by kind.
    #[arg(long)]
    kind: Option<String>,
    /// Filter neighbors by crate.
    #[arg(long = "crate")]
    krate: Option<String>,
    /// Max edges to return (default 50, hard cap 200 — narrow with filters).
    #[arg(long, default_value_t = 50)]
    limit: usize,
    /// Follow the relation transitively up to N hops (1 = direct; capped at 5).
    /// Pair with --incoming/--outgoing + --relation, e.g. callers-of-callers.
    #[arg(long, default_value_t = 1)]
    depth: usize,
    /// Emit JSON (stable shape, for tools and AI agents).
    #[arg(long)]
    json: bool,
    #[command(flatten)]
    loc: GraphLoc,
}

#[derive(Args)]
struct ContextArgs {
    /// Node id (from `find`) or a symbol name to summarize.
    query: String,
    /// Max neighbors shown per relationship group (capped at 25).
    #[arg(long, default_value_t = 6)]
    per_group: usize,
    /// Emit JSON (stable shape, for tools and AI agents).
    #[arg(long)]
    json: bool,
    #[command(flatten)]
    loc: GraphLoc,
}

#[derive(Args)]
struct ServeArgs {
    /// Address to bind.
    #[arg(long, default_value = "127.0.0.1")]
    addr: String,
    /// Port to bind (0 = pick a free port; the chosen port is written to the
    /// graph's `.build-graph-serve` file so the CLI can find it).
    #[arg(long, short = 'p', default_value_t = 0)]
    port: u16,
    #[command(flatten)]
    loc: GraphLoc,
}

#[derive(Args)]
struct ViewArgs {
    /// Output directory the graph was written to (default: <target>/build-graph).
    #[arg(long)]
    out: Option<String>,
    /// Path to the Cargo.toml (used to locate the default target dir).
    #[arg(long)]
    manifest_path: Option<String>,
    /// Print the path instead of opening a browser.
    #[arg(long)]
    no_open: bool,
}

fn main() -> Result<()> {
    // When invoked as `cargo build-graph …`, cargo passes "build-graph" as argv[1].
    let mut args: Vec<OsString> = std::env::args_os().collect();
    if compiler_observer::is_wrapper(&args) {
        std::process::exit(compiler_observer::wrapper(&args[1..]));
    }
    if args.get(1).map(|s| s == "build-graph").unwrap_or(false) {
        args.remove(1);
    }
    match Cli::parse_from(args).cmd {
        Cmd::Build(a) => run_build(a),
        Cmd::Watch(w) => run_watch(w),
        Cmd::Update(c) => {
            if c.observe_compiler_inputs {
                bail!("compiler observation requires an actual build");
            }
            run_extract(&c, None)
        }
        Cmd::View(v) => run_view(v),
        Cmd::Find(f) => run_find(f),
        Cmd::Refs(r) => run_refs(r),
        Cmd::Context(c) => run_context(c),
        Cmd::Serve(s) => run_serve(s),
    }
}

fn run_build(a: BuildArgs) -> Result<()> {
    build_and_extract(&a.common, &a.cargo_args, true)
}

/// One refresh pass: optionally run `cargo build`, then (re)extract the graph
/// from target/. Shared by `build` and the `watch` loop. Both the build and the
/// extract are already incremental — only changed crates recompile/re-document.
fn build_and_extract(common: &CommonArgs, cargo_args: &[String], do_build: bool) -> Result<()> {
    if common.observe_compiler_inputs && !do_build {
        bail!("compiler observation requires an actual build");
    }
    let mut observations = None;
    let compiled = if do_build {
        let manifest = common.manifest_path.as_ref().map(Utf8PathBuf::from);
        let mut session = if common.observe_compiler_inputs {
            let meta = metadata::load(manifest.as_deref())?;
            let target = meta.target_directory.as_std_path().to_path_buf();
            Some(compiler_observer::Session::new(
                meta,
                &target,
                &common.compiler_input_root,
            )?)
        } else {
            None
        };
        let compiled = cargo_build::run_build(
            manifest.as_deref(),
            common.release,
            &common.packages,
            cargo_args,
            session.as_mut(),
        )?;
        observations = session.as_ref().map(compiler_observer::Session::finish);
        let changed = compiled.iter().filter(|t| t.changed()).count();
        eprintln!(
            "[build-graph] build ok: {} artifact(s), {} recompiled",
            compiled.len(),
            changed
        );
        Some(compiled)
    } else {
        None
    };
    let manifest = common.manifest_path.as_ref().map(Utf8PathBuf::from);
    let meta = metadata::load(manifest.as_deref())?;
    run_extract_observed(
        common,
        compiled.as_deref(),
        meta,
        rustdoc::add_item_layer,
        observations,
    )
}

/// Watch the workspace and re-run the incremental refresh whenever a `.rs` or
/// `Cargo.toml` file changes. Layers 1–2 already reuse the prior graph for
/// unchanged crates, so a save only re-does the crate(s) you touched. The graph
/// (and anything serving it) updates in place.
fn run_watch(a: WatchArgs) -> Result<()> {
    if a.no_build && a.common.observe_compiler_inputs {
        bail!("compiler observation requires an actual build");
    }
    let manifest = a.common.manifest_path.as_ref().map(Utf8PathBuf::from);
    let meta = metadata::load(manifest.as_deref())?;
    let root = meta.workspace_root.clone();
    let target_dir = a
        .common
        .target_dir
        .as_ref()
        .map(Utf8PathBuf::from)
        .unwrap_or_else(|| meta.target_directory.clone());
    let out = a
        .common
        .out
        .as_ref()
        .map(Utf8PathBuf::from)
        .unwrap_or_else(|| target_dir.join("build-graph"));
    // Don't let our own outputs (or cargo's) trigger another rebuild.
    let excludes: Vec<std::path::PathBuf> = vec![
        target_dir.as_std_path().to_path_buf(),
        out.as_std_path().to_path_buf(),
    ];
    let do_build = !a.no_build;
    let interval = std::time::Duration::from_millis(a.debounce.max(50));

    eprintln!("[build-graph] watch: workspace {root}");
    if let Err(e) = build_and_extract(&a.common, &a.cargo_args, do_build) {
        eprintln!("[build-graph] watch: initial refresh failed — {e:#}");
    }
    eprintln!("[build-graph] watch: watching .rs/Cargo.toml under {root} (Ctrl-C to stop)…");

    let mut last = workspace_fingerprint(&root, &excludes);
    loop {
        std::thread::sleep(interval);
        let mut fp = workspace_fingerprint(&root, &excludes);
        if fp == last {
            continue;
        }
        // Let a burst of saves settle before rebuilding: wait until the
        // fingerprint stops moving for one whole interval.
        loop {
            std::thread::sleep(interval);
            let next = workspace_fingerprint(&root, &excludes);
            if next == fp {
                break;
            }
            fp = next;
        }
        eprintln!("[build-graph] watch: change detected — refreshing…");
        if let Err(e) = build_and_extract(&a.common, &a.cargo_args, do_build) {
            eprintln!("[build-graph] watch: refresh failed — {e:#}");
        }
        // Rescan after the refresh so sources the build itself touched (e.g.
        // generated files under a watched dir) don't immediately re-trigger.
        last = workspace_fingerprint(&root, &excludes);
    }
}

fn is_excluded(path: &std::path::Path, excludes: &[std::path::PathBuf]) -> bool {
    excludes.iter().any(|e| path.starts_with(e))
        || path.components().any(|c| c.as_os_str() == ".git")
}

/// A cheap change signal: hash of every workspace `.rs`/`Cargo.toml` path + mtime,
/// skipping target/, the output dir, and `.git`. Reuses the same mtime basis as
/// the per-crate cache, so it flags exactly the edits a refresh would act on.
fn workspace_fingerprint(root: &Utf8Path, excludes: &[std::path::PathBuf]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut items: Vec<(String, u128)> = Vec::new();
    for entry in walkdir::WalkDir::new(root.as_std_path())
        .into_iter()
        .filter_entry(|e| !is_excluded(e.path(), excludes))
        .flatten()
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let p = entry.path();
        let is_rs = p.extension().and_then(|e| e.to_str()) == Some("rs");
        let is_manifest = p.file_name().and_then(|n| n.to_str()) == Some("Cargo.toml");
        if !is_rs && !is_manifest {
            continue;
        }
        let mtime = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        items.push((p.to_string_lossy().into_owned(), mtime));
    }
    items.sort();
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for (path, mtime) in items {
        path.hash(&mut hasher);
        mtime.hash(&mut hasher);
    }
    hasher.finish()
}

fn run_extract(c: &CommonArgs, compiled: Option<&[cargo_build::CompiledTarget]>) -> Result<()> {
    let manifest = c.manifest_path.as_ref().map(Utf8PathBuf::from);
    let meta = metadata::load(manifest.as_deref())?;
    run_extract_with_item_layer(c, compiled, meta, rustdoc::add_item_layer)
}

type ItemLayerExtractor = fn(
    &mut Graph,
    &cargo_metadata::Metadata,
    &Utf8Path,
    Option<&str>,
    &[String],
    bool,
    bool,
) -> Result<rustdoc::ItemLayerResult>;

fn run_extract_with_item_layer(
    c: &CommonArgs,
    compiled: Option<&[cargo_build::CompiledTarget]>,
    meta: cargo_metadata::Metadata,
    extract_items: ItemLayerExtractor,
) -> Result<()> {
    run_extract_observed(c, compiled, meta, extract_items, None)
}

fn run_extract_observed(
    c: &CommonArgs,
    compiled: Option<&[cargo_build::CompiledTarget]>,
    meta: cargo_metadata::Metadata,
    extract_items: ItemLayerExtractor,
    compiler_invocations: Option<build_graph::compiler_invocation::CompilerInvocationsV1>,
) -> Result<()> {
    let target_dir = c
        .target_dir
        .as_ref()
        .map(Utf8PathBuf::from)
        .unwrap_or_else(|| meta.target_directory.clone());
    let out = c
        .out
        .as_ref()
        .map(Utf8PathBuf::from)
        .unwrap_or_else(|| target_dir.join("build-graph"));
    let profiles: &[&str] = if c.release { &["release"] } else { &["debug"] };
    // The rustc-driver backend (`--driver`/`--driver-bin`) produces the
    // references layer, so it implies `--references`; `--references` in turn
    // needs the rich item nodes to connect to, so it implies `--rich`.
    let references = c.references || c.driver_requested();
    let rich = c.rich || references;

    // Reuse the prior graph when the cache is compatible (same layer settings).
    // The prior graph may be in either form (gzip or plain) — `find_graph`
    // prefers `.gz` and `load_graph` decompresses transparently, so an
    // incremental run reloads it regardless of the compression flag.
    let cache_path = out.join(cache::CACHE_FILE);
    let existing = build_graph::output::find_graph(out.as_std_path());
    let prior = cache::Cache::load(cache_path.as_std_path());
    let compatible = prior
        .as_ref()
        .map(|p| p.rich == rich && p.no_derives == c.no_derives && p.references == references)
        .unwrap_or(false)
        && existing.is_some();
    let mut prior_export = None;
    let mut graph = match (compatible, &existing) {
        (true, Some(path)) => match build_graph::output::read_graph(path) {
            Ok(doc) => {
                prior_export = build_graph::output::read_export(out.as_std_path())
                    .ok()
                    .filter(|manifest| manifest.matches_graph(&doc).unwrap_or(false));
                Graph::load(doc)
            }
            Err(_) => Graph::new(),
        },
        _ => Graph::new(),
    };
    let prior_crates = match (compatible, prior) {
        (true, Some(p)) => p.crates,
        _ => BTreeMap::new(),
    };

    // Fingerprint every crate by its sources' mtimes; dirty = changed/new.
    let depidx = depinfo::DepIndex::build(&target_dir, profiles);
    let ws_pkgs = meta.workspace_packages();
    let sources: BTreeMap<_, _> = ws_pkgs
        .iter()
        .map(|pkg| {
            let root = pkg
                .manifest_path
                .parent()
                .unwrap_or(meta.workspace_root.as_path());
            (
                pkg.name.clone(),
                export_sources::capture(root, &meta.workspace_root, &[&target_dir, &out]),
            )
        })
        .collect();
    let mut current: BTreeMap<String, String> = BTreeMap::new();
    let mut all_sources: HashMap<String, Vec<depinfo::SourceFile>> = HashMap::new();
    let mut dirty = HashSet::new();
    for &pkg in &ws_pkgs {
        let manifest_dir = pkg
            .manifest_path
            .parent()
            .unwrap_or(meta.workspace_root.as_path());
        let srcs = depidx.crate_sources(
            &rustdoc::lib_crate_name(pkg),
            manifest_dir,
            &meta.workspace_root,
        );
        let fp = depinfo::fingerprint(&srcs);
        let export_reusable = prior_export.as_ref().is_some_and(|manifest| {
            manifest.sources.get(&pkg.name) == sources.get(&pkg.name)
                && sources
                    .get(&pkg.name)
                    .is_some_and(|snapshot| snapshot.complete)
        });
        let items_reusable = !rich
            || prior_export.as_ref().is_some_and(|manifest| {
                manifest
                    .layers
                    .iter()
                    .find(|layer| layer.layer == Layer::Items)
                    .and_then(|layer| {
                        layer
                            .packages
                            .iter()
                            .find(|report| report.package == pkg.name)
                    })
                    .is_some_and(|report| report.status == ExtractionStatus::Complete)
            });
        if !compatible
            || prior_crates.get(&pkg.name) != Some(&fp)
            || !export_reusable
            || !items_reusable
        {
            dirty.insert(pkg.name.clone());
        }
        all_sources.insert(pkg.name.clone(), srcs);
        current.insert(pkg.name.clone(), fp);
    }
    let removed: Vec<String> = prior_crates
        .keys()
        .filter(|k| !current.contains_key(*k))
        .cloned()
        .collect();
    expand_dirty_namespaces(&mut dirty, &removed, &current);
    let dirty_sources: HashMap<_, _> = all_sources
        .into_iter()
        .filter(|(name, _)| dirty.contains(name))
        .collect();
    let mut definitions = prior_export
        .as_ref()
        .map(|manifest| manifest.definitions.clone())
        .unwrap_or_default();
    definitions.retain(|record| {
        !dirty.contains(&record.identity.package) && current.contains_key(&record.identity.package)
    });
    let want: HashSet<&str> = c.packages.iter().map(|s| s.as_str()).collect();
    let mut item_reports: BTreeMap<String, PackageReport> = ws_pkgs
        .iter()
        .map(|pkg| {
            let reason = if !rich {
                Some("layer not requested")
            } else if !want.is_empty() && !want.contains(pkg.name.as_str()) {
                Some("package outside requested item scope")
            } else if !pkg.targets.iter().any(rustdoc::is_lib_target) {
                Some("no library target")
            } else if !pkg.targets.iter().any(rustdoc::is_documented_lib_target) {
                Some("library documentation disabled")
            } else {
                None
            };
            let mut report = if let Some(reason) = reason {
                PackageReport {
                    package: pkg.name.clone(),
                    status: ExtractionStatus::Skipped,
                    freshness: ArtifactFreshness::Unknown,
                    reason: Some(reason.into()),
                }
            } else if !dirty.contains(&pkg.name) {
                prior_export
                    .as_ref()
                    .and_then(|manifest| {
                        manifest
                            .layers
                            .iter()
                            .find(|layer| layer.layer == Layer::Items)
                    })
                    .and_then(|layer| {
                        layer
                            .packages
                            .iter()
                            .find(|report| report.package == pkg.name)
                    })
                    .cloned()
                    .unwrap_or_else(|| PackageReport {
                        package: pkg.name.clone(),
                        status: ExtractionStatus::Partial,
                        freshness: ArtifactFreshness::Unknown,
                        reason: Some("cached items have no supported provenance".into()),
                    })
            } else {
                PackageReport {
                    package: pkg.name.clone(),
                    status: ExtractionStatus::Partial,
                    freshness: ArtifactFreshness::Unknown,
                    reason: Some("items not extracted".into()),
                }
            };
            if compiled.is_none()
                && !dirty.contains(&pkg.name)
                && report.status != ExtractionStatus::Skipped
            {
                report.status = ExtractionStatus::Partial;
                report.freshness = ArtifactFreshness::Unknown;
                report.reason = Some("cached items reused without a compiler run".into());
            }
            (pkg.name.clone(), report)
        })
        .collect();
    let mut reference_report = LayerReport::from_packages(Layer::References, Vec::new());
    reference_report.reason = Some(
        if references {
            "cached reference coverage is unknown"
        } else {
            "layer not requested"
        }
        .into(),
    );
    if references {
        reference_report.status = ExtractionStatus::Partial;
    }
    // Drop changed/removed crates before re-extracting them.
    for name in dirty.iter().chain(removed.iter()) {
        graph.remove_crate(&norm(name));
    }

    // Layer 1: crate + dependency edges (cheap, always fresh).
    metadata::add_crate_layer(&mut graph, &meta);

    // Layer 1: source files for the dirty crates only.
    let mut files = 0usize;
    for (name, srcs) in &dirty_sources {
        files += depinfo::add_crate_files(&mut graph, name, srcs);
    }
    eprintln!(
        "[build-graph] layer 1: {} crate(s), {} dirty, +{files} file(s) re-scanned",
        ws_pkgs.len(),
        dirty.len()
    );

    // Layer 2: rich items, re-documenting only the dirty crates.
    if rich {
        let rich_dirty: Vec<String> = ws_pkgs
            .iter()
            .filter(|p| dirty.contains(&p.name))
            .filter(|p| want.is_empty() || want.contains(p.name.as_str()))
            .filter(|p| p.targets.iter().any(rustdoc::is_documented_lib_target))
            .map(|p| p.name.clone())
            .collect();
        if rich_dirty.is_empty() {
            eprintln!("[build-graph] layer 2: no changed crates to re-document");
        } else {
            let t2 = std::time::Instant::now();
            let result = extract_items(
                &mut graph,
                &meta,
                &target_dir,
                c.nightly.as_deref(),
                &rich_dirty,
                c.release,
                c.no_derives,
            )?;
            definitions.extend(result.definitions);
            for report in result.packages {
                item_reports.insert(report.package.clone(), report);
            }
            eprintln!(
                "[build-graph] layer 2: +{} item node(s) ({} crate(s), {:.1}s)",
                result.items,
                rich_dirty.len(),
                t2.elapsed().as_secs_f64()
            );
        }

        // Layer 3 (semantic) — body-level calls/uses. Two backends: the rustc
        // driver (incremental; only changed crates re-run) or rust-analyzer SCIP
        // (cold whole-workspace index). Only (re)run when something changed.
        if references && !dirty.is_empty() {
            let t3 = std::time::Instant::now();
            let result;
            let backend;
            #[cfg(feature = "rustc-driver")]
            if c.driver_requested() {
                let nightly = c.nightly.as_deref().unwrap_or(DEFAULT_DRIVER_NIGHTLY);
                result = driver_refs::resolve_driver(c.driver_bin.as_deref()).and_then(|bin| {
                    driver_refs::add_references_layer(
                        &mut graph,
                        &meta.workspace_root,
                        &out,
                        &bin,
                        nightly,
                    )
                });
                backend = "rustc driver";
            } else {
                result = scip::add_references_layer(&mut graph, &meta.workspace_root, &out);
                backend = "rust-analyzer";
            }
            #[cfg(not(feature = "rustc-driver"))]
            {
                result = scip::add_references_layer(&mut graph, &meta.workspace_root, &out);
                backend = "rust-analyzer";
            }
            match result {
                Ok(counts) => {
                    reference_report.status = ExtractionStatus::Partial;
                    reference_report.reason = Some(format!(
                        "{backend} completed; per-target reference coverage is not measured"
                    ));
                    eprintln!(
                        "[build-graph] layer 3: +{} calls, +{} uses, +{} member_calls, +{} member_uses edge(s) ({backend}, {:.1}s)",
                        counts.calls,
                        counts.uses,
                        counts.member_calls,
                        counts.member_uses,
                        t3.elapsed().as_secs_f64()
                    );
                }
                Err(e) => {
                    reference_report.status = ExtractionStatus::Skipped;
                    reference_report.reason = Some(format!(
                        "references skipped: {e:#}; retained reference artifacts have unknown freshness"
                    ));
                    eprintln!("[build-graph] layer 3: references skipped — {e:#}");
                }
            }
        }
    }

    graph.prune_dangling_edges();
    let mut source_reports = Vec::new();
    for pkg in &ws_pkgs {
        let root = pkg
            .manifest_path
            .parent()
            .unwrap_or(meta.workspace_root.as_path());
        let after = export_sources::capture(root, &meta.workspace_root, &[&target_dir, &out]);
        let before = sources.get(&pkg.name);
        let fully_observed = after.complete && before.is_some_and(|snapshot| snapshot.complete);
        let stable = before == Some(&after) && fully_observed;
        let freshness = if fully_observed && !stable {
            ArtifactFreshness::Stale
        } else {
            ArtifactFreshness::Unknown
        };
        source_reports.push(PackageReport {
            package: pkg.name.clone(),
            status: ExtractionStatus::Partial,
            freshness,
            reason: Some(
                if stable {
                    "dep-info input coverage is not measured"
                } else {
                    "source set changed or could not be fully observed during extraction"
                }
                .into(),
            ),
        });
        if !stable {
            if let Some(report) = item_reports.get_mut(&pkg.name)
                && report.status != ExtractionStatus::Skipped
            {
                report.status = ExtractionStatus::Partial;
                report.freshness = freshness;
                report.reason = Some(
                    "source set changed or could not be fully observed during extraction".into(),
                );
            }
            if references {
                reference_report.status = ExtractionStatus::Partial;
                reference_report.reason = Some(
                    "source set changed or could not be fully observed during extraction".into(),
                );
            }
        }
    }
    definitions.sort();
    let (nodes, edges) = (graph.node_count(), graph.edge_count());
    let doc = graph.into_doc();
    let wrote = if c.compress {
        build_graph::output::GRAPH_JSON_GZ
    } else {
        build_graph::output::GRAPH_JSON
    };
    let export = ExportManifest {
        schema_version: EXPORT_SCHEMA_VERSION,
        graph: GraphArtifact {
            filename: wrote.into(),
            content_fingerprint: content_fingerprint(&serde_json::to_vec(&doc)?),
        },
        compiler: CompilerReport {
            status: if compiled.is_some() {
                CompilerStatus::Succeeded
            } else {
                CompilerStatus::Unknown
            },
            artifacts: compiled
                .unwrap_or(&[])
                .iter()
                .map(|artifact| CompilerArtifact {
                    package_id: artifact.package_id.to_string(),
                    target_name: artifact.target_name.clone(),
                    fresh: artifact.fresh,
                })
                .collect(),
        },
        compiler_invocations,
        sources,
        layers: vec![
            LayerReport::from_packages(Layer::Sources, source_reports),
            LayerReport::from_packages(Layer::Items, item_reports.into_values().collect()),
            reference_report,
        ],
        definitions,
    };
    let title = meta.workspace_root.file_name().unwrap_or("build-graph");
    build_graph::output::write_graph_with_title(out.as_std_path(), &doc, c.compress, title)
        .with_context(|| format!("writing graph to {out}"))?;
    build_graph::output::write_export(out.as_std_path(), &export)
        .with_context(|| format!("writing export metadata to {out}"))?;
    cache::Cache::new(rich, c.no_derives, references, current)
        .save(cache_path.as_std_path())
        .with_context(|| format!("writing cache to {cache_path}"))?;
    eprintln!("[build-graph] wrote {out}/{wrote} ({nodes} nodes, {edges} edges)");
    eprintln!("[build-graph] view: cargo build-graph view --out {out}");
    Ok(())
}

/// `remove_crate` removes a normalized namespace, which can be shared by
/// multiple exact Cargo package names. Invalidate every surviving member of
/// any namespace being replaced before reusing its definitions or reports.
fn expand_dirty_namespaces(
    dirty: &mut HashSet<String>,
    removed: &[String],
    current: &BTreeMap<String, String>,
) {
    let namespaces: HashSet<String> = dirty.iter().chain(removed).map(|name| norm(name)).collect();
    dirty.extend(
        current
            .keys()
            .filter(|name| namespaces.contains(&norm(name)))
            .cloned(),
    );
}

fn run_view(v: ViewArgs) -> Result<()> {
    let out = match v.out {
        Some(o) => Utf8PathBuf::from(o),
        None => {
            let manifest = v.manifest_path.as_ref().map(Utf8PathBuf::from);
            let meta = metadata::load(manifest.as_deref())?;
            meta.target_directory.join("build-graph")
        }
    };
    let html = out.join("graph.html");
    if !html.as_std_path().exists() {
        bail!("{html} not found — run `cargo build-graph build` first");
    }
    // Large graphs aren't inlined: the HTML fetches graph.json, which browsers
    // only allow over HTTP. Serve those; small (inlined) graphs open from file://.
    let serve_http = serve::needs_http(html.as_std_path())?;
    if v.no_open {
        println!("{html}");
        if serve_http {
            eprintln!(
                "[build-graph] note: this graph loads graph.json over HTTP — serve the dir \
                 (e.g. `python3 -m http.server --directory {out}`); file:// won't fetch it"
            );
        }
        return Ok(());
    }
    if serve_http {
        serve::serve_and_open(out.as_std_path(), "graph.html", true)
    } else {
        open_in_browser(html.as_str())
    }
}

fn parse_at(s: &str) -> Result<(String, u32)> {
    let (file, line) = s
        .rsplit_once(':')
        .context("--at must be FILE:LINE (e.g. src/lib.rs:771)")?;
    let line = line
        .trim()
        .parse::<u32>()
        .with_context(|| format!("--at line must be a number, got `{line}`"))?;
    Ok((file.to_string(), line))
}

/// The out dir to look for a running server in, without `cargo metadata`:
/// the parent of an explicit `--graph`, or `--out` itself. `None` → the client
/// walks up from the cwd for `target/build-graph`.
fn explicit_out(loc: &GraphLoc) -> Option<Utf8PathBuf> {
    if let Some(g) = &loc.graph {
        return Utf8PathBuf::from(g).parent().map(|p| p.to_path_buf());
    }
    loc.out.as_ref().map(Utf8PathBuf::from)
}

fn run_find(a: FindArgs) -> Result<()> {
    let at = a.at.as_deref().map(parse_at).transpose()?;
    if at.is_none() && a.query.is_none() {
        bail!("provide a symbol name to search, or --at FILE:LINE for a reverse lookup");
    }
    let limit = a.limit.clamp(1, 100);
    let req = qserve::Request::Find {
        query: a.query.clone().unwrap_or_default(),
        exact: a.exact,
        kind: a.kind.clone(),
        krate: a.krate.clone(),
        at: at.clone(),
        limit,
        json: a.json,
    };
    if let Some(resp) = qserve::try_remote(explicit_out(&a.loc).as_deref(), &req) {
        print!("{resp}");
        return Ok(());
    }
    let doc = read_doc(&resolve_graph_path(&a.loc)?)?;
    let opts = query::FindOpts {
        query: a.query.unwrap_or_default(),
        exact: a.exact,
        kind: a.kind,
        krate: a.krate,
        at,
        limit,
    };
    print!("{}", render::find(&query::find(&doc, &opts), a.json));
    Ok(())
}

fn run_refs(a: RefsArgs) -> Result<()> {
    // Neither flag given → both directions.
    let (incoming, outgoing) = if a.incoming || a.outgoing {
        (a.incoming, a.outgoing)
    } else {
        (true, true)
    };
    let limit = a.limit.clamp(1, 200);
    let depth = a.depth.clamp(1, 5);
    let req = qserve::Request::Refs {
        query: a.query.clone(),
        relation: a.relation.clone(),
        incoming,
        outgoing,
        name_match: a.name_match.clone(),
        kind: a.kind.clone(),
        krate: a.krate.clone(),
        limit,
        depth,
        json: a.json,
    };
    if let Some(resp) = qserve::try_remote(explicit_out(&a.loc).as_deref(), &req) {
        print!("{resp}");
        return Ok(());
    }
    let doc = read_doc(&resolve_graph_path(&a.loc)?)?;
    let opts = query::RefsOpts {
        query: a.query.clone(),
        relation: a.relation,
        incoming,
        outgoing,
        name_match: a.name_match,
        kind: a.kind,
        krate: a.krate,
        limit,
        depth,
    };
    print!(
        "{}",
        render::refs(&query::refs(&doc, &opts), &a.query, a.json)
    );
    Ok(())
}

fn run_context(a: ContextArgs) -> Result<()> {
    let per_group = a.per_group.clamp(1, 25);
    let req = qserve::Request::Context {
        query: a.query.clone(),
        per_group,
        json: a.json,
    };
    if let Some(resp) = qserve::try_remote(explicit_out(&a.loc).as_deref(), &req) {
        print!("{resp}");
        return Ok(());
    }
    let doc = read_doc(&resolve_graph_path(&a.loc)?)?;
    let result = query::context(&doc, &a.query, per_group);
    print!("{}", render::context(&result, &a.query, a.json));
    Ok(())
}

fn run_serve(a: ServeArgs) -> Result<()> {
    let path = resolve_graph_path(&a.loc)?;
    let out = path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| Utf8PathBuf::from("."));
    eprintln!("[build-graph] serve: loading {path} (once)…");
    let doc = read_doc(&path)?;
    qserve::serve(doc, &out, &a.addr, a.port)
}

fn read_doc(path: &Utf8Path) -> Result<GraphJson> {
    // Transparently decompresses a gzip graph (detected by magic bytes).
    build_graph::output::read_graph(path.as_std_path())
        .with_context(|| format!("reading {path} (is it a build-graph graph file?)"))
}

/// Locate the graph data to query: `--graph` wins (exact path), else the
/// `graph.json.gz`/`graph.json` in `<out>`, else in the workspace's
/// `<target>/build-graph`. Prefers the compressed form when both exist.
fn resolve_graph_path(loc: &GraphLoc) -> Result<Utf8PathBuf> {
    if let Some(g) = &loc.graph {
        let p = Utf8PathBuf::from(g);
        if !p.as_std_path().exists() {
            bail!("{p} not found");
        }
        return Ok(p);
    }
    let out = match &loc.out {
        Some(o) => Utf8PathBuf::from(o),
        None => {
            let manifest = loc.manifest_path.as_ref().map(Utf8PathBuf::from);
            let meta = metadata::load(manifest.as_deref())?;
            meta.target_directory.join("build-graph")
        }
    };
    match build_graph::output::find_graph(out.as_std_path()) {
        Some(p) => Utf8PathBuf::from_path_buf(p)
            .map_err(|p| anyhow::anyhow!("graph path is not valid UTF-8: {}", p.display())),
        None => bail!("no graph.json[.gz] in {out} — run `cargo build-graph build --rich` first"),
    }
}

#[cfg(target_os = "macos")]
fn open_in_browser(path: &str) -> Result<()> {
    std::process::Command::new("open")
        .arg(path)
        .status()
        .context("failed to launch `open`")?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn open_in_browser(path: &str) -> Result<()> {
    let opener = if cfg!(target_os = "windows") {
        "explorer"
    } else {
        "xdg-open"
    };
    std::process::Command::new(opener)
        .arg(path)
        .status()
        .with_context(|| format!("failed to launch `{opener}`"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use build_graph::export::{DefinitionIdentity, DefinitionRecord};
    use build_graph::{Node, crate_id, item_id};

    use super::*;
    use crate::test_support::Workspace;

    #[test]
    fn watch_observation_conflict_is_rejected_by_clap() {
        for args in [
            [
                "cargo-build-graph",
                "watch",
                "--no-build",
                "--observe-compiler-inputs",
            ],
            [
                "cargo-build-graph",
                "watch",
                "--observe-compiler-inputs",
                "--no-build",
            ],
        ] {
            let error = Cli::try_parse_from(args).err().expect("static conflict");
            assert_eq!(error.kind(), clap::error::ErrorKind::ArgumentConflict);
        }
        assert!(Cli::try_parse_from(["cargo-build-graph", "watch", "--no-build"]).is_ok());
        assert!(
            Cli::try_parse_from(["cargo-build-graph", "watch", "--observe-compiler-inputs"])
                .is_ok()
        );
    }

    fn fixture_items(
        graph: &mut Graph,
        meta: &cargo_metadata::Metadata,
        _target_dir: &Utf8Path,
        _nightly: Option<&str>,
        packages: &[String],
        _release: bool,
        _no_derives: bool,
    ) -> Result<rustdoc::ItemLayerResult> {
        let mut result = rustdoc::ItemLayerResult {
            items: 0,
            definitions: Vec::new(),
            packages: Vec::new(),
        };
        for pkg in meta.workspace_packages() {
            if !packages.contains(&pkg.name) {
                continue;
            }
            let source = std::fs::read_to_string(&pkg.targets[0].src_path)?;
            let name = source
                .trim()
                .strip_prefix("pub struct ")
                .and_then(|source| source.strip_suffix(';'))
                .expect("fixture struct declaration");
            let id = item_id(&pkg.name, name, "struct");
            graph.add_node(Node::new(id.clone(), name, "struct"));
            graph.add_edge(crate_id(&pkg.name), &id, "contains", None, None);
            result.definitions.push(DefinitionRecord {
                graph_node_id: id,
                identity: DefinitionIdentity {
                    package: pkg.name.clone(),
                    def_path: name.into(),
                    kind: "struct".into(),
                },
                span: None,
            });
            result.packages.push(PackageReport {
                package: pkg.name.clone(),
                status: ExtractionStatus::Complete,
                freshness: ArtifactFreshness::Current,
                reason: None,
            });
            result.items += 1;
        }
        Ok(result)
    }

    fn fixture_args(workspace: &Workspace) -> CommonArgs {
        let out = workspace.root.join("target/build-graph");
        let cli = Cli::try_parse_from([
            "cargo-build-graph",
            "update",
            "--rich",
            "--no-compress",
            "--out",
            out.as_str(),
        ])
        .expect("fixture CLI arguments");
        match cli.cmd {
            Cmd::Update(args) => args,
            _ => panic!("fixture update command"),
        }
    }

    fn refresh_fixture(workspace: &Workspace, args: &CommonArgs) -> (GraphJson, ExportManifest) {
        run_extract_with_item_layer(args, Some(&[]), workspace.meta.clone(), fixture_items)
            .expect("fixture extraction");
        let out = Utf8Path::new(args.out.as_ref().expect("fixture output"));
        let graph = build_graph::output::read_graph(out.join("graph.json").as_std_path())
            .expect("written graph");
        let export = build_graph::output::read_export(out.as_std_path()).expect("written sidecar");
        assert!(export.matches_graph(&graph).expect("graph binding"));
        for definition in &export.definitions {
            assert!(
                graph
                    .nodes
                    .iter()
                    .any(|node| node.id == definition.graph_node_id)
            );
        }
        (graph, export)
    }

    fn item_report<'a>(export: &'a ExportManifest, package: &str) -> &'a PackageReport {
        export
            .layers
            .iter()
            .find(|layer| layer.layer == Layer::Items)
            .expect("item layer")
            .packages
            .iter()
            .find(|report| report.package == package)
            .expect("item package report")
    }

    fn collision_workspace() -> Workspace {
        let workspace = Workspace::new(&[("pkg-a", "first_lib"), ("pkg_a", "second_lib")]);
        workspace.change_source("pkg-a", "Alpha");
        workspace.change_source("pkg_a", "Beta");
        workspace
    }

    #[test]
    fn incremental_edit_rebuilds_colliding_package_names() {
        let workspace = collision_workspace();
        let args = fixture_args(&workspace);
        refresh_fixture(&workspace, &args);
        workspace.change_source("pkg-a", "NewAlpha");
        let (graph, export) = refresh_fixture(&workspace, &args);
        assert!(
            graph
                .nodes
                .iter()
                .any(|node| node.id == item_id("pkg-a", "NewAlpha", "struct"))
        );
        assert!(
            graph
                .nodes
                .iter()
                .any(|node| node.id == item_id("pkg_a", "Beta", "struct"))
        );
        assert!(
            !graph
                .nodes
                .iter()
                .any(|node| node.id == item_id("pkg-a", "Alpha", "struct"))
        );
        assert_eq!(export.definitions.len(), 2);
        for package in ["pkg-a", "pkg_a"] {
            let report = item_report(&export, package);
            assert_eq!(report.status, ExtractionStatus::Complete);
            assert_eq!(report.freshness, ArtifactFreshness::Current);
        }
    }

    #[test]
    fn removed_package_rebuilds_surviving_namespace_member() {
        let mut workspace = collision_workspace();
        let args = fixture_args(&workspace);
        refresh_fixture(&workspace, &args);
        let removed = workspace.meta.packages[0].id.clone();
        workspace.meta.workspace_members.retain(|id| id != &removed);
        workspace.meta.packages.retain(|pkg| pkg.id != removed);
        let (graph, export) = refresh_fixture(&workspace, &args);
        assert!(
            graph
                .nodes
                .iter()
                .any(|node| node.id == item_id("pkg_a", "Beta", "struct"))
        );
        assert!(
            !graph
                .nodes
                .iter()
                .any(|node| node.id == item_id("pkg-a", "Alpha", "struct"))
        );
        assert_eq!(export.definitions.len(), 1);
        assert_eq!(export.definitions[0].identity.package, "pkg_a");
        let report = item_report(&export, "pkg_a");
        assert_eq!(report.status, ExtractionStatus::Complete);
        assert_eq!(report.freshness, ArtifactFreshness::Current);
    }

    #[test]
    fn scoped_edit_drops_invalidated_out_of_scope_definitions() {
        let workspace = collision_workspace();
        let mut args = fixture_args(&workspace);
        refresh_fixture(&workspace, &args);
        workspace.change_source("pkg-a", "NewAlpha");
        args.packages = vec!["pkg-a".into()];
        let (graph, export) = refresh_fixture(&workspace, &args);
        assert!(
            !graph
                .nodes
                .iter()
                .any(|node| node.id == item_id("pkg_a", "Beta", "struct"))
        );
        assert_eq!(export.definitions.len(), 1);
        assert_eq!(export.definitions[0].identity.package, "pkg-a");
        let report = item_report(&export, "pkg_a");
        assert_eq!(report.status, ExtractionStatus::Skipped);
        assert_eq!(report.freshness, ArtifactFreshness::Unknown);
        assert_eq!(
            report.reason.as_deref(),
            Some("package outside requested item scope")
        );
    }

    #[test]
    fn disabled_library_docs_drop_cached_items_and_report_skip() {
        let mut workspace = Workspace::new(&[("demo", "demo")]);
        let args = fixture_args(&workspace);
        refresh_fixture(&workspace, &args);
        workspace.disable_docs("demo");
        workspace.change_source("demo", "NewDefinition");
        let (graph, export) = refresh_fixture(&workspace, &args);
        assert!(!graph.nodes.iter().any(|node| node.id.starts_with("item__")));
        assert!(export.definitions.is_empty());
        let report = item_report(&export, "demo");
        assert_eq!(report.status, ExtractionStatus::Skipped);
        assert_eq!(report.freshness, ArtifactFreshness::Unknown);
        assert_eq!(
            report.reason.as_deref(),
            Some("library documentation disabled")
        );
    }

    #[test]
    fn watch_skips_target_out_and_git() {
        let excludes = vec![
            PathBuf::from("/ws/target"),
            PathBuf::from("/ws/target/build-graph"),
        ];
        // Watched source is included.
        assert!(!is_excluded(&PathBuf::from("/ws/src/lib.rs"), &excludes));
        assert!(!is_excluded(
            &PathBuf::from("/ws/crates/a/src/main.rs"),
            &excludes
        ));
        // target/ (compiler output) and the graph output dir never count as edits —
        // this is what stops our own `graph.json.gz` writes from looping the watcher.
        assert!(is_excluded(
            &PathBuf::from("/ws/target/debug/deps/foo.d"),
            &excludes
        ));
        assert!(is_excluded(
            &PathBuf::from("/ws/target/build-graph/graph.json.gz"),
            &excludes
        ));
        // .git churns constantly during commits/checkouts; ignore it.
        assert!(is_excluded(
            &PathBuf::from("/ws/.git/index.lock"),
            &excludes
        ));
    }
}
