//! Synthetic Windows application for the physical update regression.
use std::{io::Read, path::PathBuf, time::Duration};
fn main() {
    let path = PathBuf::from(std::env::var_os("XWX_UPDATE_TEST_RECEIPT").expect("isolated receipt"));
    #[cfg(not(fixture_new))]
    {
        std::fs::write(path, format!("{{\"version\":\"fixture-old\",\"pid\":{}}}", std::process::id())).unwrap();
        let _ = std::io::stdin().read_to_end(&mut Vec::new());
    }
    #[cfg(fixture_new)]
    {
        std::fs::write(path, format!("{{\"version\":\"fixture-new\",\"pid\":{}}}", std::process::id())).unwrap();
        let mode = std::env::var("XWX_UPDATE_TEST_MODE").unwrap_or_default();
        if mode == "exit" { std::process::exit(23); }
        if mode == "delayed-ready" { std::thread::sleep(Duration::from_millis(1500)); }
        if mode != "silent" {
            let directory = PathBuf::from(std::env::var_os("XWX_DECK_UPDATE_READY_DIR").expect("startup directory"));
            let mut nonce = std::env::var("XWX_DECK_UPDATE_READY_NONCE").expect("startup nonce");
            if mode == "wrong-nonce" { nonce = "0".repeat(64); }
            let hash = std::env::var("XWX_DECK_UPDATE_EXPECTED_SHA256").expect("startup hash");
            std::fs::write(directory.join("ready.json"), format!("{{\"nonce\":\"{nonce}\",\"pid\":{},\"sha256\":\"{hash}\"}}", std::process::id())).unwrap();
        }
        if mode == "ready-then-exit" { std::thread::sleep(Duration::from_millis(100)); std::process::exit(23); }
        std::thread::sleep(Duration::from_secs(60));
    }
}
