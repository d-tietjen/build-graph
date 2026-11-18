// Independent host integration. The external host owns activation. Its adapter
// models only these exact identities, without hard-coding names in the engine.
pub fn host_callback() { custom_transport::emit(); }
mod custom_transport { pub fn emit() {} }
