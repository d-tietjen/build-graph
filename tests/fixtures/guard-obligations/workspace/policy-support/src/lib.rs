//! Generic declarative policy fixture. Compile/capture only; never execute.
#[inline(never)]
pub fn check(principal: u64, tenant: u64, object: u64, value: u64) -> bool {
    ((principal ^ tenant) | (object ^ value)) != 0
}
#[inline(never)]
pub fn effect(_principal: u64, _tenant: u64, _object: u64, value: u64) -> u64 { value }
#[inline(never)]
pub fn identity(value: u64) -> u64 { value }
#[inline(never)]
pub fn invoke(check: fn(u64, u64, u64, u64) -> bool, p: u64, t: u64, o: u64, v: u64) -> bool {
    check(p, t, o, v)
}
#[inline(never)]
pub fn forward(check: fn(u64, u64, u64, u64) -> bool, p: u64, t: u64, o: u64, v: u64) -> bool {
    invoke(check, p, t, o, v)
}
