//! Observe the real generated harness after HIR/type checking. All identities
//! come from this compiler, not Cargo flags, source parsing or stdout grammar.
use crate::compiler_semantic::{SemanticGap, SemanticTarget};
use crate::compiler_test_harness::*;
use crate::occurrences::Collector;
use crate::semantic::{ObservedRowBudget, Writer};
use rustc_ast::LitKind;
use rustc_hir::def::{DefKind, Res};
use rustc_hir::{Expr, ExprField, ExprKind, HirId, QPath, StmtKind};
use rustc_middle::ty::{self, TyCtxt};
use rustc_span::def_id::{DefId, LocalDefId, LOCAL_CRATE};
use rustc_span::hygiene::{AstPass, ExpnKind};
use rustc_span::Symbol;

// Every match is a bounded compiler-owned shape check, with an explicit gap
// for any changed/unsupported HIR. No unchecked query crosses an owner table.
fn peel<'tcx>(mut expression: &'tcx Expr<'tcx>) -> Option<&'tcx Expr<'tcx>> {
    for _ in 0..16 {
        match expression.kind {
            ExprKind::DropTemps(inner) => expression = inner,
            ExprKind::Block(block, _) if block.stmts.is_empty() => expression = block.expr?,
            _ => return Some(expression),
        }
    }
    None
}
fn definition(expression: &Expr<'_>, owner: HirId) -> Option<DefId> {
    if expression.hir_id.owner != owner.owner {
        return None;
    }
    let ExprKind::Path(QPath::Resolved(_, path)) = expression.kind else {
        return None;
    };
    let Res::Def(_, did) = path.res else {
        return None;
    };
    Some(did)
}
fn variant(tcx: TyCtxt<'_>, did: DefId) -> DefId {
    if matches!(tcx.def_kind(did), DefKind::Ctor(..)) {
        tcx.parent(did)
    } else {
        did
    }
}
fn call<'tcx>(expression: &'tcx Expr<'tcx>, owner: HirId) -> Option<(DefId, &'tcx [Expr<'tcx>])> {
    let expression = peel(expression)?;
    if expression.hir_id.owner != owner.owner {
        return None;
    }
    let ExprKind::Call(callee, args) = expression.kind else {
        return None;
    };
    Some((definition(peel(callee)?, owner)?, args))
}
fn field<'tcx>(
    fields: &'tcx [ExprField<'tcx>],
    name: &str,
    owner: HirId,
) -> Option<&'tcx Expr<'tcx>> {
    if fields.len() > 12 {
        return None;
    }
    let mut found = None;
    for value in fields {
        if value.hir_id.owner != owner.owner || value.expr.hir_id.owner != owner.owner {
            return None;
        }
        if value.ident.name.as_str() == name {
            if found.replace(value.expr).is_some() {
                return None;
            }
        }
    }
    found
}
fn string(expression: &Expr<'_>, owner: HirId) -> Option<Symbol> {
    let expression = peel(expression)?;
    if expression.hir_id.owner != owner.owner {
        return None;
    }
    let ExprKind::Lit(literal) = expression.kind else {
        return None;
    };
    let LitKind::Str(value, _) = literal.node else {
        return None;
    };
    Some(value)
}
fn boolean(expression: &Expr<'_>, owner: HirId) -> Option<bool> {
    let expression = peel(expression)?;
    if expression.hir_id.owner != owner.owner {
        return None;
    }
    let ExprKind::Lit(literal) = expression.kind else {
        return None;
    };
    let LitKind::Bool(value) = literal.node else {
        return None;
    };
    Some(value)
}
fn integer(expression: &Expr<'_>, owner: HirId) -> Option<u64> {
    let expression = peel(expression)?;
    if expression.hir_id.owner != owner.owner {
        return None;
    }
    let ExprKind::Lit(literal) = expression.kind else {
        return None;
    };
    let LitKind::Int(value, _) = literal.node else {
        return None;
    };
    u64::try_from(value.get()).ok()
}
fn structure<'tcx>(
    expression: &'tcx Expr<'tcx>,
    owner: HirId,
) -> Option<(DefId, &'tcx [ExprField<'tcx>])> {
    let expression = peel(expression)?;
    if expression.hir_id.owner != owner.owner {
        return None;
    }
    let ExprKind::Struct(QPath::Resolved(_, path), fields, tail) = expression.kind else {
        return None;
    };
    // The generated descriptors have no functional-update tail.
    if !matches!(tail, rustc_hir::StructTailExpr::None) {
        return None;
    }
    let Res::Def(DefKind::Struct, did) = path.res else {
        return None;
    };
    Some((did, fields))
}
fn entry_call<'tcx>(expression: &'tcx Expr<'tcx>) -> Option<&'tcx Expr<'tcx>> {
    let expression = peel(expression)?;
    let ExprKind::Block(block, _) = expression.kind else {
        return Some(expression);
    };
    if block.expr.is_some() || block.stmts.len() > 2 {
        return None;
    }
    let mut found = None;
    for statement in block.stmts {
        match statement.kind {
            StmtKind::Item(_) => {}
            StmtKind::Expr(value) | StmtKind::Semi(value) => {
                if found.replace(value).is_some() {
                    return None;
                }
            }
            _ => return None,
        }
    }
    found
}
fn table<'tcx>(
    argument: &'tcx Expr<'tcx>,
    owner: HirId,
) -> Option<(&'tcx Expr<'tcx>, &'tcx [Expr<'tcx>])> {
    let value = peel(argument)?;
    if value.hir_id.owner != owner.owner {
        return None;
    }
    let ExprKind::AddrOf(_, _, inner) = value.kind else {
        return None;
    };
    let array = peel(inner)?;
    if array.hir_id.owner != owner.owner {
        return None;
    }
    let ExprKind::Array(entries) = array.kind else {
        return None;
    };
    Some((array, entries))
}
fn constant<'tcx>(tcx: TyCtxt<'tcx>, entry: &'tcx Expr<'tcx>, owner: HirId) -> Option<LocalDefId> {
    let expression = peel(entry)?;
    if expression.hir_id.owner != owner.owner {
        return None;
    }
    let ExprKind::AddrOf(_, _, inner) = expression.kind else {
        return None;
    };
    let did = definition(peel(inner)?, owner)?;
    if tcx.def_kind(did) != DefKind::Const {
        return None;
    }
    did.as_local()
}
fn descriptor_type(tcx: TyCtxt<'_>, entry: LocalDefId, array: &Expr<'_>) -> Option<DefId> {
    if !tcx.has_typeck_results(entry) {
        return None;
    }
    let results = tcx.typeck(entry);
    if results.hir_owner != array.hir_id.owner {
        return None;
    }
    let ty::Array(element, _) = results.node_type_opt(array.hir_id)?.kind() else {
        return None;
    };
    let ty::Ref(_, inner, _) = element.kind() else {
        return None;
    };
    let ty::Adt(adt, _) = inner.kind() else {
        return None;
    };
    Some(adt.did())
}
fn used_test_crate(
    tcx: TyCtxt<'_>,
    did: DefId,
    row: &mut ObservedRowBudget<'_>,
) -> Option<CompilerTestCrateObservation> {
    if did.krate == LOCAL_CRATE {
        return None;
    }
    let source = tcx.used_crate_source(did.krate);
    row.charge(4 * std::mem::size_of::<CompilerSysrootMemberObservation>())?;
    let mut members = Vec::new();
    members.try_reserve_exact(4).ok()?;
    if members.capacity() > 4 {
        return None;
    }
    for (kind, path) in [
        (CompilerSysrootMemberKind::Rlib, source.rlib.as_ref()),
        (CompilerSysrootMemberKind::Rmeta, source.rmeta.as_ref()),
        (CompilerSysrootMemberKind::Dylib, source.dylib.as_ref()),
        (
            CompilerSysrootMemberKind::Interface,
            source.sdylib_interface.as_ref(),
        ),
    ] {
        let Some(path) = path else {
            continue;
        };
        let relative = path
            .strip_prefix(tcx.sess.opts.sysroot.path())
            .ok()?
            .to_str()?;
        let relative = row.text(relative, MAX_HARNESS_TEXT, false)?;
        members.push(CompilerSysrootMemberObservation { kind, relative });
    }
    let value = CompilerTestCrateObservation {
        crate_name: row.text(tcx.crate_name(did.krate).as_str(), 1024, false)?,
        stable_crate_id: row.hex_bytes(&tcx.stable_crate_id(did.krate).as_u64().to_be_bytes())?,
        crate_hash: row.hex_bytes(&tcx.crate_hash(did.krate).as_u128().to_be_bytes())?,
        members,
    };
    value.validate().ok()?;
    Some(value)
}
struct DescriptorShape<'tcx> {
    did: LocalDefId,
    descriptor: DefId,
    fields: &'tcx [ExprField<'tcx>],
    function_fields: &'tcx [ExprField<'tcx>],
    owner: HirId,
    name: Symbol,
}
fn shape<'tcx>(
    tcx: TyCtxt<'tcx>,
    did: LocalDefId,
    expected: DefId,
) -> Option<DescriptorShape<'tcx>> {
    let body = tcx.hir_maybe_body_owned_by(did)?;
    let expression = peel(body.value)?;
    let owner = expression.hir_id;
    let ty::Adt(adt, _) = tcx.type_of(did).instantiate_identity().kind() else {
        return None;
    };
    if adt.did() != expected {
        return None;
    }
    let (descriptor, function_fields) = structure(expression, owner)?;
    if descriptor != expected || function_fields.len() != 2 {
        return None;
    }
    let (desc, fields) = structure(field(function_fields, "desc", owner)?, owner)?;
    if desc.krate != expected.krate
        || tcx.item_name(desc).as_str() != "TestDesc"
        || fields.len() != 12
    {
        return None;
    }
    let (name_constructor, name_args) = call(field(fields, "name", owner)?, owner)?;
    if name_constructor.krate != expected.krate
        || tcx.item_name(variant(tcx, name_constructor)).as_str() != "StaticTestName"
        || name_args.len() != 1
    {
        return None;
    }
    let name = string(&name_args[0], owner)?;
    Some(DescriptorShape {
        did,
        descriptor,
        fields,
        function_fields,
        owner,
        name,
    })
}
fn descriptor(
    tcx: TyCtxt<'_>,
    shape: &DescriptorShape<'_>,
    ordinal: u64,
    writer: &mut Writer,
) -> Option<TestDescriptorObservation> {
    let mut row = ObservedRowBudget::new::<TestDescriptorObservation>(writer)?;
    let owner = shape.owner;
    let fields = shape.fields;
    let (name_constructor, _) = call(field(fields, "name", owner)?, owner)?;
    let ignore_message = match peel(field(fields, "ignore_message", owner)?)?.kind {
        ExprKind::Path(_) => {
            let did = variant(
                tcx,
                definition(peel(field(fields, "ignore_message", owner)?)?, owner)?,
            );
            if Some(did) != tcx.lang_items().option_none_variant() {
                return None;
            }
            None
        }
        _ => {
            let (did, args) = call(field(fields, "ignore_message", owner)?, owner)?;
            if Some(variant(tcx, did)) != tcx.lang_items().option_some_variant() || args.len() != 1
            {
                return None;
            }
            Some(row.text(string(&args[0], owner)?.as_str(), MAX_HARNESS_TEXT, true)?)
        }
    };
    let panic_expr = peel(field(fields, "should_panic", owner)?)?;
    let (panic_did, should_panic) = if let Some(did) = definition(panic_expr, owner) {
        let did = variant(tcx, did);
        let value = match tcx.item_name(did).as_str() {
            "No" => TestPanicExpectation::No,
            "Yes" => TestPanicExpectation::Yes,
            _ => return None,
        };
        (did, value)
    } else {
        let (did, args) = call(panic_expr, owner)?;
        let did = variant(tcx, did);
        if tcx.item_name(did).as_str() != "YesWithMessage" || args.len() != 1 {
            return None;
        }
        (
            did,
            TestPanicExpectation::Message {
                value: row.text(string(&args[0], owner)?.as_str(), MAX_HARNESS_TEXT, true)?,
            },
        )
    };
    if panic_did.krate != shape.descriptor.krate
        || tcx.item_name(tcx.parent(panic_did)).as_str() != "ShouldPanic"
    {
        return None;
    }
    let type_did = variant(
        tcx,
        definition(peel(field(fields, "test_type", owner)?)?, owner)?,
    );
    if type_did.krate != shape.descriptor.krate
        || tcx.item_name(tcx.parent(type_did)).as_str() != "TestType"
    {
        return None;
    }
    let test_type = match tcx.item_name(type_did).as_str() {
        "UnitTest" => CompilerTestType::Unit,
        "IntegrationTest" => CompilerTestType::Integration,
        "Unknown" => CompilerTestType::Unknown,
        _ => return None,
    };
    let (function_constructor, args) = call(field(shape.function_fields, "testfn", owner)?, owner)?;
    if function_constructor.krate != shape.descriptor.krate || args.len() != 1 {
        return None;
    }
    let kind = match tcx.item_name(variant(tcx, function_constructor)).as_str() {
        "StaticTestFn" => TestDescriptorKind::Test,
        "StaticBenchFn" => TestDescriptorKind::Bench,
        _ => return None,
    };
    let closure_expr = peel(&args[0])?;
    if closure_expr.hir_id.owner != owner.owner {
        return None;
    }
    let ExprKind::Closure(closure) = closure_expr.kind else {
        return None;
    };
    let closure_body = tcx.hir_body(closure.body);
    if tcx.hir_body_owner_def_id(closure.body) != closure.def_id {
        return None;
    }
    let closure_owner = closure_body.value.hir_id;
    let (assertion_wrapper, args) = call(closure_body.value, closure_owner)?;
    if assertion_wrapper.krate != shape.descriptor.krate
        || tcx.item_name(assertion_wrapper).as_str() != "assert_test_result"
        || args.len() != 1
    {
        return None;
    }
    let (function, parameters) = call(&args[0], closure_owner)?;
    if function.krate != LOCAL_CRATE
        || tcx.def_kind(function) != DefKind::Fn
        || parameters.len() != usize::from(kind == TestDescriptorKind::Bench)
        || closure_body.params.len() != parameters.len()
    {
        return None;
    }
    let value = TestDescriptorObservation {
        table_ordinal: ordinal,
        constant: row.definition(tcx, shape.did.to_def_id())?,
        descriptor_type: row.definition(tcx, shape.descriptor)?,
        name: row.text(shape.name.as_str(), MAX_HARNESS_TEXT, false)?,
        kind,
        ignore: boolean(field(fields, "ignore", owner)?, owner)?,
        ignore_message,
        compile_fail: boolean(field(fields, "compile_fail", owner)?, owner)?,
        no_run: boolean(field(fields, "no_run", owner)?, owner)?,
        should_panic,
        test_type,
        source_file: row.text(
            string(field(fields, "source_file", owner)?, owner)?.as_str(),
            MAX_HARNESS_TEXT,
            false,
        )?,
        start_line: integer(field(fields, "start_line", owner)?, owner)?,
        start_column: integer(field(fields, "start_col", owner)?, owner)?,
        end_line: integer(field(fields, "end_line", owner)?, owner)?,
        end_column: integer(field(fields, "end_col", owner)?, owner)?,
        closure: row.definition(tcx, closure.def_id.to_def_id())?,
        function: row.definition(tcx, function)?,
        assertion_wrapper: row.definition(tcx, assertion_wrapper)?,
        name_constructor: row.definition(tcx, name_constructor)?,
        function_constructor: row.definition(tcx, function_constructor)?,
        panic_variant: row.definition(tcx, panic_did)?,
        test_type_variant: row.definition(tcx, type_did)?,
    };
    value.validate().ok()?;
    Some(value)
}

pub(super) fn observe(tcx: TyCtxt<'_>, collector: &mut Collector, writer: &mut Writer) {
    let Some((entry, _)) = tcx.entry_fn(()) else {
        writer.unsupported_observation(SemanticGap::TestHarnessUnavailable);
        return;
    };
    let Some(local) = entry.as_local() else {
        writer.unsupported_observation(SemanticGap::TestHarnessOwnerMismatch);
        return;
    };
    if !matches!(
        tcx.def_span(entry).ctxt().outer_expn_data().kind,
        ExpnKind::AstPass(AstPass::TestHarness)
    ) {
        writer.unsupported_observation(SemanticGap::TestHarnessUnavailable);
        return;
    }
    let Some(body) = tcx.hir_maybe_body_owned_by(local) else {
        writer.unsupported_observation(SemanticGap::TestHarnessUnavailable);
        return;
    };
    let Some((runner, args)) =
        entry_call(body.value).and_then(|value| call(value, body.value.hir_id))
    else {
        writer.unsupported_observation(SemanticGap::TestHarnessUnsupportedDescriptor);
        return;
    };
    if !matches!(
        tcx.item_name(runner).as_str(),
        "test_main_static" | "test_main_static_abort"
    ) || tcx.crate_name(runner.krate).as_str() != "test"
        || args.len() != 1
    {
        writer.unsupported_observation(SemanticGap::TestHarnessCustomRunner);
        return;
    }
    let Some((array, entries)) = table(&args[0], body.value.hir_id) else {
        writer.unsupported_observation(SemanticGap::TestHarnessUnsupportedDescriptor);
        return;
    };
    let Some(descriptor_type) = descriptor_type(tcx, local, array) else {
        writer.unsupported_observation(SemanticGap::TestHarnessOwnerMismatch);
        return;
    };
    if descriptor_type.krate != runner.krate
        || tcx.item_name(descriptor_type).as_str() != "TestDescAndFn"
    {
        writer.unsupported_observation(SemanticGap::TestHarnessOwnerMismatch);
        return;
    }
    let mut make = || -> Option<TestHarnessEntryObservation> {
        let mut row = ObservedRowBudget::new::<TestHarnessEntryObservation>(writer)?;
        Some(TestHarnessEntryObservation {
            entry: row.definition(tcx, entry)?,
            origin: TestHarnessOrigin::RustcTestHarness,
            runner: row.definition(tcx, runner)?,
            descriptor_type: row.definition(tcx, descriptor_type)?,
            test_crate: used_test_crate(tcx, runner, &mut row)?,
            table_entries: entries.len() as u64,
        })
    };
    let Some(header) = make().filter(|value| value.validate().is_ok()) else {
        writer.unsupported_observation(SemanticGap::TestHarnessCrateSourceUnavailable);
        return;
    };
    writer.observed_reference(
        body.value.hir_id,
        "test_harness_entry",
        SemanticTarget::TestHarnessEntry {
            entry: Box::new(header),
        },
        None,
    );
    let mut last: Option<Symbol> = None;
    for (ordinal, element) in entries.iter().enumerate() {
        if writer.work().is_break() {
            return;
        }
        let value = constant(tcx, element, body.value.hir_id)
            .and_then(|did| shape(tcx, did, descriptor_type));
        let Some(value) = value else {
            writer.unsupported_observation(SemanticGap::TestHarnessUnsupportedDescriptor);
            return;
        };
        if last.is_some_and(|name| name.as_str() >= value.name.as_str()) {
            writer.unsupported_observation(SemanticGap::TestHarnessOrderingUnknown);
            return;
        }
        last = Some(value.name);
        let Some(descriptor) = descriptor(tcx, &value, ordinal as u64, writer) else {
            writer.unsupported_observation(SemanticGap::TestHarnessUnsupportedDescriptor);
            return;
        };
        let location = writer.observed_location(collector, tcx, tcx.def_span(value.did));
        writer.observed_reference(
            value.owner,
            "test_harness_descriptor",
            SemanticTarget::TestHarnessDescriptor {
                descriptor: Box::new(descriptor),
            },
            location,
        );
    }
}
