//! Render query results to text — JSON (the stable agent shape) or a
//! human-readable summary. Shared by the CLI and the `serve` server so both
//! produce identical output; each returns a `String` rather than printing, so
//! the server can ship it over the wire.

use std::collections::BTreeMap;
use std::fmt::Write;

use serde::Serialize;

use crate::query::{Candidate, ContextResult, Degree, FindResult, RefsResult};

/// Pretty JSON (the stable shape tools/agents parse), newline-terminated.
pub fn json<T: Serialize>(value: &T) -> String {
    let mut s =
        serde_json::to_string_pretty(value).unwrap_or_else(|e| format!("{{\"error\":\"{e}\"}}"));
    s.push('\n');
    s
}

pub fn find(r: &FindResult, as_json: bool) -> String {
    if as_json {
        return json(r);
    }
    let mut s = String::new();
    if r.matches.is_empty() {
        let _ = writeln!(
            s,
            "no matches for `{}`. If the rich layer is missing, build it \
             (`cargo build-graph build --rich`); otherwise loosen --kind/--crate, or \
             (for --at) check the FILE:LINE sits at or just below a definition.",
            r.query
        );
        return s;
    }
    if r.total_matches > r.returned {
        let _ = writeln!(
            s,
            "{} matches for `{}` — showing {} (narrow with --kind / --crate / --exact)\n",
            r.total_matches, r.query, r.returned
        );
    }
    for (i, m) in r.matches.iter().enumerate() {
        if i > 0 {
            let _ = writeln!(s);
        }
        let _ = writeln!(s, "{} — {} · crate {}", m.name, m.kind, m.krate);
        if let Some(p) = m.path {
            let _ = writeln!(s, "  path: {p}");
        }
        if let Some(f) = m.source_file {
            match m.source_location {
                Some(l) => {
                    let _ = writeln!(s, "  src:  {f}:{l}");
                }
                None => {
                    let _ = writeln!(s, "  src:  {f}");
                }
            }
        }
        degree(&mut s, &m.relationships);
    }
    if r.matches.iter().any(|m| m.relationships.total > 0) {
        let _ = writeln!(
            s,
            "\nexpand a symbol's relationships: \
             cargo build-graph refs <name|id> [--relation R] [--crate C] [--match S]"
        );
    }
    s
}

/// Relationship counts only (metadata) — `refs` expands the edges.
fn degree(s: &mut String, d: &Degree) {
    if d.total == 0 {
        let _ = writeln!(s, "  refs: none");
        return;
    }
    let fmt = |m: &BTreeMap<&str, usize>| {
        let mut v: Vec<_> = m.iter().collect();
        v.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
        v.iter()
            .map(|(rel, n)| format!("{rel} {n}"))
            .collect::<Vec<_>>()
            .join(" · ")
    };
    let out_n: usize = d.outgoing.values().sum();
    let in_n: usize = d.incoming.values().sum();
    let _ = writeln!(s, "  refs: {} total (out {out_n} · in {in_n})", d.total);
    if !d.outgoing.is_empty() {
        let _ = writeln!(s, "        out: {}", fmt(&d.outgoing));
    }
    if !d.incoming.is_empty() {
        let _ = writeln!(s, "        in:  {}", fmt(&d.incoming));
    }
}

pub fn refs(r: &RefsResult, q: &str, as_json: bool) -> String {
    if as_json {
        return json(r);
    }
    let mut s = String::new();
    let Some(subj) = &r.subject else {
        if r.candidate_list.is_empty() {
            let _ = writeln!(
                s,
                "no symbol matches `{q}`. Pass an exact name, a --crate, or a node id from `find`."
            );
        } else {
            candidates(&mut s, q, r.candidates, &r.candidate_list);
        }
        return s;
    };
    match (subj.source_file, subj.source_location) {
        (Some(f), Some(l)) => {
            let _ = writeln!(
                s,
                "{} — {} · crate {}  ({f}:{l})",
                subj.name, subj.kind, subj.krate
            );
        }
        (Some(f), None) => {
            let _ = writeln!(
                s,
                "{} — {} · crate {}  ({f})",
                subj.name, subj.kind, subj.krate
            );
        }
        _ => {
            let _ = writeln!(s, "{} — {} · crate {}", subj.name, subj.kind, subj.krate);
        }
    }
    if r.candidates > 1 {
        let _ = writeln!(
            s,
            "  (top match of {} symbols named `{}` — `find {} --exact` lists them; pass an id to pick another)",
            r.candidates, subj.name, subj.name
        );
    }
    if r.edges.is_empty() {
        let _ = writeln!(s, "  no matching relationships.");
        return s;
    }
    if r.total_matching > r.returned {
        let _ = writeln!(
            s,
            "  showing {} of {} — narrow with --relation / --crate / --kind / --match, or raise --limit",
            r.returned, r.total_matching
        );
    } else {
        let _ = writeln!(s, "  {} relationship(s)", r.total_matching);
    }
    for e in &r.edges {
        let arrow = if e.direction == "incoming" {
            "<-"
        } else {
            "->"
        };
        let name = e.path.unwrap_or(e.name);
        let mut line = if e.depth > 1 {
            format!("  d{} {:<9} {arrow} {name}", e.depth, e.relation)
        } else {
            format!("  {:<11} {arrow} {name}", e.relation)
        };
        if !e.krate.is_empty() && e.krate != subj.krate {
            line.push_str(&format!(" ({})", e.krate));
        }
        if let Some(f) = e.source_file {
            line.push_str("  ");
            line.push_str(f);
            if let Some(l) = e.source_location {
                line.push_str(&format!(":{l}"));
            }
        }
        let _ = writeln!(s, "{line}");
    }
    s
}

fn candidates(s: &mut String, q: &str, total: usize, list: &[Candidate]) {
    let _ = writeln!(
        s,
        "`{q}` is ambiguous — {total} symbols share this name. Pick one by id:\n"
    );
    for c in list {
        let loc = match (c.source_file, c.source_location) {
            (Some(f), Some(l)) => format!("  {f}:{l}"),
            (Some(f), None) => format!("  {f}"),
            _ => String::new(),
        };
        let _ = writeln!(
            s,
            "  {} — {} · crate {} · {} refs{loc}",
            c.path.unwrap_or(c.name),
            c.kind,
            c.krate,
            c.incoming_refs
        );
        let _ = writeln!(s, "    id: {}", c.id);
    }
    let _ = writeln!(s, "\nthen: cargo build-graph context <id>   (or refs <id>)");
}

pub fn context(r: &ContextResult, q: &str, as_json: bool) -> String {
    if as_json {
        return json(r);
    }
    let mut s = String::new();
    let Some(subj) = &r.subject else {
        if r.candidate_list.is_empty() {
            let _ = writeln!(s, "no symbol matches `{q}`. Try `find {q}`.");
        } else {
            candidates(&mut s, q, r.candidates, &r.candidate_list);
        }
        return s;
    };
    match (subj.source_file, subj.source_location) {
        (Some(f), Some(l)) => {
            let _ = writeln!(
                s,
                "{} — {} · crate {}  ({f}:{l})",
                subj.name, subj.kind, subj.krate
            );
        }
        (Some(f), None) => {
            let _ = writeln!(
                s,
                "{} — {} · crate {}  ({f})",
                subj.name, subj.kind, subj.krate
            );
        }
        _ => {
            let _ = writeln!(s, "{} — {} · crate {}", subj.name, subj.kind, subj.krate);
        }
    }
    degree(&mut s, &r.relationships);
    for g in &r.groups {
        let more = if g.total > g.shown.len() {
            format!(" (top {})", g.shown.len())
        } else {
            String::new()
        };
        let _ = writeln!(s, "\n  {} · {}{more}", g.label, g.total);
        for e in &g.shown {
            let name = e.path.unwrap_or(e.name);
            let mut line = format!("    {name}");
            if !e.krate.is_empty() && e.krate != subj.krate {
                line.push_str(&format!(" ({})", e.krate));
            }
            if let Some(f) = e.source_file {
                line.push_str("  ");
                line.push_str(f);
                if let Some(l) = e.source_location {
                    line.push_str(&format!(":{l}"));
                }
            }
            let _ = writeln!(s, "{line}");
        }
    }
    s
}
