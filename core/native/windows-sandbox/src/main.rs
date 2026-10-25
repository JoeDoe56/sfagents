//! No elevation on the run path. Machine changes are confined to setup/uninstall.
mod model;
#[cfg(windows)]
mod network;
#[cfg(windows)]
mod runner;
#[cfg(windows)]
mod setup;
#[cfg(windows)]
mod win;

fn main() {
    #[cfg(windows)]
    unsafe {
        // Surface startup failures through exit status/stderr, never modal
        // Windows dialogs. Children inherit this process error mode.
        use windows_sys::Win32::System::Diagnostics::Debug::*;
        SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    match dispatch(&args) {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("sfagents-sandbox: {error}");
            std::process::exit(125);
        }
    }
}
fn dispatch(args: &[String]) -> Result<i32, String> {
    match args.first().map(String::as_str).unwrap_or("help") {
        "version" | "--version" => {
            println!(
                "sfagents-sandbox {} (protocol 1)",
                env!("CARGO_PKG_VERSION")
            );
            Ok(0)
        }
        "help" | "--help" => {
            println!("sfagents-sandbox setup | uninstall | probe | recover | run --policy <file> -- <exe> [args...]\nsetup/uninstall require an administrator terminal. run/probe never elevate.");
            Ok(0)
        }
        #[cfg(windows)]
        "setup" => {
            setup::install()?;
            Ok(0)
        }
        #[cfg(windows)]
        "uninstall" => {
            setup::uninstall()?;
            Ok(0)
        }
        #[cfg(windows)]
        "probe" => {
            setup::probe()?;
            Ok(0)
        }
        #[cfg(windows)]
        "recover" => {
            runner::recover()?;
            Ok(0)
        }
        #[cfg(windows)]
        "run" => runner::run(&args[1..]),
        #[cfg(windows)]
        "worker" => runner::worker(&args[1..]),
        _ => Err("unknown command (or unsupported platform); use --help".into()),
    }
}
