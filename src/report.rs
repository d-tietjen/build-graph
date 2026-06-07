//! Render a plain-language `GRAPH_REPORT.md` from a graph — counts, the crate
//! breakdown, and the most-connected "god nodes".

use std::collections::BTreeMap;

use crate::graph::GraphJson;

pub fn render(doc: &GraphJson) -> String {
    let mut out = String::new();
    out.push_str("# Graph Report\n\n");
    out.push_str(
        "Built directly from Rust build artifacts (every edge is compiler-extracted).\n\n",
    );
    out.push_str(&format!(
        "- **{} nodes**, **{} edges**\n",
        doc.nodes.len(),
        doc.edges.len()
    ));

    // Node kinds.
    let mut kinds: BTreeMap<&str, usize> = BTreeMap::new();
    for n in &doc.nodes {
        let kind = n.attributes.get("kind").map(String::as_str).unwrap_or("?");
        *kinds.entry(kind).or_default() += 1;
    }
    out.push_str("- node kinds: ");
    out.push_str(
        &kinds
            .iter()
            .map(|(k, v)| format!("{k} {v}"))
            .collect::<Vec<_>>()
            .join(", "),
    );
    out.push_str("\n\n");

    // Edge relations.
    let mut rels: BTreeMap<&str, usize> = BTreeMap::new();
    for e in &doc.edges {
        *rels.entry(e.relation.as_str()).or_default() += 1;
    }
    if !rels.is_empty() {
        out.push_str("- edge relations: ");
        out.push_str(
            &rels
                .iter()
                .map(|(k, v)| format!("{k} {v}"))
                .collect::<Vec<_>>()
                .join(", "),
        );
        out.push_str("\n\n");
    }

    // Crates by source-file count.
    let mut files_per_crate: BTreeMap<&str, usize> = BTreeMap::new();
    for n in &doc.nodes {
        if n.attributes.get("kind").map(String::as_str) == Some("file")
            && let Some(krate) = n.attributes.get("crate")
        {
            *files_per_crate.entry(krate.as_str()).or_default() += 1;
        }
    }
    if !files_per_crate.is_empty() {
        let mut ranked: Vec<_> = files_per_crate.into_iter().collect();
        ranked.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
        out.push_str("## Largest crates (by source files)\n\n");
        for (krate, count) in ranked.iter().take(15) {
            out.push_str(&format!("- `{krate}` — {count} files\n"));
        }
        out.push('\n');
    }

    // God nodes: highest total degree.
    let mut degree: BTreeMap<&str, usize> = BTreeMap::new();
    for e in &doc.edges {
        *degree.entry(e.source.as_str()).or_default() += 1;
        *degree.entry(e.target.as_str()).or_default() += 1;
    }
    let label: BTreeMap<&str, (&str, &str)> = doc
        .nodes
        .iter()
        .map(|n| {
            (
                n.id.as_str(),
                (
                    n.label.as_str(),
                    n.attributes.get("kind").map(String::as_str).unwrap_or("?"),
                ),
            )
        })
        .collect();
    let mut ranked: Vec<_> = degree.into_iter().collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
    if !ranked.is_empty() {
        out.push_str("## Most connected nodes\n\n");
        for (id, deg) in ranked.iter().take(15) {
            let (lbl, kind) = label.get(id).copied().unwrap_or((*id, "?"));
            out.push_str(&format!("- **{lbl}** ({kind}) — {deg} connections\n"));
        }
        out.push('\n');
    }

    out
}
