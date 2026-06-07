//! Query the graph for code references, with a deliberately bounded API so a
//! caller (an AI agent especially) must say *what* it wants rather than pulling
//! a firehose of context:
//!
//! - [`find`] locates symbols and returns only **metadata** (kind, crate,
//!   `source_file:line`) plus **relationship counts** — never the edges
//!   themselves. A node may have hundreds of connections; the counts tell the
//!   caller the scale so it can decide what to drill into.
//! - [`refs`] expands *one* node's relationships, **bounded** (a hard cap) and
//!   **filterable** by relation, direction, and neighbor name/kind/crate — so a
//!   large connection list can be broken down to just the relevant slice.
//!
//! Both report `total` vs `returned`, so truncation is never silent.

use std::cmp::Reverse;
use std::collections::{BTreeMap, HashMap, HashSet};

use build_graph::{Edge, GraphJson, Node};
use serde::Serialize;

// ----- shared node helpers -----

fn attr<'a>(n: &'a Node, k: &str) -> Option<&'a str> {
    n.attributes.get(k).map(String::as_str)
}
fn node_kind(n: &Node) -> &str {
    attr(n, "kind").unwrap_or("?")
}
fn node_crate(n: &Node) -> &str {
    attr(n, "crate").unwrap_or("")
}

/// Accept friendly aliases for a `--kind` filter.
fn canon_kind(k: &str) -> &str {
    match k {
        "fn" | "func" => "function",
        "mod" => "module",
        "enum_variant" => "variant",
        other => other,
    }
}

/// How closely a label matches the query: exact (case-sensitive) is best, then
/// exact case-insensitive, then prefix, then substring.
fn name_tier(label: &str, query: &str, needle_lc: &str) -> u8 {
    if label == query {
        0
    } else if label.eq_ignore_ascii_case(query) {
        1
    } else if label.to_lowercase().starts_with(needle_lc) {
        2
    } else {
        3
    }
}

/// Prefer "definition" nodes (types, traits, fns, …) over members (a field or
/// method that happens to share a name) when ranking which symbol is meant.
fn kind_tier(kind: &str) -> u8 {
    match kind {
        "method" | "field" | "variant" => 1,
        _ => 0,
    }
}

/// Total ordering for ranking candidates: best name match, then definitions
/// over members, then **most-referenced first** (impact), then shorter label,
/// then a stable tiebreak by id. `refs_in` is the node's incoming-reference
/// count, so an AI searching a common name (`new`, `execute`) surfaces the
/// symbols the rest of the codebase actually depends on, not an arbitrary one.
fn sort_key<'a>(
    n: &'a Node,
    query: &str,
    needle_lc: &str,
    refs_in: usize,
) -> (u8, u8, Reverse<usize>, usize, &'a str) {
    (
        name_tier(&n.label, query, needle_lc),
        kind_tier(node_kind(n)),
        Reverse(refs_in),
        n.label.len(),
        n.id.as_str(),
    )
}

/// Prebuilt lookups over a graph: id→node plus the in/out adjacency. Building it
/// is O(nodes + edges); once built, queries avoid rescanning every edge —
/// `refs`/`context` become O(degree), `find`'s impact ranking O(1) per hit. The
/// CLI builds one per call; the resident `serve` server builds it **once** and
/// reuses it, which is what makes its queries fast.
pub struct Index<'a> {
    doc: &'a GraphJson,
    by_id: HashMap<&'a str, &'a Node>,
    out_adj: Adjacency<'a>,
    in_adj: Adjacency<'a>,
}

impl<'a> Index<'a> {
    pub fn build(doc: &'a GraphJson) -> Self {
        let by_id = doc.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
        let (out_adj, in_adj) = adjacency(doc);
        Index {
            doc,
            by_id,
            out_adj,
            in_adj,
        }
    }

    /// Incoming-reference count (impact): how much the codebase *depends on* a
    /// symbol — the "which one did you mean?" ranking signal. Outgoing edges (a
    /// type's own methods/fields) say nothing about that, so they're excluded.
    fn in_deg(&self, id: &str) -> usize {
        self.in_adj.get(id).map_or(0, Vec::len)
    }

    /// Per-relation in/out counts for one node, from the adjacency index.
    fn degree_of(&self, id: &str) -> Degree<'a> {
        let mut d = Degree::default();
        if let Some(es) = self.out_adj.get(id) {
            for e in es {
                d.total += 1;
                *d.outgoing.entry(e.relation.as_str()).or_default() += 1;
            }
        }
        if let Some(es) = self.in_adj.get(id) {
            for e in es {
                d.total += 1;
                *d.incoming.entry(e.relation.as_str()).or_default() += 1;
            }
        }
        d
    }
}

/// Does this node match a name query (substring on label/path, or exact label)?
fn name_matches(n: &Node, needle_lc: &str, raw: &str, exact: bool) -> bool {
    if exact {
        n.label.eq_ignore_ascii_case(raw)
    } else {
        n.label.to_lowercase().contains(needle_lc)
            || attr(n, "path").is_some_and(|p| p.to_lowercase().contains(needle_lc))
    }
}

// ----- find: locate symbols, return metadata + relationship counts -----

pub struct FindOpts {
    pub query: String,
    pub exact: bool,
    pub kind: Option<String>,
    pub krate: Option<String>,
    /// Reverse lookup: `(file, line)` — return the definition(s) at that location
    /// (the nearest symbol defined at or above `line`). Takes precedence over a
    /// name `query`. Lets an agent go from "the code I'm reading at foo.rs:42" to
    /// the graph node + its references.
    pub at: Option<(String, u32)>,
    /// Max matches to return (the caller clamps this).
    pub limit: usize,
}

/// Relationship counts for a node: a total, and per-relation tallies split by
/// direction. This is *metadata about* the connections, never their contents.
#[derive(Serialize, Default)]
pub struct Degree<'a> {
    pub total: usize,
    /// Edges out of the node (what it contains / depends on), `relation -> count`.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub outgoing: BTreeMap<&'a str, usize>,
    /// Edges into the node (what references it), `relation -> count`.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub incoming: BTreeMap<&'a str, usize>,
}

#[derive(Serialize)]
pub struct Match<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub kind: &'a str,
    #[serde(rename = "crate")]
    pub krate: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_file: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_location: Option<u32>,
    /// Counts only — use `refs` to expand the actual relationships.
    pub relationships: Degree<'a>,
}

#[derive(Serialize)]
pub struct FindResult<'a> {
    pub query: String,
    /// How many symbols matched before the limit.
    pub total_matches: usize,
    pub returned: usize,
    pub matches: Vec<Match<'a>>,
}

pub fn find_indexed<'a>(ix: &Index<'a>, opts: &FindOpts) -> FindResult<'a> {
    let needle = opts.query.to_lowercase();
    let want_kind = opts.kind.as_deref().map(canon_kind);

    let mut hits: Vec<&'a Node> = if let Some((file, line)) = &opts.at {
        // Reverse lookup: definitions in this file at/above the line, nearest first.
        let fl = file.to_lowercase();
        let mut in_file: Vec<&'a Node> = ix
            .doc
            .nodes
            .iter()
            .filter(|n| !matches!(node_kind(n), "file" | "crate"))
            .filter(|n| want_kind.is_none_or(|k| node_kind(n) == k))
            .filter(|n| opts.krate.as_deref().is_none_or(|c| node_crate(n) == c))
            .filter(|n| {
                n.source_file
                    .as_deref()
                    .is_some_and(|f| f.to_lowercase().ends_with(&fl))
            })
            .filter(|n| n.source_location.is_some_and(|l| l <= *line))
            .collect();
        // greatest line ≤ target = the symbol that encloses (or precedes) the line.
        in_file.sort_by(|a, b| {
            b.source_location
                .cmp(&a.source_location)
                .then_with(|| a.id.cmp(&b.id))
        });
        in_file
    } else {
        let mut h: Vec<&'a Node> = ix
            .doc
            .nodes
            .iter()
            .filter(|n| node_kind(n) != "file")
            .filter(|n| want_kind.is_none_or(|k| node_kind(n) == k))
            .filter(|n| opts.krate.as_deref().is_none_or(|c| node_crate(n) == c))
            .filter(|n| name_matches(n, &needle, &opts.query, opts.exact))
            .collect();
        h.sort_by(|a, b| {
            let ra = ix.in_deg(a.id.as_str());
            let rb = ix.in_deg(b.id.as_str());
            sort_key(a, &opts.query, &needle, ra).cmp(&sort_key(b, &opts.query, &needle, rb))
        });
        h
    };
    let total_matches = hits.len();
    hits.truncate(opts.limit);

    let matches = hits
        .iter()
        .map(|n| Match {
            id: n.id.as_str(),
            name: n.label.as_str(),
            kind: node_kind(n),
            krate: node_crate(n),
            path: attr(n, "path"),
            source_file: n.source_file.as_deref(),
            source_location: n.source_location,
            relationships: ix.degree_of(n.id.as_str()),
        })
        .collect();

    FindResult {
        query: opts
            .at
            .as_ref()
            .map(|(f, l)| format!("{f}:{l}"))
            .unwrap_or_else(|| opts.query.clone()),
        total_matches,
        returned: hits.len(),
        matches,
    }
}

/// Find symbols by name (or `--at` location), returning metadata + relationship
/// counts. Builds a one-shot [`Index`] (the server calls [`find_indexed`] with a
/// shared one).
pub fn find<'a>(doc: &'a GraphJson, opts: &FindOpts) -> FindResult<'a> {
    find_indexed(&Index::build(doc), opts)
}

// ----- refs: expand one node's relationships, bounded + filterable -----

pub struct RefsOpts {
    /// A node id (from `find`) or a symbol name.
    pub query: String,
    pub relation: Option<String>,
    pub incoming: bool,
    pub outgoing: bool,
    /// Substring filter on the neighbor's name/path (text search).
    pub name_match: Option<String>,
    pub kind: Option<String>,
    pub krate: Option<String>,
    /// Max edges to return (the caller clamps this to a hard cap).
    pub limit: usize,
    /// Transitive expansion: follow the relation up to this many hops from the
    /// subject (1 = direct neighbours). Each level is bounded by `limit`, so the
    /// blast radius stays capped. The caller clamps the depth.
    pub depth: usize,
}

#[derive(Serialize)]
pub struct Subject<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub kind: &'a str,
    #[serde(rename = "crate")]
    pub krate: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_file: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_location: Option<u32>,
}

fn is_one(n: &u8) -> bool {
    *n == 1
}

#[derive(Serialize, Clone)]
pub struct RefEdge<'a> {
    pub direction: &'static str,
    pub relation: &'a str,
    pub name: &'a str,
    pub kind: &'a str,
    #[serde(rename = "crate")]
    pub krate: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_file: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_location: Option<u32>,
    /// Hops from the subject (1 = direct neighbour). Shown only with `--depth>1`.
    #[serde(skip_serializing_if = "is_one")]
    pub depth: u8,
}

/// A ranked disambiguation candidate, returned when a `refs`/`context` query is
/// an ambiguous bare name. Pass one's `id` back as the query to pick it.
#[derive(Serialize)]
pub struct Candidate<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub kind: &'a str,
    #[serde(rename = "crate")]
    pub krate: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_file: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_location: Option<u32>,
    pub incoming_refs: usize,
}

#[derive(Serialize)]
pub struct RefsResult<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<Subject<'a>>,
    /// How many symbols share the resolved subject's name (>1 = same-name
    /// ambiguity; pass an `id` from `find` to pick a specific one).
    pub candidates: usize,
    /// When the query was an ambiguous bare name, the ranked alternatives to pick
    /// from (most-referenced first). Empty once the subject is unambiguous.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub candidate_list: Vec<Candidate<'a>>,
    /// Edges matching the filters before the limit.
    pub total_matching: usize,
    pub returned: usize,
    pub edges: Vec<RefEdge<'a>>,
}

struct Resolved<'a> {
    /// Best-ranked node, or `None` if nothing matched.
    subject: Option<&'a Node>,
    /// How many nodes share the subject's name.
    same_name: usize,
    /// The query was a bare name matching multiple symbols at the best name tier
    /// (an exact / case-insensitive collision) — the caller should present the
    /// candidates and let the agent pick, rather than guessing.
    ambiguous: bool,
    /// Top hits with their incoming-ref counts, for a disambiguation list.
    top: Vec<(&'a Node, usize)>,
}

/// Resolve the subject node. An exact node id wins outright (unambiguous);
/// otherwise the best-ranked node whose label/path matches the query, ranked by
/// name match then impact (incoming references).
fn resolve_subject<'a>(ix: &Index<'a>, query: &str) -> Resolved<'a> {
    if let Some(n) = ix.by_id.get(query) {
        return Resolved {
            subject: Some(*n),
            same_name: 1,
            ambiguous: false,
            top: Vec::new(),
        };
    }
    let needle = query.to_lowercase();
    let mut hits: Vec<&'a Node> = ix
        .doc
        .nodes
        .iter()
        .filter(|n| node_kind(n) != "file")
        .filter(|n| name_matches(n, &needle, query, false))
        .collect();
    hits.sort_by(|a, b| {
        let ra = ix.in_deg(a.id.as_str());
        let rb = ix.in_deg(b.id.as_str());
        sort_key(a, query, &needle, ra).cmp(&sort_key(b, query, &needle, rb))
    });
    let subject = hits.first().copied();
    // Ambiguous only when several symbols tie at the *best* name tier and that
    // tier is an exact/case-insensitive match — i.e. a real same-name collision,
    // not a broad substring search (where surfacing the top hit is fine).
    let best_tier = subject
        .map(|n| name_tier(&n.label, query, &needle))
        .unwrap_or(u8::MAX);
    let tier_count = hits
        .iter()
        .filter(|n| name_tier(&n.label, query, &needle) == best_tier)
        .count();
    let ambiguous = best_tier <= 1 && tier_count > 1;
    let same_name = match subject {
        Some(s) => ix
            .doc
            .nodes
            .iter()
            .filter(|n| node_kind(n) != "file" && n.label.eq_ignore_ascii_case(&s.label))
            .count(),
        None => 0,
    };
    let top = hits
        .iter()
        .take(12)
        .map(|n| (*n, ix.in_deg(n.id.as_str())))
        .collect();
    Resolved {
        subject,
        same_name,
        ambiguous,
        top,
    }
}

/// Edges indexed by an endpoint, so a traversal fetches a node's edges in
/// O(degree) instead of rescanning every edge — what makes `--depth` cheap.
type Adjacency<'a> = HashMap<&'a str, Vec<&'a Edge>>;

/// Build the outgoing-by-source and incoming-by-target indexes in one pass.
/// Used for transitive (`--depth>1`) walks where any node may be expanded.
fn adjacency(doc: &GraphJson) -> (Adjacency<'_>, Adjacency<'_>) {
    let mut out_adj: Adjacency = HashMap::new();
    let mut in_adj: Adjacency = HashMap::new();
    for e in &doc.edges {
        out_adj.entry(e.source.as_str()).or_default().push(e);
        in_adj.entry(e.target.as_str()).or_default().push(e);
    }
    (out_adj, in_adj)
}

/// Collect the filtered edges incident to `from` (subject↔neighbour) from the
/// adjacency index, tagged with `level`. Returns `(edge, neighbour_id)`.
fn gather<'a>(
    by_id: &HashMap<&'a str, &'a Node>,
    out_adj: &Adjacency<'a>,
    in_adj: &Adjacency<'a>,
    from: &str,
    opts: &RefsOpts,
    level: u8,
) -> Vec<(RefEdge<'a>, &'a str)> {
    let want_kind = opts.kind.as_deref().map(canon_kind);
    let name_match = opts.name_match.as_deref().map(str::to_lowercase);
    let empty: Vec<&Edge> = Vec::new();
    let outs = if opts.outgoing {
        out_adj.get(from).unwrap_or(&empty)
    } else {
        &empty
    };
    let ins = if opts.incoming {
        in_adj.get(from).unwrap_or(&empty)
    } else {
        &empty
    };
    let mut out = Vec::new();
    for (direction, e, other_id) in outs
        .iter()
        .map(|e| ("outgoing", *e, e.target.as_str()))
        .chain(ins.iter().map(|e| ("incoming", *e, e.source.as_str())))
    {
        if let Some(rel) = &opts.relation
            && e.relation != *rel
        {
            continue;
        }
        let Some(other) = by_id.get(other_id) else {
            continue;
        };
        if let Some(k) = want_kind
            && node_kind(other) != k
        {
            continue;
        }
        if let Some(c) = &opts.krate
            && node_crate(other) != c.as_str()
        {
            continue;
        }
        if let Some(m) = &name_match {
            let hit = other.label.to_lowercase().contains(m)
                || attr(other, "path").is_some_and(|p| p.to_lowercase().contains(m));
            if !hit {
                continue;
            }
        }
        out.push((
            RefEdge {
                direction,
                relation: e.relation.as_str(),
                name: other.label.as_str(),
                kind: node_kind(other),
                krate: node_crate(other),
                path: attr(other, "path"),
                source_file: other.source_file.as_deref(),
                source_location: other.source_location,
                depth: level,
            },
            other_id,
        ));
    }
    out
}

fn to_candidates<'a>(top: &[(&'a Node, usize)]) -> Vec<Candidate<'a>> {
    top.iter()
        .map(|(n, refs_in)| Candidate {
            id: n.id.as_str(),
            name: n.label.as_str(),
            kind: node_kind(n),
            krate: node_crate(n),
            path: attr(n, "path"),
            source_file: n.source_file.as_deref(),
            source_location: n.source_location,
            incoming_refs: *refs_in,
        })
        .collect()
}

fn subject_of(n: &Node) -> Subject<'_> {
    Subject {
        id: n.id.as_str(),
        name: n.label.as_str(),
        kind: node_kind(n),
        krate: node_crate(n),
        source_file: n.source_file.as_deref(),
        source_location: n.source_location,
    }
}

pub fn refs_indexed<'a>(ix: &Index<'a>, opts: &RefsOpts) -> RefsResult<'a> {
    let res = resolve_subject(ix, &opts.query);

    // Ambiguous bare name → return ranked candidates so the agent picks an id.
    if res.ambiguous {
        return RefsResult {
            subject: None,
            candidates: res.same_name,
            candidate_list: to_candidates(&res.top),
            total_matching: 0,
            returned: 0,
            edges: Vec::new(),
        };
    }
    let Some(subj) = res.subject else {
        return RefsResult {
            subject: None,
            candidates: res.same_name,
            candidate_list: Vec::new(),
            total_matching: 0,
            returned: 0,
            edges: Vec::new(),
        };
    };

    // Breadth-first to `depth`, each level bounded by `limit` so the transitive
    // blast radius stays capped. `depth == 1` is the plain one-hop expansion.
    let depth = opts.depth.clamp(1, 5) as u8;
    let mut edges: Vec<RefEdge<'a>> = Vec::new();
    let mut total_matching = 0usize;
    let mut visited: HashSet<&str> = HashSet::new();
    visited.insert(subj.id.as_str());
    let mut seen_edge: HashSet<(&str, &str, &str)> = HashSet::new();
    let mut frontier: Vec<&str> = vec![subj.id.as_str()];

    for level in 1..=depth {
        let mut found: Vec<(RefEdge<'a>, &'a str)> = Vec::new();
        for &nid in &frontier {
            for (edge, oid) in gather(&ix.by_id, &ix.out_adj, &ix.in_adj, nid, opts, level) {
                if seen_edge.insert((nid, oid, edge.relation)) {
                    found.push((edge, oid));
                }
            }
        }
        found.sort_by(|a, b| {
            a.0.direction
                .cmp(b.0.direction)
                .then(a.0.relation.cmp(b.0.relation))
                .then(a.0.name.cmp(b.0.name))
        });
        total_matching += found.len();
        let mut next: Vec<&str> = Vec::new();
        for (edge, oid) in found.into_iter().take(opts.limit) {
            if visited.insert(oid) {
                next.push(oid);
            }
            edges.push(edge);
        }
        frontier = next;
        if frontier.is_empty() {
            break;
        }
    }

    RefsResult {
        subject: Some(subject_of(subj)),
        candidates: res.same_name,
        candidate_list: Vec::new(),
        total_matching,
        returned: edges.len(),
        edges,
    }
}

/// Expand one symbol's relationships (bounded + filterable, transitive with
/// `--depth`). Builds a one-shot [`Index`]; the server calls [`refs_indexed`].
pub fn refs<'a>(doc: &'a GraphJson, opts: &RefsOpts) -> RefsResult<'a> {
    refs_indexed(&Index::build(doc), opts)
}

// ----- context: one-shot find + the symbol's most useful relationships -----

/// `(direction, relation, human label)` ordered by usefulness for understanding
/// a symbol; `context` buckets the subject's edges into these groups.
const CONTEXT_GROUPS: &[(&str, &str, &str)] = &[
    ("incoming", "calls", "called by"),
    ("outgoing", "calls", "calls"),
    ("incoming", "uses", "used by"),
    ("outgoing", "uses", "uses"),
    ("incoming", "member_calls", "called by members of"),
    ("outgoing", "member_calls", "member calls"),
    ("incoming", "member_uses", "used by members of"),
    ("outgoing", "member_uses", "member uses"),
    ("incoming", "implements", "implemented by"),
    ("outgoing", "implements", "implements"),
    ("incoming", "takes", "passed to"),
    ("incoming", "returns", "returned by"),
    ("incoming", "uses_type", "used in signature of"),
    ("outgoing", "has_method", "methods"),
    ("outgoing", "has_field", "fields"),
    ("outgoing", "has_variant", "variants"),
    ("incoming", "contains", "defined in"),
];

#[derive(Serialize)]
pub struct ContextGroup<'a> {
    pub label: &'static str,
    /// Total edges in this category (before the per-group cap).
    pub total: usize,
    pub shown: Vec<RefEdge<'a>>,
}

#[derive(Serialize)]
pub struct ContextResult<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<Subject<'a>>,
    pub candidates: usize,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub candidate_list: Vec<Candidate<'a>>,
    /// Full relationship counts (every relation, both directions).
    pub relationships: Degree<'a>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub groups: Vec<ContextGroup<'a>>,
}

/// One-shot context for a symbol: resolve it, then return its metadata, full
/// relationship counts, and a bounded sample of each useful relationship group
/// (top callers, callees, users, impls, fields, …) — what an agent would
/// otherwise assemble from a `find` plus several `refs` calls.
pub fn context_indexed<'a>(ix: &Index<'a>, query: &str, per_group: usize) -> ContextResult<'a> {
    let res = resolve_subject(ix, query);
    if res.ambiguous {
        return ContextResult {
            subject: None,
            candidates: res.same_name,
            candidate_list: to_candidates(&res.top),
            relationships: Degree::default(),
            groups: Vec::new(),
        };
    }
    let Some(subj) = res.subject else {
        return ContextResult {
            subject: None,
            candidates: res.same_name,
            candidate_list: Vec::new(),
            relationships: Degree::default(),
            groups: Vec::new(),
        };
    };

    // Every edge incident to the subject (no relation/kind/crate/match filter).
    let all_opts = RefsOpts {
        query: String::new(),
        relation: None,
        incoming: true,
        outgoing: true,
        name_match: None,
        kind: None,
        krate: None,
        limit: 0,
        depth: 1,
    };
    let all = gather(
        &ix.by_id,
        &ix.out_adj,
        &ix.in_adj,
        subj.id.as_str(),
        &all_opts,
        1,
    );

    let mut deg = Degree::default();
    for (e, _) in &all {
        deg.total += 1;
        if e.direction == "outgoing" {
            *deg.outgoing.entry(e.relation).or_default() += 1;
        } else {
            *deg.incoming.entry(e.relation).or_default() += 1;
        }
    }

    let mut groups = Vec::new();
    for (dir, rel, label) in CONTEXT_GROUPS {
        let mut matched: Vec<RefEdge<'a>> = all
            .iter()
            .filter(|(e, _)| e.direction == *dir && e.relation == *rel)
            .map(|(e, _)| e.clone())
            .collect();
        if matched.is_empty() {
            continue;
        }
        let total = matched.len();
        matched.sort_by(|a, b| a.path.unwrap_or(a.name).cmp(b.path.unwrap_or(b.name)));
        matched.truncate(per_group);
        groups.push(ContextGroup {
            label,
            total,
            shown: matched,
        });
    }

    ContextResult {
        subject: Some(subject_of(subj)),
        candidates: res.same_name,
        candidate_list: Vec::new(),
        relationships: deg,
        groups,
    }
}

/// One-shot context for a symbol. Builds a one-shot [`Index`]; the server calls
/// [`context_indexed`] with a shared one.
pub fn context<'a>(doc: &'a GraphJson, query: &str, per_group: usize) -> ContextResult<'a> {
    context_indexed(&Index::build(doc), query, per_group)
}
