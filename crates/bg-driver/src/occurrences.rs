//! Supplemental observations from this compiler's source map and HIR only.
use crate::compiler_occurrence::*;
use rustc_hir::def::DefKind;
use rustc_middle::ty::TyCtxt;
use rustc_span::{
    def_id::{DefId, LOCAL_CRATE},
    Span,
};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::{Read, Write};
use std::path::PathBuf;

pub struct Collector {
    request: CallbackRequest,
    value: CompilerOccurrencesV1,
    definitions: HashMap<DefId, DefinitionOccurrence>,
    sources: BTreeMap<PathBuf, (u32, OccurrenceInput)>,
    budget: usize,
}

impl Collector {
    pub fn new(tcx: TyCtxt<'_>) -> Option<Self> {
        let path = PathBuf::from(std::env::var_os("BG_DRIVER_OCCURRENCE_REQUEST")?);
        let meta = std::fs::symlink_metadata(&path).ok()?;
        if !meta.is_file() || meta.len() > 32 * 1024 {
            return None;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            unsafe extern "C" {
                fn geteuid() -> u32;
            }
            let parent = std::fs::symlink_metadata(path.parent()?).ok()?;
            // SAFETY: the platform's geteuid takes no arguments or pointers.
            let uid = unsafe { geteuid() };
            if meta.nlink() != 1
                || meta.mode() & 0o777 != 0o600
                || meta.uid() != uid
                || !parent.is_dir()
                || parent.uid() != uid
                || parent.mode() & 0o777 != 0o700
            {
                return None;
            }
        }
        let mut raw = Vec::new();
        let mut file = std::fs::File::open(&path).ok()?;
        let opened = file.metadata().ok()?;
        Read::by_ref(&mut file)
            .take(32 * 1024 + 1)
            .read_to_end(&mut raw)
            .ok()?;
        let after = std::fs::symlink_metadata(&path).ok()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let same = |m: &std::fs::Metadata| {
                m.dev() == meta.dev()
                    && m.ino() == meta.ino()
                    && m.nlink() == 1
                    && m.uid() == meta.uid()
                    && m.mode() == meta.mode()
                    && m.len() == meta.len()
                    && m.mtime() == meta.mtime()
                    && m.mtime_nsec() == meta.mtime_nsec()
                    && m.ctime() == meta.ctime()
                    && m.ctime_nsec() == meta.ctime_nsec()
            };
            if !same(&opened)
                || !same(&file.metadata().ok()?)
                || !same(&after)
                || raw.len() as u64 != meta.len()
            {
                return None;
            }
        }
        #[cfg(not(unix))]
        {
            let _ = (opened, after);
            return None;
        }
        let request: CallbackRequest = serde_json::from_slice(&raw).ok()?;
        let actual_source = std::env::args()
            .skip(1)
            .find(|v| !v.starts_with('-') && v.ends_with(".rs"))?;
        if request.schema_version != OCCURRENCES_VERSION
            || request.nonce.len() > 128
            || request.nonce.is_empty()
            || request.crate_name != tcx.crate_name(LOCAL_CRATE).to_string()
            || request.metadata
                != (!tcx.sess.opts.cg.metadata.is_empty())
                    .then(|| tcx.sess.opts.cg.metadata.join(""))
            || std::fs::canonicalize(actual_source).ok()? != request.source
            || request.output.parent() != path.parent()
            || request.output.exists()
        {
            return None;
        }
        let value = CompilerOccurrencesV1 {
            schema_version: OCCURRENCES_VERSION,
            nonce: request.nonce.clone(),
            command_fingerprint: request.command_fingerprint.clone(),
            crate_name: request.crate_name.clone(),
            metadata: request.metadata.clone(),
            definitions: Vec::new(),
            references: Vec::new(),
            gaps: vec![OccurrenceGap::AnalysisCoveragePartial],
        };
        Some(Self {
            request,
            value,
            definitions: HashMap::new(),
            sources: BTreeMap::new(),
            budget: MAX_SOURCE_TOTAL_BYTES,
        })
    }

    fn gap(&mut self, gap: OccurrenceGap) {
        if !self.value.gaps.contains(&gap) {
            self.value.gaps.push(gap);
        }
    }

    fn location(
        &mut self,
        tcx: TyCtxt<'_>,
        span: Span,
    ) -> Option<(OccurrenceInput, OccurrenceRange)> {
        if span.is_dummy() {
            self.gap(OccurrenceGap::UnsupportedExpansion);
            return None;
        }
        let sm = tcx.sess.source_map();
        let lo = sm.lookup_char_pos(span.lo());
        let hi = sm.lookup_char_pos(span.hi());
        if lo.file.start_pos != hi.file.start_pos {
            self.gap(OccurrenceGap::SourceUnavailable);
            return None;
        }
        let Some(local_path) = (match &lo.file.name {
            rustc_span::FileName::Real(real) => real.local_path(),
            _ => None,
        }) else {
            self.gap(OccurrenceGap::SourceUnavailable);
            return None;
        };
        let Some(path) = std::fs::canonicalize(local_path).ok() else {
            self.gap(OccurrenceGap::SourceUnavailable);
            return None;
        };
        if span.from_expansion() && !path.starts_with(&self.request.target_root) {
            self.gap(OccurrenceGap::UnsupportedExpansion);
            return None;
        }
        let input = if let Some((_, input)) = self
            .sources
            .get(&path)
            .filter(|(start, _)| *start == lo.file.start_pos.0)
        {
            input.clone()
        } else {
            let Some(src) = lo.file.src.as_ref() else {
                self.gap(OccurrenceGap::SourceUnavailable);
                return None;
            };
            let bytes = src.as_bytes();
            if bytes.len() > MAX_SOURCE_BYTES || bytes.len() > self.budget {
                self.gap(OccurrenceGap::BudgetExceeded);
                return None;
            }
            self.budget -= bytes.len();
            // Hash the compiler-owned buffer, never a dep-info-listed file read.
            let (root, base) = if path.starts_with(&self.request.target_root) {
                self.gap(OccurrenceGap::GeneratorLineageUnknown);
                (OccurrenceRoot::Target, &self.request.target_root)
            } else if path.starts_with(&self.request.source_root) {
                (OccurrenceRoot::Source, &self.request.source_root)
            } else {
                self.gap(OccurrenceGap::SourceUnavailable);
                return None;
            };
            let relative = path.strip_prefix(base).ok()?.to_str()?.replace('\\', "/");
            let input = OccurrenceInput {
                root,
                relative,
                bytes: bytes.len() as u64,
                content_fingerprint: fingerprint(bytes),
            };
            if self
                .sources
                .get(&path)
                .is_some_and(|(_, old)| old != &input)
            {
                self.gap(OccurrenceGap::SourceChanged);
                return None;
            }
            self.sources
                .insert(path, (lo.file.start_pos.0, input.clone()));
            input
        };
        Some((
            input,
            OccurrenceRange {
                begin_line: lo.line,
                begin_column: lo.col.0,
                end_line: hi.line,
                end_column: hi.col.0,
            },
        ))
    }

    pub fn definition(&mut self, tcx: TyCtxt<'_>, did: DefId) -> Option<DefinitionOccurrence> {
        if let Some(value) = self.definitions.get(&did) {
            return Some(value.clone());
        }
        if did.krate != LOCAL_CRATE {
            self.gap(OccurrenceGap::ExternalIdentityUnknown);
            return None;
        }
        if self.value.definitions.len() >= MAX_DEFINITIONS {
            self.gap(OccurrenceGap::BudgetExceeded);
            return None;
        }
        let kind = match tcx.def_kind(did) {
            DefKind::Mod => "module",
            DefKind::Struct => "struct",
            DefKind::Enum => "enum",
            DefKind::Union => "union",
            DefKind::Field => "field",
            DefKind::Variant => "variant",
            DefKind::Fn => "function",
            DefKind::AssocFn => "method",
            DefKind::Trait | DefKind::TraitAlias => "trait",
            DefKind::TyAlias | DefKind::AssocTy => "type",
            DefKind::Const | DefKind::AssocConst => "const",
            DefKind::Static { .. } => "static",
            _ => {
                self.gap(OccurrenceGap::UnsupportedDefinition);
                return None;
            }
        };
        let full = tcx.def_path_str(did);
        let Some(path) = full.strip_prefix(&format!("{}::", self.value.crate_name)) else {
            self.gap(OccurrenceGap::UnsupportedDefinition);
            return None;
        };
        // Impl/closure compiler paths are not rustdoc's named-item paths. Never
        // relabel or roll them up onto an enclosing global graph definition.
        if path.contains(['{', '}', '<', '>']) {
            self.gap(OccurrenceGap::UnsupportedDefinition);
            return None;
        }
        let Some(package) = std::env::var("CARGO_PKG_NAME")
            .ok()
            .filter(|v| !v.is_empty() && v.len() < 256)
        else {
            self.gap(OccurrenceGap::UnsupportedDefinition);
            return None;
        };
        let (input, range) = self.location(tcx, tcx.def_span(did))?;
        let value = DefinitionOccurrence {
            definition_key: definition_key(&package, path, kind),
            legacy_id: legacy_id(&package, path, kind),
            package,
            def_path: path.into(),
            kind: kind.into(),
            range,
            input,
        };
        self.value.definitions.push(value.clone());
        if self.value.validate().is_err() {
            self.value.definitions.pop();
            self.gap(OccurrenceGap::BudgetExceeded);
            return None;
        }
        self.definitions.insert(did, value.clone());
        Some(value)
    }

    pub fn reference(
        &mut self,
        tcx: TyCtxt<'_>,
        source: DefId,
        target: DefId,
        kind: &str,
        span: Span,
    ) {
        if self.value.references.len() >= MAX_REFERENCES {
            self.gap(OccurrenceGap::BudgetExceeded);
            return;
        }
        let Some(source) = self.definition(tcx, source) else {
            return;
        };
        let Some(target) = self.definition(tcx, target) else {
            return;
        };
        let Some((input, range)) = self.location(tcx, span) else {
            return;
        };
        if source.input != input {
            self.gap(OccurrenceGap::UnsupportedExpansion);
            return;
        }
        let value = ReferenceOccurrence {
            source,
            target,
            input,
            range,
            relation: if kind == "call" { "calls" } else { "uses" }.into(),
            confidence: "EXTRACTED".into(),
            confidence_score: 1,
            weight: 1,
        };
        if self.value.references.contains(&value) {
            return;
        }
        self.value.references.push(value);
        if self.value.validate().is_err() {
            self.value.references.pop();
            self.gap(OccurrenceGap::BudgetExceeded);
        }
    }

    pub fn publish(mut self) {
        self.value.definitions.sort();
        self.value.references.sort();
        self.value.gaps = self
            .value
            .gaps
            .into_iter()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        if self.value.validate().is_err() {
            eprintln!("[bg-driver] occurrences: invalid callback record");
            return;
        }
        let Ok(raw) = serde_json::to_vec(&self.value) else {
            return;
        };
        if CompilerOccurrencesV1::from_json(&raw).is_err() {
            return;
        }
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options
            .open(&self.request.output)
            .and_then(|mut file| file.write_all(&raw))
        {
            Ok(()) => eprintln!(
                "[bg-driver] occurrences: {} definitions, {} references, {} gaps",
                self.value.definitions.len(),
                self.value.references.len(),
                self.value.gaps.len()
            ),
            Err(_) => eprintln!("[bg-driver] occurrences: publication unavailable"),
        }
    }
}
