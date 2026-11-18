//! Native boundary extraction from the libraries actually named by Cargo build scripts.
//!
//! A compiler-recorded FFI call proves an ABI symbol, while an object relocation
//! or a disassembled direct branch proves a native call. Neither an undefined
//! symbol list nor a Cargo dependency edge proves a call.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::process::Command;

use anyhow::{Context, Result};
use camino::{Utf8Path, Utf8PathBuf};
use cargo_metadata::Metadata;
use serde::Deserialize;
use serde_json::{Value, json};

use build_graph::{Graph, Node};

#[derive(Default, Debug)]
pub struct NativeLayerReport {
    pub libraries: usize,
    pub functions: usize,
    pub boundaries: usize,
    pub direct_calls: usize,
    pub ffi_targets: usize,
    pub unresolved: usize,
    pub diagnostics: Vec<String>,
}

#[derive(Deserialize)]
struct ArtifactIndex {
    version: u32,
    #[serde(default)]
    rust_artifacts: Vec<RustArtifact>,
    #[serde(default)]
    native_links: Vec<NativeLink>,
}

#[derive(Deserialize)]
struct RustArtifact {
    #[serde(default)]
    target_kind: Vec<String>,
    #[serde(default)]
    filenames: Vec<String>,
}

#[derive(Deserialize)]
struct NativeLink {
    package_id: String,
    #[serde(default)]
    linked_libs: Vec<String>,
    #[serde(default)]
    linked_paths: Vec<String>,
    out_dir: String,
}

#[derive(Clone)]
struct Library {
    id: String,
    name: String,
    artifact: Option<Utf8PathBuf>,
    producer: Option<String>,
    format: Option<String>,
}

#[derive(Clone)]
struct DirectCall {
    symbol: Option<String>,
    evidence: &'static str,
    address: u64,
}

struct NativeFunction {
    id: String,
    symbol: String,
    member: String,
    address: Option<u64>,
    artifact: Utf8PathBuf,
    library_id: String,
    format: String,
    producer: Option<String>,
    binding: SymbolBinding,
    calls: Vec<DirectCall>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SymbolBinding {
    Global,
    Local,
    Unknown,
}

const NATIVE_ANALYSIS_SCOPE: &str = "named symbols; x86 call/callq and ARM bl/blx direct instructions with adjacent relocations; indirect and other instructions unresolved";

fn supported_instruction_set(format: &str) -> bool {
    let format = format.to_ascii_lowercase();
    ["x86", "i386", "arm", "aarch64"]
        .iter()
        .any(|name| format.contains(name))
}

/// Encode exact identities without lossy normalization or hash collisions.
fn id(prefix: &str, parts: &[&str]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut result = String::from(prefix);
    for part in parts {
        for byte in part.bytes() {
            result.push(HEX[(byte >> 4) as usize] as char);
            result.push(HEX[(byte & 15) as usize] as char);
        }
        result.push('_');
    }
    result
}

fn link_name(raw: &str) -> &str {
    raw.split_once('=').map_or(raw, |(_, name)| name)
}

fn candidate_files(link: &NativeLink, raw: &str) -> Vec<Utf8PathBuf> {
    let name = link_name(raw);
    if name.is_empty() || raw.starts_with("framework=") {
        return Vec::new();
    }
    let names = [
        format!("lib{name}.a"),
        format!("lib{name}.so"),
        format!("lib{name}.dylib"),
        format!("{name}.lib"),
        format!("lib{name}.tbd"),
    ];
    let mut dirs = Vec::new();
    if !link.out_dir.is_empty() {
        dirs.push(Utf8PathBuf::from(&link.out_dir));
    }
    for path in &link.linked_paths {
        let path = path.split_once('=').map_or(path.as_str(), |(_, p)| p);
        if !path.is_empty() {
            dirs.push(Utf8PathBuf::from(path));
        }
    }
    let mut found = BTreeSet::new();
    for dir in dirs {
        if !dir.is_absolute() {
            continue;
        }
        for file in &names {
            let path = dir.join(file);
            if path.is_file() {
                found.insert(path);
            }
        }
    }
    found.into_iter().collect()
}

fn symbol_key<'a>(symbol: &'a str, format: &str) -> &'a str {
    if format.to_ascii_lowercase().contains("mach-o") {
        symbol.strip_prefix('_').unwrap_or(symbol)
    } else {
        symbol
    }
}

fn parse_address(text: &str) -> Option<u64> {
    u64::from_str_radix(text.trim_start_matches("0x"), 16).ok()
}

fn object_header(line: &str) -> Option<(&str, &str)> {
    let (object, tail) = line.rsplit_once(':')?;
    let format = tail.trim().strip_prefix("file format ")?.trim();
    (!object.is_empty() && !format.is_empty()).then_some((object, format))
}

fn function_header(line: &str) -> Option<(Option<u64>, String)> {
    let trimmed = line.trim();
    if let Some((addr, symbol)) = trimmed.split_once(" <") {
        let symbol = symbol.strip_suffix(">:")?;
        return Some((Some(parse_address(addr)?), symbol.to_string()));
    }
    // Mach-O llvm-objdump often prints `_name:` without a leading address.
    let symbol = trimmed.strip_suffix(':')?;
    if symbol.starts_with('_') && symbol.chars().all(|c| !c.is_whitespace()) {
        return Some((None, symbol.to_string()));
    }
    None
}

fn symbol_bindings(output: &str) -> BTreeMap<(String, String, u64), SymbolBinding> {
    let mut bindings = BTreeMap::new();
    let mut member = String::new();
    let mut ordinal = 0usize;
    let mut in_table = false;
    for line in output.lines() {
        let trimmed = line.trim();
        if let Some((object, _)) = object_header(trimmed) {
            ordinal += 1;
            member = format!("{object}#{ordinal}");
            in_table = false;
            continue;
        }
        if trimmed == "SYMBOL TABLE:" {
            in_table = true;
            continue;
        }
        if trimmed.starts_with("Disassembly of section") {
            in_table = false;
        }
        if !in_table {
            continue;
        }
        let parts: Vec<&str> = trimmed.split_whitespace().collect();
        if parts.len() < 5 || !parts.contains(&"F") {
            continue;
        }
        let Some(address) = parse_address(parts[0]) else {
            continue;
        };
        let binding = match parts[1] {
            "g" => SymbolBinding::Global,
            "l" => SymbolBinding::Local,
            _ => SymbolBinding::Unknown,
        };
        bindings.insert(
            (member.clone(), parts.last().unwrap().to_string(), address),
            binding,
        );
    }
    bindings
}

fn operand_symbol(text: &str) -> Option<String> {
    if let Some((_, rest)) = text.split_once('<') {
        let symbol = rest.split('>').next()?;
        // A branch to a symbol+offset is not a call to the definition entry.
        if !symbol.is_empty() && !symbol.contains('+') && !symbol.contains('-') {
            return Some(symbol.to_string());
        }
    }
    let token = text.split_whitespace().last()?.trim_end_matches(',');
    if token.starts_with('_')
        || token
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic())
    {
        return Some(token.to_string());
    }
    None
}

fn relocation_symbol(text: &str) -> Option<String> {
    let mut parts = text.split_whitespace();
    let relocation = parts.next()?;
    if !(relocation.starts_with("R_") || relocation.contains("RELOC")) {
        return None;
    }
    let symbol = parts.next()?.split(['+', '-']).next()?;
    (!symbol.is_empty()).then(|| symbol.to_string())
}

/// Parse llvm-objdump's `--disassemble --reloc --no-show-raw-insn` output.
/// Relocations are accepted only when adjacent to a direct call instruction.
fn parse_disassembly(output: &str, artifact: &Utf8Path, library: &Library) -> Vec<NativeFunction> {
    let mut functions: Vec<NativeFunction> = Vec::new();
    let bindings = symbol_bindings(output);
    let mut member = String::new();
    let mut format = String::new();
    let mut current: Option<usize> = None;
    let mut pending: Option<(usize, usize, u64)> = None;
    let mut member_ordinal = 0usize;
    for line in output.lines() {
        let trimmed = line.trim();
        if let Some((object, object_format)) = object_header(trimmed) {
            member_ordinal += 1;
            member = format!("{object}#{member_ordinal}");
            format = object_format.to_string();
            current = None;
            pending = None;
            continue;
        }
        if let Some((address, symbol)) = function_header(trimmed) {
            if member.is_empty() || symbol.is_empty() {
                continue;
            }
            if (symbol.starts_with("ltmp") && symbol[4..].chars().all(|c| c.is_ascii_digit()))
                || symbol.starts_with(".L")
            {
                continue;
            }
            let binding = if let Some(address) = address {
                bindings
                    .get(&(member.clone(), symbol.clone(), address))
                    .copied()
            } else {
                let matches: Vec<_> = bindings
                    .iter()
                    .filter(|((object, name, _), _)| object == &member && name == &symbol)
                    .collect();
                (matches.len() == 1).then(|| *matches[0].1)
            }
            .unwrap_or(SymbolBinding::Unknown);
            functions.push(NativeFunction {
                id: String::new(),
                symbol,
                member: member.clone(),
                address,
                artifact: artifact.to_path_buf(),
                library_id: library.id.clone(),
                format: format.clone(),
                producer: library.producer.clone(),
                binding,
                calls: Vec::new(),
            });
            current = Some(functions.len() - 1);
            pending = None;
            continue;
        }
        let Some(function_index) = current else {
            continue;
        };
        let Some((address_text, rest)) = trimmed.split_once(':') else {
            continue;
        };
        let Some(address) = parse_address(address_text) else {
            continue;
        };
        if functions[function_index].address.is_none() && relocation_symbol(rest.trim()).is_none() {
            functions[function_index].address = Some(address);
        }
        if !supported_instruction_set(&format) {
            continue;
        }
        if let Some((pending_fn, call_index, call_address)) = pending {
            if pending_fn == function_index
                && address >= call_address
                && address <= call_address + 4
            {
                if let Some(symbol) = relocation_symbol(rest.trim()) {
                    functions[function_index].calls[call_index].symbol = Some(symbol);
                    functions[function_index].calls[call_index].evidence = "relocation";
                    pending = None;
                    continue;
                }
            }
        }
        // `--no-show-raw-insn` leaves the mnemonic immediately after the colon.
        // A tool that ignores the option may leave bytes; search a small token
        // window, but accept only direct-call mnemonics.
        let tokens: Vec<&str> = rest.split_whitespace().collect();
        let mnemonic = tokens
            .iter()
            .position(|token| matches!(*token, "call" | "callq" | "bl" | "blx" | "blr"));
        if let Some(position) = mnemonic {
            let operand = tokens[position + 1..].join(" ");
            let indirect = tokens[position] == "blr"
                || operand.starts_with('*')
                || operand.starts_with('%')
                || operand.starts_with('x') && operand[1..].chars().all(|c| c.is_ascii_digit())
                || operand.starts_with('r') && operand[1..].chars().all(|c| c.is_ascii_digit());
            let symbol = if indirect {
                None
            } else {
                operand_symbol(&operand)
            };
            let calls = &mut functions[function_index].calls;
            calls.push(DirectCall {
                symbol,
                evidence: "disassembly",
                address,
            });
            pending = Some((function_index, calls.len() - 1, address));
        } else if !rest.trim().is_empty() {
            pending = None;
        }
    }
    for function in &mut functions {
        let address = function
            .address
            .map(|address| format!("{address:x}"))
            .unwrap_or_else(|| "unknown".into());
        function.id = id(
            "native_function__",
            &[
                artifact.as_str(),
                &function.member,
                &function.symbol,
                &address,
            ],
        );
    }
    functions
}

fn library_node(library: &Library, linking_package: &str, diagnostic: Option<&str>) -> Node {
    let mut node = Node::new(library.id.clone(), &library.name, "native_library")
        .attr("native_link_name", &library.name)
        .attr("linking_package_id", linking_package)
        .attr("native_producer_status", "unknown")
        .attr("native_producer_evidence", "link scope and artifact lookup do not prove a writer")
        .attr("native_call_coverage", "partial")
        .attr("native_analysis_scope", NATIVE_ANALYSIS_SCOPE)
        .attr(
            "artifact_status",
            if library.artifact.is_some() {
                "found"
            } else {
                "unavailable"
            },
        );
    if let Some(artifact) = &library.artifact {
        node = node.attr("native_artifact", artifact.as_str());
    }
    if let Some(producer) = &library.producer {
        node = node.attr("package_id", producer);
    }
    if let Some(format) = &library.format {
        node = node.attr("native_format", format);
        node = node.attr(
            "native_instruction_set_status",
            if supported_instruction_set(format) {
                "recognized"
            } else {
                "unsupported"
            },
        );
    }
    if let Some(diagnostic) = diagnostic {
        node = node.attr("native_diagnostic", diagnostic);
    }
    node
}

fn flow_nodes(graph: &Graph) -> Vec<(String, Value, Option<String>, Vec<String>)> {
    graph
        .node_values()
        .filter(|node| {
            node.attributes
                .get("kind")
                .is_some_and(|kind| kind == "flow_function")
        })
        .filter_map(|node| {
            let flow = serde_json::from_str(node.attributes.get("flow")?).ok()?;
            let artifacts = node
                .attributes
                .get("target_artifacts")
                .and_then(|value| serde_json::from_str(value).ok())
                .unwrap_or_default();
            Some((
                node.id.clone(),
                flow,
                node.attributes.get("link_symbol").cloned(),
                artifacts,
            ))
        })
        .collect()
}

fn add_ffi_symbol_boundary(
    graph: &mut Graph,
    caller_id: &str,
    block_index: usize,
    block: &Value,
    reason: &str,
) -> Option<String> {
    let call = block.get("native_call")?;
    let symbol = call
        .get("symbol")?
        .as_str()
        .filter(|symbol| !symbol.is_empty())?;
    let abi = call.get("abi").and_then(Value::as_str).unwrap_or("");
    let declaration_package = block
        .get("callee_package_id")
        .and_then(Value::as_str)
        .unwrap_or("");
    let boundary_id = id(
        "native_ffi_boundary__",
        &[
            caller_id,
            &block_index.to_string(),
            symbol,
            abi,
            declaration_package,
        ],
    );
    let mut node = Node::new(boundary_id.clone(), symbol, "function")
        .attr("language", "native")
        .attr("native_symbol", symbol)
        .attr("body_status", "unavailable")
        .attr("native_boundary_kind", "ffi_symbol")
        .attr("native_resolution", reason)
        .attr("native_call_origin_flow_id", caller_id)
        .attr("native_callsite_block", block_index.to_string())
        .attr("native_call_evidence", "compiler_mir_ffi_call")
        .attr("native_call_coverage", "partial")
        .attr(
            "native_analysis_scope",
            "compiler-recorded FFI symbol and ABI; native definition unavailable",
        );
    if !abi.is_empty() {
        node = node.attr("native_abi", abi);
    }
    if !declaration_package.is_empty() {
        node = node.attr("native_declaration_package_id", declaration_package);
    }
    if let Some(libraries) = call.get("libraries").and_then(Value::as_array) {
        node = node.attr(
            "native_link_libraries",
            Value::Array(libraries.clone()).to_string(),
        );
    }
    graph.add_node(node);
    graph.add_edge(caller_id, &boundary_id, "native_calls", None, None);
    Some(boundary_id)
}

fn mark_unresolved_native_calls(graph: &mut Graph, reason: &str) -> (usize, usize) {
    let mut unresolved = 0;
    let mut boundaries = 0;
    for (node_id, mut flow, _, _) in flow_nodes(graph) {
        let Some(blocks) = flow.get_mut("blocks").and_then(Value::as_array_mut) else {
            continue;
        };
        let mut changed = false;
        for (block_index, block) in blocks.iter_mut().enumerate() {
            if block.get("native_call").is_some() {
                if let Some(boundary_id) =
                    add_ffi_symbol_boundary(graph, &node_id, block_index, block, reason)
                {
                    block["native_target_ids"] = json!([boundary_id]);
                    boundaries += 1;
                } else if let Some(object) = block.as_object_mut() {
                    object.remove("native_target_ids");
                }
                block["native_resolution"] = json!(reason);
                unresolved += 1;
                changed = true;
            }
        }
        if changed {
            if let Some(node) = graph.node_mut(&node_id) {
                node.attributes.insert("flow".into(), flow.to_string());
            }
        }
    }
    (unresolved, boundaries)
}

fn final_rust_symbols(
    index: &ArtifactIndex,
    diagnostics: &mut Vec<String>,
) -> BTreeMap<String, BTreeSet<String>> {
    let mut symbols = BTreeMap::new();
    for artifact in &index.rust_artifacts {
        if !artifact
            .target_kind
            .iter()
            .any(|kind| matches!(kind.as_str(), "bin" | "cdylib" | "staticlib"))
        {
            continue;
        }
        for file in &artifact.filenames {
            if !Utf8Path::new(file).is_file() {
                continue;
            }
            let output = Command::new("nm")
                .args(["--defined-only", "--format=posix"])
                .arg(file)
                .output();
            match output {
                Ok(output) if output.status.success() => {
                    let names = String::from_utf8_lossy(&output.stdout)
                        .lines()
                        .filter_map(|line| {
                            let mut parts = line.split_whitespace();
                            let name = parts.next()?;
                            let kind = parts.next()?;
                            (kind.len() == 1 && kind.chars().all(|c| c.is_ascii_alphabetic()))
                                .then(|| name.to_string())
                        })
                        .collect();
                    symbols.insert(file.clone(), names);
                }
                Ok(output) => diagnostics.push(format!(
                    "nm failed for {file}: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                )),
                Err(error) => diagnostics.push(format!("nm unavailable for {file}: {error}")),
            }
        }
    }
    symbols
}

fn resolve_native_target(
    caller: &NativeFunction,
    candidates: &[usize],
    functions: &[NativeFunction],
    final_symbols: &BTreeMap<String, BTreeSet<String>>,
) -> Option<usize> {
    let same_member: Vec<usize> = candidates
        .iter()
        .copied()
        .filter(|&index| {
            functions[index].artifact == caller.artifact && functions[index].member == caller.member
        })
        .collect();
    if !same_member.is_empty() {
        return (same_member.len() == 1).then(|| same_member[0]);
    }
    let same_archive: Vec<usize> = candidates
        .iter()
        .copied()
        .filter(|&index| {
            functions[index].artifact == caller.artifact
                && functions[index].binding == SymbolBinding::Global
        })
        .collect();
    if !same_archive.is_empty() {
        return (same_archive.len() == 1).then(|| same_archive[0]);
    }
    let linked: Vec<usize> = candidates
        .iter()
        .copied()
        .filter(|&index| {
            let target = &functions[index];
            target.binding == SymbolBinding::Global
                && final_symbols.values().any(|names| {
                    names.iter().any(|name| {
                        symbol_key(name, &caller.format)
                            == symbol_key(&caller.symbol, &caller.format)
                    }) && names.iter().any(|name| {
                        symbol_key(name, &target.format)
                            == symbol_key(&target.symbol, &target.format)
                    })
                })
        })
        .collect();
    (linked.len() == 1).then(|| linked[0])
}

fn ffi_candidates<'a>(
    functions: &'a [NativeFunction],
    libraries: &[Library],
    linking_packages: &[String],
    symbol: &str,
    names: &BTreeSet<&str>,
    callee_package: Option<&str>,
) -> Vec<&'a NativeFunction> {
    let mut candidates: Vec<&NativeFunction> = functions
        .iter()
        .filter(|function| {
            function.binding == SymbolBinding::Global
                && symbol_key(&function.symbol, &function.format) == symbol
                && libraries
                    .iter()
                    .zip(linking_packages)
                    .any(|(lib, linking_package)| {
                        lib.id == function.library_id
                            && callee_package.is_none_or(|package| package == linking_package)
                            && (names.contains(lib.name.as_str())
                                || names.is_empty() && callee_package.is_some())
                    })
        })
        .collect();
    candidates.sort_by(|a, b| a.id.cmp(&b.id));
    candidates.dedup_by(|a, b| a.id == b.id);
    candidates
}

fn unique_function_indices(functions: &[NativeFunction]) -> Vec<usize> {
    let mut seen_ids = BTreeSet::new();
    functions
        .iter()
        .enumerate()
        .filter_map(|(index, function)| seen_ids.insert(&function.id).then_some(index))
        .collect()
}

fn add_unavailable_boundary(
    graph: &mut Graph,
    caller: &NativeFunction,
    call: &DirectCall,
    reason: &str,
) -> String {
    let address = format!("{:x}", call.address);
    let symbol = call.symbol.as_deref().unwrap_or("");
    let boundary_id = id("native_boundary__", &[&caller.id, &address, symbol]);
    let kind = if call.symbol.is_some() {
        "unresolved_symbol"
    } else {
        "indirect_call"
    };
    let label = call.symbol.as_deref().unwrap_or("unknown indirect target");
    let mut node = Node::new(boundary_id.clone(), label, "function")
        .attr("language", "native")
        .attr("body_status", "unavailable")
        .attr("native_boundary_kind", kind)
        .attr("native_resolution", reason)
        .attr("native_call_origin_artifact", caller.artifact.as_str())
        .attr("native_call_origin_library_id", &caller.library_id)
        .attr("native_call_origin_object_member", &caller.member)
        .attr("native_callsite_address", &address)
        .attr("native_call_evidence", call.evidence)
        .attr("native_call_coverage", "partial")
        .attr("native_analysis_scope", NATIVE_ANALYSIS_SCOPE);
    if let Some(symbol) = &call.symbol {
        node = node.attr("native_symbol", symbol);
    }
    graph.add_node(node);
    graph.add_edge(&caller.id, &boundary_id, "native_calls", None, None);
    boundary_id
}

/// Add native symbols and proven direct calls, then map compiler-recorded FFI
/// call blocks to exact native function IDs where the linked artifact proves it.
pub fn add_native_layer(
    graph: &mut Graph,
    meta: &Metadata,
    out: &Utf8Path,
) -> Result<NativeLayerReport> {
    let mut report = NativeLayerReport::default();
    graph.remove_nodes_with_kind("native_library");
    graph.remove_nodes_with_attribute("language", "native");
    graph.remove_edges_with_relation("native_calls");
    graph.remove_edges_with_relation("links_native");
    let path = out.join("driver-artifacts-v1.json");
    if !path.is_file() {
        report
            .diagnostics
            .push(format!("artifact index unavailable: {path}"));
        (report.unresolved, report.boundaries) =
            mark_unresolved_native_calls(graph, "artifact_index_unavailable");
        return Ok(report);
    }
    let index: ArtifactIndex =
        serde_json::from_slice(&fs::read(&path).with_context(|| format!("reading {path}"))?)
            .with_context(|| format!("parsing {path}"))?;
    if index.version != 1 {
        report.diagnostics.push(format!(
            "unsupported artifact index version {}",
            index.version
        ));
        (report.unresolved, report.boundaries) =
            mark_unresolved_native_calls(graph, "artifact_index_version_unsupported");
        return Ok(report);
    }

    let mut libraries = Vec::new();
    let mut linking_packages = Vec::new();
    let current_packages: BTreeSet<&str> = meta
        .packages
        .iter()
        .map(|package| package.id.repr.as_str())
        .collect();
    for link in &index.native_links {
        if !current_packages.contains(link.package_id.as_str()) {
            report.diagnostics.push(format!(
                "native link package absent from current Cargo metadata: {}",
                link.package_id
            ));
            continue;
        }
        for raw in &link.linked_libs {
            let name = link_name(raw).to_string();
            let paths = candidate_files(link, raw);
            if paths.is_empty() {
                let lib = Library {
                    id: id("native_library__", &[&link.package_id, raw, "unavailable"]),
                    name: name.clone(),
                    artifact: None,
                    producer: None,
                    format: None,
                };
                graph.add_node(library_node(
                    &lib,
                    &link.package_id,
                    Some("linked library artifact not found in recorded linker paths"),
                ));
                report.diagnostics.push(format!(
                    "native artifact unavailable for {raw} linked by {}",
                    link.package_id
                ));
                libraries.push(lib);
                linking_packages.push(link.package_id.clone());
                continue;
            }
            for artifact in paths {
                // Cargo reports a linker search/output scope, not the writer of
                // every file in that directory. Preserve the linking package
                // separately; producer ownership needs an explicit writer fact.
                let producer = None;
                let lib = Library {
                    id: id("native_library__", &[artifact.as_str()]),
                    name: name.clone(),
                    artifact: Some(artifact),
                    producer,
                    format: None,
                };
                libraries.push(lib);
                linking_packages.push(link.package_id.clone());
            }
        }
    }
    report.libraries = libraries.len();
    let crate_ids: BTreeMap<String, String> = graph
        .node_values()
        .filter(|node| {
            node.attributes
                .get("kind")
                .is_some_and(|kind| kind == "crate")
        })
        .filter_map(|node| Some((node.attributes.get("package_id")?.clone(), node.id.clone())))
        .collect();
    for (library, package_id) in libraries.iter().zip(&linking_packages) {
        if let Some(crate_id) = crate_ids.get(package_id) {
            graph.add_edge(crate_id, &library.id, "links_native", None, None);
        }
    }
    let mut functions = Vec::new();
    for (lib, linking_package) in libraries.iter_mut().zip(&linking_packages) {
        let Some(artifact) = lib.artifact.as_ref() else {
            continue;
        };
        let output = Command::new("objdump")
            .args([
                "--disassemble",
                "--reloc",
                "--syms",
                "--show-all-symbols",
                "--no-show-raw-insn",
            ])
            .arg(artifact.as_std_path())
            .output();
        match output {
            Ok(output) if output.status.success() => {
                let text = String::from_utf8_lossy(&output.stdout);
                let parsed = parse_disassembly(&text, artifact, lib);
                lib.format = text.lines().find_map(|line| {
                    object_header(line.trim()).map(|(_, format)| format.to_string())
                });
                if lib
                    .format
                    .as_deref()
                    .is_some_and(|format| !supported_instruction_set(format))
                {
                    let diagnostic = format!(
                        "unsupported instruction set for direct-call extraction: {}",
                        lib.format.as_deref().unwrap()
                    );
                    graph.add_node(library_node(lib, linking_package, Some(&diagnostic)));
                    report.diagnostics.push(format!("{diagnostic}: {artifact}"));
                } else if parsed.is_empty() {
                    graph.add_node(library_node(lib, linking_package, Some("no disassemblable named functions; stripped symbols or unsupported format")));
                    report
                        .diagnostics
                        .push(format!("no disassemblable named functions: {artifact}"));
                } else {
                    graph.add_node(library_node(lib, linking_package, None));
                }
                functions.extend(parsed);
            }
            Ok(output) => {
                let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
                graph.add_node(library_node(
                    lib,
                    linking_package,
                    Some(&format!("objdump failed: {error}")),
                ));
                report
                    .diagnostics
                    .push(format!("objdump failed for {artifact}: {error}"));
            }
            Err(error) => {
                graph.add_node(library_node(
                    lib,
                    linking_package,
                    Some(&format!("objdump unavailable: {error}")),
                ));
                report
                    .diagnostics
                    .push(format!("objdump unavailable for {artifact}: {error}"));
            }
        }
    }
    let mut by_symbol: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    let unique_indices = unique_function_indices(&functions);
    for (index, function) in functions.iter().enumerate() {
        if unique_indices.binary_search(&index).is_ok() {
            by_symbol
                .entry(symbol_key(&function.symbol, &function.format).to_string())
                .or_default()
                .push(index);
        }
        let mut node = Node::new(function.id.clone(), &function.symbol, "function")
            .attr("language", "native")
            .attr("native_symbol", &function.symbol)
            .attr("native_artifact", function.artifact.as_str())
            .attr("native_library_id", &function.library_id)
            .attr("native_object_member", &function.member)
            .attr("native_format", &function.format)
            .attr("native_call_coverage", "partial")
            .attr("native_analysis_scope", NATIVE_ANALYSIS_SCOPE)
            .attr(
                "native_symbol_binding",
                match function.binding {
                    SymbolBinding::Global => "global",
                    SymbolBinding::Local => "local",
                    SymbolBinding::Unknown => "unknown",
                },
            )
            .attr("body_status", "native_disassembly")
            .attr("native_evidence", "object disassembly");
        if let Some(address) = function.address {
            node = node.attr("native_address", format!("{address:x}"));
        }
        if let Some(package) = &function.producer {
            node = node.attr("package_id", package);
        }
        graph.add_node(node);
    }
    report.functions = unique_indices.len();

    let flows = flow_nodes(graph);
    let final_symbols = final_rust_symbols(&index, &mut report.diagnostics);
    for &index in &unique_indices {
        let function = &functions[index];
        let mut unresolved = Vec::new();
        let mut proven = Vec::new();
        for call in &function.calls {
            let Some(symbol) = &call.symbol else {
                report.unresolved += 1;
                let boundary_id =
                    add_unavailable_boundary(graph, function, call, "indirect_or_unknown_target");
                report.boundaries += 1;
                unresolved.push(json!({"address": format!("{:x}", call.address), "boundary_id": boundary_id, "reason": "indirect_or_unknown_target"}));
                continue;
            };
            let key = symbol_key(symbol, &function.format);
            let candidates = by_symbol.get(key).map(Vec::as_slice).unwrap_or(&[]);
            let selected = resolve_native_target(function, candidates, &functions, &final_symbols);
            if let Some(target) = selected {
                graph.add_edge(
                    &function.id,
                    &functions[target].id,
                    "native_calls",
                    None,
                    None,
                );
                proven.push(json!({"address": format!("{:x}", call.address), "symbol": symbol, "target_id": functions[target].id, "evidence": call.evidence, "source_artifact": function.artifact.as_str()}));
                report.direct_calls += 1;
            } else {
                // The relocation and the Rust export must coexist in one
                // final linked output. A global same-name flow is insufficient.
                let rust_targets: BTreeSet<&str> = if candidates.is_empty() {
                    flows
                        .iter()
                        .filter(|(_, _, link_symbol, _)| {
                            link_symbol
                                .as_deref()
                                .is_some_and(|s| symbol_key(s, &function.format) == key)
                        })
                        .filter(|(_, _, _, artifacts)| {
                            artifacts.iter().any(|artifact| {
                                final_symbols.get(artifact).is_some_and(|names| {
                                    names
                                        .iter()
                                        .any(|name| symbol_key(name, &function.format) == key)
                                        && names.iter().any(|name| {
                                            symbol_key(name, &function.format)
                                                == symbol_key(&function.symbol, &function.format)
                                        })
                                })
                            })
                        })
                        .map(|(id, _, _, _)| id.as_str())
                        .collect()
                } else {
                    BTreeSet::new()
                };
                if rust_targets.len() == 1 {
                    graph.add_edge(
                        &function.id,
                        *rust_targets.first().unwrap(),
                        "native_calls",
                        None,
                        None,
                    );
                    proven.push(json!({"address": format!("{:x}", call.address), "symbol": symbol, "target_id": rust_targets.first().unwrap(), "evidence": format!("{}+final_symbol_table", call.evidence), "source_artifact": function.artifact.as_str()}));
                    report.direct_calls += 1;
                } else {
                    report.unresolved += 1;
                    let reason = if candidates.len() > 1 || rust_targets.len() > 1 {
                        "ambiguous_definition"
                    } else {
                        "definition_unavailable"
                    };
                    let boundary_id = add_unavailable_boundary(graph, function, call, reason);
                    report.boundaries += 1;
                    report.direct_calls += 1;
                    proven.push(json!({"address": format!("{:x}", call.address), "symbol": symbol, "target_id": boundary_id, "evidence": call.evidence, "resolution": "symbol_boundary", "source_artifact": function.artifact.as_str()}));
                    unresolved.push(json!({"address": format!("{:x}", call.address), "symbol": symbol, "boundary_id": boundary_id, "evidence": call.evidence, "reason": reason}));
                }
            }
        }
        if let Some(node) = graph.node_mut(&function.id) {
            if !proven.is_empty() {
                node.attributes.insert(
                    "native_direct_calls".into(),
                    Value::Array(proven).to_string(),
                );
            }
            if !unresolved.is_empty() {
                node.attributes.insert(
                    "native_call_diagnostics".into(),
                    Value::Array(unresolved).to_string(),
                );
            }
        }
    }

    for (node_id, mut flow, _, _) in flows {
        let Some(blocks) = flow.get_mut("blocks").and_then(Value::as_array_mut) else {
            continue;
        };
        let mut changed = false;
        for (block_index, block) in blocks.iter_mut().enumerate() {
            let Some(call) = block.get("native_call") else {
                continue;
            };
            let Some(symbol) = call.get("symbol").and_then(Value::as_str) else {
                continue;
            };
            let names: BTreeSet<&str> = call
                .get("libraries")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(link_name)
                .collect();
            let callee_package = block.get("callee_package_id").and_then(Value::as_str);
            let candidates = ffi_candidates(
                &functions,
                &libraries,
                &linking_packages,
                symbol,
                &names,
                callee_package,
            );
            if candidates.len() == 1 {
                block["native_target_ids"] = json!([candidates[0].id]);
                if let Some(object) = block.as_object_mut() {
                    object.remove("native_resolution");
                }
                graph.add_edge(&node_id, &candidates[0].id, "native_calls", None, None);
                report.ffi_targets += 1;
                changed = true;
            } else {
                report.unresolved += 1;
                let reason = if candidates.is_empty() {
                    "artifact_or_definition_unavailable"
                } else {
                    "ambiguous_definition"
                };
                if let Some(boundary_id) =
                    add_ffi_symbol_boundary(graph, &node_id, block_index, block, reason)
                {
                    block["native_target_ids"] = json!([boundary_id]);
                    report.boundaries += 1;
                } else if let Some(object) = block.as_object_mut() {
                    object.remove("native_target_ids");
                }
                block["native_resolution"] = json!(reason);
                changed = true;
            }
        }
        if changed {
            if let Some(node) = graph.node_mut(&node_id) {
                node.attributes.insert("flow".into(), flow.to_string());
            }
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lib() -> Library {
        Library {
            id: "library".into(),
            name: "boundary".into(),
            artifact: Some("/tmp/libboundary.a".into()),
            producer: None,
            format: None,
        }
    }

    #[test]
    fn elf_relocation_overrides_branch_placeholder_and_indirect_remains_unknown() {
        let output = "/tmp/libboundary.a(entry.o): file format elf64-x86-64\n\n0000000000000000 <boundary_c_entry>:\n   0: callq 0x0 <boundary_c_entry+0x5>\n   1: R_X86_64_PLT32 boundary_helper-0x4\n   5: callq *%rax\n0000000000000007 <boundary_helper>:\n   7: retq\n";
        let fns = parse_disassembly(output, Utf8Path::new("/tmp/libboundary.a"), &lib());
        assert_eq!(fns.len(), 2);
        assert_eq!(fns[0].calls[0].symbol.as_deref(), Some("boundary_helper"));
        assert_eq!(fns[0].calls[0].evidence, "relocation");
        assert_eq!(fns[0].calls[1].symbol, None);
    }

    #[test]
    fn macho_prefix_is_removed_only_for_proven_macho_format() {
        let output = "/tmp/libboundary.a(entry.o):\tfile format mach-o arm64\n0000000000000000 <_boundary_helper>:\n0000000000000000 <ltmp0>:\n       0: ret\n0000000000000004 <_boundary_c_entry>:\n       4: bl 0x4 <_boundary_c_entry+0x0>\n       4: ARM64_RELOC_BRANCH26 _boundary_helper\n       8: blr x8\n";
        let fns = parse_disassembly(output, Utf8Path::new("/tmp/libboundary.a"), &lib());
        assert_eq!(fns.len(), 2);
        assert_eq!(
            symbol_key(&fns[1].symbol, &fns[1].format),
            "boundary_c_entry"
        );
        assert_eq!(fns[1].calls[0].symbol.as_deref(), Some("_boundary_helper"));
        assert_eq!(fns[1].calls[1].symbol, None);
        assert_eq!(symbol_key("__Z3foov", "mach-o arm64"), "_Z3foov");
        assert_eq!(symbol_key("_Z3foov", "elf64-x86-64"), "_Z3foov");
    }

    #[test]
    fn private_definition_is_not_an_ffi_target() {
        let output = "/tmp/libboundary.a(entry.o):\tfile format mach-o arm64\nSYMBOL TABLE:\n0000000000000000 l F __TEXT,__text _private_entry\n0000000000000004 g F __TEXT,__text _public_entry\nDisassembly of section __TEXT,__text:\n0000000000000000 <_private_entry>:\n  0: ret\n0000000000000004 <_public_entry>:\n  4: ret\n";
        let functions = parse_disassembly(output, Utf8Path::new("/tmp/libboundary.a"), &lib());
        let names = BTreeSet::from(["boundary"]);
        let packages = vec!["native-sys".to_string()];
        assert_eq!(functions[0].binding, SymbolBinding::Local);
        assert_eq!(functions[1].binding, SymbolBinding::Global);
        assert!(
            ffi_candidates(
                &functions,
                &[lib()],
                &packages,
                "private_entry",
                &names,
                Some("native-sys")
            )
            .is_empty()
        );
        assert_eq!(
            ffi_candidates(
                &functions,
                &[lib()],
                &packages,
                "public_entry",
                &names,
                Some("native-sys")
            )
            .len(),
            1
        );
    }

    #[test]
    fn unrelated_artifact_name_does_not_prove_native_call() {
        let caller_text = "/tmp/one.a(one.o): file format mach-o arm64\nSYMBOL TABLE:\n0000000000000000 g F __TEXT,__text _entry\nDisassembly of section __TEXT,__text:\n0000000000000000 <_entry>:\n  0: bl 0x0 <_entry>\n  0: ARM64_RELOC_BRANCH26 _helper\n";
        let target_text = "/tmp/two.a(two.o): file format mach-o arm64\nSYMBOL TABLE:\n0000000000000000 g F __TEXT,__text _helper\nDisassembly of section __TEXT,__text:\n0000000000000000 <_helper>:\n  0: ret\n";
        let caller = parse_disassembly(caller_text, Utf8Path::new("/tmp/one.a"), &lib()).remove(0);
        let target = parse_disassembly(target_text, Utf8Path::new("/tmp/two.a"), &lib()).remove(0);
        assert_eq!(
            resolve_native_target(&caller, &[0], &[target], &BTreeMap::new()),
            None
        );
    }

    #[test]
    fn repeated_artifact_identity_does_not_create_ambiguous_targets() {
        let output = "/tmp/libboundary.a(entry.o):\tfile format mach-o arm64\nSYMBOL TABLE:\n0000000000000000 g F __TEXT,__text _entry\n0000000000000004 g F __TEXT,__text _helper\nDisassembly of section __TEXT,__text:\n0000000000000000 <_entry>:\n  0: bl 0x0 <_entry>\n  0: ARM64_RELOC_BRANCH26 _helper\n0000000000000004 <_helper>:\n  4: ret\n";
        let mut functions = parse_disassembly(output, Utf8Path::new("/tmp/libboundary.a"), &lib());
        functions.extend(parse_disassembly(
            output,
            Utf8Path::new("/tmp/libboundary.a"),
            &lib(),
        ));
        let other_library = Library {
            id: "other_library".into(),
            artifact: Some("/tmp/other.a".into()),
            ..lib()
        };
        let other_output = "/tmp/other.a(other.o):\tfile format mach-o arm64\nSYMBOL TABLE:\n0000000000000000 g F __TEXT,__text _helper\nDisassembly of section __TEXT,__text:\n0000000000000000 <_helper>:\n  0: ret\n";
        functions.extend(parse_disassembly(
            other_output,
            Utf8Path::new("/tmp/other.a"),
            &other_library,
        ));
        let unique = unique_function_indices(&functions);
        assert_eq!(functions.len(), 5);
        assert_eq!(unique, vec![0, 1, 4]);
        assert_eq!(
            resolve_native_target(
                &functions[0],
                &[unique[1], unique[2]],
                &functions,
                &BTreeMap::new()
            ),
            Some(1)
        );
        let libraries = vec![lib(), lib(), other_library];
        let packages = vec!["pkg".to_string(), "pkg".to_string(), "other".to_string()];
        let names = BTreeSet::from(["boundary"]);
        assert_eq!(
            ffi_candidates(
                &functions,
                &libraries,
                &packages,
                "helper",
                &names,
                Some("pkg")
            )
            .len(),
            1
        );
        assert_eq!(
            ffi_candidates(&functions, &libraries, &packages, "helper", &names, None).len(),
            2
        );
    }

    #[test]
    fn bare_macho_labels_take_first_instruction_address() {
        let output = "/tmp/libboundary.a(entry.o): file format mach-o arm64\n_first:\n  10: ret\n_second:\n  20: ret\n";
        let functions = parse_disassembly(output, Utf8Path::new("/tmp/libboundary.a"), &lib());
        assert_eq!(
            functions
                .iter()
                .map(|function| function.address)
                .collect::<Vec<_>>(),
            vec![Some(0x10), Some(0x20)]
        );
        assert_ne!(functions[0].id, functions[1].id);
    }

    #[test]
    fn unsupported_instruction_set_has_partial_coverage_without_invented_calls() {
        let output = "/tmp/libother.a(other.o):\tfile format elf64-littleriscv\nSYMBOL TABLE:\n0000000000000000 g F .text 0000000000000008 entry\nDisassembly of section .text:\n0000000000000000 <entry>:\n  0: jal 0x4 <helper>\n";
        let functions = parse_disassembly(output, Utf8Path::new("/tmp/libother.a"), &lib());
        assert_eq!(functions.len(), 1);
        assert!(functions[0].calls.is_empty());
        let library = Library {
            format: Some("elf64-littleriscv".into()),
            ..lib()
        };
        let node = library_node(&library, "package", Some("unsupported instruction set"));
        assert_eq!(node.attributes["native_call_coverage"], "partial");
        assert_eq!(
            node.attributes["native_instruction_set_status"],
            "unsupported"
        );
    }

    #[test]
    fn unresolved_direct_symbol_has_visible_boundary_without_claiming_ownership() {
        let output = "/tmp/libboundary.a(entry.o):\tfile format mach-o arm64\nSYMBOL TABLE:\n0000000000000000 g F __TEXT,__text _entry\nDisassembly of section __TEXT,__text:\n0000000000000000 <_entry>:\n  0: bl 0x0 <_entry>\n  0: ARM64_RELOC_BRANCH26 _external_callback\n  4: blr x8\n";
        let functions = parse_disassembly(output, Utf8Path::new("/tmp/libboundary.a"), &lib());
        let caller = &functions[0];
        let mut graph = Graph::new();
        graph
            .add_node(Node::new(caller.id.clone(), "entry", "function").attr("language", "native"));
        let boundary = add_unavailable_boundary(
            &mut graph,
            caller,
            &caller.calls[0],
            "definition_unavailable",
        );
        let node = graph.node(&boundary).unwrap();
        assert_eq!(node.attributes["native_symbol"], "_external_callback");
        assert_eq!(node.attributes["native_boundary_kind"], "unresolved_symbol");
        assert_eq!(node.attributes["body_status"], "unavailable");
        assert!(node.attributes.get("package_id").is_none());
        assert!(node.attributes.get("native_artifact").is_none());
        assert!(node.attributes.get("native_library_id").is_none());
        assert!(graph.edge_values().any(|edge| edge.source == caller.id
            && edge.target == boundary
            && edge.relation == "native_calls"));
        let unknown = add_unavailable_boundary(
            &mut graph,
            caller,
            &caller.calls[1],
            "indirect_or_unknown_target",
        );
        assert_eq!(
            graph.node(&unknown).unwrap().attributes["native_boundary_kind"],
            "indirect_call"
        );
        assert_ne!(boundary, unknown);
    }

    #[test]
    fn out_dir_link_scope_does_not_establish_artifact_writer() {
        let out = Utf8PathBuf::from_path_buf(std::env::temp_dir().join(format!("build-graph-native-writer-{}-{:?}", std::process::id(), std::thread::current().id()))).unwrap();
        let native = out.join("native");
        fs::create_dir_all(&native).unwrap();
        // Artifact lookup and even failed disassembly retain the consumer/link
        // evidence. Neither a path nor a filename proves who wrote this file.
        fs::write(native.join("libwriter_unknown.a"), b"unavailable object format").unwrap();
        fs::write(out.join("driver-artifacts-v1.json"), json!({"version":1,"rust_artifacts":[],"native_links":[{
            "package_id":"fixture@1","linked_libs":["static=writer_unknown"],"linked_paths":[format!("native={native}")],"out_dir":native
        }]}).to_string()).unwrap();
        let meta: Metadata = serde_json::from_value(json!({
            "packages":[{"name":"fixture","version":"0.1.0","id":"fixture@1","manifest_path":"/fixture/Cargo.toml","dependencies":[],"targets":[],"features":{}}],
            "workspace_members":["fixture@1"],"resolve":null,"workspace_root":"/fixture","target_directory":"/fixture/target","version":1
        })).unwrap();
        let mut graph = Graph::new();
        add_native_layer(&mut graph, &meta, &out).unwrap();
        let libraries: Vec<_> = graph.node_values().filter(|node| node.attributes.get("kind").map(String::as_str) == Some("native_library")).collect();
        assert_eq!(libraries.len(), 1);
        assert_eq!(libraries[0].attributes["linking_package_id"], "fixture@1");
        assert_eq!(libraries[0].attributes["native_artifact"], native.join("libwriter_unknown.a").as_str());
        assert_eq!(libraries[0].attributes["native_producer_status"], "unknown");
        assert!(!libraries[0].attributes.contains_key("package_id"));
        fs::remove_dir_all(out).unwrap();
    }

    #[test]
    fn no_native_artifact_entries_still_expose_raw_ffi_endpoint() {
        let out = Utf8PathBuf::from_path_buf(std::env::temp_dir().join(format!(
            "build-graph-no-native-artifact-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        )))
        .unwrap();
        fs::create_dir_all(&out).unwrap();
        fs::write(
            out.join("driver-artifacts-v1.json"),
            r#"{"version":1,"rust_artifacts":[],"native_links":[]}"#,
        )
        .unwrap();
        let meta: Metadata = serde_json::from_value(json!({
            "packages": [], "workspace_members": [], "resolve": null,
            "workspace_root": "/tmp", "target_directory": "/tmp/target", "version": 1
        }))
        .unwrap();
        let mut graph = Graph::new();
        graph.add_node(Node::new("flow".into(), "flow", "flow_function")
            .attr("flow", json!({"blocks":[{"native_call":{"symbol":"missing_c_symbol","abi":"C","libraries":["missing_native"]}}]}).to_string()));
        let report = add_native_layer(&mut graph, &meta, &out).unwrap();
        fs::remove_dir_all(&out).unwrap();
        assert_eq!(report.ffi_targets, 0);
        assert_eq!(report.boundaries, 1);
        assert_eq!(report.unresolved, 1);
        let flow: Value =
            serde_json::from_str(&graph.node("flow").unwrap().attributes["flow"]).unwrap();
        let boundary_id = flow["blocks"][0]["native_target_ids"][0].as_str().unwrap();
        let boundary = graph.node(boundary_id).unwrap();
        assert_eq!(boundary.attributes["native_boundary_kind"], "ffi_symbol");
        assert_eq!(boundary.attributes["body_status"], "unavailable");
        assert!(boundary.attributes.get("flow").is_none());
        assert!(boundary.attributes.get("package_id").is_none());
        assert_eq!(
            flow["blocks"][0]["native_resolution"],
            "artifact_or_definition_unavailable"
        );
        assert!(graph.edge_values().any(|edge| edge.source == "flow"
            && edge.target == boundary_id
            && edge.relation == "native_calls"));
    }

    #[test]
    fn missing_artifact_index_removes_stale_native_targets() {
        let mut graph = Graph::new();
        graph.add_node(Node::new("old_library".into(), "old", "native_library"));
        graph.add_node(
            Node::new("old_function".into(), "old", "function").attr("language", "native"),
        );
        graph.add_node(Node::new("flow".into(), "flow", "flow_function")
            .attr("flow", json!({"blocks":[{"native_call":{"symbol":"gone","abi":"C","libraries":["gone"]},"callee_package_id":"path+file:///fixture#decl@0.1.0","native_target_ids":["old_function"]}]}).to_string()));
        graph.add_edge("flow", "old_function", "native_calls", None, None);
        graph.add_edge("flow", "old_library", "links_native", None, None);
        let meta: Metadata = serde_json::from_value(json!({
            "packages": [], "workspace_members": [], "resolve": null,
            "workspace_root": "/tmp", "target_directory": "/tmp/target", "version": 1
        }))
        .unwrap();
        let out = Utf8PathBuf::from_path_buf(std::env::temp_dir().join(format!(
                "build-graph-missing-native-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            )))
        .unwrap();
        let report = add_native_layer(&mut graph, &meta, &out).unwrap();
        assert_eq!(report.unresolved, 1);
        assert_eq!(report.boundaries, 1);
        assert_eq!(report.functions, 0);
        assert!(!graph.contains("old_library"));
        assert!(!graph.contains("old_function"));
        assert!(
            graph
                .edge_values()
                .all(|edge| edge.target != "old_function" && edge.relation != "links_native")
        );
        let flow: Value =
            serde_json::from_str(&graph.node("flow").unwrap().attributes["flow"]).unwrap();
        let boundary_id = flow["blocks"][0]["native_target_ids"][0].as_str().unwrap();
        let boundary = graph.node(boundary_id).unwrap();
        assert_eq!(boundary.attributes["native_boundary_kind"], "ffi_symbol");
        assert_eq!(boundary.attributes["body_status"], "unavailable");
        assert_eq!(boundary.attributes["native_symbol"], "gone");
        assert_eq!(boundary.attributes["native_abi"], "C");
        assert_eq!(
            boundary.attributes["native_declaration_package_id"],
            "path+file:///fixture#decl@0.1.0"
        );
        assert!(boundary.attributes.get("package_id").is_none());
        assert!(boundary.attributes.get("flow").is_none());
        assert!(graph.edge_values().any(|edge| edge.source == "flow"
            && edge.target == boundary_id
            && edge.relation == "native_calls"));
        assert_eq!(
            flow["blocks"][0]["native_resolution"],
            "artifact_index_unavailable"
        );
    }
}
