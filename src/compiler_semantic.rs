//! Versioned, bounded observations of one compiler's local semantic domain.
//! Nonces, compiler indexes and consistency markers are descriptive only.

use crate::compiler_occurrence::{OccurrenceInput, OccurrenceRange, fingerprint};
use serde::{Deserialize, Serialize};
use std::io::Write;

pub const SEMANTIC_VERSION: u32 = 1;
pub const MAX_PAGE_BYTES: usize = 24 * 1024;
pub const MAX_PAGE_DEFINITIONS: usize = 64;
pub const MAX_PAGE_REFERENCES: usize = 64;
pub const MAX_STREAM_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_SOURCE_WORK_BYTES: u64 = 32 * 1024 * 1024;
pub const MAX_SOURCE_FILE_BYTES: u64 = 8 * 1024 * 1024;
pub const MAX_TRAVERSAL_WORK: u64 = 1_000_000;
// A valid page contains more than this many mandatory key/string bytes. This
// is a conservative encoded lower bound, not a separate per-page allowance.
pub const MIN_PAGE_BYTES: usize = 128;
pub const MAX_PAGES: usize = MAX_STREAM_BYTES / MIN_PAGE_BYTES;

// Never reserve a caller's size_hint. Grow only after observing a bounded row.
pub fn bounded_list<'de, D, T, const N: usize>(d: D) -> Result<Vec<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    struct List<T, const N: usize>(std::marker::PhantomData<T>);
    impl<'de, T: Deserialize<'de>, const N: usize> serde::de::Visitor<'de> for List<T, N> {
        type Value = Vec<T>;
        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "at most {N} observations")
        }
        fn visit_seq<A: serde::de::SeqAccess<'de>>(
            self,
            mut a: A,
        ) -> Result<Self::Value, A::Error> {
            let mut rows = Vec::new();
            while rows.len() < N {
                let Some(row) = a.next_element()? else {
                    return Ok(rows);
                };
                rows.try_reserve_exact(1)
                    .map_err(serde::de::Error::custom)?;
                rows.push(row);
            }
            if a.next_element::<serde::de::IgnoredAny>()?.is_some() {
                return Err(serde::de::Error::custom("semantic list limit"));
            }
            Ok(rows)
        }
    }
    d.deserialize_seq(List::<T, N>(std::marker::PhantomData))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SemanticBindingV1 {
    pub schema_version: u32,
    pub nonce: String,
    pub command_fingerprint: String,
    pub crate_name: String,
    pub metadata: Option<String>,
    pub domain: SemanticDomain,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SemanticDomain {
    LocalHir,
    LocalHirWithCompilerContext,
    LocalHirWithTestHarness,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SemanticGap {
    UnsupportedDefinition,
    UnsupportedResolution,
    ExpandedCoordinates,
    SourceUnavailable,
    SourceVersionChanged,
    ExternalTarget,
    GeneratedOrderingUnknown,
    OutputLimit,
    SourceWorkLimit,
    TraversalWorkLimit,
    PublicationInterrupted,
    CompilerContextUnavailable,
    CompilerContextUnsupportedValue,
    TestHarnessUnavailable,
    TestHarnessCustomRunner,
    TestHarnessUnsupportedDescriptor,
    TestHarnessOwnerMismatch,
    TestHarnessCrateSourceUnavailable,
    TestHarnessOrderingUnknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SemanticLocation {
    pub input: OccurrenceInput,
    /// Exact source-map byte-position version, scoped to this callback.
    pub source_version: u32,
    pub range: OccurrenceRange,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SemanticDefinition {
    pub ordinal: u64,
    pub local_index: u32,
    /// Present for HIR local bindings, which have no LocalDefId.
    pub binding_owner: Option<u32>,
    pub compiler_path: String,
    pub kind: String,
    pub location: Option<SemanticLocation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SemanticTarget {
    Definition {
        crate_name: String,
        definition_index: u32,
        compiler_path: String,
    },
    LocalBinding {
        owner_index: u32,
        local_index: u32,
    },
    Builtin {
        name: String,
    },
    // Boxing keeps the ordinary page Vec's element layout unchanged. Bodies
    // are allocated only by the explicit observation domains, under their cap.
    CompilerContext {
        context: Box<crate::compiler_context::CompilerContextObservation>,
    },
    EffectiveCfg {
        cfg: Box<crate::compiler_context::EffectiveCfgObservation>,
    },
    TargetFeature {
        feature: Box<crate::compiler_context::TargetFeatureObservation>,
    },
    TestHarnessEntry {
        entry: Box<crate::compiler_test_harness::TestHarnessEntryObservation>,
    },
    TestHarnessDescriptor {
        descriptor: Box<crate::compiler_test_harness::TestDescriptorObservation>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SemanticReference {
    pub ordinal: u64,
    pub owner_index: u32,
    pub hir_local_index: u32,
    pub role: String,
    pub target: SemanticTarget,
    pub location: Option<SemanticLocation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SemanticPageV1 {
    pub binding: SemanticBindingV1,
    pub ordinal: u64,
    #[serde(deserialize_with = "bounded_list::<_, _, 64>")]
    pub definitions: Vec<SemanticDefinition>,
    #[serde(deserialize_with = "bounded_list::<_, _, 64>")]
    pub references: Vec<SemanticReference>,
    #[serde(deserialize_with = "bounded_list::<_, _, 16>")]
    pub gaps: Vec<SemanticGap>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TraversalStop {
    EndOfDomain,
    WorkLimit,
    OutputLimit,
    SourceWorkLimit,
    PublicationInterrupted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SemanticTerminalV1 {
    pub binding: SemanticBindingV1,
    pub stop: TraversalStop,
    /// Actual visitor and bounded DefKey work events, not distinct HIR IDs.
    pub traversal_events: u64,
    pub visited_definitions: u64,
    pub visited_references: u64,
    pub unsupported: u64,
    pub omitted: u64,
    pub emitted_definitions: u64,
    pub emitted_references: u64,
    pub emitted_pages: u64,
    pub source_work_bytes: u64,
    #[serde(deserialize_with = "bounded_list::<_, _, 16>")]
    pub gaps: Vec<SemanticGap>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SemanticStreamV1 {
    pub binding: SemanticBindingV1,
    #[serde(deserialize_with = "bounded_list::<_, _, MAX_PAGES>")]
    pub pages: Vec<SemanticPageV1>,
    pub terminal: Option<SemanticTerminalV1>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InvocationSemanticStreamV1 {
    /// Exact retained invocation ordinal, assigned after the original unit join.
    pub invocation: usize,
    pub stream: SemanticStreamV1,
}

pub fn encoded_size(value: &impl Serialize, maximum: usize) -> Result<usize, &'static str> {
    struct Counter {
        bytes: usize,
        maximum: usize,
    }
    impl Write for Counter {
        fn write(&mut self, raw: &[u8]) -> std::io::Result<usize> {
            if raw.len() > self.maximum.saturating_sub(self.bytes) {
                return Err(std::io::Error::other("semantic observation limit"));
            }
            self.bytes += raw.len();
            Ok(raw.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut count = Counter { bytes: 0, maximum };
    serde_json::to_writer(&mut count, value).map_err(|_| "semantic observation limit")?;
    Ok(count.bytes)
}

fn text(value: &str) -> bool {
    !value.is_empty() && value.len() <= 1024 && !value.contains(['\0', '\n', '\r', '/', '\\'])
}

impl SemanticBindingV1 {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.schema_version != SEMANTIC_VERSION
            || !text(&self.nonce)
            || !text(&self.crate_name)
            || self.metadata.as_ref().is_some_and(|v| !text(v))
            || !self
                .command_fingerprint
                .strip_prefix("fnv1a64:")
                .is_some_and(|v| v.len() == 16 && v.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            return Err("invalid semantic binding");
        }
        Ok(())
    }
}

fn location(value: &Option<SemanticLocation>) -> Result<(), &'static str> {
    let Some(value) = value else { return Ok(()) };
    let input = &value.input;
    if input.bytes > MAX_SOURCE_FILE_BYTES
        || input.relative.is_empty()
        || input.relative.len() > 4096
        || input.relative.starts_with('/')
        || input.relative.contains(['\\', ':', '\0'])
        || input
            .relative
            .split('/')
            .any(|s| s.is_empty() || s == "." || s == "..")
        || !input
            .content_fingerprint
            .strip_prefix("fnv1a64:")
            .is_some_and(|s| s.len() == 16 && s.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err("invalid semantic source");
    }
    let r = &value.range;
    if r.begin_line == 0
        || (r.begin_line, r.begin_column) >= (r.end_line, r.end_column)
        || [r.begin_line, r.begin_column, r.end_line, r.end_column]
            .iter()
            .any(|n| *n > input.bytes as usize + 1)
    {
        return Err("invalid semantic range");
    }
    Ok(())
}

impl SemanticPageV1 {
    pub fn from_json(raw: &[u8]) -> Result<Self, &'static str> {
        if raw.len() > MAX_PAGE_BYTES {
            return Err("semantic page byte limit");
        }
        let value: Self = serde_json::from_slice(raw).map_err(|_| "malformed semantic page")?;
        value.validate()?;
        Ok(value)
    }
    pub fn validate(&self) -> Result<(), &'static str> {
        self.binding.validate()?;
        if self.definitions.len() > MAX_PAGE_DEFINITIONS
            || self.references.len() > MAX_PAGE_REFERENCES
            || self.gaps.len() > 16
        {
            return Err("semantic page row limit");
        }
        encoded_size(self, MAX_PAGE_BYTES)?;
        for row in &self.definitions {
            if !text(&row.compiler_path) || !text(&row.kind) {
                return Err("invalid semantic definition");
            }
            location(&row.location)?;
        }
        for row in &self.references {
            let observational = validate_observed_target(self.binding.domain, row)?;
            if !observational
                && !matches!(
                    row.role.as_str(),
                    "path"
                        | "call"
                        | "method"
                        | "field"
                        | "binding"
                        | "segment"
                        | "lifetime"
                        | "operator"
                )
            {
                return Err("invalid semantic reference");
            }
            match &row.target {
                SemanticTarget::Definition {
                    crate_name,
                    compiler_path,
                    ..
                } if !text(crate_name) || !text(compiler_path) => {
                    return Err("invalid semantic target");
                }
                SemanticTarget::Builtin { name } if !text(name) => {
                    return Err("invalid semantic builtin");
                }
                _ => {}
            }
            location(&row.location)?;
        }
        Ok(())
    }
}

impl SemanticStreamV1 {
    pub fn from_json(raw: &[u8]) -> Result<Self, &'static str> {
        if raw.len() > MAX_STREAM_BYTES {
            return Err("semantic stream byte limit");
        }
        let value: Self = serde_json::from_slice(raw).map_err(|_| "malformed semantic stream")?;
        value.validate()?;
        Ok(value)
    }
    pub fn validate(&self) -> Result<(), &'static str> {
        self.binding.validate()?;
        let bytes = encoded_size(self, MAX_STREAM_BYTES)?;
        if self.pages.len() > bytes / MIN_PAGE_BYTES {
            return Err("semantic page inventory limit");
        }
        let (mut definitions, mut references) = (0u64, 0u64);
        let mut observed = ObservedStreamState::default();
        let mut sources = std::collections::BTreeMap::new();
        for (ordinal, page) in self.pages.iter().enumerate() {
            page.validate()?;
            if page.ordinal != ordinal as u64 || page.binding != self.binding {
                return Err("noncontiguous semantic pages");
            }
            for row in &page.definitions {
                if row.ordinal != definitions {
                    return Err("noncontiguous semantic definitions");
                }
                definitions += 1;
            }
            for row in &page.references {
                observed.push(row)?;
                if row.ordinal != references {
                    return Err("noncontiguous semantic references");
                }
                references += 1;
            }
            for value in page
                .definitions
                .iter()
                .filter_map(|d| d.location.as_ref())
                .chain(page.references.iter().filter_map(|r| r.location.as_ref()))
            {
                let key = (
                    value.source_version,
                    &value.input.root,
                    &value.input.relative,
                );
                if sources
                    .insert(key, &value.input)
                    .is_some_and(|old| old != &value.input)
                {
                    return Err("conflicting semantic source version");
                }
            }
        }
        if let Some(t) = &self.terminal {
            let visited = t
                .visited_definitions
                .checked_add(t.visited_references)
                .ok_or("semantic terminal overflow")?;
            let emitted = definitions
                .checked_add(references)
                .ok_or("semantic terminal overflow")?;
            if t.binding != self.binding
                || t.emitted_pages != self.pages.len() as u64
                || t.emitted_definitions != definitions
                || t.emitted_references != references
                || t.visited_definitions < definitions
                || t.visited_references < references
                || t.unsupported > visited
                || visited > 3 * MAX_TRAVERSAL_WORK
                || t.omitted != visited - emitted
                || t.traversal_events > MAX_TRAVERSAL_WORK
                || t.source_work_bytes > MAX_SOURCE_WORK_BYTES
                || t.gaps.len() > 16
                || t.stop != TraversalStop::EndOfDomain && t.gaps.is_empty()
                || t.omitted != 0 && t.gaps.is_empty()
            {
                return Err("conflicting semantic terminal");
            }
            observed.finish(self.binding.domain, t)?;
        }
        Ok(())
    }
}

/// Local callback handoff, omitted from exports.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SemanticRequest {
    pub binding: SemanticBindingV1,
    pub output_directory: std::path::PathBuf,
    pub budget_directory: std::path::PathBuf,
}

/// Bounded on-disk inventory; pages are read only after all byte sizes are summed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SemanticPageEntry {
    pub ordinal: u64,
    pub bytes: usize,
    pub content_fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SemanticIndexV1 {
    pub binding: SemanticBindingV1,
    #[serde(deserialize_with = "bounded_list::<_, _, MAX_PAGES>")]
    pub pages: Vec<SemanticPageEntry>,
    pub terminal: SemanticTerminalV1,
}

pub fn page_fingerprint(raw: &[u8]) -> String {
    fingerprint(raw)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn stream() -> SemanticStreamV1 {
        let binding = SemanticBindingV1 {
            schema_version: 1,
            nonce: "one".into(),
            command_fingerprint: fingerprint(b"ordered"),
            crate_name: "demo".into(),
            metadata: None,
            domain: SemanticDomain::LocalHir,
        };
        SemanticStreamV1 {
            binding: binding.clone(),
            pages: vec![],
            terminal: Some(SemanticTerminalV1 {
                binding,
                stop: TraversalStop::EndOfDomain,
                traversal_events: 0,
                visited_definitions: 0,
                visited_references: 0,
                unsupported: 0,
                omitted: 0,
                emitted_definitions: 0,
                emitted_references: 0,
                emitted_pages: 0,
                source_work_bytes: 0,
                gaps: vec![],
            }),
        }
    }
    #[test]
    fn empty_observed_domain_and_interruption_counts_are_distinct() {
        let mut s = stream();
        s.validate().expect("empty observed domain");
        s.terminal.as_mut().expect("terminal").stop = TraversalStop::WorkLimit;
        assert!(s.validate().is_err());
        s.terminal
            .as_mut()
            .expect("terminal")
            .gaps
            .push(SemanticGap::TraversalWorkLimit);
        s.validate().expect("explicit interruption");
    }
    #[test]
    fn page_binding_order_and_terminal_totals_reject_substitution() {
        let mut s = stream();
        s.pages.push(SemanticPageV1 {
            binding: s.binding.clone(),
            ordinal: 1,
            definitions: vec![],
            references: vec![],
            gaps: vec![],
        });
        assert!(s.validate().is_err());
        s.pages[0].ordinal = 0;
        assert!(s.validate().is_err());
        s.terminal.as_mut().expect("terminal").emitted_pages = 1;
        s.validate().expect("one exact empty page");
        s.pages[0].binding.nonce = "different".into();
        assert!(s.validate().is_err());
    }
    #[test]
    fn page_limits_and_unknown_fields_preserve_distinct_legacy_shape() {
        let old = crate::compiler_occurrence::tests::fixture();
        assert!(
            crate::compiler_occurrence::CompilerOccurrencesV1::from_json(
                &serde_json::to_vec(&old).expect("legacy JSON")
            )
            .is_ok()
        );
        assert!(
            serde_json::from_slice::<SemanticStreamV1>(
                &serde_json::to_vec(&old).expect("legacy JSON")
            )
            .is_err()
        );
        let mut raw = serde_json::to_value(stream()).expect("stream JSON");
        raw["unexpected"] = true.into();
        assert!(serde_json::from_value::<SemanticStreamV1>(raw).is_err());
    }
    #[test]
    fn terminal_overflow_and_false_emitted_totals_reject() {
        let mut value = stream();
        let terminal = value.terminal.as_mut().unwrap();
        terminal.visited_definitions = u64::MAX;
        terminal.visited_references = 1;
        assert!(value.validate().is_err());
        let mut value = stream();
        value.terminal.as_mut().unwrap().emitted_references = 1;
        assert!(value.validate().is_err());
        value.terminal = None;
        value
            .validate()
            .expect("explicit absent terminal has no end-of-domain assertion");
    }

    #[test]
    fn bounded_deserialization_and_encoded_page_limit_are_independent() {
        let mut value = stream();
        let row = SemanticDefinition {
            ordinal: 0,
            local_index: 0,
            binding_owner: None,
            compiler_path: "demo::item".into(),
            kind: "Fn".into(),
            location: None,
        };
        let mut page = SemanticPageV1 {
            binding: value.binding.clone(),
            ordinal: 0,
            definitions: vec![row; 64],
            references: vec![],
            gaps: vec![],
        };
        page.validate().expect("64 finite definitions");
        page.definitions.push(page.definitions[0].clone());
        assert!(
            serde_json::from_slice::<SemanticPageV1>(&serde_json::to_vec(&page).unwrap()).is_err()
        );
        page.definitions.pop();
        for row in &mut page.definitions {
            row.compiler_path = "n".repeat(1024);
        }
        assert!(
            page.validate().is_err(),
            "64 rows do not create a new byte allowance"
        );
        value.pages.push(page);
        assert!(value.validate().is_err());
    }

    #[test]
    fn source_versions_retain_each_association_and_reject_conflicting_version() {
        let mut value = stream();
        let input = crate::compiler_occurrence::tests::fixture().definitions[0]
            .input
            .clone();
        let range = crate::compiler_occurrence::tests::fixture().definitions[0]
            .range
            .clone();
        let row = SemanticDefinition {
            ordinal: 0,
            local_index: 1,
            binding_owner: None,
            compiler_path: "demo::one".into(),
            kind: "Fn".into(),
            location: Some(SemanticLocation {
                input,
                source_version: 100,
                range,
            }),
        };
        let mut second = row.clone();
        second.ordinal = 1;
        second.local_index = 2;
        second.location.as_mut().unwrap().source_version = 200;
        value.pages.push(SemanticPageV1 {
            binding: value.binding.clone(),
            ordinal: 0,
            definitions: vec![row, second],
            references: vec![],
            gaps: vec![],
        });
        let t = value.terminal.as_mut().unwrap();
        t.visited_definitions = 2;
        t.emitted_definitions = 2;
        t.emitted_pages = 1;
        t.source_work_bytes = value.pages[0].definitions[0]
            .location
            .as_ref()
            .unwrap()
            .input
            .bytes;
        value
            .validate()
            .expect("distinct source-map versions retain both associations");
        value.pages[0].definitions[1]
            .location
            .as_mut()
            .unwrap()
            .source_version = 100;
        value.pages[0].definitions[1]
            .location
            .as_mut()
            .unwrap()
            .input
            .content_fingerprint = fingerprint(b"changed");
        assert!(value.validate().is_err());
    }
}

fn validate_observed_target(
    domain: SemanticDomain,
    row: &SemanticReference,
) -> Result<bool, &'static str> {
    let (role, harness) = match &row.target {
        SemanticTarget::CompilerContext { context } => {
            context.validate()?;
            ("compiler_context", false)
        }
        SemanticTarget::EffectiveCfg { cfg } => {
            cfg.validate()?;
            ("effective_cfg", false)
        }
        SemanticTarget::TargetFeature { feature } => {
            feature.validate()?;
            ("target_feature", false)
        }
        SemanticTarget::TestHarnessEntry { entry } => {
            entry.validate()?;
            ("test_harness_entry", true)
        }
        SemanticTarget::TestHarnessDescriptor { descriptor } => {
            descriptor.validate()?;
            ("test_harness_descriptor", true)
        }
        _ => return Ok(false),
    };
    if domain == SemanticDomain::LocalHir
        || harness && domain != SemanticDomain::LocalHirWithTestHarness
        || row.role != role
    {
        return Err("observation target outside requested semantic domain");
    }
    if !harness && row.location.is_some() {
        return Err("Session metadata is not a HIR source occurrence");
    }
    Ok(true)
}

#[derive(Default)]
struct ObservedStreamState<'a> {
    context: Option<&'a crate::compiler_context::CompilerContextObservation>,
    harness: Option<&'a crate::compiler_test_harness::TestHarnessEntryObservation>,
    cfg: u64,
    stable: u64,
    all: u64,
    descriptors: u64,
    last_name: Option<&'a str>,
    cfg_keys: std::collections::BTreeSet<(&'a str, Option<&'a str>)>,
    stable_keys: std::collections::BTreeSet<&'a str>,
    all_keys: std::collections::BTreeSet<&'a str>,
    constants: std::collections::BTreeSet<&'a str>,
}
impl<'a> ObservedStreamState<'a> {
    fn push(&mut self, row: &'a SemanticReference) -> Result<(), &'static str> {
        match &row.target {
            SemanticTarget::CompilerContext { context } => {
                if self.context.replace(context).is_some() {
                    return Err("duplicate Session observation");
                }
            }
            SemanticTarget::EffectiveCfg { cfg } => {
                let header = self.context.ok_or("missing Session observation header")?;
                if cfg.ordinal != self.cfg || self.cfg >= header.cfg_entries {
                    return Err("noncontiguous effective cfg rows");
                }
                if !self.cfg_keys.insert((&cfg.name, cfg.value.as_deref())) {
                    return Err("duplicate effective cfg row");
                }
                self.cfg += 1;
            }
            SemanticTarget::TargetFeature { feature } => {
                let header = self.context.ok_or("missing Session observation header")?;
                let (count, limit) = match feature.inventory {
                    crate::compiler_context::TargetFeatureInventory::Stable => {
                        (&mut self.stable, header.stable_target_feature_entries)
                    }
                    crate::compiler_context::TargetFeatureInventory::IncludingUnstable => {
                        (&mut self.all, header.all_target_feature_entries)
                    }
                };
                if feature.ordinal != *count || *count >= limit {
                    return Err("noncontiguous target feature rows");
                }
                let keys = match feature.inventory {
                    crate::compiler_context::TargetFeatureInventory::Stable => {
                        &mut self.stable_keys
                    }
                    crate::compiler_context::TargetFeatureInventory::IncludingUnstable => {
                        &mut self.all_keys
                    }
                };
                if !keys.insert(&feature.name) {
                    return Err("duplicate target feature row");
                }
                *count += 1;
            }
            SemanticTarget::TestHarnessEntry { entry } => {
                if self.harness.replace(entry).is_some() {
                    return Err("duplicate generated harness entry");
                }
            }
            SemanticTarget::TestHarnessDescriptor { descriptor } => {
                let header = self.harness.ok_or("missing generated harness entry")?;
                if descriptor.table_ordinal != self.descriptors
                    || self.descriptors >= header.table_entries
                    || self
                        .last_name
                        .is_some_and(|name| name >= descriptor.name.as_str())
                    || descriptor.descriptor_type != header.descriptor_type
                    || !descriptor.constant.same_crate(&header.entry)
                {
                    return Err("inconsistent generated descriptor table");
                }
                if !self.constants.insert(&descriptor.constant.def_path_hash) {
                    return Err("duplicate generated descriptor constant");
                }
                self.last_name = Some(&descriptor.name);
                self.descriptors += 1;
            }
            _ => {}
        }
        Ok(())
    }
    fn finish(
        &self,
        domain: SemanticDomain,
        terminal: &SemanticTerminalV1,
    ) -> Result<(), &'static str> {
        if domain == SemanticDomain::LocalHir {
            return Ok(());
        }
        let interrupted = terminal.stop != TraversalStop::EndOfDomain;
        let context_gap = interrupted
            || terminal.gaps.iter().any(|gap| {
                matches!(
                    gap,
                    SemanticGap::CompilerContextUnavailable
                        | SemanticGap::CompilerContextUnsupportedValue
                )
            });
        let complete_context = self.context.is_some_and(|header| {
            self.cfg == header.cfg_entries
                && self.stable == header.stable_target_feature_entries
                && self.all == header.all_target_feature_entries
                && self.stable_keys.is_subset(&self.all_keys)
        });
        if !complete_context && !context_gap {
            return Err("incomplete compiler Session rows without gap");
        }
        if domain == SemanticDomain::LocalHirWithTestHarness {
            let harness_gap = interrupted
                || terminal.gaps.iter().any(|gap| {
                    matches!(
                        gap,
                        SemanticGap::TestHarnessUnavailable
                            | SemanticGap::TestHarnessCustomRunner
                            | SemanticGap::TestHarnessUnsupportedDescriptor
                            | SemanticGap::TestHarnessOwnerMismatch
                            | SemanticGap::TestHarnessCrateSourceUnavailable
                            | SemanticGap::TestHarnessOrderingUnknown
                    )
                });
            if !self
                .harness
                .is_some_and(|header| self.descriptors == header.table_entries)
                && !harness_gap
            {
                return Err("incomplete generated harness rows without gap");
            }
        }
        Ok(())
    }
}
