//! Merge per-crate [`Fragment`]s into a single [`Graph`].

use std::collections::HashSet;

use crate::fragment::Fragment;
use crate::graph::{Graph, Node, crate_id, file_id, norm};

/// Build a graph from fragments. `depends_on` edges are only emitted between
/// crates that both produced a fragment (i.e. both opted in), keeping the view
/// to the instrumented workspace rather than every registry crate.
pub fn merge_fragments(fragments: &[Fragment]) -> Graph {
    let mut graph = Graph::new();
    let known: HashSet<String> = fragments.iter().map(|f| norm(&f.crate_name)).collect();

    for frag in fragments {
        let cid = crate_id(&frag.crate_name);
        graph.add_node(
            Node::new(cid.clone(), frag.crate_name.clone(), "crate")
                .attr("crate", frag.crate_name.clone())
                .attr("version", frag.version.clone()),
        );
        for file in &frag.files {
            let fid = file_id(&frag.crate_name, &file.rel);
            graph.add_node(
                Node::new(fid.clone(), file.rel.clone(), "file")
                    .with_source(Some(file.path.clone()), None)
                    .attr("crate", frag.crate_name.clone()),
            );
            graph.add_edge(cid.clone(), fid, "contains", None, None);
        }
    }

    for frag in fragments {
        let cid = crate_id(&frag.crate_name);
        for dep in &frag.dep_names {
            if known.contains(&norm(dep)) {
                graph.add_edge(cid.clone(), crate_id(dep), "depends_on", None, None);
            }
        }
    }

    graph
}
