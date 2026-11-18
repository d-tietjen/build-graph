#[inline(never)]
pub fn relay(first: u64, second: u64) -> u64 { let _ = second; first }

#[inline(never)]
pub fn write(output: &mut u64, value: u64) { *output = value; }

#[inline(never)]
pub fn first(pair: (u64, u64)) -> u64 { pair.0 }

#[inline(never)]
pub fn nested_copy(value: ((u64, u64), u64)) -> ((u64, u64), u64) { value }

#[inline(never)]
pub fn retarget<'a>(slot: &mut &'a u64, value: &'a u64) { *slot = value; }

#[inline(never)]
pub fn inner(value: u64) -> u64 { value }

#[inline(never)]
pub fn outer(first: u64, second: u64) -> u64 { inner(first + second) }

#[inline(never)]
pub fn pair_copy(pair: (u64, u64)) -> (u64, u64) { pair }

#[inline(never)]
pub fn clear_pair(mut pair: (u64, u64)) -> (u64, u64) { pair.0 = 0; pair }
#[inline(never)]
pub fn clear_pair_wrapper(pair: (u64, u64)) -> (u64, u64) { clear_pair(pair) }
#[inline(never)]
pub fn clear(output: &mut u64) { *output = 0; }
#[inline(never)]
pub fn clear_wrapper(output: &mut u64) { clear(output); }
#[inline(never)]
pub fn clear_pair_branch(mut pair: (u64, u64), write: bool) -> (u64, u64) { if write { pair.0 = 0; } pair }
#[inline(never)]
pub fn clear_pair_branch_wrapper(pair: (u64, u64), write: bool) -> (u64, u64) { clear_pair_branch(pair, write) }
#[inline(never)]
pub fn callback_value(callback: fn(&mut u64)) -> fn(&mut u64) { callback }
#[inline(never)]
pub fn gate() {}
