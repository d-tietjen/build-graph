//! Read-only, bounded local source/build context. Never a hermetic input attestation.
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use build_graph::Graph;
use serde::Serialize;

const MAX_PROBE_BYTES: u64 = 1024 * 1024;
const MAX_INPUT_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitState {
    status: String,
    object_format: Option<String>,
    tree_oid: Option<String>,
    commit_oid: Option<String>,
    repo_root: Option<String>,
    staged: Option<bool>,
    unstaged: Option<bool>,
    untracked: Option<bool>,
    submodules: Option<bool>,
    status_digest: Option<String>,
    digest_algorithm: &'static str,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct InputDigest {
    path: String,
    status: &'static str,
    digest: Option<String>,
    algorithm: &'static str,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildContext {
    profile: String,
    selected_packages: Vec<String>,
    forwarded_arguments_digest: String,
    arguments_digest_algorithm: &'static str,
    toolchain_selection: Option<String>,
    observed_rustc_version: Option<String>,
    selected_environment_digests: Vec<(String, String)>,
    file_inputs: Vec<InputDigest>,
    coverage: Vec<&'static str>,
}

#[derive(Clone)]
pub struct Start {
    root: PathBuf,
    manifest: PathBuf,
    workspace: PathBuf,
    git: GitState,
    build: BuildContext,
    compiled_during_capture: bool,
}

// Stable labelled integrity signal for small bounded context inputs. The exported
// comparison additionally pins the full graph and build record with SHA-256.
fn digest(bytes: &[u8]) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in bytes {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

// A nonblocking owned socket also bounds EOF when a descendant inherits stdout.
// No reader thread can remain blocked after the deadline. Other platforms report
// unavailable rather than starting an unbounded pipe reader.
#[cfg(unix)]
pub(crate) fn bounded_output(mut command: Command) -> Option<Vec<u8>> {
    use std::os::fd::OwnedFd;
    use std::os::unix::net::UnixStream;
    let (mut stdout, writer) = UnixStream::pair().ok()?;
    stdout.set_nonblocking(true).ok()?;
    command
        .stdout(Stdio::from(OwnedFd::from(writer)))
        .stderr(Stdio::null())
        .stdin(Stdio::null());
    let started = Instant::now();
    let mut child = command.spawn().ok()?;
    drop(command);
    let mut bytes = Vec::new();
    let mut status = None;
    let mut eof = false;
    loop {
        if started.elapsed() >= Duration::from_secs(2) {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        let mut buffer = [0; 8192];
        let mut idle = false;
        match stdout.read(&mut buffer) {
            Ok(0) => eof = true,
            Ok(n) => {
                if bytes.len() + n > MAX_PROBE_BYTES as usize {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                bytes.extend_from_slice(&buffer[..n]);
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => idle = true,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
        if status.is_none() {
            match child.try_wait() {
                Ok(value) => status = value,
                Err(_) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
            }
        }
        if eof && status.is_some() {
            return status.filter(|s| s.success()).map(|_| bytes);
        }
        // Drain ready data without an artificial per-chunk delay.
        if eof || idle {
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

#[cfg(not(unix))]
pub(crate) fn bounded_output(_command: Command) -> Option<Vec<u8>> {
    None
}

fn git(root: &Path, args: &[&str]) -> Option<Vec<u8>> {
    let mut command = Command::new("git");
    command
        .current_dir(root)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .args([
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.untrackedCache=false",
        ])
        .args(args);
    for key in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_COMMON_DIR",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_NAMESPACE",
    ] {
        command.env_remove(key);
    }
    bounded_output(command)
}

fn text(bytes: Option<Vec<u8>>) -> Option<String> {
    String::from_utf8(bytes?)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn oid(value: Option<String>, format: &str) -> Option<String> {
    value.filter(|s| {
        s.len() == (if format == "sha256" { 64 } else { 40 })
            && s.bytes().all(|b| b.is_ascii_hexdigit())
    })
}

fn probe(root: &Path) -> GitState {
    let mut state = GitState {
        status: "unavailable".into(),
        object_format: None,
        tree_oid: None,
        commit_oid: None,
        repo_root: None,
        staged: None,
        unstaged: None,
        untracked: None,
        submodules: None,
        status_digest: None,
        digest_algorithm: "fnv1a-64",
    };
    let Some(format) = text(git(root, &["rev-parse", "--show-object-format"])) else {
        return state;
    };
    if !["sha1", "sha256"].contains(&format.as_str()) {
        return state;
    }
    state.tree_oid = oid(
        text(git(root, &["rev-parse", "--verify", "HEAD^{tree}"])),
        &format,
    );
    state.commit_oid = oid(text(git(root, &["rev-parse", "--verify", "HEAD"])), &format);
    state.repo_root = text(git(root, &["rev-parse", "--show-toplevel"]));
    state.object_format = Some(format);
    let Some(status) = git(
        root,
        &[
            "status",
            "--porcelain=v2",
            "-z",
            "--untracked-files=normal",
            "--ignore-submodules=none",
        ],
    ) else {
        return state;
    };
    let (mut staged, mut unstaged, mut untracked, mut submodules) = (false, false, false, false);
    for record in status.split(|b| *b == 0) {
        if record.starts_with(b"? ") {
            untracked = true;
        }
        if record.starts_with(b"1 ") || record.starts_with(b"2 ") {
            staged |= record.get(2).is_some_and(|b| *b != b'.');
            unstaged |= record.get(3).is_some_and(|b| *b != b'.');
            submodules |= record
                .split(|b| *b == b' ')
                .nth(2)
                .is_some_and(|s| s.first() == Some(&b'S'));
        }
        if record.starts_with(b"u ") {
            staged = true;
            unstaged = true;
        }
    }
    state.staged = Some(staged);
    state.unstaged = Some(unstaged);
    state.untracked = Some(untracked);
    state.submodules = Some(submodules);
    state.status_digest = Some(digest(&status));
    state.status =
        if state.tree_oid.is_none() || state.commit_oid.is_none() || state.repo_root.is_none() {
            "unborn-or-incomplete"
        } else if staged || unstaged || untracked {
            "dirty"
        } else {
            "clean-tracked-context"
        }
        .into();
    state
}

fn input(path: PathBuf, root: &Path) -> InputDigest {
    let label = path
        .strip_prefix(root)
        .unwrap_or(&path)
        .to_string_lossy()
        .into_owned();
    if std::fs::metadata(&path).is_ok_and(|m| !m.is_file()) {
        return InputDigest {
            path: label,
            status: "unavailable-nonregular-input",
            digest: None,
            algorithm: "fnv1a-64",
        };
    }
    match std::fs::File::open(&path) {
        Ok(file) => {
            let mut bytes = Vec::new();
            if file
                .take(MAX_INPUT_BYTES + 1)
                .read_to_end(&mut bytes)
                .is_ok()
                && bytes.len() as u64 <= MAX_INPUT_BYTES
            {
                InputDigest {
                    path: label,
                    status: "captured",
                    digest: Some(digest(&bytes)),
                    algorithm: "fnv1a-64",
                }
            } else {
                InputDigest {
                    path: label,
                    status: "unavailable-or-over-limit",
                    digest: None,
                    algorithm: "fnv1a-64",
                }
            }
        }
        Err(e) => InputDigest {
            path: label,
            status: if e.kind() == std::io::ErrorKind::NotFound {
                "absent"
            } else {
                "unavailable"
            },
            digest: None,
            algorithm: "fnv1a-64",
        },
    }
}

fn build(
    root: &Path,
    manifest: &Path,
    workspace: &Path,
    release: bool,
    packages: &[String],
    args: &[String],
    nightly: Option<&str>,
) -> BuildContext {
    let mut command = Command::new("rustc");
    command.current_dir(root).arg("--version");
    let observed = text(bounded_output(command));
    let mut files = Vec::new();
    for ancestor in root.ancestors().take(32) {
        files.push(input(ancestor.join(".cargo/config.toml"), Path::new("")));
        files.push(input(ancestor.join(".cargo/config"), Path::new("")));
    }
    // Cargo metadata establishes the workspace, including member-manifest
    // invocation. Keep exact selected and workspace paths, including absence.
    for path in [
        manifest.to_path_buf(),
        workspace.join("Cargo.toml"),
        workspace.join("Cargo.lock"),
        root.join("rust-toolchain.toml"),
        root.join("rust-toolchain"),
    ] {
        if !files.iter().any(|file| file.path == path.to_string_lossy()) {
            files.push(input(path, Path::new("")));
        }
    }
    for ancestor in workspace.ancestors().take(32) {
        for name in [".cargo/config.toml", ".cargo/config"] {
            let path = ancestor.join(name);
            let item = input(path, Path::new(""));
            if !files.iter().any(|file| file.path == item.path) {
                files.push(item);
            }
        }
    }
    let environment = [
        "CARGO_BUILD_TARGET",
        "CARGO_ENCODED_RUSTFLAGS",
        "RUSTFLAGS",
        "RUSTDOCFLAGS",
        "RUSTUP_TOOLCHAIN",
    ]
    .into_iter()
    .filter_map(|key| {
        std::env::var_os(key).map(|v| (key.to_string(), digest(v.to_string_lossy().as_bytes())))
    })
    .collect();
    BuildContext {
        profile: if release { "release" } else { "debug" }.into(),
        selected_packages: packages.to_vec(),
        forwarded_arguments_digest: digest(&serde_json::to_vec(args).unwrap_or_default()),
        arguments_digest_algorithm: "fnv1a-64",
        toolchain_selection: nightly.map(str::to_string),
        observed_rustc_version: observed,
        selected_environment_digests: environment,
        file_inputs: files,
        coverage: vec![
            "Context fingerprint only; not complete or hermetic compiler-input attestation",
            "Ignored/generated/build-script/external and environment inputs are not exhaustively hashed",
            "Inherited/global Cargo configuration and arbitrary environment inputs are not exhaustively captured",
            "Forwarded arguments and selected environment values are digests, never plaintext secrets",
            "Target/features and build units retain their independent compiler capture evidence",
        ],
    }
}

impl Start {
    pub fn capture(
        manifest: Option<&str>,
        meta: &cargo_metadata::Metadata,
        release: bool,
        packages: &[String],
        args: &[String],
        nightly: Option<&str>,
        compiled: bool,
    ) -> Self {
        let root = manifest
            .and_then(|m| Path::new(m).parent())
            .filter(|p| !p.as_os_str().is_empty())
            .map(Path::to_path_buf)
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
        let root = root.canonicalize().unwrap_or(root);
        let selected_manifest = manifest
            .map(PathBuf::from)
            .unwrap_or_else(|| root.join("Cargo.toml"));
        let selected_manifest = selected_manifest
            .canonicalize()
            .unwrap_or(selected_manifest);
        let workspace = meta.workspace_root.as_std_path().to_path_buf();
        Self {
            git: probe(&root),
            build: build(
                &root,
                &selected_manifest,
                &workspace,
                release,
                packages,
                args,
                nightly,
            ),
            manifest: selected_manifest,
            workspace,
            root,
            compiled_during_capture: compiled,
        }
    }

    pub fn attach(
        self,
        graph: &mut Graph,
        meta: &cargo_metadata::Metadata,
        release: bool,
        packages: &[String],
        args: &[String],
        nightly: Option<&str>,
    ) {
        let end = probe(&self.root);
        let end_build = build(
            &self.root,
            &self.manifest,
            meta.workspace_root.as_std_path(),
            release,
            packages,
            args,
            nightly,
        );
        let consistency = if !self.compiled_during_capture {
            "extraction-only"
        } else if self.git != end
            || self.workspace != meta.workspace_root.as_std_path()
            || self.build != end_build
        {
            "changed-during-capture"
        } else if end.status == "clean-tracked-context" {
            "stable-context"
        } else if end.status == "dirty" {
            "dirty-context-unverified"
        } else {
            "context-unavailable"
        };
        let ids: Vec<_> = graph
            .node_values()
            .filter(|n| n.attributes.get("kind").map(String::as_str) == Some("crate"))
            .map(|n| (n.id.clone(), n.attributes.get("package_id").cloned()))
            .collect();
        for (id, package) in ids {
            let pkg = package
                .as_ref()
                .and_then(|id| meta.packages.iter().find(|p| &p.id.repr == id));
            let member = pkg.is_some_and(|p| meta.workspace_members.contains(&p.id));
            let relative_manifest = pkg
                .and_then(|p| {
                    end.repo_root
                        .as_ref()
                        .and_then(|r| p.manifest_path.as_std_path().strip_prefix(r).ok())
                })
                .map(|p| p.to_string_lossy().into_owned());
            let binding = if member && relative_manifest.is_some() {
                "workspace-package-in-observed-repo"
            } else {
                "unavailable-or-external"
            };
            let value = serde_json::json!({ "schemaVersion": 1, "producer": "build-graph-cli-local-context-v1", "basis": "observed-local-process",
                "scope": { "packageId": package, "workspaceMember": member, "manifestRelativeToRepo": relative_manifest, "binding": binding },
                "git": { "before": self.git, "after": end, "consistency": consistency },
                "build": { "before": self.build, "after": end_build, "fingerprintDomain": "captured-context-only", "fingerprintAlgorithm": "sha256-of-exported-build-record", "completeInputs": false },
                "coverage": ["HEAD tree is committed tracked content, not dirty/staged/untracked/ignored/generated build input identity", "Submodule contents and external packages remain independent inputs", "Source bytes and model/capture SHA-256 pins remain separate"] });
            if let Some(node) = graph.node_mut(&id) {
                node.attributes
                    .insert("capture_provenance_v1".into(), value.to_string());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn git_ok(root: &Path, args: &[&str]) {
        assert!(
            git(root, args).is_some(),
            "owned fixture git command failed"
        );
    }
    fn owned_temp(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "build-graph-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[cfg(unix)]
    #[test]
    fn owned_probe_bounds_child_and_inherited_stdout_completion() {
        fn shell(script: &str) -> Option<Vec<u8>> {
            let mut command = Command::new("sh");
            command.args(["-c", script]);
            bounded_output(command)
        }
        assert_eq!(shell("printf normal"), Some(b"normal".to_vec()));
        assert_eq!(shell("printf failed; exit 1"), None);
        assert_eq!(
            shell("dd if=/dev/zero bs=1048577 count=1 2>/dev/null"),
            None
        );
        // Only these newly owned fixture descendants inherit this probe's socket.
        // They terminate themselves; the implementation never enumerates/kills
        // unrelated processes and leaves no blocked reader thread behind.
        for script in ["sleep 3 & exit 0", "sleep 3 & wait", "exec 1>&-; sleep 3"] {
            let started = Instant::now();
            assert_eq!(shell(script), None, "{script}");
            assert!(
                started.elapsed() < Duration::from_millis(2800),
                "child and EOF share the two-second deadline: {script}"
            );
        }
    }

    #[test]
    fn member_manifest_binds_metadata_workspace_inputs_at_both_observations() {
        let root = owned_temp("workspace-inputs").canonicalize().unwrap();
        for name in ["one", "two"] {
            std::fs::create_dir_all(root.join(name).join("src")).unwrap();
            std::fs::write(
                root.join(name).join("Cargo.toml"),
                format!(
                    "[package]\nname = \"{name}\"\nversion = \"0.1.0\"\nedition.workspace = true\n"
                ),
            )
            .unwrap();
            std::fs::write(root.join(name).join("src/lib.rs"), "pub fn value() {}\n").unwrap();
        }
        let manifest_text = "[workspace]\nmembers = [\"one\", \"two\"]\nresolver = \"2\"\n[workspace.package]\nedition = \"2021\"\n";
        std::fs::write(root.join("Cargo.toml"), manifest_text).unwrap();
        std::fs::write(root.join("Cargo.lock"), "version = 4\n[[package]]\nname = \"one\"\nversion = \"0.1.0\"\n[[package]]\nname = \"two\"\nversion = \"0.1.0\"\n").unwrap();
        let manifest = root.join("one/Cargo.toml");
        let mut command = cargo_metadata::MetadataCommand::new();
        command
            .manifest_path(&manifest)
            .no_deps()
            .other_options(vec!["--locked".into(), "--offline".into()]);
        let meta = command.exec().unwrap();
        let workspace = meta.workspace_root.as_std_path();
        assert_eq!(workspace, root.canonicalize().unwrap());
        let observed = || {
            build(
                manifest.parent().unwrap(),
                &manifest,
                workspace,
                false,
                &[],
                &[],
                None,
            )
        };
        let baseline = observed();
        for path in [
            &manifest,
            &root.join("Cargo.toml"),
            &root.join("Cargo.lock"),
        ] {
            assert!(
                baseline
                    .file_inputs
                    .iter()
                    .any(|file| file.path == path.to_string_lossy() && file.status == "captured")
            );
        }
        assert!(
            !baseline
                .file_inputs
                .iter()
                .any(|file| file.path == root.join("one/Cargo.lock").to_string_lossy())
        );
        std::fs::write(root.join("unrelated"), "outside known build inputs").unwrap();
        assert_eq!(baseline, observed());
        let start = Start::capture(manifest.to_str(), &meta, false, &[], &[], None, true);
        std::fs::write(
            root.join("Cargo.lock"),
            "version = 4\n# changed real workspace lock\n",
        )
        .unwrap();
        assert_ne!(baseline, observed());
        let mut graph = Graph::new();
        let id = meta.workspace_members[0].repr.clone();
        graph.add_node(
            build_graph::Node::new("workspace".into(), "workspace", "crate").attr("package_id", &id),
        );
        start.attach(&mut graph, &meta, false, &[], &[], None);
        let record: serde_json::Value = serde_json::from_str(
            &graph.node("workspace").unwrap().attributes["capture_provenance_v1"],
        )
        .unwrap();
        assert_eq!(record["git"]["consistency"], "changed-during-capture");
        assert_ne!(
            record["build"]["before"]["fileInputs"],
            record["build"]["after"]["fileInputs"]
        );
        let locked = observed();
        std::fs::write(
            root.join("Cargo.toml"),
            manifest_text.replace("2021", "2024"),
        )
        .unwrap();
        assert_ne!(locked, observed());
        std::fs::create_dir_all(root.join(".cargo")).unwrap();
        std::fs::write(root.join(".cargo/config.toml"), "[build]\njobs = 1\n").unwrap();
        let config = observed();
        assert_ne!(locked, config);
        std::fs::remove_file(root.join("Cargo.lock")).unwrap();
        assert!(observed().file_inputs.iter().any(|file| file.path
            == root.join("Cargo.lock").to_string_lossy()
            && file.status == "absent"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn owned_git_tree_commit_dirty_and_non_git_contexts() {
        let root = std::env::temp_dir().join(format!(
            "build-graph-provenance-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        // All Git mutations below are confined to this new owned temporary repo.
        assert_eq!(probe(&root).status, "unavailable");
        git_ok(&root, &["init", "--quiet"]);
        std::fs::write(root.join("source.rs"), "pub fn source() {}\n").unwrap();
        git_ok(&root, &["add", "--", "source.rs"]);
        git_ok(
            &root,
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--quiet",
                "-m",
                "first",
            ],
        );
        let a = probe(&root);
        assert_eq!(a.status, "clean-tracked-context");
        assert!(a.tree_oid.is_some());
        git_ok(
            &root,
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--quiet",
                "--allow-empty",
                "-m",
                "same tree",
            ],
        );
        let b = probe(&root);
        assert_eq!(a.tree_oid, b.tree_oid);
        assert_ne!(a.commit_oid, b.commit_oid);
        std::fs::write(root.join("source.rs"), "pub fn changed() {}\n").unwrap();
        assert_eq!(probe(&root).unstaged, Some(true));
        git_ok(&root, &["add", "--", "source.rs"]);
        assert_eq!(probe(&root).staged, Some(true));
        git_ok(
            &root,
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--quiet",
                "-m",
                "different tree",
            ],
        );
        assert_ne!(a.tree_oid, probe(&root).tree_oid);
        std::fs::write(root.join("new-input"), "untracked").unwrap();
        assert_eq!(probe(&root).untracked, Some(true));
        let debug = build(
            &root,
            &root.join("Cargo.toml"),
            &root,
            false,
            &[],
            &[],
            None,
        );
        let release = build(&root, &root.join("Cargo.toml"), &root, true, &[], &[], None);
        assert_ne!(debug, release);
        std::fs::remove_dir_all(root).unwrap();
    }
}
