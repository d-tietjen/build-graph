//! Layer 3 (semantic) — body-level `calls` and `uses` edges from rust-analyzer's
//! **SCIP** index.
//!
//! This is the *accurate, source-aligned* reference graph: rust-analyzer resolves
//! method calls, calls inside `async fn`s, dyn-dispatch, and field/const/type
//! references that object-file or syntactic approaches miss or misattribute. It
//! is the only reference source build-graph offers — if rust-analyzer isn't
//! available the layer is skipped (we'd rather not offer the feature than offer
//! inaccurate edges).
//!
//! Pipeline: run `rust-analyzer scip <workspace>`, parse the index, map each
//! symbol to its Layer-2 node **by its definition's `file:line`** (robust against
//! the many ways rust-analyzer and rustdoc spell a path — impl methods, modules,
//! re-exports), attribute each reference to its enclosing function (nearest
//! preceding function definition), and emit a direct `calls` edge (the target is
//! a function/method) or `uses` edge (anything else). Then the direct edges are
//! rolled up through the Layer-2 ownership graph (`has_method`, `has_field`,
//! `has_variant`, `contains`) as `member_calls` / `member_uses`, so clicking a
//! struct, enum, trait, variant, or module can show what its members call/use.
//! Only edges between workspace nodes are kept.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::process::Command;

use anyhow::{Context, Result, bail};
use camino::Utf8Path;
use protobuf::Message;
use scip::types::{Index, Occurrence};

use build_graph::Graph;

/// Counts for the semantic reference layer.
#[derive(Debug, Clone, Copy, Default)]
pub struct ReferenceCounts {
    /// Direct body-level function/method call edges.
    pub calls: usize,
    /// Direct body-level references to non-function symbols.
    pub uses: usize,
    /// Owner-level rollups from structs/enums/traits/modules to member callees.
    pub member_calls: usize,
    /// Owner-level rollups from structs/enums/traits/modules to member uses.
    pub member_uses: usize,
}

/// Locate a `rust-analyzer` binary: PATH first (rustup proxy or standalone),
/// then any installed rustup toolchain. `None` if not found.
pub fn find_rust_analyzer() -> Option<String> {
    if Command::new("rust-analyzer")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
    {
        return Some("rust-analyzer".to_string());
    }
    let home = std::env::var_os("HOME")?;
    let toolchains = Path::new(&home).join(".rustup/toolchains");
    for entry in std::fs::read_dir(&toolchains).ok()?.flatten() {
        let candidate = entry.path().join("bin/rust-analyzer");
        if candidate.is_file() {
            return candidate.to_str().map(String::from);
        }
    }
    None
}

/// Run rust-analyzer SCIP over the workspace and (re)build the `calls`/`uses`
/// edges from it. Returns `(calls, uses)` counts. Errors if rust-analyzer is
/// missing or the index can't be produced/parsed.
pub fn add_references_layer(
    graph: &mut Graph,
    ws_root: &Utf8Path,
    work_dir: &Utf8Path,
) -> Result<ReferenceCounts> {
    let ra = find_rust_analyzer().context(
        "rust-analyzer not found — install it with `rustup component add rust-analyzer` \
         (the references layer needs it; there is no fallback)",
    )?;

    let index_path = work_dir.join("index.scip");
    std::fs::create_dir_all(work_dir.as_std_path()).ok();
    eprintln!(
        "[build-graph] references: indexing the workspace with rust-analyzer (this can take minutes)…"
    );
    let status = Command::new(&ra)
        .arg("scip")
        .arg(ws_root.as_str())
        .arg("--output")
        .arg(index_path.as_str())
        .status()
        .with_context(|| format!("running `{ra} scip`"))?;
    if !status.success() {
        bail!("`rust-analyzer scip` failed (exit {status})");
    }

    let bytes = std::fs::read(index_path.as_std_path())
        .with_context(|| format!("reading SCIP index {index_path}"))?;
    let index = Index::parse_from_bytes(&bytes).context("parsing the SCIP index")?;
    // The index is large and transient; don't leave it in the output dir.
    std::fs::remove_file(index_path.as_std_path()).ok();

    // Replace any prior reference edges (this layer is a full recompute).
    graph.remove_edges_with_relation("calls");
    graph.remove_edges_with_relation("uses");
    graph.remove_edges_with_relation("member_calls");
    graph.remove_edges_with_relation("member_uses");

    let (calls, uses) = ingest(graph, &index);
    let (member_calls, member_uses) = add_member_reference_edges(graph);
    Ok(ReferenceCounts {
        calls,
        uses,
        member_calls,
        member_uses,
    })
}

/// 1-indexed start line of an occurrence (SCIP ranges are 0-indexed).
fn start_line(o: &Occurrence) -> i32 {
    o.range.first().copied().unwrap_or(0) + 1
}

/// Only global (item) symbols map to nodes; `local …` symbols are fn-local
/// bindings we ignore.
fn is_global(symbol: &str) -> bool {
    symbol.starts_with("rust-analyzer")
}

/// Whether a symbol denotes a function/method (its SCIP descriptor ends `().`).
/// Used both to pick the right `file:line` bucket (so a trait and its method on
/// one line don't collide) and to classify the edge as `calls` vs `uses`.
fn sym_is_fn(symbol: &str) -> bool {
    symbol.ends_with(").")
}

fn ingest(graph: &mut Graph, index: &Index) -> (usize, usize) {
    // `file:line` -> node id, split into function vs other so a trait/struct and
    // a method defined on the same line don't collide. Owned, so the graph is
    // free to mutate afterwards.
    let mut loc_fn: HashMap<String, String> = HashMap::new();
    let mut loc_other: HashMap<String, String> = HashMap::new();
    for n in graph.node_values() {
        if let (Some(f), Some(l)) = (n.source_file.as_deref(), n.source_location) {
            let kind = n.attributes.get("kind").map(String::as_str).unwrap_or("");
            let bucket = if kind == "function" || kind == "method" {
                &mut loc_fn
            } else {
                &mut loc_other
            };
            bucket
                .entry(format!("{f}:{l}"))
                .or_insert_with(|| n.id.clone());
        }
    }
    // rustdoc's item line and rust-analyzer's name line usually coincide; allow ±1.
    let lookup = |is_fn: bool, file: &str, line: i32| -> Option<&String> {
        let m = if is_fn { &loc_fn } else { &loc_other };
        m.get(&format!("{file}:{line}"))
            .or_else(|| m.get(&format!("{file}:{}", line - 1)))
            .or_else(|| m.get(&format!("{file}:{}", line + 1)))
    };

    // symbol -> node id, by the symbol's definition location (+ fn-ness bucket).
    let mut sym_node: HashMap<&str, String> = HashMap::new();
    for doc in &index.documents {
        for o in &doc.occurrences {
            if o.symbol_roles & 1 == 0 || !is_global(&o.symbol) {
                continue;
            }
            if let Some(id) = lookup(sym_is_fn(&o.symbol), &doc.relative_path, start_line(o)) {
                sym_node.insert(o.symbol.as_str(), id.clone());
            }
        }
    }

    let mut seen: HashSet<(String, String, &str)> = HashSet::new();
    let (mut calls, mut uses) = (0usize, 0usize);
    for doc in &index.documents {
        // Function definitions in this file, sorted by line, for attribution.
        let mut fns: Vec<(i32, &str)> = doc
            .occurrences
            .iter()
            .filter(|o| o.symbol_roles & 1 != 0 && sym_is_fn(&o.symbol))
            .filter_map(|o| {
                sym_node
                    .get(o.symbol.as_str())
                    .map(|id| (start_line(o), id.as_str()))
            })
            .collect();
        fns.sort();

        for o in &doc.occurrences {
            if o.symbol_roles & 1 != 0 || !is_global(&o.symbol) {
                continue; // references only
            }
            let Some(callee) = sym_node.get(o.symbol.as_str()) else {
                continue;
            };
            // Enclosing function = the last def starting at or before this line.
            let pos = fns.partition_point(|(l, _)| *l <= start_line(o));
            if pos == 0 {
                continue;
            }
            let caller = fns[pos - 1].1;
            if caller == callee.as_str() {
                continue;
            }
            let rel = if sym_is_fn(&o.symbol) {
                "calls"
            } else {
                "uses"
            };
            if seen.insert((caller.to_string(), callee.clone(), rel)) {
                graph.add_edge(caller.to_string(), callee.clone(), rel, None, None);
                if rel == "calls" {
                    calls += 1;
                } else {
                    uses += 1;
                }
            }
        }
    }
    (calls, uses)
}

fn owner_relation(rel: &str) -> bool {
    matches!(rel, "contains" | "has_method" | "has_field" | "has_variant")
}

fn owner_kind(kind: &str) -> bool {
    matches!(
        kind,
        "module" | "struct" | "enum" | "union" | "trait" | "variant"
    )
}

fn rollup_relation(rel: &str) -> Option<&'static str> {
    match rel {
        "calls" => Some("member_calls"),
        "uses" | "takes" | "returns" | "uses_type" | "aliases" | "implements" => {
            Some("member_uses")
        }
        _ => None,
    }
}

fn enclosing_owners(
    id: &str,
    parents: &HashMap<String, Vec<String>>,
    cache: &mut HashMap<String, Vec<String>>,
    visiting: &mut HashSet<String>,
) -> Vec<String> {
    if let Some(cached) = cache.get(id) {
        return cached.clone();
    }
    if !visiting.insert(id.to_string()) {
        return Vec::new();
    }

    let mut owners = Vec::new();
    if let Some(direct) = parents.get(id) {
        for parent in direct {
            owners.push(parent.clone());
            owners.extend(enclosing_owners(parent, parents, cache, visiting));
        }
    }

    visiting.remove(id);
    owners.sort();
    owners.dedup();
    cache.insert(id.to_string(), owners.clone());
    owners
}

/// Derive owner-level semantic edges from exact member references.
///
/// Example: if `Widget::render` calls `paint` and uses `Color`, the graph keeps
/// the exact method-level edges and also adds:
///
/// - `Widget --member_calls--> paint`
/// - `Widget --member_uses--> Color`
///
/// Transitive owners are included too: a module containing `Widget` receives the
/// same rollups, so every object-like node can answer "what happens inside me?"
pub(crate) fn add_member_reference_edges(graph: &mut Graph) -> (usize, usize) {
    let mut parents: HashMap<String, Vec<String>> = HashMap::new();
    for edge in graph.edge_values() {
        if !owner_relation(edge.relation.as_str()) {
            continue;
        }
        let Some(owner) = graph.node(edge.source.as_str()) else {
            continue;
        };
        let kind = owner
            .attributes
            .get("kind")
            .map(String::as_str)
            .unwrap_or("");
        if owner_kind(kind) {
            parents
                .entry(edge.target.clone())
                .or_default()
                .push(edge.source.clone());
        }
    }

    let direct_refs: Vec<(String, String, &'static str)> = graph
        .edge_values()
        .filter_map(|edge| {
            rollup_relation(edge.relation.as_str())
                .map(|rel| (edge.source.clone(), edge.target.clone(), rel))
        })
        .collect();

    let mut existing: HashSet<(String, String, &'static str)> = graph
        .edge_values()
        .filter_map(|edge| match edge.relation.as_str() {
            "member_calls" => Some((edge.source.clone(), edge.target.clone(), "member_calls")),
            "member_uses" => Some((edge.source.clone(), edge.target.clone(), "member_uses")),
            _ => None,
        })
        .collect();

    let mut owner_cache: HashMap<String, Vec<String>> = HashMap::new();
    let mut visiting: HashSet<String> = HashSet::new();
    let (mut member_calls, mut member_uses) = (0usize, 0usize);
    for (source, target, rel) in direct_refs {
        for owner in enclosing_owners(&source, &parents, &mut owner_cache, &mut visiting) {
            if owner == target {
                continue;
            }
            if existing.insert((owner.clone(), target.clone(), rel)) {
                graph.add_edge(owner, target.clone(), rel, None, None);
                if rel == "member_calls" {
                    member_calls += 1;
                } else {
                    member_uses += 1;
                }
            }
        }
    }

    (member_calls, member_uses)
}

#[cfg(test)]
mod tests {
    use build_graph::{Graph, Node};

    use super::add_member_reference_edges;

    fn item(id: &str, label: &str, kind: &str) -> Node {
        Node::new(id.to_string(), label, kind).attr("crate", "demo")
    }

    #[test]
    fn rolls_direct_method_references_up_to_type_and_module_owners() {
        let mut graph = Graph::new();
        for node in [
            item("module", "demo", "module"),
            item("widget", "Widget", "struct"),
            item("render", "render", "method"),
            item("paint", "paint", "function"),
            item("color", "Color", "enum"),
            item("field", "palette", "field"),
        ] {
            graph.add_node(node);
        }
        graph.add_edge("module", "widget", "contains", None, None);
        graph.add_edge("widget", "render", "has_method", None, None);
        graph.add_edge("widget", "field", "has_field", None, None);
        graph.add_edge("render", "paint", "calls", None, None);
        graph.add_edge("render", "color", "uses", None, None);
        graph.add_edge("field", "color", "uses_type", None, None);

        assert_eq!(add_member_reference_edges(&mut graph), (2, 2));
        let doc = graph.into_doc();
        let has = |source: &str, target: &str, rel: &str| {
            doc.edges
                .iter()
                .any(|edge| edge.source == source && edge.target == target && edge.relation == rel)
        };

        assert!(has("widget", "paint", "member_calls"));
        assert!(has("module", "paint", "member_calls"));
        assert!(has("widget", "color", "member_uses"));
        assert!(has("module", "color", "member_uses"));
        assert!(has("render", "paint", "calls"));
        assert!(has("render", "color", "uses"));
    }

    #[test]
    fn dedupes_rollups_and_skips_owner_self_edges() {
        let mut graph = Graph::new();
        for node in [
            item("widget", "Widget", "struct"),
            item("a", "a", "method"),
            item("b", "b", "method"),
        ] {
            graph.add_node(node);
        }
        graph.add_edge("widget", "a", "has_method", None, None);
        graph.add_edge("widget", "b", "has_method", None, None);
        graph.add_edge("a", "b", "calls", None, None);
        graph.add_edge("a", "widget", "uses", None, None);
        graph.add_edge("b", "widget", "uses", None, None);

        assert_eq!(add_member_reference_edges(&mut graph), (1, 0));
        let doc = graph.into_doc();
        assert_eq!(
            doc.edges
                .iter()
                .filter(|edge| edge.source == "widget"
                    && edge.target == "b"
                    && edge.relation == "member_calls")
                .count(),
            1
        );
        assert!(!doc.edges.iter().any(|edge| edge.source == "widget"
            && edge.target == "widget"
            && edge.relation == "member_uses"));
    }
}
