//! Derive build-graph's reference edges from a rust-analyzer SCIP index, emitted
//! as `kind <TAB> caller_file:line <TAB> callee_file:line` — the same coordinate
//! system the rustc driver dumps, so the two can be diffed for equivalence.
//!
//! This replicates the attribution logic of build-graph's `src/scip.rs` exactly:
//!   - only global (`rust-analyzer …`) symbols map to nodes; `local …` ignored
//!   - a symbol is a fn iff its descriptor ends `).`
//!   - a reference is attributed to the nearest preceding fn definition in its file
//!   - a reference to a fn is a `call`, otherwise a `use`
//! A symbol only resolves if its *definition* occurs in some indexed document, so
//! external/std symbols (no indexed def) drop out — i.e. workspace-only, same as
//! scip.rs keeping only edges between graph nodes.
//!
//! Usage: scip-edges <index.scip> [caller_path_prefix]

use std::collections::HashMap;

use protobuf::Message;
use scip::types::{Index, Occurrence};

fn start_line(o: &Occurrence) -> i32 {
    o.range.first().copied().unwrap_or(0) + 1
}
fn is_global(symbol: &str) -> bool {
    symbol.starts_with("rust-analyzer")
}
fn sym_is_fn(symbol: &str) -> bool {
    symbol.ends_with(").")
}
fn is_def(o: &Occurrence) -> bool {
    o.symbol_roles & 1 != 0
}

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("usage: scip-edges <index.scip> [caller_prefix]");
    let prefix = args.next().unwrap_or_default();

    let bytes = std::fs::read(&path).expect("read index");
    let index = Index::parse_from_bytes(&bytes).expect("parse index");
    eprintln!("[scip-edges] {} documents", index.documents.len());

    // symbol -> (file, line) of its definition (fn and non-fn kept separate is not
    // needed here: the symbol string itself disambiguates).
    let mut sym_def: HashMap<&str, (String, i32)> = HashMap::new();
    for doc in &index.documents {
        for o in &doc.occurrences {
            if is_def(o) && is_global(&o.symbol) {
                sym_def
                    .entry(o.symbol.as_str())
                    .or_insert_with(|| (doc.relative_path.clone(), start_line(o)));
            }
        }
    }
    eprintln!("[scip-edges] {} defined global symbols", sym_def.len());

    let mut emitted = 0usize;
    let mut calls = 0usize;
    let mut uses = 0usize;
    for doc in &index.documents {
        // fn definitions in this file, sorted by line, for attribution.
        let mut fns: Vec<(i32, &str)> = doc
            .occurrences
            .iter()
            .filter(|o| is_def(o) && is_global(&o.symbol) && sym_is_fn(&o.symbol))
            .map(|o| (start_line(o), o.symbol.as_str()))
            .collect();
        fns.sort();

        for o in &doc.occurrences {
            if is_def(o) || !is_global(&o.symbol) {
                continue; // references only
            }
            let Some((callee_file, callee_line)) = sym_def.get(o.symbol.as_str()) else {
                continue; // unresolved (external/std) → dropped, like scip.rs
            };
            // enclosing fn = last def starting at or before this line
            let pos = fns.partition_point(|(l, _)| *l <= start_line(o));
            if pos == 0 {
                continue;
            }
            let caller_line = fns[pos - 1].0;
            let caller = format!("{}:{}", doc.relative_path, caller_line);
            let callee = format!("{callee_file}:{callee_line}");
            if caller == callee {
                continue;
            }
            if !prefix.is_empty() && !doc.relative_path.starts_with(&prefix) {
                continue; // only calls made *by* the target crate
            }
            let kind = if sym_is_fn(&o.symbol) { "call" } else { "use" };
            if kind == "call" {
                calls += 1;
            } else {
                uses += 1;
            }
            println!("{kind}\t{caller}\t{callee}");
            emitted += 1;
        }
    }
    eprintln!("[scip-edges] emitted {emitted} edges ({calls} call, {uses} use) for prefix `{prefix}`");
}
