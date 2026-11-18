#[no_mangle]
pub extern "C" fn rust_boundary_callback(value: i32) -> i32 {
    value + 7
}

fn main() {
    let older = common_v1::compute(3);
    let newer = common_v2::compute(4);
    let native = native_sys::invoke_native(older + newer);
    assert_eq!(native, rust_boundary_callback(older + newer + 11));
}
