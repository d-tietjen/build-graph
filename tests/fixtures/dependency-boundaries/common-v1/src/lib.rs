pub fn compute(value: i32) -> i32 {
    native_sys::rust_side_increment(value)
}
