//! Backup history exposes owned archives, never active recovery journals.
use super::*;

struct Record {
    path: PathBuf,
    title: &'static str,
    kind: &'static str,
    at: u64,
}
fn regular(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.is_file() && !m.file_type().is_symlink())
        && same_physical_path(path).unwrap_or(false)
}
fn kind(name: &str) -> Option<(&'static str, &'static str)> {
    if name.starts_with("settings-") && name.ends_with(".json") {
        Some(("应用设置", "settings"))
    } else if name.starts_with("config-backup-") && name.ends_with(".toml") {
        Some(("ChatGPT 配置", "codex"))
    } else if name.starts_with("desktop-migration-") || name.starts_with("legacy-recovery-desktop-")
    {
        Some(("Claude Desktop 配置", "archive"))
    } else if name.starts_with("claude-environment-before-") {
        Some(("Claude 配置", "archive"))
    } else {
        None
    }
}
fn settings_value(source: &str) -> Result<Settings> {
    let mut value: Value = serde_json::from_str(source).map_err(err)?;
    if !value.is_object() {
        return Err("备份不是有效设置，原配置未修改".into());
    }
    if value.get("connections").is_none() && value["providers"]["connections"].is_array() {
        value["connections"] = value["providers"]["connections"].clone();
        value["selected"] = value["providers"]["selected"].clone();
    }
    if !value["connections"].is_array() || !value["selected"].is_object() {
        return Err("备份格式不支持直接恢复，请打开位置查看".into());
    }
    serde_json::from_value(value).map_err(err)
}
fn restore_state(kind: &str, valid: bool, target_safe: bool, active: bool) -> &'static str {
    if kind == "archive" {
        "unsupported"
    } else if !valid {
        "invalid-backup"
    } else if !target_safe {
        "unsafe-target"
    } else if active {
        "trace-active"
    } else {
        "ready"
    }
}
impl Pilot {
    pub(super) fn backup_root(&self) -> PathBuf {
        data_storage::backup_storage_root()
            .unwrap_or_else(|| self.root.clone())
            .join("backups")
    }
    pub(super) fn save_backup(
        &self,
        prefix: &str,
        extension: &str,
        source: &str,
    ) -> Result<PathBuf> {
        if ![
            "settings-import",
            "settings-backup",
            "settings-before-restore",
            "config-backup",
            "desktop-migration",
        ]
        .contains(&prefix)
            || !["json", "toml"].contains(&extension)
        {
            return Err("备份类型无效".into());
        }
        let directory = data_storage::prepare_directory(&self.root, &self.backup_root())?;
        let mut nonce = [0u8; 8];
        getrandom::fill(&mut nonce).map_err(err)?;
        let nonce: String = nonce.iter().map(|byte| format!("{byte:02x}")).collect();
        let path = directory.join(format!("{prefix}-{}-{nonce}.{extension}", millis()));
        if path.exists() {
            return Err("备份位置已被占用，原文件未覆盖".into());
        }
        write(&path, source)?;
        credentials::private_permissions(&path, false)?;
        Ok(path)
    }
    fn backup_records(&self) -> Result<Vec<Record>> {
        let mut result = vec![];
        let mut directories = vec![
            self.root.clone(),
            self.root.join("codex"),
            self.root.join("backups"),
            self.backup_root(),
        ];
        directories.sort();
        directories.dedup();
        for directory in directories {
            if !directory.exists() {
                continue;
            }
            if !same_physical_path(&directory)? {
                continue;
            }
            for entry in fs::read_dir(directory).map_err(err)? {
                let entry = entry.map_err(err)?;
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().into_owned();
                let Some((title, kind)) = kind(&name) else {
                    continue;
                };
                if !regular(&path) {
                    continue;
                }
                let at = entry
                    .metadata()
                    .map_err(err)?
                    .modified()
                    .map_err(err)?
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                result.push(Record {
                    path,
                    title,
                    kind,
                    at,
                });
            }
        }
        let mut parents = self
            .root
            .parent()
            .map(Path::to_path_buf)
            .into_iter()
            .collect::<Vec<_>>();
        if let Some(base) = data_storage::backup_storage_root() {
            parents.push(base.join("backups"));
        }
        parents.sort();
        parents.dedup();
        for parent in parents
            .into_iter()
            .filter(|p| same_physical_path(p).unwrap_or(false))
        {
            for entry in fs::read_dir(parent).map_err(err)? {
                let entry = entry.map_err(err)?;
                let name = entry.file_name().to_string_lossy().into_owned();
                if !name
                    .strip_prefix("xwxdeck-reset-backup-")
                    .is_some_and(|s| s.len() == 32 && s.bytes().all(|b| b.is_ascii_hexdigit()))
                {
                    continue;
                }
                let path = entry.path();
                if !same_physical_path(&path)? || !regular(&path.join("job.json")) {
                    continue;
                }
                let Some(source) = read(&path.join("job.json"))? else {
                    continue;
                };
                let Ok(job) = serde_json::from_str::<Value>(&source) else {
                    continue;
                };
                if job["root"].as_str().map(Path::new) != Some(self.root.as_path()) {
                    continue;
                }
                let at = entry
                    .metadata()
                    .map_err(err)?
                    .modified()
                    .map_err(err)?
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                result.push(Record {
                    path,
                    title: "应用数据",
                    kind: "archive",
                    at,
                });
            }
        }
        result.sort_by(|a, b| b.at.cmp(&a.at).then_with(|| a.path.cmp(&b.path)));
        Ok(result)
    }
    fn backup_target(&self, kind: &str) -> Option<PathBuf> {
        match kind {
            "settings" => Some(self.root.join("settings.json")),
            "codex" => Some(self.config_path()),
            _ => None,
        }
    }
    pub(super) fn backup_history(&self) -> Result<Value> {
        self.backup_records()?.into_iter().map(|record| {
            let source = if record.path.is_file() { read(&record.path)? } else { None };
            let valid = source.as_deref().is_some_and(|s| match record.kind {
                "settings" => settings_value(s).is_ok(), "codex" => doc(s).is_ok(), _ => false,
            });
            let target = self.backup_target(record.kind);
            let target_safe = target.as_deref().is_some_and(|path| fs::symlink_metadata(path).is_err() || regular(path));
            let target_source = if target_safe { target.as_deref().map(read).transpose()?.flatten() } else { None };
            let state = restore_state(record.kind, valid, target_safe, self.active());
            Ok(json!({"id":storage::digest(record.path.to_string_lossy().as_bytes()),"title":record.title,"path":record.path,"createdAt":record.at,
                "canRestore":state == "ready","restoreState":state,"sourceDigest":source.as_deref().map(|s| storage::digest(s.as_bytes())),
                "targetDigest":target_source.as_deref().map(|s| storage::digest(s.as_bytes()))}))
        }).collect::<Result<Vec<Value>>>().map(|rows| json!(rows))
    }
    pub(crate) fn backup_folder(&self, id: &str) -> Result<PathBuf> {
        if id.is_empty() {
            return data_storage::prepare_directory(&self.root, &self.backup_root());
        }
        let record = self
            .backup_records()?
            .into_iter()
            .find(|r| storage::digest(r.path.to_string_lossy().as_bytes()) == id)
            .ok_or("备份已不存在，请刷新列表")?;
        Ok(record.path)
    }
    pub(super) fn restore_backup(&mut self, input: &Value) -> Result<Value> {
        if self.active() {
            return Err("请先停止 Trace 再恢复备份".into());
        }
        let record = self
            .backup_records()?
            .into_iter()
            .find(|r| storage::digest(r.path.to_string_lossy().as_bytes()) == text(input, "id"))
            .ok_or("备份已不存在，请刷新列表")?;
        let target = self
            .backup_target(record.kind)
            .ok_or("此备份请通过打开位置查看")?;
        if fs::symlink_metadata(&target).is_ok() && !regular(&target) {
            return Err("目标路径包含链接，原配置未修改".into());
        }
        if !same_physical_path(target.parent().ok_or("配置路径无效")?)? {
            return Err("配置目录包含链接，原配置未修改".into());
        }
        let source = read(&record.path)?.ok_or("备份已不存在")?;
        let before = read(&target)?;
        let digest = before.as_deref().map(|s| storage::digest(s.as_bytes()));
        if storage::digest(source.as_bytes()) != text(input, "sourceDigest")
            || digest.as_deref() != input["targetDigest"].as_str()
        {
            return Err("备份或当前配置已变化，请刷新后重试".into());
        }
        let mut next_settings = if record.kind == "settings" {
            Some(settings_value(&source)?)
        } else {
            doc(&source)?;
            None
        };
        let next = if let Some(settings) = next_settings.as_mut() {
            // Live storage handles retain their current data location.
            settings.trace_root = self.settings.trace_root.clone();
            settings.log_root = self.settings.log_root.clone();
            Self::settings_document(settings)?
        } else {
            source.clone()
        };
        let backup = before
            .as_deref()
            .map(|current| {
                self.save_backup(
                    if record.kind == "settings" {
                        "settings-before-restore"
                    } else {
                        "config-backup"
                    },
                    if record.kind == "settings" {
                        "json"
                    } else {
                        "toml"
                    },
                    current,
                )
            })
            .transpose()?;
        if read(&record.path)?.as_deref() != Some(&source) || read(&target)? != before {
            return Err("恢复前文件发生变化，原文件和备份均保留".into());
        }
        write_checked(&target, before.as_deref().unwrap_or(""), &next)?;
        if let Some(settings) = next_settings {
            self.settings = settings;
            self.settings_problem = None;
            *self.settings_source.lock().map_err(err)? = Some(next);
        }
        Ok(json!({"backupPath":backup,"restored":true}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn history_excludes_live_recovery_journals() {
        for name in [
            "desktop-ledger.json",
            "desktop-recovery.json",
            "claude-desktop-sync-state.json",
            "settings.json",
            "auth.json",
        ] {
            assert!(kind(name).is_none());
        }
        assert_eq!(
            kind("settings-backup-1.json"),
            Some(("应用设置", "settings"))
        );
        assert_eq!(
            kind("config-backup-1.toml"),
            Some(("ChatGPT 配置", "codex"))
        );
    }
    #[test]
    fn old_settings_require_real_configuration_schema() {
        assert!(settings_value("{}").is_err());
        assert!(settings_value(r#"{"providers":{"connections":[],"selected":{}}}"#).is_ok());
        assert!(settings_value(r#"{"connections":[],"selected":{}}"#).is_ok());
    }
    #[test]
    fn restore_reasons_preserve_format_and_target_failures_while_trace_runs() {
        assert_eq!(restore_state("archive", false, false, true), "unsupported");
        assert_eq!(
            restore_state("settings", false, true, true),
            "invalid-backup"
        );
        assert_eq!(restore_state("codex", true, false, true), "unsafe-target");
        assert_eq!(restore_state("settings", true, true, true), "trace-active");
        assert_eq!(restore_state("codex", true, true, false), "ready");
    }
}
