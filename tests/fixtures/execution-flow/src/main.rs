fn before() {}
fn left() {}
fn right() {}
fn after() {}
fn shared() {}

pub fn main() {
    shared();
}

// Both arms are reachable because flag is chosen at runtime. A path through
// entry calls before, exactly one of left/right, shared, then after.
pub fn entry(flag: bool) {
    before();
    if flag {
        left();
        shared();
    } else {
        right();
        shared();
    }
    after();
}

pub fn recurse(depth: u8) {
    if depth > 0 {
        recurse(depth - 1);
    }
}

pub fn loop_calls(count: u8) {
    for _ in 0..count {
        shared();
    }
}

fn named_callback() {}
fn alternate_callback() {}
fn closure_body() {}

pub fn invoke_callback(callback: fn()) {
    callback();
}

pub fn invoke_generic<F: Fn()>(callback: F) {
    callback();
}

pub fn forward_callback(callback: fn()) {
    invoke_callback(callback);
}

fn redirect_callback(callback: &mut fn()) {
    *callback = alternate_callback;
}

pub fn aliased_callback_entry() {
    let mut callback: fn() = named_callback;
    redirect_callback(&mut callback);
    callback();
}

pub fn aliased_forward_callback_entry() {
    let mut callback: fn() = named_callback;
    redirect_callback(&mut callback);
    invoke_callback(callback);
}

pub fn callback_entry(flag: bool, count: u8) {
    let callback: fn() = if flag {
        named_callback
    } else {
        alternate_callback
    };
    callback();
    forward_callback(callback);
    invoke_generic(|| closure_body());
    for _ in 0..count {
        invoke_callback(named_callback);
    }
}
