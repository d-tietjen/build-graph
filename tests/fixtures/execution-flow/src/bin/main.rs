use execution_flow_fixture::{entry, loop_calls, recurse};

fn binary_before() {}
fn binary_after() {}

fn main() {
    binary_before();
    let flag = std::env::args().any(|arg| arg == "--left");
    entry(flag);
    binary_after();
    recurse(1);
    loop_calls(2);
}
