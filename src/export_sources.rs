//! Source-content observations used to qualify exported artifact provenance.

use build_graph::export::{SourceFileDigest, SourceSnapshot, content_fingerprint};
use camino::Utf8Path;

pub fn capture(
    package_root: &Utf8Path,
    workspace_root: &Utf8Path,
    excludes: &[&Utf8Path],
) -> SourceSnapshot {
    let mut files = Vec::new();
    let mut complete = true;
    for entry in walkdir::WalkDir::new(package_root.as_std_path())
        .into_iter()
        .filter_entry(|entry| {
            entry.depth() == 0
                || ((!entry.file_type().is_dir()
                    || (!entry.file_name().to_string_lossy().starts_with('.')
                        && entry.file_name() != "target"))
                    && !excludes.iter().any(|path| {
                        path.as_std_path() != package_root.as_std_path()
                            && entry.path().starts_with(path.as_std_path())
                    }))
        })
    {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                complete = false;
                continue;
            }
        };
        if !entry.file_type().is_file() && !entry.file_type().is_symlink() {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("rs")
            && path.file_name().and_then(|name| name.to_str()) != Some("Cargo.toml")
            && path.file_name().and_then(|name| name.to_str()) != Some("Cargo.lock")
        {
            continue;
        }
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(_) => {
                complete = false;
                continue;
            }
        };
        files.push(SourceFileDigest {
            path: path
                .strip_prefix(workspace_root.as_std_path())
                .unwrap_or(path)
                .to_string_lossy()
                .replace('\\', "/"),
            content_fingerprint: content_fingerprint(&bytes),
        });
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    // Length-prefixed fields avoid delimiter ambiguity in paths and digests.
    let mut observed = Vec::new();
    for file in &files {
        for value in [&file.path, &file.content_fingerprint] {
            observed.extend_from_slice(&(value.len() as u64).to_le_bytes());
            observed.extend_from_slice(value.as_bytes());
        }
    }
    SourceSnapshot {
        fingerprint: content_fingerprint(&observed),
        files,
        complete,
    }
}
