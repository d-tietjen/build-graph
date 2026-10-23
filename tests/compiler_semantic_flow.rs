//! Actual pinned driver traversal; prerequisites are mandatory in the shared
//! feature-enabled Linux job. Authoring these selectors is not execution.
#![cfg(all(target_os = "linux", feature = "rustc-driver"))]

use build_graph::compiler_invocation::{CompilerInvocationsV1, MAX_ATTACHMENT_BYTES};
use build_graph::compiler_occurrence::OccurrenceGap;
use build_graph::compiler_semantic::*;
use build_graph::output::read_export;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new(source: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "semantic-flow-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).expect("exclusive fixture");
        fs::create_dir(root.join("src")).unwrap();
        fs::write(
            root.join("Cargo.toml"),
            "[package]\nname='semantic_demo'\nversion='0.1.0'\nedition='2024'\n[workspace]\n",
        )
        .unwrap();
        fs::write(root.join("src/lib.rs"), source).unwrap();
        Self(root)
    }
    fn build(&self) -> CompilerInvocationsV1 {
        let driver = std::env::var_os("BUILD_GRAPH_DRIVER")
            .expect("shared job must supply genuine matching bg-driver");
        assert!(Path::new(&driver).is_file(), "actual driver required");
        let mut command = Command::new(env!("CARGO_BIN_EXE_cargo-build-graph"));
        command
            .args(["build", "--manifest-path"])
            .arg(self.0.join("Cargo.toml"))
            .args([
                "--observe-compiler-inputs",
                "--observe-definition-occurrences",
                "--observe-semantic-stream",
                "--nightly",
                "nightly-2026-02-27",
            ])
            .env("BUILD_GRAPH_DRIVER", driver)
            .env_remove("RUSTC_WRAPPER")
            .env_remove("RUSTC_WORKSPACE_WRAPPER")
            .env_remove("BG_DRIVER_OCCURRENCE_REQUEST")
            .env_remove("BG_DRIVER_SEMANTIC_REQUEST")
            .current_dir(&self.0);
        if let Some(cargo) = std::env::var_os("BUILD_GRAPH_TEST_OCCURRENCE_CARGO") {
            command.arg("--occurrence-cargo").arg(cargo);
        }
        let output = command.output().expect("actual CLI producer");
        assert!(
            output.status.success(),
            "actual build failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let facts = read_export(&self.0.join("target/build-graph"))
            .expect("original export reader")
            .compiler_invocations
            .expect("invocation attachment");
        facts.validate().expect("same aggregate validator");
        assert!(serde_json::to_vec(&facts).unwrap().len() <= MAX_ATTACHMENT_BYTES);
        facts
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn stream(facts: &CompilerInvocationsV1) -> &SemanticStreamV1 {
    let (ordinal, _) = facts
        .invocations
        .iter()
        .enumerate()
        .find(|(_, u)| u.unit.crate_name == "semantic_demo")
        .expect("actual unit");
    &facts
        .semantic_streams
        .iter()
        .find(|s| s.invocation == ordinal)
        .expect("genuine stream, no skipped positive")
        .stream
}

#[test]
fn actual_full_hir_domain_spans_pages_and_preserves_legacy_partial_record() {
    let mut source = String::from(
        "pub mod domain { pub struct Record {pub value:u32} pub enum Choice {One(Record),Two{value:u32}} pub trait Service<'a>{type Value;const VALUE:u32;fn run(&self)->Self::Value;} impl Service<'static> for Record{type Value=u32;const VALUE:u32=2;fn run(&self)->u32{self.value}} unsafe extern \"C\" {pub fn foreign(value:u32)->u32;} pub fn generic<T:Service<'static>>(value:&T)->T::Value{value.run()} }\nuse domain::Record as Imported; pub fn destructure(record:Imported)->u32{let Imported{value:local}=record;local}\n",
    );
    for index in 0..150 {
        source.push_str(&format!(
            "pub fn item_{index}()->u32{{destructure(Imported{{value:{index}}})}}\n"
        ));
    }
    let facts = Fixture::new(&source).build();
    let observed = stream(&facts);
    let terminal = observed.terminal.as_ref().unwrap();
    assert_eq!(terminal.stop, TraversalStop::EndOfDomain);
    assert!(
        observed.pages.len() > 1
            && terminal.emitted_definitions > 64
            && terminal.emitted_references > 64
    );
    assert_eq!(terminal.emitted_pages, observed.pages.len() as u64);
    let definitions: Vec<_> = observed.pages.iter().flat_map(|p| &p.definitions).collect();
    for suffix in [
        "domain", "Record", "Choice", "One", "Service", "Value", "VALUE", "foreign", "generic",
    ] {
        assert!(
            definitions
                .iter()
                .any(|d| d.compiler_path.ends_with(suffix)),
            "missing structural declaration {suffix}"
        );
    }
    assert!(
        definitions
            .iter()
            .any(|d| d.binding_owner.is_some() && d.compiler_path == "local")
    );
    assert!(definitions.iter().any(|d| d.kind.starts_with("Impl")));
    let references: Vec<_> = observed.pages.iter().flat_map(|p| &p.references).collect();
    for role in ["path", "segment", "method", "field", "lifetime", "call"] {
        assert!(
            references.iter().any(|r| r.role == role),
            "missing actual role {role}"
        );
    }
    for (ordinal, page) in observed.pages.iter().enumerate() {
        assert_eq!(page.ordinal, ordinal as u64);
        page.validate().unwrap();
    }
    let invocation = &facts.invocations[facts
        .semantic_streams
        .iter()
        .find(|s| s.stream.binding.crate_name == "semantic_demo")
        .unwrap()
        .invocation];
    if let Some(legacy) = &invocation.occurrences {
        assert!(
            legacy
                .gaps
                .contains(&OccurrenceGap::AnalysisCoveragePartial)
        );
        assert!(legacy.definitions.len() <= 64 && legacy.references.len() <= 64);
    } else {
        assert!(
            invocation
                .gaps
                .contains(&build_graph::compiler_invocation::ObservationGap::BudgetExceeded),
            "original invocation limit remains active"
        );
    }
}

#[test]
fn actual_unsupported_resolution_and_long_definition_are_counted() {
    let source = format!(
        "pub fn {}(){{}}\npub fn indirect(f:fn()->u32)->u32{{f()}}\npub fn closure()->u32{{let f=||2;f()}}\n",
        "long".repeat(400)
    );
    let facts = Fixture::new(&source).build();
    let observed = stream(&facts);
    let terminal = observed.terminal.as_ref().unwrap();
    assert_eq!(terminal.stop, TraversalStop::EndOfDomain);
    assert!(terminal.unsupported > 0 && terminal.omitted > 0);
    assert!(terminal.gaps.contains(&SemanticGap::UnsupportedDefinition));
    assert!(terminal.gaps.contains(&SemanticGap::UnsupportedResolution));
    assert!(
        observed
            .pages
            .iter()
            .any(|p| p.gaps.contains(&SemanticGap::UnsupportedDefinition))
    );
    assert!(
        observed
            .pages
            .iter()
            .any(|p| p.gaps.contains(&SemanticGap::UnsupportedResolution))
    );
    assert_eq!(
        terminal.omitted,
        terminal.visited_definitions + terminal.visited_references
            - terminal.emitted_definitions
            - terminal.emitted_references
    );
}

#[test]
fn actual_source_work_limit_is_shared_across_files_and_pages() {
    let fixture = Fixture::new("pub mod a;pub mod b;pub mod c;pub mod d;pub mod e;\n");
    for name in ["a", "b", "c", "d", "e"] {
        let mut source = String::from("pub fn item()->u32{1}\n/*");
        source.push_str(&" ".repeat(7 * 1024 * 1024));
        source.push_str("*/\n");
        fs::write(fixture.0.join(format!("src/{name}.rs")), source).unwrap();
    }
    let facts = fixture.build();
    let observed = stream(&facts);
    let terminal = observed.terminal.as_ref().unwrap();
    assert_eq!(terminal.stop, TraversalStop::SourceWorkLimit);
    assert!(terminal.gaps.contains(&SemanticGap::SourceWorkLimit));
    assert!(terminal.source_work_bytes <= MAX_SOURCE_WORK_BYTES);
    assert!(
        observed
            .pages
            .iter()
            .flat_map(|p| &p.definitions)
            .filter_map(|d| d.location.as_ref())
            .all(|l| l.input.bytes <= MAX_SOURCE_FILE_BYTES)
    );
}

#[test]
fn actual_per_file_limit_reports_interruption_without_terminal_success() {
    let mut source = String::from("pub fn item(){}\n/*");
    source.push_str(&" ".repeat(MAX_SOURCE_FILE_BYTES as usize));
    source.push_str("*/\n");
    let facts = Fixture::new(&source).build();
    let terminal = stream(&facts).terminal.as_ref().unwrap();
    assert_eq!(terminal.stop, TraversalStop::SourceWorkLimit);
    assert!(terminal.gaps.contains(&SemanticGap::SourceWorkLimit));
    assert!(terminal.unsupported > 0);
}

#[test]
fn actual_output_overflow_keeps_committed_pages_and_interrupted_terminal() {
    let mut source = String::new();
    for index in 0..35_000 {
        source.push_str(&format!("pub fn item_{index}(){{}}\n"));
    }
    let facts = Fixture::new(&source).build();
    let observed = stream(&facts);
    let terminal = observed.terminal.as_ref().unwrap();
    assert_eq!(terminal.stop, TraversalStop::OutputLimit);
    assert!(terminal.gaps.contains(&SemanticGap::OutputLimit));
    assert!(terminal.emitted_definitions > 64 && terminal.emitted_definitions < 35_000);
    assert_eq!(
        terminal.emitted_definitions,
        observed
            .pages
            .iter()
            .map(|p| p.definitions.len() as u64)
            .sum::<u64>()
    );
    assert!(terminal.omitted > 0);
    assert!(serde_json::to_vec(&facts).unwrap().len() <= MAX_ATTACHMENT_BYTES);
}

#[test]
fn actual_nested_owner_signatures_keep_body_tables_scoped_and_restore_outer() {
    let source = r#"
pub trait Assoc { type Value; fn wrap(value: Self::Value) -> Self::Value; }
pub struct Payload { pub value: u32 }
impl Assoc for Payload { type Value = u32; fn wrap(value: u32) -> u32 { value } }
pub fn touch(value: u32) -> u32 { value }
pub fn outer(record: Payload) -> u32 {
    fn inner<T: Assoc>(value: T::Value) -> T::Value { T::wrap(value) }
    type NestedAlias<T: Assoc> = T::Value;
    trait NestedTrait<T: Assoc> {
        fn required(value: T::Value) -> T::Value;
        fn provided(value: T::Value) -> T::Value { T::wrap(value) }
    }
    struct Nested;
    impl Nested {
        fn associated<T: Assoc>(value: T::Value) -> T::Value { T::wrap(value) }
    }
    unsafe extern "C" {
        fn foreign(value: <Payload as Assoc>::Value) -> <Payload as Assoc>::Value;
    }
    let first = inner::<Payload>(record.value);
    let second = Nested::associated::<Payload>(first);
    let closure = || touch(second);
    touch(closure())
}
"#;
    let facts = Fixture::new(source).build();
    let observed = stream(&facts);
    let terminal = observed
        .terminal
        .as_ref()
        .expect("actual traversal terminal");
    assert_eq!(terminal.stop, TraversalStop::EndOfDomain);
    assert!(
        terminal.unsupported > 0,
        "non-body associated-type signatures retain their disposition"
    );
    assert!(terminal.gaps.contains(&SemanticGap::UnsupportedResolution));
    let definitions: Vec<_> = observed
        .pages
        .iter()
        .flat_map(|page| &page.definitions)
        .collect();
    let owner = |suffix: &str| {
        definitions
            .iter()
            .find(|definition| {
                definition.binding_owner.is_none() && definition.compiler_path.ends_with(suffix)
            })
            .unwrap_or_else(|| panic!("missing actual nested definition {suffix}"))
            .local_index
    };
    for suffix in [
        "inner",
        "NestedAlias",
        "NestedTrait",
        "required",
        "provided",
        "associated",
        "foreign",
    ] {
        let _ = owner(suffix);
    }
    let references: Vec<_> = observed
        .pages
        .iter()
        .flat_map(|page| &page.references)
        .collect();
    for suffix in ["inner", "provided", "associated"] {
        assert!(references.iter().any(|reference| {
            reference.owner_index == owner(suffix)
                && reference.role == "call"
                && matches!(&reference.target, SemanticTarget::Definition { compiler_path, .. } if compiler_path.ends_with("wrap"))
                && reference.location.is_some()
        }), "nested body must use its own original table: {suffix}");
    }
    let outer = owner("outer");
    for suffix in ["inner", "associated", "touch"] {
        assert!(references.iter().any(|reference| {
            reference.owner_index == outer
                && reference.role == "call"
                && matches!(&reference.target, SemanticTarget::Definition { compiler_path, .. } if compiler_path.ends_with(suffix))
                && reference.location.is_some()
        }), "outer body must resume after nested owner: {suffix}");
    }
    assert!(references.iter().any(|reference| {
        reference.owner_index == outer && reference.role == "field"
            && matches!(&reference.target, SemanticTarget::Definition { compiler_path, .. } if compiler_path.ends_with("value"))
    }));
    assert!(references.iter().filter(|reference| {
        reference.owner_index == outer && reference.role == "call"
            && matches!(&reference.target, SemanticTarget::Definition { compiler_path, .. } if compiler_path.ends_with("touch"))
    }).count() >= 2, "the closure shares its actual type-checking root and the outer body continues afterward");
    observed.validate().expect("same bounded stream validator");
    assert!(serde_json::to_vec(&facts).unwrap().len() <= MAX_ATTACHMENT_BYTES);
}
