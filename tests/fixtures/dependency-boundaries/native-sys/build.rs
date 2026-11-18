use std::env;
use std::path::PathBuf;
use std::process::Command;

fn run(tool: &str, args: &[&str]) {
    let status = Command::new(tool).args(args).status().expect("native build tool available");
    assert!(status.success(), "{tool} failed: {status}");
}

fn main() {
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR"));
    let object = out.join("boundary.o");
    let archive = out.join("libboundary_native.a");
    let object = object.to_str().expect("UTF-8 object path");
    let archive = archive.to_str().expect("UTF-8 archive path");
    let compiler = env::var("CC").unwrap_or_else(|_| "cc".into());
    let archiver = env::var("AR").unwrap_or_else(|_| "ar".into());
    run(&compiler, &["-c", "-O0", "-o", object, "native/boundary.c"]);
    run(&archiver, &["crs", archive, object]);
    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=static=boundary_native");
    println!("cargo:rerun-if-changed=native/boundary.c");
}
