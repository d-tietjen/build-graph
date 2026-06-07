//! Build-script helper and graph core for `build-graph`.
//!
//! The [`Builder`] refreshes a code knowledge graph on every `cargo build`.
//! The graph model/output modules are also used by the `cargo-build-graph`
//! binary shipped by this package.
//!
//! Add to a crate's build dependencies and call it from `build.rs`:
//!
//! ```toml
//! # Cargo.toml
//! [build-dependencies]
//! build-graph = "0.1.0"
//! ```
//!
//! ```ignore
//! // build.rs
//! fn main() {
//!     build_graph::Builder::new().run();
//! }
//! ```
//!
//! On each build this records a per-crate *fragment* under
//! `target/build-graph/fragments/` and atomically re-merges all fragments into
//! `target/build-graph/graph.json` (+ `graph.html`). Cargo only re-runs a crate's
//! build script when that crate changes, so the graph updates incrementally.
//!
//! It runs entirely from build-script environment + the crate's own
//! `Cargo.toml` and source tree — it never invokes `cargo` or a toolchain, so
//! it cannot deadlock the build. The richer symbol/type layer is produced
//! out-of-band by the `cargo build-graph` CLI.
//!
//! Set `BUILD_GRAPH=0` to disable. Errors never fail the host build — they are
//! reported as `cargo:warning=…`.

use std::collections::BTreeSet;
use std::env;
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};

pub mod fragment;
pub mod graph;
pub mod merge;
pub mod output;
pub mod report;

pub use fragment::{Fragment, FragmentFile};
pub use graph::{
    Edge, FILE_TYPE_CODE, Graph, GraphJson, Node, crate_id, crate_of_id, file_id, item_id, norm,
};
pub use merge::merge_fragments;

/// Configures and runs the per-build graph refresh.
pub struct Builder {
    out_subdir: String,
}

impl Default for Builder {
    fn default() -> Self {
        Builder::new()
    }
}

impl Builder {
    pub fn new() -> Self {
        Builder {
            out_subdir: "build-graph".to_string(),
        }
    }

    /// Override the subdirectory under the target dir (default `build-graph`).
    pub fn out_subdir(mut self, name: impl Into<String>) -> Self {
        self.out_subdir = name.into();
        self
    }

    /// Run the refresh. Infallible from the caller's perspective: any error is
    /// surfaced as a cargo warning and the build proceeds.
    pub fn run(&self) {
        if disabled() {
            return;
        }
        if let Err(e) = self.try_run() {
            println!("cargo:warning=build-graph skipped: {e}");
        }
    }

    fn try_run(&self) -> Result<(), Box<dyn Error>> {
        let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR")?);
        let crate_name = env::var("CARGO_PKG_NAME")?;
        let version = env::var("CARGO_PKG_VERSION").unwrap_or_default();
        let out_dir = PathBuf::from(env::var("OUT_DIR")?);

        let target_root =
            find_target_root(&out_dir).ok_or("could not locate the target directory")?;
        let graph_dir = target_root.join(&self.out_subdir);
        let frag_dir = graph_dir.join("fragments");
        fs::create_dir_all(&frag_dir)?;

        let ws_root = find_workspace_root(&manifest_dir);
        let files = collect_rs_files(&manifest_dir, ws_root.as_deref());
        let dep_names = parse_dep_names(&manifest_dir.join("Cargo.toml")).unwrap_or_default();

        let fragment = Fragment {
            crate_name: crate_name.clone(),
            version,
            manifest_dir: manifest_dir.display().to_string(),
            files,
            dep_names,
        };

        let frag_path = frag_dir.join(format!("{}.json", sanitize(&crate_name)));
        let bytes = serde_json::to_vec_pretty(&fragment)?;
        output::write_atomic(&frag_path, &bytes)?;

        // Re-merge every fragment we can see into the shared graph. Concurrent
        // build scripts each write the full graph atomically; the last to land
        // after the build finishes holds the complete union.
        let fragments = read_fragments(&frag_dir);
        let graph = merge_fragments(&fragments);
        // Plain (uncompressed): this runs in the build hot path on every compile
        // and produces only the small Layer-1 (crate/file) graph, so gzip would
        // be overhead for no real disk saving. Readers handle either form.
        let title = ws_root
            .as_deref()
            .and_then(Path::file_name)
            .or_else(|| manifest_dir.file_name())
            .map(|name| name.to_string_lossy())
            .unwrap_or_else(|| crate_name.into());
        output::write_graph_with_title(&graph_dir, &graph.into_doc(), false, &title)?;
        Ok(())
    }
}

fn disabled() -> bool {
    matches!(
        env::var("BUILD_GRAPH").ok().as_deref(),
        Some("0") | Some("off") | Some("false") | Some("no")
    )
}

fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect()
}

/// Find the cargo target directory by walking up from `OUT_DIR`. Cargo marks
/// the target root with a `CACHEDIR.TAG`; fall back to an ancestor named
/// `target`.
fn find_target_root(out_dir: &Path) -> Option<PathBuf> {
    for anc in out_dir.ancestors() {
        if anc.join("CACHEDIR.TAG").is_file() {
            return Some(anc.to_path_buf());
        }
    }
    for anc in out_dir.ancestors() {
        if anc.file_name().and_then(|s| s.to_str()) == Some("target") {
            return Some(anc.to_path_buf());
        }
    }
    None
}

/// The highest ancestor whose `Cargo.toml` declares `[workspace]`, used to make
/// file paths workspace-relative for display.
fn find_workspace_root(manifest_dir: &Path) -> Option<PathBuf> {
    let mut found = None;
    for anc in manifest_dir.ancestors() {
        let manifest = anc.join("Cargo.toml");
        if manifest.is_file()
            && let Ok(text) = fs::read_to_string(&manifest)
            && text.contains("[workspace]")
        {
            found = Some(anc.to_path_buf());
        }
    }
    found
}

fn collect_rs_files(manifest_dir: &Path, ws_root: Option<&Path>) -> Vec<FragmentFile> {
    let mut out = Vec::new();
    let mut seen = BTreeSet::new();
    for entry in walkdir::WalkDir::new(manifest_dir)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_str().unwrap_or("");
            name != "target" && !name.starts_with('.')
        })
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("rs") {
            continue;
        }
        let rel = path
            .strip_prefix(manifest_dir)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        let display = ws_root
            .and_then(|w| path.strip_prefix(w).ok())
            .map(|r| r.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|| path.to_string_lossy().to_string());
        if seen.insert(rel.clone()) {
            out.push(FragmentFile { rel, path: display });
        }
    }
    out
}

/// Collect declared dependency crate names from a `Cargo.toml`, resolving
/// `package = "…"` renames to the real crate name.
fn parse_dep_names(cargo_toml: &Path) -> Option<Vec<String>> {
    let text = fs::read_to_string(cargo_toml).ok()?;
    let value: toml::Value = text.parse().ok()?;
    let mut names = BTreeSet::new();

    let mut harvest = |table: &toml::Value| {
        if let Some(toml::Value::Table(deps)) = table.get("dependencies") {
            collect_table(deps, &mut names);
        }
        if let Some(toml::Value::Table(deps)) = table.get("build-dependencies") {
            collect_table(deps, &mut names);
        }
        if let Some(toml::Value::Table(deps)) = table.get("dev-dependencies") {
            collect_table(deps, &mut names);
        }
    };
    harvest(&value);

    // Platform-specific tables: [target.'cfg(...)'.dependencies]
    if let Some(toml::Value::Table(targets)) = value.get("target") {
        for spec in targets.values() {
            harvest(spec);
        }
    }

    Some(names.into_iter().collect())
}

fn collect_table(table: &toml::map::Map<String, toml::Value>, names: &mut BTreeSet<String>) {
    for (key, spec) in table {
        let real = spec
            .get("package")
            .and_then(|p| p.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| key.clone());
        names.insert(real);
    }
}

fn read_fragments(frag_dir: &Path) -> Vec<Fragment> {
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(frag_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            if let Ok(text) = fs::read_to_string(&path)
                && let Ok(fragment) = serde_json::from_str::<Fragment>(&text)
            {
                out.push(fragment);
            }
        }
    }
    out
}
