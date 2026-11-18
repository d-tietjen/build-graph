//! Paired candidate. Compiled for evidence; never executed by validation.
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
    let _ignored = check(value);
    effect(value)
}
pub fn cleanup(value: u64) -> u64 {
    acquire(value)
}
pub fn write_entry(value: u64) -> u64 {
    let _ = std::fs::write("never-executed", b"data");
    effect(value)
}
pub fn added_entry(value: u64) -> u64 {
    effect(value)
}
pub fn renamed_after(value: u64) -> u64 {
    value
}
