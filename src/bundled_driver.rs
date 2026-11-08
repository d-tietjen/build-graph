//! Embedded driver sources for registry installs without a retained Git checkout.
//!
//! Cargo excludes nested packages. Links in driver-bundle package regular copies
//! of the canonical files without maintaining a second driver source tree.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow};
use camino::Utf8PathBuf;
use sha2::{Digest, Sha256};

const FILES: &[(&str, &str)] = &[
    ("crates/bg-driver/Cargo.toml", include_str!("../driver-bundle/manifest.toml")),
    ("crates/bg-driver/Cargo.lock", include_str!("../driver-bundle/lock.toml")),
    ("crates/bg-driver/rust-toolchain.toml", include_str!("../driver-bundle/toolchain.toml")),
    ("crates/bg-driver/src/main.rs", include_str!("../driver-bundle/main.rs")),
    ("crates/bg-driver/src/observed_context.rs", include_str!("../driver-bundle/observed_context.rs")),
    ("crates/bg-driver/src/occurrences.rs", include_str!("../driver-bundle/occurrences.rs")),
    ("crates/bg-driver/src/semantic.rs", include_str!("../driver-bundle/semantic.rs")),
    ("crates/bg-driver/src/test_harness.rs", include_str!("../driver-bundle/test_harness.rs")),
    ("src/compiler_occurrence.rs", include_str!("compiler_occurrence.rs")),
    ("src/compiler_semantic.rs", include_str!("compiler_semantic.rs")),
    ("src/compiler_context.rs", include_str!("compiler_context.rs")),
    ("src/compiler_test_harness.rs", include_str!("compiler_test_harness.rs")),
    ("src/held_callback_control.rs", include_str!("held_callback_control.rs")),
];

/// Atomically unpack the exact bundled layout into the user's content-addressed
/// cache. Preserve its Cargo outputs across calls; failures never build a partial
/// tree. Shared modules retain the relative paths used by the driver.
pub(super) fn materialize() -> Result<Utf8PathBuf> {
    let base = std::env::var_os("XDG_CACHE_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".cache")))
        .context("bundled driver needs XDG_CACHE_HOME or HOME for its build cache")?;
    let mut digest = Sha256::new();
    for (path, bytes) in FILES {
        digest.update(path.as_bytes());
        digest.update([0]);
        digest.update(bytes.as_bytes());
        digest.update([0]);
    }
    let parent = base.join("build-graph/drivers");
    let root = parent.join(format!("{:x}", digest.finalize()));
    let source = root.join("crates/bg-driver");
    if !source.join("Cargo.toml").is_file() {
        std::fs::create_dir_all(&parent).context("creating the driver cache")?;
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
        let stage = parent.join(format!(".unpack-{}-{nonce}", std::process::id()));
        std::fs::create_dir(&stage).context("creating driver staging directory")?;
        let result = publish(&stage, &root);
        if stage.exists() {
            if let Err(error) = std::fs::remove_dir_all(&stage) {
                eprintln!("[build-graph] driver: staging cleanup failed: {error}");
            }
        }
        result?;
    }
    Utf8PathBuf::from_path_buf(source).map_err(|path| anyhow!("driver cache path is not UTF-8: {}", path.display()))
}

fn publish(stage: &Path, root: &Path) -> Result<()> {
    for (relative, bytes) in FILES {
        let path = stage.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).context("creating bundled driver layout")?;
        }
        std::fs::write(&path, bytes).with_context(|| format!("writing {relative}"))?;
    }
    match std::fs::rename(stage, root) {
        Ok(()) => Ok(()),
        // Another invocation may have published the same complete immutable tree.
        Err(_) if root.join("crates/bg-driver/Cargo.toml").is_file() => Ok(()),
        Err(error) => Err(error).context("publishing bundled driver source"),
    }
}
