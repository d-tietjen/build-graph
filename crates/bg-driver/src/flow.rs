//! Persist one pre-optimization MIR control-flow graph per local body.
//! A call's normal edge is its return continuation, never an edge to its callee.

use rustc_hir::def::DefKind;
use rustc_middle::mir::{
    self, Body, CastKind, Rvalue, StatementKind, TerminatorKind, UnwindAction,
};
use rustc_middle::middle::codegen_fn_attrs::CodegenFnAttrFlags;
use rustc_middle::traits::ImplSource;
use rustc_middle::ty::{self, TyCtxt, TypeVisitableExt};
use rustc_session::config::CrateType;
use rustc_span::{
    def_id::{DefId, LocalDefId, LOCAL_CRATE},
    RemapPathScopeComponents,
    source_map::Spanned,
    Span,
};
use serde::Serialize;
use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};

#[derive(Serialize)]
struct Unit {
    version: u32,
    krate: String,
    unit_key: String,
    manifest_dir: Option<String>,
    package_name: Option<String>,
    package_version: Option<String>,
    out_dir: Option<String>,
    crate_root: Option<String>,
    crate_types: Vec<String>,
    build_context: serde_json::Value,
    flows: Vec<FlowRecord>,
}

#[derive(Serialize)]
struct FlowRecord {
    function: String,
    function_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    compiler_entry: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    definition_source: Option<serde_json::Value>,
    owner_kind: String,
    source_file: Option<String>,
    source_location: Option<u32>,
    source_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    link_symbol: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    impl_self: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    impl_trait: Option<String>,
    flow: Flow,
}

#[derive(Serialize)]
struct Flow {
    version: u32,
    function: String,
    function_id: String,
    entry: String,
    blocks: Vec<Block>,
    #[serde(skip_serializing_if = "Option::is_none")]
    value_facts: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    guard_facts: Option<serde_json::Value>,
}

#[derive(Serialize)]
struct Block {
    id: String,
    kind: &'static str,
    label: String,
    source_file: Option<String>,
    source_location: Option<u32>,
    callee: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    callee_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    callee_artifact: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    callee_crate: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    callee_abi: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    native_call: Option<NativeCall>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    callee_targets: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    callback_parameter: Option<usize>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    callback_args: Vec<CallbackArg>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    callback_references: Vec<TraitCallbackReference>,
    #[serde(skip_serializing_if = "is_false")]
    callback_unknown: bool,
    successors: Vec<Successor>,
}

#[derive(Serialize)]
struct NativeCall {
    symbol: String,
    abi: String,
    libraries: Vec<String>,
    declaration_local: bool,
}

#[derive(Serialize)]
struct CallbackArg {
    index: usize,
    targets: Vec<String>,
    parameter: Option<usize>,
    #[serde(skip_serializing_if = "is_false")]
    unknown: bool,
}

// A trait bound on a passed value identifies methods that the external callee
// may use. This is a reference/registration, not an observed method invocation.
#[derive(Serialize)]
struct TraitCallbackReference {
    kind: &'static str,
    index: usize,
    receiver_type: String,
    trait_id: String,
    r#trait: String,
    targets: Vec<TraitCallbackTarget>,
}

#[derive(Serialize)]
struct TraitCallbackTarget {
    function: String,
    function_id: String,
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Serialize)]
struct Successor {
    target: Option<String>,
    label: String,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    action: Option<&'static str>,
}

fn edge(target: mir::BasicBlock, label: impl Into<String>) -> Successor {
    Successor {
        target: Some(format!("{target:?}")),
        label: label.into(),
        kind: "normal",
        action: None,
    }
}

fn unwind_edge(action: &UnwindAction) -> Successor {
    let (target, label, continuation) = match action {
        UnwindAction::Cleanup(bb) => (Some(format!("{bb:?}")), "cleanup", None),
        UnwindAction::Continue => (None, "continue unwinding", Some("continue")),
        UnwindAction::Terminate(_) => (None, "terminate on unwind", Some("terminate")),
        UnwindAction::Unreachable => (None, "unwind unreachable", Some("unreachable")),
    };
    Successor {
        target,
        label: label.into(),
        kind: "unwind",
        action: continuation,
    }
}

fn location(tcx: TyCtxt<'_>, span: Span) -> (Option<String>, Option<u32>) {
    if span.is_dummy() {
        return (None, None);
    }
    let sm = tcx.sess.source_map();
    let pos = sm.lookup_char_pos(span.lo());
    (
        Some(sm.filename_for_diagnostics(&pos.file.name).to_string()),
        u32::try_from(pos.line).ok(),
    )
}

fn snippet(tcx: TyCtxt<'_>, span: Span) -> Option<String> {
    if span.is_dummy() {
        return None;
    }
    let raw = tcx.sess.source_map().span_to_snippet(span).ok()?;
    let text = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    (!text.is_empty() && text.chars().count() <= 160).then_some(text)
}

fn flow_key(tcx: TyCtxt<'_>, def_id: DefId) -> String {
    let path = tcx.def_path_str(def_id);
    if !def_id.is_local() {
        return path;
    }
    let krate = tcx.crate_name(LOCAL_CRATE).to_string();
    let qualified = format!("{krate}::{path}");
    if tcx.crate_types().contains(&CrateType::Executable) {
        format!("bin::{qualified}")
    } else {
        qualified
    }
}

fn flow_id(tcx: TyCtxt<'_>, def_id: DefId) -> String {
    format!("{:?}", tcx.def_path_hash(def_id))
}

fn canonical_def_path(tcx: TyCtxt<'_>, def_id: DefId) -> Option<String> {
    let path = tcx.def_path(def_id);
    let names = path
        .data
        .iter()
        .map(|part| part.data.get_opt_name().map(|name| name.to_string()))
        .collect::<Option<Vec<_>>>()?;
    Some(
        std::iter::once(tcx.crate_name(path.krate).to_string())
            .chain(names)
            .collect::<Vec<_>>()
            .join("::"),
    )
}

fn canonical_region_name<'tcx>(tcx: TyCtxt<'tcx>, region: ty::Region<'tcx>) -> Option<String> {
    match region.kind() {
        // An elided impl lifetime is an early parameter named `'_`; rustdoc
        // records that same placeholder in path arguments.
        ty::ReEarlyParam(data) => Some(data.name.to_string()),
        ty::ReLateParam(_) | ty::ReBound(..) | ty::ReStatic => {
            Some(region.get_name(tcx)?.to_string())
        }
        _ => None,
    }
}

fn canonical_type_name<'tcx>(tcx: TyCtxt<'tcx>, value: ty::Ty<'tcx>) -> Option<String> {
    if value.has_non_region_infer() || value.has_aliases() {
        return None;
    }
    match value.kind() {
        ty::Adt(def, args) => Some(format!(
            "{}{}",
            canonical_def_path(tcx, def.did())?,
            canonical_generic_args(tcx, args.iter())?
        )),
        ty::Foreign(def_id) => canonical_def_path(tcx, *def_id),
        ty::Param(param) => Some(param.name.to_string()),
        ty::Ref(region, inner, mutability) => Some(format!(
            "&{} {}{}",
            canonical_region_name(tcx, *region)?,
            if mutability.is_mut() { "mut " } else { "" },
            canonical_type_name(tcx, *inner)?
        )),
        ty::RawPtr(inner, mutability) => Some(format!(
            "*{} {}",
            if mutability.is_mut() { "mut" } else { "const" },
            canonical_type_name(tcx, *inner)?
        )),
        ty::Slice(inner) => Some(format!("[{}]", canonical_type_name(tcx, *inner)?)),
        ty::Tuple(types) => Some(format!(
            "({})",
            types
                .iter()
                .map(|ty| canonical_type_name(tcx, ty))
                .collect::<Option<Vec<_>>>()?
                .join(", ")
        )),
        ty::Bool | ty::Char | ty::Str | ty::Int(_) | ty::Uint(_) | ty::Float(_) | ty::Never => {
            Some(value.to_string())
        }
        _ => None,
    }
}

fn canonical_generic_args<'tcx>(
    tcx: TyCtxt<'tcx>,
    args: impl Iterator<Item = ty::GenericArg<'tcx>>,
) -> Option<String> {
    let mut rendered = Vec::new();
    for arg in args {
        match arg.kind() {
            ty::GenericArgKind::Type(ty) => rendered.push(canonical_type_name(tcx, ty)?),
            ty::GenericArgKind::Const(value) => match value.kind() {
                ty::ConstKind::Param(param) => rendered.push(format!("const {}", param.name)),
                _ => return None,
            },
            ty::GenericArgKind::Lifetime(region) => {
                rendered.push(canonical_region_name(tcx, region)?);
            }
            // Lifetime names in rustdoc are source spellings. With no stable
            // cross-artifact lifetime identity, leave these impls unresolved.
            _ => return None,
        }
    }
    if rendered.is_empty() {
        Some(String::new())
    } else {
        Some(format!("<{}>", rendered.join(", ")))
    }
}

fn canonical_impl_identity(tcx: TyCtxt<'_>, def_id: DefId) -> Option<(String, String)> {
    let impl_id = tcx.trait_impl_of_assoc(def_id)?;
    let trait_ref = tcx.impl_trait_ref(impl_id).instantiate_identity();
    let self_type = canonical_type_name(tcx, trait_ref.self_ty())?;
    // Rustdoc omits trailing defaulted trait arguments (for example Rhs=Self)
    // while rustc's resolved trait ref contains them. Remove only defaults
    // proven equal to the instantiated value of that declared parameter.
    let generics = tcx.generics_of(trait_ref.def_id);
    let mut visible = trait_ref.args.len();
    while visible > 1 {
        let param = generics.param_at(visible - 1, tcx);
        let Some(default) = param.default_value(tcx) else {
            break;
        };
        if default.instantiate(tcx, trait_ref.args) != trait_ref.args[visible - 1] {
            break;
        }
        visible -= 1;
    }
    let trait_name = format!(
        "{}{}",
        canonical_def_path(tcx, trait_ref.def_id)?,
        canonical_generic_args(tcx, trait_ref.args.iter().take(visible).skip(1))?
    );
    Some((self_type, trait_name))
}

// Only locals and transparent references/casts carry callback provenance.
// A missing value means unknown, never an empty set of possible callees.
#[derive(Clone, PartialEq, Eq)]
struct Provenance {
    targets: BTreeSet<String>,
    parameters: BTreeSet<usize>,
    unknown: bool,
}

impl Provenance {
    fn unknown() -> Self {
        Self {
            targets: BTreeSet::new(),
            parameters: BTreeSet::new(),
            unknown: true,
        }
    }

    fn target(key: String) -> Self {
        Self {
            targets: BTreeSet::from([key]),
            parameters: BTreeSet::new(),
            unknown: false,
        }
    }

    fn parameter(index: usize) -> Self {
        Self {
            targets: BTreeSet::new(),
            parameters: BTreeSet::from([index]),
            unknown: false,
        }
    }

    fn merge(&mut self, other: &Self) {
        self.targets.extend(other.targets.iter().cloned());
        self.parameters.extend(other.parameters.iter().copied());
        self.unknown |= other.unknown;
        if self.targets.len() > 16 || self.parameters.len() > 4 {
            self.targets.clear();
            self.parameters.clear();
            self.unknown = true;
        }
    }

    fn unknown_only(&self) -> bool {
        self.unknown && self.targets.is_empty() && self.parameters.is_empty()
    }

    fn single_parameter(&self) -> Option<usize> {
        (self.parameters.len() == 1)
            .then(|| self.parameters.iter().next().copied())
            .flatten()
    }

    fn unresolved(&self) -> bool {
        self.unknown || self.parameters.len() > 1
    }
}

type State = HashMap<mir::Local, Provenance>;

fn callback_type(ty: ty::Ty<'_>) -> bool {
    match ty.kind() {
        ty::FnDef(..) | ty::FnPtr(..) | ty::Closure(..) | ty::Param(..) => true,
        ty::Ref(_, inner, _) => callback_type(*inner),
        _ => false,
    }
}

fn place_provenance(place: mir::Place<'_>, state: &State) -> Provenance {
    if place
        .projection
        .iter()
        .all(|elem| matches!(elem, mir::ProjectionElem::Deref))
    {
        state
            .get(&place.local)
            .cloned()
            .unwrap_or_else(Provenance::unknown)
    } else {
        Provenance::unknown()
    }
}

fn operand_provenance<'tcx>(
    tcx: TyCtxt<'tcx>,
    body: &Body<'tcx>,
    state: &State,
    operand: &mir::Operand<'tcx>,
) -> Provenance {
    match *operand.ty(&body.local_decls, tcx).kind() {
        ty::FnDef(def_id, _) | ty::Closure(def_id, _) => Provenance::target(flow_key(tcx, def_id)),
        _ => match operand {
            mir::Operand::Copy(place) | mir::Operand::Move(place) => {
                place_provenance(*place, state)
            }
            _ => Provenance::unknown(),
        },
    }
}

fn rvalue_provenance<'tcx>(
    tcx: TyCtxt<'tcx>,
    body: &Body<'tcx>,
    state: &State,
    value: &Rvalue<'tcx>,
) -> Provenance {
    match value {
        Rvalue::Use(operand) | Rvalue::WrapUnsafeBinder(operand, _) => {
            operand_provenance(tcx, body, state, operand)
        }
        Rvalue::Ref(_, _, place) | Rvalue::CopyForDeref(place) => place_provenance(*place, state),
        Rvalue::Cast(CastKind::PointerCoercion(..) | CastKind::Subtype, operand, _) => {
            operand_provenance(tcx, body, state, operand)
        }
        Rvalue::Aggregate(kind, _) => match kind.as_ref() {
            mir::AggregateKind::Closure(def_id, _) => Provenance::target(flow_key(tcx, *def_id)),
            _ => Provenance::unknown(),
        },
        _ => Provenance::unknown(),
    }
}

fn assign(state: &mut State, place: mir::Place<'_>, value: Provenance) {
    if place.projection.is_empty() && !value.unknown_only() {
        state.insert(place.local, value);
    } else if place.projection.is_empty() {
        state.remove(&place.local);
    } else {
        // Without a points-to map, a projected write may update any tracked
        // callback through an alias.
        state.clear();
    }
}

fn fn_trait_invocation<'tcx>(
    tcx: TyCtxt<'tcx>,
    body: &Body<'tcx>,
    func: &mir::Operand<'tcx>,
) -> bool {
    let ty::FnDef(def_id, _) = *func.ty(&body.local_decls, tcx).kind() else {
        return false;
    };
    matches!(tcx.def_kind(def_id), DefKind::AssocFn) && tcx.is_fn_trait(tcx.parent(def_id))
}

fn merge_state(existing: &mut State, incoming: &State) -> bool {
    let keys: HashSet<_> = existing.keys().chain(incoming.keys()).copied().collect();
    let mut changed = false;
    for key in keys {
        let old = existing
            .get(&key)
            .cloned()
            .unwrap_or_else(Provenance::unknown);
        let mut joined = old.clone();
        joined.merge(
            &incoming
                .get(&key)
                .cloned()
                .unwrap_or_else(Provenance::unknown),
        );
        if joined != old {
            changed = true;
            if joined.unknown_only() {
                existing.remove(&key);
            } else {
                existing.insert(key, joined);
            }
        }
    }
    changed
}

fn block_states<'tcx>(
    tcx: TyCtxt<'tcx>,
    body: &Body<'tcx>,
) -> Option<HashMap<mir::BasicBlock, State>> {
    let mut start = State::new();
    for (index, local) in body.args_iter().enumerate() {
        if callback_type(body.local_decls[local].ty) {
            start.insert(local, Provenance::parameter(index));
        }
    }
    let mut incoming = HashMap::from([(mir::START_BLOCK, start)]);
    let mut at_terminator = HashMap::new();
    let mut queue = VecDeque::from([mir::START_BLOCK]);
    let mut queued = HashSet::from([mir::START_BLOCK]);
    let budget = body
        .basic_blocks
        .len()
        .saturating_mul(body.local_decls.len())
        .saturating_mul(16)
        .clamp(256, 100_000);
    let mut steps = 0;
    while let Some(bb) = queue.pop_front() {
        queued.remove(&bb);
        steps += 1;
        if steps > budget {
            return None;
        }
        let mut state = incoming[&bb].clone();
        let data = &body.basic_blocks[bb];
        for statement in &data.statements {
            match &statement.kind {
                StatementKind::Assign(boxed) => {
                    let (place, value) = &**boxed;
                    let provenance = rvalue_provenance(tcx, body, &state, value);
                    assign(&mut state, *place, provenance);
                }
                StatementKind::StorageLive(local) | StatementKind::StorageDead(local) => {
                    state.remove(local);
                }
                _ => {}
            }
        }
        at_terminator.insert(bb, state.clone());
        let Some(term) = &data.terminator else {
            continue;
        };
        if let TerminatorKind::Call {
            func,
            args,
            destination,
            ..
        } = &term.kind
        {
            if !fn_trait_invocation(tcx, body, func)
                && args.iter().any(|arg| {
                    matches!(
                        *arg.node.ty(&body.local_decls, tcx).kind(),
                        ty::Ref(_, inner, rustc_hir::Mutability::Mut) if callback_type(inner)
                    )
                })
            {
                // The callee may replace a callback through `&mut`; retaining
                // any local origin without a points-to map would claim a
                // target that no longer has to be present.
                state.clear();
            }
            assign(&mut state, *destination, Provenance::unknown());
        }
        for successor in term.successors() {
            let changed = if let Some(old) = incoming.get_mut(&successor) {
                merge_state(old, &state)
            } else {
                incoming.insert(successor, state.clone());
                true
            };
            if changed && queued.insert(successor) {
                queue.push_back(successor);
            }
        }
    }
    Some(at_terminator)
}

fn callee<'tcx>(
    tcx: TyCtxt<'tcx>,
    owner: LocalDefId,
    body: &Body<'tcx>,
    func: &mir::Operand<'tcx>,
) -> Option<(String, String, DefId)> {
    let ty::FnDef(def_id, args) = *func.ty(&body.local_decls, tcx).kind() else {
        // Function pointers, dyn dispatch, and other indirect calls have no
        // statically known body. The call block itself remains in the flow.
        return None;
    };
    let env = ty::TypingEnv::post_analysis(tcx, owner.to_def_id());
    let target = match ty::Instance::try_resolve(tcx, env, def_id, args) {
        Ok(Some(instance)) => instance.def_id(),
        _ => def_id,
    };
    Some((flow_key(tcx, target), flow_id(tcx, target), target))
}

fn callee_artifact_path(
    source: &rustc_session::cstore::CrateSource,
) -> Option<&std::path::Path> {
    // These are loaded representations of one compiler-selected crate, not
    // competing identities. Prefer metadata, then static, then dynamic source.
    source.rmeta.as_deref().or(source.rlib.as_deref()).or(source.dylib.as_deref())
}

#[cfg(test)]
mod callee_artifact_tests {
    use super::callee_artifact_path;
    use rustc_session::cstore::CrateSource;
    use std::path::{Path, PathBuf};

    #[test]
    fn loaded_crate_formats_preserve_artifact_evidence() {
        let source = |dylib: Option<&str>, rlib: Option<&str>, rmeta: Option<&str>| CrateSource {
            dylib: dylib.map(PathBuf::from),
            rlib: rlib.map(PathBuf::from),
            rmeta: rmeta.map(PathBuf::from),
            sdylib_interface: None,
        };
        for (loaded, expected) in [
            (source(None, None, None), None),
            (source(Some("/loaded/dynamic"), None, None), Some("/loaded/dynamic")),
            (source(None, Some("/loaded/static"), None), Some("/loaded/static")),
            (source(None, None, Some("/loaded/metadata")), Some("/loaded/metadata")),
            (source(Some("/loaded/dynamic"), Some("/loaded/static"), None), Some("/loaded/static")),
            (source(Some("/loaded/dynamic"), None, Some("/loaded/metadata")), Some("/loaded/metadata")),
            (source(None, Some("/loaded/static"), Some("/loaded/metadata")), Some("/loaded/metadata")),
            (source(Some("/loaded/dynamic"), Some("/loaded/static"), Some("/loaded/metadata")), Some("/loaded/metadata")),
        ] {
            assert_eq!(callee_artifact_path(&loaded), expected.map(Path::new));
        }
        let mut interface_only = source(None, None, None);
        interface_only.sdylib_interface = Some(PathBuf::from("/loaded/interface"));
        assert_eq!(callee_artifact_path(&interface_only), None);
    }
}

fn fill_callee_metadata<'tcx>(
    tcx: TyCtxt<'tcx>,
    body: &Body<'tcx>,
    func: &mir::Operand<'tcx>,
    target: DefId,
    block: &mut Block,
) {
    block.callee_crate = Some(tcx.crate_name(target.krate).to_string());
    if !target.is_local() {
        let source = tcx.used_crate_source(target.krate);
        if let Some(path) = callee_artifact_path(source) {
            block.callee_artifact = std::fs::canonicalize(path)
                .ok()
                .map(|path| path.to_string_lossy().into_owned());
        }
    }
    let abi = format!("{:?}", func.ty(&body.local_decls, tcx).fn_sig(tcx).abi());
    block.callee_abi = Some(abi.clone());
    if tcx.def_kind(tcx.parent(target)) != DefKind::ForeignMod {
        return;
    }
    let attrs = tcx.codegen_fn_attrs(target);
    let symbol = attrs
        .symbol_name
        .unwrap_or_else(|| tcx.item_name(target))
        .to_string();
    let libraries = tcx
        .native_library(target)
        .map(|library| vec![library.name.to_string()])
        .unwrap_or_default();
    block.native_call = Some(NativeCall {
        symbol,
        abi,
        libraries,
        declaration_local: target.is_local(),
    });
}

fn callback_metadata<'tcx>(
    tcx: TyCtxt<'tcx>,
    body: &Body<'tcx>,
    state: &State,
    func: &mir::Operand<'tcx>,
    args: &[Spanned<mir::Operand<'tcx>>],
    block: &mut Block,
) {
    let fn_def = match *func.ty(&body.local_decls, tcx).kind() {
        ty::FnDef(def_id, _) => Some(def_id),
        _ => None,
    };
    let fn_trait_call = fn_trait_invocation(tcx, body, func);
    if fn_trait_call || fn_def.is_none() {
        // Fn/FnMut/FnOnce are invocation shims. Their first MIR argument is
        // the callable receiver, not a call into the trait method's body.
        let target = if fn_trait_call {
            args.first().map(|arg| &arg.node).unwrap_or(func)
        } else {
            func
        };
        let provenance = operand_provenance(tcx, body, state, target);
        let parameter = provenance.single_parameter();
        let unknown = provenance.unresolved();
        block.callee = None;
        block.callee_id = None;
        block.callee_targets = provenance.targets.into_iter().collect();
        block.callback_parameter = parameter;
        block.callback_unknown =
            unknown || (block.callee_targets.is_empty() && block.callback_parameter.is_none());
    }
    for (index, arg) in args.iter().enumerate() {
        if fn_trait_call && index == 0 {
            continue;
        }
        if !callback_type(arg.node.ty(&body.local_decls, tcx)) {
            continue;
        }
        let provenance = operand_provenance(tcx, body, state, &arg.node);
        let parameter = provenance.single_parameter();
        let unknown =
            provenance.unresolved() || (provenance.targets.is_empty() && parameter.is_none());
        block.callback_args.push(CallbackArg {
            index,
            targets: provenance.targets.into_iter().collect(),
            parameter,
            unknown,
        });
    }
}

fn trait_callback_references<'tcx>(
    tcx: TyCtxt<'tcx>,
    owner: LocalDefId,
    body: &Body<'tcx>,
    func: &mir::Operand<'tcx>,
    args: &[Spanned<mir::Operand<'tcx>>],
) -> Vec<TraitCallbackReference> {
    let ty::FnDef(callee_id, callee_args) = *func.ty(&body.local_decls, tcx).kind() else {
        return Vec::new();
    };
    let env = ty::TypingEnv::post_analysis(tcx, owner.to_def_id());
    let mut references = Vec::new();
    let mut seen = BTreeSet::new();
    for (clause, _) in tcx
        .predicates_of(callee_id)
        .instantiate(tcx, callee_args)
        .iter()
    {
        let ty::ClauseKind::Trait(predicate) = clause.kind().skip_binder() else {
            continue;
        };
        if predicate.polarity != ty::PredicatePolarity::Positive {
            continue;
        }
        // Region erasure is sound here; type and const parameters are not.
        let Ok(trait_ref) = tcx.try_normalize_erasing_regions(env, predicate.trait_ref) else {
            continue;
        };
        if trait_ref.has_non_region_param()
            || trait_ref.has_non_region_infer()
            || trait_ref.has_placeholders()
            || trait_ref.has_escaping_bound_vars()
            || trait_ref.has_aliases()
        {
            continue;
        }
        let Ok(ImplSource::UserDefined(selected)) =
            tcx.codegen_select_candidate(env.as_query_input(trait_ref))
        else {
            continue;
        };
        if !selected.impl_def_id.is_local() {
            continue;
        }
        let targets: Vec<_> = tcx
            .associated_items(selected.impl_def_id)
            .in_definition_order()
            .filter(|item| {
                item.def_id.is_local()
                    && matches!(item.kind, ty::AssocKind::Fn { .. })
                    && item
                        .trait_item_def_id()
                        .is_some_and(|trait_item| tcx.parent(trait_item) == trait_ref.def_id)
            })
            .map(|item| TraitCallbackTarget {
                function: flow_key(tcx, item.def_id),
                function_id: flow_id(tcx, item.def_id),
            })
            .collect();
        if targets.is_empty() {
            continue;
        }
        for (index, arg) in args.iter().enumerate() {
            let actual = arg.node.ty(&body.local_decls, tcx);
            let Ok(actual) = tcx.try_normalize_erasing_regions(env, actual) else {
                continue;
            };
            if actual != trait_ref.self_ty() {
                continue;
            }
            let trait_id = flow_id(tcx, trait_ref.def_id);
            if !seen.insert((index, trait_id.clone())) {
                continue;
            }
            references.push(TraitCallbackReference {
                kind: "trait_method_reference",
                index,
                receiver_type: actual.to_string(),
                trait_id,
                r#trait: flow_key(tcx, trait_ref.def_id),
                targets: targets
                    .iter()
                    .map(|target| TraitCallbackTarget {
                        function: target.function.clone(),
                        function_id: target.function_id.clone(),
                    })
                    .collect(),
            });
        }
    }
    references
}

fn block<'tcx>(
    tcx: TyCtxt<'tcx>,
    owner: LocalDefId,
    body: &Body<'tcx>,
    state: &State,
    id: mir::BasicBlock,
    data: &mir::BasicBlockData<'tcx>,
) -> Block {
    let mut block = Block {
        id: format!("{id:?}"),
        kind: "opaque",
        label: "missing terminator".into(),
        source_file: None,
        source_location: None,
        callee: None,
        callee_id: None,
        callee_artifact: None,
        callee_crate: None,
        callee_abi: None,
        native_call: None,
        callee_targets: Vec::new(),
        callback_parameter: None,
        callback_args: Vec::new(),
        callback_references: Vec::new(),
        callback_unknown: false,
        successors: Vec::new(),
    };
    let Some(term) = &data.terminator else {
        return block;
    };
    (block.source_file, block.source_location) = location(tcx, term.source_info.span);
    let fallback;
    match &term.kind {
        TerminatorKind::Goto { target }
        | TerminatorKind::FalseEdge {
            real_target: target,
            ..
        }
        | TerminatorKind::FalseUnwind {
            real_target: target,
            ..
        } => {
            // Imaginary borrow-check edges are deliberately excluded.
            block.kind = "goto";
            fallback = "continue".to_string();
            block.successors.push(edge(*target, "next"));
        }
        TerminatorKind::SwitchInt { discr, targets } => {
            block.kind = "branch";
            fallback = format!("switch {discr:?}");
            for (value, target) in targets.iter() {
                block
                    .successors
                    .push(edge(target, format!("value {value:?}")));
            }
            block
                .successors
                .push(edge(targets.otherwise(), "otherwise"));
        }
        TerminatorKind::Call {
            func,
            args,
            target,
            unwind,
            ..
        } => {
            block.kind = "call";
            if let Some((key, id, target_id)) = callee(tcx, owner, body, func) {
                block.callee = Some(key);
                block.callee_id = Some(id);
                fill_callee_metadata(tcx, body, func, target_id, &mut block);
            }
            callback_metadata(tcx, body, state, func, args, &mut block);
            block.callback_references = trait_callback_references(tcx, owner, body, func, args);
            fallback = format!(
                "call {}",
                block.callee.as_deref().unwrap_or("indirect target")
            );
            if let Some(target) = target {
                block.successors.push(edge(*target, "return"));
            }
            block.successors.push(unwind_edge(unwind));
        }
        TerminatorKind::TailCall { func, args, .. } => {
            block.kind = "tail_call";
            if let Some((key, id, target_id)) = callee(tcx, owner, body, func) {
                block.callee = Some(key);
                block.callee_id = Some(id);
                fill_callee_metadata(tcx, body, func, target_id, &mut block);
            }
            callback_metadata(tcx, body, state, func, args, &mut block);
            block.callback_references = trait_callback_references(tcx, owner, body, func, args);
            fallback = format!(
                "tail call {}",
                block.callee.as_deref().unwrap_or("indirect target")
            );
        }
        TerminatorKind::Return => {
            block.kind = "return";
            fallback = "return".to_string();
        }
        TerminatorKind::Drop { target, unwind, .. } => {
            block.kind = "opaque";
            fallback = "drop (destructor body opaque)".to_string();
            block.successors.push(edge(*target, "after drop"));
            block.successors.push(unwind_edge(unwind));
        }
        TerminatorKind::Assert { target, unwind, .. } => {
            block.kind = "assert";
            fallback = "assert".to_string();
            block.successors.push(edge(*target, "passed"));
            block.successors.push(unwind_edge(unwind));
        }
        TerminatorKind::Yield { resume, drop, .. } => {
            block.kind = "yield";
            fallback = "yield".to_string();
            block.successors.push(edge(*resume, "resume"));
            if let Some(drop) = drop {
                block.successors.push(edge(*drop, "drop coroutine"));
            }
        }
        TerminatorKind::UnwindResume => {
            block.kind = "unwind";
            fallback = "resume unwinding".to_string();
            block.successors.push(unwind_edge(&UnwindAction::Continue));
        }
        TerminatorKind::UnwindTerminate(_) => {
            block.kind = "abort";
            fallback = "terminate on unwind".to_string();
            block.successors.push(Successor {
                target: None,
                label: "terminate on unwind".into(),
                kind: "unwind",
                action: Some("terminate"),
            });
        }
        TerminatorKind::Unreachable => {
            block.kind = "unreachable";
            fallback = "unreachable".to_string();
        }
        TerminatorKind::CoroutineDrop => {
            block.kind = "return";
            fallback = "coroutine drop".to_string();
        }
        TerminatorKind::InlineAsm {
            targets, unwind, ..
        } => {
            block.kind = "opaque";
            fallback = "inline assembly".to_string();
            for (i, target) in targets.iter().enumerate() {
                block
                    .successors
                    .push(edge(*target, format!("assembly exit {i}")));
            }
            block.successors.push(unwind_edge(unwind));
        }
    }
    block.label = if matches!(&term.kind, TerminatorKind::Drop { .. }) {
        format!(
            "{} (destructor body opaque)",
            snippet(tcx, term.source_info.span).unwrap_or_else(|| "drop".into())
        )
    } else {
        snippet(tcx, term.source_info.span).unwrap_or(fallback)
    };
    block
}

// This optional capability is independent of the control-flow v1 schema. Types
// and projection variants come from rustc; display strings are never parsed.
fn value_shape_node(
    depth: usize,
    remaining: &mut usize,
    describe: impl FnOnce(&mut usize) -> serde_json::Value,
) -> serde_json::Value {
    // Root, reference and field callers reserve at least this one node.
    *remaining -= 1;
    if depth >= 12 {
        serde_json::json!({"kind": "unknown"})
    } else {
        describe(remaining)
    }
}

fn value_shape_reference<T>(
    target: T,
    depth: usize,
    remaining: &mut usize,
    describe: impl FnOnce(T, usize, &mut usize) -> serde_json::Value,
) -> serde_json::Value {
    if *remaining == 0 {
        serde_json::json!({"kind": "unknown"})
    } else {
        serde_json::json!({"kind": "reference", "target": describe(target, depth + 1, remaining)})
    }
}

fn value_shape_fields<I: ExactSizeIterator>(
    fields: I,
    depth: usize,
    remaining: &mut usize,
    mut describe: impl FnMut(I::Item, usize, &mut usize) -> serde_json::Value,
) -> serde_json::Value {
    let count = fields.len();
    if count > *remaining {
        return serde_json::json!({"kind": "unknown"});
    }
    let mut children = Vec::with_capacity(count);
    for (index, field) in fields.enumerate() {
        // Earlier descendants cannot consume the one node reserved for each tail.
        let capacity = *remaining - (count - index - 1);
        let mut child_remaining = capacity;
        children.push(describe(field, depth + 1, &mut child_remaining));
        *remaining -= capacity - child_remaining;
    }
    serde_json::json!({"kind": "fields", "fields": children})
}

fn value_shape<'tcx>(tcx: TyCtxt<'tcx>, value: ty::Ty<'tcx>) -> serde_json::Value {
    fn describe<'tcx>(tcx: TyCtxt<'tcx>, value: ty::Ty<'tcx>, depth: usize, remaining: &mut usize) -> serde_json::Value {
        value_shape_node(depth, remaining, |remaining| match value.kind() {
            ty::Ref(_, target, _) => value_shape_reference(*target, depth, remaining, |field, depth, remaining| describe(tcx, field, depth, remaining)),
            ty::Tuple(fields) => value_shape_fields(fields.iter(), depth, remaining, |field, depth, remaining| describe(tcx, field, depth, remaining)),
            ty::Adt(def, args) if def.is_struct() => value_shape_fields(def.non_enum_variant().fields.iter(), depth, remaining, |field, depth, remaining| describe(tcx, field.ty(tcx, args), depth, remaining)),
            ty::Bool | ty::Char | ty::Int(_) | ty::Uint(_) | ty::Float(_) | ty::FnDef(..) | ty::FnPtr(..) | ty::Never => serde_json::json!({"kind": "scalar"}),
            _ => serde_json::json!({"kind": "unknown"}),
        })
    }
    describe(tcx, value, 0, &mut 4096)
}

#[cfg(test)]
mod value_shape_budget_tests {
    use super::{value_shape_fields, value_shape_node, value_shape_reference};
    use serde_json::{json, Value};

    enum Shape {
        Scalar,
        Unknown,
        Reference(Box<Shape>),
        Fields(Vec<Shape>),
    }

    fn describe(shape: &Shape, depth: usize, remaining: &mut usize) -> Value {
        value_shape_node(depth, remaining, |remaining| match shape {
            Shape::Scalar => json!({"kind": "scalar"}),
            Shape::Unknown => json!({"kind": "unknown"}),
            Shape::Reference(target) => value_shape_reference(target.as_ref(), depth, remaining, describe),
            Shape::Fields(fields) => value_shape_fields(fields.iter(), depth, remaining, describe),
        })
    }

    fn nodes(value: &Value) -> usize {
        1 + value.get("fields").and_then(Value::as_array).map_or(0, |fields| fields.iter().map(nodes).sum())
            + value.get("target").map_or(0, nodes)
    }

    fn wide(outer: usize, inner: usize) -> Shape {
        Shape::Fields(std::iter::once(Shape::Fields((0..inner).map(|_| Shape::Scalar).collect()))
            .chain((1..outer).map(|_| Shape::Scalar)).collect())
    }

    #[test]
    fn value_shape_budget_counts_serialized_nodes_and_reserved_tails() {
        // Exercise the emitter's actual accounting helpers, not a JS size model.
        for budget in 1..=64 {
            let mut remaining = budget;
            let unknowns = describe(&Shape::Fields((0..16).map(|_| Shape::Unknown).collect()), 0, &mut remaining);
            assert_eq!(nodes(&unknowns), budget - remaining);
            assert!(nodes(&unknowns) <= budget);
            for outer in 1..=16 {
                for inner in 0..=16 {
                    let shape = wide(outer, inner);
                    let mut remaining = budget;
                    let encoded = serde_json::to_vec(&describe(&shape, 0, &mut remaining)).expect("serialize shape");
                    let decoded: Value = serde_json::from_slice(&encoded).expect("parse shape");
                    assert_eq!(nodes(&decoded), budget - remaining);
                    assert!(nodes(&decoded) <= budget);
                }
            }
        }
        let mut remaining = 4096;
        let value = describe(&wide(4095, 4094), 0, &mut remaining);
        let decoded: Value = serde_json::from_slice(&serde_json::to_vec(&value).expect("serialize wide shape")).expect("parse wide shape");
        assert_eq!(nodes(&decoded), 4096);
        assert_eq!(remaining, 0);
        assert_eq!(decoded["fields"][0]["kind"], "unknown");

        let mut deep = Shape::Scalar;
        for _ in 0..20 { deep = Shape::Reference(Box::new(deep)); }
        for budget in 1..=32 {
            let mut remaining = budget;
            let value = describe(&deep, 0, &mut remaining);
            assert_eq!(nodes(&value), budget.min(13));
            assert_eq!(nodes(&value), budget - remaining);
            let mut leaf = &value;
            while let Some(target) = leaf.get("target") { leaf = target; }
            assert_eq!(leaf["kind"], "unknown");
        }
    }
}

fn value_place<'tcx>(
    tcx: TyCtxt<'tcx>,
    body: &Body<'tcx>,
    place: mir::Place<'tcx>,
) -> serde_json::Value {
    use mir::ProjectionElem;
    let projections: Vec<_> = place.iter_projections().map(|(base, elem)| match elem {
        ProjectionElem::Field(_, _) if matches!(base.ty(&body.local_decls, tcx).ty.kind(), ty::Adt(def, _) if def.is_union()) =>
            serde_json::json!({"kind": "unsupported", "reason": "union field alias"}),
        ProjectionElem::Field(field, ty) => serde_json::json!({"kind": "field", "index": field.as_usize(), "type": ty.to_string(), "shape": value_shape(tcx, ty)}),
        ProjectionElem::Deref if matches!(base.ty(&body.local_decls, tcx).ty.kind(), ty::Ref(..)) =>
            serde_json::json!({"kind": "deref"}),
        ProjectionElem::Deref => serde_json::json!({"kind": "unsupported", "reason": "non-reference dereference"}),
        ProjectionElem::Index(local) => serde_json::json!({"kind": "unsupported", "reason": "dynamic index", "local": local.as_usize()}),
        ProjectionElem::ConstantIndex { offset, min_length, from_end } => serde_json::json!({"kind": "unsupported", "reason": "index projection", "offset": offset, "min_length": min_length, "from_end": from_end}),
        ProjectionElem::Subslice { .. } => serde_json::json!({"kind": "unsupported", "reason": "subslice"}),
        ProjectionElem::Downcast(..) => serde_json::json!({"kind": "unsupported", "reason": "variant projection"}),
        _ => serde_json::json!({"kind": "unsupported", "reason": "type/opaque projection"}),
    }).collect();
    serde_json::json!({"local": place.local.as_usize(), "projection": projections,
        "type": place.ty(&body.local_decls, tcx).ty.to_string(),
        "shape": value_shape(tcx, place.ty(&body.local_decls, tcx).ty)})
}

fn value_operand<'tcx>(
    tcx: TyCtxt<'tcx>,
    body: &Body<'tcx>,
    operand: &mir::Operand<'tcx>,
) -> serde_json::Value {
    match operand {
        mir::Operand::Copy(place) => {
            serde_json::json!({"kind": "copy", "place": value_place(tcx, body, *place)})
        }
        mir::Operand::Move(place) => {
            serde_json::json!({"kind": "move", "place": value_place(tcx, body, *place)})
        }
        mir::Operand::Constant(value) => {
            serde_json::json!({"kind": "constant", "type": value.const_.ty().to_string()})
        }
        mir::Operand::RuntimeChecks(_) => serde_json::json!({"kind": "constant", "type": "bool"}),
    }
}

fn value_rvalue<'tcx>(
    tcx: TyCtxt<'tcx>,
    body: &Body<'tcx>,
    value: &Rvalue<'tcx>,
) -> serde_json::Value {
    let operand = |op| value_operand(tcx, body, op);
    let place = |p| value_place(tcx, body, p);
    match value {
        Rvalue::Use(op) | Rvalue::WrapUnsafeBinder(op, _) => {
            serde_json::json!({"kind": "use", "operands": [operand(op)]})
        }
        Rvalue::CopyForDeref(p) => {
            serde_json::json!({"kind": "use", "operands": [{"kind": "copy", "place": place(*p)}]})
        }
        Rvalue::Ref(_, _, p) => serde_json::json!({"kind": "ref", "place": place(*p)}),
        Rvalue::Cast(
            CastKind::Subtype
            | CastKind::IntToInt
            | CastKind::FloatToInt
            | CastKind::FloatToFloat
            | CastKind::IntToFloat,
            op,
            _,
        ) => serde_json::json!({"kind": "compute", "operands": [operand(op)]}),
        Rvalue::BinaryOp(_, ops) => {
            serde_json::json!({"kind": "compute", "operands": [operand(&ops.0), operand(&ops.1)]})
        }
        Rvalue::UnaryOp(_, op) => serde_json::json!({"kind": "compute", "operands": [operand(op)]}),
        Rvalue::Discriminant(p) => {
            serde_json::json!({"kind": "compute", "operands": [{"kind": "copy", "place": place(*p)}]})
        }
        Rvalue::Aggregate(kind, operands)
            if matches!(
                kind.as_ref(),
                mir::AggregateKind::Tuple | mir::AggregateKind::Adt(_, _, _, _, None)
            ) =>
        {
            serde_json::json!({"kind": "aggregate", "operands": operands.iter().map(operand).collect::<Vec<_>>()})
        }
        Rvalue::RawPtr(_, p) => {
            serde_json::json!({"kind": "unsupported", "reason": "raw pointer alias", "place": place(*p)})
        }
        Rvalue::Cast(_, op, _) => {
            serde_json::json!({"kind": "unsupported", "reason": "pointer/representation cast", "operands": [operand(op)]})
        }
        _ => serde_json::json!({"kind": "unsupported", "reason": "unmodeled rvalue"}),
    }
}

fn value_facts<'tcx>(tcx: TyCtxt<'tcx>, body: &Body<'tcx>) -> serde_json::Value {
    let locals: Vec<_> = body.local_decls.iter_enumerated().map(|(local, decl)| {
        let (file, line) = location(tcx, decl.source_info.span);
        let kind = match decl.ty.kind() { ty::Ref(..) => "reference", ty::RawPtr(..) => "raw_pointer", _ => "value" };
        serde_json::json!({"local": local.as_usize(), "type": decl.ty.to_string(), "kind": kind,
            "shape": value_shape(tcx, decl.ty),
            "role": if local == mir::RETURN_PLACE { "return" } else if local.as_usize() <= body.arg_count { "parameter" } else { "local" },
            "source_file": file, "source_location": line})
    }).collect();
    let blocks: Vec<_> = body.basic_blocks.iter_enumerated().map(|(bb, data)| {
        let statements: Vec<_> = data.statements.iter().enumerate().map(|(index, statement)| {
            let (file, line) = location(tcx, statement.source_info.span);
            let mut fact = match &statement.kind {
                StatementKind::Assign(pair) => serde_json::json!({"kind": "assign", "destination": value_place(tcx, body, pair.0), "value": value_rvalue(tcx, body, &pair.1)}),
                StatementKind::StorageLive(local) | StatementKind::StorageDead(local) => serde_json::json!({"kind": "storage", "local": local.as_usize()}),
                StatementKind::Nop | StatementKind::FakeRead(_) | StatementKind::PlaceMention(_) | StatementKind::AscribeUserType(..) | StatementKind::Coverage(_) | StatementKind::ConstEvalCounter | StatementKind::BackwardIncompatibleDropHint { .. } => serde_json::json!({"kind": "nop"}),
                _ => serde_json::json!({"kind": "unsupported", "reason": "unmodeled memory effect"}),
            };
            fact["id"] = serde_json::json!(format!("bb{}:s{index}", bb.as_usize()));
            fact["source_file"] = serde_json::json!(file);
            fact["source_location"] = serde_json::json!(line);
            fact
        }).collect();
        let call = data.terminator.as_ref().and_then(|term| {
            let (file, line) = location(tcx, term.source_info.span);
            let (func, args, destination) = match &term.kind {
                TerminatorKind::Call { func, args, destination, .. } => (func, args, Some(*destination)),
                TerminatorKind::TailCall { func, args, .. } => (func, args, None),
                _ => return None,
            };
            Some(serde_json::json!({"function": value_operand(tcx, body, func),
                "argument_convention": if fn_trait_invocation(tcx, body, func) { "fn-trait-tuple" } else { "direct" },
                "arguments": args.iter().map(|arg| value_operand(tcx, body, &arg.node)).collect::<Vec<_>>(),
                "destination": destination.map(|p| value_place(tcx, body, p)),
                "source_file": file, "source_location": line}))
        });
        serde_json::json!({"id": format!("bb{}", bb.as_usize()), "statements": statements, "call": call})
    }).collect();
    serde_json::json!({"version": 1, "capability": "rustc-mir-values-v1", "status": "captured",
        "parameter_locals": (1..=body.arg_count).collect::<Vec<_>>(), "return_local": 0, "locals": locals, "blocks": blocks})
}

// Optional capability separate from value v1. The scalar/target association comes
// directly from typed SwitchInt, never from labels or pretty-printed MIR.
fn guard_facts<'tcx>(tcx: TyCtxt<'tcx>, body: &Body<'tcx>) -> serde_json::Value {
    let branches: Vec<_> = body
        .basic_blocks
        .iter_enumerated()
        .filter_map(|(bb, data)| {
            let term = data.terminator.as_ref()?;
            let TerminatorKind::SwitchInt { discr, targets } = &term.kind else {
                return None;
            };
            let block = format!("bb{}", bb.as_usize());
            if !matches!(discr.ty(&body.local_decls, tcx).kind(), ty::Bool)
                || !matches!(discr, mir::Operand::Copy(_) | mir::Operand::Move(_))
            {
                return Some(serde_json::json!({"block": block, "kind": "unsupported"}));
            }
            let target = |scalar| {
                targets
                    .iter()
                    .find(|(value, _)| *value == scalar)
                    .map(|(_, target)| target)
                    .unwrap_or_else(|| targets.otherwise())
            };
            Some(serde_json::json!({"block": block, "kind": "boolean",
            "discriminant": value_operand(tcx, body, discr),
            "targets": [{"value": false, "target": format!("bb{}", target(0).as_usize())},
                {"value": true, "target": format!("bb{}", target(1).as_usize())}]}))
        })
        .collect();
    let function_values: Vec<_> = body.basic_blocks.iter_enumerated().flat_map(|(bb, data)| {
        data.statements.iter().enumerate().filter_map(move |(index, statement)| {
            let StatementKind::Assign(pair) = &statement.kind else { return None; };
            let Rvalue::Cast(CastKind::PointerCoercion(..), operand, target) = &pair.1 else { return None; };
            let source = operand.ty(&body.local_decls, tcx);
            let ty::FnDef(def, args) = source.kind() else { return None; };
            if !args.is_empty() || !matches!(target.kind(), ty::FnPtr(..)) { return None; }
            let (file, line) = location(tcx, statement.source_info.span);
            Some(serde_json::json!({"statement": format!("bb{}:s{index}", bb.as_usize()),
                "kind": "function-pointer", "function_id": flow_id(tcx, *def),
                "source": value_operand(tcx, body, operand), "destination": value_place(tcx, body, pair.0),
                "source_file": file, "source_location": line}))
        })
    }).collect();
    serde_json::json!({"version": 1, "capability": "rustc-mir-guards-v1", "status": "captured", "branches": branches, "function_values": function_values})
}

fn digest_file(file: &str) -> Option<String> {
    // FNV-1a, shared with the graph ingester. A source digest excludes stale
    // per-unit records if Cargo changes its metadata key after an edit.
    let bytes = std::fs::read(file).ok()?;
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in bytes {
        hash = (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3);
    }
    Some(format!("{hash:016x}"))
}

pub(super) fn write_unit(tcx: TyCtxt<'_>, dir: &str, key: &str) {
    // `--test` turns a library into an Executable with the same crate name as
    // its binary target. Its MIR is a harness variant, not a separate catalog
    // function; do not let it occupy the binary flow identity.
    if tcx.sess.opts.test {
        let _ = std::fs::remove_file(std::path::Path::new(dir).join(format!("{key}.json")));
        return;
    }
    let mut flows = Vec::new();
    let mut digests = std::collections::HashMap::<String, Option<String>>::new();
    for &owner in tcx.mir_keys(()) {
        if !matches!(
            tcx.def_kind(owner),
            DefKind::Fn | DefKind::AssocFn | DefKind::Closure | DefKind::SyntheticCoroutineBody
        ) {
            continue;
        }
        let path = flow_key(tcx, owner.to_def_id());
        // Macro-generated local bodies may carry the definition span of a
        // dependency macro. Anchor provenance to the workspace invocation so
        // the importer can verify the actual source file and digest.
        let (source_file, source_location) =
            location(tcx, tcx.def_span(owner.to_def_id()).source_callsite());
        // This query runs borrow checking and drop elaboration, but precedes
        // optimized_mir, whose inlining can erase source-level calls.
        let mir = tcx.mir_drops_elaborated_and_const_checked(owner);
        let mut captured_values = None;
        let mut captured_guards = None;
        let blocks = if mir.is_stolen() {
            vec![Block {
                id: "bb0".into(),
                kind: "opaque",
                label: "pre-optimization MIR unavailable".into(),
                source_file: source_file.clone(),
                source_location,
                callee: None,
                callee_id: None,
                callee_artifact: None,
                callee_crate: None,
                callee_abi: None,
                native_call: None,
                callee_targets: Vec::new(),
                callback_parameter: None,
                callback_args: Vec::new(),
                callback_references: Vec::new(),
                callback_unknown: false,
                successors: Vec::new(),
            }]
        } else {
            let body = mir.borrow();
            captured_values = Some(value_facts(tcx, &body));
            captured_guards = Some(guard_facts(tcx, &body));
            let states = block_states(tcx, &body);
            let unknown = State::new();
            body.basic_blocks
                .iter_enumerated()
                .map(|(bb, data)| {
                    let state = states
                        .as_ref()
                        .and_then(|states| states.get(&bb))
                        .unwrap_or(&unknown);
                    block(tcx, owner, &body, state, bb, data)
                })
                .collect()
        };
        let source_digest = source_file.as_deref().and_then(|file| {
            digests
                .entry(file.to_string())
                .or_insert_with(|| digest_file(file))
                .clone()
        });
        let impl_identity = canonical_impl_identity(tcx, owner.to_def_id());
        let link_symbol = if matches!(tcx.def_kind(owner), DefKind::Fn | DefKind::AssocFn) {
            let attrs = tcx.codegen_fn_attrs(owner.to_def_id());
            attrs.symbol_name.map(|symbol| symbol.to_string()).or_else(|| {
                attrs
                    .flags
                    .contains(CodegenFnAttrFlags::NO_MANGLE)
                    .then(|| tcx.item_name(owner.to_def_id()).to_string())
            })
        } else {
            None
        };
        flows.push(FlowRecord {
            function: path.clone(),
            function_id: flow_id(tcx, owner.to_def_id()),
            compiler_entry: if tcx.crate_types().contains(&CrateType::ProcMacro)
                && matches!(tcx.def_kind(owner), DefKind::Fn)
                && tcx.hir_attrs(tcx.local_def_id_to_hir_id(owner)).iter().any(|attr| {
                    matches!(attr, rustc_hir::Attribute::Parsed(
                        rustc_hir::attrs::AttributeKind::ProcMacro(..)
                        | rustc_hir::attrs::AttributeKind::ProcMacroAttribute(..)
                        | rustc_hir::attrs::AttributeKind::ProcMacroDerive { .. }
                    ))
                })
            {
                Some("proc-macro-export".into())
            } else if tcx.entry_fn(()).is_some_and(|(entry, _)| entry == owner.to_def_id()) {
                Some("compiler-main".into())
            } else {
                None
            },
            owner_kind: format!("{:?}", tcx.def_kind(owner)),
            definition_source: {
                let (file, line) = location(tcx, tcx.def_span(owner.to_def_id()));
                file.as_deref().and_then(|file| {
                    let digest = digests.entry(file.to_string()).or_insert_with(|| digest_file(file)).clone()?;
                    Some(serde_json::json!({ "source_file": file, "source_location": line, "source_digest": digest }))
                })
            },
            source_digest,
            link_symbol,
            impl_self: impl_identity
                .as_ref()
                .map(|(self_type, _)| self_type.clone()),
            impl_trait: impl_identity
                .as_ref()
                .map(|(_, trait_name)| trait_name.clone()),
            source_file,
            source_location,
            flow: Flow {
                version: 1,
                function: path,
                function_id: flow_id(tcx, owner.to_def_id()),
                entry: "bb0".into(),
                blocks,
                value_facts: captured_values,
                guard_facts: captured_guards,
            },
        });
    }
    flows.sort_by(|a, b| a.function.cmp(&b.function));
    let unit = Unit {
        version: 2,
        krate: tcx.crate_name(rustc_span::def_id::LOCAL_CRATE).to_string(),
        unit_key: key.to_string(),
        manifest_dir: std::env::var("CARGO_MANIFEST_DIR").ok(),
        package_name: std::env::var("CARGO_PKG_NAME").ok(),
        package_version: std::env::var("CARGO_PKG_VERSION").ok(),
        out_dir: std::env::var("OUT_DIR").ok(),
        crate_root: tcx.sess.local_crate_source_file().map(|file| {
            file.path(RemapPathScopeComponents::DIAGNOSTICS)
                .to_string_lossy()
                .into_owned()
        }),
        crate_types: tcx.crate_types().iter().map(|ty| format!("{ty:?}")).collect(),
        build_context: build_context(tcx),
        flows,
    };
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let Ok(bytes) = serde_json::to_vec(&unit) else {
        return;
    };
    let path = std::path::Path::new(dir).join(format!("{key}.json"));
    let tmp = std::path::Path::new(dir).join(format!("{key}.{}.tmp", std::process::id()));
    if std::fs::write(&tmp, bytes).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}

/// Only selected compiler configuration is retained. Never persist arbitrary
/// rustc arguments, Cargo environment values, or build-script environment values.
fn build_context(tcx: TyCtxt<'_>) -> serde_json::Value {
    let args: Vec<String> = std::env::args().collect();
    let mut features = BTreeSet::new();
    let mut profile = std::collections::BTreeMap::new();
    for (index, arg) in args.iter().enumerate() {
        let cfg = arg.strip_prefix("--cfg=").or_else(|| {
            (arg == "--cfg").then(|| args.get(index + 1).map(String::as_str)).flatten()
        });
        if let Some(feature) = cfg.and_then(|cfg| cfg.strip_prefix("feature=\"")).and_then(|cfg| cfg.strip_suffix('"')) {
            features.insert(feature.to_string());
        }
        let codegen = arg.strip_prefix("-C").filter(|value| !value.is_empty()).or_else(|| {
            (arg == "-C").then(|| args.get(index + 1).map(String::as_str)).flatten()
        });
        if let Some((key, value)) = codegen.and_then(|value| value.split_once('=')) {
            if ["opt-level", "debuginfo", "debug-assertions", "panic", "codegen-units"].contains(&key) {
                profile.insert(key.to_string(), value.to_string());
            }
        }
    }
    serde_json::json!({
        "schemaVersion": 1,
        "target_triple": tcx.sess.opts.target_triple.to_string(),
        "features": features,
        "profile": profile,
        "profile_basis": "explicit rustc codegen flags; unspecified defaults and Cargo profile name unknown",
        "test": tcx.sess.opts.test,
        "phase_basis": "compiler entry and resolved call reachability; triples do not determine logical role",
    })
}
