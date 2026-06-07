//! A resident query server so the graph is parsed **once** instead of on every
//! CLI call. `serve` loads the graph into memory and answers `find` / `refs` /
//! `context` requests over a localhost socket; the matching CLI commands proxy
//! to it (and silently fall back to a direct load if it isn't running).
//!
//! Protocol: one JSON [`Request`] line in, the rendered result (text or JSON)
//! out, then the connection closes. The server writes its port to
//! `<out>/.build-graph-serve` so the client can find it without re-running
//! `cargo metadata`. A stale file (server died) just means `connect` fails and
//! the client falls back — it self-heals.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use camino::Utf8Path;
use serde::{Deserialize, Serialize};

use build_graph::GraphJson;

use crate::{query, render};

/// The name of the per-graph file holding the running server's port.
pub const PORT_FILE: &str = ".build-graph-serve";

/// A query sent to the server. Fields mirror the CLI options (already clamped /
/// defaulted by the caller); `json` selects the rendered output format.
#[derive(Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Request {
    Find {
        query: String,
        exact: bool,
        kind: Option<String>,
        krate: Option<String>,
        at: Option<(String, u32)>,
        limit: usize,
        json: bool,
    },
    Refs {
        query: String,
        relation: Option<String>,
        incoming: bool,
        outgoing: bool,
        name_match: Option<String>,
        kind: Option<String>,
        krate: Option<String>,
        limit: usize,
        depth: usize,
        json: bool,
    },
    Context {
        query: String,
        per_group: usize,
        json: bool,
    },
}

/// Run a query against the prebuilt index and render the result.
fn handle(ix: &query::Index, req: Request) -> String {
    match req {
        Request::Find {
            query: q,
            exact,
            kind,
            krate,
            at,
            limit,
            json,
        } => {
            let opts = query::FindOpts {
                query: q,
                exact,
                kind,
                krate,
                at,
                limit: limit.clamp(1, 100),
            };
            render::find(&query::find_indexed(ix, &opts), json)
        }
        Request::Refs {
            query: q,
            relation,
            incoming,
            outgoing,
            name_match,
            kind,
            krate,
            limit,
            depth,
            json,
        } => {
            let opts = query::RefsOpts {
                query: q,
                relation,
                incoming,
                outgoing,
                name_match,
                kind,
                krate,
                limit: limit.clamp(1, 200),
                depth: depth.clamp(1, 5),
            };
            let result = query::refs_indexed(ix, &opts);
            render::refs(&result, &opts.query, json)
        }
        Request::Context {
            query: q,
            per_group,
            json,
        } => {
            let result = query::context_indexed(ix, &q, per_group.clamp(1, 25));
            render::context(&result, &q, json)
        }
    }
}

fn handle_conn(stream: TcpStream, ix: &query::Index) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let mut stream = stream;
    let resp = match serde_json::from_str::<Request>(line.trim()) {
        Ok(req) => handle(ix, req),
        Err(e) => format!("error: bad request ({e})\n"),
    };
    stream.write_all(resp.as_bytes())?;
    stream.flush()
}

/// Load-once server: hold `doc` in memory and answer queries until killed.
/// Each connection is handled on its own thread (the graph is shared read-only).
pub fn serve(doc: GraphJson, out_dir: &Utf8Path, addr: &str, port: u16) -> Result<()> {
    let listener =
        TcpListener::bind((addr, port)).with_context(|| format!("binding {addr}:{port}"))?;
    let bound = listener.local_addr()?.port();
    let port_file = out_dir.join(PORT_FILE);
    std::fs::write(port_file.as_std_path(), bound.to_string())
        .with_context(|| format!("writing {port_file}"))?;
    eprintln!(
        "[build-graph] serve: graph held in memory; listening on {addr}:{bound}\n\
         [build-graph] serve: find/refs/context in this workspace now use it — Ctrl-C to stop"
    );

    // Build the lookup index once; every query reuses it (this is the whole
    // point — O(degree) refs and O(1)/hit ranking instead of rescanning edges).
    // Single-threaded: queries are now fast enough that serializing them is fine,
    // and it keeps the index a plain borrow of `doc`.
    let index = query::Index::build(&doc);
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        stream.set_read_timeout(Some(Duration::from_secs(30))).ok();
        let _ = handle_conn(stream, &index);
    }
    let _ = std::fs::remove_file(port_file.as_std_path());
    Ok(())
}

/// Locate a running server's port file without `cargo metadata`: an explicit
/// out dir if given, else the nearest `target/build-graph/<PORT_FILE>` walking
/// up from the current directory.
fn port_file(explicit_out: Option<&Utf8Path>) -> Option<PathBuf> {
    if let Some(out) = explicit_out {
        let p = out.join(PORT_FILE);
        return p.as_std_path().exists().then(|| p.into_std_path_buf());
    }
    let mut dir = std::env::current_dir().ok()?;
    loop {
        let p = dir.join("target/build-graph").join(PORT_FILE);
        if p.exists() {
            return Some(p);
        }
        if !dir.pop() {
            return None;
        }
    }
}

/// Try to answer `req` via a running server. Returns the rendered response, or
/// `None` if no server is reachable (the caller then loads the graph directly).
pub fn try_remote(explicit_out: Option<&Utf8Path>, req: &Request) -> Option<String> {
    let pf = port_file(explicit_out)?;
    let port: u16 = std::fs::read_to_string(&pf).ok()?.trim().parse().ok()?;
    let mut stream = TcpStream::connect(("127.0.0.1", port)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(60))).ok();
    let body = serde_json::to_string(req).ok()?;
    stream.write_all(body.as_bytes()).ok()?;
    stream.write_all(b"\n").ok()?;
    stream.shutdown(Shutdown::Write).ok();
    let mut resp = String::new();
    stream.read_to_string(&mut resp).ok()?;
    Some(resp)
}
