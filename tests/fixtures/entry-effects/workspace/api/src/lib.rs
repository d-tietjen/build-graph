pub fn library_action() { effect_dependency::read_input(); }

pub struct UnusedPublic;
impl UnusedPublic {
    pub fn unused_method(&self) { let _ = ::std::fs::write("unused", b"unreached"); }
}

mod private {
    pub fn public_in_private_module() { let _ = ::std::fs::remove_file("unused"); }
    pub fn publicly_reexported() { let _ = ::std::env::var_os("REEXPORTED"); }
}
pub use private::publicly_reexported as exposed_alias;

#[no_mangle]
pub extern "C" fn exported_service_entry() { library_action(); }

extern "C" { pub fn unknown_native_boundary(); }

// This callable is deliberately uninvoked. Its imported native declaration
// must remain an unknown outgoing boundary, never a confirmed incoming entry.
pub unsafe fn call_unknown_native() { unsafe { unknown_native_boundary(); } }

// A full standard-like application namespace must never acquire a builtin effect.
#[allow(dead_code)]
pub mod std { pub mod fs { pub fn read_to_string() {} } }

pub trait PublicEffect { fn activate(&self); }
struct PrivateEffect;
impl PublicEffect for PrivateEffect {
    fn activate(&self) { let _ = ::std::fs::write("trait-object", b"unreached"); }
}
pub fn public_effect_factory() -> Box<dyn PublicEffect> { Box::new(PrivateEffect) }
fn internal_trait_caller() { PrivateEffect.activate(); }
