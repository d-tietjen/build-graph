//! Compiler-owned generated harness observations, without execution authority.
use crate::compiler_semantic::bounded_list;
use serde::{Deserialize, Serialize};

pub const MAX_HARNESS_TEXT: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompilerDefinitionObservation {
    pub crate_name: String,
    /// Fixed-width hexadecimal of the compiler stable crate identifier.
    pub stable_crate_id: String,
    /// Fixed-width hexadecimal of the actual compiler Svh numeric value.
    pub crate_hash: String,
    /// Hex of Fingerprint::to_le_bytes(), including leading zero bytes.
    pub def_path_hash: String,
    pub definition_index: u32,
    pub compiler_path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompilerSysrootMemberKind {
    Rlib,
    Rmeta,
    Dylib,
    Interface,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompilerSysrootMemberObservation {
    pub kind: CompilerSysrootMemberKind,
    pub relative: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompilerTestCrateObservation {
    pub crate_name: String,
    pub stable_crate_id: String,
    pub crate_hash: String,
    #[serde(deserialize_with = "bounded_list::<_, _, 4>")]
    pub members: Vec<CompilerSysrootMemberObservation>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TestHarnessOrigin {
    RustcTestHarness,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TestHarnessEntryObservation {
    pub entry: CompilerDefinitionObservation,
    pub origin: TestHarnessOrigin,
    pub runner: CompilerDefinitionObservation,
    pub descriptor_type: CompilerDefinitionObservation,
    pub test_crate: CompilerTestCrateObservation,
    pub table_entries: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TestDescriptorKind {
    Test,
    Bench,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum TestPanicExpectation {
    No,
    Yes,
    Message { value: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompilerTestType {
    Unit,
    Integration,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TestDescriptorObservation {
    pub table_ordinal: u64,
    pub constant: CompilerDefinitionObservation,
    pub descriptor_type: CompilerDefinitionObservation,
    pub name: String,
    pub kind: TestDescriptorKind,
    pub ignore: bool,
    pub ignore_message: Option<String>,
    pub compile_fail: bool,
    pub no_run: bool,
    pub should_panic: TestPanicExpectation,
    pub test_type: CompilerTestType,
    pub source_file: String,
    pub start_line: u64,
    pub start_column: u64,
    pub end_line: u64,
    pub end_column: u64,
    pub closure: CompilerDefinitionObservation,
    pub function: CompilerDefinitionObservation,
    pub assertion_wrapper: CompilerDefinitionObservation,
    pub name_constructor: CompilerDefinitionObservation,
    pub function_constructor: CompilerDefinitionObservation,
    pub panic_variant: CompilerDefinitionObservation,
    pub test_type_variant: CompilerDefinitionObservation,
}

fn text(value: &str, empty: bool) -> bool {
    (empty || !value.is_empty()) && value.len() <= MAX_HARNESS_TEXT && !value.contains('\0')
}
fn hex(value: &str, size: usize) -> bool {
    value.len() == size
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
impl CompilerDefinitionObservation {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !text(&self.crate_name, false)
            || !hex(&self.stable_crate_id, 16)
            || !hex(&self.crate_hash, 32)
            || !hex(&self.def_path_hash, 32)
            || self.compiler_path.is_empty()
            || self.compiler_path.len() > 1024
            || self.compiler_path.contains(['\0', '\n', '\r', '/', '\\'])
        {
            return Err("invalid compiler definition observation");
        }
        Ok(())
    }
    pub fn same_crate(&self, other: &Self) -> bool {
        self.crate_name == other.crate_name
            && self.stable_crate_id == other.stable_crate_id
            && self.crate_hash == other.crate_hash
    }
}
impl CompilerTestCrateObservation {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !text(&self.crate_name, false)
            || !hex(&self.stable_crate_id, 16)
            || !hex(&self.crate_hash, 32)
            || self.members.is_empty()
            || self.members.len() > 4
        {
            return Err("invalid used compiler test crate");
        }
        for (index, member) in self.members.iter().enumerate() {
            if !text(&member.relative, false)
                || member.relative.starts_with('/')
                || member.relative.contains(['\\', ':'])
                || member
                    .relative
                    .split('/')
                    .any(|part| part.is_empty() || part == "." || part == "..")
                || self.members[..index]
                    .iter()
                    .any(|old| old.kind == member.kind)
            {
                return Err("invalid used sysroot member");
            }
        }
        Ok(())
    }
}
impl TestHarnessEntryObservation {
    pub fn validate(&self) -> Result<(), &'static str> {
        self.entry.validate()?;
        self.runner.validate()?;
        self.descriptor_type.validate()?;
        self.test_crate.validate()?;
        if !self.runner.same_crate(&self.descriptor_type)
            || self.runner.crate_name != self.test_crate.crate_name
            || self.runner.stable_crate_id != self.test_crate.stable_crate_id
            || self.runner.crate_hash != self.test_crate.crate_hash
            || self.table_entries > crate::compiler_semantic::MAX_TRAVERSAL_WORK
        {
            return Err("inconsistent observed harness entry");
        }
        Ok(())
    }
}
impl TestDescriptorObservation {
    pub fn validate(&self) -> Result<(), &'static str> {
        for definition in [
            &self.constant,
            &self.descriptor_type,
            &self.closure,
            &self.function,
            &self.assertion_wrapper,
            &self.name_constructor,
            &self.function_constructor,
            &self.panic_variant,
            &self.test_type_variant,
        ] {
            definition.validate()?;
        }
        if !self.constant.same_crate(&self.function)
            || !self.constant.same_crate(&self.closure)
            || [
                &self.assertion_wrapper,
                &self.name_constructor,
                &self.function_constructor,
                &self.panic_variant,
                &self.test_type_variant,
            ]
            .iter()
            .any(|definition| !self.descriptor_type.same_crate(definition))
            || !text(&self.name, false)
            || !text(&self.source_file, false)
            || self
                .ignore_message
                .as_ref()
                .is_some_and(|value| !text(value, true))
            || matches!(&self.should_panic, TestPanicExpectation::Message { value } if !text(value, true))
            || self.start_line == 0
            || (self.start_line, self.start_column) > (self.end_line, self.end_column)
        {
            return Err("inconsistent observed test descriptor");
        }
        Ok(())
    }
}
