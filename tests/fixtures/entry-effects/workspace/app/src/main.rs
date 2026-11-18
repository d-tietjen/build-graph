fn main() {
    effects_api::library_action();
    registration_framework::register(callback_reference_only);
    registration_framework::command("show", cli_handler);
    registration_framework::invoke(invoked_callback);
    let mut configured = std::process::Command::new("unused-command");
    configured.arg("configuration-is-not-launch");
}

fn callback_reference_only() {
    let _ = std::net::TcpStream::connect("127.0.0.1:9");
}

fn invoked_callback() {
    let _ = std::env::var("ENTRY_EFFECT_FIXTURE");
}

fn cli_handler() {
    let _ = std::process::Command::new("echo").status();
}

mod helper { pub fn main() {} }
struct AssociatedMain;
impl AssociatedMain { fn main() {} }
