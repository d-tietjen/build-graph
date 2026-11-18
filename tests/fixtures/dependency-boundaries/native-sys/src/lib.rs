unsafe extern "C" {
    #[link_name = "boundary_c_entry"]
    fn differently_named_rust_declaration(value: i32) -> i32;
}

pub fn rust_side_increment(value: i32) -> i32 {
    value + 1
}

pub fn invoke_native(value: i32) -> i32 {
    unsafe { differently_named_rust_declaration(value) }
}
