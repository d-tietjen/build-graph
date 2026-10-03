//! Bounded observations of the actual compiler Session after analysis.
//! These rows describe compiler state; they confer no input or execution rights.
use serde::{Deserialize, Serialize};

pub const MAX_CONTEXT_TEXT: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompilerContextProvenance {
    RustcSessionAfterAnalysis,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompilerContextObservation {
    pub provenance: CompilerContextProvenance,
    pub rustc_version: String,
    pub target_llvm: String,
    pub target_arch: String,
    pub cfg_entries: u64,
    pub stable_target_feature_entries: u64,
    pub all_target_feature_entries: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EffectiveCfgObservation {
    pub ordinal: u64,
    pub name: String,
    pub value: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TargetFeatureInventory {
    Stable,
    IncludingUnstable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TargetFeatureObservation {
    pub inventory: TargetFeatureInventory,
    pub ordinal: u64,
    pub name: String,
}

fn text(value: &str, empty: bool) -> bool {
    (empty || !value.is_empty()) && value.len() <= MAX_CONTEXT_TEXT && !value.contains('\0')
}
impl CompilerContextObservation {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !text(&self.rustc_version, false)
            || !text(&self.target_llvm, false)
            || !text(&self.target_arch, false)
            || self.cfg_entries > crate::compiler_semantic::MAX_TRAVERSAL_WORK
            || self.stable_target_feature_entries > crate::compiler_semantic::MAX_TRAVERSAL_WORK
            || self.all_target_feature_entries > crate::compiler_semantic::MAX_TRAVERSAL_WORK
        {
            return Err("invalid compiler Session observation");
        }
        Ok(())
    }
}
impl EffectiveCfgObservation {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !text(&self.name, false) || self.value.as_ref().is_some_and(|value| !text(value, true)) {
            return Err("invalid effective cfg observation");
        }
        Ok(())
    }
}
impl TargetFeatureObservation {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !text(&self.name, false) {
            return Err("invalid target feature observation");
        }
        Ok(())
    }
}
