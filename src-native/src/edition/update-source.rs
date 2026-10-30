use super::*;
#[cfg(any(test, not(feature = "update-validation")))]
use base64::{engine::general_purpose::STANDARD, Engine};
#[cfg(any(test, not(feature = "update-validation")))]
use ring::signature;

#[cfg(any(test, not(feature = "update-validation")))]
fn verified_manifest(bytes: &[u8], trust: &Value) -> Result<Value> {
    let envelope: Value = serde_json::from_slice(bytes).map_err(|_| "更新签名格式错误")?;
    if envelope["schemaVersion"] != 1 || envelope["algorithm"] != "Ed25519" {
        return Err("更新缺少可信签名".into());
    }
    let key = trust["keys"]
        .as_array()
        .and_then(|keys| keys.iter().find(|key| key["id"] == envelope["keyId"]))
        .ok_or("更新签名密钥未受信任；尚未配置正式发布公钥")?;
    let public = STANDARD.decode(text(key, "publicKey")).map_err(err)?;
    let payload = STANDARD.decode(text(&envelope, "payload")).map_err(err)?;
    let signed = STANDARD.decode(text(&envelope, "signature")).map_err(err)?;
    if public.len() != 32 || payload.len() > 1024 * 1024 {
        return Err("更新签名数据无效".into());
    }
    signature::UnparsedPublicKey::new(&signature::ED25519, public)
        .verify(&payload, &signed)
        .map_err(|_| "更新签名验证失败")?;
    serde_json::from_slice(&payload).map_err(|_| "更新信息格式错误".into())
}

#[cfg(not(feature = "update-validation"))]
fn feed() -> Result<String> {
    #[cfg(feature = "update-validation")]
    return Ok(crate::update_validation::feed().into());
    #[cfg(not(feature = "update-validation"))]
    {
        let feed = std::env::var("XWX_DECK_UPDATE_SERVER_URL")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "https://xwxdeck.com/updates/stable".into());
        validate_url(&feed)?;
        Ok(feed.trim_end_matches('/').into())
    }
}
pub(super) fn client() -> Result<reqwest::ClientBuilder> {
    let builder = reqwest::Client::builder();
    #[cfg(feature = "update-validation")]
    return crate::update_validation::client(builder);
    #[cfg(not(feature = "update-validation"))]
    Ok(builder)
}
pub(super) async fn manifest(_root: &Path) -> Result<Value> {
    #[cfg(feature = "update-validation")]
    return crate::update_validation::manifest().await;
    #[cfg(not(feature = "update-validation"))]
    {
        let feed = feed()?;
        let response = client()?
            .redirect(reqwest::redirect::Policy::limited(5))
            .timeout(Duration::from_secs(12))
            .build()
            .map_err(err)?
            .get(format!("{feed}/release.json"))
            .send()
            .await
            .map_err(|_| "更新信息请求失败".to_string())?
            .error_for_status()
            .map_err(|e| {
                format!(
                    "更新信息 HTTP {}",
                    e.status().map(|s| s.as_u16()).unwrap_or(0)
                )
            })?;
        validate_url(response.url().as_str())?;
        let final_url = response.url().clone();
        let mut stream = response.bytes_stream();
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(err)?;
            if bytes.len().saturating_add(chunk.len()) > 1024 * 1024 {
                return Err("更新信息过大".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        // Unsigned synthetic fixtures are permitted only by the existing explicit
        // isolated RPC/smoke transport, never for an HTTPS production feed.
        let url = reqwest::Url::parse(&feed).map_err(err)?;
        let isolated = url.scheme() == "http"
            && [Some("127.0.0.1"), Some("localhost")].contains(&url.host_str())
            && final_url.scheme() == "http"
            && [Some("127.0.0.1"), Some("localhost")].contains(&final_url.host_str())
            && std::env::args().any(|a| a == "--rpc" || a == "--smoke");
        let manifest: Value = if isolated {
            serde_json::from_slice(&bytes).map_err(|_| "更新信息格式错误")?
        } else {
            #[cfg(feature = "update-validation")]
            let trust = crate::update_validation::trust()?;
            #[cfg(not(feature = "update-validation"))]
            let trust = serde_json::from_str(include_str!("../../../assets/update-trust.json"))
                .map_err(err)?;
            verified_manifest(&bytes, &trust)?
        };
        let isolated_candidate = std::env::args().any(|arg| arg == "--pilot-root")
            && _root.join(".xwx-rust-pilot").is_file();
        validate_candidate_feed(&manifest, &url, isolated_candidate)?;
        if manifest["schemaVersion"] != 1
            || manifest["channel"]
                != if cfg!(feature = "update-validation") {
                    "mac-validation"
                } else {
                    "release"
                }
            || version(text(&manifest, "version")).is_none()
            || manifest["tag"] != format!("v{}", text(&manifest, "version"))
        {
            return Err("更新清单版本或频道不一致".into());
        }
        Ok(manifest)
    }
}

#[cfg(any(test, not(feature = "update-validation")))]
fn validate_candidate_feed(manifest: &Value, feed: &reqwest::Url, isolated: bool) -> Result<()> {
    let Some(candidate) = manifest.get("candidate") else {
        if feed.host_str() == Some("download.xwxdeck.com")
            && feed.path().starts_with("/candidates/")
        {
            return Err("候选更新缺少来源标识".into());
        }
        return Ok(());
    };
    let commit = text(candidate, "commit");
    let fingerprint = text(candidate, "sourceFingerprint");
    let is_hex = |value: &str, length| {
        value.len() == length
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    };
    let base = format!("https://download.xwxdeck.com/candidates/{commit}");
    if !isolated
        || candidate["schemaVersion"] != 1
        || candidate["only"] != true
        || !is_hex(commit, 40)
        || !is_hex(fingerprint, 64)
        || feed.as_str().trim_end_matches('/') != base
    {
        return Err("候选更新仅限对应来源的显式隔离目录".into());
    }
    let files = manifest["files"].as_array().ok_or("候选制品列表无效")?;
    if files.len() != 3 {
        return Err("候选制品必须覆盖当前三个发行身份".into());
    }
    let mut seen = std::collections::HashSet::new();
    for file in files {
        let name = match (
            text(file, "platform"),
            text(file, "arch"),
            text(file, "kind"),
        ) {
            ("windows", "x64", "installer") => "XwX-Deck-windows-x64-setup.exe",
            ("windows", "x64", "portable") => "XwX-Deck-windows-x64.exe",
            ("darwin", "arm64", "disk-image") => "XwX-Deck-mac-arm64.dmg",
            _ => return Err("候选制品身份无效".into()),
        };
        if text(file, "name") != name
            || text(file, "url") != format!("{base}/{name}")
            || !seen.insert(name)
        {
            return Err("候选制品不属于当前隔离来源".into());
        }
    }
    Ok(())
}

pub(super) fn release_supported(manifest: &Value) -> bool {
    manifest["releaseSeries"]
        == if cfg!(feature = "update-validation") {
            "mac-update-validation-v1"
        } else {
            "native-v1"
        }
}

#[cfg(test)]
mod signing_tests {
    use super::*;
    use ring::signature::{Ed25519KeyPair, KeyPair};

    #[test]
    fn candidate_manifest_requires_matching_source_feed_and_an_isolated_root() {
        let commit = "a".repeat(40);
        let base = format!("https://download.xwxdeck.com/candidates/{commit}");
        let names = [
            (
                "windows",
                "x64",
                "installer",
                "XwX-Deck-windows-x64-setup.exe",
            ),
            ("windows", "x64", "portable", "XwX-Deck-windows-x64.exe"),
            ("darwin", "arm64", "disk-image", "XwX-Deck-mac-arm64.dmg"),
        ];
        let manifest = json!({"candidate":{"schemaVersion":1,"commit":commit,"only":true,"sourceFingerprint":"b".repeat(64)},
            "files":names.iter().map(|(platform,arch,kind,name)|json!({"platform":platform,"arch":arch,"kind":kind,"name":name,"url":format!("{base}/{name}")})).collect::<Vec<_>>()});
        let feed = reqwest::Url::parse(&base).unwrap();
        assert!(validate_candidate_feed(&manifest, &feed, true).is_ok());
        assert!(validate_candidate_feed(&manifest, &feed, false).is_err());
        let stable = reqwest::Url::parse("https://xwxdeck.com/updates/stable").unwrap();
        assert!(validate_candidate_feed(&manifest, &stable, true).is_err());
        assert!(validate_candidate_feed(&json!({"files":[]}), &stable, false).is_ok());
        assert!(validate_candidate_feed(&json!({"files":[]}), &feed, true).is_err());
        let mut altered = manifest.clone();
        altered["candidate"]["commit"] = json!("c".repeat(40));
        assert!(validate_candidate_feed(&altered, &feed, true).is_err());
        altered = manifest.clone();
        altered["files"][0]["url"] =
            json!("https://download.xwxdeck.com/updates/stable/release.json");
        assert!(validate_candidate_feed(&altered, &feed, true).is_err());
        altered = manifest.clone();
        altered["files"][1] = altered["files"][0].clone();
        assert!(validate_candidate_feed(&altered, &feed, true).is_err());
        for missing in 0..3 {
            let mut incomplete = manifest.clone();
            incomplete["files"].as_array_mut().unwrap().remove(missing);
            assert!(validate_candidate_feed(&incomplete, &feed, true).is_err());
        }
        altered = manifest.clone();
        altered["files"][2] = json!({"platform":"darwin","arch":"x64","kind":"disk-image","name":"XwX-Deck-mac-x64.dmg","url":format!("{base}/XwX-Deck-mac-x64.dmg")});
        assert!(validate_candidate_feed(&altered, &feed, true).is_err());
    }

    #[test]
    fn signed_payload_is_authenticated_before_parsing_and_rejects_tampering() {
        // Deterministic, ephemeral test-only key; never a release credential.
        let pair = Ed25519KeyPair::from_seed_unchecked(&[7; 32]).unwrap();
        let trust = json!({"keys":[{"id":"fixture","publicKey":STANDARD.encode(pair.public_key().as_ref())}]});
        let payload = br#"{"version":"1.0.0"}"#;
        let mut envelope = json!({"schemaVersion":1,"algorithm":"Ed25519","keyId":"fixture","payload":STANDARD.encode(payload),"signature":STANDARD.encode(pair.sign(payload).as_ref())});
        let check = |value: &Value| verified_manifest(&serde_json::to_vec(value).unwrap(), &trust);
        assert_eq!(check(&envelope).unwrap()["version"], "1.0.0");
        envelope["payload"] = json!(STANDARD.encode(br#"{"version":"9.0.0"}"#));
        assert!(check(&envelope).is_err());
        envelope["keyId"] = json!("unknown");
        assert!(check(&envelope).is_err());
        assert!(verified_manifest(payload, &trust).is_err());
        assert!(
            verified_manifest(&serde_json::to_vec(&envelope).unwrap(), &json!({"keys":[]}))
                .is_err()
        );
    }
}
