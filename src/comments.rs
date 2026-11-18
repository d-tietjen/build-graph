//! Bounded Rust comment observations. Effective docs retain compiler ownership;
//! local tokens are never used to guess a declaration by name or proximity.
use std::collections::{BTreeMap, HashMap};
use std::io::Read;
use std::path::{Path, PathBuf};

use build_graph::{Graph, Node, file_id, norm};
use serde::Serialize;
use sha2::{Digest, Sha256};

pub const EXTRACTOR: &str = "rust-comments-v1";
const MAX_FILE: usize = 4 * 1024 * 1024;
const MAX_SOURCE: usize = 32 * 1024 * 1024;
const MAX_FILES: usize = 10_000;
const MAX_RECORDS: usize = 10_000;
const MAX_TEXT: usize = 65_536;
const MAX_CORPUS: usize = 8 * 1024 * 1024;

pub fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn read(path: &Path) -> Option<Vec<u8>> {
    let file = std::fs::File::open(path).ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    file.take((MAX_FILE + 1) as u64)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() <= MAX_FILE).then_some(bytes)
}

/// Pre-rustdoc local source observation, bounded independently of graph size.
/// Symlinks and files outside package roots are deliberately unsupported.
pub struct Before {
    files: HashMap<PathBuf, String>,
    pub partial: bool,
}
impl Before {
    pub fn capture(roots: &[PathBuf]) -> Self {
        let mut result = Self {
            files: HashMap::new(),
            partial: false,
        };
        let mut bytes = 0;
        let mut visited = 0;
        for root in roots {
            for entry in walkdir::WalkDir::new(root)
                .follow_links(false)
                .into_iter()
                .filter_entry(|e| {
                    !matches!(
                        e.file_name().to_str(),
                        Some("target" | ".git" | "node_modules" | ".graphify")
                    )
                })
            {
                visited += 1;
                if visited > MAX_FILES * 4 {
                    result.partial = true;
                    return result;
                }
                let Ok(entry) = entry else {
                    result.partial = true;
                    continue;
                };
                if !entry.file_type().is_file()
                    || entry.path().extension().is_none_or(|e| e != "rs")
                {
                    continue;
                }
                let Some(path) = entry.path().canonicalize().ok() else {
                    result.partial = true;
                    continue;
                };
                if result.files.contains_key(&path) {
                    continue;
                }
                if result.files.len() >= MAX_FILES {
                    result.partial = true;
                    return result;
                }
                let Some(content) = read(&path) else {
                    result.partial = true;
                    continue;
                };
                bytes += content.len();
                if bytes > MAX_SOURCE {
                    result.partial = true;
                    return result;
                }
                result.files.insert(path, sha(&content));
            }
        }
        result
    }
}

/// Content-based optional rich-capture invalidation, including local Markdown.
/// A bounded/partial scan is labelled in the fingerprint and capture coverage.
pub fn fingerprint(root: &Path) -> String {
    let mut inputs = BTreeMap::new();
    let mut bytes = 0;
    let mut partial = false;
    for entry in walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            !matches!(
                e.file_name().to_str(),
                Some("target" | ".git" | "node_modules" | ".graphify")
            )
        })
        .take(MAX_FILES * 4)
    {
        let Ok(entry) = entry else {
            partial = true;
            continue;
        };
        if !entry.file_type().is_file()
            || !matches!(
                entry.path().extension().and_then(|s| s.to_str()),
                Some("rs" | "md")
            )
        {
            continue;
        }
        let Some(data) = read(entry.path()) else {
            partial = true;
            continue;
        };
        bytes += data.len();
        if bytes > MAX_SOURCE || inputs.len() >= MAX_FILES {
            partial = true;
            break;
        }
        inputs.insert(
            entry
                .path()
                .strip_prefix(root)
                .unwrap_or(entry.path())
                .to_string_lossy()
                .into_owned(),
            sha(&data),
        );
    }
    sha(
        serde_json::json!({"inputs":inputs,"partial":partial,"extractor":EXTRACTOR})
            .to_string()
            .as_bytes(),
    )
}

/// Capture-time pin for the supported Cargo/rustdoc context, independent of
/// source mtimes and artifact freshness. Contents/environment values are hashes.
/// This is bounded local observation, not exhaustive compiler-read attestation.
pub fn selected_context(
    meta: &cargo_metadata::Metadata,
    target_dir: &Path,
    toolchain: &str,
    release: bool,
    packages: &[String],
) -> serde_json::Value {
    let mut command = std::process::Command::new("rustup");
    command.args(["run", toolchain, "rustc", "-vV"]);
    let compiler = crate::capture_provenance::bounded_output(command)
        .filter(|bytes| !bytes.is_empty())
        .map(|bytes| sha(&bytes));
    selected_context_inputs(
        meta,
        target_dir,
        toolchain,
        release,
        packages,
        compiler,
        std::env::vars_os(),
    )
}

fn selected_context_inputs(
    meta: &cargo_metadata::Metadata,
    target_dir: &Path,
    toolchain: &str,
    release: bool,
    packages: &[String],
    compiler: Option<String>,
    environment_inputs: impl IntoIterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
) -> serde_json::Value {
    let cwd = std::env::current_dir()
        .ok()
        .filter(|path| path.to_str().is_some());
    let cargo_home = std::env::var_os("CARGO_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".cargo")));
    let mut paths = BTreeMap::<PathBuf, bool>::new();
    paths.insert(
        meta.workspace_root.join("Cargo.toml").into_std_path_buf(),
        true,
    );
    paths.insert(
        meta.workspace_root.join("Cargo.lock").into_std_path_buf(),
        false,
    );
    for pkg in &meta.packages {
        paths.insert(pkg.manifest_path.clone().into_std_path_buf(), true);
    }
    let mut qualified = cwd.is_some() && cargo_home.is_some() && compiler.is_some();
    for root in cwd
        .iter()
        .map(PathBuf::as_path)
        .chain([meta.workspace_root.as_std_path()])
    {
        if root.ancestors().count() > 32 {
            qualified = false;
        }
        for ancestor in root.ancestors().take(32) {
            for name in [
                ".cargo/config",
                ".cargo/config.toml",
                "rust-toolchain",
                "rust-toolchain.toml",
            ] {
                paths.entry(ancestor.join(name)).or_insert(false);
            }
        }
    }
    if let Some(home) = cargo_home {
        for name in ["config", "config.toml"] {
            paths.entry(home.join(name)).or_insert(false);
        }
    }
    let mut inputs = BTreeMap::new();
    let mut total = 0usize;
    if paths.len() > MAX_FILES {
        qualified = false;
    }
    for (path, required) in paths.into_iter().take(MAX_FILES) {
        let value = match std::fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && !required => {
                serde_json::json!({"status":"absent"})
            }
            Ok(metadata) if metadata.is_file() => match read(&path) {
                Some(bytes) if total.saturating_add(bytes.len()) <= MAX_SOURCE => {
                    total += bytes.len();
                    if matches!(
                        path.file_name().and_then(|name| name.to_str()),
                        Some("config" | "config.toml")
                    ) {
                        let config = std::str::from_utf8(&bytes)
                            .ok()
                            .and_then(|text| toml::from_str::<toml::Value>(text).ok());
                        if config.as_ref().is_none_or(|config| {
                            config.get("include").is_some()
                                || config.get("build").is_some_and(|build| {
                                    [
                                        "rustc",
                                        "rustdoc",
                                        "rustc-wrapper",
                                        "rustc-workspace-wrapper",
                                    ]
                                    .iter()
                                    .any(|key| build.get(*key).is_some())
                                        || build.get("target").is_some_and(|target| {
                                            target.to_string().contains(".json")
                                        })
                                })
                        }) {
                            qualified = false;
                        }
                    }
                    serde_json::json!({"status":"observed","sha256":sha(&bytes)})
                }
                _ => {
                    qualified = false;
                    serde_json::json!({"status":"unavailable-or-over-limit"})
                }
            },
            _ => {
                qualified = false;
                serde_json::json!({"status":"unavailable-or-unsupported"})
            }
        };
        if path.to_str().is_none() {
            qualified = false;
        }
        inputs.insert(path.to_string_lossy().into_owned(), value);
    }
    let mut environment = BTreeMap::new();
    for (key, value) in environment_inputs {
        let Some(key) = key.to_str() else {
            qualified = false;
            continue;
        };
        if key.starts_with("CARGO_")
            || key.starts_with("RUST")
            || matches!(
                key,
                "PATH"
                    | "HOME"
                    | "CC"
                    | "CXX"
                    | "AR"
                    | "CFLAGS"
                    | "CXXFLAGS"
                    | "LDFLAGS"
                    | "SDKROOT"
                    | "MACOSX_DEPLOYMENT_TARGET"
            )
        {
            if !value.is_empty()
                && (matches!(
                    key,
                    "RUSTC"
                        | "RUSTDOC"
                        | "RUSTC_WRAPPER"
                        | "RUSTC_WORKSPACE_WRAPPER"
                        | "RUST_TARGET_PATH"
                        | "CARGO_BUILD_RUSTC"
                        | "CARGO_BUILD_RUSTDOC"
                        | "CARGO_BUILD_RUSTC_WRAPPER"
                        | "CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER"
                ) || key == "CARGO_BUILD_TARGET" && value.to_string_lossy().contains(".json"))
            {
                qualified = false;
            }
            total = total
                .saturating_add(key.len())
                .saturating_add(value.as_encoded_bytes().len());
            if total > MAX_SOURCE || environment.len() >= MAX_FILES {
                qualified = false;
                break;
            }
            environment.insert(key.to_string(), sha(value.as_encoded_bytes()));
        }
    }
    let resolved = meta
        .resolve
        .as_ref()
        .filter(|resolve| resolve.nodes.len() <= MAX_FILES);
    if resolved.is_none() {
        qualified = false;
    }
    selected_context_record(
        serde_json::json!({"files":inputs,"environmentSha256":sha(serde_json::to_vec(&environment).unwrap_or_default().as_slice()),
        "resolved":resolved,"workspace":meta.workspace_root,"workingDirectory":cwd,"targetDirectory":target_dir,
        "toolchainSelection":toolchain,"compilerVersionSha256":compiler,"release":release,"selectedPackages":packages}),
        qualified,
    )
}

fn selected_context_record(inputs: serde_json::Value, qualified: bool) -> serde_json::Value {
    serde_json::json!({"schemaVersion":1,"status":if qualified {"observed-selected-context"} else {"unavailable-selected-context"},
        "sha256":sha(inputs.to_string().as_bytes()),"completeInputs":false,
        "coverage":"Bounded Cargo manifests/lock/resolved features, local/inherited/Cargo-home configuration, selected compiler version, target/profile/package selection and recognized Cargo/Rust environment controls. Compiler overrides, config includes and custom target specifications are unsupported. Arbitrary build-script, external/include and undeclared environment reads are not attested."})
}

pub fn context_qualified(context: &serde_json::Value) -> bool {
    context["schemaVersion"] == 1
        && context["status"] == "observed-selected-context"
        && context["sha256"]
            .as_str()
            .is_some_and(|hash| hash.len() == 64)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Declaration {
    pub occurrence_id: String,
    pub original_id: String,
    pub name: Option<String>,
    pub coordinate_encoding: &'static str,
    pub graph_node_id: Option<String>,
    pub path: String,
    pub kind: String,
    pub file: Option<String>,
    pub begin: Option<(usize, usize)>,
    pub end: Option<(usize, usize)>,
    pub docs: Option<String>,
    pub has_body: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Range {
    start_byte: usize,
    end_byte: usize,
    begin: (usize, usize),
    end: (usize, usize),
    encoding: &'static str,
}
fn position(text: &str, offset: usize) -> (usize, usize) {
    let prefix = &text[..offset];
    (
        prefix.bytes().filter(|b| *b == b'\n').count() + 1,
        prefix.rsplit('\n').next().unwrap_or("").chars().count(),
    )
}
fn range(text: &str, start: usize, end: usize) -> Range {
    Range {
        start_byte: start,
        end_byte: end,
        begin: position(text, start),
        end: position(text, end),
        encoding: "utf8-bytes; one-based-line/zero-based-unicode-scalar-column; end-exclusive",
    }
}
fn offset(text: &str, at: (usize, usize)) -> Option<usize> {
    if at.0 == 0 {
        return None;
    }
    let mut start = 0;
    for _ in 1..at.0 {
        start += text.get(start..)?.find('\n')? + 1;
    }
    let line = text.get(start..)?.split('\n').next()?;
    Some(
        start
            + if at.1 == line.chars().count() {
                line.len()
            } else {
                line.char_indices().nth(at.1)?.0
            },
    )
}
#[derive(Clone)]
struct Token {
    start: usize,
    end: usize,
    kind: &'static str,
}
#[derive(Clone)]
struct Lexed {
    comments: Vec<Token>,
    code: Vec<Token>,
    complete: bool,
}

// This lexer recognizes strings before examining comment delimiters. Unknown or
// unterminated literals stop extraction; no content after them is fabricated.
fn lex(text: &str) -> Lexed {
    let b = text.as_bytes();
    let mut out = Lexed {
        comments: Vec::new(),
        code: Vec::new(),
        complete: true,
    };
    let mut i = 0;
    while i < b.len() {
        let start = i;
        if b[i..].starts_with(b"//") {
            i += 2;
            while i < b.len() && b[i] != b'\n' && b[i] != b'\r' {
                i += 1;
            }
            let kind = if b[start..].starts_with(b"///") && !b[start..].starts_with(b"////") {
                "outer-line-doc"
            } else if b[start..].starts_with(b"//!") {
                "inner-line-doc"
            } else {
                "line"
            };
            // A contiguous run is one exact source record, retaining the
            // intervening newline/indentation. No logical text is synthesized.
            let merged = out.comments.last_mut().is_some_and(|previous| {
                let gap = &text[previous.end..start];
                if previous.kind == kind
                    && gap.chars().all(char::is_whitespace)
                    && gap.bytes().filter(|b| *b == b'\n').count() == 1
                {
                    previous.end = i;
                    true
                } else {
                    false
                }
            });
            if !merged {
                out.comments.push(Token {
                    start,
                    end: i,
                    kind,
                });
            }
            continue;
        }
        if b[i..].starts_with(b"/*") {
            i += 2;
            let mut depth = 1usize;
            while i < b.len() && depth > 0 {
                if b[i..].starts_with(b"/*") {
                    depth += 1;
                    i += 2;
                } else if b[i..].starts_with(b"*/") {
                    depth -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            if depth != 0 {
                out.complete = false;
                break;
            }
            let kind = if b[start..].starts_with(b"/**")
                && !b[start..].starts_with(b"/***")
                && !b[start..].starts_with(b"/**/")
            {
                "outer-block-doc"
            } else if b[start..].starts_with(b"/*!") {
                "inner-block-doc"
            } else {
                "block"
            };
            out.comments.push(Token {
                start,
                end: i,
                kind,
            });
            continue;
        }
        // r"", r#""#, br#""# and cr#""# (Rust C strings).
        let raw = if b[i] == b'r' {
            Some(i + 1)
        } else if (b[i] == b'b' || b[i] == b'c') && b.get(i + 1) == Some(&b'r') {
            Some(i + 2)
        } else {
            None
        };
        if let Some(mut quote) = raw {
            while b.get(quote) == Some(&b'#') {
                quote += 1;
            }
            if b.get(quote) == Some(&b'"') {
                let hashes = quote - raw.unwrap();
                i = quote + 1;
                let mut closed = false;
                while i < b.len() {
                    if b[i] == b'"'
                        && b.get(i + 1..i + 1 + hashes)
                            .is_some_and(|s| s.iter().all(|c| *c == b'#'))
                    {
                        i += 1 + hashes;
                        closed = true;
                        break;
                    }
                    i += 1;
                }
                if !closed {
                    out.complete = false;
                    break;
                }
                out.code.push(Token {
                    start,
                    end: i,
                    kind: "literal",
                });
                continue;
            }
        }
        if b[i] == b'"' {
            i += 1;
            let mut closed = false;
            while i < b.len() {
                if b[i] == b'\\' {
                    i = (i + 2).min(b.len());
                } else if b[i] == b'"' {
                    i += 1;
                    closed = true;
                    break;
                } else {
                    i += 1;
                }
            }
            if !closed {
                out.complete = false;
                break;
            }
            out.code.push(Token {
                start,
                end: i,
                kind: "literal",
            });
            continue;
        }
        if b[i] == b'\'' {
            let mut end = i + 1;
            if b.get(end) == Some(&b'\\') {
                end += 1;
                if b.get(end) == Some(&b'u') && b.get(end + 1) == Some(&b'{') {
                    end += 2;
                    while end < b.len() && b[end] != b'}' {
                        end += 1;
                    }
                    end += 1;
                } else if b.get(end) == Some(&b'x') {
                    end += 3;
                } else {
                    end += 1;
                }
            } else if let Some(ch) = text.get(end..).and_then(|s| s.chars().next()) {
                end += ch.len_utf8();
            }
            if b.get(end) == Some(&b'\'') {
                i = end + 1;
                out.code.push(Token {
                    start,
                    end: i,
                    kind: "literal",
                });
                continue;
            }
        }
        let ch = text[i..].chars().next().unwrap();
        if ch.is_whitespace() {
            i += ch.len_utf8();
            continue;
        }
        if ch.is_alphanumeric() || ch == '_' {
            i += ch.len_utf8();
            while i < b.len() {
                let ch = text[i..].chars().next().unwrap();
                if !ch.is_alphanumeric() && ch != '_' {
                    break;
                }
                i += ch.len_utf8();
            }
            out.code.push(Token {
                start,
                end: i,
                kind: "word",
            });
        } else {
            i += ch.len_utf8();
            out.code.push(Token {
                start,
                end: i,
                kind: "punctuation",
            });
        }
        if out.code.len() + out.comments.len() > 500_000 {
            out.complete = false;
            break;
        }
    }
    out
}

// Only simple, lexer-confirmed function declaration/body geometry is supported.
// Generic/where/const signature braces, macros and nested unsupported items fence
// the entire body; false negatives are explicitly preferable to wrong ownership.
fn body(text: &str, code: &[Token], declaration: &Declaration) -> Option<(usize, usize)> {
    if !declaration.has_body || text.starts_with('\u{feff}') || text.contains('\r') {
        return None;
    }
    // rustdoc normalizes source before lookup_char_pos. The pinned producer
    // exports line/CharPos+1 and exclusive span.hi. BOM/CRLF stay unowned above.
    let begin = declaration.begin?;
    let finish = declaration.end?;
    let start = offset(text, (begin.0, begin.1.checked_sub(1)?))?;
    let end = offset(text, (finish.0, finish.1.checked_sub(1)?))?;
    let tokens: Vec<_> = code
        .iter()
        .filter(|t| t.start >= start && t.end <= end)
        .collect();
    let words: Vec<_> = tokens.iter().map(|t| &text[t.start..t.end]).collect();
    let fun = words.iter().position(|s| *s == "fn")?;
    let name_at = if words.get(fun + 1) == Some(&"r") && words.get(fun + 2) == Some(&"#") {
        fun + 3
    } else {
        fun + 1
    };
    if words.get(name_at).copied() != declaration.name.as_deref() {
        return None;
    }
    let mut paren = 0usize;
    let mut params = false;
    let mut opened = None;
    for i in fun + 1..words.len() {
        let word = words[i];
        if matches!(word, "<" | "where" | "!" | ";") {
            return None;
        }
        if word == "(" {
            paren += 1;
            params = true;
        }
        if word == ")" {
            paren = paren.checked_sub(1)?;
        }
        if word == "{" {
            if paren != 0 || !params {
                return None;
            }
            opened = Some(i);
            break;
        }
    }
    let open = opened?;
    let mut depth = 0usize;
    let mut close = None;
    for i in open..words.len() {
        let word = words[i];
        if i > open
            && matches!(
                word,
                "fn" | "mod" | "impl" | "trait" | "struct" | "enum" | "union" | "!" | "|"
            )
        {
            return None;
        }
        if word == "{" {
            depth += 1;
        }
        if word == "}" {
            depth = depth.checked_sub(1)?;
            if depth == 0 {
                close = Some(i);
                break;
            }
        }
    }
    let close = close?;
    if close + 1 != words.len() {
        return None;
    }
    Some((tokens[open].end, tokens[close].start))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    id: String,
    kind: String,
    text: String,
    occurrence_id: Option<String>,
    graph_node_id: Option<String>,
    file_node_id: Option<String>,
    file: Option<String>,
    source_absolute: Option<String>,
    range: Option<Range>,
    declaration: Option<Declaration>,
    ownership: &'static str,
    source_status: String,
    source_sha256: Option<String>,
}

/// Preserve one independently owned corpus per package/target/export. Its graph
/// carrier uses the existing item namespace so incremental crate removal works.
pub fn attach(
    graph: &mut Graph,
    root: &Path,
    before: &Before,
    declarations: Vec<Declaration>,
    package: &str,
    package_id: &str,
    target: serde_json::Value,
    artifact_sha: &str,
    build: serde_json::Value,
    export_current: bool,
) {
    let scope = serde_json::json!({"packageId":package_id,"target":target});
    let scope_sha = sha(scope.to_string().as_bytes());
    let build_sha = sha(build.to_string().as_bytes());
    let mut post_bytes = 0usize;
    let mut source_pins = BTreeMap::<String, serde_json::Value>::new();
    let mut files = BTreeMap::<String, (String, String, Lexed)>::new();
    let mut diagnostics = vec![
        "Effective Markdown cites compiler declaration geometry, not original documentation token ranges. Included/expanded/cfg source origin is unverified.",
    ];
    if before.partial {
        diagnostics.push("Pre-export source scan reached a bound or unavailable input; source coverage is partial.");
    }
    for d in &declarations {
        let Some(file) = &d.file else { continue };
        if source_pins.contains_key(file) {
            continue;
        }
        let local = root.join(file);
        let canonical = local.canonicalize().ok();
        let pre = canonical.as_ref().and_then(|p| before.files.get(p));
        let bytes = if pre.is_some() { read(&local) } else { None };
        let post = bytes.as_ref().map(|b| sha(b));
        let status = if pre.is_none() {
            "missing-generated-or-unsupported-source"
        } else if post.as_ref() != pre {
            "stale-source"
        } else {
            "matching-local-observation"
        };
        source_pins.insert(
            file.clone(),
            serde_json::json!({"file":file,"status":status,"beforeSha256":pre,"afterSha256":post}),
        );
        if status == "matching-local-observation" {
            if let Some(text) = bytes.and_then(|b| String::from_utf8(b).ok()) {
                let lexed = lex(&text);
                if !lexed.complete {
                    diagnostics.push("A source lexer stopped at unsupported/unterminated geometry or its token bound; later comments are missing.");
                }
                files.insert(file.clone(), (text, post.unwrap(), lexed));
            }
        }
    }
    let mut records = Vec::new();
    let mut retained = 0;
    let mut push = |record: Record| {
        let size = serde_json::to_vec(&record)
            .map(|v| v.len())
            .unwrap_or(MAX_CORPUS + 1);
        if records.len() < MAX_RECORDS && retained + size <= MAX_CORPUS {
            retained += size;
            records.push(record);
            true
        } else {
            false
        }
    };
    let mut omitted = 0usize;
    for d in &declarations {
        let Some(docs) = &d.docs else { continue };
        if docs.len() > MAX_TEXT {
            omitted += 1;
            continue;
        }
        let pin = d.file.as_ref().and_then(|f| source_pins.get(f));
        let mut original = d.clone();
        original.docs = None;
        if !push(Record {
            id: sha(format!("{}:effective", d.occurrence_id).as_bytes()),
            kind: "effective-doc".into(),
            text: docs.clone(),
            occurrence_id: Some(d.occurrence_id.clone()),
            graph_node_id: d.graph_node_id.clone(),
            file_node_id: d.file.as_ref().map(|f| file_id(package, f)),
            file: d.file.clone(),
            source_absolute: d
                .file
                .as_ref()
                .and_then(|f| root.join(f).canonicalize().ok())
                .map(|p| p.to_string_lossy().into_owned()),
            range: None,
            declaration: Some(original),
            ownership: "compiler-original-occurrence",
            source_status: if !export_current {
                "stale-or-unverified-export".into()
            } else {
                pin.and_then(|p| p["status"].as_str())
                    .unwrap_or("missing-or-generated-declaration-source")
                    .into()
            },
            source_sha256: pin
                .and_then(|p| p["afterSha256"].as_str())
                .map(str::to_string),
        }) {
            omitted += 1;
        }
    }
    let mut geometry_work = 0usize;
    let mut comment_ordinals = BTreeMap::<(String, String), usize>::new();
    for (file, (text, digest, lexed)) in &files {
        let mut owners = Vec::new();
        for d in declarations
            .iter()
            .filter(|d| d.file.as_ref() == Some(file))
        {
            geometry_work = geometry_work.saturating_add(lexed.code.len() + text.len());
            if geometry_work > 16_000_000 {
                break;
            }
            if let Some(span) = body(text, &lexed.code, d) {
                owners.push((d, span));
            }
        }
        for c in &lexed.comments {
            if c.end - c.start > MAX_TEXT {
                omitted += 1;
                continue;
            }
            geometry_work = geometry_work.saturating_add(c.end.saturating_mul(2) + owners.len());
            if geometry_work > 16_000_000 {
                omitted += 1;
                continue;
            }
            let candidates: Vec<_> = owners
                .iter()
                .filter(|(_, (s, e))| c.start >= *s && c.end <= *e)
                .collect();
            let owner =
                if export_current && candidates.len() == 1 && matches!(c.kind, "line" | "block") {
                    Some(candidates[0].0)
                } else {
                    None
                };
            let mut declaration = owner.cloned();
            if let Some(d) = &mut declaration {
                d.docs = None;
            }
            // An exact owner plus source-order ordinal identifies this token
            // independently of absolute byte shifts caused by earlier docs.
            // Geometry/source pins remain current-snapshot evidence, not keys.
            let owner_key = owner
                .map(|d| d.occurrence_id.clone())
                .unwrap_or_else(|| format!("file:{file}"));
            let ordinal = comment_ordinals
                .entry((owner_key.clone(), c.kind.into()))
                .or_default();
            let id = sha(serde_json::json!([scope_sha, owner_key, c.kind, *ordinal])
                .to_string()
                .as_bytes());
            *ordinal += 1;
            if !push(Record {
                id,
                kind: c.kind.into(),
                text: text[c.start..c.end].into(),
                occurrence_id: owner.map(|d| d.occurrence_id.clone()),
                graph_node_id: owner.and_then(|d| d.graph_node_id.clone()),
                file_node_id: Some(file_id(package, file)),
                file: Some(file.clone()),
                source_absolute: root
                    .join(file)
                    .canonicalize()
                    .ok()
                    .map(|p| p.to_string_lossy().into_owned()),
                range: Some(range(text, c.start, c.end)),
                declaration,
                ownership: if owner.is_some() {
                    "exact-supported-body"
                } else {
                    "file-unattached"
                },
                source_status: "matching-local-observation".into(),
                source_sha256: Some(digest.clone()),
            }) {
                omitted += 1;
            }
        }
    }
    drop(push);
    records.sort_by(|a, b| a.id.cmp(&b.id));
    let sources: Vec<_> = source_pins.into_values().collect();
    let source_snapshot_sha = sha(serde_json::to_vec(&sources).unwrap().as_slice());
    let corpus = serde_json::json!({"schemaVersion":1,"extractor":EXTRACTOR,"scope":scope,"scopeSha256":scope_sha,
        "artifactSha256":artifact_sha,"build":build,"buildSha256":build_sha,"sourceSnapshotSha256":source_snapshot_sha,
        "exportStatus":if export_current {"successful-rustdoc-observation"} else {"stale-or-unverified-export"},
        "sourcePins":sources,"records":records,"coverage":{"partial":before.partial || omitted > 0 || !export_current || !diagnostics.is_empty(),
            "omittedRecords":omitted,"diagnostics":diagnostics,"hermeticSourceProof":false,"unsupported":"External/generated/non-UTF8 source, cfg-disabled items, unknown nested/macro/closure/generic-body ownership are not inferred."}});
    graph.add_node(
        Node::new(
            format!(
                "item__{}__comment_corpus_{}__metadata",
                norm(package),
                scope_sha
            ),
            format!("{package} comments"),
            "comment_corpus",
        )
        .attr("crate", package)
        .attr("package_id", package_id)
        .attr("comment_corpus", corpus.to_string()),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_nested_unicode_and_string_negatives() {
        let text = "//! inner\nfn f() { let s = r###\"// nope /* no */\"###; let c = '/'; // café 🦀\n/* a /* nested */ b */ }";
        let parsed = lex(text);
        assert!(parsed.complete);
        assert_eq!(parsed.comments.len(), 3);
        assert_eq!(parsed.comments[0].kind, "inner-line-doc");
        assert_eq!(
            &text[parsed.comments[1].start..parsed.comments[1].end],
            "// café 🦀"
        );
        let r = range(text, parsed.comments[1].start, parsed.comments[1].end);
        assert_eq!(offset(text, r.begin), Some(r.start_byte));
        assert_eq!(offset(text, r.end), Some(r.end_byte));
        assert_eq!(
            &text[parsed.comments[2].start..parsed.comments[2].end],
            "/* a /* nested */ b */"
        );
    }
    #[test]
    fn literal_forms_lifetimes_and_unterminated_boundaries() {
        let parsed = lex(
            "fn f<'a>() { b\"//\"; c\"/*\"; br#\"//\"#; cr#\"/*\"#; '\\''; '\\u{1f980}'; } /** doc */ //// ordinary\n/**/ /*! inner */ /* missing",
        );
        assert!(!parsed.complete);
        assert_eq!(
            parsed.comments.iter().map(|c| c.kind).collect::<Vec<_>>(),
            vec!["outer-block-doc", "line", "block", "inner-block-doc"]
        );
    }
    fn declaration(text: &str) -> Declaration {
        Declaration {
            occurrence_id: "o".into(),
            original_id: "r".into(),
            name: Some("f".into()),
            coordinate_encoding: "one-based-line/one-based-unicode-scalar-column; end-exclusive; normalized compiler source",
            graph_node_id: Some("node".into()),
            path: "f".into(),
            kind: "function".into(),
            file: Some("src.rs".into()),
            begin: Some((1, 1)),
            end: Some({
                let p = position(text, text.len());
                (p.0, p.1 + 1)
            }),
            docs: None,
            has_body: true,
        }
    }
    #[test]
    fn supported_body_and_ambiguous_nested_geometry() {
        let simple = "pub fn f() { // inside\n }";
        assert!(body(simple, &lex(simple).code, &declaration(simple)).is_some());
        for text in [
            "fn f<const N: usize>() { // generic\n }",
            "fn f() { fn nested() {} // nested\n }",
            "fn f() { macro_call!(); // macro\n }",
            "fn f() -> X<{ 1 }> { // const brace\n }",
            "fn f() { let c = || {}; // closure\n }",
        ] {
            assert!(
                body(text, &lex(text).code, &declaration(text)).is_none(),
                "{text}"
            );
        }
    }
    #[test]
    fn fixed_groundtruth_ordinary_runs_are_exact_unicode_source_slices() {
        let source = include_str!("../tests/fixtures/comment-search/source.rs");
        let input: serde_json::Value = serde_json::from_str(include_str!(
            "../tests/fixtures/comment-search/model-input.json"
        ))
        .unwrap();
        let parsed = lex(source);
        assert!(parsed.complete);
        let ordinary: Vec<_> = parsed
            .comments
            .iter()
            .filter(|c| c.kind == "line")
            .collect();
        assert_eq!(ordinary.len(), 4);
        for (token, doc) in ordinary
            .iter()
            .zip(input["documents"].as_array().unwrap().iter().skip(4))
        {
            assert_eq!(
                &source[token.start..token.end],
                doc["text"].as_str().unwrap()
            );
        }
    }
    #[test]
    fn normalized_compiler_columns_are_distinct_from_exact_raw_byte_geometry() {
        let text = "fn f() { /* 🦀 */ }";
        let d = declaration(text);
        assert!(body(text, &lex(text).code, &d).is_some());
        let mut wrong = d.clone();
        wrong.end = Some((1, text.len() + 1));
        assert!(body(text, &lex(text).code, &wrong).is_none());
        for raw in ["\u{feff}fn f() { // raw\n}", "fn f() { // raw\r\n}"] {
            assert!(body(raw, &lex(raw).code, &declaration(raw)).is_none());
            assert!(!lex(raw).comments.is_empty());
        }
    }
    #[test]
    fn qualified_cache_reuses_old_mtime_only_while_artifact_source_and_context_pins_match() {
        let dir = std::env::temp_dir().join(format!("bg-comments-cache-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("src.rs");
        let text = "fn f() { // body\n}";
        std::fs::write(&source, text).unwrap();
        let before = Before::capture(&[dir.clone()]);
        let artifact = dir.join("export.json");
        let start = std::time::SystemTime::now();
        std::fs::write(&artifact, b"{}").unwrap();
        let end = std::time::SystemTime::now();
        assert!(artifact_in_window(&artifact, Some((start, end))));
        assert!(!artifact_in_window(&artifact, None));
        assert!(!artifact_in_window(
            &artifact,
            Some((
                end + std::time::Duration::from_secs(1),
                end + std::time::Duration::from_secs(2)
            ))
        ));
        let context = selected_context_record(
            serde_json::json!({"Cargo.toml":"default=[]","resolvedFeatures":[]}),
            true,
        );
        let target = serde_json::json!({"name":"lib","kind":["lib"],"source":source});
        let mut graph = Graph::new();
        let mut d = declaration(text);
        d.docs = Some("exact docs".into());
        attach(
            &mut graph,
            &dir,
            &before,
            vec![d.clone()],
            "fixture",
            "pkg",
            target.clone(),
            &sha(b"{}"),
            serde_json::json!({"artifactPath":artifact,"toolchainSelection":"pinned","release":false,"selectedContext":context}),
            true,
        );
        assert!(cache_matches(
            &graph,
            &dir,
            &dir,
            "pkg",
            "pinned",
            false,
            &[target.clone()],
            &context
        ));
        assert!(!cache_matches(
            &graph,
            &dir,
            &dir,
            "pkg",
            "other",
            false,
            &[target.clone()],
            &context
        ));
        assert!(!cache_matches(
            &graph,
            &dir,
            &dir,
            "pkg",
            "pinned",
            false,
            &[serde_json::json!({"name":"different-target"})],
            &context
        ));
        assert!(!cache_matches(
            &graph,
            &dir,
            &dir,
            "different-package-id",
            "pinned",
            false,
            &[target.clone()],
            &context
        ));
        assert!(!cache_matches(
            &graph,
            &dir,
            &dir,
            "pkg",
            "pinned",
            true,
            &[target.clone()],
            &context
        ));
        for changed_target in [
            serde_json::json!({"name":"lib","kind":["bin"],"source":source}),
            serde_json::json!({"name":"lib","kind":["lib"],"source":dir.join("different.rs")}),
        ] {
            assert!(!cache_matches(
                &graph,
                &dir,
                &dir,
                "pkg",
                "pinned",
                false,
                &[changed_target],
                &context
            ));
        }
        for changed_context in [
            selected_context_record(
                serde_json::json!({"Cargo.toml":"default=[blue]","resolvedFeatures":["blue"]}),
                true,
            ),
            selected_context_record(serde_json::json!({"config":"changed"}), true),
            selected_context_record(serde_json::json!({"environment":"changed"}), true),
            selected_context_record(serde_json::json!({"compiler":"changed"}), true),
            selected_context_record(serde_json::json!({}), false),
            serde_json::Value::Null,
        ] {
            assert!(!cache_matches(
                &graph,
                &dir,
                &dir,
                "pkg",
                "pinned",
                false,
                &[target.clone()],
                &changed_context
            ));
        }
        std::fs::write(&source, "fn f() { // changed source\n}").unwrap();
        assert!(!cache_matches(
            &graph,
            &dir,
            &dir,
            "pkg",
            "pinned",
            false,
            &[target.clone()],
            &context
        ));
        std::fs::write(&source, text).unwrap();
        std::fs::write(&artifact, b"changed").unwrap();
        assert!(!cache_matches(
            &graph,
            &dir,
            &dir,
            "pkg",
            "pinned",
            false,
            &[target.clone()],
            &context
        ));
        let mut old = Graph::new();
        attach(
            &mut old,
            &dir,
            &before,
            vec![d],
            "fixture",
            "pkg",
            target.clone(),
            &sha(b"{}"),
            serde_json::json!({}),
            false,
        );
        let corpus: serde_json::Value = serde_json::from_str(
            old.node_values()
                .next()
                .unwrap()
                .attributes
                .get("comment_corpus")
                .unwrap(),
        )
        .unwrap();
        assert_eq!(corpus["records"].as_array().unwrap().len(), 2);
        assert!(
            corpus["records"]
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["kind"] == "line" && r["ownership"] == "file-unattached")
        );
        let raw = corpus["records"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["kind"] == "line")
            .unwrap();
        assert_eq!(raw["ownership"], "file-unattached");
        assert!(raw["occurrenceId"].is_null());
        assert!(raw["declaration"].is_null());
        assert!(raw["graphNodeId"].is_null());
        assert_eq!(corpus["exportStatus"], "stale-or-unverified-export");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn selected_context_observes_manifest_features_configuration_and_missing_compiler() {
        let dir = std::env::temp_dir().join(format!("bg-comments-context-{}", std::process::id()));
        std::fs::create_dir_all(dir.join(".cargo")).unwrap();
        std::fs::write(dir.join("lib.rs"), "pub fn p() {}\n").unwrap();
        let manifest = "[package]\nname='context-fixture'\nversion='0.1.0'\nedition='2021'\n[workspace]\n[lib]\npath='lib.rs'\n[features]\ndefault=[]\nblue=[]\n";
        std::fs::write(dir.join("Cargo.toml"), manifest).unwrap();
        let mut command = cargo_metadata::MetadataCommand::new();
        command
            .manifest_path(dir.join("Cargo.toml"))
            .other_options(vec!["--offline".into()]);
        let meta = command.exec().unwrap();
        let observe = |meta: &cargo_metadata::Metadata| {
            selected_context_inputs(
                meta,
                &dir.join("target"),
                "pinned",
                false,
                &[],
                Some(sha(b"observed compiler")),
                std::env::vars_os(),
            )
        };
        let first = observe(&meta);
        assert!(context_qualified(&first));
        assert_eq!(observe(&meta), first);
        std::fs::create_dir_all(dir.join("target")).unwrap();
        let artifact = dir.join("target/export.json");
        std::fs::write(&artifact, b"{}").unwrap();
        let target = serde_json::json!({"name":"lib","kind":["lib"],"source":dir.join("lib.rs")});
        let mut graph = Graph::new();
        attach(
            &mut graph,
            &dir,
            &Before::capture(&[dir.clone()]),
            vec![],
            "context-fixture",
            "pkg",
            target.clone(),
            &sha(b"{}"),
            serde_json::json!({"artifactPath":artifact,"toolchainSelection":"pinned","release":false,"selectedContext":first}),
            true,
        );
        let cache_accepts = |context: &serde_json::Value| {
            cache_matches(
                &graph,
                &dir,
                &dir.join("target"),
                "pkg",
                "pinned",
                false,
                &[target.clone()],
                context,
            )
        };
        assert!(cache_accepts(&first));
        let reject_override = |context: serde_json::Value| {
            assert_eq!(context["status"], "unavailable-selected-context");
            assert!(!context_qualified(&context));
            assert!(!cache_accepts(&context));
        };
        for path in ["/owned/custom-rustdoc-a", "/owned/custom-rustdoc-b"] {
            std::fs::write(
                dir.join(".cargo/config.toml"),
                format!("[build]\nrustdoc='{path}'\n"),
            )
            .unwrap();
            reject_override(observe(&meta));
        }
        std::fs::remove_file(dir.join(".cargo/config.toml")).unwrap();
        assert_eq!(observe(&meta), first);
        assert!(cache_accepts(&observe(&meta)));
        for path in ["/owned/custom-rustdoc-a", "/owned/custom-rustdoc-b"] {
            reject_override(selected_context_inputs(
                &meta,
                &dir.join("target"),
                "pinned",
                false,
                &[],
                Some(sha(b"observed compiler")),
                std::env::vars_os().chain([("CARGO_BUILD_RUSTDOC".into(), path.into())]),
            ));
        }
        assert_eq!(observe(&meta), first);
        let source = std::fs::metadata(dir.join("lib.rs"))
            .unwrap()
            .modified()
            .unwrap();
        std::fs::write(
            dir.join("Cargo.toml"),
            manifest.replace("default=[]", "default=['blue']"),
        )
        .unwrap();
        let changed_meta = command.exec().unwrap();
        assert_ne!(observe(&changed_meta), first);
        assert_ne!(
            observe(&meta),
            first,
            "manifest bytes invalidate even an earlier metadata observation"
        );
        assert_eq!(
            std::fs::metadata(dir.join("lib.rs"))
                .unwrap()
                .modified()
                .unwrap(),
            source
        );
        std::fs::write(dir.join("Cargo.toml"), manifest).unwrap();
        assert_eq!(observe(&meta), first);
        std::fs::write(
            dir.join(".cargo/config.toml"),
            "[build]\nrustflags=['--cfg', 'context_change']\n",
        )
        .unwrap();
        assert_ne!(observe(&meta), first);
        assert!(!context_qualified(&selected_context_inputs(
            &meta,
            &dir,
            "pinned",
            false,
            &[],
            None,
            std::env::vars_os(),
        )));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn only_exact_qualified_current_carriers_survive_normalized_crate_removal() {
        let mut graph = Graph::new();
        for (suffix, id) in [
            ("changed", "pkg-a"),
            ("unchanged", "pkg-b"),
            ("removed", "pkg-c"),
            ("same-name-new-id", "pkg-d"),
            ("target-changed", "pkg-e"),
        ] {
            graph.add_node(
                Node::new(
                    format!("item__same_name__{suffix}"),
                    "same-name",
                    "comment_corpus",
                )
                .attr("package_id", id),
            );
        }
        graph.add_node(
            Node::new("item__same_name__function".into(), "f", "function")
                .attr("package_id", "pkg-b"),
        );
        let qualified = ["pkg-a".into(), "pkg-b".into()].into_iter().collect();
        let recaptured = ["pkg-a".into()].into_iter().collect();
        let affected = ["same_name".into()].into_iter().collect();
        let carriers = preserve_carriers(&graph, &qualified, &recaptured, &affected);
        assert_eq!(carriers.len(), 1);
        assert_eq!(carriers[0].attributes["package_id"], "pkg-b");
        graph.remove_crate("same_name");
        for carrier in carriers {
            graph.add_node(carrier);
        }
        assert_eq!(graph.node_count(), 1);
        assert_eq!(
            graph.node_values().next().unwrap().attributes["package_id"],
            "pkg-b"
        );
    }

    #[test]
    fn source_change_does_not_become_matching_observation() {
        let dir = std::env::temp_dir().join(format!("bg-comments-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("src.rs");
        std::fs::write(&source, "fn f() { // first\n }").unwrap();
        let before = Before::capture(&[dir.clone()]);
        std::fs::write(&source, "fn f() { // changed\n }").unwrap();
        let mut graph = Graph::new();
        let mut d = declaration("fn f() { // first\n }");
        d.docs = Some("effective docs".into());
        attach(
            &mut graph,
            &dir,
            &before,
            vec![d],
            "fixture",
            "pkg",
            serde_json::json!({"name":"lib"}),
            &"a".repeat(64),
            serde_json::json!({}),
            true,
        );
        let corpus: serde_json::Value = serde_json::from_str(
            graph
                .node_values()
                .next()
                .unwrap()
                .attributes
                .get("comment_corpus")
                .unwrap(),
        )
        .unwrap();
        assert_eq!(corpus["records"].as_array().unwrap().len(), 1);
        assert_eq!(corpus["records"][0]["sourceStatus"], "stale-source");
        std::fs::remove_dir_all(dir).unwrap();
    }
}

/// Qualify only an artifact whose observed mtime lies in this successful
/// command's bracket. This is a freshness observation, not a hermetic proof.
pub fn artifact_in_window(
    path: &Path,
    window: Option<(std::time::SystemTime, std::time::SystemTime)>,
) -> bool {
    window.is_some_and(|(start, end)| {
        std::fs::metadata(path)
            .and_then(|m| m.modified())
            .is_ok_and(|modified| modified >= start && modified <= end)
    })
}

/// Reuse a previously qualified capture without requiring a new artifact mtime.
/// Revalidate its exact artifact/source/context pins against bounded local files.
pub fn cache_matches(
    graph: &Graph,
    workspace: &Path,
    target_dir: &Path,
    package_id: &str,
    toolchain: &str,
    release: bool,
    targets: &[serde_json::Value],
    context: &serde_json::Value,
) -> bool {
    if !context_qualified(context) {
        return false;
    }
    let Ok(root) = workspace.canonicalize() else {
        return false;
    };
    let Ok(target) = target_dir.canonicalize() else {
        return false;
    };
    let mut found = false;
    let mut matched_targets = std::collections::BTreeSet::new();
    let mut retained = 0usize;
    for node in graph.node_values().filter(|n| {
        n.attributes
            .get("kind")
            .is_some_and(|k| k == "comment_corpus")
            && n.attributes
                .get("package_id")
                .is_some_and(|id| id == package_id)
    }) {
        found = true;
        let Some(raw) = node.attributes.get("comment_corpus") else {
            return false;
        };
        if raw.len() > MAX_CORPUS {
            return false;
        }
        let Ok(c) = serde_json::from_str::<serde_json::Value>(raw) else {
            return false;
        };
        let Some(target_index) = targets.iter().position(|t| *t == c["scope"]["target"]) else {
            return false;
        };
        if !matched_targets.insert(target_index) || c["scope"]["packageId"] != package_id {
            return false;
        }
        if c["extractor"] != EXTRACTOR
            || c["exportStatus"] != "successful-rustdoc-observation"
            || c["build"]["toolchainSelection"] != toolchain
            || c["build"]["release"] != release
            || c["build"]["selectedContext"] != *context
        {
            return false;
        }
        let Some(path) = c["build"]["artifactPath"]
            .as_str()
            .and_then(|p| Path::new(p).canonicalize().ok())
        else {
            return false;
        };
        if !path.starts_with(&target) {
            return false;
        }
        let Ok(file) = std::fs::File::open(path) else {
            return false;
        };
        let mut hasher = Sha256::new();
        let mut size = 0usize;
        let mut reader = file.take(64 * 1024 * 1024 + 1);
        let mut buffer = [0u8; 16384];
        loop {
            let Ok(n) = reader.read(&mut buffer) else {
                return false;
            };
            if n == 0 {
                break;
            }
            size += n;
            if size > 64 * 1024 * 1024 {
                return false;
            }
            hasher.update(&buffer[..n]);
        }
        if size == 0 || c["artifactSha256"] != format!("{:x}", hasher.finalize()) {
            return false;
        }
        let Some(pins) = c["sourcePins"].as_array() else {
            return false;
        };
        for pin in pins {
            let Some(file) = pin["file"].as_str() else {
                return false;
            };
            let Some(path) = root.join(file).canonicalize().ok() else {
                return false;
            };
            if !path.starts_with(&root) {
                return false;
            }
            let Some(bytes) = read(&path) else {
                return false;
            };
            retained += bytes.len();
            if retained > MAX_SOURCE {
                return false;
            }
            if pin["status"] != "matching-local-observation" || pin["afterSha256"] != sha(&bytes) {
                return false;
            }
        }
    }
    found && matched_targets.len() == targets.len()
}

/// Retain only independently qualified current metadata across inherited
/// normalized-crate removal. No structural nodes or edges are preserved here.
pub fn preserve_carriers(
    graph: &Graph,
    qualified_ids: &std::collections::BTreeSet<String>,
    recaptured_ids: &std::collections::BTreeSet<String>,
    affected_crates: &std::collections::BTreeSet<String>,
) -> Vec<Node> {
    graph
        .node_values()
        .filter(|node| {
            node.attributes
                .get("kind")
                .is_some_and(|k| k == "comment_corpus")
                && node
                    .attributes
                    .get("package_id")
                    .is_some_and(|id| qualified_ids.contains(id) && !recaptured_ids.contains(id))
                && build_graph::crate_of_id(&node.id)
                    .is_some_and(|krate| affected_crates.contains(krate))
        })
        .cloned()
        .collect()
}
