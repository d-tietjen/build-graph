include!(concat!(env!("OUT_DIR"), "/generated.rs"));
fixture_macros::emit_fixture!();

unsafe extern "C" { fn fixture_native_value() -> u32; }
fn main() {
    shared::probe();
    shared::invoke(target_only);
    let _ = (generated_value(), expanded_value(), duplicate_one::version());
    #[cfg(unix)]
    let _ = duplicate_two::version();
    let _ = unsafe { fixture_native_value() };
}

fn target_only() { let _ = std::env::var_os("BUILD_SUPPLY_TARGET_CALLBACK"); }
