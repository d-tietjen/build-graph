//! Actual analysis-callback observations. Consistency markers are not custody
//! or cryptographic integrity; downstream readers must qualify original bytes.
//!
//! This module is shared with the standalone nightly driver. It deliberately
//! has no graph, compiler-internal, service or host-policy dependency.

use serde::{Deserialize, Serialize};

pub const OCCURRENCES_VERSION: u32 = 1;
pub const MAX_OCCURRENCE_BYTES: usize = 24 * 1024;
pub const MAX_DEFINITIONS: usize = 64;
pub const MAX_REFERENCES: usize = 64;
pub const MAX_SOURCE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_SOURCE_TOTAL_BYTES: usize = 32 * 1024 * 1024;

/// Local-only handoff to one callback; never included in the public export.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CallbackRequest {
    pub schema_version: u32,
    pub nonce: String,
    pub command_fingerprint: String,
    pub crate_name: String,
    pub metadata: Option<String>,
    pub source: std::path::PathBuf,
    pub source_root: std::path::PathBuf,
    pub target_root: std::path::PathBuf,
    pub output: std::path::PathBuf,
}

pub fn fingerprint(bytes: &[u8]) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("fnv1a64:{hash:016x}")
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OccurrenceRoot {
    Source,
    Target,
}

/// Source-map buffer delivered to this compiler. Target is a generated-file
/// location, not proof of its generator or its ordering relative to this unit.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OccurrenceInput {
    pub root: OccurrenceRoot,
    pub relative: String,
    pub bytes: u64,
    pub content_fingerprint: String,
}

/// Raw compiler coordinates: one-based lines, zero-based character columns and
/// an exclusive end. Rustdoc JSON columns are one-based; no rebasing is performed
/// in this callback record.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OccurrenceRange {
    pub begin_line: usize,
    pub begin_column: usize,
    pub end_line: usize,
    pub end_column: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DefinitionOccurrence {
    pub package: String,
    pub def_path: String,
    pub kind: String,
    pub definition_key: String,
    pub legacy_id: String,
    pub range: OccurrenceRange,
    pub input: OccurrenceInput,
}

/// A reference actually visited in this invocation, with both exact definition
/// tuples. No global attachment ordinal or enclosing-function guess is emitted.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReferenceOccurrence {
    pub source: DefinitionOccurrence,
    pub target: DefinitionOccurrence,
    pub relation: String,
    pub confidence: String,
    pub confidence_score: u8,
    pub weight: u8,
    pub range: OccurrenceRange,
    pub input: OccurrenceInput,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OccurrenceGap {
    BudgetExceeded,
    UnsupportedDefinition,
    UnsupportedExpansion,
    SourceUnavailable,
    SourceChanged,
    ExternalIdentityUnknown,
    GeneratorLineageUnknown,
    AnalysisCoveragePartial,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompilerOccurrencesV1 {
    pub schema_version: u32,
    /// Fresh callback handoff, scoped to this run and compiler slot.
    pub nonce: String,
    /// FNV of the enclosing invocation's ordered normalized command. The full
    /// serialized invocation binds Cargo's later exact unit join as well.
    pub command_fingerprint: String,
    pub crate_name: String,
    pub metadata: Option<String>,
    pub definitions: Vec<DefinitionOccurrence>,
    pub references: Vec<ReferenceOccurrence>,
    pub gaps: Vec<OccurrenceGap>,
}

pub fn definition_key(package: &str, path: &str, kind: &str) -> String {
    fn hex(value: &str) -> String {
        value
            .as_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }
    format!("definition:v1:{}:{}:{}", hex(package), hex(path), hex(kind))
}

pub fn legacy_id(package: &str, path: &str, kind: &str) -> String {
    fn norm(s: &str) -> String {
        s.chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() {
                    c.to_ascii_lowercase()
                } else {
                    '_'
                }
            })
            .collect()
    }
    format!("item__{}__{}__{}", norm(package), norm(path), norm(kind))
}

impl CompilerOccurrencesV1 {
    pub fn from_json(raw: &[u8]) -> Result<Self, &'static str> {
        if raw.len() > MAX_OCCURRENCE_BYTES {
            return Err("occurrence budget exceeded");
        }
        let result: Self = serde_json::from_slice(raw).map_err(|_| "malformed occurrences")?;
        result.validate()?;
        Ok(result)
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        if self.schema_version != OCCURRENCES_VERSION
            || self.definitions.len() > MAX_DEFINITIONS
            || self.references.len() > MAX_REFERENCES
            || self.gaps.len() > 16
            || !marker(&self.command_fingerprint)
            || !text(&self.crate_name)
            || !text(&self.nonce)
            || self.metadata.as_ref().is_some_and(|v| !text(v))
        {
            return Err("invalid occurrence envelope");
        }
        // Bound serialized size before allocating its Value representation.
        struct Cap(usize);
        impl std::io::Write for Cap {
            fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                self.0 = self
                    .0
                    .checked_sub(b.len())
                    .ok_or_else(|| std::io::Error::other("cap"))?;
                Ok(b.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        serde_json::to_writer(Cap(MAX_OCCURRENCE_BYTES), self)
            .map_err(|_| "occurrence budget exceeded")?;
        let mut definitions = std::collections::BTreeSet::new();
        let mut inputs = std::collections::BTreeMap::new();
        for def in &self.definitions {
            validate_definition(def)?;
            if self
                .definitions
                .first()
                .is_some_and(|first| first.package != def.package)
            {
                return Err("conflicting occurrence package");
            }
            if !definitions.insert(def) {
                return Err("duplicate definition occurrence");
            }
            let key = (&def.input.root, &def.input.relative);
            if inputs
                .insert(key, &def.input)
                .is_some_and(|old| old != &def.input)
            {
                return Err("conflicting source buffer");
            }
            if def.input.root == OccurrenceRoot::Target
                && !self.gaps.contains(&OccurrenceGap::GeneratorLineageUnknown)
            {
                return Err("unaccounted generator identity");
            }
        }
        let total = inputs
            .values()
            .try_fold(0u64, |n, input| n.checked_add(input.bytes))
            .ok_or("source buffer budget exceeded")?;
        if total > MAX_SOURCE_TOTAL_BYTES as u64 {
            return Err("source buffer budget exceeded");
        }
        let mut refs = std::collections::BTreeSet::new();
        for edge in &self.references {
            if !definitions.contains(&edge.source)
                || !definitions.contains(&edge.target)
                || !refs.insert(edge)
                || !matches!(edge.relation.as_str(), "calls" | "uses")
                || edge.confidence != "EXTRACTED"
                || edge.confidence_score != 1
                || edge.weight != 1
                || edge.input != edge.source.input
            {
                return Err("invalid reference occurrence");
            }
            validate_range(&edge.range)?;
        }
        Ok(())
    }
}

fn text(s: &str) -> bool {
    !s.is_empty() && s.len() <= 1024 && !s.contains(['\0', '\n', '\r', '/', '\\'])
}
fn marker(s: &str) -> bool {
    s.strip_prefix("fnv1a64:")
        .is_some_and(|s| s.len() == 16 && s.bytes().all(|b| b.is_ascii_hexdigit()))
}
fn validate_range(r: &OccurrenceRange) -> Result<(), &'static str> {
    if r.begin_line == 0
        || [r.begin_line, r.begin_column, r.end_line, r.end_column]
            .iter()
            .any(|n| *n > MAX_SOURCE_BYTES + 1)
        || (r.begin_line, r.begin_column) >= (r.end_line, r.end_column)
    {
        return Err("invalid occurrence range");
    }
    Ok(())
}
fn validate_definition(d: &DefinitionOccurrence) -> Result<(), &'static str> {
    if !text(&d.package)
        || !text(&d.def_path)
        || !text(&d.kind)
        || d.definition_key != definition_key(&d.package, &d.def_path, &d.kind)
        || d.legacy_id != legacy_id(&d.package, &d.def_path, &d.kind)
        || d.input.relative.is_empty()
        || d.input.relative.len() > 4096
        || d.input.relative.contains(['\\', ':', '\0'])
        || d.input
            .relative
            .split('/')
            .any(|s| s.is_empty() || s == "." || s == "..")
        || d.input.bytes > MAX_SOURCE_BYTES as u64
        || !marker(&d.input.content_fingerprint)
    {
        return Err("invalid definition occurrence");
    }
    validate_range(&d.range)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    pub(crate) fn fixture() -> CompilerOccurrencesV1 {
        let d = DefinitionOccurrence {
            package: "demo".into(),
            def_path: "source".into(),
            kind: "function".into(),
            definition_key: definition_key("demo", "source", "function"),
            legacy_id: legacy_id("demo", "source", "function"),
            range: OccurrenceRange {
                begin_line: 1,
                begin_column: 0,
                end_line: 1,
                end_column: 18,
            },
            input: OccurrenceInput {
                root: OccurrenceRoot::Source,
                relative: "src/lib.rs".into(),
                bytes: 18,
                content_fingerprint: fingerprint(b"pub fn source() {}"),
            },
        };
        CompilerOccurrencesV1 {
            schema_version: 1,
            nonce: "fresh-1".into(),
            command_fingerprint: fingerprint(b"command"),
            crate_name: "demo".into(),
            metadata: Some("abc".into()),
            definitions: vec![d],
            references: Vec::new(),
            gaps: vec![OccurrenceGap::AnalysisCoveragePartial],
        }
    }

    #[test]
    fn exact_occurrences_round_trip_without_attachment_ordinals() {
        let value = fixture();
        let raw = serde_json::to_vec(&value).expect("JSON");
        assert_eq!(
            CompilerOccurrencesV1::from_json(&raw).expect("valid"),
            value
        );
        assert!(!String::from_utf8(raw).expect("UTF8").contains("ordinal"));
    }
    #[test]
    fn malformed_unknown_and_oversized_occurrences_reject() {
        assert!(CompilerOccurrencesV1::from_json(b"secret").is_err());
        assert!(CompilerOccurrencesV1::from_json(&vec![b' '; MAX_OCCURRENCE_BYTES + 1]).is_err());
        let mut value = serde_json::to_value(fixture()).expect("JSON");
        value["complete"] = true.into();
        assert!(
            CompilerOccurrencesV1::from_json(&serde_json::to_vec(&value).expect("JSON")).is_err()
        );
        let mut value = fixture();
        value
            .definitions
            .resize(MAX_DEFINITIONS + 1, value.definitions[0].clone());
        assert!(value.validate().is_err());
    }
    #[test]
    fn duplicate_conflicting_identity_and_buffer_reject() {
        let mut value = fixture();
        value.definitions.push(value.definitions[0].clone());
        assert!(value.validate().is_err());
        let mut value = fixture();
        value.definitions[0].legacy_id = "guessed".into();
        assert!(value.validate().is_err());
        let mut value = fixture();
        let mut other = value.definitions[0].clone();
        other.range.begin_column += 1;
        other.input.content_fingerprint = fingerprint(b"changed");
        value.definitions.push(other);
        assert!(value.validate().is_err());
        let mut value = fixture();
        let mut other = value.definitions[0].clone();
        other.package = "unrelated".into();
        other.definition_key = definition_key(&other.package, &other.def_path, &other.kind);
        other.legacy_id = legacy_id(&other.package, &other.def_path, &other.kind);
        value.definitions.push(other);
        assert!(value.validate().is_err());
    }
    #[test]
    fn references_require_exact_both_endpoints_and_consumed_source() {
        let mut value = fixture();
        let d = value.definitions[0].clone();
        let r = ReferenceOccurrence {
            source: d.clone(),
            target: d.clone(),
            input: d.input.clone(),
            range: d.range.clone(),
            relation: "calls".into(),
            confidence: "EXTRACTED".into(),
            confidence_score: 1,
            weight: 1,
        };
        value.references.push(r);
        value.validate().expect("actual shape");
        value.references[0].target.range.begin_column += 1;
        assert!(value.validate().is_err());
        value.references[0].target = d;
        value.references[0].input.content_fingerprint = fingerprint(b"changed");
        assert!(value.validate().is_err());
    }
    #[test]
    fn generated_buffer_requires_explicit_unknown_lineage() {
        let mut value = fixture();
        value.definitions[0].input.root = OccurrenceRoot::Target;
        assert!(value.validate().is_err());
        value.gaps.push(OccurrenceGap::GeneratorLineageUnknown);
        value.validate().expect("partial generated observation");
    }
    #[test]
    fn original_ranges_and_portable_buffers_are_validated() {
        for path in ["/host/private", "../outside", "a//b", "C:source"] {
            let mut value = fixture();
            value.definitions[0].input.relative = path.into();
            assert!(value.validate().is_err());
        }
        let mut value = fixture();
        value.definitions[0].range.begin_line = 0;
        assert!(value.validate().is_err());
    }

    #[test]
    fn cumulative_source_buffer_budget_is_finite() {
        let mut value = fixture();
        let d = value.definitions[0].clone();
        value.definitions.clear();
        for i in 0..5 {
            let mut d = d.clone();
            d.input.relative = format!("src/input{i}.rs");
            d.input.bytes = MAX_SOURCE_BYTES as u64;
            value.definitions.push(d);
        }
        assert!(value.validate().is_err());
        value.definitions.pop();
        value.validate().expect("exact 32 MiB bound");
    }
}
