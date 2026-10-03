//! Whole local HIR traversal with streamed finite observational pages.
use crate::compiler_semantic::*;
use crate::occurrences::Collector;
use rustc_hir::def::Res;
use rustc_hir::intravisit::{self, Visitor};
use rustc_hir::{
    Body, Expr, ExprKind, HirId, Lifetime, LifetimeKind, Pat, PatKind, Path as HirPath,
    PathSegment, QPath,
};
use rustc_middle::{
    hir::nested_filter,
    ty::{self, TyCtxt, TypeckResults},
};
use rustc_span::{
    def_id::{DefId, LOCAL_CRATE},
    Span,
};
use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::ops::ControlFlow;
use std::path::PathBuf;
use std::time::Duration;

struct Lock(PathBuf);
impl Drop for Lock {
    fn drop(&mut self) {
        let _ = fs::remove_dir(&self.0);
    }
}

// The counter spans all compiler callbacks in this extraction directory. A
// short exclusive directory operation protects only finite byte accounting.
fn reserve(directory: &std::path::Path, bytes: usize) -> std::io::Result<usize> {
    let lock = directory.join("semantic-budget-lock");
    let mut held = None;
    for _ in 0..50 {
        match fs::create_dir(&lock) {
            Ok(()) => {
                held = Some(Lock(lock.clone()));
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                std::thread::sleep(Duration::from_millis(2))
            }
            Err(e) => return Err(e),
        }
    }
    let _held = held.ok_or_else(|| std::io::Error::other("semantic accounting interrupted"))?;
    let path = directory.join("semantic-budget-bytes");
    let used = match fs::symlink_metadata(&path) {
        Ok(info) => {
            if !info.is_file() || info.len() > 32 || !private_file(&info, directory)? {
                return Err(std::io::Error::other("semantic accounting unavailable"));
            }
            let mut raw = String::new();
            let file = File::open(&path)?;
            if !same_file(&info, &file.metadata()?) || !private_file(&info, directory)? {
                return Err(std::io::Error::other("semantic accounting changed"));
            }
            (&file).take(33).read_to_string(&mut raw)?;
            if !same_file(&info, &file.metadata()?)
                || !same_file(&info, &fs::symlink_metadata(&path)?)
            {
                return Err(std::io::Error::other("semantic accounting changed"));
            }
            raw.parse::<usize>()
                .map_err(|_| std::io::Error::other("semantic accounting unavailable"))?
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0,
        Err(e) => return Err(e),
    };
    let total = used
        .checked_add(bytes)
        .filter(|n| *n <= MAX_STREAM_BYTES)
        .ok_or_else(|| std::io::Error::other("semantic output limit"))?;
    let mut options = OpenOptions::new();
    options.write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path)?;
    if !private_file(&file.metadata()?, directory)?
        || !same_file(&file.metadata()?, &fs::symlink_metadata(&path)?)
    {
        return Err(std::io::Error::other("semantic accounting changed"));
    }
    file.set_len(0)?;
    write!(file, "{total}")?;
    file.sync_all()?;
    if !same_file(&file.metadata()?, &fs::symlink_metadata(&path)?) {
        return Err(std::io::Error::other("semantic accounting changed"));
    }
    Ok(MAX_STREAM_BYTES - total)
}

fn same_file(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        a.dev() == b.dev()
            && a.ino() == b.ino()
            && a.len() == b.len()
            && a.mode() == b.mode()
            && a.uid() == b.uid()
            && a.nlink() == b.nlink()
            && a.mtime() == b.mtime()
            && a.mtime_nsec() == b.mtime_nsec()
            && a.ctime() == b.ctime()
            && a.ctime_nsec() == b.ctime_nsec()
    }
    #[cfg(not(unix))]
    {
        let _ = (a, b);
        false
    }
}

fn private_file(info: &fs::Metadata, parent: &std::path::Path) -> std::io::Result<bool> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let parent = fs::symlink_metadata(parent)?;
        Ok(info.is_file()
            && info.nlink() == 1
            && info.mode() & 0o777 == 0o600
            && parent.is_dir()
            && parent.mode() & 0o777 == 0o700
            && info.uid() == parent.uid())
    }
    #[cfg(not(unix))]
    {
        let _ = (info, parent);
        Ok(false)
    }
}

fn exclusive(path: &std::path::Path, raw: &[u8]) -> std::io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(raw)?;
    file.sync_all()
}

struct Writer {
    request: SemanticRequest,
    page: SemanticPageV1,
    entries: Vec<SemanticPageEntry>,
    terminal: SemanticTerminalV1,
    source_versions: BTreeSet<u32>,
    stopped: bool,
    max_pages: usize,
}

impl Writer {
    #[cfg(target_os = "linux")]
    fn new_with_controls(
        collector: &Collector,
        controls: &crate::held_callback_control::InheritedControls,
    ) -> Option<Self> {
        use crate::held_callback_control::InheritedControls;
        use std::os::unix::fs::MetadataExt;
        let raw = match controls {
            InheritedControls::LegacyPath => return Self::new(collector),
            InheritedControls::Unavailable(_) => return None,
            InheritedControls::Sealed(value) => value.semantic_bytes()?,
        };
        let path = PathBuf::from(std::env::var_os("BG_DRIVER_SEMANTIC_REQUEST")?);
        let parent = collector.semantic_parent()?;
        let parent_info = fs::symlink_metadata(parent).ok()?;
        // SAFETY: geteuid takes no pointer arguments.
        if !path.is_absolute()
            || path.parent()? != parent
            || !parent_info.is_dir()
            || parent_info.mode() & 0o777 != 0o700
            || parent_info.uid() != unsafe { libc::geteuid() }
        {
            return None;
        }
        let request: SemanticRequest = serde_json::from_slice(raw).ok()?;
        if request.binding != collector.semantic_binding()
            || request.binding.validate().is_err()
            || request.budget_directory != parent
            || request.output_directory.parent()? != parent
            || fs::canonicalize(parent).ok()? != parent
            || request.output_directory.exists()
        {
            return None;
        }
        // Reserve terminal and initial index metadata before their allocations.
        let remaining = reserve(
            parent,
            4096 + 4 * MAX_PAGE_BYTES + encoded_size(&request.binding, 8192).ok()?,
        )
        .ok()?;
        fs::create_dir(&request.output_directory).ok()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&request.output_directory, fs::Permissions::from_mode(0o700))
                .ok()?;
        }
        let binding = request.binding.clone();
        Some(Self {
            page: SemanticPageV1 {
                binding: binding.clone(),
                ordinal: 0,
                definitions: Vec::with_capacity(MAX_PAGE_DEFINITIONS),
                references: Vec::with_capacity(MAX_PAGE_REFERENCES),
                gaps: Vec::with_capacity(16),
            },
            terminal: SemanticTerminalV1 {
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
                gaps: Vec::new(),
            },
            request,
            entries: Vec::new(),
            source_versions: BTreeSet::new(),
            stopped: false,
            max_pages: remaining / MIN_PAGE_BYTES,
        })
    }
    fn new(collector: &Collector) -> Option<Self> {
        let path = PathBuf::from(std::env::var_os("BG_DRIVER_SEMANTIC_REQUEST")?);
        let parent = collector.semantic_parent()?;
        let before = fs::symlink_metadata(&path).ok()?;
        if !before.is_file()
            || before.len() > 32 * 1024
            || path.parent()? != parent
            || !private_file(&before, parent).ok()?
        {
            return None;
        }
        let mut file = File::open(&path).ok()?;
        let mut raw = Vec::new();
        Read::by_ref(&mut file)
            .take(32 * 1024 + 1)
            .read_to_end(&mut raw)
            .ok()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let same = |info: &fs::Metadata| {
                info.dev() == before.dev()
                    && info.ino() == before.ino()
                    && info.len() == before.len()
                    && info.mtime() == before.mtime()
                    && info.mtime_nsec() == before.mtime_nsec()
                    && info.ctime() == before.ctime()
                    && info.ctime_nsec() == before.ctime_nsec()
                    && info.mode() & 0o777 == 0o600
                    && info.nlink() == 1
                    && info.uid() == before.uid()
            };
            if !same(&file.metadata().ok()?)
                || !same(&fs::symlink_metadata(&path).ok()?)
                || raw.len() as u64 != before.len()
            {
                return None;
            }
        }
        let request: SemanticRequest = serde_json::from_slice(&raw).ok()?;
        if request.binding != collector.semantic_binding()
            || request.binding.validate().is_err()
            || request.budget_directory != parent
            || request.output_directory.parent()? != parent
            || fs::canonicalize(parent).ok()? != parent
            || request.output_directory.exists()
        {
            return None;
        }
        // Reserve terminal and initial index metadata before their allocations.
        let remaining = reserve(
            parent,
            4096 + 4 * MAX_PAGE_BYTES + encoded_size(&request.binding, 8192).ok()?,
        )
        .ok()?;
        fs::create_dir(&request.output_directory).ok()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&request.output_directory, fs::Permissions::from_mode(0o700))
                .ok()?;
        }
        let binding = request.binding.clone();
        Some(Self {
            page: SemanticPageV1 {
                binding: binding.clone(),
                ordinal: 0,
                definitions: Vec::with_capacity(MAX_PAGE_DEFINITIONS),
                references: Vec::with_capacity(MAX_PAGE_REFERENCES),
                gaps: Vec::with_capacity(16),
            },
            terminal: SemanticTerminalV1 {
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
                gaps: Vec::new(),
            },
            request,
            entries: Vec::new(),
            source_versions: BTreeSet::new(),
            stopped: false,
            max_pages: remaining / MIN_PAGE_BYTES,
        })
    }
    fn gap(&mut self, gap: SemanticGap) {
        if !self.terminal.gaps.contains(&gap) {
            self.terminal.gaps.push(gap);
        }
        // Each page records gaps observed in the traversal prefix. Keep the
        // prefix across page boundaries, including an omitted candidate.
        if !self.page.gaps.contains(&gap) {
            self.page.gaps.push(gap);
        }
    }
    fn fits(&mut self) -> bool {
        let length = self.page.gaps.len();
        for gap in [
            SemanticGap::UnsupportedDefinition,
            SemanticGap::UnsupportedResolution,
            SemanticGap::ExpandedCoordinates,
            SemanticGap::SourceUnavailable,
            SemanticGap::SourceVersionChanged,
            SemanticGap::ExternalTarget,
            SemanticGap::GeneratedOrderingUnknown,
            SemanticGap::OutputLimit,
            SemanticGap::SourceWorkLimit,
            SemanticGap::TraversalWorkLimit,
            SemanticGap::PublicationInterrupted,
        ] {
            if !self.page.gaps.contains(&gap) {
                self.page.gaps.push(gap);
            }
        }
        let fits = encoded_size(&self.page, MAX_PAGE_BYTES).is_ok();
        self.page.gaps.truncate(length);
        fits
    }
    fn interrupted(&mut self, stop: TraversalStop, gap: SemanticGap) {
        self.stopped = true;
        self.terminal.stop = stop;
        self.gap(gap);
    }
    fn work(&mut self) -> ControlFlow<()> {
        if self.stopped {
            return ControlFlow::Break(());
        }
        if self.terminal.traversal_events == MAX_TRAVERSAL_WORK {
            self.interrupted(TraversalStop::WorkLimit, SemanticGap::TraversalWorkLimit);
            return ControlFlow::Break(());
        }
        self.terminal.traversal_events += 1;
        ControlFlow::Continue(())
    }
    fn location(
        &mut self,
        collector: &mut Collector,
        tcx: TyCtxt<'_>,
        span: Span,
    ) -> Option<SemanticLocation> {
        if span.is_dummy() {
            self.gap(SemanticGap::SourceUnavailable);
            return None;
        }
        let source = tcx.sess.source_map().lookup_char_pos(span.lo()).file;
        if !self.source_versions.contains(&source.start_pos.0) {
            let path_bytes = match &source.name {
                rustc_span::FileName::Real(real) => real
                    .local_path()
                    .map(|p| p.as_os_str().as_encoded_bytes().len()),
                _ => None,
            };
            let Some(path_bytes) = path_bytes.filter(|n| *n <= 4096) else {
                self.gap(SemanticGap::SourceUnavailable);
                return None;
            };
            // Source buffers remain compiler-owned. Charge only finite cache
            // bookkeeping before retaining a source-version association.
            if reserve(&self.request.budget_directory, path_bytes * 3 + 256).is_err() {
                self.interrupted(TraversalStop::OutputLimit, SemanticGap::OutputLimit);
                return None;
            }
            self.source_versions.insert(source.start_pos.0);
        }
        let value = collector.semantic_location(tcx, span);
        if collector.source_work_exhausted() {
            self.interrupted(TraversalStop::SourceWorkLimit, SemanticGap::SourceWorkLimit);
        }
        if collector.source_version_changed() {
            self.gap(SemanticGap::SourceVersionChanged);
        }
        if value.is_none() {
            self.gap(if span.from_expansion() {
                SemanticGap::ExpandedCoordinates
            } else {
                SemanticGap::SourceUnavailable
            });
        }
        if value
            .as_ref()
            .is_some_and(|v| v.input.root == crate::compiler_occurrence::OccurrenceRoot::Target)
        {
            self.gap(SemanticGap::GeneratedOrderingUnknown);
        }
        value
    }
    fn flush(&mut self) -> bool {
        if self.page.definitions.is_empty() && self.page.references.is_empty() {
            return true;
        }
        if self.entries.len() >= self.max_pages {
            self.interrupted(TraversalStop::OutputLimit, SemanticGap::OutputLimit);
            return false;
        }
        if self.page.validate().is_err() {
            self.interrupted(TraversalStop::OutputLimit, SemanticGap::OutputLimit);
            return false;
        }
        let Ok(bytes) = encoded_size(&self.page, MAX_PAGE_BYTES) else {
            return false;
        };
        let entry = SemanticPageEntry {
            ordinal: self.page.ordinal,
            bytes,
            content_fingerprint: String::new(),
        };
        // Include the inventory entry, final embedded-page comma and finite
        // retained entry bookkeeping before allocating the serialized page.
        let entry_bytes = encoded_size(&entry, 1024).unwrap_or(1024) + 128;
        if reserve(&self.request.budget_directory, bytes + entry_bytes + 1).is_err() {
            self.interrupted(TraversalStop::OutputLimit, SemanticGap::OutputLimit);
            return false;
        }
        if self.entries.try_reserve_exact(1).is_err() {
            self.interrupted(TraversalStop::OutputLimit, SemanticGap::OutputLimit);
            return false;
        }
        let mut raw = Vec::new();
        if raw.try_reserve_exact(bytes).is_err()
            || serde_json::to_writer(&mut raw, &self.page).is_err()
        {
            self.interrupted(
                TraversalStop::PublicationInterrupted,
                SemanticGap::PublicationInterrupted,
            );
            return false;
        }
        if exclusive(
            &self
                .request
                .output_directory
                .join(format!("page-{}.json", self.page.ordinal)),
            &raw,
        )
        .is_err()
        {
            self.interrupted(
                TraversalStop::PublicationInterrupted,
                SemanticGap::PublicationInterrupted,
            );
            return false;
        }
        self.entries.push(SemanticPageEntry {
            content_fingerprint: page_fingerprint(&raw),
            ..entry
        });
        self.terminal.emitted_definitions += self.page.definitions.len() as u64;
        self.terminal.emitted_references += self.page.references.len() as u64;
        self.terminal.emitted_pages += 1;
        self.page.definitions.clear();
        self.page.references.clear();
        self.page.ordinal += 1;
        true
    }
    fn definition(&mut self, row: SemanticDefinition) {
        if self.page.definitions.len() == MAX_PAGE_DEFINITIONS && !self.flush() {
            return;
        }
        self.page.definitions.push(row);
        if !self.fits() {
            let row = self.page.definitions.pop();
            if !self.flush() {
                return;
            }
            if let Some(row) = row {
                self.page.definitions.push(row);
            }
            if !self.fits() {
                self.page.definitions.clear();
                self.interrupted(TraversalStop::OutputLimit, SemanticGap::OutputLimit);
            }
        }
    }
    fn reference(&mut self, row: SemanticReference) {
        if self.page.references.len() == MAX_PAGE_REFERENCES && !self.flush() {
            return;
        }
        self.page.references.push(row);
        if !self.fits() {
            let row = self.page.references.pop();
            if !self.flush() {
                return;
            }
            if let Some(row) = row {
                self.page.references.push(row);
            }
            if !self.fits() {
                self.page.references.clear();
                self.interrupted(TraversalStop::OutputLimit, SemanticGap::OutputLimit);
            }
        }
    }
    fn publish(mut self, collector: &Collector) {
        if !self.flush() {
            // Keep committed pages and report exactly the rows omitted from
            // the uncommitted final page. Never count those rows as emitted.
            self.page.definitions.clear();
            self.page.references.clear();
        }
        self.terminal.source_work_bytes = collector.source_work_bytes();
        self.terminal.omitted = self.terminal.visited_definitions
            + self.terminal.visited_references
            - self.terminal.emitted_definitions
            - self.terminal.emitted_references;
        let index = SemanticIndexV1 {
            binding: self.request.binding.clone(),
            pages: self.entries,
            terminal: self.terminal,
        };
        let Ok(size) = encoded_size(&index, MAX_STREAM_BYTES) else {
            return;
        };
        // Fixed terminal/binding and each actual inventory entry were charged
        // before retention. Their final serialization does not reset a budget.
        let mut raw = Vec::new();
        if raw.try_reserve_exact(size).is_ok() && serde_json::to_writer(&mut raw, &index).is_ok() {
            let _ = exclusive(&self.request.output_directory.join("index.json"), &raw);
        }
    }
}

struct Walk<'a, 'tcx> {
    tcx: TyCtxt<'tcx>,
    collector: &'a mut Collector,
    writer: &'a mut Writer,
    typeck: Option<&'tcx TypeckResults<'tcx>>,
}

// Traverse actual compiler DefKeys with a fixed stack and bounded output.
// Avoid allocating a potentially unbounded def_path_str before checking size.
fn compiler_path(tcx: TyCtxt<'_>, writer: &mut Writer, mut did: DefId) -> Option<String> {
    use rustc_hir::definitions::{DefPathData, DefPathDataName};
    use std::fmt::Write;
    let crate_name = tcx.crate_name(did.krate);
    let mut parts = [None; 64];
    let mut count = 0;
    let mut size = crate_name.as_str().len();
    loop {
        if writer.work().is_break() {
            return None;
        }
        let key = tcx.def_key(did);
        let Some(parent) = key.parent else { break };
        if count == parts.len() {
            return None;
        }
        let symbol = match key.disambiguated_data.data.name() {
            DefPathDataName::Named(name) => name,
            DefPathDataName::Anon { namespace } => namespace,
        };
        size = size.checked_add(symbol.as_str().len() + 16)?;
        if let DefPathData::AnonAssocTy(name) = key.disambiguated_data.data {
            size = size.checked_add(name.as_str().len() + 2)?;
        }
        if size > 1024 {
            return None;
        }
        parts[count] = Some(key.disambiguated_data);
        count += 1;
        did.index = parent;
    }
    if size > 1024 {
        return None;
    }
    let mut output = String::with_capacity(size);
    output.push_str(crate_name.as_str());
    for part in parts[..count].iter().rev().flatten() {
        output.push_str("::");
        match part.data.name() {
            DefPathDataName::Named(name) => {
                output.push_str(name.as_str());
                if part.disambiguator != 0 {
                    write!(&mut output, "#{}", part.disambiguator).ok()?;
                }
            }
            DefPathDataName::Anon { namespace } => {
                if let DefPathData::AnonAssocTy(name) = part.data {
                    output.push_str(name.as_str());
                    output.push_str("::");
                }
                write!(&mut output, "{{{}#{}}}", namespace, part.disambiguator).ok()?;
            }
        }
    }
    (!output.contains(['/', '\\', '\0', '\n', '\r']) && output.len() <= 1024).then_some(output)
}

impl<'tcx> Walk<'_, 'tcx> {
    fn typeck_for(&self, id: HirId) -> Option<&'tcx TypeckResults<'tcx>> {
        self.typeck.filter(|results| {
            results.hir_owner == id.owner
                && matches!(
                    self.tcx.hir_node(id),
                    rustc_hir::Node::Expr(_)
                        | rustc_hir::Node::Pat(_)
                        | rustc_hir::Node::ExprField(_)
                        | rustc_hir::Node::PatField(_)
                )
        })
    }
    fn without_typeck(
        &mut self,
        walk: impl FnOnce(&mut Self) -> ControlFlow<()>,
    ) -> ControlFlow<()> {
        // Item signatures are outside the enclosing body's table. Their own
        // bodies install their original table through visit_body, then restore.
        let old = self.typeck.take();
        let result = walk(self);
        self.typeck = old;
        result
    }
    fn target(&mut self, res: Res) -> Option<SemanticTarget> {
        match res {
            Res::Def(_, did) => {
                if did.krate != LOCAL_CRATE {
                    self.writer.gap(SemanticGap::ExternalTarget);
                }
                let path = compiler_path(self.tcx, self.writer, did)?;
                Some(SemanticTarget::Definition {
                    crate_name: self.tcx.crate_name(did.krate).to_string(),
                    definition_index: did.index.as_u32(),
                    compiler_path: path,
                })
            }
            Res::Local(id) => Some(SemanticTarget::LocalBinding {
                owner_index: id.owner.def_id.local_def_index.as_u32(),
                local_index: id.local_id.as_u32(),
            }),
            Res::PrimTy(ty) => Some(SemanticTarget::Builtin {
                name: format!("{ty:?}"),
            }),
            _ => {
                self.writer.gap(SemanticGap::UnsupportedResolution);
                None
            }
        }
    }
    fn reference(&mut self, res: Res, id: HirId, span: Span, role: &str) {
        self.reference_with_gap(res, id, span, role, false);
    }
    fn reference_with_gap(
        &mut self,
        res: Res,
        id: HirId,
        span: Span,
        role: &str,
        unsupported: bool,
    ) {
        self.writer.terminal.visited_references += 1;
        let Some(target) = self.target(res) else {
            self.writer.terminal.unsupported += 1;
            self.writer.gap(SemanticGap::UnsupportedResolution);
            return;
        };
        let location = self.writer.location(self.collector, self.tcx, span);
        if unsupported || location.is_none() {
            self.writer.terminal.unsupported += 1;
        }
        let ordinal =
            self.writer.terminal.emitted_references + self.writer.page.references.len() as u64;
        self.writer.reference(SemanticReference {
            ordinal,
            owner_index: id.owner.def_id.local_def_index.as_u32(),
            hir_local_index: id.local_id.as_u32(),
            role: role.into(),
            target,
            location,
        });
    }
    fn unsupported_reference(&mut self) {
        self.writer.terminal.visited_references += 1;
        self.writer.terminal.unsupported += 1;
        self.writer.gap(SemanticGap::UnsupportedResolution);
    }
}

impl<'tcx> Visitor<'tcx> for Walk<'_, 'tcx> {
    type NestedFilter = nested_filter::All;
    type Result = ControlFlow<()>;
    fn maybe_tcx(&mut self) -> Self::MaybeTyCtxt {
        self.tcx
    }
    fn visit_id(&mut self, _: HirId) -> Self::Result {
        self.writer.work()
    }
    fn visit_item(&mut self, item: &'tcx rustc_hir::Item<'tcx>) -> Self::Result {
        self.without_typeck(|walk| intravisit::walk_item(walk, item))
    }
    fn visit_trait_item(&mut self, item: &'tcx rustc_hir::TraitItem<'tcx>) -> Self::Result {
        self.without_typeck(|walk| intravisit::walk_trait_item(walk, item))
    }
    fn visit_impl_item(&mut self, item: &'tcx rustc_hir::ImplItem<'tcx>) -> Self::Result {
        self.without_typeck(|walk| intravisit::walk_impl_item(walk, item))
    }
    fn visit_foreign_item(&mut self, item: &'tcx rustc_hir::ForeignItem<'tcx>) -> Self::Result {
        self.without_typeck(|walk| intravisit::walk_foreign_item(walk, item))
    }
    fn visit_body(&mut self, body: &Body<'tcx>) -> Self::Result {
        let old = self.typeck;
        let owner = body.value.hir_id.owner.def_id;
        self.typeck = self.tcx.has_typeck_results(owner).then(|| {
            self.tcx.typeck(
                self.tcx
                    .typeck_root_def_id(owner.to_def_id())
                    .expect_local(),
            )
        });
        let result = intravisit::walk_body(self, body);
        self.typeck = old;
        result
    }
    fn visit_path(&mut self, path: &HirPath<'tcx>, id: HirId) -> Self::Result {
        self.writer.work()?;
        self.reference(path.res, id, path.span, "path");
        intravisit::walk_path(self, path)
    }
    fn visit_qpath(&mut self, path: &'tcx QPath<'tcx>, id: HirId, span: Span) -> Self::Result {
        if !matches!(path, QPath::Resolved(..)) {
            self.writer.work()?;
            if let Some(typeck) = self.typeck_for(id) {
                self.reference(typeck.qpath_res(path, id), id, span, "path");
            } else {
                self.unsupported_reference();
            }
        }
        intravisit::walk_qpath(self, path, id)
    }
    fn visit_path_segment(&mut self, segment: &'tcx PathSegment<'tcx>) -> Self::Result {
        self.writer.work()?;
        self.reference(segment.res, segment.hir_id, segment.ident.span, "segment");
        intravisit::walk_path_segment(self, segment)
    }
    fn visit_lifetime(&mut self, lifetime: &'tcx Lifetime) -> Self::Result {
        self.writer.work()?;
        match lifetime.kind {
            LifetimeKind::Param(did) => self.reference(
                Res::Def(self.tcx.def_kind(did), did.to_def_id()),
                lifetime.hir_id,
                lifetime.ident.span,
                "lifetime",
            ),
            LifetimeKind::Static => {
                self.writer.terminal.visited_references += 1;
                let location = self
                    .writer
                    .location(self.collector, self.tcx, lifetime.ident.span);
                if location.is_none() {
                    self.writer.terminal.unsupported += 1;
                }
                self.writer.reference(SemanticReference {
                    ordinal: self.writer.terminal.emitted_references
                        + self.writer.page.references.len() as u64,
                    owner_index: lifetime.hir_id.owner.def_id.local_def_index.as_u32(),
                    hir_local_index: lifetime.hir_id.local_id.as_u32(),
                    role: "lifetime".into(),
                    target: SemanticTarget::Builtin {
                        name: "static_lifetime".into(),
                    },
                    location,
                });
            }
            _ => self.unsupported_reference(),
        }
        intravisit::walk_lifetime(self, lifetime)
    }
    fn visit_pat(&mut self, pattern: &'tcx Pat<'tcx>) -> Self::Result {
        self.writer.work()?;
        if let PatKind::Binding(_, id, ident, _) = pattern.kind {
            self.writer.terminal.visited_definitions += 1;
            let name = ident.name.as_str();
            if name.len() > 1024 || name.contains(['/', '\\', '\0', '\n', '\r']) {
                self.writer.terminal.unsupported += 1;
                self.writer.gap(SemanticGap::UnsupportedDefinition);
            } else {
                let location = self.writer.location(self.collector, self.tcx, ident.span);
                if location.is_none() {
                    self.writer.terminal.unsupported += 1;
                }
                self.writer.definition(SemanticDefinition {
                    ordinal: self.writer.terminal.emitted_definitions
                        + self.writer.page.definitions.len() as u64,
                    local_index: id.local_id.as_u32(),
                    binding_owner: Some(id.owner.def_id.local_def_index.as_u32()),
                    compiler_path: name.to_string(),
                    kind: "LocalBinding".into(),
                    location,
                });
            }
        }
        if let PatKind::Struct(ref path, fields, _) = pattern.kind {
            if let Some(typeck) = self.typeck_for(pattern.hir_id) {
                let res = typeck.qpath_res(path, pattern.hir_id);
                if let ty::Adt(adt, _) = typeck.pat_ty(pattern).kind() {
                    for field in fields {
                        self.writer.work()?;
                        let Some(typeck) = self.typeck_for(field.hir_id) else {
                            self.unsupported_reference();
                            continue;
                        };
                        if let Some(definition) = adt
                            .variant_of_res(res)
                            .fields
                            .get(typeck.field_index(field.hir_id))
                        {
                            self.reference(
                                Res::Def(self.tcx.def_kind(definition.did), definition.did),
                                field.hir_id,
                                field.ident.span,
                                "field",
                            );
                        } else {
                            self.unsupported_reference();
                        }
                    }
                } else {
                    for _ in fields {
                        self.writer.work()?;
                        self.unsupported_reference();
                    }
                }
            } else {
                for _ in fields {
                    self.writer.work()?;
                    self.unsupported_reference();
                }
            }
        }
        intravisit::walk_pat(self, pattern)
    }
    fn visit_assoc_item_constraint(
        &mut self,
        constraint: &'tcx rustc_hir::AssocItemConstraint<'tcx>,
    ) -> Self::Result {
        self.writer.work()?;
        // HIR's associated constraint identifier has no resolved DefId here.
        // Visit its full RHS/generic domain and record the missing resolution.
        self.unsupported_reference();
        intravisit::walk_assoc_item_constraint(self, constraint)
    }
    fn visit_attribute(&mut self, _: &'tcx rustc_hir::Attribute) -> Self::Result {
        self.writer.work()?;
        self.unsupported_reference();
        ControlFlow::Continue(())
    }
    fn visit_inline_asm(
        &mut self,
        asm: &'tcx rustc_hir::InlineAsm<'tcx>,
        id: HirId,
    ) -> Self::Result {
        self.writer.work()?;
        self.unsupported_reference();
        intravisit::walk_inline_asm(self, asm, id)
    }
    fn visit_expr(&mut self, expression: &'tcx Expr<'tcx>) -> Self::Result {
        self.writer.work()?;
        if let Some(typeck) = self.typeck_for(expression.hir_id) {
            match expression.kind {
                ExprKind::Call(callee, _) => {
                    if let ExprKind::Path(ref path) = callee.kind {
                        let Some(typeck) = self.typeck_for(callee.hir_id) else {
                            self.unsupported_reference();
                            return intravisit::walk_expr(self, expression);
                        };
                        let indirect =
                            !matches!(typeck.expr_ty_adjusted(callee).kind(), ty::FnDef(..));
                        if indirect {
                            self.writer.gap(SemanticGap::UnsupportedResolution);
                        }
                        self.reference_with_gap(
                            typeck.qpath_res(path, callee.hir_id),
                            expression.hir_id,
                            expression.span,
                            "call",
                            indirect,
                        );
                    } else {
                        self.unsupported_reference();
                    }
                }
                ExprKind::MethodCall(..) => {
                    if let Some(did) = typeck.type_dependent_def_id(expression.hir_id) {
                        let env = ty::TypingEnv::post_analysis(
                            self.tcx,
                            expression.hir_id.owner.def_id.to_def_id(),
                        );
                        let (resolved, unresolved) = match ty::Instance::try_resolve(
                            self.tcx,
                            env,
                            did,
                            typeck.node_args(expression.hir_id),
                        ) {
                            Ok(Some(instance)) => (instance.def_id(), false),
                            _ => {
                                self.writer.gap(SemanticGap::UnsupportedResolution);
                                (did, true)
                            }
                        };
                        self.reference_with_gap(
                            Res::Def(self.tcx.def_kind(resolved), resolved),
                            expression.hir_id,
                            expression.span,
                            "method",
                            unresolved,
                        );
                    } else {
                        self.unsupported_reference();
                    }
                }
                ExprKind::Field(receiver, _) => {
                    let Some(receiver_typeck) = self.typeck_for(receiver.hir_id) else {
                        self.unsupported_reference();
                        return intravisit::walk_expr(self, expression);
                    };
                    if let ty::Adt(adt, _) = receiver_typeck.expr_ty_adjusted(receiver).kind() {
                        if adt.is_struct() || adt.is_union() {
                            if let Some(field) = adt
                                .non_enum_variant()
                                .fields
                                .get(typeck.field_index(expression.hir_id))
                            {
                                self.reference(
                                    Res::Def(self.tcx.def_kind(field.did), field.did),
                                    expression.hir_id,
                                    expression.span,
                                    "field",
                                );
                            } else {
                                self.unsupported_reference();
                            }
                        } else {
                            self.unsupported_reference();
                        }
                    } else {
                        self.unsupported_reference();
                    }
                }
                ExprKind::Index(..)
                | ExprKind::Unary(..)
                | ExprKind::Binary(..)
                | ExprKind::AssignOp(..) => {
                    if let Some(did) = typeck.type_dependent_def_id(expression.hir_id) {
                        self.reference(
                            Res::Def(self.tcx.def_kind(did), did),
                            expression.hir_id,
                            expression.span,
                            "operator",
                        );
                    } else {
                        self.writer.terminal.visited_references += 1;
                        let location =
                            self.writer
                                .location(self.collector, self.tcx, expression.span);
                        if location.is_none() {
                            self.writer.terminal.unsupported += 1;
                        }
                        self.writer.reference(SemanticReference {
                            ordinal: self.writer.terminal.emitted_references
                                + self.writer.page.references.len() as u64,
                            owner_index: expression.hir_id.owner.def_id.local_def_index.as_u32(),
                            hir_local_index: expression.hir_id.local_id.as_u32(),
                            role: "operator".into(),
                            target: SemanticTarget::Builtin {
                                name: match expression.kind {
                                    ExprKind::Index(..) => "Index".into(),
                                    ExprKind::Unary(op, _) => format!("Unary{op:?}"),
                                    ExprKind::Binary(op, ..) => format!("Binary{:?}", op.node),
                                    ExprKind::AssignOp(op, ..) => format!("Assign{:?}", op.node),
                                    _ => unreachable!("operator match"),
                                },
                            },
                            location,
                        });
                    }
                }
                ExprKind::Struct(path, fields, _) => {
                    let res = typeck.qpath_res(path, expression.hir_id);
                    if let ty::Adt(adt, _) = typeck.expr_ty(expression).kind() {
                        for field in fields {
                            self.writer.work()?;
                            let Some(typeck) = self.typeck_for(field.hir_id) else {
                                self.unsupported_reference();
                                continue;
                            };
                            if let Some(definition) = adt
                                .variant_of_res(res)
                                .fields
                                .get(typeck.field_index(field.hir_id))
                            {
                                self.reference(
                                    Res::Def(self.tcx.def_kind(definition.did), definition.did),
                                    field.hir_id,
                                    field.ident.span,
                                    "field",
                                );
                            } else {
                                self.unsupported_reference();
                            }
                        }
                    } else {
                        for _ in fields {
                            self.writer.work()?;
                            self.unsupported_reference();
                        }
                    }
                }
                _ => {}
            }
        } else {
            match expression.kind {
                ExprKind::Struct(_, fields, _) => {
                    for _ in fields {
                        self.writer.work()?;
                        self.unsupported_reference();
                    }
                }
                ExprKind::Call(..)
                | ExprKind::MethodCall(..)
                | ExprKind::Field(..)
                | ExprKind::Index(..)
                | ExprKind::Unary(..)
                | ExprKind::Binary(..)
                | ExprKind::AssignOp(..) => self.unsupported_reference(),
                _ => {}
            }
        }
        intravisit::walk_expr(self, expression)
    }
}

pub fn observe(
    tcx: TyCtxt<'_>,
    collector: &mut Collector,
    #[cfg(target_os = "linux")] controls: &crate::held_callback_control::InheritedControls,
) {
    #[cfg(target_os = "linux")]
    let writer = Writer::new_with_controls(collector, controls);
    #[cfg(not(target_os = "linux"))]
    let writer = Writer::new(collector);
    let Some(mut writer) = writer else {
        return;
    };
    // The analysis query's entire local definition domain includes structural,
    // anonymous, impl, generic, variant and foreign definitions, not only fns.
    for did in tcx.iter_local_def_id() {
        if writer.work().is_break() {
            break;
        }
        writer.terminal.visited_definitions += 1;
        let Some(path) = compiler_path(tcx, &mut writer, did.to_def_id()) else {
            writer.terminal.unsupported += 1;
            writer.gap(SemanticGap::UnsupportedDefinition);
            continue;
        };
        let location = writer.location(collector, tcx, tcx.def_span(did));
        if location.is_none() {
            writer.terminal.unsupported += 1;
        }
        let row = SemanticDefinition {
            ordinal: writer.terminal.emitted_definitions + writer.page.definitions.len() as u64,
            local_index: did.local_def_index.as_u32(),
            binding_owner: None,
            compiler_path: path,
            kind: format!("{:?}", tcx.def_kind(did)),
            location,
        };
        writer.definition(row);
    }
    if !writer.stopped {
        let mut walk = Walk {
            tcx,
            collector,
            writer: &mut writer,
            typeck: None,
        };
        let result = tcx.hir_walk_toplevel_module(&mut walk);
        let result = if result.is_continue() {
            tcx.hir_walk_attributes(&mut walk)
        } else {
            result
        };
        if result.is_break() && !writer.stopped {
            writer.interrupted(TraversalStop::WorkLimit, SemanticGap::TraversalWorkLimit);
        }
    }
    writer.publish(collector);
}
