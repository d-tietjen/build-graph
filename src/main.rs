//! `cargo-build-graph` — build a code knowledge graph directly from Rust build
//! artifacts. Install it (`cargo install build-graph`) to invoke as
//! `cargo build-graph <build|update|view>`.

mod cache;
mod cargo_build;
mod depinfo;
mod metadata;
mod qserve;
mod query;
mod render;
mod rustdoc;
mod scip;
mod serve;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::ffi::OsString;
use std::path::Path;

use anyhow::{Context, Result, bail};
use build_graph::{Graph, GraphJson, norm};
use camino::{Utf8Path, Utf8PathBuf};
use clap::{Args, Parser, Subcommand};

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
    /// Restrict extraction to these packages.
    #[arg(short = 'p', long = "package")]
    packages: Vec<String>,
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

#[derive(Args)]
struct BuildArgs {
    #[command(flatten)]
    common: CommonArgs,
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
    if args.get(1).map(|s| s == "build-graph").unwrap_or(false) {
        args.remove(1);
    }
    match Cli::parse_from(args).cmd {
        Cmd::Build(a) => run_build(a),
        Cmd::Update(c) => run_extract(&c, &[]),
        Cmd::View(v) => run_view(v),
        Cmd::Find(f) => run_find(f),
        Cmd::Refs(r) => run_refs(r),
        Cmd::Context(c) => run_context(c),
        Cmd::Serve(s) => run_serve(s),
    }
}

fn run_build(a: BuildArgs) -> Result<()> {
    let manifest = a.common.manifest_path.as_ref().map(Utf8PathBuf::from);
    let compiled = cargo_build::run_build(
        manifest.as_deref(),
        a.common.release,
        &a.common.packages,
        &a.cargo_args,
    )?;
    let changed = compiled.iter().filter(|t| t.changed()).count();
    eprintln!(
        "[build-graph] build ok: {} artifact(s), {} recompiled",
        compiled.len(),
        changed
    );
    run_extract(&a.common, &compiled)
}

fn run_extract(c: &CommonArgs, _compiled: &[cargo_build::CompiledTarget]) -> Result<()> {
    let manifest = c.manifest_path.as_ref().map(Utf8PathBuf::from);
    let meta = metadata::load(manifest.as_deref())?;

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
    // `--references` needs the rich item nodes to connect to, so it implies `--rich`.
    let rich = c.rich || c.references;

    // Reuse the prior graph when the cache is compatible (same layer settings).
    // The prior graph may be in either form (gzip or plain) — `find_graph`
    // prefers `.gz` and `load_graph` decompresses transparently, so an
    // incremental run reloads it regardless of the compression flag.
    let cache_path = out.join(cache::CACHE_FILE);
    let existing = build_graph::output::find_graph(out.as_std_path());
    let prior = cache::Cache::load(cache_path.as_std_path());
    let compatible = prior
        .as_ref()
        .map(|p| p.rich == rich && p.no_derives == c.no_derives && p.references == c.references)
        .unwrap_or(false)
        && existing.is_some();
    let mut graph = match (compatible, &existing) {
        (true, Some(p)) => load_graph(p).unwrap_or_default(),
        _ => Graph::new(),
    };
    let prior_crates = match (compatible, prior) {
        (true, Some(p)) => p.crates,
        _ => BTreeMap::new(),
    };

    // Fingerprint every crate by its sources' mtimes; dirty = changed/new.
    let depidx = depinfo::DepIndex::build(&target_dir, profiles);
    let ws_pkgs = meta.workspace_packages();
    let mut current: BTreeMap<String, String> = BTreeMap::new();
    let mut dirty_sources: HashMap<String, Vec<depinfo::SourceFile>> = HashMap::new();
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
        if !compatible || prior_crates.get(&pkg.name) != Some(&fp) {
            dirty_sources.insert(pkg.name.clone(), srcs);
        }
        current.insert(pkg.name.clone(), fp);
    }
    let dirty: HashSet<String> = dirty_sources.keys().cloned().collect();
    let removed: Vec<String> = prior_crates
        .keys()
        .filter(|k| !current.contains_key(*k))
        .cloned()
        .collect();

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
        let want: HashSet<&str> = c.packages.iter().map(|s| s.as_str()).collect();
        let rich_dirty: Vec<String> = ws_pkgs
            .iter()
            .filter(|p| dirty.contains(&p.name))
            .filter(|p| want.is_empty() || want.contains(p.name.as_str()))
            .filter(|p| p.targets.iter().any(rustdoc::is_lib_target))
            .map(|p| p.name.clone())
            .collect();
        if rich_dirty.is_empty() {
            eprintln!("[build-graph] layer 2: no changed crates to re-document");
        } else {
            let items = rustdoc::add_item_layer(
                &mut graph,
                &meta,
                &target_dir,
                c.nightly.as_deref(),
                &rich_dirty,
                c.release,
                c.no_derives,
            )?;
            eprintln!("[build-graph] layer 2: +{items} item node(s)");
        }

        // Layer 3 (semantic): rust-analyzer SCIP references — accurate calls/uses.
        // The index is whole-workspace, so only (re)run when something changed.
        if c.references && !dirty.is_empty() {
            match scip::add_references_layer(&mut graph, &meta.workspace_root, &out) {
                Ok(counts) => eprintln!(
                    "[build-graph] layer 3: +{} calls, +{} uses, +{} member_calls, +{} member_uses edge(s) (rust-analyzer)",
                    counts.calls, counts.uses, counts.member_calls, counts.member_uses
                ),
                Err(e) => eprintln!("[build-graph] layer 3: references skipped — {e:#}"),
            }
        }
    }

    graph.prune_dangling_edges();
    let (nodes, edges) = (graph.node_count(), graph.edge_count());
    let title = meta.workspace_root.file_name().unwrap_or("build-graph");
    build_graph::output::write_graph_with_title(
        out.as_std_path(),
        &graph.into_doc(),
        c.compress,
        title,
    )
    .with_context(|| format!("writing graph to {out}"))?;
    cache::Cache::new(rich, c.no_derives, c.references, current)
        .save(cache_path.as_std_path())
        .with_context(|| format!("writing cache to {cache_path}"))?;
    let wrote = if c.compress {
        build_graph::output::GRAPH_JSON_GZ
    } else {
        build_graph::output::GRAPH_JSON
    };
    eprintln!("[build-graph] wrote {out}/{wrote} ({nodes} nodes, {edges} edges)");
    eprintln!("[build-graph] view: cargo build-graph view --out {out}");
    Ok(())
}

fn load_graph(path: &Path) -> Option<Graph> {
    build_graph::output::read_graph(path).ok().map(Graph::load)
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
