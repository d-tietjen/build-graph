//! In-memory knowledge graph + graphify-compatible serialization.
//!
//! Every node/edge here is *extracted from build artifacts* — there is no
//! inference, so every edge is `EXTRACTED` with `confidence_score = 1.0`.
//!
//! Node IDs are deterministic and derived from **paths** (crate / module /
//! symbol), never from build hashes or rustdoc's numeric ids. This is what
//! lets two runs of the same code produce byte-identical graphs, so the graph
//! diffs cleanly across rebuilds.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

/// graphify's `file_type` vocabulary is a closed set of six values. Everything
/// we emit is source code, so this is always `"code"`.
pub const FILE_TYPE_CODE: &str = "code";

/// Normalize an arbitrary string to graphify's id charset `[a-z0-9_]`.
pub fn norm(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect()
}

/// `crate__{name}`
pub fn crate_id(name: &str) -> String {
    format!("crate__{}", norm(name))
}

/// `file__{crate}__{relpath}`
pub fn file_id(krate: &str, relpath: &str) -> String {
    format!("file__{}__{}", norm(krate), norm(relpath))
}

/// `item__{crate}__{path}__{kind}` (path is a `::`-joined module + symbol path).
/// The trailing kind keeps same-named items of *different* kinds distinct after
/// case-insensitive normalization: without it an enum variant `Auth` and a
/// constructor `auth()` collapse to one id and merge into a single node.
pub fn item_id(krate: &str, path: &str, kind: &str) -> String {
    format!("item__{}__{}__{}", norm(krate), norm(path), norm(kind))
}

/// Recover the owning crate component from any id produced above. Used by the
/// incremental splice to drop/replace exactly one crate's subgraph.
pub fn crate_of_id(id: &str) -> Option<&str> {
    // ids are `{kind}__{crate}__...`; components never contain the `__`
    // delimiter because `norm` only ever emits single underscores within a
    // component.
    let mut parts = id.split("__");
    match parts.next()? {
        "crate" | "file" | "item" => parts.next(),
        _ => None,
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Node {
    pub id: String,
    pub label: String,
    pub file_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_location: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub captured_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contributor: Option<String>,
    /// Extra, non-graphify metadata (kind, visibility, crate, …). graphify's
    /// loader ignores unknown keys; our bundled viewer uses them for coloring.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub attributes: BTreeMap<String, String>,
}

impl Node {
    pub fn new(id: String, label: impl Into<String>, kind: &str) -> Self {
        let mut attributes = BTreeMap::new();
        attributes.insert("kind".to_string(), kind.to_string());
        Node {
            id,
            label: label.into(),
            file_type: FILE_TYPE_CODE.to_string(),
            source_file: None,
            source_location: None,
            source_url: None,
            captured_at: None,
            author: None,
            contributor: None,
            attributes,
        }
    }

    pub fn with_source(mut self, file: Option<String>, line: Option<u32>) -> Self {
        self.source_file = file;
        self.source_location = line;
        self
    }

    pub fn attr(mut self, key: &str, value: impl Into<String>) -> Self {
        self.attributes.insert(key.to_string(), value.into());
        self
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Edge {
    pub source: String,
    pub target: String,
    pub relation: String,
    pub confidence: String,
    pub confidence_score: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_location: Option<u32>,
    pub weight: f64,
}

/// The on-disk graph document (graphify-compatible schema).
#[derive(Serialize, Deserialize)]
pub struct GraphJson {
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    pub hyperedges: Vec<serde_json::Value>,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Default)]
pub struct Graph {
    /// id -> node, sorted by id for stable output.
    nodes: BTreeMap<String, Node>,
    /// (source, target, relation) -> edge, deduped + sorted for stable output.
    edges: BTreeMap<(String, String, String), Edge>,
}

impl Graph {
    pub fn new() -> Self {
        Graph::default()
    }

    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    pub fn edge_count(&self) -> usize {
        self.edges.len()
    }

    /// Iterate all nodes (read-only) — used to build secondary indexes such as
    /// the symbol→id map the SCIP references layer resolves against.
    pub fn node_values(&self) -> impl Iterator<Item = &Node> {
        self.nodes.values()
    }

    /// Look up one node by id.
    pub fn node(&self, id: &str) -> Option<&Node> {
        self.nodes.get(id)
    }

    /// Iterate all edges (read-only) — used by derived layers that aggregate
    /// previously extracted relationships without losing the original edges.
    pub fn edge_values(&self) -> impl Iterator<Item = &Edge> {
        self.edges.values()
    }

    pub fn contains(&self, id: &str) -> bool {
        self.nodes.contains_key(id)
    }

    /// Insert a node, or enrich an existing one (fill in a missing source
    /// location / merge attributes). Idempotent: re-adding the same node is a
    /// no-op, which keeps output stable across runs.
    pub fn add_node(&mut self, node: Node) {
        match self.nodes.get_mut(&node.id) {
            None => {
                self.nodes.insert(node.id.clone(), node);
            }
            Some(existing) => {
                if existing.source_file.is_none() {
                    existing.source_file = node.source_file;
                    existing.source_location = node.source_location;
                }
                for (k, v) in node.attributes {
                    existing.attributes.entry(k).or_insert(v);
                }
            }
        }
    }

    /// Add an `EXTRACTED` edge (deduped by source/target/relation).
    pub fn add_edge(
        &mut self,
        source: impl Into<String>,
        target: impl Into<String>,
        relation: &str,
        source_file: Option<String>,
        source_location: Option<u32>,
    ) {
        let source = source.into();
        let target = target.into();
        let key = (source.clone(), target.clone(), relation.to_string());
        self.edges.entry(key).or_insert(Edge {
            source,
            target,
            relation: relation.to_string(),
            confidence: "EXTRACTED".to_string(),
            confidence_score: 1.0,
            source_file,
            source_location,
            weight: 1.0,
        });
    }

    /// Drop a crate's own nodes and the edges it *authored* (those whose source
    /// it owns), before re-extracting it incrementally.
    ///
    /// Edges authored by *other* crates that point *into* this one are kept:
    /// because node IDs are deterministic, re-extracting this crate restores the
    /// same target IDs, so those cross-crate edges stay valid. (Any that become
    /// genuinely dangling — e.g. a removed item — are swept by
    /// [`Graph::prune_dangling_edges`] before serialization.)
    pub fn remove_crate(&mut self, krate_norm: &str) {
        self.nodes
            .retain(|id, _| crate_of_id(id) != Some(krate_norm));
        self.edges
            .retain(|(source, _, _), _| crate_of_id(source) != Some(krate_norm));
    }

    /// Remove every edge with the given relation. Used by the semantic
    /// references layer, which recomputes reference relations wholesale.
    pub fn remove_edges_with_relation(&mut self, relation: &str) {
        self.edges.retain(|(_, _, rel), _| rel != relation);
    }

    /// Drop edges whose endpoints are not both present. Run once before writing
    /// so an incremental update can never emit a dangling reference.
    pub fn prune_dangling_edges(&mut self) {
        let present: BTreeSet<&String> = self.nodes.keys().collect();
        self.edges
            .retain(|(s, t, _), _| present.contains(s) && present.contains(t));
    }

    /// Load a previously serialized graph back into memory (best effort —
    /// unknown fields are ignored). Powers incremental splicing.
    pub fn load(doc: GraphJson) -> Self {
        let mut g = Graph::new();
        for n in doc.nodes {
            g.nodes.insert(n.id.clone(), n);
        }
        for e in doc.edges {
            g.edges
                .insert((e.source.clone(), e.target.clone(), e.relation.clone()), e);
        }
        g
    }

    pub fn into_doc(self) -> GraphJson {
        GraphJson {
            nodes: self.nodes.into_values().collect(),
            edges: self.edges.into_values().collect(),
            hyperedges: Vec::new(),
            input_tokens: 0,
            output_tokens: 0,
        }
    }
}
