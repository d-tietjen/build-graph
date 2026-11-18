//! Compile/capture only. The validation recipe never executes this application.
#[derive(Clone, Copy)]
pub struct Pair { pub first: u64, pub second: u64 }

#[inline(never)]
pub fn input() -> u64 { 7 }
#[inline(never)]
pub fn sensitive(value: u64) -> u64 { value }
#[inline(never)]
pub fn identity(value: u64) -> u64 { value }

pub fn positive() -> u64 { sensitive(value_dependency::relay(input(), 0)) }
pub fn swapped() -> u64 { sensitive(value_dependency::relay(0, input())) }
pub fn cross_fields() -> u64 { sensitive(value_dependency::first((input(), 0))) }
pub fn cross_fields_clean() -> u64 { sensitive(value_dependency::first((0, input()))) }
pub fn fields() -> u64 {
    let pair = Pair { first: input(), second: 0 };
    sensitive(pair.second)
}
pub fn field_positive() -> u64 {
    let pair = Pair { first: input(), second: 0 };
    sensitive(pair.first)
}
pub fn references() -> u64 {
    let value = input();
    let reference = &value;
    sensitive(*reference)
}
pub fn reference_write() -> u64 {
    let mut value = 0;
    value_dependency::write(&mut value, input());
    sensitive(value)
}
pub fn unrelated() -> u64 {
    let _ = value_dependency::relay(input(), 0);
    sensitive(value_dependency::relay(0, 0))
}
#[inline(never)]
pub fn invoke(callback: fn(u64) -> u64, value: u64) -> u64 { callback(value) }
#[inline(never)]
pub fn forward(callback: fn(u64) -> u64, value: u64) -> u64 { invoke(callback, value) }
pub fn callbacks() -> u64 { sensitive(forward(identity, input())) }
#[inline(never)]
pub fn generic_invoke<F: Fn(u64) -> u64>(callback: F, value: u64) -> u64 { callback(value) }
pub fn callback_tuple() -> u64 { sensitive(generic_invoke(identity, input())) }
#[inline(never)]
pub fn recursive(value: u64, depth: u64) -> u64 {
    if depth == 0 { value } else { recursive(value, depth - 1) }
}
pub fn loops() -> u64 {
    let mut value = input();
    for _ in 0..3 { value = identity(value); }
    sensitive(recursive(value, 2))
}
#[inline(never)]
pub fn sanitize(value: u64) -> u64 { value }
pub fn sanitized() -> u64 { sensitive(sanitize(input())) }
pub fn bypass() -> u64 {
    let value = input();
    let _ = sanitize(value);
    sensitive(value)
}
#[inline(never)]
pub fn transform(value: &str) -> String { value.to_owned() }
#[inline(never)]
pub fn input_text() -> &'static str { "configured input" }
#[inline(never)]
pub fn sensitive_text(value: String) -> usize { value.len() }
pub fn strings() -> usize { sensitive_text(transform(input_text())) }
unsafe extern "C" { fn external_value(value: u64) -> u64; }
pub unsafe fn native() -> u64 { sensitive(unsafe { external_value(input()) }) }
pub unsafe fn raw_alias(pointer: *const u64) -> u64 { sensitive(unsafe { *pointer }) }

pub fn nested_positive() -> u64 {
    let nested = ((input(), 0), 0);
    sensitive(nested.0.0)
}
pub fn nested_clean() -> u64 {
    let nested = ((input(), 0), 0);
    sensitive(nested.0.1)
}
pub fn nested_return_positive() -> u64 {
    let nested = value_dependency::nested_copy(((input(), 0), 0));
    sensitive(nested.0.0)
}
pub fn nested_return_clean() -> u64 {
    let nested = value_dependency::nested_copy(((input(), 0), 0));
    sensitive(nested.0.1)
}
pub fn retarget_positive() -> u64 {
    let secret = input();
    let clean = 0;
    let mut reference = &clean;
    value_dependency::retarget(&mut reference, &secret);
    sensitive(*reference)
}
pub fn retarget_clean() -> u64 {
    let _secret = input();
    let clean = 0;
    let mut reference = &clean;
    value_dependency::retarget(&mut reference, &clean);
    sensitive(*reference)
}
pub fn retarget_field_positive() -> u64 {
    let pair = Pair { first: input(), second: 0 };
    let clean = 0;
    let mut reference = &clean;
    value_dependency::retarget(&mut reference, &pair.first);
    sensitive(*reference)
}
pub fn retarget_field_clean() -> u64 {
    let pair = Pair { first: input(), second: 0 };
    let mut reference = &pair.second;
    value_dependency::retarget(&mut reference, &pair.second);
    sensitive(*reference)
}
pub fn reused_proof() -> u64 {
    let source = input();
    let _first = value_dependency::outer(source, 0);
    sensitive(value_dependency::outer(0, source))
}
pub fn parameter_source(value: u64) -> u64 { sensitive(value) }
pub fn overwrite_clean(mut pair: Pair) -> u64 { pair.first = 0; sensitive(pair.first) }
pub fn overwrite_sibling(mut pair: Pair) -> u64 { pair.first = 0; sensitive(pair.second) }
pub fn overwrite_nested(mut pair: ((u64, u64), u64)) -> u64 { pair.0.0 = 0; sensitive(pair.0.0) }
pub fn overwrite_reference(mut pair: Pair) -> u64 { let first = &mut pair.first; *first = 0; sensitive(pair.first) }
pub fn overwrite_summary(pair: (u64, u64)) -> u64 {
    let mut result = value_dependency::pair_copy(pair);
    result.0 = 0;
    sensitive(result.0)
}
pub fn overwrite_wrapper_clean(pair: (u64, u64)) -> u64 {
    let result = value_dependency::clear_pair_wrapper(pair);
    sensitive(result.0)
}
pub fn overwrite_wrapper_sibling(pair: (u64, u64)) -> u64 {
    let result = value_dependency::clear_pair_wrapper(pair);
    sensitive(result.1)
}
pub fn overwrite_wrapper_reference(mut pair: (u64, u64)) -> u64 {
    value_dependency::clear_wrapper(&mut pair.0);
    sensitive(pair.0)
}
pub fn overwrite_wrapper_reference_sibling(mut pair: (u64, u64)) -> u64 {
    value_dependency::clear_wrapper(&mut pair.0);
    sensitive(pair.1)
}
pub fn overwrite_wrapper_branch(pair: (u64, u64), write: bool) -> u64 {
    let result = value_dependency::clear_pair_branch_wrapper(pair, write);
    sensitive(result.0)
}
pub fn mixed_reference(callback: fn(&mut u64), choose: bool) -> u64 {
    let mut value = input();
    let unknown = value_dependency::callback_value(callback);
    let operation: fn(&mut u64) = if choose { value_dependency::clear } else { unknown };
    operation(&mut value);
    value_dependency::gate();
    sensitive(value)
}
pub fn mixed_reference_clean(callback: fn(&mut u64), choose: bool) -> u64 {
    let _source = input();
    let mut value = 0;
    let unknown = value_dependency::callback_value(callback);
    let operation: fn(&mut u64) = if choose { value_dependency::clear } else { unknown };
    operation(&mut value);
    value_dependency::gate();
    sensitive(value)
}
pub fn mixed_reference_field(callback: fn(&mut u64), choose: bool) -> u64 {
    let mut pair = (input(), 0);
    let unknown = value_dependency::callback_value(callback);
    let operation: fn(&mut u64) = if choose { value_dependency::clear } else { unknown };
    operation(&mut pair.0);
    value_dependency::gate();
    sensitive(pair.0)
}
