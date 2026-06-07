//! Minimal static file server used by `view` when the graph is too large to
//! inline. Such a `graph.html` fetches `graph.json` at runtime, and browsers
//! refuse `fetch()` over `file://` — so we serve the output directory on a
//! loopback port instead. Pure `std` (no extra deps, no Python), one thread per
//! connection, blocks until the process is interrupted.

use std::fs::File;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;

use anyhow::{Context, Result};

/// A "fetch-mode" `graph.html` (written for large graphs) carries an empty data
/// script and loads `graph.json` over HTTP. Detect it by that empty marker —
/// the script tag lives near the top of the document, so the first chunk is
/// enough.
pub fn needs_http(html_path: &Path) -> Result<bool> {
    let mut f =
        File::open(html_path).with_context(|| format!("opening {}", html_path.display()))?;
    let mut buf = [0u8; 64 * 1024];
    let n = f.read(&mut buf)?;
    let head = String::from_utf8_lossy(&buf[..n]);
    Ok(head.contains(r#"id="graph-data"></script>"#))
}

/// Serve `dir` on a free loopback port, open `page` in the browser (unless
/// `open` is false), then block handling requests until interrupted.
pub fn serve_and_open(dir: &Path, page: &str, open: bool) -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").context("binding a loopback HTTP port")?;
    let port = listener
        .local_addr()
        .context("reading the server address")?
        .port();
    let url = format!("http://127.0.0.1:{port}/{page}");
    eprintln!("[build-graph] serving {} at {url}", dir.display());
    eprintln!("[build-graph] (this graph loads graph.json over HTTP — press Ctrl-C to stop)");
    if open {
        // Best-effort: a failed launch shouldn't stop us from serving.
        if let Err(e) = crate::open_in_browser(&url) {
            eprintln!("[build-graph] could not open a browser ({e}); visit {url}");
        }
    }
    for stream in listener.incoming() {
        match stream {
            Ok(s) => {
                let root = dir.to_path_buf();
                std::thread::spawn(move || {
                    if let Err(e) = handle(s, &root) {
                        eprintln!("[build-graph] request error: {e}");
                    }
                });
            }
            Err(e) => eprintln!("[build-graph] connection error: {e}"),
        }
    }
    Ok(())
}

/// Handle one connection: read the request line, serve the file, close.
fn handle(stream: TcpStream, root: &Path) -> io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    // Drain remaining headers (unused) so the client write side is satisfied.
    let mut header = String::new();
    loop {
        header.clear();
        let n = reader.read_line(&mut header)?;
        if n == 0 || header == "\r\n" || header == "\n" {
            break;
        }
    }
    let raw_path = request_line.split_whitespace().nth(1).unwrap_or("/");
    let mut stream = stream;
    serve_path(&mut stream, root, raw_path)
}

fn serve_path(stream: &mut TcpStream, root: &Path, raw_path: &str) -> io::Result<()> {
    let without_query = raw_path.split('?').next().unwrap_or("");
    let rel = without_query.trim_start_matches('/');
    let rel = if rel.is_empty() { "graph.html" } else { rel };
    // Refuse path traversal — only files under `root` are served.
    if rel.split('/').any(|seg| seg == ".." || seg == ".") {
        return write_status(stream, "403 Forbidden", b"forbidden");
    }
    let path = root.join(rel);
    match File::open(&path) {
        Ok(mut file) => {
            let len = file.metadata().map(|m| m.len()).unwrap_or(0);
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {len}\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\n\r\n",
                content_type(&path)
            );
            stream.write_all(head.as_bytes())?;
            io::copy(&mut file, stream)?;
            Ok(())
        }
        Err(_) => write_status(stream, "404 Not Found", b"not found"),
    }
}

fn write_status(stream: &mut TcpStream, status: &str, body: &[u8]) -> io::Result<()> {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("json") => "application/json",
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        // Serve the gzip data as an opaque payload (no `Content-Encoding: gzip`):
        // the viewer inflates it itself, so we must not let the browser auto-
        // decode it first (that would leave the viewer decompressing plain JSON).
        Some("gz") => "application/gzip",
        _ => "application/octet-stream",
    }
}
