use std::{env, fs, path::PathBuf, process::Command};

fn main() {
    shared::probe();
    shared::invoke(host_only);
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo OUT_DIR"));
    fs::write(out.join("generated.rs"), "pub fn generated_value() -> u32 { 17 }\n").unwrap();
    let object = out.join("value.o");
    let archive = out.join("libfixture_native.a");
    assert!(Command::new("cc").args(["-c", "native/value.c", "-o"]).arg(&object).status().unwrap().success());
    assert!(Command::new("ar").arg("crs").arg(&archive).arg(&object).status().unwrap().success());
    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=static=fixture_native");
    // A system link directive has no known build-script writer.
    println!("cargo:rustc-link-lib=c");
    println!("cargo:rustc-env=FIXTURE_BUILD_DECLARATION=controlled-fixture-value");
    println!("cargo:rerun-if-changed=native/value.c");
}

fn host_only() { let _ = env::var_os("BUILD_SUPPLY_HOST_CALLBACK"); }
