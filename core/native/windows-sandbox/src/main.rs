//! SF Agents Windows shell sandbox helper (scaffold).
//!
//! Planned subcommands: `setup` and `uninstall` (elevated, once), `probe`
//! and `run` (unelevated, per command). See docs/windows-sandbox-handover.md.

fn main() {
    let cmd = std::env::args().nth(1).unwrap_or_default();
    match cmd.as_str() {
        "version" | "--version" => println!("sfagents-sandbox {}", env!("CARGO_PKG_VERSION")),
        _ => {
            eprintln!("sfagents-sandbox: not implemented yet ({cmd:?})");
            std::process::exit(2);
        }
    }
}
