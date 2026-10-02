//! Versioned provenance exported separately from the graphify graph schema.
//!
//! Legacy graph IDs normalize case and punctuation. A [`DefinitionRecord`]
//! retains the original identity even when several records share a graph ID.
//! Layer completion and compiler evidence are independent: an exit-zero CLI
//! invocation is not evidence that every requested layer was extracted.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Version of the `graph-export.json` schema.
pub const EXPORT_SCHEMA_VERSION: u32 = 1;
/// Uncompressed JSON sidecar written by the CLI, next to its graph.
pub const EXPORT_FILE: &str = "graph-export.json";

/// Case-preserving identity within a workspace's package namespace.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct DefinitionIdentity {
    /// Original Cargo package name, without graph-ID normalization.
    pub package: String,
    /// Original `::`-joined definition path, relative to the package root.
    pub def_path: String,
    /// Extractor kind (for example `struct`, `function`, or `method`).
    pub kind: String,
}

impl DefinitionIdentity {
    /// Lossless key: `definition:v1:<package hex>:<path hex>:<kind hex>`.
    /// Each field is the lowercase hex encoding of its original UTF-8 bytes.
    /// This key is distinct from the graphify node ID and retains case.
    pub fn key(&self) -> String {
        fn hex(value: &str) -> String {
            let mut out = String::with_capacity(value.len() * 2);
            for byte in value.as_bytes() {
                use std::fmt::Write;
                let _ = write!(out, "{byte:02x}");
            }
            out
        }
        format!(
            "definition:v1:{}:{}:{}",
            hex(&self.package),
            hex(&self.def_path),
            hex(&self.kind)
        )
    }
}

/// A coordinate copied from rustdoc JSON without rebasing or truncation.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct SourcePosition {
    pub line: usize,
    pub column: usize,
}

/// Full rustdoc definition span. Rustdoc uses one-based lines and columns;
/// `end` is exclusive. Paths use `/`, retaining rustdoc's relative/absolute form.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct DefinitionSpan {
    pub file: String,
    pub begin: SourcePosition,
    pub end: SourcePosition,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct DefinitionRecord {
    /// Legacy graph node ID. Several original definitions may share this ID.
    pub graph_node_id: String,
    pub identity: DefinitionIdentity,
    /// `None` for items for which rustdoc provides no source span.
    pub span: Option<DefinitionSpan>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExtractionStatus {
    Complete,
    Skipped,
    Partial,
}

/// Relationship between exported artifacts and the observed source state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactFreshness {
    /// Successful extraction with an unchanged, fully observed source set.
    Current,
    /// No evidence associates these artifacts with the current source set.
    Unknown,
    /// Sources changed during extraction or differ from retained provenance.
    Stale,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Layer {
    Sources,
    Items,
    References,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackageReport {
    pub package: String,
    pub status: ExtractionStatus,
    pub freshness: ArtifactFreshness,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LayerReport {
    pub layer: Layer,
    pub status: ExtractionStatus,
    pub reason: Option<String>,
    pub packages: Vec<PackageReport>,
}

impl LayerReport {
    /// Derive overall status from actual package outcomes. Empty/all-skipped
    /// scopes are skipped; incomplete or mixed scopes are partial.
    pub fn from_packages(layer: Layer, packages: Vec<PackageReport>) -> Self {
        let status = if packages.is_empty()
            || packages
                .iter()
                .all(|p| p.status == ExtractionStatus::Skipped)
        {
            ExtractionStatus::Skipped
        } else if packages
            .iter()
            .all(|p| p.status == ExtractionStatus::Complete)
        {
            ExtractionStatus::Complete
        } else {
            ExtractionStatus::Partial
        };
        Self {
            layer,
            status,
            reason: None,
            packages,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompilerStatus {
    Unknown,
    Succeeded,
    Failed,
}

/// One artifact reported by Cargo's build JSON stream. `fresh` means Cargo
/// reused a cached artifact; it is not a source-content freshness assertion.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompilerArtifact {
    pub package_id: String,
    pub target_name: String,
    pub fresh: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompilerReport {
    pub status: CompilerStatus,
    pub artifacts: Vec<CompilerArtifact>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceFileDigest {
    /// Workspace-relative path, with `/` separators.
    pub path: String,
    pub content_fingerprint: String,
}

/// Content observations of `.rs`, `Cargo.toml`, and `Cargo.lock` files under
/// a package root, excluding target/output directories and hidden directories.
/// These are consistency markers, not cryptographic integrity assertions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceSnapshot {
    pub fingerprint: String,
    pub files: Vec<SourceFileDigest>,
    /// False if a traversal or read failed. Such observations cannot prove freshness.
    pub complete: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphArtifact {
    pub filename: String,
    /// Fingerprint of the compact, uncompressed `GraphJson` serialization.
    pub content_fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExportManifest {
    pub schema_version: u32,
    pub graph: GraphArtifact,
    pub compiler: CompilerReport,
    /// Exact package name -> source observation at extraction start.
    pub sources: BTreeMap<String, SourceSnapshot>,
    pub layers: Vec<LayerReport>,
    /// Ordered independently of legacy graph nodes; collisions are retained.
    pub definitions: Vec<DefinitionRecord>,
}

impl ExportManifest {
    /// Check version and sidecar binding against a parsed graph. Writers replace
    /// the graph and sidecar separately, so consumers must validate this binding.
    pub fn matches_graph(&self, graph: &crate::GraphJson) -> Result<bool, serde_json::Error> {
        Ok(self.schema_version == EXPORT_SCHEMA_VERSION
            && self.graph.content_fingerprint == content_fingerprint(&serde_json::to_vec(graph)?))
    }
}

/// Stable FNV-1a 64-bit consistency marker, encoded `fnv1a64:<16 hex digits>`.
/// Consumers needing tamper resistance should hash their inputs independently.
pub fn content_fingerprint(bytes: &[u8]) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("fnv1a64:{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn original_identities_survive_legacy_collisions() {
        let identities: Vec<_> = ["Foo", "foo", "a::b", "a__b"]
            .into_iter()
            .map(|path| DefinitionIdentity {
                package: "Mixed-Package".into(),
                def_path: path.into(),
                kind: "struct".into(),
            })
            .collect();
        assert_eq!(
            crate::item_id("Mixed-Package", "Foo", "struct"),
            crate::item_id("mixed_package", "foo", "struct")
        );
        let keys: std::collections::BTreeSet<_> =
            identities.iter().map(DefinitionIdentity::key).collect();
        assert_eq!(keys.len(), identities.len());
        let mut other = identities[0].clone();
        other.package = "mixed-package".into();
        assert_ne!(identities[0].key(), other.key());
        other = identities[0].clone();
        other.kind = "Struct".into();
        assert_ne!(identities[0].key(), other.key());
    }

    #[test]
    fn mixed_and_failed_package_outcomes_are_partial() {
        let report = |status| PackageReport {
            package: "demo".into(),
            status,
            freshness: ArtifactFreshness::Unknown,
            reason: None,
        };
        assert_eq!(
            LayerReport::from_packages(
                Layer::Items,
                vec![
                    report(ExtractionStatus::Complete),
                    report(ExtractionStatus::Partial)
                ]
            )
            .status,
            ExtractionStatus::Partial
        );
        assert_eq!(
            LayerReport::from_packages(
                Layer::Items,
                vec![
                    report(ExtractionStatus::Complete),
                    report(ExtractionStatus::Skipped)
                ]
            )
            .status,
            ExtractionStatus::Partial
        );
        assert_eq!(
            LayerReport::from_packages(Layer::Items, vec![]).status,
            ExtractionStatus::Skipped
        );
        assert_eq!(
            LayerReport::from_packages(Layer::Items, vec![report(ExtractionStatus::Complete)])
                .status,
            ExtractionStatus::Complete
        );
    }

    #[test]
    fn sidecar_retains_colliding_definitions_and_binds_to_graph() {
        let mut graph = crate::Graph::new();
        let graph_node_id = crate::item_id("demo", "Foo", "struct");
        graph.add_node(crate::Node::new(graph_node_id.clone(), "Foo", "struct"));
        graph.add_node(crate::Node::new(graph_node_id.clone(), "foo", "struct"));
        let doc = graph.into_doc();
        assert_eq!(doc.nodes.len(), 1);
        let manifest = ExportManifest {
            schema_version: EXPORT_SCHEMA_VERSION,
            graph: GraphArtifact {
                filename: "graph.json".into(),
                content_fingerprint: content_fingerprint(
                    &serde_json::to_vec(&doc).expect("graph JSON"),
                ),
            },
            compiler: CompilerReport {
                status: CompilerStatus::Unknown,
                artifacts: Vec::new(),
            },
            sources: BTreeMap::new(),
            layers: Vec::new(),
            definitions: ["Foo", "foo"]
                .into_iter()
                .map(|name| DefinitionRecord {
                    graph_node_id: graph_node_id.clone(),
                    identity: DefinitionIdentity {
                        package: "demo".into(),
                        def_path: name.into(),
                        kind: "struct".into(),
                    },
                    span: None,
                })
                .collect(),
        };
        let roundtrip: ExportManifest =
            serde_json::from_slice(&serde_json::to_vec(&manifest).expect("sidecar JSON"))
                .expect("sidecar roundtrip");
        assert_eq!(roundtrip.definitions.len(), 2);
        assert!(roundtrip.matches_graph(&doc).expect("graph binding"));
        assert!(
            !roundtrip
                .matches_graph(&crate::Graph::new().into_doc())
                .expect("changed graph binding")
        );
    }
}
