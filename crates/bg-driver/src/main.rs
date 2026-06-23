//! Spike: a clippy-style rustc driver used as `RUSTC_WORKSPACE_WRAPPER`.
//!
//! Goal — prove we can pull *resolved* `calls`/`uses` edges straight out of the
//! compiler's HIR during a normal `cargo check`, incrementally (cargo only runs
//! the wrapper for crates it recompiles), without a separate rust-analyzer pass.
//!
//! This only prints a summary + samples; if the numbers and resolution look
//! right, the real version emits per-crate graph fragments into the existing
//! fragment/merge pipeline.

#![feature(rustc_private)]

extern crate rustc_driver;
extern crate rustc_hir;
extern crate rustc_interface;
extern crate rustc_middle;
extern crate rustc_session;
extern crate rustc_span;

use rustc_driver::{Callbacks, Compilation};
use rustc_hir::def::{DefKind, Res};
use rustc_hir::intravisit::{self, Visitor};
use rustc_hir::{AmbigArg, Expr, ExprKind, HirId, Pat, PatKind, QPath, Ty, TyKind};
use rustc_interface::interface::Compiler;
use rustc_middle::ty::{self, TyCtxt, TypeckResults};
use rustc_span::def_id::{DefId, LOCAL_CRATE};

struct BgCallbacks;

impl Callbacks for BgCallbacks {
    fn after_analysis<'tcx>(&mut self, _compiler: &Compiler, tcx: TyCtxt<'tcx>) -> Compilation {
        extract(tcx);
        Compilation::Continue
    }
}

/// A filename key that is **stable per compilation unit across edits** (cargo's
/// `-C metadata` hash) so persisted edge/def files overwrite cleanly on an
/// incremental rebuild instead of accumulating stale duplicates. Falls back to
/// the pid if metadata is absent.
fn unit_key(tcx: TyCtxt<'_>, krate: &str) -> String {
    let meta = tcx.sess.opts.cg.metadata.join("");
    if meta.is_empty() {
        format!("{krate}-{}", std::process::id())
    } else {
        format!("{krate}-{meta}")
    }
}

/// `file:line` of a def's *identifier* span (matching rust-analyzer's
/// name-occurrence convention), falling back to the full def span. Using the
/// identifier line is what makes coordinates line up with SCIP.
fn loc_of(tcx: TyCtxt<'_>, def_id: rustc_span::def_id::DefId) -> Option<(String, usize)> {
    let span = tcx
        .def_ident_span(def_id)
        .unwrap_or_else(|| tcx.def_span(def_id));
    if span.is_dummy() {
        return None;
    }
    let sm = tcx.sess.source_map();
    let lo = sm.lookup_char_pos(span.lo());
    let file = sm.filename_for_diagnostics(&lo.file.name).to_string();
    Some((file, lo.line))
}

fn extract(tcx: TyCtxt<'_>) {
    let krate = tcx.crate_name(LOCAL_CRATE);
    let mut calls: usize = 0;
    let mut method_calls: usize = 0;
    let mut cross_crate: usize = 0;
    let mut uses_count: usize = 0;
    let mut samples: Vec<String> = Vec::new();
    // Full edge dump (for equivalence checking against rust-analyzer scip):
    // (kind, caller "file:line", callee "file:line"). Only collected when requested.
    let want_edges = std::env::var_os("BG_DRIVER_EDGES").is_some();
    let mut edges: Vec<(&'static str, String, String)> = Vec::new();

    for owner in tcx.hir_body_owners() {
        let body = tcx.hir_body_owned_by(owner);
        let typeck = tcx.typeck(owner);
        let owner_path = tcx.def_path_str(owner.to_def_id());
        let owner_loc =
            want_edges
                .then(|| loc_of(tcx, owner.to_def_id()))
                .flatten()
                .map(|(f, l)| format!("{f}:{l}"));
        let mut v = CallVisitor {
            tcx,
            typeck,
            owner_did: owner.to_def_id(),
            owner: owner_path,
            owner_loc,
            calls: &mut calls,
            method_calls: &mut method_calls,
            cross_crate: &mut cross_crate,
            uses_count: &mut uses_count,
            samples: &mut samples,
            edges: &mut edges,
        };
        v.visit_expr(body.value);
        // Also walk the fn signature (param/return/where types) — rust-analyzer
        // records those type references too, attributed to the fn.
        let node = tcx.hir_node_by_def_id(owner);
        if let Some(decl) = node.fn_decl() {
            intravisit::walk_fn_decl(&mut v, decl);
        }
        if let Some(generics) = node.generics() {
            intravisit::walk_generics(&mut v, generics);
        }
    }

    // Optional def catalog: `file:line -> DefKind` for every local def, so a
    // node-space analysis can classify each reference target (field/variant/
    // type-alias = Layer 2's structural domain, vs a genuine reference gap).
    if let Ok(dir) = std::env::var("BG_DRIVER_DEFS") {
        use std::io::Write;
        let _ = std::fs::create_dir_all(&dir);
        let path = format!("{dir}/{}.tsv", unit_key(tcx, &krate.to_string()));
        if let Ok(mut f) = std::fs::File::create(&path) {
            let mut buf = String::new();
            for did in tcx.hir_crate_items(()).definitions() {
                if let Some((file, line)) = loc_of(tcx, did.to_def_id()) {
                    if !file.starts_with('/') {
                        buf.push_str(&format!(
                            "{file}:{line}\t{:?}\t{}\n",
                            tcx.def_kind(did),
                            tcx.def_path_str(did.to_def_id())
                        ));
                    }
                }
            }
            let _ = f.write_all(buf.as_bytes());
        }
    }

    if want_edges {
        // BG_DRIVER_EDGES is a *directory*: each (parallel) rustc process writes
        // its own file, so concurrent compiles can't tear each other's lines.
        if let Ok(dir) = std::env::var("BG_DRIVER_EDGES") {
            use std::io::Write;
            let _ = std::fs::create_dir_all(&dir);
            let path = format!("{dir}/{}.tsv", unit_key(tcx, &krate.to_string()));
            if let Ok(mut f) = std::fs::File::create(&path) {
                let mut buf = String::new();
                for (kind, caller, callee) in &edges {
                    buf.push_str(&format!("{kind}\t{caller}\t{callee}\n"));
                }
                let _ = f.write_all(buf.as_bytes());
            }
        }
    }

    eprintln!(
        "[bg-driver] crate `{krate}`: {} call edges ({} method, {} cross-crate), {} use edges",
        calls + method_calls,
        method_calls,
        cross_crate,
        uses_count
    );
    // A real run appends one line here; cargo's replayed-stderr cache can't fake a
    // file write, so this is the honest "the driver actually executed" signal.
    if let Ok(path) = std::env::var("BG_DRIVER_LOG") {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(f, "{krate} {} calls", calls + method_calls);
        }
    }
    for s in samples.iter().take(12) {
        eprintln!("[bg-driver]   {s}");
    }
}

struct CallVisitor<'a, 'tcx> {
    tcx: TyCtxt<'tcx>,
    typeck: &'tcx TypeckResults<'tcx>,
    owner_did: DefId,
    owner: String,
    owner_loc: Option<String>,
    calls: &'a mut usize,
    method_calls: &'a mut usize,
    cross_crate: &'a mut usize,
    uses_count: &'a mut usize,
    samples: &'a mut Vec<String>,
    edges: &'a mut Vec<(&'static str, String, String)>,
}

impl<'a, 'tcx> CallVisitor<'a, 'tcx> {
    fn record(&mut self, kind: &'static str, callee: DefId) {
        if callee.krate != LOCAL_CRATE {
            *self.cross_crate += 1;
        }
        if let Some(caller) = self.owner_loc.clone() {
            if let Some((f, l)) = loc_of(self.tcx, callee) {
                // Keep only workspace↔workspace edges (drop std `/rustc/…` and
                // dep absolute paths) — matches build-graph's reference layer and
                // keeps the dump comparable to scip's.
                if !f.starts_with('/') {
                    self.edges.push((kind, caller, format!("{f}:{l}")));
                }
            }
        }
    }

    fn call(&mut self, callee: DefId, method: bool) {
        if method {
            *self.method_calls += 1;
        } else {
            *self.calls += 1;
        }
        if self.samples.len() < 12 {
            let kind = if method { "m" } else { "f" };
            self.samples.push(format!(
                "[{kind}] {} -> {}",
                self.owner,
                self.tcx.def_path_str(callee)
            ));
        }
        self.record("call", callee);
    }

    fn use_def(&mut self, callee: DefId) {
        *self.uses_count += 1;
        self.record("use", callee);
    }

    /// For a method call, resolve to the *concrete impl* method when the receiver
    /// is monomorphizable (matching rust-analyzer, which records the impl). For a
    /// generic/dyn receiver this can't be done, so fall back to the trait method.
    fn method_target(&self, trait_method: DefId, hir_id: HirId) -> DefId {
        let args = self.typeck.node_args(hir_id);
        let env = ty::TypingEnv::post_analysis(self.tcx, self.owner_did);
        match ty::Instance::try_resolve(self.tcx, env, trait_method, args) {
            Ok(Some(inst)) => inst.def_id(),
            _ => trait_method,
        }
    }

    /// A `uses` target from a path resolution: types, consts, statics, fields,
    /// variants, etc. — but NOT fns/ctors (those are `calls`, handled separately,
    /// and re-counting their path expr would double-count).
    fn use_from_res(&mut self, res: Res) {
        if let Res::Def(kind, def_id) = res {
            let is_use = matches!(
                kind,
                DefKind::Struct
                    | DefKind::Enum
                    | DefKind::Union
                    | DefKind::Trait
                    | DefKind::TyAlias
                    | DefKind::AssocTy
                    | DefKind::TraitAlias
                    | DefKind::ForeignTy
                    | DefKind::Const
                    | DefKind::AssocConst
                    | DefKind::Static { .. }
                    | DefKind::Field
                    | DefKind::Variant
            );
            if is_use {
                self.use_def(def_id);
            }
        }
    }
}

impl<'a, 'tcx> Visitor<'tcx> for CallVisitor<'a, 'tcx> {
    fn visit_expr(&mut self, ex: &'tcx Expr<'tcx>) {
        // Skip references in macro-expanded code: rust-analyzer's SCIP works on
        // source tokens, so it doesn't emit occurrences for derive/`?`-desugar
        // generated calls. User code spliced into a macro arg keeps its own span.
        if !ex.span.from_expansion() {
            match ex.kind {
                ExprKind::Call(callee, _args) => {
                    if let ExprKind::Path(ref qpath) = callee.kind {
                        if let Res::Def(dk, def_id) = self.typeck.qpath_res(qpath, callee.hir_id) {
                            // tuple-struct/variant construction: rustc says "call",
                            // SCIP says "use" — match SCIP.
                            if matches!(dk, DefKind::Ctor(..)) {
                                self.use_def(def_id);
                            } else {
                                self.call(def_id, false);
                            }
                        }
                    }
                }
                ExprKind::MethodCall(..) => {
                    if let Some(def_id) = self.typeck.type_dependent_def_id(ex.hir_id) {
                        let target = self.method_target(def_id, ex.hir_id);
                        self.call(target, true);
                    }
                }
                // value paths to consts/statics/variants used as values → use
                ExprKind::Path(ref qpath) => {
                    self.use_from_res(self.typeck.qpath_res(qpath, ex.hir_id));
                }
                // struct/enum-variant literal → use of the type/variant
                ExprKind::Struct(qpath, ..) => {
                    self.use_from_res(self.typeck.qpath_res(qpath, ex.hir_id));
                }
                // field access → use of the field def
                ExprKind::Field(recv, _) => {
                    let ty = self.typeck.expr_ty_adjusted(recv);
                    if let ty::Adt(adt, _) = ty.kind() {
                        if adt.is_struct() || adt.is_union() {
                            let idx = self.typeck.field_index(ex.hir_id);
                            if let Some(field) = adt.non_enum_variant().fields.get(idx) {
                                self.use_def(field.did);
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        intravisit::walk_expr(self, ex);
    }

    fn visit_ty(&mut self, t: &'tcx Ty<'tcx, AmbigArg>) {
        if !t.span.from_expansion() {
            if let TyKind::Path(QPath::Resolved(_, path)) = t.kind {
                self.use_from_res(path.res);
            }
        }
        intravisit::walk_ty(self, t);
    }

    fn visit_pat(&mut self, p: &'tcx Pat<'tcx>) {
        if !p.span.from_expansion() {
            match p.kind {
                PatKind::TupleStruct(ref qpath, ..) | PatKind::Struct(ref qpath, ..) => {
                    self.use_from_res(self.typeck.qpath_res(qpath, p.hir_id));
                }
                _ => {}
            }
        }
        intravisit::walk_pat(self, p);
    }
}

fn is_rustc(arg: &str) -> bool {
    std::path::Path::new(arg)
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s == "rustc")
        .unwrap_or(false)
}

fn print_sysroot(rustc: &str) -> Option<String> {
    let out = std::process::Command::new(rustc)
        .args(["--print", "sysroot"])
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn main() -> std::process::ExitCode {
    let mut args: Vec<String> = std::env::args().collect();

    // As RUSTC_WORKSPACE_WRAPPER, cargo calls us `bg-driver <rustc> <args…>`.
    // Drop the rustc path; we *are* the compiler. Use it to learn the sysroot,
    // since our binary lives outside the toolchain and can't infer it.
    let mut sysroot = None;
    if args.len() > 1 && is_rustc(&args[1]) {
        let rustc = args.remove(1);
        sysroot = print_sysroot(&rustc);
    }
    if let Some(sr) = sysroot {
        if !args.iter().any(|a| a == "--sysroot" || a.starts_with("--sysroot=")) {
            args.push("--sysroot".into());
            args.push(sr);
        }
    }

    rustc_driver::catch_with_exit_code(|| {
        rustc_driver::run_compiler(&args, &mut BgCallbacks);
        Ok::<(), rustc_span::ErrorGuaranteed>(())
    })
}
