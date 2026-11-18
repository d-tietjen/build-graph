use execution_flow_fixture::entry;

fn collision_before() {}
fn collision_after() {}
fn shared() {}

fn main() {
    collision_before();
    let flag = std::env::args().any(|arg| arg == "--left");
    entry(flag);
    shared();
    collision_after();
}
