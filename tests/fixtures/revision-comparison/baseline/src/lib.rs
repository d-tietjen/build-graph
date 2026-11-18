//! Controlled local compiler input. Test models declare the operation meanings.
#[inline(never)]
pub fn check(value: u64) -> bool {
    value < 64
}
#[inline(never)]
pub fn effect(value: u64) -> u64 {
    value
}
#[inline(never)]
pub fn acquire(value: u64) -> u64 {
    value
}
#[inline(never)]
pub fn release(value: u64) -> u64 {
    value
}
#[inline(never)]
pub fn guarded(value: u64) -> u64 {
    if check(value) { effect(value) } else { 0 }
}
pub fn cleanup(value: u64) -> u64 {
    let handle = acquire(value);
    release(handle)
}
pub fn write_entry(value: u64) -> u64 {
    effect(value)
}
pub fn renamed_before(value: u64) -> u64 {
    value
}
