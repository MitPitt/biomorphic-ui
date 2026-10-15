//! Offline WGSL checker. Parses + validates a WGSL file with naga so shader
//! mistakes are caught without a GPU. Exits non-zero on any error.
//!
//!   cargo run --release -- <file.wgsl> [--emit]
//!
//! `--emit` additionally round-trips through the WGSL backend, which catches a
//! few constructs the validator accepts but the writer rejects.

use std::process::ExitCode;

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let path = match args.next() {
        Some(p) => p,
        None => {
            eprintln!("usage: wgslcheck <file.wgsl> [--emit]");
            return ExitCode::FAILURE;
        }
    };
    let emit = args.any(|a| a == "--emit");
    let src = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("read {path}: {e}");
            return ExitCode::FAILURE;
        }
    };

    let module = match naga::front::wgsl::parse_str(&src) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("{}", e.emit_to_string_with_path(&src, &path));
            return ExitCode::FAILURE;
        }
    };

    let mut validator = naga::valid::Validator::new(
        naga::valid::ValidationFlags::all(),
        naga::valid::Capabilities::all(),
    );
    let info = match validator.validate(&module) {
        Ok(i) => i,
        Err(e) => {
            eprintln!("{}", e.emit_to_string_with_path(&src, &path));
            return ExitCode::FAILURE;
        }
    };

    if emit {
        let mut out = String::new();
        let mut writer = naga::back::wgsl::Writer::new(&mut out, naga::back::wgsl::WriterFlags::empty());
        if let Err(e) = writer.write(&module, &info) {
            eprintln!("wgsl write error: {e:?}");
            return ExitCode::FAILURE;
        }
    }

    println!("ok   {path}");
    ExitCode::SUCCESS
}
