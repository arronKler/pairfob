use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use pairfob_desktop::herdr::{self, Config, ConnectTarget};
use pairfob_desktop::model::Size;

const HELP: &str = "\
pairfob-desktop - Herdr sessions in a native window

usage:
  pairfob-desktop [--session NAME | --socket PATH]
  pairfob-desktop --self-check [--seconds N] [--session NAME | --socket PATH]

options:
  --session NAME   attach to a named Herdr session (default: the current one)
  --socket PATH    exact herdr-client socket path
  --self-check     connect, print one frame's stats, exit
  --seconds N      self-check timeout in seconds (default 10)
  -V, --version    print the version
  -h, --help       print this help
";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Window,
    SelfCheck,
}

fn main() -> ExitCode {
    pairfob_desktop::log::init();
    let args: Vec<String> = std::env::args().skip(1).collect();
    pairfob_desktop::log::info(&format!(
        "pairfob-desktop {} starting with arguments [{}]",
        pairfob_desktop::update::VERSION,
        args.join(" ")
    ));

    let mut mode = Mode::Window;
    let mut target = ConnectTarget::Local;
    let mut seconds = 10u64;

    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--self-check" => mode = Mode::SelfCheck,
            "--session" => match args.next() {
                Some(name) => {
                    target = ConnectTarget::Session {
                        name,
                        development: false,
                    }
                }
                None => return usage("--session needs a name"),
            },
            "--socket" => match args.next() {
                Some(path) => target = ConnectTarget::Socket(PathBuf::from(path)),
                None => return usage("--socket needs a path"),
            },
            "--seconds" => match args.next().and_then(|value| value.parse().ok()) {
                Some(value) => seconds = value,
                None => return usage("--seconds needs a number"),
            },
            "-V" | "--version" => {
                println!("pairfob-desktop {}", pairfob_desktop::update::VERSION);
                return ExitCode::SUCCESS;
            }
            "-h" | "--help" => {
                print!("{HELP}");
                return ExitCode::SUCCESS;
            }
            other => return usage(&format!("unknown argument {other}")),
        }
    }

    let session = match &target {
        ConnectTarget::Session { name, .. } => Some(name.clone()),
        _ => None,
    };

    if mode == Mode::SelfCheck {
        let mut config = Config::local();
        config.target = target;
        config.surface = Size::new(120, 40);
        return match herdr::self_check(&config, Duration::from_secs(seconds)) {
            Ok(report) => {
                println!("{}", report.summary());
                ExitCode::SUCCESS
            }
            Err(error) => {
                eprintln!("self-check failed: {error}");
                pairfob_desktop::log::error(&format!("self-check failed: {error}"));
                ExitCode::FAILURE
            }
        };
    }

    let mut config = Config::local();
    config.target = target;

    #[cfg(feature = "gui")]
    {
        let desktop = match herdr::start(config) {
            Ok(desktop) => desktop,
            Err(error) => {
                eprintln!("could not start the engine: {error}");
                pairfob_desktop::log::error(&format!("could not start the engine: {error}"));
                return ExitCode::FAILURE;
            }
        };
        match pairfob_desktop::ui::run(desktop, session) {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("the window stopped: {error}");
                pairfob_desktop::log::error(&format!("the window stopped: {error}"));
                ExitCode::FAILURE
            }
        }
    }

    #[cfg(not(feature = "gui"))]
    {
        let _ = (config, session);
        eprintln!("this build has no window: rebuild with the gui feature, or use --self-check");
        ExitCode::from(2)
    }
}

fn usage(message: &str) -> ExitCode {
    eprintln!("{message}\n");
    eprint!("{HELP}");
    ExitCode::from(2)
}
