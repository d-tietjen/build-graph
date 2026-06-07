//! Persistent per-crate cache so a run only re-extracts crates that changed.
//!
//! Stored next to the graph as `.build-graph-cache.json`. The value per crate
//! is its dep-info mtime (as a string) — when it matches the previous run, the
//! crate's nodes/edges are reused from the prior `graph.json` instead of being
//! recomputed.

use std::collections::BTreeMap;
use std::path::Path;

use anyhow::Result;
use serde::{Deserialize, Serialize};

pub const CACHE_VERSION: u32 = 2;
pub const CACHE_FILE: &str = ".build-graph-cache.json";

#[derive(Serialize, Deserialize, Default)]
pub struct Cache {
    pub version: u32,
    /// Whether the cached graph includes the rich (Layer 2) item nodes.
    pub rich: bool,
    /// Whether derive-generated impls were filtered out (`--no-derives`).
    #[serde(default)]
    pub no_derives: bool,
    /// Whether the cached graph includes the semantic rust-analyzer `calls`/`uses`
    /// reference edges (`--references`).
    #[serde(default)]
    pub references: bool,
    /// crate name -> dep-info fingerprint (mtime nanos, as a string).
    pub crates: BTreeMap<String, String>,
}

impl Cache {
    pub fn new(
        rich: bool,
        no_derives: bool,
        references: bool,
        crates: BTreeMap<String, String>,
    ) -> Self {
        Cache {
            version: CACHE_VERSION,
            rich,
            no_derives,
            references,
            crates,
        }
    }

    /// Load a compatible cache, or `None` if absent/unreadable/old-version.
    pub fn load(path: &Path) -> Option<Cache> {
        let text = std::fs::read_to_string(path).ok()?;
        let cache: Cache = serde_json::from_str(&text).ok()?;
        (cache.version == CACHE_VERSION).then_some(cache)
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        std::fs::write(path, serde_json::to_string_pretty(self)?)?;
        Ok(())
    }
}
