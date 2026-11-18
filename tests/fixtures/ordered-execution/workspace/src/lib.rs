//! Tiny compiler-only ordered-path fixture. Never execute this application.
#[inline(never)]
pub fn source() -> usize { 7 }
#[inline(never)]
pub fn sink(value: usize) -> usize { value }
#[inline(never)]
pub fn guard() -> usize { 0 }
#[inline(never)]
pub fn identity<T: Copy>(value: T) -> T { value }
#[inline(never)]
pub fn ordered() -> usize { sink(identity(source())) }
#[inline(never)]
pub fn reversed() -> usize { let value = sink(0); let _ = source(); value }
#[inline(never)]
pub fn exclusive(flag: bool) -> usize { if flag { source() } else { sink(0) } }
#[inline(never)]
pub fn invoke<F: FnMut() -> usize>(mut callback: F) -> usize { callback() }
#[inline(never)]
pub fn callback_route() -> usize { let value = invoke(source); sink(value) }
#[inline(never)]
pub fn repeated(mut count: usize) -> usize {
    while count != 0 { let _ = source(); count = count.wrapping_sub(1); }
    sink(0)
}
#[inline(never)]
pub fn guarded() -> usize { let _ = guard(); ordered() }
