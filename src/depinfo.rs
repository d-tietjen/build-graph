//! Layer 1b — per-crate source-file membership + fingerprint, from cargo's
//! dep-info (`.d`) files.
//!
//! Each compiled unit writes `target/<profile>/deps/<crate>-<hash>.d` listing
//! the source files it was built from. We index those per crate (the newest
//! one), read a crate's own `.rs` paths from it, and fingerprint the crate by
//! those files' **mtimes** — which change only when you edit the crate's
//! sources, not when the graph is rebuilt. That fingerprint is the signal for
//! incremental caching.
//!
//! This replaces an earlier whole-`target/` `.d` walk that read every (often
//! huge, transitively-closed) dep-info file on every run.

use std::collections::{BTreeSet, HashMap};
use std::hash::{Hash, Hasher};
use std::time::UNIX_EPOCH;

use camino::{Utf8Path, Utf8PathBuf};

use build_graph::{Graph, Node, crate_id, file_id};

/// One source file belonging to a crate.
pub struct SourceFile {
    /// Crate-relative path (used as the node label).
    pub rel: String,
    /// Workspace-relative path (display / `source_file`).
    pub ws_rel: String,
    /// Modification time, nanoseconds since the epoch.
    pub mtime: u128,
}

/// Newest dep-info `.d` per crate, keyed by the rustc crate/lib name.
pub struct DepIndex {
    newest: HashMap<String, Utf8PathBuf>,
}

impl DepIndex {
    /// Scan the `deps/` directories once (filenames + mtimes only) and remember
    /// the newest `.d` for each crate.
    pub fn build(target_dir: &Utf8Path, profiles: &[&str]) -> Self {
        let mut newest: HashMap<String, (Utf8PathBuf, u128)> = HashMap::new();
        for profile in profiles {
            let deps = target_dir.join(profile).join("deps");
            let Ok(entries) = std::fs::read_dir(deps.as_std_path()) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("d") {
                    continue;
                }
                let Some(file_stem) = path.file_stem().and_then(|s| s.to_str()) else {
                    continue;
                };
                // `<name>-<hash>` → `<name>` (crate/lib names never contain `-`).
                let stem = file_stem
                    .rsplit_once('-')
                    .map(|(a, _)| a)
                    .unwrap_or(file_stem);
                let mtime = entry
                    .metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_nanos())
                    .unwrap_or(0);
                let Ok(upath) = Utf8PathBuf::from_path_buf(path.clone()) else {
                    continue;
                };
                // Index under both the raw and `lib`-stripped stem so either the
                // rlib or the rmeta unit resolves the crate.
                let stripped = stem.strip_prefix("lib").unwrap_or(stem);
                for key in [stem, stripped] {
                    let slot = newest
                        .entry(key.to_string())
                        .or_insert_with(|| (upath.clone(), mtime));
                    if mtime > slot.1 {
                        *slot = (upath.clone(), mtime);
                    }
                }
            }
        }
        DepIndex {
            newest: newest.into_iter().map(|(k, (p, _))| (k, p)).collect(),
        }
    }

    /// The crate's own `.rs` sources (paths under `manifest_dir`), each with its
    /// mtime. Reads the crate's `.d` on demand.
    pub fn crate_sources(
        &self,
        libname: &str,
        manifest_dir: &Utf8Path,
        ws_root: &Utf8Path,
    ) -> Vec<SourceFile> {
        let Some(dpath) = self.newest.get(libname) else {
            return Vec::new();
        };
        let Ok(content) = std::fs::read_to_string(dpath.as_std_path()) else {
            return Vec::new();
        };
        let mut seen = BTreeSet::new();
        let mut out = Vec::new();
        for token in content.split_whitespace() {
            let token = token.trim_end_matches(':');
            if !token.ends_with(".rs") {
                continue;
            }
            let p = Utf8PathBuf::from(token);
            let p = if p.is_absolute() { p } else { ws_root.join(p) };
            if !p.starts_with(manifest_dir) {
                continue; // generated/external source (include!/build script)
            }
            let rel = p
                .strip_prefix(manifest_dir)
                .map(|r| r.as_str().to_string())
                .unwrap_or_else(|_| p.as_str().to_string());
            if !seen.insert(rel.clone()) {
                continue;
            }
            let ws_rel = p
                .strip_prefix(ws_root)
                .map(|r| r.as_str().to_string())
                .unwrap_or_else(|_| p.as_str().to_string());
            let mtime = std::fs::metadata(p.as_std_path())
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            out.push(SourceFile { rel, ws_rel, mtime });
        }
        out
    }
}

/// Fingerprint a crate from its sources' (relative path, mtime). Changes only
/// when the crate's own source files change — stable across graph rebuilds.
pub fn fingerprint(files: &[SourceFile]) -> String {
    let mut items: Vec<(&str, u128)> = files.iter().map(|f| (f.rel.as_str(), f.mtime)).collect();
    items.sort();
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for (rel, mtime) in items {
        rel.hash(&mut hasher);
        mtime.hash(&mut hasher);
    }
    format!("{:016x}", hasher.finish())
}

/// Add file nodes + `contains` edges for one crate. Returns the file count.
pub fn add_crate_files(graph: &mut Graph, crate_name: &str, files: &[SourceFile]) -> usize {
    for f in files {
        let fid = file_id(crate_name, &f.rel);
        graph.add_node(
            Node::new(fid.clone(), f.rel.clone(), "file")
                .with_source(Some(f.ws_rel.clone()), None)
                .attr("crate", crate_name.to_string()),
        );
        graph.add_edge(crate_id(crate_name), &fid, "contains", None, None);
    }
    files.len()
}
