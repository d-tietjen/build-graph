//! Layer 2 — the rich symbol/type item graph, from nightly rustdoc JSON.
//!
//! For the selected, doc-enabled workspace libraries we invoke
//! `rustup run <nightly> cargo doc --lib -p <pkg>` with JSON rustdoc flags,
//! parse newly produced `target/doc/<crate>.json` with `rustdoc-types`,
//! and fold the items + their relationships into the graph. Item nodes link up
//! to the Layer-1 crate node, and cross-crate type references resolve to other
//! workspace crate nodes, so the layers form one connected graph.

use std::collections::{HashMap, HashSet};
use std::process::Command;

use anyhow::{Context, Result, bail};
use camino::Utf8Path;
use cargo_metadata::{Metadata, Package, Target};
use rustdoc_types::{Attribute, Crate, Id, Item, ItemEnum, StructKind, Type, VariantKind};

use build_graph::export::{
    ArtifactFreshness, DefinitionIdentity, DefinitionRecord, DefinitionSpan, ExtractionStatus,
    PackageReport, SourcePosition,
};
use build_graph::{Graph, Node, crate_id, item_id, norm};

pub struct ItemLayerResult {
    pub items: usize,
    pub definitions: Vec<DefinitionRecord>,
    pub packages: Vec<PackageReport>,
}

/// Run rustdoc JSON for the selected workspace libraries and add their items.
pub fn add_item_layer(
    graph: &mut Graph,
    meta: &Metadata,
    target_dir: &Utf8Path,
    nightly: Option<&str>,
    packages: &[String],
    release: bool,
    no_derives: bool,
) -> Result<ItemLayerResult> {
    let toolchain = nightly.unwrap_or("nightly");
    add_item_layer_with_doc(graph, meta, target_dir, packages, no_derives, |selected| {
        eprintln!(
            "[build-graph] rich layer: documenting {} crate(s) with {toolchain} (one pass)…",
            selected.len()
        );
        run_doc_json(meta, target_dir, toolchain, selected, release)
    })
}

/// Selected occurrence route: launch the actual Cargo directly, with explicit
/// matching rustc/rustdoc, retaining the original one-pass/freshness behavior.
pub fn add_item_layer_routed(
    graph: &mut Graph,
    meta: &Metadata,
    target_dir: &Utf8Path,
    packages: &[String],
    release: bool,
    no_derives: bool,
    selected: &mut crate::cargo_launch::CargoLaunchSession,
) -> Result<ItemLayerResult> {
    add_item_layer_with_doc(graph, meta, target_dir, packages, no_derives, |packages| {
        let mut command =
            selected_doc_command(meta, target_dir, packages, release, &selected.cargo);
        selected.configure(&mut command, false);
        if selected.has_launch_observer() {
            let mut child = selected.launch(
                command,
                build_graph::compiler_invocation::CargoOperationKind::Docs,
            )?;
            let status = child.wait()?;
            if !status.success() {
                eprintln!(
                    "[build-graph] rich layer: doc build reported errors; ingesting newly produced JSON"
                );
            }
            return Ok(status.success());
        }
        let operation = selected.begin(
            &mut command,
            build_graph::compiler_invocation::CargoOperationKind::Docs,
        )?;
        let status = command.status();
        selected.complete(operation, status.as_ref().ok().copied());
        let status = status.context("failed to run selected Cargo doc")?;
        if !status.success() {
            eprintln!(
                "[build-graph] rich layer: doc build reported errors; ingesting newly produced JSON"
            );
        }
        Ok(status.success())
    })
}

fn add_item_layer_with_doc(
    graph: &mut Graph,
    meta: &Metadata,
    target_dir: &Utf8Path,
    packages: &[String],
    no_derives: bool,
    run_doc: impl FnOnce(&[String]) -> Result<bool>,
) -> Result<ItemLayerResult> {
    let selected = select_lib_packages(meta, packages);
    if selected.is_empty() {
        eprintln!("[build-graph] rich layer: no library targets to document");
        return Ok(ItemLayerResult {
            items: 0,
            definitions: Vec::new(),
            packages: Vec::new(),
        });
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
    // Workspace success alone does not prove that each artifact was produced.
    // Remove retained JSON first so an old artifact can never qualify as output
    // from this invocation.
    for pkg in &selected {
        let path = json_path(target_dir, pkg);
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("removing retained rustdoc JSON {path}"));
            }
        }
    }
    let selected_names: Vec<String> = selected.iter().map(|pkg| pkg.name.clone()).collect();
    let doc_succeeded = run_doc(&selected_names)?;

    let mut total = 0usize;
    let mut done = 0usize;
    let mut pending: Vec<Pending> = Vec::new();
    let mut definitions = Vec::new();
    let mut reports = Vec::new();
    for pkg in selected {
        match ingest_pkg(graph, target_dir, pkg, &workspace_crate_names, no_derives) {
            Ok((added, refs, records)) => {
                total += added;
                done += 1;
                pending.extend(refs);
                definitions.extend(records);
                reports.push(PackageReport {
                    package: pkg.name.clone(),
                    status: if doc_succeeded {
                        ExtractionStatus::Complete
                    } else {
                        ExtractionStatus::Partial
                    },
                    freshness: if doc_succeeded {
                        ArtifactFreshness::Current
                    } else {
                        ArtifactFreshness::Unknown
                    },
                    reason: (!doc_succeeded).then(|| {
                        "cargo doc failed; newly produced JSON has unconfirmed completion".into()
                    }),
                });
            }
            Err(e) => {
                eprintln!("[build-graph] rich layer: skipped {} ({e:#})", pkg.name);
                reports.push(PackageReport {
                    package: pkg.name.clone(),
                    status: ExtractionStatus::Partial,
                    freshness: ArtifactFreshness::Unknown,
                    reason: Some(format!("{e:#}")),
                });
            }
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
    Ok(ItemLayerResult {
        items: total,
        definitions,
        packages: reports,
    })
}

pub fn is_lib_target(t: &Target) -> bool {
    t.kind
        .iter()
        .any(|k| matches!(k.to_string().as_str(), "lib" | "rlib" | "proc-macro"))
}

pub fn is_documented_lib_target(t: &Target) -> bool {
    is_lib_target(t) && t.doc
}

fn select_lib_packages<'a>(meta: &'a Metadata, packages: &[String]) -> Vec<&'a Package> {
    let want: HashSet<&str> = packages.iter().map(|s| s.as_str()).collect();
    meta.workspace_packages()
        .into_iter()
        .filter(|p| want.is_empty() || want.contains(p.name.as_str()))
        .filter(|p| p.targets.iter().any(is_documented_lib_target))
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
) -> Result<(usize, Vec<Pending>, Vec<DefinitionRecord>)> {
    let json_path = json_path(target_dir, pkg);
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
    if !matches!(
        krate.index.get(&krate.root).map(|item| &item.inner),
        Some(ItemEnum::Module(_))
    ) {
        bail!("rustdoc JSON {json_path} has no root module to extract");
    }

    let mut ingest = Ingest::new(&krate, &pkg.name, workspace_crate_names.clone(), no_derives);
    ingest.run(&crate_id(&pkg.name));
    Ok(ingest.apply(graph))
}

fn json_path(target_dir: &Utf8Path, pkg: &Package) -> camino::Utf8PathBuf {
    target_dir
        .join("doc")
        .join(format!("{}.json", lib_crate_name(pkg)))
}

/// Produce rustdoc JSON for all selected crates in a single `cargo doc` pass.
fn run_doc_json(
    meta: &Metadata,
    target_dir: &Utf8Path,
    toolchain: &str,
    packages: &[String],
    release: bool,
) -> Result<bool> {
    let status = doc_command(meta, target_dir, toolchain, packages, release)
        .status()
        .with_context(|| format!("failed to run `rustup run {toolchain} cargo doc`"))?;
    // With `--keep-going`, a non-zero status just means some crates failed to
    // build; we still ingest the JSON that was produced for the rest, with
    // partial status and unknown freshness.
    if !status.success() {
        eprintln!(
            "[build-graph] rich layer: doc build reported errors; ingesting newly produced JSON"
        );
    }
    Ok(status.success())
}

fn doc_command(
    meta: &Metadata,
    target_dir: &Utf8Path,
    toolchain: &str,
    packages: &[String],
    release: bool,
) -> Command {
    let mut cmd = Command::new("rustup");
    cmd.arg("run").arg(toolchain).arg("cargo");
    configure_doc_command(&mut cmd, meta, target_dir, packages, release);
    cmd
}

fn selected_doc_command(
    meta: &Metadata,
    target_dir: &Utf8Path,
    packages: &[String],
    release: bool,
    cargo: &std::path::Path,
) -> Command {
    let mut command = Command::new(cargo);
    configure_doc_command(&mut command, meta, target_dir, packages, release);
    command
}

fn configure_doc_command(
    cmd: &mut Command,
    meta: &Metadata,
    target_dir: &Utf8Path,
    packages: &[String],
    release: bool,
) {
    let manifest = meta.workspace_root.join("Cargo.toml");
    // `--document-private-items`: a code graph needs the *private* helpers too,
    // not just the public API — otherwise references to/from them (most of a
    // codebase) have no node to connect to and `find callers` comes up empty.
    cmd.env(
        "RUSTDOCFLAGS",
        "-Z unstable-options --output-format json --document-private-items",
    )
    .arg("doc")
    .arg("--lib")
    .arg("--no-deps")
    .arg("--keep-going")
    .arg("--manifest-path")
    .arg(manifest.as_str())
    .arg("--target-dir")
    .arg(target_dir.as_str());
    if release {
        cmd.arg("--release");
    }
    for p in packages {
        cmd.arg("-p").arg(p);
    }
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
    definitions: Vec<DefinitionRecord>,
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
            definitions: Vec::new(),
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

        let span = span_of(item);
        let file = span.as_ref().map(|s| s.file.clone());
        let line = span.as_ref().and_then(|s| u32::try_from(s.begin.line).ok());
        self.definitions.push(DefinitionRecord {
            graph_node_id: node_id.clone(),
            identity: DefinitionIdentity {
                package: self.pkg.to_string(),
                def_path: my_path.clone(),
                kind: kind.to_string(),
            },
            span,
        });
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
    fn apply(self, graph: &mut Graph) -> (usize, Vec<Pending>, Vec<DefinitionRecord>) {
        let before = graph.node_count();
        for node in self.nodes {
            graph.add_node(node);
        }
        for e in self.edges {
            if graph.contains(&e.src) && graph.contains(&e.tgt) {
                graph.add_edge(e.src, e.tgt, e.rel, None, None);
            }
        }
        (graph.node_count() - before, self.pending, self.definitions)
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

fn span_of(item: &Item) -> Option<DefinitionSpan> {
    item.span.as_ref().map(definition_span)
}

fn definition_span(span: &rustdoc_types::Span) -> DefinitionSpan {
    DefinitionSpan {
        file: span.filename.to_string_lossy().replace('\\', "/"),
        begin: SourcePosition {
            line: span.begin.0,
            column: span.begin.1,
        },
        end: SourcePosition {
            line: span.end.0,
            column: span.end.1,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::Workspace;

    fn fixture_json(name: &str) -> Vec<u8> {
        let module = |id, name: &str, is_crate, items| Item {
            id,
            crate_id: 0,
            name: Some(name.into()),
            span: None,
            visibility: rustdoc_types::Visibility::Public,
            docs: None,
            links: HashMap::new(),
            attrs: Vec::new(),
            deprecation: None,
            inner: ItemEnum::Module(rustdoc_types::Module {
                is_crate,
                items,
                is_stripped: false,
            }),
        };
        serde_json::to_vec(&Crate {
            root: Id(0),
            crate_version: None,
            includes_private: true,
            index: [
                (Id(0), module(Id(0), "demo", true, vec![Id(1)])),
                (Id(1), module(Id(1), name, false, Vec::new())),
            ]
            .into_iter()
            .collect(),
            paths: HashMap::new(),
            external_crates: HashMap::new(),
            target: rustdoc_types::Target {
                triple: "x86_64-unknown-linux-gnu".into(),
                target_features: Vec::new(),
            },
            format_version: rustdoc_types::FORMAT_VERSION,
        })
        .expect("fixture rustdoc JSON")
    }

    fn retained_json(workspace: &Workspace, package_index: usize) -> camino::Utf8PathBuf {
        let path = json_path(
            &workspace.meta.target_directory,
            &workspace.meta.packages[package_index],
        );
        std::fs::create_dir_all(path.parent().expect("doc directory")).expect("doc directory");
        std::fs::write(&path, fixture_json("OldDefinition")).expect("retained rustdoc JSON");
        path
    }

    #[test]
    fn doc_disabled_library_never_ingests_retained_json() {
        let mut workspace = Workspace::new(&[("demo", "demo")]);
        let path = retained_json(&workspace, 0);
        workspace.disable_docs("demo");
        workspace.change_source("demo", "NewDefinition");
        let mut graph = Graph::new();
        let result = add_item_layer_with_doc(
            &mut graph,
            &workspace.meta,
            &workspace.meta.target_directory,
            &[],
            false,
            |_| panic!("doc-disabled targets must not invoke cargo doc"),
        )
        .expect("skipped library documentation");
        assert_eq!(graph.node_count(), 0);
        assert!(result.definitions.is_empty());
        assert!(result.packages.is_empty());
        assert!(path.exists());
    }

    #[test]
    fn successful_doc_without_new_json_cannot_promote_retained_artifact() {
        let workspace = Workspace::new(&[("demo", "demo")]);
        let path = retained_json(&workspace, 0);
        workspace.change_source("demo", "NewDefinition");
        let mut graph = Graph::new();
        let result = add_item_layer_with_doc(
            &mut graph,
            &workspace.meta,
            &workspace.meta.target_directory,
            &[],
            false,
            |selected| {
                assert_eq!(selected, ["demo"]);
                assert!(!path.exists());
                Ok(true)
            },
        )
        .expect("doc succeeded without an artifact");
        assert_eq!(graph.node_count(), 0);
        assert!(result.definitions.is_empty());
        assert_eq!(result.packages[0].status, ExtractionStatus::Partial);
        assert_eq!(result.packages[0].freshness, ArtifactFreshness::Unknown);
    }

    #[test]
    fn successful_doc_qualifies_only_packages_with_new_json() {
        let workspace = Workspace::new(&[("demo", "demo"), ("missing", "missing")]);
        let produced = retained_json(&workspace, 0);
        let missing = retained_json(&workspace, 1);
        let mut graph = Graph::new();
        let result = add_item_layer_with_doc(
            &mut graph,
            &workspace.meta,
            &workspace.meta.target_directory,
            &[],
            false,
            |_| {
                assert!(!produced.exists());
                assert!(!missing.exists());
                std::fs::write(&produced, fixture_json("NewDefinition"))?;
                Ok(true)
            },
        )
        .expect("one produced JSON file");
        assert_eq!(result.definitions.len(), 1);
        assert_eq!(result.definitions[0].identity.def_path, "NewDefinition");
        assert_eq!(result.packages[0].status, ExtractionStatus::Complete);
        assert_eq!(result.packages[0].freshness, ArtifactFreshness::Current);
        assert_eq!(result.packages[1].status, ExtractionStatus::Partial);
        assert_eq!(result.packages[1].freshness, ArtifactFreshness::Unknown);
        assert!(!graph.contains(&item_id("demo", "OldDefinition", "module")));
    }

    #[test]
    fn failed_doc_keeps_new_json_partial_with_unknown_freshness() {
        let workspace = Workspace::new(&[("demo", "demo")]);
        let path = retained_json(&workspace, 0);
        let result = add_item_layer_with_doc(
            &mut Graph::new(),
            &workspace.meta,
            &workspace.meta.target_directory,
            &[],
            false,
            |_| {
                std::fs::write(&path, fixture_json("NewDefinition"))?;
                Ok(false)
            },
        )
        .expect("partial doc build");
        assert_eq!(result.definitions[0].identity.def_path, "NewDefinition");
        assert_eq!(result.packages[0].status, ExtractionStatus::Partial);
        assert_eq!(result.packages[0].freshness, ArtifactFreshness::Unknown);
    }

    #[test]
    fn doc_command_selects_libraries_and_exact_packages() {
        let workspace = Workspace::new(&[("demo", "demo")]);
        let command = doc_command(
            &workspace.meta,
            &workspace.meta.target_directory,
            "nightly",
            &["demo".into()],
            false,
        );
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_str().expect("UTF-8 argument"))
            .collect();
        assert!(args.contains(&"--lib"));
        assert!(args.windows(2).any(|args| args == ["-p", "demo"]));
        assert!(!args.contains(&"--workspace"));
    }

    #[test]
    fn selected_doc_command_is_direct_and_preserves_original_flags_and_packages() {
        let workspace = Workspace::new(&[("demo", "demo")]);
        let selected = selected_doc_command(
            &workspace.meta,
            &workspace.meta.target_directory,
            &["demo".into()],
            true,
            std::path::Path::new("/selected/cargo"),
        );
        let legacy = doc_command(
            &workspace.meta,
            &workspace.meta.target_directory,
            "nightly",
            &["demo".into()],
            true,
        );
        assert_eq!(selected.get_program(), "/selected/cargo");
        assert_eq!(legacy.get_program(), "rustup");
        assert_eq!(
            selected.get_args().collect::<Vec<_>>(),
            legacy.get_args().skip(3).collect::<Vec<_>>()
        );
        assert_eq!(
            selected.get_envs().collect::<Vec<_>>(),
            legacy.get_envs().collect::<Vec<_>>()
        );
    }

    #[test]
    fn full_definition_span_is_retained() {
        let span = rustdoc_types::Span {
            filename: "src/lib.rs".into(),
            begin: (2, 3),
            end: (9, 17),
        };
        assert_eq!(
            definition_span(&span),
            DefinitionSpan {
                file: "src/lib.rs".into(),
                begin: SourcePosition { line: 2, column: 3 },
                end: SourcePosition {
                    line: 9,
                    column: 17
                },
            }
        );
    }
}
