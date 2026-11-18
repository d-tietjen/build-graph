//! Compile/capture only. These names are fixture declarations, never policy heuristics.
use policy_support::{check, effect};

pub fn early_return(p: u64, t: u64, o: u64, v: u64) -> u64 {
    if check(p, t, o, v) {} else { return 0; }
    effect(p, t, o, v)
}
pub fn fail_open(p: u64, t: u64, o: u64, v: u64) -> u64 {
    if check(p, t, o, v) { let _ = policy_support::identity(v); }
    effect(p, t, o, v)
}
pub fn ignored(p: u64, t: u64, o: u64, v: u64) -> u64 {
    let _ = check(p, t, o, v);
    effect(p, t, o, v)
}
pub fn failed_only(p: u64, t: u64, o: u64, v: u64) -> u64 {
    if check(p, t, o, v) { 0 } else { effect(p, t, o, v) }
}
pub fn wrong_tenant(p: u64, t: u64, o: u64, v: u64, other: u64) -> u64 {
    if check(p, other, o, v) { effect(p, t, o, v) } else { 0 }
}
pub fn wrong_object(p: u64, t: u64, o: u64, v: u64, other: u64) -> u64 {
    if check(p, t, other, v) { effect(p, t, o, v) } else { 0 }
}
pub fn wrong_principal(p: u64, t: u64, o: u64, v: u64, other: u64) -> u64 {
    if check(other, t, o, v) { effect(p, t, o, v) } else { 0 }
}
pub fn after_effect(p: u64, t: u64, o: u64, v: u64) -> u64 {
    let result = effect(p, t, o, v);
    if check(p, t, o, v) { result } else { 0 }
}
pub fn transformed(p: u64, t: u64, o: u64, v: u64) -> u64 {
    if check(p, t, o, v) { effect(p, t, o, v ^ 1) } else { 0 }
}
pub fn transformed_checked(p: u64, t: u64, o: u64, v: u64) -> u64 {
    let changed = v ^ 1;
    if check(p, t, o, changed) { effect(p, t, o, changed) } else { 0 }
}
pub fn alternate(p: u64, t: u64, o: u64, v: u64, choose: bool) -> u64 {
    if choose { if check(p, t, o, v) {} else { return 0; } }
    effect(p, t, o, v)
}
pub fn middleware(p: u64, t: u64, o: u64, v: u64) -> u64 {
    let copied = policy_support::identity(v);
    if check(p, t, o, copied) { effect(p, t, o, copied) } else { 0 }
}
pub fn callback(p: u64, t: u64, o: u64, v: u64) -> u64 {
    if policy_support::forward(check, p, t, o, v) { effect(p, t, o, v) } else { 0 }
}
pub fn direct_pointer(p: u64, t: u64, o: u64, v: u64) -> u64 {
    let checker: fn(u64, u64, u64, u64) -> bool = check;
    if checker(p, t, o, v) { effect(p, t, o, v) } else { 0 }
}
pub fn other_check(p: u64, t: u64, o: u64, v: u64) -> bool {
    p == t && o == v
}
pub fn repeated(p: u64, t: u64, o: u64, v: u64) -> u64 {
    let _ = policy_support::identity(t);
    let copied = policy_support::identity(v);
    if check(p, t, o, copied) { effect(p, t, o, copied) } else { 0 }
}
pub fn loop_frontier(p: u64, t: u64, o: u64, v: u64, repeat: bool) -> u64 {
    while repeat { let _ = policy_support::identity(v); }
    if check(p, t, o, v) { effect(p, t, o, v) } else { 0 }
}
extern "C" { fn opaque_check(p: u64, t: u64, o: u64, v: u64) -> bool; }
pub fn native(p: u64, t: u64, o: u64, v: u64) -> u64 {
    if unsafe { opaque_check(p, t, o, v) } { effect(p, t, o, v) } else { 0 }
}
