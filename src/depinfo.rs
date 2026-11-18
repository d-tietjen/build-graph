//! Layer 1b — per-crate source-file membership + fingerprint, from cargo's
//! dep-info (`.d`) files.
//!
//! Each compiled unit writes `target/<profile>/deps/<crate>-<hash>.d` listing
//! the source files it was built from. We select the newest dep-info file for
//! each target source root, then fingerprint that crate's `.rs` paths by
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

/// Dep-info candidates keyed by rustc crate name. A lib and bin may share the
/// name, so their source roots distinguish the records.
pub struct DepIndex {
    candidates: HashMap<String, Vec<(Utf8PathBuf, u128)>>,
}

impl DepIndex {
    /// Scan the `deps/` directories once (filenames + mtimes only).
    pub fn build(target_dir: &Utf8Path, profiles: &[&str]) -> Self {
        let mut candidates: HashMap<String, Vec<(Utf8PathBuf, u128)>> = HashMap::new();
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
                    candidates
                        .entry(key.to_string())
                        .or_default()
                        .push((upath.clone(), mtime));
                }
            }
        }
        for entries in candidates.values_mut() {
            entries.sort_by(|(ap, at), (bp, bt)| bt.cmp(at).then_with(|| ap.cmp(bp)));
            entries.dedup_by(|(ap, _), (bp, _)| ap == bp);
        }
        DepIndex { candidates }
    }

    /// The crate's own `.rs` sources (paths under `manifest_dir`), each with its
    /// mtime. Reads the crate's `.d` on demand.
    pub fn crate_sources(
        &self,
        libname: &str,
        target_source: &Utf8Path,
        manifest_dir: &Utf8Path,
        ws_root: &Utf8Path,
    ) -> Vec<SourceFile> {
        let Some(candidates) = self.candidates.get(libname) else {
            return Vec::new();
        };
        // A package can have a lib and a same-named bin. Use the newest dep
        // file that actually names this target's current root source, rather
        // than letting one target hide the other's source membership.
        let Some(content) = candidates.iter().find_map(|(dpath, _)| {
            let content = std::fs::read_to_string(dpath.as_std_path()).ok()?;
            content
                .split_whitespace()
                .filter(|token| token.trim_end_matches(':').ends_with(".rs"))
                .any(|token| {
                    let p = Utf8Path::new(token.trim_end_matches(':'));
                    let p = if p.is_absolute() {
                        p.to_path_buf()
                    } else {
                        ws_root.join(p)
                    };
                    p == target_source
                })
                .then_some(content)
        }) else {
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
