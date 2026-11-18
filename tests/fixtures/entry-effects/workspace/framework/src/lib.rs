pub fn register(_handler: fn()) {}
pub fn command(_name: &str, _handler: fn()) {}
pub fn invoke(handler: fn()) { handler(); }
