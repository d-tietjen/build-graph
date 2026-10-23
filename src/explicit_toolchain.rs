//! Explicit observational tool selections without tool-discovery subprocesses.

use std::path::{Component, Path, PathBuf};

use anyhow::{Result, bail};

use crate::CommonArgs;

pub struct ExplicitToolchain {
    pub cargo: PathBuf,
    pub rustc: PathBuf,
    pub rustdoc: PathBuf,
    pub sysroot: PathBuf,
}

impl ExplicitToolchain {
    pub fn selected(common: &CommonArgs) -> Result<Option<Self>> {
        if common.occurrence_rustc.is_none()
            && common.occurrence_rustdoc.is_none()
            && common.occurrence_sysroot.is_none()
        {
            return Ok(None);
        }
        let (Some(cargo), Some(rustc), Some(rustdoc), Some(sysroot), Some(driver)) = (
            common.occurrence_cargo.as_deref(),
            common.occurrence_rustc.as_deref(),
            common.occurrence_rustdoc.as_deref(),
            common.occurrence_sysroot.as_deref(),
            common.driver_bin.as_deref(),
        ) else {
            bail!(
                "explicit occurrence tools require Cargo, rustc, rustdoc, sysroot and a prebuilt driver"
            );
        };
        if !common.observe_compiler_inputs || !common.observe_definition_occurrences {
            bail!("explicit occurrence tools require actual compiler occurrence capture");
        }
        for tool in [cargo, rustc, rustdoc, driver] {
            let path = Path::new(tool);
            validate_path(path)?;
            let metadata = path.metadata()?;
            if !metadata.is_file() {
                bail!("explicit occurrence tool must be a regular executable file");
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if metadata.permissions().mode() & 0o111 == 0 {
                    bail!("explicit occurrence tool is not executable");
                }
            }
        }
        let sysroot = PathBuf::from(sysroot);
        validate_path(&sysroot)?;
        if !sysroot.is_dir() || !sysroot.join("lib").is_dir() {
            bail!("explicit occurrence sysroot requires an existing lib directory");
        }
        Ok(Some(Self {
            cargo: cargo.into(),
            rustc: rustc.into(),
            rustdoc: rustdoc.into(),
            sysroot,
        }))
    }
}

pub fn validate_path(path: &Path) -> Result<()> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
        || path.as_os_str().as_encoded_bytes().is_empty()
        || path.as_os_str().as_encoded_bytes().len()
            > build_graph::compiler_invocation::MAX_TEXT_BYTES
        || path
            .as_os_str()
            .as_encoded_bytes()
            .iter()
            .any(|byte| *byte < 32)
    {
        bail!(
            "explicit occurrence paths must be bounded absolute paths without control bytes or parent traversal"
        );
    }
    Ok(())
}

#[cfg(test)]
#[path = "explicit_toolchain_tests.rs"]
mod tests;
