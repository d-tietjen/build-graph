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
use rustc_hir::def::Res;
use rustc_hir::intravisit::{self, Visitor};
use rustc_hir::{Expr, ExprKind};
use rustc_interface::interface::Compiler;
use rustc_middle::ty::{TyCtxt, TypeckResults};
use rustc_span::def_id::LOCAL_CRATE;

struct BgCallbacks;

impl Callbacks for BgCallbacks {
    fn after_analysis<'tcx>(&mut self, _compiler: &Compiler, tcx: TyCtxt<'tcx>) -> Compilation {
        extract(tcx);
        Compilation::Continue
    }
}

/// `file:line` of a def's span, or `None` for dummy/macro spans.
fn loc_of(tcx: TyCtxt<'_>, def_id: rustc_span::def_id::DefId) -> Option<(String, usize)> {
    let span = tcx.def_span(def_id);
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
    let mut samples: Vec<String> = Vec::new();
    // Full edge dump (for equivalence checking against rust-analyzer scip):
    // (caller "file:line", callee "file:line"). Only collected when requested.
    let want_edges = std::env::var_os("BG_DRIVER_EDGES").is_some();
    let mut edges: Vec<(String, String)> = Vec::new();

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
            owner: owner_path,
            owner_loc,
            calls: &mut calls,
            method_calls: &mut method_calls,
            cross_crate: &mut cross_crate,
            samples: &mut samples,
            edges: &mut edges,
        };
        v.visit_expr(body.value);
    }

    if want_edges {
        if let Ok(path) = std::env::var("BG_DRIVER_EDGES") {
            use std::io::Write;
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
                for (c, callee) in &edges {
                    let _ = writeln!(f, "call\t{c}\t{callee}");
                }
            }
        }
    }

    eprintln!(
        "[bg-driver] crate `{krate}`: {} call edges ({} method, {} cross-crate)",
        calls + method_calls,
        method_calls,
        cross_crate
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
    owner: String,
    owner_loc: Option<String>,
    calls: &'a mut usize,
    method_calls: &'a mut usize,
    cross_crate: &'a mut usize,
    samples: &'a mut Vec<String>,
    edges: &'a mut Vec<(String, String)>,
}

impl<'a, 'tcx> CallVisitor<'a, 'tcx> {
    fn emit(&mut self, callee: rustc_span::def_id::DefId, method: bool) {
        if method {
            *self.method_calls += 1;
        } else {
            *self.calls += 1;
        }
        if callee.krate != LOCAL_CRATE {
            *self.cross_crate += 1;
        }
        if self.samples.len() < 12 {
            let kind = if method { "m" } else { "f" };
            self.samples.push(format!(
                "[{kind}] {} -> {}",
                self.owner,
                self.tcx.def_path_str(callee)
            ));
        }
        if let Some(caller) = self.owner_loc.clone() {
            if let Some((f, l)) = loc_of(self.tcx, callee) {
                self.edges.push((caller, format!("{f}:{l}")));
            }
        }
    }
}

impl<'a, 'tcx> Visitor<'tcx> for CallVisitor<'a, 'tcx> {
    fn visit_expr(&mut self, ex: &'tcx Expr<'tcx>) {
        match ex.kind {
            ExprKind::Call(callee, _args) => {
                if let ExprKind::Path(ref qpath) = callee.kind {
                    if let Res::Def(_dk, def_id) = self.typeck.qpath_res(qpath, callee.hir_id) {
                        self.emit(def_id, false);
                    }
                }
            }
            ExprKind::MethodCall(..) => {
                if let Some(def_id) = self.typeck.type_dependent_def_id(ex.hir_id) {
                    self.emit(def_id, true);
                }
            }
            _ => {}
        }
        intravisit::walk_expr(self, ex);
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
