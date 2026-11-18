//! Write a graph to disk: `graph.json` (graphify schema) plus a `graph.html`
//! viewer. Small graphs inline their data into the HTML (so it opens from
//! `file://` without hitting fetch/CORS restrictions); large graphs leave the
//! data out and the viewer fetches the graph data at runtime (so the HTML stays
//! small instead of becoming a multi-hundred-MB document the browser must parse
//! on load — such a graph is served over HTTP, see `INLINE_LIMIT`).
//!
//! The graph data is gzip-compressed at rest by default (`graph.json.gz`,
//! ~35x smaller on a large workspace). Reads transparently decompress (the
//! format is detected by gzip's magic bytes, not the extension), and the
//! viewer inflates a fetched payload in-browser via `DecompressionStream`.
//!
//! Writes are atomic (temp file + rename) so concurrent build scripts during a
//! parallel `cargo build` never observe or produce a torn file.

use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;

use crate::export::{EXPORT_FILE, EXPORT_SCHEMA_VERSION, ExportManifest};
use crate::graph::GraphJson;

const VIEWER_TEMPLATE: &str = include_str!("viewer.html");
const EXECUTION_FLOW_JS: &str = include_str!("execution-flow.js");
const FLOW_MAP_JS: &str = include_str!("flow-map.js");
const CALL_GRAPH_JS: &str = include_str!("call-graph.js");
const ARCHITECTURE_ORGANIZATION_JS: &str = include_str!("architecture-organization.js");
const SUPPLY_CHAIN_JS: &str = include_str!("supply-chain.js");
const EXECUTION_MODEL_JS: &str = include_str!("execution-model.js");
const VALUE_FLOW_JS: &str = include_str!("value-flow.js");
const FAILURE_OBLIGATIONS_JS: &str = include_str!("failure-obligations.js");
const RESOURCE_RISKS_JS: &str = include_str!("resource-risks.js");
const GUARD_OBLIGATIONS_JS: &str = include_str!("guard-obligations.js");
const ANALYSIS_SNAPSHOT_JS: &str = include_str!("analysis-snapshot.js");
const REVISION_COMPARISON_JS: &str = include_str!("revision-comparison.js");
const TEST_CANDIDATES_JS: &str = include_str!("test-candidates.js");
const COMMENT_SEARCH_JS: &str = include_str!("comment-search.js");
const PERFORMANCE_MEASUREMENTS_JS: &str = include_str!("performance-measurements.js");
const ANALYSIS_EVIDENCE_JS: &str = include_str!("analysis-evidence.js");
const PROGRAM_QUERIES_JS: &str = include_str!("program-queries.js");
const CALL_PATHS_JS: &str = include_str!("call-paths.js");
const ADVISORY_EXPOSURE_JS: &str = include_str!("advisory-exposure.js");
const ENTRY_EFFECTS_JS: &str = include_str!("entry-effects.js");
const EXECUTION_MODEL_VIEW_JS: &str = include_str!("execution-model-view.js");
const TRACE_WATERFALL_JS: &str = include_str!("trace-waterfall.js");
/// Replaced with the JSON payload; lives inside a `<script type="application/json">`.
const PLACEHOLDER: &str = "/*__GRAPH_DATA__*/";
/// Replaced with the filename the viewer fetches when the data isn't inlined —
/// `graph.json.gz` (compressed) or `graph.json` (plain). The viewer sniffs the
/// fetched bytes for gzip magic and inflates if needed, so this is just a hint.
const SRC_PLACEHOLDER: &str = "__GRAPH_SRC__";
/// Replaced with the capture name in the browser tab title.
const TITLE_PLACEHOLDER: &str = "__GRAPH_TITLE__";
const FLOW_JS_PLACEHOLDER: &str = "/*__EXECUTION_FLOW_JS__*/";
const FLOW_MAP_JS_PLACEHOLDER: &str = "/*__FLOW_MAP_JS__*/";
const CALL_GRAPH_JS_PLACEHOLDER: &str = "/*__CALL_GRAPH_JS__*/";
const ARCHITECTURE_ORGANIZATION_JS_PLACEHOLDER: &str = "/*__ARCHITECTURE_ORGANIZATION_JS__*/";
const SUPPLY_CHAIN_JS_PLACEHOLDER: &str = "/*__SUPPLY_CHAIN_JS__*/";
const EXECUTION_MODEL_JS_PLACEHOLDER: &str = "/*__EXECUTION_MODEL_JS__*/";
const VALUE_FLOW_JS_PLACEHOLDER: &str = "/*__VALUE_FLOW_JS__*/";
const FAILURE_OBLIGATIONS_JS_PLACEHOLDER: &str = "/*__FAILURE_OBLIGATIONS_JS__*/";
const RESOURCE_RISKS_JS_PLACEHOLDER: &str = "/*__RESOURCE_RISKS_JS__*/";
const GUARD_OBLIGATIONS_JS_PLACEHOLDER: &str = "/*__GUARD_OBLIGATIONS_JS__*/";
const ANALYSIS_SNAPSHOT_JS_PLACEHOLDER: &str = "/*__ANALYSIS_SNAPSHOT_JS__*/";
const REVISION_COMPARISON_JS_PLACEHOLDER: &str = "/*__REVISION_COMPARISON_JS__*/";
const TEST_CANDIDATES_JS_PLACEHOLDER: &str = "/*__TEST_CANDIDATES_JS__*/";
const COMMENT_SEARCH_JS_PLACEHOLDER: &str = "/*__COMMENT_SEARCH_JS__*/";
const PERFORMANCE_MEASUREMENTS_JS_PLACEHOLDER: &str = "/*__PERFORMANCE_MEASUREMENTS_JS__*/";
const ANALYSIS_EVIDENCE_JS_PLACEHOLDER: &str = "/*__ANALYSIS_EVIDENCE_JS__*/";
const PROGRAM_QUERIES_JS_PLACEHOLDER: &str = "/*__PROGRAM_QUERIES_JS__*/";
const CALL_PATHS_JS_PLACEHOLDER: &str = "/*__CALL_PATHS_JS__*/";
const ADVISORY_EXPOSURE_JS_PLACEHOLDER: &str = "/*__ADVISORY_EXPOSURE_JS__*/";
const ENTRY_EFFECTS_JS_PLACEHOLDER: &str = "/*__ENTRY_EFFECTS_JS__*/";
const EXECUTION_MODEL_VIEW_JS_PLACEHOLDER: &str = "/*__EXECUTION_MODEL_VIEW_JS__*/";
const TRACE_WATERFALL_JS_PLACEHOLDER: &str = "/*__TRACE_WATERFALL_JS__*/";

/// The plain (uncompressed) graph data filename.
pub const GRAPH_JSON: &str = "graph.json";
/// The gzip-compressed graph data filename (the default at-rest form).
pub const GRAPH_JSON_GZ: &str = "graph.json.gz";

/// Compact-JSON payloads larger than this are not inlined into `graph.html`.
/// Instead the data script is left empty and the viewer fetches the graph data
/// at runtime — keeping the HTML small and avoiding handing the browser a
/// multi-hundred-MB inline document. A graph this large must be served over
/// HTTP (browsers block `file://` fetches, and it's impractical to open from
/// `file://` regardless). 32 MiB inlines fine; a whole large workspace's graph
/// (~140 MB compact) does not. Measured against the *uncompressed* size so the
/// inline decision doesn't depend on how well a given graph compresses.
const INLINE_LIMIT: usize = 32 * 1024 * 1024;

/// gzip's two-byte magic header (`1f 8b`).
fn is_gzip(bytes: &[u8]) -> bool {
    bytes.len() >= 2 && bytes[0] == 0x1f && bytes[1] == 0x8b
}

/// Atomically write `bytes` to `path` (temp file in the same dir + rename).
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("build-graph.out");
    // Distinct per process so parallel build scripts don't clash on the temp.
    let tmp = parent.join(format!("{file_name}.tmp.{}", std::process::id()));
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

/// gzip `bytes` at a balanced level (6 — ~35x on a large graph, ~1s to write).
fn gzip(bytes: &[u8]) -> io::Result<Vec<u8>> {
    let mut enc = GzEncoder::new(Vec::new(), Compression::new(6));
    enc.write_all(bytes)?;
    enc.finish()
}

fn escape_html(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

/// The canonical graph data file in `out_dir`, if one exists. Prefers the
/// compressed `graph.json.gz` (the default), falling back to a plain
/// `graph.json`. Used to locate a graph to query or reload without caring which
/// form a previous run wrote.
pub fn find_graph(out_dir: &Path) -> Option<PathBuf> {
    let gz = out_dir.join(GRAPH_JSON_GZ);
    if gz.exists() {
        return Some(gz);
    }
    let plain = out_dir.join(GRAPH_JSON);
    plain.exists().then_some(plain)
}

/// Read a graph document from `path`, transparently inflating it if it's gzip.
/// Detection is by content (magic bytes), so a `graph.json` that happens to be
/// gzip-compressed, or a `graph.json.gz` that isn't, are both handled correctly.
pub fn read_graph(path: &Path) -> io::Result<GraphJson> {
    let bytes = fs::read(path)?;
    if is_gzip(&bytes) {
        let mut json = Vec::new();
        GzDecoder::new(&bytes[..]).read_to_end(&mut json)?;
        serde_json::from_slice(&json).map_err(io::Error::other)
    } else {
        serde_json::from_slice(&bytes).map_err(io::Error::other)
    }
}

/// Read a supported export sidecar. Absence or an unsupported version is an
/// error, rather than inferred extraction completeness.
pub fn read_export(out_dir: &Path) -> io::Result<ExportManifest> {
    let manifest: ExportManifest =
        serde_json::from_slice(&fs::read(out_dir.join(EXPORT_FILE))?).map_err(io::Error::other)?;
    if manifest.schema_version != EXPORT_SCHEMA_VERSION {
        return Err(io::Error::other(
            "unsupported build-graph export schema version",
        ));
    }
    if let Some(observation) = &manifest.compiler_invocations {
        observation.validate().map_err(io::Error::other)?;
    }
    Ok(manifest)
}

/// Atomically replace the export sidecar. The graph is a separate atomic
/// write; consumers should call [`ExportManifest::matches_graph`] before reuse.
pub fn write_export(out_dir: &Path, manifest: &ExportManifest) -> io::Result<()> {
    if let Some(observation) = &manifest.compiler_invocations {
        observation.validate().map_err(io::Error::other)?;
    }
    let bytes = serde_json::to_vec(manifest).map_err(io::Error::other)?;
    write_atomic(&out_dir.join(EXPORT_FILE), &bytes)
}

/// Write `graph.json[.gz]` + `graph.html` into `out_dir`. When `compress`, the
/// data is written as `graph.json.gz` and any stale plain `graph.json` is
/// removed (and vice-versa) so exactly one canonical form is on disk.
pub fn write_graph(out_dir: &Path, doc: &GraphJson, compress: bool) -> io::Result<()> {
    write_graph_with_title(out_dir, doc, compress, "build-graph")
}

/// Write a graph using a custom browser tab title in `graph.html`.
pub fn write_graph_with_title(
    out_dir: &Path,
    doc: &GraphJson,
    compress: bool,
    title: &str,
) -> io::Result<()> {
    fs::create_dir_all(out_dir)?;

    // Compact, not pretty: this graph can be hundreds of MB, so dropping the
    // indentation meaningfully shrinks it on disk, speeds up `find`/`refs` (which
    // reparse it per call), and cuts the viewer's fetch. It stays deterministic
    // (nodes/edges are sorted), so it still diffs cleanly across rebuilds.
    let compact = serde_json::to_string(doc).map_err(io::Error::other)?;

    // Write exactly one canonical data file and sweep the other form so a
    // reader (which prefers .gz) never picks up a stale graph from a prior run
    // with the opposite setting.
    let (src_name, stale) = if compress {
        write_atomic(&out_dir.join(GRAPH_JSON_GZ), &gzip(compact.as_bytes())?)?;
        (GRAPH_JSON_GZ, GRAPH_JSON)
    } else {
        write_atomic(&out_dir.join(GRAPH_JSON), compact.as_bytes())?;
        (GRAPH_JSON, GRAPH_JSON_GZ)
    };
    let _ = fs::remove_file(out_dir.join(stale));

    // Bake the fetch source into the template first (before the — potentially
    // huge — data is embedded), so the substitution can't touch node labels.
    let template = VIEWER_TEMPLATE
        .replace(SRC_PLACEHOLDER, src_name)
        .replace(TITLE_PLACEHOLDER, &escape_html(title))
        .replace(FLOW_JS_PLACEHOLDER, EXECUTION_FLOW_JS)
        .replace(FLOW_MAP_JS_PLACEHOLDER, FLOW_MAP_JS)
        .replace(CALL_GRAPH_JS_PLACEHOLDER, CALL_GRAPH_JS)
        .replace(ARCHITECTURE_ORGANIZATION_JS_PLACEHOLDER, ARCHITECTURE_ORGANIZATION_JS)
        .replace(SUPPLY_CHAIN_JS_PLACEHOLDER, SUPPLY_CHAIN_JS)
        .replace(EXECUTION_MODEL_JS_PLACEHOLDER, EXECUTION_MODEL_JS)
        .replace(VALUE_FLOW_JS_PLACEHOLDER, VALUE_FLOW_JS)
        .replace(GUARD_OBLIGATIONS_JS_PLACEHOLDER, GUARD_OBLIGATIONS_JS)
        .replace(FAILURE_OBLIGATIONS_JS_PLACEHOLDER, FAILURE_OBLIGATIONS_JS)
        .replace(RESOURCE_RISKS_JS_PLACEHOLDER, RESOURCE_RISKS_JS)
        .replace(ANALYSIS_EVIDENCE_JS_PLACEHOLDER, ANALYSIS_EVIDENCE_JS)
        .replace(PROGRAM_QUERIES_JS_PLACEHOLDER, PROGRAM_QUERIES_JS)
        .replace(ANALYSIS_SNAPSHOT_JS_PLACEHOLDER, ANALYSIS_SNAPSHOT_JS)
        .replace(REVISION_COMPARISON_JS_PLACEHOLDER, REVISION_COMPARISON_JS)
        .replace(TEST_CANDIDATES_JS_PLACEHOLDER, TEST_CANDIDATES_JS)
        .replace(COMMENT_SEARCH_JS_PLACEHOLDER, COMMENT_SEARCH_JS)
        .replace(
            PERFORMANCE_MEASUREMENTS_JS_PLACEHOLDER,
            PERFORMANCE_MEASUREMENTS_JS,
        )
        .replace(CALL_PATHS_JS_PLACEHOLDER, CALL_PATHS_JS)
        .replace(ADVISORY_EXPOSURE_JS_PLACEHOLDER, ADVISORY_EXPOSURE_JS)
        .replace(ENTRY_EFFECTS_JS_PLACEHOLDER, ENTRY_EFFECTS_JS)
        .replace(EXECUTION_MODEL_VIEW_JS_PLACEHOLDER, EXECUTION_MODEL_VIEW_JS)
        .replace(TRACE_WATERFALL_JS_PLACEHOLDER, TRACE_WATERFALL_JS);

    // The inline decision is on the *uncompressed* size: a graph that's small
    // enough to embed stays a self-contained, file://-openable document.
    let html = if compact.len() <= INLINE_LIMIT {
        // `<` keeps the JSON valid while preventing a stray `</script>` in any
        // label from closing the embedding tag early.
        let embedded = compact.replace('<', "\\u003c");
        template.replace(PLACEHOLDER, &embedded)
    } else {
        // Too large to inline: empty data script → the viewer fetches the data
        // file (`src_name`) at runtime (serve the output dir over HTTP).
        template.replace(PLACEHOLDER, "")
    };
    write_atomic(&out_dir.join("graph.html"), html.as_bytes())?;

    let report = crate::report::render(doc);
    write_atomic(&out_dir.join("GRAPH_REPORT.md"), report.as_bytes())?;

    Ok(())
}
