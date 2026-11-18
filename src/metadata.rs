//! Layer 1a — the crate dependency graph, from `cargo metadata`.
//!
//! Produces one crate node per resolved Cargo package and a `depends_on` edge
//! for every resolved dependency. Workspace crate IDs remain stable for the
//! source, symbol, and architecture layers.

use std::collections::{HashMap, HashSet};

use anyhow::{Context, Result, bail};
use camino::Utf8Path;
use cargo_metadata::{DependencyKind, Metadata, MetadataCommand, Package, PackageId};
use serde::Serialize;

use build_graph::{Graph, Node, crate_id};

/// Run `cargo metadata` (with the resolved dependency graph) for a workspace.
pub fn load(manifest_path: Option<&Utf8Path>) -> Result<Metadata> {
    let mut cmd = MetadataCommand::new();
    if let Some(mp) = manifest_path {
        cmd.manifest_path(mp);
    }
    cmd.exec().context("`cargo metadata` failed")
}

/// Use the library's actual command/JSON parser with the selected Cargo. Legacy
/// absence keeps MetadataCommand::exec unchanged; no shadow resolution runs.
pub fn load_routed(
    manifest_path: Option<&Utf8Path>,
    selected: Option<&mut crate::cargo_launch::CargoLaunchSession>,
) -> Result<Metadata> {
    let Some(selected) = selected else {
        return load(manifest_path);
    };
    let mut metadata = MetadataCommand::new();
    metadata.cargo_path(&selected.cargo);
    if let Some(manifest) = manifest_path {
        metadata.manifest_path(manifest);
    }
    let mut command = metadata.cargo_command();
    selected.configure(&mut command, false);
    #[cfg(target_os = "linux")]
    if selected.has_launch_observer() {
        command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let mut child = selected.launch(
            command,
            build_graph::compiler_invocation::CargoOperationKind::Metadata,
        )?;
        let output = child.output()?;
        if !output.status.success() {
            bail!("selected Cargo metadata failed");
        }
        let stdout = std::str::from_utf8(&output.stdout)?
            .lines()
            .find(|line| line.starts_with('{'))
            .context("Cargo metadata produced no JSON")?;
        return MetadataCommand::parse(stdout).context("selected Cargo metadata JSON failed");
    }
    let operation = selected.begin(
        &mut command,
        build_graph::compiler_invocation::CargoOperationKind::Metadata,
    )?;
    let output = command.output();
    selected.complete(operation, output.as_ref().ok().map(|output| output.status));
    let output = output.context("failed to spawn selected Cargo metadata")?;
    if !output.status.success() {
        bail!(
            "selected Cargo metadata failed (exit {:?})",
            output.status.code()
        );
    }
    let stdout = std::str::from_utf8(&output.stdout)?
        .lines()
        .find(|line| line.starts_with('{'))
        .context("Cargo metadata produced no JSON")?;
    MetadataCommand::parse(stdout).context("selected Cargo metadata JSON failed")
}

/// An injective graph ID for an external package's exact Cargo identity.
fn package_id(pid: &PackageId) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut id = String::with_capacity("package__".len() + pid.repr.len() * 2);
    id.push_str("package__");
    for byte in pid.repr.bytes() {
        id.push(HEX[(byte >> 4) as usize] as char);
        id.push(HEX[(byte & 0x0f) as usize] as char);
    }
    id
}

fn graph_id(
    pkg: &Package,
    workspace: &HashSet<&PackageId>,
    legacy_owners: &HashMap<String, &PackageId>,
) -> String {
    let legacy_id = crate_id(&pkg.name);
    if workspace.contains(&pkg.id)
        && legacy_owners
            .get(&legacy_id)
            .is_some_and(|owner| *owner == &pkg.id)
    {
        legacy_id
    } else {
        package_id(&pkg.id)
    }
}

#[derive(Serialize)]
struct SupplyChainDependency<'a> {
    package_id: &'a str,
    name: &'a str,
    kind: &'static str,
    target: Option<String>,
}

fn dependency_kind(kind: DependencyKind) -> &'static str {
    match kind {
        DependencyKind::Normal => "normal",
        DependencyKind::Build => "build",
        DependencyKind::Development => "dev",
        DependencyKind::Unknown => "unknown",
    }
}

/// Replace the crate catalog and its resolved dependency edges on every run.
pub fn add_crate_layer(graph: &mut Graph, meta: &Metadata) {
    let workspace: HashSet<&PackageId> = meta.workspace_members.iter().collect();
    let by_id: HashMap<&PackageId, &Package> = meta.packages.iter().map(|p| (&p.id, p)).collect();
    // Different workspace names can normalize to the same legacy crate ID.
    // Retain that ID for one deterministic owner and give every other package
    // its injective Cargo ID so the catalog never merges distinct identities.
    let mut legacy_owners: HashMap<String, &PackageId> = HashMap::new();
    for pkg in &meta.packages {
        if workspace.contains(&pkg.id) {
            legacy_owners
                .entry(crate_id(&pkg.name))
                .and_modify(|owner| {
                    if pkg.id.repr < owner.repr {
                        *owner = &pkg.id;
                    }
                })
                .or_insert(&pkg.id);
        }
    }
    let resolved: HashMap<&PackageId, &cargo_metadata::Node> = meta
        .resolve
        .iter()
        .flat_map(|resolve| &resolve.nodes)
        .map(|node| (&node.id, node))
        .collect();

    graph.remove_nodes_with_kind("crate");
    graph.remove_edges_with_relation("depends_on");

    for pkg in &meta.packages {
        let member = workspace.contains(&pkg.id);
        let id = graph_id(pkg, &workspace, &legacy_owners);
        let mut dependencies = Vec::new();
        if let Some(node) = resolved.get(&pkg.id) {
            if node.deps.is_empty() {
                // Older Cargo metadata has only `dependencies`, without aliases
                // or per-kind/target information.
                for dep in &node.dependencies {
                    let Some(to) = by_id.get(dep) else { continue };
                    graph.add_edge(
                        &id,
                        graph_id(to, &workspace, &legacy_owners),
                        "depends_on",
                        None,
                        None,
                    );
                    dependencies.push(SupplyChainDependency {
                        package_id: &dep.repr,
                        name: &to.name,
                        kind: "unknown",
                        target: None,
                    });
                }
            } else {
                for dep in &node.deps {
                    let Some(to) = by_id.get(&dep.pkg) else {
                        continue;
                    };
                    graph.add_edge(
                        &id,
                        graph_id(to, &workspace, &legacy_owners),
                        "depends_on",
                        None,
                        None,
                    );
                    if dep.dep_kinds.is_empty() {
                        dependencies.push(SupplyChainDependency {
                            package_id: &dep.pkg.repr,
                            name: &dep.name,
                            kind: "unknown",
                            target: None,
                        });
                    } else {
                        for kind in &dep.dep_kinds {
                            dependencies.push(SupplyChainDependency {
                                package_id: &dep.pkg.repr,
                                name: &dep.name,
                                kind: dependency_kind(kind.kind),
                                target: kind.target.as_ref().map(ToString::to_string),
                            });
                        }
                    }
                }
            }
        }
        let manifest_rel = member
            .then(|| pkg.manifest_path.strip_prefix(&meta.workspace_root).ok())
            .flatten()
            .map(|p| p.as_str().to_string());
        let mut crate_node = Node::new(id, pkg.name.clone(), "crate")
            .with_source(manifest_rel, None)
            .attr("crate", pkg.name.clone())
            .attr("package_id", pkg.id.repr.clone())
            .attr("version", pkg.version.to_string())
            .attr("workspace_member", member.to_string())
            .attr(
                "package_source",
                pkg.source
                    .as_ref()
                    .map(|s| s.repr.as_str())
                    .unwrap_or("path"),
            )
            .attr(
                "supply_chain_dependencies",
                serde_json::to_string(&dependencies).expect("dependency records serialize"),
            )
            .attr(
                "cargo_targets",
                serde_json::json!({
                    "schemaVersion": 1,
                    "targets": pkg.targets.iter().map(|target| serde_json::json!({
                        "name": target.name,
                        "kind": target.kind.iter().map(ToString::to_string).collect::<Vec<_>>(),
                        "crate_types": target.crate_types.iter().map(ToString::to_string).collect::<Vec<_>>(),
                        "src_path": target.src_path,
                        "required_features": target.required_features,
                    })).collect::<Vec<_>>()
                }).to_string(),
            );
        if let Some(license) = &pkg.license {
            crate_node = crate_node.attr("license", license.clone());
        }
        if let Some(repository) = &pkg.repository {
            crate_node = crate_node.attr("repository", repository.clone());
        }
        graph.add_node(crate_node);
    }
}

#[cfg(test)]
mod tests {
    use build_graph::{Graph, Node, crate_id, file_id, item_id};
    use cargo_metadata::{Metadata, PackageId};
    use serde_json::{Value, json};

    use super::{add_crate_layer, package_id};

    fn package(
        name: &str,
        version: &str,
        id: &str,
        source: Option<&str>,
        manifest_path: &str,
        license: Option<&str>,
        repository: Option<&str>,
    ) -> Value {
        json!({
            "name": name,
            "version": version,
            "id": id,
            "source": source,
            "manifest_path": manifest_path,
            "authors": [],
            "dependencies": [],
            "targets": [],
            "features": {},
            "categories": [],
            "keywords": [],
            "license": license,
            "repository": repository,
        })
    }

    fn metadata(packages: Vec<Value>, workspace_id: &str, nodes: Vec<Value>) -> Metadata {
        serde_json::from_value(json!({
            "packages": packages,
            "workspace_members": [workspace_id],
            "resolve": { "nodes": nodes, "root": workspace_id },
            "workspace_root": "/ws",
            "target_directory": "/ws/target",
            "version": 1,
        }))
        .unwrap()
    }

    fn dependencies(graph: &Graph, id: &str) -> Value {
        serde_json::from_str(
            graph
                .node(id)
                .unwrap()
                .attributes
                .get("supply_chain_dependencies")
                .unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn resolved_packages_keep_exact_id_source_alias_kind_and_target() {
        assert_eq!(package_id(&PackageId { repr: "é".into() }), "package__c3a9");
        let app = "path+file:///ws#app@0.1.0";
        let reg_v1 = "registry+https://index.example/common#common@1.0.0";
        let reg_v2 = "registry+https://index.example/common#common@2.0.0";
        let git = "git+https://git.example/common?rev=main#common@1.0.0";
        let path = "path+file:///vendor/common#common@1.0.0";
        let meta = metadata(
            vec![
                package(
                    "app",
                    "0.1.0",
                    app,
                    None,
                    "/ws/Cargo.toml",
                    Some("MIT"),
                    None,
                ),
                package(
                    "common",
                    "1.0.0",
                    reg_v1,
                    Some("registry+https://index.example/common"),
                    "/registry/common-1/Cargo.toml",
                    Some("Apache-2.0"),
                    Some("https://example.org/common"),
                ),
                package(
                    "common",
                    "2.0.0",
                    reg_v2,
                    Some("registry+https://index.example/common"),
                    "/registry/common-2/Cargo.toml",
                    None,
                    None,
                ),
                package(
                    "common",
                    "1.0.0",
                    git,
                    Some("git+https://git.example/common?rev=main"),
                    "/git/common/Cargo.toml",
                    None,
                    None,
                ),
                package(
                    "common",
                    "1.0.0",
                    path,
                    None,
                    "/vendor/common/Cargo.toml",
                    None,
                    None,
                ),
            ],
            app,
            vec![
                json!({
                    "id": app,
                    "dependencies": [reg_v1, reg_v2, git, path],
                    "deps": [
                        {"name": "renamed_common", "pkg": reg_v1, "dep_kinds": [
                            {"kind": null, "target": "cfg(unix)"},
                            {"kind": "build", "target": null}
                        ]},
                        {"name": "common_two", "pkg": reg_v2, "dep_kinds": [{"kind": "dev", "target": null}]},
                        {"name": "git_common", "pkg": git, "dep_kinds": [{"kind": "future-kind", "target": null}]},
                        {"name": "path_common", "pkg": path, "dep_kinds": []}
                    ]
                }),
                json!({"id": reg_v1, "dependencies": [path], "deps": [
                    {"name": "path_common", "pkg": path, "dep_kinds": [{"kind": "normal", "target": null}]}
                ]}),
            ],
        );
        let mut graph = Graph::new();
        add_crate_layer(&mut graph, &meta);

        let app_node = graph.node(&crate_id("app")).unwrap();
        assert_eq!(app_node.source_file.as_deref(), Some("Cargo.toml"));
        assert_eq!(app_node.attributes["package_id"], app);
        assert_eq!(app_node.attributes["workspace_member"], "true");
        assert_eq!(app_node.attributes["package_source"], "path");
        assert_eq!(graph.node_count(), 5);
        for id in [reg_v1, reg_v2, git, path] {
            let external = graph
                .node(&package_id(&PackageId { repr: id.into() }))
                .unwrap();
            assert_eq!(external.attributes["package_id"], id);
            assert_eq!(external.attributes["workspace_member"], "false");
            assert_eq!(external.attributes["kind"], "crate");
            assert!(external.source_file.is_none());
        }
        assert_eq!(
            graph
                .node(&package_id(&PackageId {
                    repr: reg_v1.into()
                }))
                .unwrap()
                .attributes["license"],
            "Apache-2.0"
        );
        assert_eq!(
            graph
                .node(&package_id(&PackageId {
                    repr: reg_v1.into()
                }))
                .unwrap()
                .attributes["repository"],
            "https://example.org/common"
        );
        assert_eq!(
            graph
                .node(&package_id(&PackageId { repr: git.into() }))
                .unwrap()
                .attributes["package_source"],
            "git+https://git.example/common?rev=main"
        );
        assert_eq!(
            graph
                .node(&package_id(&PackageId { repr: path.into() }))
                .unwrap()
                .attributes["package_source"],
            "path"
        );
        assert_eq!(
            dependencies(&graph, &crate_id("app")),
            json!([
                {"package_id": reg_v1, "name": "renamed_common", "kind": "normal", "target": "cfg(unix)"},
                {"package_id": reg_v1, "name": "renamed_common", "kind": "build", "target": null},
                {"package_id": reg_v2, "name": "common_two", "kind": "dev", "target": null},
                {"package_id": git, "name": "git_common", "kind": "unknown", "target": null},
                {"package_id": path, "name": "path_common", "kind": "unknown", "target": null}
            ])
        );
        assert_eq!(
            dependencies(
                &graph,
                &package_id(&PackageId {
                    repr: reg_v1.into()
                })
            ),
            json!([
                {"package_id": path, "name": "path_common", "kind": "normal", "target": null}
            ])
        );
        assert_eq!(
            graph
                .edge_values()
                .filter(|edge| edge.relation == "depends_on")
                .count(),
            5
        );
    }

    #[test]
    fn build_target_declarations_retain_sources_and_required_features() {
        let id = "path+file:///ws#builder@0.1.0";
        let mut pkg = package("builder", "0.1.0", id, None, "/ws/Cargo.toml", None, None);
        pkg["targets"] = json!([
            {"name":"build-script-build","kind":["custom-build"],"crate_types":["bin"],"src_path":"/ws/build.rs","required-features":[]},
            {"name":"fixture_macro","kind":["proc-macro"],"crate_types":["proc-macro"],"src_path":"/ws/src/lib.rs","required-features":["macros"]}
        ]);
        let meta = metadata(vec![pkg], id, vec![json!({"id":id,"dependencies":[]})]);
        let mut graph = Graph::new();
        add_crate_layer(&mut graph, &meta);
        let targets: Value = serde_json::from_str(&graph.node(&crate_id("builder")).unwrap().attributes["cargo_targets"]).unwrap();
        assert_eq!(targets["schemaVersion"], 1);
        assert_eq!(targets["targets"][0]["kind"][0], "custom-build");
        assert_eq!(targets["targets"][0]["src_path"], "/ws/build.rs");
        assert_eq!(targets["targets"][1]["required_features"][0], "macros");
    }

    #[test]
    fn normalized_workspace_name_collision_keeps_both_cargo_identities() {
        let hyphen = "path+file:///ws/foo-bar#foo-bar@0.1.0";
        let underscore = "path+file:///ws/foo_bar#foo_bar@0.1.0";
        let mut meta: Metadata = serde_json::from_value(json!({
            "packages": [
                package("foo-bar", "0.1.0", hyphen, None, "/ws/foo-bar/Cargo.toml", None, None),
                package("foo_bar", "0.1.0", underscore, None, "/ws/foo_bar/Cargo.toml", None, None)
            ],
            "workspace_members": [hyphen, underscore],
            "resolve": { "nodes": [
                {"id": hyphen, "dependencies": [underscore], "deps": [
                    {"name": "foo_bar", "pkg": underscore, "dep_kinds": [{"kind": "normal", "target": null}]}
                ]},
                {"id": underscore, "dependencies": []}
            ], "root": hyphen },
            "workspace_root": "/ws",
            "target_directory": "/ws/target",
            "version": 1
        }))
        .unwrap();
        let alternate = package_id(&PackageId {
            repr: underscore.into(),
        });
        for _ in 0..2 {
            let mut graph = Graph::new();
            add_crate_layer(&mut graph, &meta);
            assert_eq!(graph.node_count(), 2);
            assert_eq!(
                graph.node(&crate_id("foo-bar")).unwrap().attributes["package_id"],
                hyphen
            );
            assert_eq!(
                graph.node(&alternate).unwrap().attributes["package_id"],
                underscore
            );
            assert_eq!(
                graph.node(&alternate).unwrap().attributes["workspace_member"],
                "true"
            );
            assert_eq!(
                graph.node(&alternate).unwrap().source_file.as_deref(),
                Some("foo_bar/Cargo.toml")
            );
            assert!(
                graph
                    .edge_values()
                    .any(|edge| edge.source == crate_id("foo-bar")
                        && edge.target == alternate
                        && edge.relation == "depends_on")
            );
            meta.packages.reverse();
        }
    }

    #[test]
    fn refresh_replaces_stale_catalog_and_keeps_rich_workspace_edges() {
        let app = "path+file:///ws#app@0.1.0";
        let old = "registry+https://index.example/old#old@1.0.0";
        let new = "registry+https://index.example/new#new@2.0.0";
        let mut graph = Graph::new();
        let file = file_id("app", "src/lib.rs");
        let caller = item_id("app", "caller", "function");
        let callee = item_id("app", "callee", "function");
        graph.add_node(Node::new(file.clone(), "src/lib.rs", "file"));
        graph.add_node(Node::new(caller.clone(), "caller", "function"));
        graph.add_node(Node::new(callee.clone(), "callee", "function"));
        graph.add_edge(crate_id("app"), &file, "contains", None, None);
        graph.add_edge(&caller, &callee, "calls", None, None);

        let first = metadata(
            vec![
                package(
                    "app",
                    "0.1.0",
                    app,
                    None,
                    "/ws/Cargo.toml",
                    Some("MIT"),
                    None,
                ),
                package(
                    "old",
                    "1.0.0",
                    old,
                    Some("registry+https://index.example"),
                    "/registry/old/Cargo.toml",
                    None,
                    None,
                ),
            ],
            app,
            vec![json!({"id": app, "dependencies": [old]})],
        );
        add_crate_layer(&mut graph, &first);
        assert_eq!(
            dependencies(&graph, &crate_id("app")),
            json!([
                {"package_id": old, "name": "old", "kind": "unknown", "target": null}
            ])
        );

        let second = metadata(
            vec![
                package("app", "0.1.0", app, None, "/ws/Cargo.toml", None, None),
                package(
                    "new",
                    "2.0.0",
                    new,
                    Some("registry+https://index.example"),
                    "/registry/new/Cargo.toml",
                    None,
                    None,
                ),
            ],
            app,
            vec![json!({"id": app, "dependencies": [new], "deps": [
                {"name": "replacement", "pkg": new, "dep_kinds": [{"kind": "dev", "target": null}]}
            ]})],
        );
        add_crate_layer(&mut graph, &second);
        graph.prune_dangling_edges();

        assert!(
            graph
                .node(&package_id(&PackageId { repr: old.into() }))
                .is_none()
        );
        assert!(
            graph
                .node(&package_id(&PackageId { repr: new.into() }))
                .is_some()
        );
        assert!(
            !graph
                .node(&crate_id("app"))
                .unwrap()
                .attributes
                .contains_key("license")
        );
        assert_eq!(
            dependencies(&graph, &crate_id("app")),
            json!([
                {"package_id": new, "name": "replacement", "kind": "dev", "target": null}
            ])
        );
        assert!(graph.node(&file).is_some());
        assert!(graph.node(&caller).is_some());
        assert!(graph.node(&callee).is_some());
        assert!(
            graph
                .edge_values()
                .any(|edge| edge.source == crate_id("app")
                    && edge.target == file
                    && edge.relation == "contains")
        );
        assert!(graph.edge_values().any(|edge| edge.source == caller
            && edge.target == callee
            && edge.relation == "calls"));
        assert_eq!(
            graph
                .edge_values()
                .filter(|edge| edge.relation == "depends_on")
                .count(),
            1
        );
        assert!(
            graph
                .edge_values()
                .any(|edge| edge.source == crate_id("app")
                    && edge.target == package_id(&PackageId { repr: new.into() })
                    && edge.relation == "depends_on")
        );
    }
}
