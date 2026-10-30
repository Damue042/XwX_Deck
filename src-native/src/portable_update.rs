//! Portable replacement runs in a copied native executable after safe shutdown.
#[cfg(target_os = "windows")]
mod windows {
    use sha2::{Digest, Sha256};
    use std::os::windows::process::CommandExt;
    use std::{
        fs,
        io::Read,
        path::{Path, PathBuf},
        process::Command,
        time::Duration,
    };
    fn hash(path: &Path) -> Result<String, String> {
        let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
        let mut hash = Sha256::new();
        let mut buffer = [0u8; 65536];
        loop {
            let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            hash.update(&buffer[..n]);
        }
        Ok(format!("{:x}", hash.finalize()))
    }
    fn regular(path: &Path) -> Result<(), String> {
        let info = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
        if !path.is_absolute()
            || !info.is_file()
            || info.file_type().is_symlink()
            || path.extension().and_then(|s| s.to_str()) != Some("exe")
        {
            return Err("无效便携版路径".into());
        }
        Ok(())
    }
    const STARTUP_TIMEOUT: Duration = Duration::from_secs(45);
    const READY_GRACE: Duration = Duration::from_secs(1);

    fn read_startup_json(path: &Path) -> Result<serde_json::Value, String> {
        let info = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
        if !info.is_file() || info.file_type().is_symlink() || info.len() > 8192 {
            return Err("Invalid startup receipt file".into());
        }
        serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
            .map_err(|_| "Invalid startup receipt contents".into())
    }

    fn startup_directory(path: &Path, nonce: &str) -> Result<(), String> {
        if nonce.len() != 64
            || !nonce.bytes().all(|c| c.is_ascii_hexdigit())
            || !path.is_absolute()
            || path.file_name().and_then(|v| v.to_str())
                != Some(format!("startup-{nonce}").as_str())
            || path
                .parent()
                .and_then(Path::file_name)
                .and_then(|v| v.to_str())
                != Some("updates")
        {
            return Err("Invalid startup receipt directory".into());
        }
        for directory in [path, path.parent().unwrap()] {
            let info = fs::symlink_metadata(directory).map_err(|e| e.to_string())?;
            if !info.is_dir() || info.file_type().is_symlink() {
                return Err("Startup receipt directory must be a regular directory".into());
            }
        }
        Ok(())
    }

    // Called only through the main window's IPC after React commits a usable
    // shell and receives the native runtime state. Spawn success is insufficient.
    pub fn acknowledge_startup() -> Result<(), String> {
        let directory = std::env::var_os("XWX_DECK_UPDATE_READY_DIR");
        let nonce = std::env::var("XWX_DECK_UPDATE_READY_NONCE").ok();
        let (directory, nonce) = match (directory, nonce) {
            (None, None) => return Ok(()),
            (Some(directory), Some(nonce)) => (PathBuf::from(directory), nonce),
            _ => return Err("Incomplete update startup challenge".into()),
        };
        startup_directory(&directory, &nonce)?;
        let challenge = read_startup_json(&directory.join("challenge.json"))?;
        let executable = std::env::current_exe().map_err(|e| e.to_string())?;
        let requested = PathBuf::from(
            challenge["executable"]
                .as_str()
                .ok_or("Missing startup executable")?,
        );
        let actual = fs::canonicalize(&executable).map_err(|e| e.to_string())?;
        let requested = fs::canonicalize(requested).map_err(|e| e.to_string())?;
        let actual_hash = hash(&executable)?;
        if challenge["nonce"] != nonce
            || !actual
                .to_string_lossy()
                .eq_ignore_ascii_case(&requested.to_string_lossy())
            || challenge["sha256"] != actual_hash
        {
            return Err("Update startup challenge does not match this application".into());
        }
        let receipt =
            serde_json::json!({"nonce":nonce,"pid":std::process::id(),"sha256":actual_hash});
        let ready = directory.join("ready.json");
        if ready.exists() {
            return if read_startup_json(&ready)? == receipt {
                Ok(())
            } else {
                Err("A different application already acknowledged startup".into())
            };
        }
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(directory.join("ready.tmp"))
            .map_err(|e| e.to_string())?;
        file.write_all(receipt.to_string().as_bytes())
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        fs::rename(directory.join("ready.tmp"), ready).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn launch_and_confirm(
        mut command: Command,
        target: &Path,
        updates: &Path,
    ) -> Result<u32, String> {
        regular(target)?;
        let target = fs::canonicalize(target).map_err(|e| e.to_string())?;
        let updates = fs::canonicalize(updates).map_err(|e| e.to_string())?;
        let mut random = [0u8; 32];
        getrandom::fill(&mut random).map_err(|e| e.to_string())?;
        let nonce: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let directory = updates.join(format!("startup-{nonce}"));
        fs::create_dir(&directory).map_err(|e| e.to_string())?;
        startup_directory(&directory, &nonce)?;
        let expected = hash(&target)?;
        let challenge = serde_json::json!({"nonce":nonce,"executable":target,"sha256":expected});
        fs::write(directory.join("challenge.json"), challenge.to_string())
            .map_err(|e| e.to_string())?;
        let mut child = command
            .env("XWX_DECK_UPDATE_READY_DIR", &directory)
            .env("XWX_DECK_UPDATE_READY_NONCE", &nonce)
            .env("XWX_DECK_UPDATE_EXPECTED_SHA256", &expected)
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| format!("自动启动失败：{e}"))?;
        let started = std::time::Instant::now();
        let mut acknowledged = None;
        loop {
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                return Err(format!(
                    "新版启动未完成，进程已退出（{status}）。新文件与恢复备份均保留，请手动检查。"
                ));
            }
            let ready = directory.join("ready.json");
            if ready.exists() {
                let receipt = read_startup_json(&ready)?;
                if receipt["nonce"] != nonce
                    || receipt["pid"].as_u64() != Some(u64::from(child.id()))
                    || receipt["sha256"] != expected
                {
                    return Err("新版启动确认不匹配。新文件与恢复备份均保留，请手动检查。".into());
                }
                if acknowledged.is_none() && hash(&target)? != expected {
                    return Err("新版文件在启动期间发生变化，已保留恢复备份。".into());
                }
                let at = acknowledged.get_or_insert_with(std::time::Instant::now);
                if at.elapsed() >= READY_GRACE {
                    if hash(&target)? != expected {
                        return Err("启动确认后的文件校验失败，已保留恢复备份。".into());
                    }
                    fs::write(directory.join("confirmed.json"), receipt.to_string())
                        .map_err(|e| e.to_string())?;
                    return Ok(child.id());
                }
            }
            if started.elapsed() >= STARTUP_TIMEOUT {
                return Err(
                    "等待新版就绪超时。新程序可能仍在运行，新文件与恢复备份均保留，请手动检查。"
                        .into(),
                );
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    pub fn spawn(source: &Path) -> Result<(), String> {
        regular(source)?;
        let target = std::env::current_exe().map_err(|e| e.to_string())?;
        regular(&target)?;
        if target.starts_with(source.parent().ok_or("无效下载目录")?) {
            return Err("临时验证程序不能替换自身".into());
        }
        let helper = source
            .parent()
            .unwrap()
            .join(format!("xwx-native-update-{}.exe", std::process::id()));
        fs::copy(&target, &helper).map_err(|e| e.to_string())?;
        let mut command = Command::new(&helper);
        command
            .args(["--install-update"])
            .arg(source)
            .arg("--replace-executable")
            .arg(&target)
            .arg("--expected-sha256")
            .arg(hash(source)?)
            .arg("--parent-pid")
            .arg(std::process::id().to_string());
        let args: Vec<_> = std::env::args().collect();
        for flag in ["--pilot-root", "--data-root"] {
            if let Some(value) = args.windows(2).find(|pair| pair[0] == flag) {
                let root = fs::canonicalize(&value[1]).map_err(|e| e.to_string())?;
                command.arg(flag).arg(root);
            }
        }
        command
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn nightly_window(hour: u32, idle_ms: u64) -> bool {
        (2..5).contains(&hour) && idle_ms >= 900_000
    }
    pub fn idle_for_nightly() -> bool {
        use chrono::Timelike;
        #[repr(C)]
        struct LastInput {
            size: u32,
            time: u32,
        }
        #[link(name = "user32")]
        extern "system" {
            fn GetLastInputInfo(info: *mut LastInput) -> i32;
        }
        #[link(name = "kernel32")]
        extern "system" {
            fn GetTickCount() -> u32;
        }
        let mut input = LastInput {
            size: std::mem::size_of::<LastInput>() as u32,
            time: 0,
        };
        let hour = chrono::Local::now().hour();
        unsafe {
            GetLastInputInfo(&mut input) != 0
                && nightly_window(hour, u64::from(GetTickCount().wrapping_sub(input.time)))
        }
    }
    pub fn worker() -> Option<i32> {
        let args: Vec<_> = std::env::args().collect();
        if !args.iter().any(|s| s == "--install-update") {
            return None;
        }
        let argument = |name: &str| {
            args.windows(2)
                .find(|a| a[0] == name)
                .map(|a| a[1].clone())
                .ok_or_else(|| format!("Missing {name}"))
        };
        let result = (|| -> Result<(), String> {
            let source = PathBuf::from(argument("--install-update")?);
            let target = PathBuf::from(argument("--replace-executable")?);
            let expected = argument("--expected-sha256")?;
            let pid = argument("--parent-pid")?
                .parse::<u32>()
                .map_err(|e| e.to_string())?;
            regular(&source)?;
            regular(&target)?;
            let executable = std::env::current_exe().map_err(|e| e.to_string())?;
            if pid == 0
                || source == target
                || source.parent() != executable.parent()
                || source
                    .parent()
                    .and_then(|p| p.file_name())
                    .and_then(|s| s.to_str())
                    != Some("updates")
                || hash(&source)? != expected
            {
                return Err("更新路径或 SHA-256 不匹配".into());
            }
            let mut gone = false;
            for _ in 0..120 {
                let output = Command::new("tasklist.exe")
                    .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
                    .creation_flags(0x08000000)
                    .output()
                    .map_err(|e| e.to_string())?;
                if !output.status.success() {
                    return Err("无法确认旧程序已退出".into());
                }
                let alive = String::from_utf8_lossy(&output.stdout).lines().any(|l| {
                    l.split(',')
                        .nth(1)
                        .is_some_and(|v| v.trim_matches('"') == pid.to_string())
                });
                if !alive {
                    gone = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(500));
            }
            if !gone {
                return Err("旧程序仍运行，未替换".into());
            }
            if hash(&source)? != expected {
                return Err("安装包已被修改".into());
            }
            let backup = target.with_extension(format!("exe.previous-{}", &hash(&target)?[..16]));
            if backup.exists() {
                return Err("检测到已有更新恢复备份，请先检查".into());
            }
            fs::rename(&target, &backup).map_err(|e| e.to_string())?;
            let replaced = (|| -> Result<(), String> {
                fs::copy(&source, &target).map_err(|e| e.to_string())?;
                if hash(&target)? != expected {
                    return Err("替换后校验失败".into());
                }
                Ok(())
            })();
            if let Err(e) = replaced {
                let _ = fs::remove_file(&target);
                fs::rename(&backup, &target).map_err(|e| e.to_string())?;
                return Err(e);
            }
            let mut command = Command::new(&target);
            command.current_dir(target.parent().unwrap());
            for flag in ["--pilot-root", "--data-root"] {
                if let Some(value) = args.windows(2).find(|pair| pair[0] == flag) {
                    let root = fs::canonicalize(&value[1]).map_err(|e| e.to_string())?;
                    if flag == "--pilot-root"
                        && fs::read_to_string(root.join(".xwx-rust-pilot"))
                            .ok()
                            .as_deref()
                            != Some("isolated-rust-pilot-v1\n")
                    {
                        return Err("隔离数据目录无效".into());
                    }
                    command.arg(flag).arg(root);
                }
            }
            launch_and_confirm(command, &target, source.parent().unwrap())
                .map_err(|error| format!("{error} 恢复备份：{}", backup.display()))?;
            Ok(())
        })();
        if let Err(error) = result {
            if let Ok(path) = std::env::current_exe() {
                let _ = fs::write(path.with_extension("error.txt"), error);
            }
            Some(1)
        } else {
            Some(0)
        }
    }
}
#[cfg(target_os = "windows")]
pub use windows::{
    acknowledge_startup, idle_for_nightly, launch_and_confirm, nightly_window, spawn, worker,
};
