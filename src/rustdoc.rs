//! Layer 2 — the rich symbol/type item graph, from nightly rustdoc JSON.
//!
//! For each selected workspace library we invoke
//! `rustup run <nightly> cargo rustdoc -p <pkg> --lib -- -Z unstable-options
//! --output-format json`, parse `target/doc/<crate>.json` with `rustdoc-types`,
//! and fold the items + their relationships into the graph. Item nodes link up
//! to the Layer-1 crate node, and cross-crate type references resolve to other
//! workspace crate nodes, so the layers form one connected graph.

use std::collections::{HashMap, HashSet};
use std::process::Command;

use anyhow::{Context, Result, bail};
use camino::Utf8Path;
use cargo_metadata::{Metadata, Package, Target};
use rustdoc_types::{Attribute, Crate, Id, Item, ItemEnum, StructKind, Type, VariantKind};

use build_graph::{Graph, Node, crate_id, item_id, norm};

/// Run rustdoc JSON for the selected workspace libraries and add their items.
pub fn add_item_layer(
    graph: &mut Graph,
    meta: &Metadata,
    target_dir: &Utf8Path,
    nightly: Option<&str>,
    packages: &[String],
    release: bool,
    no_derives: bool,
) -> Result<usize> {
    let toolchain = nightly.unwrap_or("nightly");
    let selected = select_lib_packages(meta, packages);
    if selected.is_empty() {
        eprintln!("[build-graph] rich layer: no library targets to document");
        return Ok(0);
    }

    let workspace_crate_names: HashSet<String> = meta
        .workspace_packages()
        .iter()
        .map(|p| norm(&p.name))
        .collect();

    // One nightly doc build for everything selected — shared compilation, and
    // robust to per-crate failure via `--keep-going`. This scales to a whole
    // workspace far better than one rustdoc invocation per crate.
    let n = selected.len();
    eprintln!("[build-graph] rich layer: documenting {n} crate(s) with {toolchain} (one pass)…");
    run_doc_json(meta, target_dir, toolchain, packages, release)?;

    let mut total = 0usize;
    let mut done = 0usize;
    let mut pending: Vec<Pending> = Vec::new();
    for pkg in selected {
        match ingest_pkg(graph, target_dir, pkg, &workspace_crate_names, no_derives) {
            Ok((added, refs)) => {
                total += added;
                done += 1;
                pending.extend(refs);
            }
            Err(e) => eprintln!("[build-graph] rich layer: skipped {} ({e:#})", pkg.name),
        }
    }

    // Now that every crate's items exist, resolve cross-crate references to the
    // specific item (crate node as fallback) so item→item edges are visible.
    let mut cross = 0usize;
    for p in pending {
        if !graph.contains(&p.from) {
            continue;
        }
        if graph.contains(&p.item) {
            graph.add_edge(p.from, p.item, p.rel, None, None);
            cross += 1;
        } else if graph.contains(&p.krate) {
            graph.add_edge(p.from, p.krate, p.rel, None, None);
        }
    }
    eprintln!(
        "[build-graph] rich layer: +{total} item nodes from {done}/{n} crate(s), {cross} cross-crate edge(s)"
    );
    Ok(total)
}

pub fn is_lib_target(t: &Target) -> bool {
    t.kind
        .iter()
        .any(|k| matches!(k.to_string().as_str(), "lib" | "rlib" | "proc-macro"))
}

fn select_lib_packages<'a>(meta: &'a Metadata, packages: &[String]) -> Vec<&'a Package> {
    let want: HashSet<&str> = packages.iter().map(|s| s.as_str()).collect();
    meta.workspace_packages()
        .into_iter()
        .filter(|p| want.is_empty() || want.contains(p.name.as_str()))
        .filter(|p| p.targets.iter().any(is_lib_target))
        .collect()
}

pub fn lib_crate_name(pkg: &Package) -> String {
    pkg.targets
        .iter()
        .find(|t| is_lib_target(t))
        .map(|t| t.name.replace('-', "_"))
        .unwrap_or_else(|| pkg.name.replace('-', "_"))
}

/// Parse one crate's already-produced rustdoc JSON and fold its items in.
fn ingest_pkg(
    graph: &mut Graph,
    target_dir: &Utf8Path,
    pkg: &Package,
    workspace_crate_names: &HashSet<String>,
    no_derives: bool,
) -> Result<(usize, Vec<Pending>)> {
    let json_path = target_dir
        .join("doc")
        .join(format!("{}.json", lib_crate_name(pkg)));
    let data = std::fs::read_to_string(&json_path).with_context(|| {
        format!("no rustdoc JSON at {json_path} (crate may have failed to build)")
    })?;
    let krate: Crate =
        serde_json::from_str(&data).with_context(|| format!("parsing rustdoc JSON {json_path}"))?;

    if krate.format_version != rustdoc_types::FORMAT_VERSION {
        bail!(
            "rustdoc JSON format_version {} != supported {}; install/select a matching nightly \
             (e.g. --nightly nightly-2026-02-27) or update the rustdoc-types pin",
            krate.format_version,
            rustdoc_types::FORMAT_VERSION
        );
    }

    let mut ingest = Ingest::new(&krate, &pkg.name, workspace_crate_names.clone(), no_derives);
    ingest.run(&crate_id(&pkg.name));
    Ok(ingest.apply(graph))
}

/// Produce rustdoc JSON for all selected crates in a single `cargo doc` pass.
fn run_doc_json(
    meta: &Metadata,
    target_dir: &Utf8Path,
    toolchain: &str,
    packages: &[String],
    release: bool,
) -> Result<()> {
    let manifest = meta.workspace_root.join("Cargo.toml");
    let mut cmd = Command::new("rustup");
    // `--document-private-items`: a code graph needs the *private* helpers too,
    // not just the public API — otherwise references to/from them (most of a
    // codebase) have no node to connect to and `find callers` comes up empty.
    cmd.env(
        "RUSTDOCFLAGS",
        "-Z unstable-options --output-format json --document-private-items",
    )
    .arg("run")
    .arg(toolchain)
    .arg("cargo")
    .arg("doc")
    .arg("--no-deps")
    .arg("--keep-going")
    .arg("--manifest-path")
    .arg(manifest.as_str())
    .arg("--target-dir")
    .arg(target_dir.as_str());
    if release {
        cmd.arg("--release");
    }
    if packages.is_empty() {
        cmd.arg("--workspace");
    } else {
        for p in packages {
            cmd.arg("-p").arg(p);
        }
    }

    let status = cmd
        .status()
        .with_context(|| format!("failed to run `rustup run {toolchain} cargo doc`"))?;
    // With `--keep-going`, a non-zero status just means some crates failed to
    // build; we still ingest the JSON that was produced for the rest.
    if !status.success() {
        eprintln!(
            "[build-graph] rich layer: doc build reported errors; ingesting crates that succeeded"
        );
    }
    Ok(())
}

struct EdgeSpec {
    src: String,
    tgt: String,
    rel: &'static str,
}

/// A deferred cross-crate edge, resolved against the global node set once every
/// crate has been ingested (the target item may live in a not-yet-seen crate).
struct Pending {
    from: String,
    /// Preferred target: the specific item in the other crate.
    item: String,
    /// Fallback target: the other crate's node, if that item isn't present.
    krate: String,
    rel: &'static str,
}

/// Outcome of resolving a type reference to a graph node.
enum Resolved {
    Local(String),
    External { item: String, krate: String },
}

/// Folds one crate's rustdoc JSON into nodes + edges. Built in two phases: a
/// walk that creates every item node (filling `map: Id -> node id`), then a
/// type pass that resolves field/parameter/return/impl type references using
/// the now-complete map.
struct Ingest<'a> {
    krate: &'a Crate,
    pkg: &'a str,
    workspace_crate_names: HashSet<String>,
    map: HashMap<Id, String>,
    nodes: Vec<Node>,
    edges: Vec<EdgeSpec>,
    /// (owner type node id, impl item id) for the type pass.
    impls: Vec<(String, Id)>,
    /// Cross-crate references, resolved globally after all crates are ingested.
    pending: Vec<Pending>,
    /// Skip `#[automatically_derived]` impls (their `implements` edge + methods).
    no_derives: bool,
}

impl<'a> Ingest<'a> {
    fn new(
        krate: &'a Crate,
        pkg: &'a str,
        workspace_crate_names: HashSet<String>,
        no_derives: bool,
    ) -> Self {
        Ingest {
            krate,
            pkg,
            workspace_crate_names,
            map: HashMap::new(),
            nodes: Vec::new(),
            edges: Vec::new(),
            impls: Vec::new(),
            pending: Vec::new(),
            no_derives,
        }
    }

    fn run(&mut self, crate_node_id: &str) {
        if let Some(root) = self.krate.index.get(&self.krate.root)
            && let ItemEnum::Module(m) = &root.inner
        {
            for child in &m.items {
                if let Some(node) = self.walk(*child, "", None) {
                    self.edges.push(EdgeSpec {
                        src: crate_node_id.to_string(),
                        tgt: node,
                        rel: "contains",
                    });
                }
            }
        }
        self.type_pass();
    }

    /// Create a node for `id` (and its children) under `prefix`. Returns the
    /// node id, or `None` for kinds we don't model (use/extern crate/…).
    fn walk(&mut self, id: Id, prefix: &str, force_kind: Option<&'static str>) -> Option<String> {
        if let Some(existing) = self.map.get(&id) {
            return Some(existing.clone());
        }
        let item = self.krate.index.get(&id)?;
        let name = item.name.clone()?;
        let kind = force_kind.or_else(|| kind_str(&item.inner))?;

        let my_path = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}::{name}")
        };
        let node_id = item_id(self.pkg, &my_path, kind);
        self.map.insert(id, node_id.clone());

        let (file, line) = span_of(item);
        self.nodes.push(
            Node::new(node_id.clone(), name, kind)
                .with_source(file, line)
                .attr("crate", self.pkg.to_string())
                .attr("path", my_path.clone()),
        );

        match &item.inner {
            ItemEnum::Module(m) => {
                for child in &m.items {
                    if let Some(cn) = self.walk(*child, &my_path, None) {
                        self.push_edge(&node_id, &cn, "contains");
                    }
                }
            }
            ItemEnum::Struct(s) => {
                for field in struct_fields(s) {
                    if let Some(fnode) = self.walk(field, &my_path, None) {
                        self.push_edge(&node_id, &fnode, "has_field");
                    }
                }
                for imp in &s.impls {
                    self.walk_impl(&node_id, &my_path, *imp);
                }
            }
            ItemEnum::Enum(e) => {
                for variant in &e.variants {
                    if let Some(vn) = self.walk(*variant, &my_path, None) {
                        self.push_edge(&node_id, &vn, "has_variant");
                    }
                }
                for imp in &e.impls {
                    self.walk_impl(&node_id, &my_path, *imp);
                }
            }
            ItemEnum::Union(u) => {
                for field in &u.fields {
                    if let Some(fnode) = self.walk(*field, &my_path, None) {
                        self.push_edge(&node_id, &fnode, "has_field");
                    }
                }
                for imp in &u.impls {
                    self.walk_impl(&node_id, &my_path, *imp);
                }
            }
            ItemEnum::Trait(t) => {
                for assoc in &t.items {
                    if let Some(an) = self.walk(*assoc, &my_path, Some("method")) {
                        self.push_edge(&node_id, &an, "has_method");
                    }
                }
            }
            ItemEnum::Variant(v) => {
                for field in variant_fields(v) {
                    if let Some(fnode) = self.walk(field, &my_path, None) {
                        self.push_edge(&node_id, &fnode, "has_field");
                    }
                }
            }
            _ => {}
        }
        Some(node_id)
    }

    fn walk_impl(&mut self, owner_node: &str, owner_path: &str, impl_id: Id) {
        let Some(item) = self.krate.index.get(&impl_id) else {
            return;
        };
        let ItemEnum::Impl(im) = &item.inner else {
            return;
        };
        // Skip compiler-synthesized / blanket impls (Send/Sync/etc.) — noise.
        if im.is_synthetic || im.blanket_impl.is_some() {
            return;
        }
        // With `--no-derives`, skip derive-generated impls entirely (their
        // `implements` edge and their clone/default/fmt/… method nodes). The
        // compiler marks every derived impl `#[automatically_derived]`.
        if self.no_derives
            && item
                .attrs
                .iter()
                .any(|a| matches!(a, Attribute::AutomaticallyDerived))
        {
            return;
        }
        for assoc in &im.items {
            if let Some(mn) = self.walk(*assoc, owner_path, Some("method")) {
                self.push_edge(owner_node, &mn, "has_method");
            }
        }
        // `implements` is resolved in the type pass (the trait node may not be
        // walked yet at this point).
        self.impls.push((owner_node.to_string(), impl_id));
    }

    fn type_pass(&mut self) {
        let entries: Vec<(Id, String)> = self.map.iter().map(|(k, v)| (*k, v.clone())).collect();
        for (id, node) in entries {
            let Some(item) = self.krate.index.get(&id) else {
                continue;
            };
            match &item.inner {
                ItemEnum::StructField(t) => self.type_edge(&node, t, "uses_type"),
                ItemEnum::Function(f) => {
                    for (_, t) in &f.sig.inputs {
                        self.type_edge(&node, t, "takes");
                    }
                    if let Some(out) = &f.sig.output {
                        self.type_edge(&node, out, "returns");
                    }
                }
                ItemEnum::TypeAlias(ta) => self.type_edge(&node, &ta.type_, "aliases"),
                ItemEnum::Static(s) => self.type_edge(&node, &s.type_, "uses_type"),
                ItemEnum::Constant { type_, .. } => self.type_edge(&node, type_, "uses_type"),
                _ => {}
            }
        }

        let impls = std::mem::take(&mut self.impls);
        for (owner, impl_id) in impls {
            if let Some(item) = self.krate.index.get(&impl_id)
                && let ItemEnum::Impl(im) = &item.inner
                && let Some(tr) = &im.trait_
            {
                match self.resolve_id(tr.id) {
                    Some(Resolved::Local(t)) => self.push_edge(&owner, &t, "implements"),
                    Some(Resolved::External { item, krate }) => self.pending.push(Pending {
                        from: owner.clone(),
                        item,
                        krate,
                        rel: "implements",
                    }),
                    None => {}
                }
            }
        }
    }

    fn type_edge(&mut self, node: &str, ty: &Type, rel: &'static str) {
        match self.resolve_type(ty) {
            Some(Resolved::Local(target)) if target != node => self.push_edge(node, &target, rel),
            Some(Resolved::Local(_)) => {} // self-reference; no edge
            Some(Resolved::External { item, krate }) => {
                self.pending.push(Pending {
                    from: node.to_string(),
                    item,
                    krate,
                    rel,
                });
            }
            None => {}
        }
    }

    /// Resolve a type to a node: a local item, or a cross-crate reference (the
    /// specific item in another workspace crate, with its crate node as a
    /// fallback). `None` for primitives, generics, std types, etc.
    fn resolve_type(&self, ty: &Type) -> Option<Resolved> {
        match ty {
            Type::ResolvedPath(path) => self.resolve_id(path.id),
            Type::BorrowedRef { type_, .. } => self.resolve_type(type_),
            Type::Slice(inner) => self.resolve_type(inner),
            Type::Array { type_, .. } => self.resolve_type(type_),
            Type::RawPointer { type_, .. } => self.resolve_type(type_),
            Type::QualifiedPath { self_type, .. } => self.resolve_type(self_type),
            _ => None,
        }
    }

    fn resolve_id(&self, id: Id) -> Option<Resolved> {
        if let Some(node) = self.map.get(&id) {
            return Some(Resolved::Local(node.clone()));
        }
        // External reference: `paths[id].path` is the item's fully-qualified
        // path, beginning with the crate name — resolve to that crate's item.
        let summary = self.krate.paths.get(&id)?;
        let crate_name = summary.path.first()?;
        if !self.workspace_crate_names.contains(&norm(crate_name)) {
            return None;
        }
        let sub = summary.path[1..].join("::");
        let item = if sub.is_empty() {
            crate_id(crate_name)
        } else {
            // Must match the id `walk` gives the target item in its own crate,
            // so use the summary's kind (an external item's kind is known here).
            item_id(crate_name, &sub, itemkind_str(&summary.kind))
        };
        Some(Resolved::External {
            item,
            krate: crate_id(crate_name),
        })
    }

    fn push_edge(&mut self, src: &str, tgt: &str, rel: &'static str) {
        self.edges.push(EdgeSpec {
            src: src.to_string(),
            tgt: tgt.to_string(),
            rel,
        });
    }

    /// Apply collected nodes + local edges to the graph; return the number of
    /// new nodes and the deferred cross-crate references.
    fn apply(self, graph: &mut Graph) -> (usize, Vec<Pending>) {
        let before = graph.node_count();
        for node in self.nodes {
            graph.add_node(node);
        }
        for e in self.edges {
            if graph.contains(&e.src) && graph.contains(&e.tgt) {
                graph.add_edge(e.src, e.tgt, e.rel, None, None);
            }
        }
        (graph.node_count() - before, self.pending)
    }
}

fn kind_str(inner: &ItemEnum) -> Option<&'static str> {
    Some(match inner {
        ItemEnum::Module(_) => "module",
        ItemEnum::Struct(_) => "struct",
        ItemEnum::StructField(_) => "field",
        ItemEnum::Enum(_) => "enum",
        ItemEnum::Variant(_) => "variant",
        ItemEnum::Union(_) => "union",
        ItemEnum::Function(_) => "function",
        ItemEnum::Trait(_) | ItemEnum::TraitAlias(_) => "trait",
        ItemEnum::TypeAlias(_) => "type",
        ItemEnum::Constant { .. } | ItemEnum::AssocConst { .. } => "const",
        ItemEnum::Static(_) => "static",
        ItemEnum::Macro(_) | ItemEnum::ProcMacro(_) => "macro",
        ItemEnum::Primitive(_) | ItemEnum::AssocType { .. } => "type",
        // Imports, extern crate/type: not modelled as nodes.
        _ => return None,
    })
}

/// The id-kind tag for a *referenced* item, from its `paths` summary kind. Must
/// agree with [`kind_str`] for the kinds that are cross-crate reference targets
/// (types and traits) so the deferred edge resolves to the right node id.
fn itemkind_str(k: &rustdoc_types::ItemKind) -> &'static str {
    use rustdoc_types::ItemKind as K;
    match k {
        K::Module => "module",
        K::Struct => "struct",
        K::StructField => "field",
        K::Enum => "enum",
        K::Variant => "variant",
        K::Union => "union",
        K::Function => "function",
        K::Trait | K::TraitAlias => "trait",
        K::TypeAlias => "type",
        K::Constant | K::AssocConst => "const",
        K::Static => "static",
        K::Macro | K::ProcAttribute | K::ProcDerive => "macro",
        K::Primitive | K::AssocType | K::ExternType => "type",
        _ => "item",
    }
}

fn struct_fields(s: &rustdoc_types::Struct) -> Vec<Id> {
    match &s.kind {
        StructKind::Unit => Vec::new(),
        StructKind::Tuple(fields) => fields.iter().flatten().copied().collect(),
        StructKind::Plain { fields, .. } => fields.clone(),
    }
}

fn variant_fields(v: &rustdoc_types::Variant) -> Vec<Id> {
    match &v.kind {
        VariantKind::Plain => Vec::new(),
        VariantKind::Tuple(fields) => fields.iter().flatten().copied().collect(),
        VariantKind::Struct { fields, .. } => fields.clone(),
    }
}

fn span_of(item: &Item) -> (Option<String>, Option<u32>) {
    match &item.span {
        Some(span) => (
            Some(span.filename.to_string_lossy().replace('\\', "/")),
            Some(span.begin.0 as u32),
        ),
        None => (None, None),
    }
}
