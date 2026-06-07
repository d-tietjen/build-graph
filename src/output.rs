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

use crate::graph::GraphJson;

const VIEWER_TEMPLATE: &str = include_str!("viewer.html");
/// Replaced with the JSON payload; lives inside a `<script type="application/json">`.
const PLACEHOLDER: &str = "/*__GRAPH_DATA__*/";
/// Replaced with the filename the viewer fetches when the data isn't inlined —
/// `graph.json.gz` (compressed) or `graph.json` (plain). The viewer sniffs the
/// fetched bytes for gzip magic and inflates if needed, so this is just a hint.
const SRC_PLACEHOLDER: &str = "__GRAPH_SRC__";
/// Replaced with the dashboard title shown in the sidebar.
const TITLE_PLACEHOLDER: &str = "__GRAPH_TITLE__";

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

/// Write `graph.json[.gz]` + `graph.html` into `out_dir`. When `compress`, the
/// data is written as `graph.json.gz` and any stale plain `graph.json` is
/// removed (and vice-versa) so exactly one canonical form is on disk.
pub fn write_graph(out_dir: &Path, doc: &GraphJson, compress: bool) -> io::Result<()> {
    write_graph_with_title(out_dir, doc, compress, "build-graph")
}

/// Write a graph using a custom sidebar title in `graph.html`.
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
        .replace(TITLE_PLACEHOLDER, &escape_html(title));

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
