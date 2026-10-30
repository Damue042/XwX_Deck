//! Compiled only into explicit isolated update acceptance builds. Never a
//! production trust exception: separate channel/key, loopback HTTPS and root.
use std::path::{Path, PathBuf};
type Result<T> = std::result::Result<T, String>;
fn base(root: &Path) -> Result<PathBuf> {
    let data = root.parent().ok_or("invalid validation root")?;
    let base = data.parent().ok_or("invalid validation base")?;
    if data.file_name().is_none_or(|n| n != "data")
        || std::fs::read_to_string(base.join("fixture-id")).unwrap_or_default()
            != env!("XWX_UPDATE_VALIDATION_ID")
    {
        return Err("验收目录不属于当前测试任务".into());
    }
    Ok(base.into())
}
pub fn guard_root(root: &Path) -> Result<()> {
    let actual = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
    if actual != root
        || !actual.starts_with(base(root)?.join("data"))
        || std::fs::read_to_string(root.join(".xwx-rust-pilot")).unwrap_or_default()
            != "isolated-rust-pilot-v1\n"
    {
        return Err("更新验收构建只允许指定的独立数据目录".into());
    }
    Ok(())
}
pub fn guard_app(app: &Path, id: &str, root: &Path) -> Result<()> {
    if id != "app.xwxdeck.validation" || !app.starts_with(base(root)?.join("apps")) {
        return Err("更新验收构建不能操作正常安装".into());
    }
    Ok(())
}
pub fn guard_launch() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    let root = args
        .iter()
        .position(|v| v == "--pilot-root")
        .and_then(|n| args.get(n + 1))
        .ok_or("验收构建必须指定独立数据目录")?;
    guard_root(Path::new(root))?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    if !exe.starts_with(base(Path::new(root))?.join("apps")) {
        return Err("验收构建只能从隔离应用目录启动".into());
    }
    Ok(())
}
pub fn feed() -> &'static str {
    env!("XWX_UPDATE_VALIDATION_FEED")
}
pub fn trust() -> Result<serde_json::Value> {
    serde_json::from_str(env!("XWX_UPDATE_VALIDATION_TRUST")).map_err(|e| e.to_string())
}
pub fn allowed_url(url: &reqwest::Url) -> bool {
    let expected = reqwest::Url::parse(feed()).expect("validation feed");
    url.scheme() == "https"
        && url.host_str() == Some("127.0.0.1")
        && url.port_or_known_default() == expected.port_or_known_default()
}
pub fn client(builder: reqwest::ClientBuilder) -> Result<reqwest::ClientBuilder> {
    let ca = reqwest::Certificate::from_pem(env!("XWX_UPDATE_VALIDATION_CA").as_bytes())
        .map_err(|e| e.to_string())?;
    Ok(builder.add_root_certificate(ca).https_only(true).no_proxy())
}
// Both edition adapters use the same signed loopback fixture. This function
// is absent from normal builds and does not alter either production feed.
pub async fn manifest() -> Result<serde_json::Value> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use futures_util::StreamExt;
    let response = client(reqwest::Client::builder())?
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(|e| e.to_string())?
        .get(format!("{}/release.json", feed()))
        .send()
        .await
        .map_err(|_| "更新信息请求失败")?
        .error_for_status()
        .map_err(|e| {
            format!(
                "更新信息 HTTP {}",
                e.status().map(|s| s.as_u16()).unwrap_or(0)
            )
        })?;
    if !allowed_url(response.url()) {
        return Err("验收更新地址不符合来源规则".into());
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        if bytes.len().saturating_add(chunk.len()) > 1024 * 1024 {
            return Err("更新信息过大".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let envelope: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "更新签名格式错误")?;
    if envelope["schemaVersion"] != 1 || envelope["algorithm"] != "Ed25519" {
        return Err("更新缺少可信签名".into());
    }
    let trust = trust()?;
    let key = trust["keys"]
        .as_array()
        .and_then(|keys| keys.iter().find(|key| key["id"] == envelope["keyId"]))
        .ok_or("更新签名密钥未受信任")?;
    let decode = |value: &serde_json::Value| {
        STANDARD
            .decode(value.as_str().unwrap_or(""))
            .map_err(|e| e.to_string())
    };
    let public = decode(&key["publicKey"])?;
    let payload = decode(&envelope["payload"])?;
    let signed = decode(&envelope["signature"])?;
    if public.len() != 32 || payload.len() > 1024 * 1024 {
        return Err("更新签名数据无效".into());
    }
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, public)
        .verify(&payload, &signed)
        .map_err(|_| "更新签名验证失败")?;
    let manifest: serde_json::Value =
        serde_json::from_slice(&payload).map_err(|_| "更新信息格式错误")?;
    let version = manifest["version"]
        .as_str()
        .filter(|version| {
            let parts = version.split('.').collect::<Vec<_>>();
            parts.len() == 3 && parts.iter().all(|part| part.parse::<u64>().is_ok())
        })
        .ok_or("更新版本无效")?;
    if manifest["schemaVersion"] != 1
        || manifest["channel"] != "mac-validation"
        || manifest["releaseSeries"] != "mac-update-validation-v1"
        || manifest["tag"].as_str() != Some(format!("v{version}").as_str())
    {
        return Err("更新清单版本或频道不一致".into());
    }
    Ok(manifest)
}
pub fn checkpoint(root: &Path, value: &serde_json::Value) -> Result<()> {
    guard_root(root)?;
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    if bytes.len() > 65536 {
        return Err("验收记录过长".into());
    }
    std::fs::write(root.join("update-validation-checkpoint.json"), bytes).map_err(|e| e.to_string())
}
pub fn control(root: &Path, mode: &str) -> Result<()> {
    guard_root(root)?;
    if ![
        "bad-signature",
        "network-failure",
        "corrupt-download",
        "invalid-platform-signature",
        "interrupted-download",
        "good",
        "up-to-date",
    ]
    .contains(&mode)
    {
        return Err("未知验收场景".into());
    }
    std::fs::write(
        base(root)?.join("control.json"),
        serde_json::json!({"mode":mode}).to_string(),
    )
    .map_err(|e| e.to_string())
}
pub fn inject_startup_failure(root: &Path) {
    if guard_root(root).is_ok()
        && std::fs::read_to_string(root.join("fail-new-startup")).unwrap_or_default()
            == "exit-before-ready"
        && std::env::args().any(|a| a == "--smoke-update-restarted")
    {
        std::process::exit(82);
    }
}

pub fn withhold_health(root: &Path) -> bool {
    guard_root(root).is_ok()
        && std::env::args().any(|a| a == "--smoke-update-restarted")
        && std::fs::read_to_string(root.join("fail-new-startup")).unwrap_or_default()
            == "withhold-ready"
}

pub fn nightly_mode() -> bool {
    std::env::args().any(|a| a == "--smoke-nightly-update")
}
fn argument_root() -> Option<PathBuf> {
    let a: Vec<_> = std::env::args().collect();
    a.iter()
        .position(|x| x == "--pilot-root")
        .and_then(|i| a.get(i + 1))
        .map(PathBuf::from)
}
pub fn night_clock() -> Option<(u32, f64)> {
    if !nightly_mode() {
        return None;
    }
    // A malformed/missing test clock fails closed, never falls back to the real clock.
    let read = (|| -> Result<(u32, f64)> {
        let root = argument_root().ok_or("missing root")?;
        guard_root(&root)?;
        let v: serde_json::Value = serde_json::from_slice(
            &std::fs::read(root.join("night-clock.json")).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        let h = v["hour"]
            .as_u64()
            .filter(|h| *h < 24)
            .ok_or("invalid hour")?;
        let idle = v["idleSeconds"]
            .as_f64()
            .filter(|s| s.is_finite() && *s >= 0.0 && *s <= 86400.0)
            .ok_or("invalid idle")?;
        Ok((h as u32, idle))
    })();
    Some(read.unwrap_or((0, 0.0)))
}
pub fn elapsed_ms(real_elapsed: u64) -> u64 {
    if !nightly_mode() {
        return real_elapsed;
    }
    argument_root()
        .filter(|root| guard_root(root).is_ok())
        .and_then(|root| std::fs::read(root.join("night-clock.json")).ok())
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|clock| clock["elapsedMs"].as_u64())
        .unwrap_or(real_elapsed)
}
pub fn set_night_clock(root: &Path, value: &serde_json::Value) -> Result<()> {
    guard_root(root)?;
    if !nightly_mode() {
        return Err("test clock requires explicit nightly scenario".into());
    }
    if value["hour"].as_u64().is_none_or(|h| h >= 24)
        || value["idleSeconds"]
            .as_f64()
            .is_none_or(|s| !s.is_finite() || !(0.0..=86400.0).contains(&s))
    {
        return Err("invalid test clock".into());
    }
    std::fs::write(root.join("night-clock.json"), value.to_string()).map_err(|e| e.to_string())
}
pub fn record_poll(root: &Path, state: &serde_json::Value) -> Result<()> {
    use std::io::Write;
    guard_root(root)?;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("night-polls.jsonl"))
        .map_err(|e| e.to_string())?;
    writeln!(
        f,
        "{}",
        serde_json::json!({"status":state["status"],"clock":night_clock()})
    )
    .map_err(|e| e.to_string())
}
pub fn poll_count(root: &Path) -> usize {
    std::fs::read_to_string(root.join("night-polls.jsonl"))
        .unwrap_or_default()
        .lines()
        .count()
}
pub fn scenario(root: &Path) -> Result<serde_json::Value> {
    guard_root(root)?;
    let mut v: serde_json::Value = serde_json::from_slice(
        &std::fs::read(root.join("night-scenario.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    v["stagingInputResumed"] =
        serde_json::json!(root.join("night-stage-input-resumed.json").is_file());
    Ok(v)
}
pub fn after_stage(root: &Path) -> Result<()> {
    if !nightly_mode() {
        return Ok(());
    }
    guard_root(root)?;
    let path = root.join("night-clock.json");
    let mut clock: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    if clock["resumeAfterStaging"] == true {
        clock["idleSeconds"] = serde_json::json!(0);
        clock["resumeAfterStaging"] = serde_json::json!(false);
        std::fs::write(&path, clock.to_string()).map_err(|e| e.to_string())?;
        std::fs::write(root.join("night-stage-input-resumed.json"), "true")
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
