//! Per-crate graph *fragment*.
//!
//! During a build, each instrumented crate's `build.rs` writes one of these to
//! `target/build-graph/fragments/<crate>.json`. A fragment is everything one crate
//! can know about itself without invoking cargo: its identity, its source
//! files, and the names of the dependencies it declares. The merge step unions
//! all fragments into a single graph.

use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
pub struct FragmentFile {
    /// Path relative to the crate root — used as the node label.
    pub rel: String,
    /// Display path: workspace-relative when known, else absolute.
    pub path: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Fragment {
    pub crate_name: String,
    pub version: String,
    /// Absolute path to the crate root (`CARGO_MANIFEST_DIR`).
    pub manifest_dir: String,
    pub files: Vec<FragmentFile>,
    /// Declared dependency crate names (resolved through `package = "…"`
    /// renames). Only those that match another fragment become edges.
    pub dep_names: Vec<String>,
}
