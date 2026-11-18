use proc_macro::TokenStream;

#[proc_macro]
pub fn emit_fixture(_: TokenStream) -> TokenStream {
    let _ = std::env::var_os("BUILD_SUPPLY_FIXTURE_MACRO");
    "pub fn expanded_value() -> u32 { 19 }".parse().unwrap()
}
