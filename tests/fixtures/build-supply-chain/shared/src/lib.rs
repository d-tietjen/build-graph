// The same function can belong to a host/build and an application role,
// including when Cargo reuses a unit and the host/target triples are equal.
pub fn probe() { let _ = std::env::var_os("BUILD_SUPPLY_FIXTURE_PROBE"); }

pub fn invoke(callback: fn()) { callback(); }
