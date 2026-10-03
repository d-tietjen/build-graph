//! Actual effective cfg/backend feature state of this same analysed Session.
use crate::compiler_context::*;
use crate::compiler_semantic::{SemanticGap, SemanticTarget};
use crate::semantic::{ObservedRowBudget, Writer};
use rustc_hir::CRATE_HIR_ID;
use rustc_middle::ty::TyCtxt;

pub(super) fn observe(tcx: TyCtxt<'_>, writer: &mut Writer) {
    let mut make = || -> Option<CompilerContextObservation> {
        let mut row = ObservedRowBudget::new::<CompilerContextObservation>(writer)?;
        let value = CompilerContextObservation {
            provenance: CompilerContextProvenance::RustcSessionAfterAnalysis,
            rustc_version: row.text(tcx.sess.cfg_version, MAX_CONTEXT_TEXT, false)?,
            target_llvm: row.text(&tcx.sess.target.llvm_target, MAX_CONTEXT_TEXT, false)?,
            target_arch: row.text(tcx.sess.target.arch.desc(), MAX_CONTEXT_TEXT, false)?,
            cfg_entries: tcx.sess.psess.config.len() as u64,
            stable_target_feature_entries: tcx.sess.target_features.len() as u64,
            all_target_feature_entries: tcx.sess.unstable_target_features.len() as u64,
        };
        value.validate().ok()?;
        Some(value)
    };
    let Some(context) = make() else {
        writer.unsupported_observation(SemanticGap::CompilerContextUnavailable);
        return;
    };
    writer.observed_reference(
        CRATE_HIR_ID,
        "compiler_context",
        SemanticTarget::CompilerContext {
            context: Box::new(context),
        },
        None,
    );
    // Borrow original FxIndexSet order. No clone, sort, helper compiler, argv
    // reconstruction or all-set allocation occurs in this observation pass.
    for (ordinal, (name, value)) in tcx.sess.psess.config.iter().enumerate() {
        let mut make = || -> Option<EffectiveCfgObservation> {
            let mut row = ObservedRowBudget::new::<EffectiveCfgObservation>(writer)?;
            let value = EffectiveCfgObservation {
                ordinal: ordinal as u64,
                name: row.text(name.as_str(), MAX_CONTEXT_TEXT, false)?,
                value: match value {
                    Some(value) => Some(row.text(value.as_str(), MAX_CONTEXT_TEXT, true)?),
                    None => None,
                },
            };
            value.validate().ok()?;
            Some(value)
        };
        let Some(cfg) = make() else {
            writer.unsupported_observation(SemanticGap::CompilerContextUnsupportedValue);
            return;
        };
        writer.observed_reference(
            CRATE_HIR_ID,
            "effective_cfg",
            SemanticTarget::EffectiveCfg { cfg: Box::new(cfg) },
            None,
        );
    }
    for (inventory, features) in [
        (TargetFeatureInventory::Stable, &tcx.sess.target_features),
        (
            TargetFeatureInventory::IncludingUnstable,
            &tcx.sess.unstable_target_features,
        ),
    ] {
        for (ordinal, feature) in features.iter().enumerate() {
            let mut make = || -> Option<TargetFeatureObservation> {
                let mut row = ObservedRowBudget::new::<TargetFeatureObservation>(writer)?;
                Some(TargetFeatureObservation {
                    inventory,
                    ordinal: ordinal as u64,
                    name: row.text(feature.as_str(), MAX_CONTEXT_TEXT, false)?,
                })
            };
            let Some(feature) = make() else {
                writer.unsupported_observation(SemanticGap::CompilerContextUnsupportedValue);
                return;
            };
            writer.observed_reference(
                CRATE_HIR_ID,
                "target_feature",
                SemanticTarget::TargetFeature {
                    feature: Box::new(feature),
                },
                None,
            );
        }
    }
}
