//! Filesystem and metadata fixtures; no Cargo or compiler subprocesses.

use std::sync::atomic::{AtomicU64, Ordering};

use camino::Utf8PathBuf;
use cargo_metadata::Metadata;
use serde_json::json;

static NEXT_WORKSPACE: AtomicU64 = AtomicU64::new(0);

pub struct Workspace {
    pub root: Utf8PathBuf,
    pub meta: Metadata,
}

impl Workspace {
    pub fn new(packages: &[(&str, &str)]) -> Self {
        let root = Utf8PathBuf::from_path_buf(std::env::temp_dir())
            .expect("UTF-8 temporary directory")
            .join(format!(
                "build-graph-regression-{}-{}",
                std::process::id(),
                NEXT_WORKSPACE.fetch_add(1, Ordering::Relaxed)
            ));
        std::fs::create_dir_all(&root).expect("fixture workspace");
        let members: Vec<_> = packages.iter().map(|(name, _)| *name).collect();
        std::fs::write(
            root.join("Cargo.toml"),
            format!("[workspace]\nmembers = {members:?}\nresolver = \"2\"\n"),
        )
        .expect("workspace manifest");
        let mut metadata_packages = Vec::new();
        let mut ids = Vec::new();
        for (name, lib_name) in packages {
            let package_root = root.join(name);
            std::fs::create_dir_all(package_root.join("src")).expect("package source directory");
            std::fs::write(
                package_root.join("Cargo.toml"),
                format!(
                    "[package]\nname = {name:?}\nversion = \"0.1.0\"\nedition = \"2024\"\n\
                     [lib]\nname = {lib_name:?}\n"
                ),
            )
            .expect("package manifest");
            std::fs::write(package_root.join("src/lib.rs"), "pub struct Original;\n")
                .expect("package source");
            let id = format!("path+file://{package_root}#{name}@0.1.0");
            ids.push(id.clone());
            metadata_packages.push(json!({
                "name": name,
                "version": "0.1.0",
                "id": id,
                "dependencies": [],
                "targets": [{
                    "name": lib_name,
                    "kind": ["lib"],
                    "crate_types": ["lib"],
                    "src_path": package_root.join("src/lib.rs"),
                    "edition": "2024",
                    "doc": true
                }],
                "features": {},
                "manifest_path": package_root.join("Cargo.toml"),
                "edition": "2024"
            }));
        }
        let meta = serde_json::from_value(json!({
            "packages": metadata_packages,
            "workspace_members": ids,
            "workspace_default_members": ids,
            "resolve": null,
            "workspace_root": root,
            "target_directory": root.join("target"),
            "version": 1
        }))
        .expect("fixture Cargo metadata");
        Self { root, meta }
    }

    pub fn change_source(&self, package: &str, definition: &str) {
        std::fs::write(
            self.root.join(package).join("src/lib.rs"),
            format!("pub struct {definition};\n"),
        )
        .expect("changed package source");
    }

    pub fn disable_docs(&mut self, package: &str) {
        let pkg = self
            .meta
            .packages
            .iter_mut()
            .find(|pkg| pkg.name == package)
            .expect("fixture package");
        pkg.targets[0].doc = false;
        let manifest = &pkg.manifest_path;
        let mut text = std::fs::read_to_string(manifest).expect("package manifest");
        text.push_str("doc = false\n");
        std::fs::write(manifest, text).expect("disabled documentation");
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
