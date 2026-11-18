//! Compiler-only fixture. Protocol meaning is supplied separately by exact IDs.
#![allow(dead_code)]

#[inline(never)]
pub fn acquire(object: u64) -> u64 {
    object
}
#[inline(never)]
pub fn release(object: u64) -> u64 {
    object
}
#[inline(never)]
pub fn begin(object: u64) -> u64 {
    object
}
#[inline(never)]
pub fn update(object: u64) -> u64 {
    object
}
#[inline(never)]
pub fn rollback(object: u64) -> u64 {
    object
}
#[inline(never)]
pub fn commit(object: u64) -> u64 {
    object
}
#[inline(never)]
pub fn apply(object: u64) -> u64 {
    object
}

pub fn early_error(object: u64, fail: bool) -> u64 {
    let object = acquire(object);
    if fail {
        return object;
    }
    release(object)
}
pub fn proper_cleanup(object: u64, fail: bool) -> u64 {
    let object = acquire(object);
    if fail {
        return release(object);
    }
    release(object)
}
pub fn partial_update(object: u64, fail: bool) -> u64 {
    let object = update(begin(object));
    if fail {
        return object;
    }
    commit(object)
}
pub fn proper_rollback(object: u64, fail: bool) -> u64 {
    let object = update(begin(object));
    if fail {
        return rollback(object);
    }
    commit(object)
}
pub fn retry_duplicate(object: u64) -> u64 {
    apply(apply(object))
}
pub fn loop_retry(mut object: u64, repeat: bool) -> u64 {
    loop {
        object = apply(object);
        if !repeat {
            return object;
        }
    }
}
pub fn retry_once(object: u64) -> u64 {
    apply(object)
}
pub fn copied_cleanup(object: u64) -> u64 {
    let held = acquire(object);
    let copied = held;
    release(copied)
}
#[inline(never)]
fn cleanup_forward(object: u64) -> u64 {
    release(object)
}
pub fn cross_call_cleanup(object: u64) -> u64 {
    cleanup_forward(acquire(object))
}
pub fn field_cleanup(pair: (u64, u64)) -> u64 {
    let object = acquire(pair.0);
    release(object)
}
// These compiler-generated reference/drop/external paths intentionally stay unknown.
struct Cleanup(u64);
impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = release(self.0);
    }
}
#[inline(never)]
pub fn may_unwind(fail: bool) {
    if fail {
        panic!("controlled fixture");
    }
}
pub fn unwind_cleanup(object: u64, fail: bool) {
    let _cleanup = Cleanup(acquire(object));
    may_unwind(fail);
}
pub async fn suspend_cleanup(object: u64) -> u64 {
    let object = acquire(object);
    std::future::pending::<()>().await;
    release(object)
}
unsafe extern "C" {
    fn unavailable_operation(object: u64) -> u64;
}
pub unsafe fn unavailable_external(object: u64) -> u64 {
    let object = acquire(object);
    unsafe { unavailable_operation(object) }
}
