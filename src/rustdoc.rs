//! Layer 2 — the rich symbol/type item graph, from nightly rustdoc JSON.
//!
//! For selected workspace libraries and binaries we invoke nightly `cargo doc`
//! with JSON output and parse `target/doc/<target>.json` with `rustdoc-types`,
//! and fold the items + their relationships into the graph. Item nodes link up
//! to the Layer-1 crate node, and cross-crate type references resolve to other
//! workspace crate nodes, so the layers form one connected graph.

use std::collections::{HashMap, HashSet};
use std::process::Command;

use anyhow::{Context, Result, bail};
use camino::Utf8Path;
use cargo_metadata::{Metadata, Package, Target};
use rustdoc_types::{
    Attribute, Crate, GenericArg, GenericArgs, Id, Item, ItemEnum, Path, StructKind, Type,
    VariantKind,
};

use crate::comments;
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

/// Run rustdoc JSON for the selected workspace libraries and binaries and add their items.
pub fn add_item_layer(
    graph: &mut Graph,
    meta: &Metadata,
    target_dir: &Utf8Path,
    nightly: Option<&str>,
    packages: &[String],
    release: bool,
    no_derives: bool,
    selected_packages: &[String],
) -> Result<ItemLayerResult> {
    let toolchain = nightly.unwrap_or("nightly");
    add_item_layer_with_doc(
        graph,
        meta,
        target_dir,
        packages,
        no_derives,
        toolchain,
        release,
        selected_packages,
        |dir, packages, targets| run_doc_json(meta, dir, toolchain, packages, release, targets),
    )
}

/// Route documentation through the same selected Cargo as the build.
pub fn add_item_layer_routed(
    graph: &mut Graph,
    meta: &Metadata,
    target_dir: &Utf8Path,
    nightly: Option<&str>,
    packages: &[String],
    release: bool,
    no_derives: bool,
    selected_packages: &[String],
    selected: &mut crate::cargo_launch::CargoLaunchSession,
) -> Result<ItemLayerResult> {
    add_item_layer_with_doc(
        graph,
        meta,
        target_dir,
        packages,
        no_derives,
        nightly.unwrap_or("nightly"),
        release,
        selected_packages,
        |dir, packages, targets| {
            let mut command =
                selected_doc_command(meta, dir, packages, release, &selected.cargo, targets);
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
        },
    )
}

#[derive(Clone, Copy)]
enum DocTargets<'a> {
    Libraries,
    Defaults,
    Exact(&'a Target),
}

fn add_item_layer_with_doc(
    graph: &mut Graph,
    meta: &Metadata,
    target_dir: &Utf8Path,
    packages: &[String],
    no_derives: bool,
    toolchain: &str,
    release: bool,
    selected_packages: &[String],
    mut run_doc: impl FnMut(&Utf8Path, &[String], DocTargets<'_>) -> Result<bool>,
) -> Result<ItemLayerResult> {
    let selected = select_documentable_targets(meta, packages);
    let n = selected.len();
    if n == 0 {
        return Ok(ItemLayerResult {
            items: 0,
            definitions: Vec::new(),
            packages: Vec::new(),
        });
    }
    let workspace_crate_names = meta
        .workspace_packages()
        .iter()
        .map(|p| norm(&p.name))
        .collect();
    let selected_names: Vec<_> = selected
        .iter()
        .map(|(pkg, _)| pkg.name.clone())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    let roots: Vec<_> = selected
        .iter()
        .filter_map(|(pkg, _)| {
            pkg.manifest_path
                .parent()
                .map(|p| p.as_std_path().to_path_buf())
        })
        .collect();
    let sources_before = comments::Before::capture(&roots);
    let before = comments::selected_context(
        meta,
        target_dir.as_std_path(),
        toolchain,
        release,
        selected_packages,
    );

    let mut doc_name_counts = HashMap::<String, usize>::new();
    for (_, target) in select_documentable_targets(meta, &[]) {
        *doc_name_counts
            .entry(doc_name(target).to_lowercase())
            .or_default() += 1;
    }
    for (_, target) in &selected {
        clear_retained_json(&target_doc_path(target_dir, target))?;
    }
    let targets = if selected.iter().any(|(_, target)| is_bin_target(target)) {
        DocTargets::Defaults
    } else {
        DocTargets::Libraries
    };
    eprintln!("[build-graph] rich layer: documenting {n} target(s) with {toolchain}…");
    let started = std::time::SystemTime::now();
    let doc_succeeded = run_doc(target_dir, &selected_names, targets)?;
    let finished = std::time::SystemTime::now();
    let after = comments::selected_context(
        meta,
        target_dir.as_std_path(),
        toolchain,
        release,
        selected_packages,
    );

    let mut total = 0;
    let mut done = 0;
    let mut pending = Vec::<Pending>::new();
    let mut definitions = Vec::new();
    let mut reports = std::collections::BTreeMap::<String, PackageReport>::new();
    for (index, (pkg, target)) in selected.into_iter().enumerate() {
        let mut doc_dir = target_dir.to_path_buf();
        let mut context_current = comments::context_qualified(&before) && before == after;
        let mut succeeded = doc_succeeded;
        let mut window = succeeded.then_some((started, finished));
        if doc_name_counts[&doc_name(target).to_lowercase()] > 1 {
            doc_dir = target_dir.join(format!(
                "build-graph-doc-target-{index}-{}-{}",
                pkg.name, target.name
            ));
            clear_retained_json(&target_doc_path(&doc_dir, target))?;
            let started = std::time::SystemTime::now();
            succeeded = run_doc(
                &doc_dir,
                std::slice::from_ref(&pkg.name),
                DocTargets::Exact(target),
            )?;
            window = succeeded.then(|| (started, std::time::SystemTime::now()));
            context_current &= before
                == comments::selected_context(
                    meta,
                    target_dir.as_std_path(),
                    toolchain,
                    release,
                    selected_packages,
                );
        }
        let result = ingest_pkg(
            graph,
            &doc_dir,
            &meta.workspace_root,
            pkg,
            target,
            &workspace_crate_names,
            no_derives,
            &sources_before,
            window,
            toolchain,
            release,
            &before,
            context_current,
        );
        let reason = match result {
            Ok((added, refs, records)) => {
                total += added;
                done += 1;
                pending.extend(refs);
                definitions.extend(records);
                (!succeeded).then(|| {
                    "cargo doc failed; newly produced JSON has unconfirmed completion".into()
                })
            }
            Err(error) => {
                eprintln!(
                    "[build-graph] rich layer: skipped {}:{} ({error:#})",
                    pkg.name, target.name
                );
                Some(format!("{error:#}"))
            }
        };
        let report = PackageReport {
            package: pkg.name.clone(),
            status: if reason.is_none() {
                ExtractionStatus::Complete
            } else {
                ExtractionStatus::Partial
            },
            freshness: if reason.is_none() {
                ArtifactFreshness::Current
            } else {
                ArtifactFreshness::Unknown
            },
            reason,
        };
        // A package's report stays partial if any selected target was partial.
        if report.status == ExtractionStatus::Partial || !reports.contains_key(&pkg.name) {
            reports.insert(pkg.name.clone(), report);
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
        packages: reports.into_values().collect(),
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

pub fn is_bin_target(t: &Target) -> bool {
    t.kind.iter().any(|k| k.to_string() == "bin")
}

pub fn is_documentable_target(t: &Target) -> bool {
    t.doc && (is_lib_target(t) || is_bin_target(t))
}

fn doc_name(target: &Target) -> String {
    target.name.replace('-', "_")
}

fn select_documentable_targets<'a>(
    meta: &'a Metadata,
    packages: &[String],
) -> Vec<(&'a Package, &'a Target)> {
    let want: HashSet<&str> = packages.iter().map(|s| s.as_str()).collect();
    meta.workspace_packages()
        .into_iter()
        .filter(|p| want.is_empty() || want.contains(p.name.as_str()))
        .flat_map(|p| {
            p.targets
                .iter()
                .filter(|t| is_documentable_target(t))
                .map(move |t| (p, t))
        })
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
    workspace_root: &Utf8Path,
    pkg: &Package,
    target: &Target,
    workspace_crate_names: &HashSet<String>,
    no_derives: bool,
    sources_before: &comments::Before,
    export_window: Option<(std::time::SystemTime, std::time::SystemTime)>,
    toolchain: &str,
    release: bool,
    selected_context: &serde_json::Value,
    context_current: bool,
) -> Result<(usize, Vec<Pending>, Vec<DefinitionRecord>)> {
    let json_path = target_doc_path(target_dir, target);
    let data = std::fs::read_to_string(&json_path).with_context(|| {
        format!("no rustdoc JSON at {json_path} (crate may have failed to build)")
    })?;
    let export_current =
        context_current && comments::artifact_in_window(json_path.as_std_path(), export_window);
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

    let span = krate
        .index
        .get(&krate.root)
        .and_then(|root| root.span.as_ref())
        .with_context(|| format!("rustdoc JSON {json_path} has no root source span"))?;
    let actual = std::fs::canonicalize(workspace_root.as_std_path().join(&span.filename))?;
    let expected = std::fs::canonicalize(target.src_path.as_std_path())?;
    if actual != expected {
        bail!(
            "rustdoc JSON {json_path} describes {}, expected {} for {}:{}",
            span.filename.display(),
            target.src_path,
            pkg.name,
            target.name
        );
    }

    let mut ingest = Ingest::new(&krate, &pkg.name, workspace_crate_names.clone(), no_derives);
    let prefix = if is_bin_target(target) {
        format!("bin::{}", target.name)
    } else {
        String::new()
    };
    ingest.run(&crate_id(&pkg.name), &prefix);
    for node in &mut ingest.nodes {
        node.attributes
            .insert("package_id".into(), pkg.id.repr.clone());
        node.attributes
            .insert("capture_scope".into(), "workspace".into());
        if let Some(file) = &node.source_file {
            node.attributes.insert(
                "source_absolute".into(),
                workspace_root.join(file).to_string(),
            );
        }
        node.attributes
            .insert("target_name".into(), target.name.clone());
        node.attributes
            .insert("target_kind".into(), serde_json::to_string(&target.kind)?);
        node.attributes
            .insert("target_src_path".into(), target.src_path.to_string());
    }
    let target_scope =
        serde_json::json!({"name":target.name,"kind":target.kind,"source":target.src_path});
    let declarations = comment_declarations(
        &krate,
        &ingest,
        &pkg.id.repr,
        &target_scope,
        &crate_id(&pkg.name),
    );
    let result = ingest.apply(graph);
    comments::attach(
        graph,
        workspace_root.as_std_path(),
        sources_before,
        declarations,
        &pkg.name,
        &pkg.id.repr,
        target_scope,
        &comments::sha(data.as_bytes()),
        serde_json::json!({"toolchainSelection":toolchain,"release":release,"selectedContext":selected_context,"contextStable":context_current,"packageId":pkg.id.repr,"target":target.name,"exportItemCount":krate.index.len(),"exportDocumentationCount":krate.index.values().filter(|item|item.docs.is_some()).count(),"declarationLimit":10000,"artifactPath":json_path,"coordinateProducerReference":"rust-lang/rust@6a979b3e32522049d0acb4a47f7ae44b7c8abfd5; conversions.rs lo/hi CharPos+1; normalized source","sourceObservation":"pre/post local; not hermetic compiler input proof"}),
        export_current,
    );
    Ok(result)
}

/// Original compiler IDs and walk-owned paths remain separate from normalized
/// graph IDs. This is intentionally called before Graph::add_node merges nodes.
fn comment_declarations(
    krate: &Crate,
    ingest: &Ingest<'_>,
    package_id: &str,
    target_scope: &serde_json::Value,
    crate_node: &str,
) -> Vec<comments::Declaration> {
    let mut declarations = Vec::new();
    let mut documentation_bytes = 0usize;
    let mut originals: Vec<_> = krate
        .index
        .iter()
        .filter(|(_, item)| item.crate_id == 0)
        .collect();
    originals.sort_by_key(|(id, _)| id.0);
    for (id, item) in originals.into_iter().take(10_000) {
        let Some(kind) = ingest
            .original_kinds
            .get(id)
            .map(String::as_str)
            .or_else(|| kind_str(&item.inner))
        else {
            continue;
        };
        let graph_node_id = if *id == krate.root {
            Some(crate_node.to_string())
        } else {
            ingest.map.get(id).cloned()
        };
        let path = (if *id == krate.root {
            target_scope["name"].as_str().map(str::to_owned)
        } else {
            ingest.original_paths.get(id).cloned()
        })
        .or_else(|| krate.paths.get(id).map(|p| p.path.join("::")))
        .unwrap_or_else(|| format!("original:{}", id.0));
        let occurrence_id = comments::sha(
            serde_json::json!([package_id, target_scope, id.0, path, kind])
                .to_string()
                .as_bytes(),
        );
        declarations.push(comments::Declaration { occurrence_id, original_id: id.0.to_string(), name:item.name.clone(),coordinate_encoding:"one-based-line/one-based-unicode-scalar-column; end-exclusive; normalized compiler source", graph_node_id, path, kind:kind.into(),
            file:item.span.as_ref().map(|s|s.filename.to_string_lossy().replace('\\',"/")),
            begin:item.span.as_ref().map(|s|s.begin), end:item.span.as_ref().map(|s|s.end), docs:item.docs.as_ref().filter(|text|{documentation_bytes=documentation_bytes.saturating_add(text.len());text.len()<=65536&&documentation_bytes<=8*1024*1024}).cloned(),
            has_body:matches!(&item.inner,ItemEnum::Function(f) if f.has_body) });
    }
    declarations
}

fn target_doc_path(target_dir: &Utf8Path, target: &Target) -> camino::Utf8PathBuf {
    target_dir
        .join("doc")
        .join(format!("{}.json", doc_name(target)))
}

fn clear_retained_json(path: &Utf8Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => {
            Err(error).with_context(|| format!("removing retained rustdoc JSON at {path}"))
        }
    }
}

/// Produce rustdoc JSON for all selected crates in a single `cargo doc` pass.
fn run_doc_json(
    meta: &Metadata,
    target_dir: &Utf8Path,
    toolchain: &str,
    packages: &[String],
    release: bool,
    targets: DocTargets<'_>,
) -> Result<bool> {
    let status = doc_command(meta, target_dir, toolchain, packages, release, targets)
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
    targets: DocTargets<'_>,
) -> Command {
    let mut cmd = Command::new("rustup");
    cmd.arg("run").arg(toolchain).arg("cargo");
    configure_doc_command(&mut cmd, meta, target_dir, packages, release, targets);
    cmd
}

fn selected_doc_command(
    meta: &Metadata,
    target_dir: &Utf8Path,
    packages: &[String],
    release: bool,
    cargo: &std::path::Path,
    targets: DocTargets<'_>,
) -> Command {
    let mut command = Command::new(cargo);
    configure_doc_command(&mut command, meta, target_dir, packages, release, targets);
    command
}

fn configure_doc_command(
    cmd: &mut Command,
    meta: &Metadata,
    target_dir: &Utf8Path,
    packages: &[String],
    release: bool,
    targets: DocTargets<'_>,
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
    .arg("--no-deps")
    .arg("--keep-going")
    .arg("--manifest-path")
    .arg(manifest.as_str())
    .arg("--target-dir")
    .arg(target_dir.as_str());
    match targets {
        DocTargets::Defaults => {}
        DocTargets::Exact(target) if is_bin_target(target) => {
            cmd.args(["--bin", &target.name]);
        }
        _ => {
            cmd.arg("--lib");
        }
    }
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
    original_paths: HashMap<Id, String>,
    original_kinds: HashMap<Id, String>,
    tuple_field_ordinals: HashMap<Id, usize>,
    public_items: HashSet<Id>,
    has_glob_exports: bool,
    nodes: Vec<Node>,
    definitions: Vec<DefinitionRecord>,
    edges: Vec<EdgeSpec>,
    /// (actual impl Self id, impl item id) for the type pass.
    impls: Vec<(Id, Id)>,
    /// Associated items whose local Self is walked after their impl list.
    pending_owner_edges: Vec<(Id, String, &'static str)>,
    /// Cross-crate references, resolved globally after all crates are ingested.
    pending: Vec<Pending>,
    /// Skip `#[automatically_derived]` impls (their `implements` edge + methods).
    no_derives: bool,
}

impl<'a> Ingest<'a> {
    fn path_name(&self, path: &Path) -> Option<String> {
        self.krate
            .paths
            .get(&path.id)
            .map(|summary| summary.path.join("::"))
            .filter(|name| !name.is_empty())
    }

    fn type_name(&self, ty: &Type) -> Option<String> {
        match ty {
            Type::ResolvedPath(path) => Some(format!(
                "{}{}",
                self.path_name(path)?,
                self.generic_args(path.args.as_deref())?
            )),
            Type::Generic(name) | Type::Primitive(name) => Some(name.clone()),
            Type::BorrowedRef {
                lifetime,
                is_mutable,
                type_,
            } if lifetime
                .as_deref()
                .is_none_or(|name| name.starts_with('\'')) =>
            {
                Some(format!(
                    "&{} {}{}",
                    lifetime.as_deref().unwrap_or("'_"),
                    if *is_mutable { "mut " } else { "" },
                    self.type_name(type_)?
                ))
            }
            Type::RawPointer { is_mutable, type_ } => Some(format!(
                "*{} {}",
                if *is_mutable { "mut" } else { "const" },
                self.type_name(type_)?
            )),
            Type::Slice(type_) => Some(format!("[{}]", self.type_name(type_)?)),
            Type::Tuple(types) => Some(format!(
                "({})",
                types
                    .iter()
                    .map(|ty| self.type_name(ty))
                    .collect::<Option<Vec<_>>>()?
                    .join(", ")
            )),
            // No guessed identity for opaque or unresolved shapes.
            _ => None,
        }
    }

    fn generic_args(&self, args: Option<&GenericArgs>) -> Option<String> {
        let Some(args) = args else {
            return Some(String::new());
        };
        let GenericArgs::AngleBracketed { args, constraints } = args else {
            return None;
        };
        if !constraints.is_empty() {
            return None;
        }
        let rendered = args
            .iter()
            .map(|arg| match arg {
                GenericArg::Lifetime(name) if name.starts_with('\'') => Some(name.clone()),
                GenericArg::Lifetime(_) => None,
                GenericArg::Type(ty) => self.type_name(ty),
                GenericArg::Const(value)
                    if !value.is_literal
                        && value.value.is_none()
                        && value
                            .expr
                            .chars()
                            .next()
                            .is_some_and(|ch| ch.is_ascii_alphabetic() || ch == '_')
                        && value
                            .expr
                            .chars()
                            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_') =>
                {
                    Some(format!("const {}", value.expr))
                }
                GenericArg::Const(_) => None,
                GenericArg::Infer => None,
            })
            .collect::<Option<Vec<_>>>()?;
        if rendered.is_empty() {
            Some(String::new())
        } else {
            Some(format!("<{}>", rendered.join(", ")))
        }
    }

    fn trait_name(&self, trait_: &Path) -> Option<String> {
        Some(format!(
            "{}{}",
            self.path_name(trait_)?,
            self.generic_args(trait_.args.as_deref())?
        ))
    }

    fn new(
        krate: &'a Crate,
        pkg: &'a str,
        workspace_crate_names: HashSet<String>,
        no_derives: bool,
    ) -> Self {
        // Index original tuple slots once so named fields do not scan the crate.
        let mut tuple_field_ordinals = HashMap::new();
        for parent in krate.index.values() {
            let fields = match &parent.inner {
                ItemEnum::Struct(s) => match &s.kind {
                    StructKind::Tuple(fields) => fields,
                    _ => continue,
                },
                ItemEnum::Variant(v) => match &v.kind {
                    VariantKind::Tuple(fields) => fields,
                    _ => continue,
                },
                _ => continue,
            };
            for (ordinal, field) in fields.iter().enumerate() {
                if let Some(field) = field {
                    tuple_field_ordinals.entry(*field).or_insert(ordinal);
                }
            }
        }
        Ingest {
            krate,
            pkg,
            workspace_crate_names,
            map: HashMap::new(),
            original_paths: HashMap::new(),
            original_kinds: HashMap::new(),
            tuple_field_ordinals,
            public_items: externally_visible_items(krate),
            has_glob_exports: krate.index.values().any(|item| {
                matches!(item.visibility, rustdoc_types::Visibility::Public)
                    && matches!(&item.inner, ItemEnum::Use(use_) if use_.is_glob)
            }),
            nodes: Vec::new(),
            definitions: Vec::new(),
            edges: Vec::new(),
            impls: Vec::new(),
            pending_owner_edges: Vec::new(),
            pending: Vec::new(),
            no_derives,
        }
    }

    fn run(&mut self, crate_node_id: &str, prefix: &str) {
        if let Some(root) = self.krate.index.get(&self.krate.root) {
            if let ItemEnum::Module(m) = &root.inner {
                for child in &m.items {
                    if let Some(node) = self.walk(*child, prefix, None) {
                        self.edges.push(EdgeSpec {
                            src: crate_node_id.to_string(),
                            tgt: node,
                            rel: "contains",
                        });
                    }
                }
            }
        }
        self.type_pass();
    }

    /// Create a node for `id` (and its children) under `prefix`. Returns the
    /// node id, or `None` for kinds we don't model (use/extern crate/…).
    fn walk(&mut self, id: Id, prefix: &str, force_kind: Option<&'static str>) -> Option<String> {
        self.walk_with_identity(id, prefix, force_kind, None)
    }

    fn walk_with_identity(
        &mut self,
        id: Id,
        prefix: &str,
        force_kind: Option<&'static str>,
        impl_identity: Option<&str>,
    ) -> Option<String> {
        if let Some(existing) = self.map.get(&id) {
            return Some(existing.clone());
        }
        let item = self.krate.index.get(&id)?;
        // Rustdoc may name tuple fields with their numeric ordinals. The
        // original parent's slots (including stripped fields) own the path.
        let tuple_field_name = if matches!(item.inner, ItemEnum::StructField(_)) {
            self.tuple_field_ordinals
                .get(&id)
                .map(|ordinal| format!("tuple_field_{ordinal}"))
        } else {
            None
        };
        let name = tuple_field_name.or_else(|| item.name.clone())?;
        let kind = force_kind.or_else(|| kind_str(&item.inner))?;

        let my_path = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}::{name}")
        };
        let mut node_id = item_id(self.pkg, &my_path, kind);
        if impl_identity.is_some() {
            // `item_id` normalizes case and punctuation. Encoding the original
            // canonical identity bytes keeps distinct legal generic arguments
            // distinct even when their normalized display paths collide.
            node_id.push_str("__impl_");
            for byte in my_path.as_bytes() {
                node_id.push_str(&format!("{byte:02x}"));
            }
        }
        self.original_paths.insert(id, my_path.clone());
        self.original_kinds.insert(id, kind.into());
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
        let mut node = Node::new(node_id.clone(), name, kind)
            .with_source(file, line)
            .attr("crate", self.pkg.to_string())
            .attr("path", my_path.clone());
        node = node
            .attr(
                "declaration_visibility",
                match &item.visibility {
                    rustdoc_types::Visibility::Public => "public",
                    rustdoc_types::Visibility::Crate => "crate",
                    rustdoc_types::Visibility::Restricted { .. } => "restricted",
                    rustdoc_types::Visibility::Default => "default",
                },
            )
            .attr(
                "external_visibility",
                if self.public_items.contains(&id) {
                    "public"
                } else if impl_identity.is_some() || self.has_glob_exports {
                    // Trait accessibility and concrete Self accessibility need a joint
                    // proof; a public declaration alone does not provide it.
                    "unknown"
                } else {
                    "private"
                },
            );
        if let ItemEnum::Function(function) = &item.inner {
            let root_function = self.krate.index.get(&self.krate.root).is_some_and(|root| {
                matches!(&root.inner, ItemEnum::Module(module) if module.items.contains(&id))
            });
            node = node
                .attr("rustdoc_root_function", root_function.to_string())
                .attr("has_body", function.has_body.to_string())
                .attr(
                    "function_abi",
                    serde_json::to_string(&function.header.abi).unwrap(),
                );
            for attribute in &item.attrs {
                match attribute {
                    Attribute::ExportName(symbol) => {
                        node = node.attr("export_symbol", symbol.clone());
                    }
                    Attribute::NoMangle => {
                        node = node.attr("export_symbol", item.name.clone().unwrap_or_default());
                    }
                    _ => {}
                }
            }
        }
        self.nodes.push(node);

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
                let mut normalized_names = HashMap::new();
                for assoc in &t.items {
                    if let Some(name) = self
                        .krate
                        .index
                        .get(assoc)
                        .and_then(|item| item.name.as_ref())
                    {
                        *normalized_names.entry(norm(name)).or_insert(0usize) += 1;
                    }
                }
                for assoc in &t.items {
                    let Some((kind, relation)) = self
                        .krate
                        .index
                        .get(assoc)
                        .and_then(|item| associated_kind_relation(&item.inner))
                    else {
                        continue;
                    };
                    let colliding = self
                        .krate
                        .index
                        .get(assoc)
                        .and_then(|item| item.name.as_ref())
                        .is_some_and(|name| {
                            normalized_names.get(&norm(name)).copied().unwrap_or(0) > 1
                        });
                    if let Some(an) = self.walk_with_identity(
                        *assoc,
                        &my_path,
                        Some(kind),
                        colliding.then_some(my_path.as_str()),
                    ) {
                        self.push_edge(&node_id, &an, relation);
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
        let self_path = self.type_name(&im.for_);
        let actual_self_id = match &im.for_ {
            Type::ResolvedPath(path) => Some(path.id),
            _ => None,
        };
        let actual_owner = match &im.for_ {
            Type::ResolvedPath(path) => self.map.get(&path.id).cloned(),
            _ if im.trait_.is_none() => Some(owner_node.to_string()),
            _ => None,
        };
        let trait_name = im.trait_.as_ref().and_then(|tr| self.trait_name(tr));
        let bin_prefix = owner_path
            .strip_prefix("bin::")
            .and_then(|tail| tail.split_once("::"))
            .map(|(target, _)| format!("bin::{target}::"))
            .unwrap_or_default();
        for assoc in &im.items {
            let Some((kind, relation)) = self
                .krate
                .index
                .get(assoc)
                .and_then(|item| associated_kind_relation(&item.inner))
            else {
                continue;
            };
            // The impl list of a source type can include conversions whose
            // `for` type is elsewhere. Only the resolved impl Self owns these
            // associated items. Trait-qualified identity also keeps methods
            // with the same name from distinct impls separate.
            let qualified = self_path.as_ref().zip(trait_name.as_ref());
            let prefix = qualified
                .map(|(self_path, trait_name)| format!("{bin_prefix}<{self_path} as {trait_name}>"))
                .unwrap_or_else(|| owner_path.to_string());
            let identity =
                qualified.map(|(self_path, trait_name)| format!("{self_path} as {trait_name}"));
            if let Some(mn) =
                self.walk_with_identity(*assoc, &prefix, Some(kind), identity.as_deref())
            {
                if let Some((self_path, trait_name)) = qualified {
                    if let Some(node) = self.nodes.iter_mut().find(|node| node.id == mn) {
                        node.attributes
                            .insert("impl_self".into(), self_path.clone());
                        node.attributes
                            .insert("impl_trait".into(), trait_name.clone());
                    }
                }
                if let Some(actual_owner) = &actual_owner {
                    self.push_edge(actual_owner, &mn, relation);
                } else if let Some(self_id) = actual_self_id {
                    self.pending_owner_edges.push((self_id, mn, relation));
                }
            }
        }
        // `implements` is resolved in the type pass (the trait node may not be
        // walked yet at this point).
        if im.trait_.is_some() {
            if let Some(self_id) = actual_self_id {
                self.impls.push((self_id, impl_id));
            }
        }
    }

    fn type_pass(&mut self) {
        for (self_id, item, relation) in std::mem::take(&mut self.pending_owner_edges) {
            if let Some(owner) = self.map.get(&self_id).cloned() {
                self.push_edge(&owner, &item, relation);
            }
        }
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
        for (self_id, impl_id) in impls {
            let Some(owner) = self.map.get(&self_id).cloned() else {
                continue;
            };
            if let Some(item) = self.krate.index.get(&impl_id) {
                if let ItemEnum::Impl(im) = &item.inner {
                    if let Some(tr) = &im.trait_ {
                        match self.resolve_id(tr.id) {
                            Some(Resolved::Local(t)) => self.push_edge(&owner, &t, "implements"),
                            Some(Resolved::External { item, krate }) => {
                                self.pending.push(Pending {
                                    from: owner.clone(),
                                    item,
                                    krate,
                                    rel: "implements",
                                })
                            }
                            None => {}
                        }
                    }
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

fn associated_kind_relation(inner: &ItemEnum) -> Option<(&'static str, &'static str)> {
    match inner {
        ItemEnum::Function(_) => Some(("method", "has_method")),
        ItemEnum::AssocConst { .. } => Some(("const", "has_const")),
        ItemEnum::AssocType { .. } => Some(("type", "has_type")),
        _ => None,
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
mod export_tests {
    use super::*;
    use crate::test_support::Workspace;

    fn fixture_json(name: &str, target: &Target) -> Vec<u8> {
        let module = |id, name: &str, is_crate: bool, items| Item {
            id,
            crate_id: 0,
            name: Some(name.into()),
            span: is_crate.then(|| rustdoc_types::Span {
                filename: target.src_path.clone().into_std_path_buf(),
                begin: (1, 1),
                end: (1, 2),
            }),
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
        let target = &workspace.meta.packages[package_index].targets[0];
        let path = target_doc_path(&workspace.meta.target_directory, target);
        std::fs::create_dir_all(path.parent().expect("doc directory")).expect("doc directory");
        std::fs::write(&path, fixture_json("OldDefinition", target))
            .expect("retained rustdoc JSON");
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
            "nightly",
            false,
            &[],
            |_, _, _| panic!("doc-disabled targets must not invoke cargo doc"),
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
            "nightly",
            false,
            &[],
            |_, selected, _| {
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
            "nightly",
            false,
            &[],
            |_, _, _| {
                assert!(!produced.exists());
                assert!(!missing.exists());
                std::fs::write(
                    &produced,
                    fixture_json("NewDefinition", &workspace.meta.packages[0].targets[0]),
                )?;
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
            "nightly",
            false,
            &[],
            |_, _, _| {
                std::fs::write(
                    &path,
                    fixture_json("NewDefinition", &workspace.meta.packages[0].targets[0]),
                )?;
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
            DocTargets::Libraries,
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
            DocTargets::Libraries,
        );
        let legacy = doc_command(
            &workspace.meta,
            &workspace.meta.target_directory,
            "nightly",
            &["demo".into()],
            true,
            DocTargets::Libraries,
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

/// Named public module paths and explicit local re-exports establish declaration
/// accessibility. This says nothing about invocation or dynamic symbol linkage.
/// Glob re-exports and trait implementations remain conservative candidates.
fn externally_visible_items(krate: &Crate) -> HashSet<Id> {
    let mut exposed = HashSet::new();
    let mut queue = vec![krate.root];
    let mut index = 0;
    while index < queue.len() {
        let id = queue[index];
        index += 1;
        if !exposed.insert(id) {
            continue;
        }
        let Some(item) = krate.index.get(&id) else {
            continue;
        };
        let mut children: Vec<Id> = Vec::new();
        let mut impls: Vec<Id> = Vec::new();
        match &item.inner {
            ItemEnum::Module(module) => children.extend(&module.items),
            ItemEnum::Trait(trait_) => {
                // Trait associated items inherit the public trait's visibility.
                queue.extend(&trait_.items);
            }
            ItemEnum::Struct(struct_) => impls.extend(&struct_.impls),
            ItemEnum::Enum(enum_) => impls.extend(&enum_.impls),
            ItemEnum::Union(union_) => impls.extend(&union_.impls),
            ItemEnum::Use(use_) if !use_.is_glob => queue.extend(use_.id),
            _ => {}
        }
        for impl_id in impls {
            if let Some(Item {
                inner: ItemEnum::Impl(implementation),
                ..
            }) = krate.index.get(&impl_id)
                && implementation.trait_.is_none()
                && matches!(&implementation.for_, Type::ResolvedPath(path) if path.id == id)
            {
                children.extend(&implementation.items);
            }
        }
        queue.extend(children.into_iter().filter(|child| {
            krate
                .index
                .get(child)
                .is_some_and(|item| matches!(item.visibility, rustdoc_types::Visibility::Public))
        }));
    }
    exposed
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, HashSet};

    use build_graph::{Graph, Node, crate_id, item_id};
    use rustdoc_types::{
        Abi, Crate, Enum, Function, FunctionHeader, FunctionSignature, GenericArg, GenericArgs,
        Generics, Id, Impl, Item, ItemEnum, ItemKind, ItemSummary, Module, Path, Struct,
        StructKind, Target, Trait, Type, Variant, VariantKind, Visibility,
    };

    use super::Ingest;

    fn generics() -> Generics {
        Generics {
            params: Vec::new(),
            where_predicates: Vec::new(),
        }
    }

    fn item(id: u32, name: Option<&str>, inner: ItemEnum) -> Item {
        Item {
            id: Id(id),
            crate_id: 0,
            name: name.map(str::to_string),
            // Macro-expanded associated items often have no rustdoc span.
            span: None,
            visibility: Visibility::Public,
            docs: None,
            links: HashMap::new(),
            attrs: Vec::new(),
            deprecation: None,
            inner,
        }
    }

    fn method(has_body: bool) -> ItemEnum {
        ItemEnum::Function(Function {
            sig: FunctionSignature {
                inputs: Vec::new(),
                output: None,
                is_c_variadic: false,
            },
            generics: generics(),
            header: FunctionHeader {
                is_const: false,
                is_unsafe: false,
                is_async: false,
                abi: Abi::Rust,
            },
            has_body,
        })
    }

    #[test]
    fn comment_occurrences_preserve_roots_tuple_gaps_and_normalization_collisions() {
        let mut index = HashMap::new();
        index.insert(
            Id(0),
            item(
                0,
                Some("fixture"),
                ItemEnum::Module(Module {
                    is_crate: true,
                    items: vec![Id(1), Id(2), Id(5), Id(8), Id(10)],
                    is_stripped: false,
                }),
            ),
        );
        index.insert(Id(1), item(1, Some("Run"), method(true)));
        index.insert(Id(2), item(2, Some("run"), method(true)));
        index.insert(
            Id(5),
            item(
                5,
                Some("Tuple"),
                ItemEnum::Struct(Struct {
                    kind: StructKind::Tuple(vec![Some(Id(6)), None, Some(Id(7)), Some(Id(17))]),
                    generics: generics(),
                    impls: vec![],
                }),
            ),
        );
        index.insert(
            Id(6),
            item(
                6,
                Some("0"),
                ItemEnum::StructField(Type::Primitive("u8".into())),
            ),
        );
        index.insert(
            Id(7),
            item(
                7,
                Some("2"),
                ItemEnum::StructField(Type::Primitive("u16".into())),
            ),
        );
        index.insert(
            Id(8),
            item(
                8,
                Some("Named"),
                ItemEnum::Struct(Struct {
                    kind: StructKind::Plain {
                        fields: vec![Id(9)],
                        has_stripped_fields: false,
                    },
                    generics: generics(),
                    impls: vec![],
                }),
            ),
        );
        index.insert(
            Id(10),
            item(
                10,
                Some("Choice"),
                ItemEnum::Enum(Enum {
                    generics: generics(),
                    has_stripped_variants: false,
                    variants: vec![Id(11), Id(14)],
                    impls: vec![],
                }),
            ),
        );
        index.insert(
            Id(11),
            item(
                11,
                Some("Tuple"),
                ItemEnum::Variant(Variant {
                    kind: VariantKind::Tuple(vec![Some(Id(12)), None, Some(Id(13)), Some(Id(18))]),
                    discriminant: None,
                }),
            ),
        );
        index.insert(
            Id(14),
            item(
                14,
                Some("Record"),
                ItemEnum::Variant(Variant {
                    kind: VariantKind::Struct {
                        fields: vec![Id(15)],
                        has_stripped_fields: false,
                    },
                    discriminant: None,
                }),
            ),
        );
        for (id, name) in [
            (9, Some("channel")),
            (12, Some("0")),
            (13, Some("2")),
            (15, Some("value")),
            (17, None),
            (18, None),
        ] {
            index.insert(
                Id(id),
                item(
                    id,
                    name,
                    ItemEnum::StructField(Type::Primitive("u8".into())),
                ),
            );
        }
        for (id, i) in &mut index {
            i.docs = Some(format!("original docs {}", id.0));
        }
        let krate = Crate {
            root: Id(0),
            crate_version: None,
            includes_private: true,
            index,
            paths: HashMap::new(),
            external_crates: HashMap::new(),
            target: Target {
                triple: "fixture".into(),
                target_features: vec![],
            },
            format_version: rustdoc_types::FORMAT_VERSION,
        };
        let mut ingest = Ingest::new(&krate, "fixture", HashSet::new(), false);
        ingest.run(&crate_id("fixture"), "");
        let scope = serde_json::json!({"name":"fixture","kind":["lib"]});
        let rows = super::comment_declarations(
            &krate,
            &ingest,
            "exact-package-id",
            &scope,
            &crate_id("fixture"),
        );
        let row = |id: &str| rows.iter().find(|d| d.original_id == id).unwrap();
        assert_eq!(row("0").graph_node_id, Some(crate_id("fixture")));
        assert_eq!(row("1").graph_node_id, row("2").graph_node_id);
        assert_ne!(row("1").occurrence_id, row("2").occurrence_id);
        assert_eq!(row("1").path, "Run");
        assert_eq!(row("2").path, "run");
        assert_eq!(row("6").path, "Tuple::tuple_field_0");
        assert_eq!(row("7").path, "Tuple::tuple_field_2");
        assert_eq!(row("17").path, "Tuple::tuple_field_3");
        assert_eq!(row("12").path, "Choice::Tuple::tuple_field_0");
        assert_eq!(row("13").path, "Choice::Tuple::tuple_field_2");
        assert_eq!(row("18").path, "Choice::Tuple::tuple_field_3");
        assert_eq!(row("9").path, "Named::channel");
        assert_eq!(row("15").path, "Choice::Record::value");
        assert_eq!(row("7").name.as_deref(), Some("2"));
        assert_eq!(row("13").name.as_deref(), Some("2"));
        for id in ["6", "7", "9", "12", "13", "15", "17", "18"] {
            let field = row(id);
            assert_eq!(
                field.graph_node_id,
                Some(item_id("fixture", &field.path, "field"))
            );
        }
        assert_eq!(row("7").docs.as_deref(), Some("original docs 7"));
        let other = super::comment_declarations(
            &krate,
            &ingest,
            "different-package-id",
            &scope,
            &crate_id("fixture"),
        );
        assert_ne!(rows[0].occurrence_id, other[0].occurrence_id);
        let other_target = super::comment_declarations(
            &krate,
            &ingest,
            "exact-package-id",
            &serde_json::json!({"name":"fixture","kind":["bin"]}),
            &crate_id("fixture"),
        );
        assert_ne!(rows[0].occurrence_id, other_target[0].occurrence_id);
    }

    #[test]
    fn entry_metadata_distinguishes_public_paths_private_modules_and_abi_declarations() {
        let mut index = HashMap::new();
        index.insert(
            Id(0),
            item(
                0,
                Some("fixture"),
                ItemEnum::Module(Module {
                    is_crate: true,
                    items: vec![Id(1), Id(2), Id(4), Id(5), Id(7)],
                    is_stripped: false,
                }),
            ),
        );
        index.insert(Id(1), item(1, Some("unused_public_api"), method(true)));
        let mut private_module = item(
            2,
            Some("private"),
            ItemEnum::Module(Module {
                is_crate: false,
                items: vec![Id(3), Id(6)],
                is_stripped: false,
            }),
        );
        private_module.visibility = Visibility::Default;
        index.insert(Id(2), private_module);
        index.insert(Id(3), item(3, Some("public_in_private"), method(true)));
        index.insert(Id(6), item(6, Some("publicly_reexported"), method(true)));
        index.insert(
            Id(7),
            item(
                7,
                Some("exposed_alias"),
                ItemEnum::Use(rustdoc_types::Use {
                    source: "private::publicly_reexported".into(),
                    name: "exposed_alias".into(),
                    id: Some(Id(6)),
                    is_glob: false,
                }),
            ),
        );
        for (id, has_body) in [(4, false), (5, true)] {
            let mut function = method(has_body);
            if let ItemEnum::Function(function) = &mut function {
                function.header.abi = Abi::C { unwind: false };
            }
            let mut declaration = item(
                id,
                Some(if has_body {
                    "exported_entry"
                } else {
                    "foreign_declaration"
                }),
                function,
            );
            if has_body {
                declaration.attrs.push(rustdoc_types::Attribute::ExportName(
                    "external_entry".into(),
                ));
            }
            index.insert(Id(id), declaration);
        }
        let krate = Crate {
            root: Id(0),
            crate_version: None,
            includes_private: true,
            index,
            paths: HashMap::new(),
            external_crates: HashMap::new(),
            target: Target {
                triple: "fixture-target".into(),
                target_features: Vec::new(),
            },
            format_version: rustdoc_types::FORMAT_VERSION,
        };
        let mut ingest = Ingest::new(&krate, "fixture", HashSet::new(), false);
        ingest.run("crate_fixture", "");
        let public = ingest
            .nodes
            .iter()
            .find(|n| n.label == "unused_public_api")
            .unwrap();
        assert_eq!(public.attributes["declaration_visibility"], "public");
        assert_eq!(public.attributes["external_visibility"], "public");
        assert_eq!(public.attributes["rustdoc_root_function"], "true");
        let private = ingest
            .nodes
            .iter()
            .find(|n| n.label == "public_in_private")
            .unwrap();
        assert_eq!(private.attributes["declaration_visibility"], "public");
        assert_eq!(private.attributes["external_visibility"], "private");
        assert_eq!(private.attributes["rustdoc_root_function"], "false");
        let reexported = ingest
            .nodes
            .iter()
            .find(|n| n.label == "publicly_reexported")
            .unwrap();
        assert_eq!(reexported.attributes["external_visibility"], "public");
        let foreign = ingest
            .nodes
            .iter()
            .find(|n| n.label == "foreign_declaration")
            .unwrap();
        assert_eq!(foreign.attributes["has_body"], "false");
        assert!(!foreign.attributes.contains_key("export_symbol"));
        assert_eq!(
            foreign.attributes["function_abi"],
            serde_json::to_string(&Abi::C { unwind: false }).unwrap()
        );
        let exported = ingest
            .nodes
            .iter()
            .find(|n| n.label == "exported_entry")
            .unwrap();
        assert_eq!(exported.attributes["has_body"], "true");
        assert_eq!(exported.attributes["export_symbol"], "external_entry");
        // The declarative adapter payload uses the same string attributes as
        // declaration metadata, so GraphJson and cache serialization retain it.
        let manifest =
            r#"{"schemaVersion":1,"adapters":[{"id":"fixture","version":"1","entries":[]}]}"#;
        let mut graph = Graph::new();
        graph.add_node(exported.clone().attr("entry_effects", manifest));
        let serialized = serde_json::to_string(&graph.into_doc()).unwrap();
        let restored: build_graph::graph::GraphJson = serde_json::from_str(&serialized).unwrap();
        assert_eq!(restored.nodes[0].attributes["entry_effects"], manifest);
        assert_eq!(
            restored.nodes[0].attributes["external_visibility"],
            "public"
        );
    }

    #[test]
    fn trait_impl_methods_have_distinct_canonical_identities_and_actual_owners() {
        let summary = |kind, parts: &[&str]| ItemSummary {
            crate_id: 0,
            path: parts.iter().map(|part| (*part).into()).collect(),
            kind,
        };
        let path = |id, name: &str| Path {
            path: name.into(),
            id: Id(id),
            args: None,
        };
        let mut paths = HashMap::from([
            (Id(1), summary(ItemKind::Struct, &["fixture", "Widget"])),
            (
                Id(100),
                summary(ItemKind::Trait, &["fixture", "fmt", "Debug"]),
            ),
            (
                Id(101),
                summary(ItemKind::Trait, &["fixture", "fmt", "Display"]),
            ),
            (
                Id(102),
                summary(ItemKind::Trait, &["fixture", "convert", "From"]),
            ),
            (Id(103), summary(ItemKind::Struct, &["fixture", "Alpha"])),
            (Id(104), summary(ItemKind::Struct, &["fixture", "alpha"])),
            (
                Id(105),
                summary(ItemKind::Trait, &["fixture", "ExternalOnly"]),
            ),
            (Id(106), summary(ItemKind::Trait, &["fixture", "CaseTrait"])),
            (Id(200), summary(ItemKind::Struct, &["remote", "Target"])),
            (Id(201), summary(ItemKind::Struct, &["fixture", "Later"])),
        ]);
        let mut index = HashMap::new();
        index.insert(
            Id(0),
            item(
                0,
                Some("fixture"),
                ItemEnum::Module(Module {
                    is_crate: true,
                    items: vec![Id(1), Id(100), Id(101), Id(102), Id(105), Id(106), Id(201)],
                    is_stripped: false,
                }),
            ),
        );
        index.insert(
            Id(1),
            item(
                1,
                Some("Widget"),
                ItemEnum::Struct(Struct {
                    kind: StructKind::Unit,
                    generics: generics(),
                    impls: vec![Id(2), Id(4), Id(6), Id(8), Id(10), Id(12), Id(14), Id(16)],
                }),
            ),
        );
        index.insert(
            Id(201),
            item(
                201,
                Some("Later"),
                ItemEnum::Struct(Struct {
                    kind: StructKind::Unit,
                    generics: generics(),
                    impls: Vec::new(),
                }),
            ),
        );
        for (id, name) in [
            (100, "Debug"),
            (101, "Display"),
            (102, "From"),
            (105, "ExternalOnly"),
            (106, "CaseTrait"),
        ] {
            index.insert(
                Id(id),
                item(
                    id,
                    Some(name),
                    ItemEnum::Trait(Trait {
                        is_auto: false,
                        is_unsafe: false,
                        is_dyn_compatible: true,
                        items: if id == 106 {
                            vec![Id(19), Id(20)]
                        } else {
                            Vec::new()
                        },
                        generics: generics(),
                        bounds: Vec::new(),
                        implementations: Vec::new(),
                    }),
                ),
            );
        }
        for (impl_id, method_id, trait_id, name, arg, external_self) in [
            (2, 3, Some(100), "fmt", None, false),
            (4, 5, Some(101), "fmt", None, false),
            (6, 7, Some(102), "from", Some(103), false),
            (8, 9, Some(102), "from", Some(104), false),
            (10, 11, None, "fmt", None, false),
            (12, 13, Some(105), "send", None, true),
            (14, 15, Some(105), "send", None, false),
            (16, 17, Some(106), "Run", None, false),
        ] {
            let trait_ = trait_id.map(|id| Path {
                path: match id {
                    100 => "Debug",
                    101 => "Display",
                    102 => "From",
                    106 => "CaseTrait",
                    _ => "ExternalOnly",
                }
                .into(),
                id: Id(id),
                args: arg.map(|arg| {
                    Box::new(GenericArgs::AngleBracketed {
                        args: vec![GenericArg::Type(Type::ResolvedPath(path(
                            arg,
                            if arg == 103 { "Alpha" } else { "alpha" },
                        )))],
                        constraints: Vec::new(),
                    })
                }),
            });
            index.insert(
                Id(impl_id),
                item(
                    impl_id,
                    None,
                    ItemEnum::Impl(Impl {
                        is_unsafe: false,
                        generics: generics(),
                        provided_trait_methods: Vec::new(),
                        trait_,
                        for_: Type::ResolvedPath(path(
                            if external_self {
                                200
                            } else if impl_id == 14 {
                                201
                            } else {
                                1
                            },
                            if external_self {
                                "Target"
                            } else if impl_id == 14 {
                                "Later"
                            } else {
                                "Widget"
                            },
                        )),
                        items: vec![Id(method_id)],
                        is_negative: false,
                        is_synthetic: false,
                        blanket_impl: None,
                    }),
                ),
            );
            index.insert(Id(method_id), item(method_id, Some(name), method(true)));
        }
        if let ItemEnum::Impl(im) = &mut index.get_mut(&Id(16)).unwrap().inner {
            im.items.push(Id(18));
        }
        index.insert(Id(18), item(18, Some("run"), method(true)));
        index.insert(Id(19), item(19, Some("Run"), method(false)));
        index.insert(Id(20), item(20, Some("run"), method(false)));
        let krate = Crate {
            root: Id(0),
            crate_version: None,
            includes_private: true,
            index,
            paths: std::mem::take(&mut paths),
            external_crates: HashMap::new(),
            target: Target {
                triple: "fixture-target".into(),
                target_features: Vec::new(),
            },
            format_version: rustdoc_types::FORMAT_VERSION,
        };
        let mut graph = Graph::new();
        let crate_node = crate_id("fixture");
        graph.add_node(Node::new(crate_node.clone(), "fixture", "crate"));
        let mut ingest = Ingest::new(&krate, "fixture", HashSet::new(), false);
        ingest.run(&crate_node, "");
        ingest.apply(&mut graph);

        let methods: Vec<_> = graph
            .node_values()
            .filter(|node| node.attributes.get("kind").map(String::as_str) == Some("method"))
            .collect();
        assert_eq!(methods.len(), 11);
        let widget = item_id("fixture", "Widget", "struct");
        let owned: Vec<_> = graph
            .edge_values()
            .filter(|edge| edge.source == widget && edge.relation == "has_method")
            .collect();
        assert_eq!(owned.len(), 7);
        assert!(methods.iter().any(
            |method| method.attributes.get("impl_self").map(String::as_str)
                == Some("remote::Target")
                && !owned.iter().any(|edge| edge.target == method.id)
        ));
        let later = item_id("fixture", "Later", "struct");
        assert!(graph.edge_values().any(|edge| {
            edge.source == later
                && edge.relation == "has_method"
                && methods
                    .iter()
                    .any(|method| method.id == edge.target && method.label == "send")
        }));
        assert!(graph.edge_values().any(|edge| {
            edge.source == later
                && edge.relation == "implements"
                && edge.target == item_id("fixture", "ExternalOnly", "trait")
        }));
        let from: Vec<_> = methods
            .iter()
            .filter(|method| method.label == "from")
            .collect();
        assert_eq!(from.len(), 2);
        assert_ne!(from[0].id, from[1].id);
        assert_ne!(
            from[0].attributes.get("impl_trait"),
            from[1].attributes.get("impl_trait")
        );
        let fmt: Vec<_> = methods
            .iter()
            .filter(|method| method.label == "fmt")
            .collect();
        assert_eq!(fmt.len(), 3);
        assert!(
            fmt.iter()
                .any(|method| !method.attributes.contains_key("impl_trait"))
        );
        let case_methods: Vec<_> = methods
            .iter()
            .filter(|method| {
                method.attributes.get("impl_trait").map(String::as_str)
                    == Some("fixture::CaseTrait")
            })
            .collect();
        assert_eq!(case_methods.len(), 2);
        assert_ne!(case_methods[0].id, case_methods[1].id);
        assert!(!graph.edge_values().any(|edge| {
            edge.source == widget
                && edge.relation == "implements"
                && edge.target == item_id("fixture", "ExternalOnly", "trait")
        }));
    }

    #[test]
    fn trait_and_impl_associated_items_keep_callable_and_data_kinds_distinct() {
        let index: HashMap<Id, Item> = [
            item(
                0,
                Some("fixture"),
                ItemEnum::Module(Module {
                    is_crate: true,
                    items: vec![Id(1), Id(5)],
                    is_stripped: false,
                }),
            ),
            item(
                1,
                Some("Contract"),
                ItemEnum::Trait(Trait {
                    is_auto: false,
                    is_unsafe: false,
                    is_dyn_compatible: true,
                    items: vec![Id(2), Id(3), Id(4)],
                    generics: generics(),
                    bounds: Vec::new(),
                    implementations: Vec::new(),
                }),
            ),
            item(2, Some("run"), method(false)),
            item(
                3,
                Some("NAME"),
                ItemEnum::AssocConst {
                    type_: Type::Primitive("str".into()),
                    value: None,
                },
            ),
            item(
                4,
                Some("Output"),
                ItemEnum::AssocType {
                    generics: generics(),
                    bounds: Vec::new(),
                    type_: None,
                },
            ),
            item(
                5,
                Some("Widget"),
                ItemEnum::Struct(Struct {
                    kind: StructKind::Unit,
                    generics: generics(),
                    impls: vec![Id(6)],
                }),
            ),
            item(
                6,
                None,
                ItemEnum::Impl(Impl {
                    is_unsafe: false,
                    generics: generics(),
                    provided_trait_methods: Vec::new(),
                    trait_: None,
                    for_: Type::Primitive("Widget".into()),
                    items: vec![Id(7), Id(8), Id(9)],
                    is_negative: false,
                    is_synthetic: false,
                    blanket_impl: None,
                }),
            ),
            item(7, Some("run"), method(true)),
            item(
                8,
                Some("NAME"),
                ItemEnum::AssocConst {
                    type_: Type::Primitive("str".into()),
                    value: Some("widget".into()),
                },
            ),
            item(
                9,
                Some("Output"),
                ItemEnum::AssocType {
                    generics: generics(),
                    bounds: Vec::new(),
                    type_: Some(Type::Primitive("usize".into())),
                },
            ),
        ]
        .into_iter()
        .map(|item| (item.id, item))
        .collect();
        let krate = Crate {
            root: Id(0),
            crate_version: None,
            includes_private: true,
            index,
            paths: HashMap::new(),
            external_crates: HashMap::new(),
            target: Target {
                triple: "fixture-target".into(),
                target_features: Vec::new(),
            },
            format_version: rustdoc_types::FORMAT_VERSION,
        };
        let mut graph = Graph::new();
        let crate_node = crate_id("fixture");
        graph.add_node(Node::new(crate_node.clone(), "fixture", "crate"));
        let mut ingest = Ingest::new(&krate, "fixture", HashSet::new(), false);
        ingest.run(&crate_node, "");
        ingest.apply(&mut graph);

        for owner in ["Contract", "Widget"] {
            let owner_id = item_id(
                "fixture",
                owner,
                if owner == "Contract" {
                    "trait"
                } else {
                    "struct"
                },
            );
            for (name, kind, relation) in [
                ("run", "method", "has_method"),
                ("NAME", "const", "has_const"),
                ("Output", "type", "has_type"),
            ] {
                let child_id = item_id("fixture", &format!("{owner}::{name}"), kind);
                let node = graph.node(&child_id).expect("associated item node");
                assert_eq!(node.attributes.get("kind").map(String::as_str), Some(kind));
                assert!(graph.edge_values().any(|edge| {
                    edge.source == owner_id && edge.target == child_id && edge.relation == relation
                }));
                if kind != "method" {
                    assert!(!node.attributes.contains_key("has_body"));
                    assert!(
                        !graph.edge_values().any(|edge| {
                            edge.target == child_id && edge.relation == "has_method"
                        })
                    );
                }
            }
        }
        assert_eq!(
            graph
                .node(&item_id("fixture", "Contract::run", "method"))
                .unwrap()
                .attributes
                .get("has_body")
                .map(String::as_str),
            Some("false")
        );
        assert_eq!(
            graph
                .node(&item_id("fixture", "Widget::run", "method"))
                .unwrap()
                .attributes
                .get("has_body")
                .map(String::as_str),
            Some("true")
        );
    }
}
