use super::*;
use axum::response::IntoResponse;
use chrono::{DateTime, Local, Utc};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
#[path = "trace_classification.rs"]
mod trace_classification;
#[path = "trace_content.rs"]
mod trace_content;
#[path = "trace_pricing.rs"]
mod trace_pricing;
#[cfg(target_os = "windows")]
use crate::windows_reveal;
#[cfg(test)]
use trace_pricing::{model_cost, model_cost_parts};
use trace_pricing::{needs_ark_cost_repair, repaired_cost_point, usage_cost_point};

pub(super) fn provider_price(store: &Store, model: &str, snapshot: Value) -> Value {
    trace_pricing::provider_price(&store.lock().unwrap().prices, model, snapshot)
}
pub(super) fn reference_price(store: &Store, model: &str) -> Value {
    trace_pricing::reference_price(&store.lock().unwrap().prices, model)
}
pub(super) fn freeze_reference_price(store: &Store, record: &mut Value) {
    record["referencePriceVersion"] = json!(1);
    record["referencePrice"] = reference_price(store, text(&record["request"], "model"));
}
pub(super) type Store = Arc<std::sync::Mutex<TraceStore>>;
pub(super) fn iso(at: u128) -> String {
    DateTime::<Utc>::from_timestamp_millis(at as i64)
        .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default()
}
pub(super) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
// Measure the exact wire size without allocating a second JSON body.
#[derive(Default)]
struct JsonByteCount(usize);
impl std::io::Write for JsonByteCount {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0 = self.0.saturating_add(bytes.len());
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn json_byte_len(value: &Value) -> Result<usize> {
    let mut count = JsonByteCount::default();
    serde_json::to_writer(&mut count, value).map_err(err)?;
    Ok(count.0)
}
fn empty_index() -> Value {
    json!({"version":1,"sessions":[]})
}
fn usage_summary(session: &Value) -> Value {
    let mut summary = json!({});
    for key in ["totalTokens", "dailyUsage", "recentRatePoints"] {
        if let Some(value) = session.get(key) {
            summary[key] = value.clone();
        }
    }
    summary
}
// Protect only the conversations with requests in flight, not every session
// merely because the Gateway is enabled. The last completion applies 0 GB.
pub(super) struct DetailLease {
    store: Store,
    id: String,
}
impl DetailLease {
    pub fn new(store: Store, key: &str) -> Self {
        let id = format!("session-{}", &digest(key.as_bytes())[..24]);
        *store
            .lock()
            .unwrap()
            .recording
            .entry(id.clone())
            .or_default() += 1;
        Self { store, id }
    }
}
impl Drop for DetailLease {
    fn drop(&mut self) {
        let mut store = self.store.lock().unwrap();
        if let Some(count) = store.recording.get_mut(&self.id) {
            *count -= 1;
            if *count == 0 {
                store.recording.remove(&self.id);
            }
        }
        store.apply_retention();
    }
}
fn trace_error(record: &Value) -> bool {
    if record["auxiliary"] == "count" && record["response"]["statusCode"] == 404 {
        return false;
    }
    !record["error"].is_null()
        || record["response"]["statusCode"]
            .as_u64()
            .is_some_and(|s| s >= 400)
}
fn error_count(path: &Path) -> Result<usize> {
    use std::io::{BufRead, BufReader};
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(err(error)),
    };
    let mut count = 0;
    for line in BufReader::new(file).lines() {
        let line = line.map_err(err)?;
        if line.trim().is_empty() {
            continue;
        }
        let row = trace_content::decode(path, serde_json::from_str(&line).map_err(err)?)?;
        count += usize::from(trace_error(&row));
    }
    Ok(count)
}
fn usage(value: &Value, wire: &str) -> Value {
    trace_usage::normalize(value, wire)
}
fn record_usage(value: &Value, wire: &str, record: &Value) -> Value {
    let request = if record["upstream"]["requestBody"].is_object() {
        &record["upstream"]["requestBody"]
    } else {
        &record["request"]["body"]
    };
    trace_usage::normalize_for_request(value, wire, request)
}
pub(super) fn load_prices(root: &Path) -> Vec<Value> {
    let bundled: Vec<Value> = crate::embedded_assets::prices()
        .ok()
        .and_then(|text| serde_json::from_str(text).ok())
        .unwrap_or_default();
    let cache = read(&root.join("pricing-cache/models-dev-pricing.json"))
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .filter(|v| v["version"] == 2)
        .unwrap_or(Value::Null);
    let rows: Vec<Value> = cache["rules"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| {
            r["match"] == "exact"
                && r["source"] == "models.dev"
                && r["referenceOnly"] == true
                && r["tokens"]
                    .as_array()
                    .is_some_and(|a| a.len() == 1 && a[0].is_string())
                && ["input", "output"]
                    .iter()
                    .all(|k| r[*k].as_f64().is_some_and(|n| n.is_finite() && n >= 0.0))
        })
        .cloned()
        .map(model_metadata::normalize_cached_price)
        .collect();
    if rows.is_empty() {
        bundled
    } else {
        rows
    }
}

fn accumulate_cache_hit_usage(stats: &mut Value, usage: &Value) {
    if !stats.is_object() {
        *stats =
            json!({"inputTokens":0,"cacheReadTokens":0,"knownRequests":0,"excludedRequests":0});
    }
    let missing = |field| {
        usage["incompleteFields"]
            .as_array()
            .is_some_and(|fields| fields.iter().any(|f| f == field))
    };
    let invalid = usage["invalidFields"]
        .as_array()
        .is_some_and(|fields| fields.iter().any(|f| f == "input" || f == "cacheRead"));
    let input = usage["inputTotalTokens"].as_u64().filter(|_| {
        usage["inputIncludesCache"] == true || (!missing("cacheRead") && !missing("cacheWrite"))
    });
    let pair = input
        .zip(usage["cacheReadTokens"].as_u64())
        .filter(|(i, r)| {
            !invalid && !missing("cacheRead") && i >= r && *i <= 9_007_199_254_740_991
        });
    if let Some((input, read)) = pair {
        stats["inputTokens"] = json!(stats["inputTokens"].as_u64().unwrap_or(0) + input);
        stats["cacheReadTokens"] = json!(stats["cacheReadTokens"].as_u64().unwrap_or(0) + read);
        stats["knownRequests"] = json!(stats["knownRequests"].as_u64().unwrap_or(0) + 1);
    } else {
        stats["excludedRequests"] = json!(stats["excludedRequests"].as_u64().unwrap_or(0) + 1);
    }
}

fn accumulate_model_usage(by_model: &mut Value, record: &Value) {
    let model = text(&record["request"], "model");
    let u = &record["usage"];
    let m = &mut by_model[model];
    let had_usage = m.is_object();
    if !m.is_object() {
        *m = json!({"version":2,"input":0,"inputTotal":0,"inputTotalComplete":true,"output":0,"cacheRead":0,"cacheCreation":0,"total":0,"apiType":record["request"]["apiType"]});
    }
    let point = &record["costSnapshot"];
    let previous = m["capturedCost"]["cost"].as_f64();
    let known = point["knownCostUsd"].as_f64();
    let first = m.get("capturedCost").is_none();
    m["capturedCost"] = json!({
        "cost": if previous.is_some() || known.is_some() { Some(previous.unwrap_or(0.0) + known.unwrap_or(0.0)) } else { None },
        "complete": (first || m["capturedCost"]["complete"] == true) && point["costComplete"] == true
    });
    if m["inputTotal"].is_null() {
        m["inputTotalComplete"] = json!(false);
    }
    if !m["knownFieldCounts"].is_object() {
        // If raw history is unavailable, retain a known legacy aggregate,
        // including explicit zero. Its coverage is a lower bound of one.
        let mut coverage = json!({});
        for (field, key) in [
            ("input", "input"),
            ("cacheRead", "cacheRead"),
            ("cacheWrite", "cacheCreation"),
            ("output", "output"),
            ("total", "total"),
        ] {
            let known = had_usage
                && m[key].as_u64().is_some_and(|n| {
                    n > 0
                        || !m["incompleteFields"]
                            .as_array()
                            .is_some_and(|a| a.iter().any(|f| f == field))
                            && !m["invalidFields"]
                                .as_array()
                                .is_some_and(|a| a.iter().any(|f| f == field))
                });
            coverage[field] = json!(u64::from(known));
        }
        m["knownFieldCounts"] = coverage;
    }
    for (field, key) in [
        ("input", "inputUncachedTokens"),
        ("cacheRead", "cacheReadTokens"),
        ("cacheWrite", "cacheCreationTokens"),
        ("output", "outputTokens"),
        ("total", "totalTokens"),
    ] {
        let valid = u[key].as_u64().is_some()
            && !u["invalidFields"]
                .as_array()
                .is_some_and(|a| a.iter().any(|f| f == field));
        m["knownFieldCounts"][field] =
            json!(m["knownFieldCounts"][field].as_u64().unwrap_or(0) + u64::from(valid));
    }
    for (key, value) in [
        ("input", "inputUncachedTokens"),
        ("inputTotal", "inputTotalTokens"),
        ("output", "outputTokens"),
        ("cacheRead", "cacheReadTokens"),
        ("cacheCreation", "cacheCreationTokens"),
        ("total", "totalTokens"),
    ] {
        m[key] = json!(m[key].as_u64().unwrap_or(0) + u[value].as_u64().unwrap_or(0));
    }
    m["reasoningComplete"] = json!(
        (m["reasoningComplete"].is_null() || m["reasoningComplete"] == true)
            && (u["reasoningTokens"].is_number() || u["outputTokens"] == 0)
    );
    let mut incomplete = m["incompleteFields"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    for field in u["incompleteFields"].as_array().into_iter().flatten() {
        if !incomplete.contains(field) {
            incomplete.push(field.clone());
        }
    }
    for (field, key) in [
        ("input", "inputUncachedTokens"),
        ("cacheRead", "cacheReadTokens"),
        ("cacheWrite", "cacheCreationTokens"),
        ("output", "outputTokens"),
        ("total", "totalTokens"),
    ] {
        if u[key].as_u64().is_none() && !incomplete.iter().any(|v| v == field) {
            incomplete.push(json!(field));
        }
    }
    m["incompleteFields"] = json!(incomplete);
    let mut invalid = m["invalidFields"].as_array().cloned().unwrap_or_default();
    for field in u["invalidFields"].as_array().into_iter().flatten() {
        if !invalid.contains(field) {
            invalid.push(field.clone());
        }
    }
    m["invalidFields"] = json!(invalid);
    if u["inputTotalTokens"].as_u64().is_none()
        || u["inputIncludesCache"] != true
            && m["incompleteFields"]
                .as_array()
                .is_some_and(|a| a.iter().any(|v| v == "cacheRead" || v == "cacheWrite"))
    {
        m["inputTotalComplete"] = json!(false);
    } else if m["inputTotalComplete"].is_null() {
        m["inputTotalComplete"] = json!(true);
    }
    for (target, source) in [
        ("cacheCreation5m", "cacheCreation5mTokens"),
        ("cacheCreation1h", "cacheCreation1hTokens"),
        ("reasoning", "reasoningTokens"),
    ] {
        if u[source].as_u64().is_some() || m[target].as_u64().is_some() {
            m[target] = json!(m[target].as_u64().unwrap_or(0) + u[source].as_u64().unwrap_or(0));
        }
    }
}

fn display_record(prices: &[Value], mut row: Value) -> Value {
    // Enrich old records in memory; historical JSONL remains byte-identical.
    trace_compaction::annotate(&mut row);
    if row["startedAtMs"].as_u64().is_none() {
        if let Ok(at) = chrono::DateTime::parse_from_rfc3339(text(&row, "startedAt")) {
            row["startedAtMs"] = json!(at.timestamp_millis());
        }
    }
    if needs_ark_cost_repair(&row["costSnapshot"])
        || (row["costSnapshot"]["version"] == 1 && row["costSnapshot"]["costComplete"] == false)
    {
        let evidence = &row["usageEvidence"]["upstream"];
        if evidence["raw"].is_object() {
            let wire = text(evidence, "protocol").to_owned();
            row["usage"] = record_usage(&json!({"usage":evidence["raw"]}), &wire, &row);
        }
        row["costSnapshot"] = repaired_cost_point(prices, &row);
        row["costViewBasis"] = json!("frozen-rate-correction");
    } else if row["costSnapshot"]["version"] != 1 {
        let mut raw = row["usageEvidence"]["upstream"]["raw"].clone();
        if !raw.is_object() {
            raw = row["sse"]["events"]
                .as_array()
                .into_iter()
                .flatten()
                .rev()
                .find_map(|e| {
                    e["json"]["response"]
                        .get("usage")
                        .or_else(|| e["json"].get("usage"))
                        .filter(|v| v.is_object())
                        .cloned()
                })
                .unwrap_or(Value::Null);
        }
        if raw.is_object() {
            let wire = row["usageEvidence"]["upstream"]["protocol"]
                .as_str()
                .or_else(|| row["protocol"].as_str())
                .unwrap_or("openai-responses")
                .to_owned();
            row["usage"] = record_usage(&json!({"usage":raw}), &wire, &row);
        }
        row["costViewBasis"] = json!("legacy-current-reference");
        row["costSnapshot"] = usage_cost_point(prices, &row);
    }
    row
}

// Small, read-only per-file indexes. Bodies are never retained by the page cache.
#[derive(Clone)]
struct TraceFileRow {
    summary: Value,
    offset: u64,
    length: usize,
}
struct CachedTraceFile {
    price_key: String,
    length: u64,
    modified: Option<std::time::SystemTime>,
    rows: Arc<Vec<TraceFileRow>>,
    summary_bytes: usize,
    last_used: u128,
}
fn cache_trace_file(
    cache: &mut BTreeMap<PathBuf, CachedTraceFile>,
    path: &Path,
    entry: CachedTraceFile,
) {
    const MAX_SUMMARY_BYTES: usize = 8 * 1024 * 1024;
    cache.remove(path);
    if entry.summary_bytes > MAX_SUMMARY_BYTES {
        return;
    }
    while cache.len() >= 8
        || cache.values().map(|file| file.summary_bytes).sum::<usize>() + entry.summary_bytes
            > MAX_SUMMARY_BYTES
    {
        let Some(oldest) = cache
            .iter()
            .min_by_key(|(_, file)| file.last_used)
            .map(|(path, _)| path.clone())
        else {
            break;
        };
        cache.remove(&oldest);
    }
    cache.insert(path.to_path_buf(), entry);
}
struct TracePageReader {
    price_key: String,
    root: PathBuf,
    prices: Vec<Value>,
    sessions: Vec<Value>,
    files: BTreeMap<PathBuf, (u64, Option<std::time::SystemTime>)>,
    cache: Arc<std::sync::Mutex<BTreeMap<PathBuf, CachedTraceFile>>>,
}
fn trace_row_summary(record: &Value) -> Value {
    let mut summary = json!({"summaryOnly":true});
    for key in [
        "id",
        "sessionId",
        "physicalSessionId",
        "turn",
        "logicalTurn",
        "mainOrdinal",
        "startedAt",
        "startedAtMs",
        "completedAt",
        "durationMs",
        "source",
        "client",
        "clientConversationKey",
        "provider",
        "providerTransition",
        "auxiliary",
        "subagent",
        "subagentInfo",
        "compact",
        "routedBy",
        "usage",
        "costSnapshot",
        "error",
    ] {
        if let Some(value) = record.get(key) {
            summary[key] = value.clone();
        }
    }
    for key in ["model", "apiType", "method", "path", "headers"] {
        if let Some(value) = record["request"].get(key) {
            summary["request"][key] = value.clone();
        }
    }
    for key in ["statusCode", "statusMessage", "protocolEnded", "bodyEnded"] {
        if let Some(value) = record["response"].get(key) {
            summary["response"][key] = value.clone();
        }
    }
    for key in ["baseUrl", "url"] {
        if let Some(value) = record["upstream"].get(key) {
            summary["upstream"][key] = value.clone();
        }
    }
    summary
}
impl TracePageReader {
    fn file_rows(&self, path: &Path) -> Result<Arc<Vec<TraceFileRow>>> {
        use std::io::{BufRead, BufReader, Read};
        let file = fs::File::open(path).map_err(err)?;
        let metadata = file.metadata().map_err(err)?;
        let (length, modified) = self
            .files
            .get(path)
            .copied()
            .unwrap_or((metadata.len(), metadata.modified().ok()));
        if metadata.len() < length {
            return Err("会话日志已变化，请重新加载".into());
        }
        if let Some(cached) = self.cache.lock().map_err(err)?.get_mut(path) {
            if cached.length == length
                && cached.modified == modified
                && cached.price_key == self.price_key
            {
                cached.last_used = millis();
                return Ok(cached.rows.clone());
            }
        }
        let mut reader = BufReader::new(file.take(length));
        let mut line = String::new();
        let mut offset = 0;
        let mut rows = Vec::new();
        let mut summary_bytes = 0usize;
        let mut prices_by_model = BTreeMap::new();
        loop {
            line.clear();
            let length = reader.read_line(&mut line).map_err(err)?;
            if length == 0 {
                break;
            }
            if !line.trim().is_empty() {
                let mut record: Value = serde_json::from_str(&line).map_err(err)?;
                let annotation = if record["_traceContent"]["version"] == 1 {
                    // Current captures already carry their classification.
                    json!({})
                } else {
                    trace_classification::annotations(&record)
                };
                for field in ["auxiliary", "source", "clientConversationKey"] {
                    if let Some(value) = annotation.get(field) {
                        record[field] = value.clone();
                    }
                }
                let prices = prices_by_model
                    .entry(text(&record["request"], "model").to_owned())
                    .or_insert_with(|| {
                        trace_pricing::reference_price(
                            &self.prices,
                            text(&record["request"], "model"),
                        )
                    });
                let prices = std::slice::from_ref(prices);
                let record = if record.get("_traceContent").is_some()
                    && (record["costSnapshot"]["version"] != 1
                        || record["costSnapshot"]["costComplete"] == false
                        || needs_ark_cost_repair(&record["costSnapshot"]))
                {
                    display_record(prices, trace_content::decode(path, record)?)
                } else {
                    display_record(prices, record)
                };
                let summary = trace_row_summary(&record);
                summary_bytes = summary_bytes.saturating_add(json_byte_len(&summary)?);
                rows.push(TraceFileRow {
                    summary,
                    offset,
                    length,
                });
            }
            offset += length as u64;
        }
        let rows = Arc::new(rows);
        let mut cache = self.cache.lock().map_err(err)?;
        cache_trace_file(
            &mut cache,
            path,
            CachedTraceFile {
                price_key: self.price_key.clone(),
                length,
                modified,
                rows: rows.clone(),
                summary_bytes,
                last_used: millis(),
            },
        );
        Ok(rows)
    }
    fn page(
        &self,
        id: &str,
        offset: Option<usize>,
        before: Option<usize>,
        limit: usize,
        summary_only: bool,
        request_id: Option<&str>,
    ) -> Result<Option<Value>> {
        use std::io::{Read, Seek, SeekFrom};
        let Some(session) = self.sessions.iter().find(|s| s["id"] == id) else {
            return Ok(None);
        };
        // Keep immutable cached indexes alive, then sort borrowed rows. A single
        // detail read must not clone every summary in a long conversation.
        let mut files = Vec::new();
        for member in self.sessions.iter().filter(|s| {
            s["id"] == id
                || (!text(session, "clientConversationKey").is_empty()
                    && s["clientConversationKey"] == session["clientConversationKey"]
                    && s["source"] == session["source"])
        }) {
            let file = PathBuf::from(member["jsonlPath"].as_str().ok_or("索引路径无效")?);
            if file.parent() != Some(self.root.as_path())
                || file.canonicalize().map_err(err)?.parent()
                    != Some(self.root.canonicalize().map_err(err)?.as_path())
            {
                return Err("索引路径越界，已拒绝读取".into());
            }
            let rows = self.file_rows(&file)?;
            files.push((file, rows));
        }
        let mut records: Vec<_> = files
            .iter()
            .flat_map(|(file, rows)| rows.iter().map(move |row| (row, file)))
            .collect();
        records.sort_by(|(a, _), (b, _)| {
            a.summary["startedAt"]
                .as_str()
                .unwrap_or("")
                .cmp(b.summary["startedAt"].as_str().unwrap_or(""))
                .then_with(|| {
                    a.summary["id"]
                        .as_str()
                        .unwrap_or("")
                        .cmp(b.summary["id"].as_str().unwrap_or(""))
                })
        });
        let mut main_ordinal = 0;
        let ordinals: Vec<_> = records
            .iter()
            .map(|(row, _)| {
                if row.summary["auxiliary"].is_null() && row.summary["subagent"].is_null() {
                    main_ordinal += 1;
                    Some(main_ordinal)
                } else {
                    None
                }
            })
            .collect();
        let offset = if let Some(request_id) = request_id {
            let Some(index) = records
                .iter()
                .position(|(r, _)| r.summary["id"] == request_id)
            else {
                return Ok(None);
            };
            Some(index)
        } else {
            offset
        };
        let total = records.len();
        let limit = if request_id.is_some() {
            1
        } else {
            limit.clamp(1, 200)
        };
        let tail = request_id.is_none() && (before.is_some() || offset.is_none());
        let upper = before.unwrap_or(total).min(total);
        let offset = if tail {
            upper.saturating_sub(limit)
        } else {
            offset.unwrap_or(0).min(total)
        };
        let end = if tail {
            upper
        } else {
            (offset + limit).min(total)
        };
        let indexes: Vec<_> = if tail {
            (offset..end).rev().collect()
        } else {
            (offset..end).collect()
        };
        let single = indexes.len() == 1;
        let mut traces = Vec::new();
        let mut bytes = 0;
        for index in indexes {
            let (row, path) = &records[index];
            let mut record = if summary_only {
                row.summary.clone()
            } else {
                let mut file = fs::File::open(path).map_err(err)?;
                file.seek(SeekFrom::Start(row.offset)).map_err(err)?;
                let mut data = vec![0; row.length];
                file.read_exact(&mut data).map_err(err)?;
                let mut record = display_record(
                    &self.prices,
                    trace_content::decode(path, serde_json::from_slice(&data).map_err(err)?)?,
                );
                for key in ["auxiliary", "mainOrdinal"] {
                    if let Some(value) = row.summary.get(key) {
                        record[key] = value.clone();
                    }
                }
                record
            };
            record["physicalSessionId"] = row.summary["sessionId"].clone();
            record["sessionId"] = json!(id);
            record["turn"] = json!(index + 1);
            if let Some(ordinal) = ordinals[index] {
                record["mainOrdinal"] = json!(ordinal);
            }
            // The budget applies to expanded API data, not compressed disk bytes.
            // A single record is always admitted, so avoid allocating a second
            // multi-megabyte JSON string just to count bytes for no next record.
            let size = if single { 0 } else { json_byte_len(&record)? };
            if !traces.is_empty() && bytes + size > 24 * 1024 * 1024 {
                break;
            }
            bytes += size;
            if !summary_only {
                record.as_object_mut().unwrap().remove("summaryOnly");
            }
            traces.push(record);
        }
        if tail {
            traces.reverse();
        }
        let offset = if tail { end - traces.len() } else { offset };
        let end = offset + traces.len();
        Ok(Some(
            json!({"id":id,"traces":traces,"offset":offset,"limit":limit,"total":total,"hasMoreBefore":offset>0,"hasMoreAfter":end<total}),
        ))
    }
}

pub(super) struct TraceStore {
    data_root: PathBuf,
    pub root: PathBuf,
    pub prices: Vec<Value>,
    pub active: bool,
    pub theme: String,
    pub language: String,
    pub events: tokio::sync::broadcast::Sender<String>,
    index: Value,
    index_source: Option<String>,
    legacy_annotations: BTreeMap<String, Value>,
    legacy_costs: BTreeMap<String, Value>,
    page_cache: Arc<std::sync::Mutex<BTreeMap<PathBuf, CachedTraceFile>>>,
    writer: Option<super::trace_writer::Lease>,
    pub limit: u64,
    pub auto_cleanup: bool,
    recording: BTreeMap<String, usize>,
    pub retention_notice: Option<String>,
    pub read_problem: Option<String>,
    background_history: bool,
    history_owner: std::sync::Weak<std::sync::Mutex<TraceStore>>,
    history_generation: Arc<AtomicU64>,
    history_running: Arc<std::sync::atomic::AtomicBool>,
    history_full: bool,
    history_pending: std::collections::BTreeSet<String>,
    pub history_revision: u64,
}
impl TraceStore {
    pub fn resource_counts(&self) -> Value {
        let cache = self.page_cache.lock().unwrap();
        json!({"eventReceivers":self.events.receiver_count(),"pageCacheFiles":cache.len(),
            "pageCacheBytes":cache.values().map(|entry|entry.summary_bytes).sum::<usize>(),
            "recordingSessions":self.recording.len(),"historyRunning":self.history_running.load(Ordering::SeqCst)})
    }
    #[cfg(test)]
    pub fn open(root: PathBuf, limit: u64, auto: bool, data_root: &Path) -> Result<Store> {
        Self::open_history(root, limit, auto, data_root, false)
    }
    pub fn open_background(
        root: PathBuf,
        limit: u64,
        auto: bool,
        data_root: &Path,
    ) -> Result<Store> {
        Self::open_history(root, limit, auto, data_root, true)
    }
    fn open_history(
        root: PathBuf,
        limit: u64,
        auto: bool,
        data_root: &Path,
        background_history: bool,
    ) -> Result<Store> {
        let source = read(&root.join("index.json"))?;
        let index_source = source.clone();
        let (index, read_problem) = match source {
            Some(source) => match serde_json::from_str::<Value>(&source) {
                Ok(value) if value["sessions"].is_array() => (value, None),
                _ => (
                    empty_index(),
                    Some("Trace 索引损坏，原文件已保留；可在设置中手动修复索引".into()),
                ),
            },
            None => (empty_index(), None),
        };
        // Read legacy annotation evidence once. This is a view projection:
        // never rewrite JSONL or repair a missing/damaged index automatically.
        let mut legacy_annotations = BTreeMap::new();
        for session in index["sessions"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|_| !background_history)
        {
            if session["captureClassificationVersion"] == 1 {
                continue;
            }
            let path = PathBuf::from(text(session, "jsonlPath"));
            if path.parent() != Some(root.as_path()) {
                continue;
            }
            if let Ok(file) = fs::File::open(&path) {
                use std::io::{BufRead, BufReader};
                let mut line = String::new();
                if BufReader::new(file).read_line(&mut line).is_ok() {
                    if let Ok(record) = serde_json::from_str::<Value>(&line)
                        .map_err(err)
                        .and_then(|record| trace_content::decode(&path, record))
                    {
                        legacy_annotations.insert(
                            text(session, "id").into(),
                            trace_classification::annotations(&record),
                        );
                    }
                }
            }
        }
        let store = Arc::new(std::sync::Mutex::new(Self {
            data_root: data_root.to_path_buf(),
            prices: load_prices(data_root),
            root,
            active: false,
            theme: "day".into(),
            language: crate::language::system_language(),
            events: tokio::sync::broadcast::channel(16).0,
            index,
            index_source,
            legacy_annotations,
            legacy_costs: BTreeMap::new(),
            page_cache: Arc::new(std::sync::Mutex::new(BTreeMap::new())),
            writer: None,
            limit,
            auto_cleanup: auto,
            recording: BTreeMap::new(),
            retention_notice: None,
            read_problem,
            background_history,
            history_owner: std::sync::Weak::new(),
            history_generation: Arc::new(AtomicU64::new(0)),
            history_running: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            history_full: false,
            history_pending: std::collections::BTreeSet::new(),
            history_revision: 0,
        }));
        {
            let mut state = store.lock().map_err(err)?;
            state.history_owner = Arc::downgrade(&store);
            state.refresh_legacy_costs();
        }
        if limit == 0 && !background_history {
            store.lock().map_err(err)?.apply_retention();
        }
        Ok(store)
    }
    pub(super) fn begin_writer(&mut self) -> Result<()> {
        let writer = super::trace_writer::Lease::acquire(&self.root)?;
        // Another writer may have completed while this window was read-only.
        // Adopt its complete index only after taking exclusive ownership.
        let source = read(&self.root.join("index.json"))?;
        let index = source
            .as_ref()
            .map(|s| {
                serde_json::from_str::<Value>(s)
                    .map_err(|_| "Trace 索引损坏，请先手动检查并修复".to_string())
            })
            .transpose()?
            .unwrap_or_else(empty_index);
        if !index["sessions"].is_array() {
            return Err("Trace 索引无效，未开始写入".into());
        }
        let changed = self.index != index;
        self.index = index;
        self.index_source = source;
        if changed {
            self.refresh_legacy_costs();
        }
        self.read_problem = None;
        self.writer = Some(writer);
        Ok(())
    }
    pub(super) fn end_writer(&mut self) {
        self.writer = None;
    }
    fn validate_index(&self) -> Result<()> {
        if read(&self.root.join("index.json"))? != self.index_source {
            return Err("Trace 索引已被外部修改，未覆盖历史；请停止 Trace 后重新检查索引".into());
        }
        Ok(())
    }
    fn with_writer<T>(
        &mut self,
        check_index: bool,
        operation: impl FnOnce(&mut Self) -> Result<T>,
    ) -> Result<T> {
        let temporary = self.writer.is_none();
        if temporary {
            self.writer = Some(super::trace_writer::Lease::acquire(&self.root)?);
        }
        let result = (|| {
            self.writer.as_ref().unwrap().validate()?;
            if check_index {
                self.validate_index()?;
            }
            operation(self)
        })();
        if self.active {
            if let Err(ref error) = result {
                self.read_problem = Some(error.clone());
            }
        }
        if temporary {
            self.writer = None;
        }
        result
    }
    pub fn totals(&self) -> (usize, u64, u64) {
        let sessions = self.index["sessions"].as_array().unwrap();
        (
            sessions.len(),
            sessions
                .iter()
                .filter_map(|s| s["traceCount"].as_u64())
                .sum(),
            self.size(),
        )
    }
    fn size(&self) -> u64 {
        fs::read_dir(&self.root)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
            .filter(|e| {
                !["trace-writer.lock", ".native-trace-writer.lock", "tap.lock"]
                    .contains(&e.file_name().to_string_lossy().as_ref())
            })
            .filter_map(|e| e.metadata().ok())
            .map(|m| m.len())
            .sum()
    }
    /// Rebuild only display aggregates; raw logs, index bytes and frozen prices
    /// are untouched. Legacy rows use today's explicitly labelled reference.
    pub(super) fn refresh_legacy_costs(&mut self) {
        if self.background_history {
            self.queue_history(None);
            return;
        }
        let mut job = LegacyHistory {
            root: self.root.clone(),
            index: self.index.clone(),
            prices: self.prices.clone(),
            legacy_costs: BTreeMap::new(),
            legacy_annotations: BTreeMap::new(),
        };
        job.refresh(|| false);
        self.legacy_costs = job.legacy_costs;
        self.legacy_annotations.extend(job.legacy_annotations);
    }
    fn refresh_legacy_session(&mut self, id: &str) {
        if self.background_history {
            self.queue_history(Some(id));
        } else {
            self.refresh_legacy_costs();
        }
    }
    fn queue_history(&mut self, session: Option<&str>) {
        if let Some(id) = session {
            self.history_pending.insert(id.to_owned());
        } else {
            self.history_full = true;
            self.history_generation.fetch_add(1, Ordering::SeqCst);
        }
        if self.history_running.swap(true, Ordering::SeqCst) {
            return;
        }
        let current = self.history_generation.clone();
        let running = self.history_running.clone();
        let owner = self.history_owner.clone();
        std::thread::spawn(move || loop {
            let Some(store) = owner.upgrade() else {
                return;
            };
            let Ok(mut state) = store.lock() else {
                return;
            };
            if !state.history_full && state.history_pending.is_empty() {
                running.store(false, Ordering::SeqCst);
                return;
            }
            let generation = current.load(Ordering::SeqCst);
            let full = state.history_full;
            state.history_full = false;
            let pending = std::mem::take(&mut state.history_pending);
            let mut index = state.index.clone();
            if !full {
                index["sessions"]
                    .as_array_mut()
                    .unwrap()
                    .retain(|s| pending.contains(text(s, "id")));
            }
            let mut job = LegacyHistory {
                root: state.root.clone(),
                index,
                prices: state.prices.clone(),
                legacy_costs: BTreeMap::new(),
                legacy_annotations: BTreeMap::new(),
            };
            drop(state);
            drop(store);
            job.refresh(|| {
                current.load(Ordering::SeqCst) != generation || owner.strong_count() == 0
            });
            let Some(store) = owner.upgrade() else {
                return;
            };
            let Ok(mut state) = store.lock() else {
                return;
            };
            if current.load(Ordering::SeqCst) != generation {
                continue;
            }
            // Publish only sessions that still match this snapshot. An
            // append or deletion must never be overwritten by old work.
            let sessions: BTreeMap<_, _> = state.index["sessions"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|s| (text(s, "id").to_owned(), s))
                .collect();
            let snapshot: BTreeMap<_, _> = job.index["sessions"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|s| (text(s, "id").to_owned(), s))
                .collect();
            let unchanged =
                |id: &String| sessions.contains_key(id) && sessions.get(id) == snapshot.get(id);
            job.legacy_costs.retain(|id, _| unchanged(id));
            job.legacy_annotations.retain(|id, _| unchanged(id));
            state
                .legacy_costs
                .retain(|id, _| !snapshot.contains_key(id));
            state
                .legacy_annotations
                .retain(|id, _| !snapshot.contains_key(id));
            state.legacy_costs.extend(job.legacy_costs);
            state.legacy_annotations.extend(job.legacy_annotations);
            state.history_revision = state.history_revision.wrapping_add(1);
            let pending = state.history_full || !state.history_pending.is_empty();
            if !pending {
                running.store(false, Ordering::SeqCst);
            }
            if state.limit == 0 && !pending {
                state.apply_retention();
            }
            let _ = state.events.send("event: reset\ndata: {}\n\n".into());
            if !pending {
                return;
            }
        });
    }
    fn finish_history_before_retention(&mut self) {
        if self.background_history && self.history_running.load(Ordering::SeqCst) {
            // An explicit detail deletion must retain the completed accounting
            // view before unlinking its source. Cancel the older reader first.
            self.history_generation.fetch_add(1, Ordering::SeqCst);
            self.history_full = false;
            self.history_pending.clear();
            self.background_history = false;
            self.refresh_legacy_costs();
            self.background_history = true;
        }
    }
    fn release_session_views(&mut self, id: &str) {
        self.legacy_costs.remove(id);
        self.legacy_annotations.remove(id);
        self.history_pending.remove(id);
        self.page_cache
            .lock()
            .unwrap()
            .retain(|path, _| path.file_stem().is_none_or(|stem| stem != id));
    }
}

struct LegacyHistory {
    root: PathBuf,
    index: Value,
    prices: Vec<Value>,
    legacy_costs: BTreeMap<String, Value>,
    legacy_annotations: BTreeMap<String, Value>,
}
impl LegacyHistory {
    fn refresh(&mut self, cancelled: impl Fn() -> bool) {
        self.legacy_costs.clear();
        for session in self.index["sessions"].as_array().into_iter().flatten() {
            if cancelled() {
                return;
            }
            let path = PathBuf::from(text(session, "jsonlPath"));
            if path.parent() != Some(self.root.as_path()) {
                continue;
            }
            if session["captureClassificationVersion"] != 1 {
                use std::io::{BufRead, BufReader};
                if let Ok(file) = fs::File::open(&path) {
                    let mut line = String::new();
                    if BufReader::new(file).read_line(&mut line).is_ok() {
                        if let Ok(record) = serde_json::from_str(&line)
                            .map_err(err)
                            .and_then(|row| trace_content::decode(&path, row))
                        {
                            self.legacy_annotations.insert(
                                text(session, "id").into(),
                                trace_classification::annotations(&record),
                            );
                        }
                    }
                }
            }
            let frozen_correction = session["nativeUsage"].as_array().is_some_and(|points| {
                points.iter().any(|point| {
                    needs_ark_cost_repair(point)
                        || (point["costComplete"] == false && point["priceRule"].is_object())
                })
            });
            if session["costSnapshotVersion"] == 1
                && !frozen_correction
                && session["cacheHitUsage"].is_object()
                && session["usageByModel"].as_object().is_some_and(|models| {
                    models.values().all(|m| m["knownFieldCounts"].is_object())
                })
            {
                continue;
            }
            let path = PathBuf::from(text(session, "jsonlPath"));
            if path.parent() != Some(self.root.as_path()) {
                continue;
            }
            let Ok(file) = fs::File::open(&path) else {
                continue;
            };
            let mut by_model = json!({});
            let mut points = vec![];
            let mut cache_hit_usage = Value::Null;
            // Keep only one request body in memory. Old conversations can
            // contain hundreds of megabytes of repeated context.
            use std::io::{BufRead, BufReader};
            let mut reader = BufReader::new(file);
            let mut line = String::new();
            let mut prices_by_model = BTreeMap::new();
            let valid = (|| -> Result<()> {
                loop {
                    if cancelled() {
                        return Err("历史统计任务已被新快照替代".into());
                    }
                    line.clear();
                    if reader.read_line(&mut line).map_err(err)? == 0 {
                        break;
                    }
                    if line.trim().is_empty() {
                        continue;
                    }
                    let row =
                        trace_content::decode(&path, serde_json::from_str(&line).map_err(err)?)?;
                    let prices = prices_by_model
                        .entry(text(&row["request"], "model").to_owned())
                        .or_insert_with(|| {
                            trace_pricing::reference_price(
                                &self.prices,
                                text(&row["request"], "model"),
                            )
                        });
                    let row = display_record(std::slice::from_ref(prices), row);
                    accumulate_model_usage(&mut by_model, &row);
                    accumulate_cache_hit_usage(&mut cache_hit_usage, &row["usage"]);
                    points.push(row["costSnapshot"].clone());
                }
                Ok(())
            })();
            if valid.is_err() || points.is_empty() {
                continue;
            }
            if session["traceCount"]
                .as_u64()
                .is_some_and(|n| n != points.len() as u64)
            {
                for model in by_model
                    .as_object_mut()
                    .into_iter()
                    .flat_map(|m| m.values_mut())
                {
                    model["capturedCost"]["complete"] = json!(false);
                }
                for point in &mut points {
                    point["costComplete"] = json!(false);
                }
            }
            let accounted = cache_hit_usage["knownRequests"].as_u64().unwrap_or(0)
                + cache_hit_usage["excludedRequests"].as_u64().unwrap_or(0);
            if let Some(extra) = session["traceCount"]
                .as_u64()
                .and_then(|n| n.checked_sub(accounted))
            {
                cache_hit_usage["excludedRequests"] =
                    json!(cache_hit_usage["excludedRequests"].as_u64().unwrap_or(0) + extra);
            }
            if session["costSnapshotVersion"] == 1 && !frozen_correction {
                let mut annotated = session["usageByModel"].clone();
                for (model, usage) in annotated.as_object_mut().into_iter().flatten() {
                    if by_model[model]["knownFieldCounts"].is_object() {
                        usage["knownFieldCounts"] = by_model[model]["knownFieldCounts"].clone();
                    }
                }
                self.legacy_costs.insert(
                    text(session, "id").into(),
                    json!({"cacheHitUsage":cache_hit_usage,"usageByModel":annotated}),
                );
                continue;
            }
            let tokens: u64 = points.iter().filter_map(|p| p["tokens"].as_u64()).sum();
            self.legacy_costs.insert(text(session,"id").into(),json!({"cacheHitUsage":cache_hit_usage,"usageByModel":by_model,"nativeUsage":points,"totalTokens":tokens,"costViewBasis":if frozen_correction {"frozen-rate-correction"} else {"legacy-current-reference"}}));
        }
    }
}
impl TraceStore {
    fn view_sessions(&self) -> Vec<Value> {
        let mut sessions = self.index["sessions"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        for session in &mut sessions {
            if let Some(costs) = self.legacy_costs.get(text(session, "id")) {
                for (key, value) in costs.as_object().into_iter().flatten() {
                    session[key] = value.clone();
                }
            }
            if let Some(annotation) = self.legacy_annotations.get(text(session, "id")) {
                for (key, value) in annotation.as_object().into_iter().flatten() {
                    session[key] = value.clone();
                }
            }
        }
        trace_classification::associate_titles(&mut sessions);
        sessions
    }
    pub fn state(&self, active: bool) -> Value {
        json!({"theme":self.theme,"language":self.language,"active":active,"rootPath":self.root,"generatedAt":iso(millis()),"sessions":self.view_sessions(),"usageSummaries":self.retained_usage_summaries(),"traces":[],"storage":{"rootPath":self.root,"totalBytes":self.size(),"maxBytes":self.limit}})
    }
    pub fn stats(&self) -> Value {
        let now = millis();
        let today = Local::now().date_naive();
        let mut total = json!({"tokens":0,"costUsd":0.0,"costComplete":true,"knownCostRequests":0});
        let mut day = total.clone();
        let mut week = total.clone();
        let mut series = vec![];
        let sessions = self.view_sessions();
        for session in sessions
            .iter()
            .chain(self.index.get("usageOnly"))
            .chain(
                self.index["usageOnly"]["legacy"]
                    .as_array()
                    .into_iter()
                    .flatten(),
            )
            .chain(
                self.index["usageOnly"]["summaries"]
                    .as_array()
                    .into_iter()
                    .flatten(),
            )
        {
            if !session["nativeUsage"].is_array() {
                let tokens = session["totalTokens"].as_u64().unwrap_or(0);
                total["tokens"] = json!(total["tokens"].as_u64().unwrap_or(0) + tokens);
                if tokens > 0 {
                    total["costComplete"] = json!(false);
                }
                for (date, usage) in session["dailyUsage"].as_object().into_iter().flatten() {
                    if let Ok(date) = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d") {
                        let tokens = usage["tokens"].as_u64().unwrap_or(0);
                        for period in
                            [&mut day, &mut week]
                                .iter_mut()
                                .enumerate()
                                .filter_map(|(i, p)| {
                                    if (i == 0 && date == today)
                                        || (i == 1
                                            && date <= today
                                            && today.signed_duration_since(date).num_days() < 7)
                                    {
                                        Some(p)
                                    } else {
                                        None
                                    }
                                })
                        {
                            period["tokens"] =
                                json!(period["tokens"].as_u64().unwrap_or(0) + tokens);
                            if tokens > 0 {
                                period["costComplete"] = json!(false);
                            }
                        }
                    }
                }
                series.extend(
                    session["recentRatePoints"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .cloned(),
                );
                continue;
            }
            for point in session["nativeUsage"].as_array().into_iter().flatten() {
                let at = point["atMs"].as_u64().unwrap_or(0) as u128;
                let tokens = point["tokens"].as_u64().unwrap_or(0);
                let cost = point["knownCostUsd"]
                    .as_f64()
                    .or_else(|| point["costUsd"].as_f64());
                let complete = point["costComplete"]
                    .as_bool()
                    .unwrap_or(point["costUsd"].as_f64().is_some());
                for period in [&mut total, &mut day, &mut week]
                    .iter_mut()
                    .enumerate()
                    .filter_map(|(i, p)| {
                        if i == 0
                            || (i == 1
                                && DateTime::<Utc>::from_timestamp_millis(at as i64)
                                    .is_some_and(|t| t.with_timezone(&Local).date_naive() == today))
                            || (i == 2 && at + 7 * 86_400_000 >= now)
                        {
                            Some(p)
                        } else {
                            None
                        }
                    })
                {
                    period["tokens"] = json!(period["tokens"].as_u64().unwrap_or(0) + tokens);
                    period["costUsd"] =
                        json!(period["costUsd"].as_f64().unwrap_or(0.0) + cost.unwrap_or(0.0));
                    if cost.is_some() {
                        period["knownCostRequests"] =
                            json!(period["knownCostRequests"].as_u64().unwrap_or(0) + 1);
                    }
                    if !complete {
                        period["costComplete"] = json!(false);
                    }
                }
                series.push(json!({"at":iso(at),"tokens":tokens}));
            }
        }
        series.sort_by(|a, b| a["at"].as_str().cmp(&b["at"].as_str()));
        if series.len() > 1000 {
            series.drain(..series.len() - 1000);
        }
        json!({"total":total,"today":day,"week":week,"series":series})
    }
    #[cfg(test)]
    pub fn page(
        &self,
        id: &str,
        offset: Option<usize>,
        before: Option<usize>,
        limit: usize,
    ) -> Result<Option<Value>> {
        self.page_projection(id, offset, before, limit, false, None)
    }
    fn page_reader(&self) -> TracePageReader {
        // Capture committed file boundaries while the writer is excluded. Later
        // appends cannot expose half a JSON line to this read-only snapshot.
        let sessions = self.view_sessions();
        let files = sessions
            .iter()
            .filter_map(|session| {
                let path = PathBuf::from(session["jsonlPath"].as_str()?);
                let metadata = fs::metadata(&path).ok()?;
                Some((path, (metadata.len(), metadata.modified().ok())))
            })
            .collect();
        TracePageReader {
            price_key: digest(
                serde_json::to_string(&self.prices)
                    .unwrap_or_default()
                    .as_bytes(),
            ),
            root: self.root.clone(),
            prices: self.prices.clone(),
            sessions,
            files,
            cache: self.page_cache.clone(),
        }
    }
    #[cfg(test)]
    fn page_projection(
        &self,
        id: &str,
        offset: Option<usize>,
        before: Option<usize>,
        limit: usize,
        summary_only: bool,
        request_id: Option<&str>,
    ) -> Result<Option<Value>> {
        self.page_reader()
            .page(id, offset, before, limit, summary_only, request_id)
    }
    fn session_file(&self, id: &str) -> Result<PathBuf> {
        let sessions = self.view_sessions();
        let session = sessions
            .iter()
            .find(|s| s["id"] == id)
            .ok_or("session not found")?;
        let file = PathBuf::from(session["jsonlPath"].as_str().ok_or("索引路径无效")?);
        if !file.is_file() || file.parent() != Some(self.root.as_path()) {
            return Err("会话日志文件已不存在".into());
        }
        let canonical = file.canonicalize().map_err(err)?;
        if canonical.parent() != Some(self.root.canonicalize().map_err(err)?.as_path()) {
            return Err("索引路径越界".into());
        }
        Ok(canonical)
    }
    pub fn delete(&mut self, id: &str, clear_usage: bool) -> Result<bool> {
        self.with_writer(true, |store| store.delete_owned(id, clear_usage))
    }
    fn delete_owned(&mut self, id: &str, clear_usage: bool) -> Result<bool> {
        if !clear_usage {
            self.finish_history_before_retention();
        }
        let view = self.view_sessions();
        let Some(target) = view.iter().find(|s| s["id"] == id) else {
            return Ok(false);
        };
        let targets: Vec<_> = view
            .iter()
            .filter(|s| {
                s["id"] == id
                    || (!text(target, "clientConversationKey").is_empty()
                        && s["clientConversationKey"] == target["clientConversationKey"]
                        && s["source"] == target["source"])
            })
            .collect();
        let mut paths = Vec::new();
        for target in &targets {
            let file = PathBuf::from(target["jsonlPath"].as_str().ok_or("索引路径无效")?);
            if file.parent() != Some(self.root.as_path()) {
                return Err("索引路径越界".into());
            }
            if file.exists() {
                fs::File::open(&file).map_err(err)?;
            }
            paths.push(file);
        }
        let _deletion_guards = paths
            .iter()
            .map(|file| trace_content::deletion_guard(file))
            .collect::<Result<Vec<_>>>()?;
        for file in paths {
            if file.exists() {
                fs::remove_file(&file).map_err(err)?;
            }
            trace_content::remove(&file)?;
        }
        let before = self.index.clone();
        if !clear_usage {
            for target in &targets {
                self.retain_session_usage(target);
            }
        }
        let ids: Vec<_> = targets.iter().map(|s| s["id"].clone()).collect();
        self.index["sessions"]
            .as_array_mut()
            .unwrap()
            .retain(|s| !ids.contains(&s["id"]));
        if let Err(error) = self.persist() {
            self.index = before;
            return Err(error);
        }
        for id in ids.iter().filter_map(Value::as_str) {
            self.release_session_views(id);
        }
        Ok(true)
    }
    pub fn inspect_repair(&self) -> Result<Value> {
        let index_path = self.root.join("index.json");
        let index_source = read(&index_path)?;
        let index_sha = index_source
            .as_ref()
            .map(|s| digest(s.as_bytes()))
            .unwrap_or_default();
        let disk_index = index_source
            .as_ref()
            .and_then(|source| serde_json::from_str::<Value>(source).ok())
            .filter(|value| value["sessions"].is_array());
        let index_status = if index_source.is_none() {
            "missing"
        } else if disk_index.is_none() {
            "invalid"
        } else {
            "valid"
        };
        let indexed: Vec<_> = disk_index
            .as_ref()
            .and_then(|v| v["sessions"].as_array())
            .into_iter()
            .flatten()
            .collect();
        let mut candidates = vec![];
        let mut content_errors = vec![];
        let mut total = 0;
        for entry in fs::read_dir(&self.root)
            .map_err(err)?
            .flatten()
            .filter(|e| {
                e.file_type().is_ok_and(|t| t.is_file())
                    && e.path().extension().is_some_and(|e| e == "jsonl")
            })
        {
            total += 1;
            let source = read(&entry.path())?.unwrap_or_default();
            let mut valid = 0;
            let mut malformed = 0;
            let mut id = String::new();
            for line in source.lines().filter(|l| !l.is_empty()) {
                let parsed = serde_json::from_str::<Value>(line).map_err(err);
                let decoded = parsed.and_then(|record| {
                    trace_content::decode(&entry.path(), record).inspect_err(|error| {
                        content_errors.push(json!({"jsonlPath":entry.path(),"error":error}));
                    })
                });
                match decoded {
                    Ok(v)
                        if v["id"].is_string()
                            && v["request"].is_object()
                            && v["response"].is_object() =>
                    {
                        valid += 1;
                        if id.is_empty() {
                            id = text(&v, "sessionId").into();
                        }
                    }
                    _ => malformed += 1,
                }
            }
            if valid > 0 {
                if id.is_empty() {
                    id = format!(
                        "session-{}",
                        &digest(entry.file_name().to_string_lossy().as_bytes())[..24]
                    );
                }
                candidates.push(json!({"id":id,"jsonlPath":entry.path(),"validRecords":valid,"malformedRecords":malformed}));
            }
        }
        let missing: Vec<_> = indexed
            .iter()
            .filter_map(|s| s["jsonlPath"].as_str())
            .filter(|p| !Path::new(p).is_file())
            .collect();
        let unindexed: Vec<_> = candidates
            .iter()
            .filter(|candidate| {
                !indexed
                    .iter()
                    .any(|s| s["jsonlPath"] == candidate["jsonlPath"])
            })
            .map(|c| c["jsonlPath"].clone())
            .collect();
        let stale: Vec<_> = candidates
            .iter()
            .filter(|candidate| {
                indexed.iter().any(|s| {
                    s["jsonlPath"] == candidate["jsonlPath"]
                        && s["traceCount"] != candidate["validRecords"]
                })
            })
            .map(|c| c["jsonlPath"].clone())
            .collect();
        let usage_refresh: Vec<_> = indexed
            .iter()
            .filter(|s| {
                s["usageNormalizationVersion"] != 2
                    || s["costSnapshotVersion"] != 1
                    || s["nativeUsage"]
                        .as_array()
                        .is_some_and(|points| points.iter().any(needs_ark_cost_repair))
                    || s["nativeUsage"]
                        .as_array()
                        .is_some_and(|a| a.iter().any(|p| p.get("costComplete").is_none()))
            })
            .map(|s| s["jsonlPath"].clone())
            .collect();
        let needs_repair = !usage_refresh.is_empty()
            || !content_errors.is_empty()
            || index_status == "invalid"
            || !unindexed.is_empty()
            || !missing.is_empty()
            || !stale.is_empty();
        Ok(
            json!({"rootPath":self.root,"indexPath":index_path,"indexStatus":index_status,"indexSha256":index_sha,"indexedSessions":indexed.len(),"jsonlFiles":total,"missingIndexedFiles":missing,"unindexedFiles":unindexed,"staleIndexedFiles":stale,"usageRefreshFiles":usage_refresh,"contentErrors":content_errors,"needsRepair":needs_repair,"candidates":candidates}),
        )
    }

    pub fn apply_repair(&mut self, expected: Option<&str>) -> Result<Value> {
        self.with_writer(false, |store| store.apply_repair_owned(expected))
    }
    fn apply_repair_owned(&mut self, expected: Option<&str>) -> Result<Value> {
        let plan = self.inspect_repair()?;
        if plan["contentErrors"]
            .as_array()
            .is_some_and(|errors| !errors.is_empty())
        {
            return Err(
                "Trace 正文库缺失或损坏，未修改索引；请保留会话日志与正文库一起检查".into(),
            );
        }
        if expected.is_some_and(|e| plan["indexSha256"] != e) {
            return Err("索引已被外部修改，请重新检查".into());
        }
        let index = self.root.join("index.json");
        let prior_source = read(&index)?;
        let prior = prior_source
            .as_ref()
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .filter(|v| v["sessions"].is_array())
            .unwrap_or_else(empty_index);
        let mut sessions = vec![];
        for candidate in plan["candidates"].as_array().unwrap() {
            let path = PathBuf::from(candidate["jsonlPath"].as_str().ok_or("无效修复路径")?);
            if path.parent() != Some(self.root.as_path()) {
                return Err("修复路径越界".into());
            }
            let source = read(&path)?.unwrap_or_default();
            let rows: Vec<Value> = source
                .lines()
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .map(|record| trace_content::decode(&path, record))
                .collect::<Result<Vec<_>>>()?
                .into_iter()
                .filter(|v| {
                    v["id"].is_string() && v["request"].is_object() && v["response"].is_object()
                })
                .map(|mut row| {
                    let evidence = &row["usageEvidence"]["upstream"];
                    let wire = text(evidence, "protocol");
                    if evidence["raw"].is_object()
                        && [
                            "responses",
                            "openai-responses",
                            "chat-completions",
                            "openai-chat-completions",
                            "messages",
                            "anthropic-messages",
                        ]
                        .contains(&wire)
                    {
                        row["usage"] = record_usage(&json!({"usage":evidence["raw"]}), wire, &row);
                    }
                    row["costSnapshot"] = repaired_cost_point(&self.prices, &row);
                    row
                })
                .collect();
            if rows.is_empty() {
                continue;
            }
            let mut usage_by_model = json!({});
            for row in &rows {
                accumulate_model_usage(&mut usage_by_model, row);
            }
            let mut cache_hit_usage = Value::Null;
            for row in &rows {
                accumulate_cache_hit_usage(&mut cache_hit_usage, &row["usage"]);
            }
            let first = &rows[0];
            let last = rows.last().unwrap();
            let native_usage: Vec<_> = rows.iter().map(|r| r["costSnapshot"].clone()).collect();
            let mut summary = prior["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .find(|s| s["jsonlPath"] == candidate["jsonlPath"])
                .filter(|s| s.is_object())
                .cloned()
                .unwrap_or_else(|| json!({}));
            let recovered = json!({"cacheHitUsage":cache_hit_usage,"id":candidate["id"],"startedAt":first["startedAt"],"updatedAt":last["completedAt"],"source":first["source"],"clientConversationKey":first["clientConversationKey"],"firstPrompt":first["request"]["body"]["input"].as_str().unwrap_or(""),"firstModel":first["request"]["model"],"jsonlPath":path,"traceCount":rows.len(),"totalTokens":rows.iter().filter_map(|r|r["usage"]["totalTokens"].as_u64()).sum::<u64>(),"totalDurationMs":rows.iter().filter_map(|r|r["durationMs"].as_u64()).sum::<u64>(),"usageByModel":usage_by_model,"usageNormalizationVersion":2,"nativeUsage":native_usage});
            for (key, value) in recovered.as_object().unwrap() {
                if key == "firstPrompt" && summary.get(key).is_some() {
                    continue;
                }
                summary[key] = value.clone();
            }
            summary["costSnapshotVersion"] = json!(1);
            sessions.push(summary);
        }
        let current = read(&index)?.unwrap_or_default();
        if digest(current.as_bytes()) != plan["indexSha256"].as_str().unwrap_or("")
            && !(current.is_empty() && plan["indexSha256"] == "")
        {
            return Err("索引已被外部修改，请重新检查".into());
        }
        let backup = if let Some(source) = read(&index)? {
            let path = self.root.join(format!("index-backup-{}.json", millis()));
            write(&path, &source)?;
            Some(path)
        } else {
            None
        };
        let recovered = sessions.len();
        let mut repaired = prior;
        repaired["version"] = json!(1);
        repaired["sessions"] = json!(sessions);
        self.writer
            .as_ref()
            .ok_or("缺少 Trace 修复租约")?
            .validate()?;
        if read(&index)? != prior_source {
            return Err("Trace 索引在修复前发生外部变化，原历史和备份已保留".into());
        }
        let next = serde_json::to_string_pretty(&repaired).map_err(err)?;
        write_checked(&index, prior_source.as_deref().unwrap_or_default(), &next)?;
        self.index_source = Some(next);
        self.index = repaired;
        self.refresh_legacy_costs();
        self.read_problem = None;
        let mut result = plan;
        result["applied"] = json!(true);
        result["backupIndexPath"] = json!(backup);
        result["recoveredSessions"] = json!(recovered);
        Ok(result)
    }
    pub fn clear(&mut self) -> Result<()> {
        self.with_writer(true, |store| store.clear_owned())
    }
    fn clear_owned(&mut self) -> Result<()> {
        let ids: Vec<_> = self.index["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|s| s["id"].as_str().map(str::to_string))
            .collect();
        for id in ids {
            self.delete_owned(&id, true)?;
        }
        self.index.as_object_mut().unwrap().remove("usageOnly");
        self.persist()?;
        Ok(())
    }
    pub fn reset_usage(&mut self) -> Result<()> {
        self.with_writer(true, |store| {
            store.index.as_object_mut().unwrap().remove("usageOnly");
            store.index["usageResetAt"] = json!(millis());
            for session in store.index["sessions"].as_array_mut().unwrap() {
                session["nativeUsage"] = json!([]);
                session["usageByModel"] = json!({});
                session["dailyUsage"] = json!({});
                session["totalTokens"] = json!(0);
            }
            store.persist()
        })
    }
    fn usage_only(&mut self) -> &mut Value {
        let usage = &mut self.index["usageOnly"];
        if !usage["nativeUsage"].is_array() {
            let legacy = usage_summary(usage);
            *usage = json!({"nativeUsage":[],"legacy":[]});
            if legacy["totalTokens"].as_u64().unwrap_or(0) > 0 {
                usage["legacy"].as_array_mut().unwrap().push(legacy);
            }
        }
        usage
    }
    // Accounting survives detail deletion. Keep counters and frozen prices,
    // never conversation IDs, titles, paths, prompts or response bodies.
    fn retain_session_usage(&mut self, session: &Value) {
        let mut summary = json!({});
        for key in [
            "source",
            "totalTokens",
            "usageByModel",
            "cacheHitUsage",
            "nativeUsage",
            "dailyUsage",
            "recentRatePoints",
            "costViewBasis",
        ] {
            if let Some(value) = session.get(key) {
                summary[key] = value.clone();
            }
        }
        let usage = self.usage_only();
        if !usage["summaries"].is_array() {
            usage["summaries"] = json!([]);
        }
        usage["summaries"].as_array_mut().unwrap().push(summary);
    }
    fn retained_usage_summaries(&self) -> Vec<Value> {
        let usage = &self.index["usageOnly"];
        let mut summaries: Vec<_> = usage["summaries"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|summary| summary.is_object())
            .cloned()
            .collect();
        // Older usage-only ledgers have frozen totals but no source or input /
        // output breakdown. Preserve known totals without inventing details.
        let mut legacy = json!({"source":"unknown", "totalTokens":0, "usageByModel":{}});
        for point in usage["nativeUsage"].as_array().into_iter().flatten() {
            legacy["totalTokens"] = json!(
                legacy["totalTokens"].as_u64().unwrap_or(0) + point["tokens"].as_u64().unwrap_or(0)
            );
            let mut frozen = point.clone();
            if frozen["knownCostUsd"].is_null() {
                frozen["knownCostUsd"] = point["costUsd"].clone();
            }
            accumulate_model_usage(
                &mut legacy["usageByModel"],
                &json!({
                    "request":{"model":point["modelId"]}, "usage":{"totalTokens":point["tokens"]}, "costSnapshot":frozen
                }),
            );
        }
        if !usage["nativeUsage"].is_array() {
            legacy["totalTokens"] = usage["totalTokens"].clone();
        }
        for item in usage["legacy"].as_array().into_iter().flatten() {
            legacy["totalTokens"] = json!(
                legacy["totalTokens"].as_u64().unwrap_or(0)
                    + item["totalTokens"].as_u64().unwrap_or(0)
            );
        }
        if legacy["totalTokens"].as_u64().unwrap_or(0) > 0
            || usage["nativeUsage"]
                .as_array()
                .is_some_and(|p| !p.is_empty())
        {
            summaries.push(legacy);
        }
        for summary in &mut summaries {
            summary.as_object_mut().unwrap().remove("nativeUsage");
            summary.as_object_mut().unwrap().remove("dailyUsage");
            summary.as_object_mut().unwrap().remove("recentRatePoints");
        }
        summaries
    }
    pub fn set_retention(&mut self, limit: u64, auto_cleanup: bool) {
        self.limit = limit;
        self.auto_cleanup = auto_cleanup;
        self.apply_retention();
    }
    fn apply_retention(&mut self) {
        if self.limit != 0 {
            self.retention_notice = if self.auto_cleanup {
                // Writer/index validation still blocks capture. A cleanup
                // error only leaves retention pending, including at lease drop.
                self.with_writer(true, |store| Ok(store.cleanup_to_limit()))
                    .and_then(|result| result)
                    .err()
                    .map(|error| format!("详细记录清理未完成：{error}；请重新应用存储设置"))
            } else {
                None
            };
            return;
        }
        let result = self
            .with_writer(true, |store| Ok(store.purge_completed_details()))
            .and_then(|result| result);
        self.retention_notice = match result {
            Err(error) => Some(format!(
                "设置已保存，详细记录清理未完成：{error}；请重新应用存储设置"
            )),
            Ok(()) if !self.recording.is_empty() => {
                Some("已清理结束的记录，正在生成的记录将在结束后清理".into())
            }
            Ok(()) => None,
        };
    }
    fn purge_completed_details(&mut self) -> Result<()> {
        self.finish_history_before_retention();
        if let Some(ref problem) = self.read_problem {
            return Err(problem.clone());
        }
        let completed: Vec<_> = self
            .view_sessions()
            .into_iter()
            .filter(|s| !self.recording.contains_key(text(s, "id")))
            .collect();
        for session in completed {
            let path = PathBuf::from(session["jsonlPath"].as_str().ok_or("索引路径无效")?);
            if path.parent() != Some(self.root.as_path()) {
                return Err("索引路径越界".into());
            }
            if path.exists() {
                fs::File::open(&path).map_err(err)?;
            }
            let _deletion_guard = trace_content::deletion_guard(&path)?;
            let before = self.index.clone();
            self.retain_session_usage(&session);
            self.index["sessions"]
                .as_array_mut()
                .unwrap()
                .retain(|s| s["id"] != session["id"]);
            // Commit accounting before unlinking details. A retry removes the
            // leftover native file without counting that session a second time.
            if let Err(error) = self.persist() {
                self.index = before;
                return Err(error);
            }
            if path.exists() {
                fs::remove_file(&path).map_err(err)?;
            }
            trace_content::remove(&path)?;
            self.release_session_views(text(&session, "id"));
        }
        for entry in fs::read_dir(&self.root).map_err(err)?.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(id) = name
                .strip_suffix(".jsonl")
                .or_else(|| name.strip_suffix(".content.sqlite"))
            else {
                continue;
            };
            if id
                .strip_prefix("session-")
                .is_some_and(|hash| hash.len() == 24 && hash.bytes().all(|b| b.is_ascii_hexdigit()))
                && !self.recording.contains_key(id)
            {
                let log = self.root.join(format!("{id}.jsonl"));
                let _deletion_guard = trace_content::deletion_guard(&log)?;
                if log.exists() {
                    fs::File::open(&log).map_err(err)?;
                    fs::remove_file(&log).map_err(err)?;
                }
                trace_content::remove(&log)?;
            }
        }
        Ok(())
    }
    fn persist(&mut self) -> Result<()> {
        self.writer
            .as_ref()
            .ok_or("缺少 Trace 写入租约")?
            .validate()?;
        self.validate_index()?;
        let source = serde_json::to_string_pretty(&self.index).map_err(err)?;
        write_checked(
            &self.root.join("index.json"),
            self.index_source.as_deref().unwrap_or_default(),
            &source,
        )?;
        self.index_source = Some(source);
        let _ = self.events.send("event: reset\ndata: {}\n\n".into());
        Ok(())
    }
    fn cache_committed_append(
        &self,
        path: &Path,
        previous: &fs::Metadata,
        line_bytes: usize,
        record: Value,
    ) {
        // Extend only a prefix we observed before our own committed write.
        // External changes and changed pricing still take the full read path.
        let Ok(mut cache) = self.page_cache.lock() else {
            return;
        };
        let cached = cache.remove(path);
        let Ok(metadata) = fs::metadata(path) else {
            return;
        };
        if metadata.len() != previous.len().saturating_add(line_bytes as u64) {
            return;
        }
        let price_key = digest(
            serde_json::to_string(&self.prices)
                .unwrap_or_default()
                .as_bytes(),
        );
        let mut entry = match cached {
            Some(entry)
                if entry.length == previous.len()
                    && entry.modified == previous.modified().ok()
                    && entry.price_key == price_key =>
            {
                entry
            }
            _ if previous.len() == 0 => CachedTraceFile {
                price_key,
                length: 0,
                modified: None,
                rows: Arc::new(Vec::new()),
                summary_bytes: 0,
                last_used: 0,
            },
            _ => return,
        };
        let price = trace_pricing::reference_price(&self.prices, text(&record["request"], "model"));
        let summary = trace_row_summary(&display_record(&[price], record));
        let Ok(bytes) = json_byte_len(&summary) else {
            return;
        };
        entry.summary_bytes = entry.summary_bytes.saturating_add(bytes);
        Arc::make_mut(&mut entry.rows).push(TraceFileRow {
            summary,
            offset: previous.len(),
            length: line_bytes,
        });
        entry.length = metadata.len();
        entry.modified = metadata.modified().ok();
        entry.last_used = millis();
        cache_trace_file(&mut cache, path, entry);
    }
    pub fn append(&mut self, record: Value, key: &str) -> Result<()> {
        self.with_writer(true, |store| store.append_owned(record, key))
    }
    fn append_owned(&mut self, mut record: Value, key: &str) -> Result<()> {
        if let Some(ref problem) = self.read_problem {
            return Err(problem.clone());
        }
        trace_compaction::annotate(&mut record);
        let annotation = trace_classification::annotations(&record);
        if let Some(kind) = annotation.get("auxiliary") {
            record["auxiliary"] = kind.clone();
        }
        let reset_at = self.index["usageResetAt"].as_u64().unwrap_or(0);
        let record_at = record["startedAtMs"]
            .as_u64()
            .or_else(|| {
                chrono::DateTime::parse_from_rfc3339(text(&record, "startedAt"))
                    .ok()
                    .map(|t| t.timestamp_millis() as u64)
            })
            .unwrap_or(0);
        if self.limit == 0 {
            if reset_at > 0 && record_at <= reset_at {
                return Ok(());
            }
            let point = usage_cost_point(&self.prices, &record);
            let mut summary = json!({"source":record["source"],"totalTokens":record["usage"]["totalTokens"],"nativeUsage":[point],"usageByModel":{}});
            record["costSnapshot"] = summary["nativeUsage"][0].clone();
            accumulate_model_usage(&mut summary["usageByModel"], &record);
            accumulate_cache_hit_usage(&mut summary["cacheHitUsage"], &record["usage"]);
            self.retain_session_usage(&summary);
            self.persist()?;
            return Ok(());
        }
        let mut id = format!("session-{}", &digest(key.as_bytes())[..24]);
        let mut file = self.root.join(format!("{id}.jsonl"));
        let indexed = self.index["sessions"].as_array().unwrap();
        if !indexed.iter().any(|session| session["id"] == id) {
            let matching: Vec<_> = indexed
                .iter()
                .filter(|session| {
                    let annotation = self.legacy_annotations.get(text(session, "id"));
                    let identity = |field| {
                        annotation
                            .and_then(|a| a.get(field))
                            .unwrap_or(&session[field])
                    };
                    identity("source") == &record["source"]
                        && identity("clientConversationKey") == key
                })
                .map(|session| text(session, "id").to_owned())
                .take(2)
                .collect();
            if let [existing] = matching.as_slice() {
                file = self.session_file(existing)?;
                id = existing.clone();
            }
        }
        let sessions = self.index["sessions"].as_array_mut().unwrap();
        let at=sessions.iter().position(|s|s["id"]==id).unwrap_or_else(||{sessions.push(json!({"id":id,"startedAt":record["startedAt"],"updatedAt":record["completedAt"],"source":record["source"],"clientConversationKey":key,"firstPrompt":record["request"]["body"]["input"].as_str().or_else(||record["clientFirstPrompt"].as_str()).unwrap_or(""),"firstModel":record["request"]["model"],"jsonlPath":file,"traceCount":0,"totalTokens":0,"totalDurationMs":0,"usageByModel":{},"usageNormalizationVersion":2,"nativeUsage":[]}));sessions.len()-1});
        let summary = &mut sessions[at];
        if !summary["cacheHitUsage"].is_object() {
            let recovered = self
                .legacy_costs
                .get(&id)
                .map(|view| &view["cacheHitUsage"]);
            summary["cacheHitUsage"] = recovered
                .filter(|stats| stats.is_object())
                .cloned()
                .unwrap_or_else(|| {
                    json!({"inputTokens":0,"cacheReadTokens":0,"knownRequests":0,
                    "excludedRequests":summary["traceCount"].as_u64().unwrap_or(0)})
                });
        }
        if let Some(view) = self.legacy_costs.get(&id) {
            for (model, usage) in summary["usageByModel"]
                .as_object_mut()
                .into_iter()
                .flatten()
            {
                if !usage["knownFieldCounts"].is_object()
                    && view["usageByModel"][model]["knownFieldCounts"].is_object()
                {
                    usage["knownFieldCounts"] =
                        view["usageByModel"][model]["knownFieldCounts"].clone();
                }
            }
        }

        if let Some(legacy) = self.legacy_annotations.remove(&id) {
            for (key, value) in legacy.as_object().into_iter().flatten() {
                summary[key] = value.clone();
            }
        }
        summary["source"] = record["source"].clone();
        summary["clientConversationKey"] = json!(key);
        if !summary["nativeUsage"].is_array() {
            summary["nativeUsage"] = self
                .legacy_costs
                .get(&id)
                .and_then(|view| view.get("nativeUsage"))
                .filter(|points| points.is_array())
                .cloned()
                .unwrap_or_else(|| json!([]));
        }
        let auxiliary = annotation["auxiliary"].is_string();
        summary["captureClassificationVersion"] = json!(1);
        if !auxiliary {
            summary["hidden"] = json!(false);
            if summary["hasMainTurn"] != true || text(summary, "firstPrompt").is_empty() {
                summary["firstPrompt"] = annotation["firstPrompt"].clone();
            }
            summary["hasMainTurn"] = json!(true);
        } else {
            if summary["hasMainTurn"] != true {
                summary["hidden"] = json!(true);
                summary["firstPrompt"] = json!("");
            }
            for field in ["title", "titlePromptHash"] {
                if let Some(value) = annotation.get(field) {
                    summary[field] = value.clone();
                }
            }
            let kind = annotation["auxiliary"].as_str().unwrap();
            if !summary["auxiliaryCounts"].is_object() {
                summary["auxiliaryCounts"] = json!({});
            }
            summary["auxiliaryCounts"][kind] =
                json!(summary["auxiliaryCounts"][kind].as_u64().unwrap_or(0) + 1);
        }
        if summary["errorCount"].as_u64().is_none() {
            summary["errorCount"] = json!(error_count(&file)?);
        }
        let is_error = trace_error(&record);
        summary["errorCount"] =
            json!(summary["errorCount"].as_u64().unwrap_or(0) + u64::from(is_error));
        if record["auxiliary"].is_null() && record["subagent"].is_null() {
            summary["lastTurnError"] = json!(is_error);
        }
        let turn = summary["traceCount"].as_u64().unwrap_or(0) + 1;
        record["sessionId"] = json!(id);
        record["turn"] = json!(turn);
        summary["traceCount"] = json!(turn);
        summary["updatedAt"] = record["completedAt"].clone();
        let tokens = record["usage"]["totalTokens"].as_u64().unwrap_or(0);
        summary["totalTokens"] = json!(summary["totalTokens"].as_u64().unwrap_or(0) + tokens);
        summary["totalDurationMs"] = json!(
            summary["totalDurationMs"].as_u64().unwrap_or(0)
                + record["durationMs"].as_u64().unwrap_or(0)
        );
        record["costSnapshot"] = usage_cost_point(&self.prices, &record);
        // A legacy aggregate cannot claim complete monetary coverage until its
        // original requests have been rebuilt by the backed-up index repair.
        if summary["costSnapshotVersion"] != 1 && turn > 1 {
            for model in summary["usageByModel"]
                .as_object_mut()
                .into_iter()
                .flat_map(|m| m.values_mut())
            {
                if model.get("capturedCost").is_none() {
                    model["capturedCost"] = json!({"cost":null,"complete":false});
                }
            }
        } else {
            summary["costSnapshotVersion"] = json!(1);
        }
        accumulate_model_usage(&mut summary["usageByModel"], &record);
        accumulate_cache_hit_usage(&mut summary["cacheHitUsage"], &record["usage"]);
        summary["nativeUsage"]
            .as_array_mut()
            .unwrap()
            .push(record["costSnapshot"].clone());
        let mut output = fs::OpenOptions::new()
            .read(true)
            .append(true)
            .create(true)
            .open(&file)
            .map_err(err)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            output
                .set_permissions(fs::Permissions::from_mode(0o600))
                .map_err(err)?;
        }
        use std::io::Write;
        let previous = output.metadata().map_err(err)?;
        let stored = trace_content::encode(&file, &record)?;
        let line = stored.to_string();
        writeln!(&mut output, "{line}").map_err(err)?;
        output.sync_all().map_err(err)?;
        drop(output);
        if self.legacy_costs.remove(&id).is_some()
            || (turn > 1 && summary["costSnapshotVersion"] != 1)
        {
            self.refresh_legacy_session(&id);
        }
        self.persist()?;
        // The record is committed. A retention failure must not mark capture
        // as broken or block later requests from being recorded.
        self.retention_notice = self
            .cleanup_to_limit()
            .err()
            .map(|error| format!("详细记录清理未完成：{error}；请重新应用存储设置"));
        if self.index["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["id"] == id)
        {
            // SSE is a notification, not a second in-memory archive of bodies.
            // The Viewer reads the selected full request through the detail API.
            let mut event = trace_row_summary(&record);
            event["clientFirstPrompt"] = json!(text(&annotation, "firstPrompt")
                .chars()
                .take(1024)
                .collect::<String>());
            if let Some(title) = annotation.get("title") {
                event["generatedTitle"] = title.clone();
            }
            let _ = self.events.send(format!("event: trace\ndata: {event}\n\n"));
            self.cache_committed_append(&file, &previous, line.len() + 1, record);
        }
        Ok(())
    }
    fn cleanup_to_limit(&mut self) -> Result<()> {
        if self.auto_cleanup && self.limit > 0 {
            while self.size() > self.limit && !self.index["sessions"].as_array().unwrap().is_empty()
            {
                let oldest = self.index["sessions"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|candidate| {
                        !self.index["sessions"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|session| {
                                self.recording.contains_key(text(session, "id"))
                                    && (session["id"] == candidate["id"]
                                        || (!text(candidate, "clientConversationKey").is_empty()
                                            && session["clientConversationKey"]
                                                == candidate["clientConversationKey"]
                                            && session["source"] == candidate["source"]))
                            })
                    })
                    .min_by_key(|s| s["updatedAt"].as_str().unwrap_or(""));
                let Some(oldest) = oldest.and_then(|s| s["id"].as_str()).map(str::to_string) else {
                    break;
                };
                self.delete_owned(&oldest, false)?;
            }
        }
        Ok(())
    }
}

// Capture upstream accounting independently from the outermost HTTP body. The
// latter may still be converted by ingress after a Capture has finished/dropped.
// Either side can drop first (including an entirely unpolled client body).
#[derive(Clone, Default)]
pub(super) struct ClientEvidence(Arc<std::sync::Mutex<ClientEvidenceState>>);
#[derive(Default)]
struct ClientEvidenceState {
    raw: Vec<u8>,
    overflow: bool,
    status: u16,
    headers: Value,
    finished: bool,
    ended: bool,
    sse: bool,
    protocol_ended: bool,
    terminal_seen: bool,
    captures: usize,
    pending: Vec<(Store, String, Value)>,
    tools: Option<super::tool_wait::Observer>,
}
impl ClientEvidence {
    pub fn tools(&self, observer: super::tool_wait::Observer) {
        self.0.lock().unwrap().tools = Some(observer);
    }
    pub fn capture(&self) -> Self {
        self.0.lock().unwrap().captures += 1;
        self.clone()
    }
    pub fn response(&self, response: Response) -> Response {
        use futures_util::StreamExt;
        {
            let state = self.0.lock().unwrap();
            if state.captures == 0 && state.pending.is_empty() {
                return response;
            }
        }
        let (parts, body) = response.into_parts();
        {
            let mut state = self.0.lock().unwrap();
            state.status = parts.status.as_u16();
            let sse = parts
                .headers
                .get("content-type")
                .and_then(|h| h.to_str().ok())
                .is_some_and(|h| h.contains("text/event-stream"));
            state.sse = sse;
            if let Some(tools) = state.tools.as_mut() {
                tools.transport(sse);
            }
            state.headers = json!(parts
                .headers
                .iter()
                .filter(|(name, _)| ![
                    "authorization",
                    "proxy-authorization",
                    "x-api-key",
                    "x-goog-api-key",
                    "cookie",
                    "set-cookie"
                ]
                .contains(&name.as_str()))
                .map(|(name, value)| (name.to_string(), json!(value.to_str().unwrap_or(""))))
                .collect::<serde_json::Map<_, _>>());
        }
        let guard = ClientBodyGuard(self.clone());
        let expected = parts
            .headers
            .get("content-length")
            .and_then(|h| h.to_str().ok())
            .and_then(|h| h.parse::<usize>().ok());
        let stream = async_stream::stream! {
            // Constructed outside the generator so Drop also runs before polling.
            let guard = guard;
            let mut body = body.into_data_stream();
            while let Some(chunk) = body.next().await {
                if let Ok(bytes) = &chunk {
                    let mut state = guard.0.0.lock().unwrap();
                    let remaining = (32 * 1024 * 1024usize).saturating_sub(state.raw.len());
                    state.raw.extend_from_slice(&bytes[..bytes.len().min(remaining)]);
                    state.overflow |= bytes.len() > remaining;
                    let detected_sse = !state.sse && protocol::is_sse_body(&state.raw);
                    state.sse |= detected_sse;
                    if state.sse && !state.protocol_ended && !state.overflow {
                        let tail=&state.raw[state.raw.len().saturating_sub(bytes.len()+64)..];
                        state.terminal_seen |= tail.windows(b"response.completed".len()).any(|w|w==b"response.completed") || tail.windows(b"response.incomplete".len()).any(|w|w==b"response.incomplete");
                        if state.terminal_seen {
                            state.protocol_ended=protocol::collapse_sse(&String::from_utf8_lossy(&state.raw),"responses","").is_ok();
                        }
                    }
                    if !state.sse && !state.protocol_ended && !state.overflow
                        && bytes.iter().rev().find(|b| !b.is_ascii_whitespace()) == Some(&b'}') {
                        state.protocol_ended = serde_json::from_slice::<Value>(&state.raw).is_ok_and(|value|
                            (value["status"] == "completed" && protocol::validate_response(&value,"responses").is_ok())
                            || value["object"] == "response.compaction");
                    }
                    if let Some(mut tools) = state.tools.take() {
                        if (200..300).contains(&state.status) {
                            if detected_sse { tools.transport(true); }
                            tools.chunk(if detected_sse { &state.raw } else { bytes },&state.raw,state.overflow);
                            if expected == Some(state.raw.len()) || state.protocol_ended { tools.finish(&state.raw,state.overflow); }
                        }
                        state.tools = Some(tools);
                    }
                }
                let failed = chunk.is_err();
                yield chunk;
                if failed { return; }
            }
            let mut state = guard.0.0.lock().unwrap();
            if let Some(mut tools) = state.tools.take() {
                if (200..300).contains(&state.status) { tools.finish(&state.raw,state.overflow); }
                state.tools = Some(tools);
            }
            state.ended = true;
        };
        Response::from_parts(parts, Body::from_stream(stream))
    }
    fn publish(&self, store: Store, key: String, record: Value) {
        {
            let mut state = self.0.lock().unwrap();
            state.pending.push((store, key, record));
            state.captures -= 1;
        }
        self.flush();
    }
    fn flush(&self) {
        let records = {
            let mut state = self.0.lock().unwrap();
            if !state.finished || state.captures != 0 {
                return;
            }
            let last = state.pending.len().saturating_sub(1);
            let pending = std::mem::take(&mut state.pending);
            pending.into_iter().enumerate().map(|(index, (store, key, mut record))| {
                let delivered = index == last;
                // Definite account refusals consumed internally remain separate
                // upstream attempts, never copies of the final client's stream.
                if !delivered {
                    record["attemptResponse"] = record["response"].take();
                    record["response"] = json!({"forwardedToClient":false,"rawBody":"","statusCode":null,"headers":{}});
                } else {
                    record["response"]["statusCode"] = json!(state.status);
                    record["response"]["headers"] = state.headers.clone();
                    record["response"]["rawBody"] = json!(String::from_utf8_lossy(&state.raw));
                    record["response"]["forwardedToClient"] = json!(true);
                    record["response"]["bodyFormat"] = json!("wire");
                    record["response"]["captureBoundary"] = json!("gateway-http-body");
                    record["response"]["bodyEnded"] = json!(state.ended);
                    record["response"]["protocolEnded"] = json!(state.protocol_ended);
                    if let Ok(body) = serde_json::from_slice::<Value>(&state.raw) {
                        record["response"]["body"] = body;
                    } else if record.get("error").is_some() {
                        record["response"].as_object_mut().unwrap().remove("body");
                    }
                    if state.overflow {
                        record["response"]["bodyTruncated"] = json!(true);
                        record["error"] = json!("客户端响应记录超过 32 MB，已截断；网络转发保持完整");
                    } else if !state.ended && !state.protocol_ended && record.get("error").is_none() {
                        record["error"] = json!("客户端响应未读取到结束；已保留 Gateway 输出的前缀");
                    }
                }
                (store, key, record)
            }).collect::<Vec<_>>()
        };
        // Never hold the evidence mutex while taking the shared writer mutex.
        for (store, key, record) in records {
            let mut store = store.lock().unwrap();
            if let Err(error) = store.append(record, &key) {
                store.read_problem = Some(format!(
                    "Trace 最终响应未能保存：{error}；请检查历史目录并手动修复索引"
                ));
                eprintln!("Trace capture failed: {error}");
            }
        }
    }
}
struct ClientBodyGuard(ClientEvidence);
impl Drop for ClientBodyGuard {
    fn drop(&mut self) {
        self.0 .0.lock().unwrap().finished = true;
        self.0.flush();
    }
}

#[cfg(test)]
mod client_evidence_tests {
    use super::*;

    #[test]
    fn legacy_cli_resume_reuses_the_owned_file_and_survives_reopen() {
        let root = std::env::temp_dir().join(format!(
            "xwx-legacy-cli-{}-{}",
            std::process::id(),
            millis()
        ));
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let file = root.join("legacy-date.jsonl");
        let old = json!({"id":"old-request","sessionId":"legacy-date","source":"codex-vscode","clientConversationKey":"codex-vscode:thread-a","startedAt":"2026-10-21T00:00:00Z","request":{"model":"fixture","headers":{"originator":"codex_exec","thread-id":"thread-a","session-id":"thread-a"},"body":{"input":"same prompt"}},"response":{"statusCode":200},"usage":{"totalTokens":3}});
        let original = format!("{old}\n");
        fs::write(&file, &original).unwrap();
        let index = json!({"version":1,"sessions":[{"id":"legacy-date","source":"codex-vscode","clientConversationKey":"codex-vscode:thread-a","jsonlPath":file,"traceCount":1,"totalTokens":3,"usageByModel":{}}]}).to_string();
        fs::write(root.join("index.json"), &index).unwrap();
        let mut next = old.clone();
        next["id"] = json!("new-request");
        next["source"] = json!("codex-cli");
        next["clientConversationKey"] = json!("codex-cli:thread-a");
        next["request"]["body"]["input"] = json!("resume question");
        for count in [2, 3] {
            next["id"] = json!(format!("new-request-{count}"));
            let store = TraceStore::open(root.clone(), u64::MAX, false, &root).unwrap();
            {
                let mut store = store.lock().unwrap();
                assert_eq!(
                    store.state(false)["sessions"][0]["clientConversationKey"],
                    "codex-cli:thread-a"
                );
                if count == 2 {
                    assert_eq!(fs::read_to_string(root.join("index.json")).unwrap(), index);
                }
                store.append(next.clone(), "codex-cli:thread-a").unwrap();
                let state = store.state(false);
                assert_eq!(state["sessions"].as_array().unwrap().len(), 1);
                assert_eq!(state["sessions"][0]["id"], "legacy-date");
                assert_eq!(state["sessions"][0]["firstPrompt"], "same prompt");
                assert_eq!(state["sessions"][0]["traceCount"], count);
                assert_eq!(state["sessions"][0]["totalTokens"], count * 3);
                assert!(fs::read(&file).unwrap().starts_with(original.as_bytes()));
            }
        }
        let store = TraceStore::open(root.clone(), u64::MAX, false, &root).unwrap();
        next["request"]["headers"]["thread-id"] = json!("thread-b");
        next["request"]["headers"]["session-id"] = json!("thread-b");
        next["clientConversationKey"] = json!("codex-cli:thread-b");
        store
            .lock()
            .unwrap()
            .append(next, "codex-cli:thread-b")
            .unwrap();
        assert_eq!(
            store.lock().unwrap().state(false)["sessions"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stats_distinguish_known_zero_from_missing_cost_without_repricing() {
        let root = std::env::temp_dir().join(format!(
            "xwx-known-cost-{}-{}",
            std::process::id(),
            millis()
        ));
        fs::create_dir_all(&root).unwrap();
        let now = millis();
        let missing = json!({"atMs":now,"tokens":null,"knownCostUsd":null,"costComplete":false});
        let zero = json!({"atMs":now,"tokens":0,"knownCostUsd":0.0,"costComplete":true});
        let index =
            json!({"version":1,"sessions":[{"id":"known-cost","nativeUsage":[zero,missing]}]})
                .to_string();
        fs::write(root.join("index.json"), &index).unwrap();
        let store = TraceStore::open(root.clone(), u64::MAX, false, &root).unwrap();
        {
            let mut store = store.lock().unwrap();
            for (points, count, amount, complete) in [
                (json!([zero, missing]), 1, 0.0, false),
                (json!([missing]), 0, 0.0, false),
                (json!([zero]), 1, 0.0, true),
                (
                    json!([{"atMs":now,"tokens":7,"knownCostUsd":0.003,"costComplete":false},missing]),
                    1,
                    0.003,
                    false,
                ),
                (json!([]), 0, 0.0, true),
            ] {
                store.index["sessions"][0]["nativeUsage"] = points;
                let stats = store.stats();
                for period in ["total", "today", "week"] {
                    assert_eq!(stats[period]["knownCostRequests"], count);
                    assert_eq!(stats[period]["costUsd"], amount);
                    assert_eq!(stats[period]["costComplete"], complete);
                }
            }
        }
        assert_eq!(fs::read_to_string(root.join("index.json")).unwrap(), index);
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn model_field_coverage_keeps_known_zero_after_unknown_and_invalid_requests() {
        let unknown = json!({
            "request":{"model":"known-zero-contract"},
            "usage":{"incompleteFields":["input","cacheRead","cacheWrite","output","total"]},
            "costSnapshot":{"version":1,"knownCostUsd":null,"costComplete":false}
        });
        let zero = json!({
            "request":{"model":"known-zero-contract"},
            "usage":{"version":2,"inputUncachedTokens":0,"inputTotalTokens":0,
                "inputIncludesCache":true,"cacheReadTokens":0,"cacheCreationTokens":0,
                "outputTokens":0,"totalTokens":0,"incompleteFields":[]},
            "costSnapshot":{"version":1,"knownCostUsd":0,"costComplete":true}
        });
        let mut by_model = json!({});
        accumulate_model_usage(&mut by_model, &unknown);
        assert_eq!(
            by_model["known-zero-contract"]["knownFieldCounts"],
            json!({"input":0,"cacheRead":0,"cacheWrite":0,"output":0,"total":0})
        );
        assert!(by_model["known-zero-contract"]["capturedCost"]["cost"].is_null());
        accumulate_model_usage(&mut by_model, &zero);
        assert_eq!(
            by_model["known-zero-contract"]["knownFieldCounts"],
            json!({"input":1,"cacheRead":1,"cacheWrite":1,"output":1,"total":1})
        );
        for key in [
            "input",
            "inputTotal",
            "cacheRead",
            "cacheCreation",
            "output",
            "total",
        ] {
            assert_eq!(by_model["known-zero-contract"][key].as_u64(), Some(0));
        }
        // One illegal counter must not discard independently valid zero fields.
        let mut invalid = zero.clone();
        invalid["usage"]["outputTokens"] = json!(-1);
        invalid["usage"]["invalidFields"] = json!(["output"]);
        invalid["costSnapshot"]["costComplete"] = json!(false);
        accumulate_model_usage(&mut by_model, &invalid);
        assert_eq!(
            by_model["known-zero-contract"]["knownFieldCounts"],
            json!({"input":2,"cacheRead":2,"cacheWrite":2,"output":1,"total":2})
        );
        assert_eq!(by_model["known-zero-contract"]["output"].as_u64(), Some(0));
        assert!(by_model["known-zero-contract"]["invalidFields"]
            .as_array()
            .unwrap()
            .iter()
            .any(|field| field == "output"));
        assert_eq!(
            by_model["known-zero-contract"]["capturedCost"]["cost"].as_f64(),
            Some(0.0)
        );
        assert_eq!(
            by_model["known-zero-contract"]["capturedCost"]["complete"],
            false
        );
        let coverage = by_model["known-zero-contract"]["knownFieldCounts"].clone();
        let bytes = serde_json::to_vec(&by_model).unwrap();
        let mut resumed: Value = serde_json::from_slice(&bytes).unwrap();
        accumulate_model_usage(&mut resumed, &unknown);
        assert_eq!(resumed["known-zero-contract"]["knownFieldCounts"], coverage);
        assert_eq!(resumed["known-zero-contract"]["total"].as_u64(), Some(0));
        assert_eq!(
            resumed["known-zero-contract"]["capturedCost"]["cost"].as_f64(),
            Some(0.0)
        );
        assert_eq!(
            zero["usage"]["outputTokens"], 0,
            "source usage stays read-only"
        );
    }

    #[test]
    fn legacy_known_zero_survives_an_unknown_append_without_raw_history() {
        let mut by_model = json!({"fixture":{"version":2,"input":40,"cacheRead":60,"cacheCreation":0,"output":0,"total":100}});
        let unknown = json!({"request":{"model":"fixture"},"usage":{"incompleteFields":["input","cacheRead","cacheWrite","output","total"]}});
        accumulate_model_usage(&mut by_model, &unknown);
        assert_eq!(by_model["fixture"]["cacheCreation"], 0);
        assert_eq!(
            by_model["fixture"]["knownFieldCounts"],
            json!({"input":1,"cacheRead":1,"cacheWrite":1,"output":1,"total":1})
        );
        let mut fresh = json!({});
        accumulate_model_usage(&mut fresh, &unknown);
        assert_eq!(
            fresh["fixture"]["knownFieldCounts"],
            json!({"input":0,"cacheRead":0,"cacheWrite":0,"output":0,"total":0})
        );
    }

    #[test]
    fn cache_hit_pairs_survive_missing_usage_and_preserve_frozen_history() {
        let known = json!({"inputTotalTokens":100,"inputIncludesCache":true,"cacheReadTokens":60,"cacheCreationTokens":0,"inputUncachedTokens":40});
        let mut stats = Value::Null;
        accumulate_cache_hit_usage(&mut stats, &known);
        accumulate_cache_hit_usage(
            &mut stats,
            &json!({"incompleteFields":["input","cacheRead","cacheWrite"]}),
        );
        assert_eq!(
            stats,
            json!({"inputTokens":100,"cacheReadTokens":60,"knownRequests":1,"excludedRequests":1})
        );
        let root = std::env::temp_dir().join(format!(
            "xwx-cache-history-{}-{}",
            std::process::id(),
            millis()
        ));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("history.jsonl");
        let frozen = json!({"version":1,"costComplete":true,"costUsd":0.123,"knownCostUsd":0.123,"tokens":100});
        let source = [json!({"request":{"model":"fixture"},"usage":known,"costSnapshot":frozen}),json!({"request":{"model":"fixture"},"usage":{"incompleteFields":["input","cacheRead"]},"costSnapshot":{"version":1,"costComplete":false}})].iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
        fs::write(&file, &source).unwrap();
        let original_model = json!({"version":2,"input":40,"cacheRead":60,"cacheCreation":0,"incompleteFields":["input","cacheRead"]});
        let index=json!({"version":1,"sessions":[{"id":"history","jsonlPath":file,"traceCount":2,"costSnapshotVersion":1,"nativeUsage":[frozen,{"version":1,"costComplete":false}],"usageByModel":{"fixture":original_model}}]}).to_string();
        fs::write(root.join("index.json"), &index).unwrap();
        let store = TraceStore::open(root.clone(), u64::MAX, false, &root).unwrap();
        {
            let store = store.lock().unwrap();
            let view = &store.view_sessions()[0];
            assert_eq!(view["cacheHitUsage"], stats);
            let mut annotated_model = original_model.clone();
            annotated_model["knownFieldCounts"] =
                json!({"input":1,"cacheRead":1,"cacheWrite":1,"output":0,"total":0});
            assert_eq!(view["usageByModel"]["fixture"], annotated_model);
            assert_eq!(view["nativeUsage"][0], frozen);
        }
        assert_eq!(fs::read_to_string(&file).unwrap(), source);
        assert_eq!(fs::read_to_string(root.join("index.json")).unwrap(), index);
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn continued_legacy_summary_without_readable_rows_counts_history_as_excluded() {
        for empty_file in [false, true] {
            let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
                "xwx-cache-missing-history-{}-{}-{empty_file}",
                std::process::id(),
                millis()
            ));
            fs::create_dir_all(&root).unwrap();
            let key = "cache-legacy-resume";
            let id = format!("session-{}", &digest(key.as_bytes())[..24]);
            let file = root.join(format!("{id}.jsonl"));
            if empty_file {
                fs::write(&file, "").unwrap();
            }
            let frozen = json!({"version":1,"costComplete":true,"costUsd":0.123,"knownCostUsd":0.123,"tokens":100});
            let frozen_history = vec![frozen; 3];
            let index = json!({"version":1,"sessions":[{"id":id,"clientConversationKey":key,"jsonlPath":file,"traceCount":3,
                "costSnapshotVersion":1,"captureClassificationVersion":1,"errorCount":0,"nativeUsage":frozen_history,
                "totalTokens":300,"usageByModel":{"fixture":{"version":2,"input":0,"cacheRead":0,"cacheCreation":0,
                    "inputTotalComplete":false,"incompleteFields":["input","cacheRead"]}}}]}).to_string();
            fs::write(root.join("index.json"), &index).unwrap();
            let store = TraceStore::open(root.clone(), u64::MAX, false, &root).unwrap();
            let record = json!({"id":"continued","startedAt":"2026-10-14T00:00:00Z","completedAt":"2026-10-14T00:00:01Z",
                "source":"codex-cli","durationMs":1,"request":{"model":"fixture","apiType":"responses","body":{"input":"synthetic"}},
                "usage":{"inputTokens":100,"inputUncachedTokens":40,"inputTotalTokens":100,"inputIncludesCache":true,
                    "cacheReadTokens":60,"cacheCreationTokens":0,"outputTokens":5,"totalTokens":105}});
            {
                let mut store = store.lock().unwrap();
                assert!(store.legacy_costs.is_empty());
                store.append(record, key).unwrap();
                let view = store.view_sessions().remove(0);
                assert_eq!(view["traceCount"], 4);
                assert_eq!(
                    view["cacheHitUsage"],
                    json!({"inputTokens":100,"cacheReadTokens":60,"knownRequests":1,"excludedRequests":3})
                );
                assert_eq!(
                    &view["nativeUsage"].as_array().unwrap()[..3],
                    frozen_history.as_slice()
                );
            }
            drop(store);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn background_history_is_responsive_coalesces_and_preserves_evidence() {
        let root = std::env::temp_dir().join(format!(
            "xwx-background-history-{}-{}",
            std::process::id(),
            millis()
        ));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("legacy.jsonl");
        let row = json!({"request":{"model":"background-fixture","body":{"input":"x".repeat(4096)}},
            "usage":{"inputUncachedTokens":1,"inputTotalTokens":1,"outputTokens":1,"cacheReadTokens":0,"cacheCreationTokens":0,"totalTokens":2}});
        let source = (row.to_string() + "\n").repeat(2000);
        fs::write(&file, &source).unwrap();
        let index = json!({"version":1,"sessions":[{"id":"legacy","jsonlPath":file,"traceCount":2000,"captureClassificationVersion":1}]}).to_string();
        fs::write(root.join("index.json"), &index).unwrap();
        let synchronous = TraceStore::open(root.clone(), u64::MAX, false, &root).unwrap();
        let expected = synchronous.lock().unwrap().legacy_costs.clone();
        drop(synchronous);
        let started = std::time::Instant::now();
        let store = TraceStore::open_background(root.clone(), u64::MAX, false, &root).unwrap();
        assert!(started.elapsed() < Duration::from_secs(1));
        let running = {
            let mut state = store.lock().unwrap();
            for _ in 0..20 {
                state.refresh_legacy_costs();
            }
            state.history_running.clone()
        };
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while running.load(Ordering::SeqCst) {
            assert!(std::time::Instant::now() < deadline);
            let read = std::time::Instant::now();
            assert_eq!(store.lock().unwrap().totals().0, 1);
            assert!(read.elapsed() < Duration::from_millis(250));
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(store.lock().unwrap().legacy_costs, expected);
        assert_eq!(fs::read_to_string(&file).unwrap(), source);
        assert_eq!(fs::read_to_string(root.join("index.json")).unwrap(), index);
        // Dropping the store cancels work without a strong-reference cycle.
        let weak = Arc::downgrade(&store);
        store.lock().unwrap().refresh_legacy_costs();
        drop(store);
        while weak.strong_count() != 0 {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
        // The worker may finish its current read before noticing shutdown.
        std::thread::sleep(Duration::from_millis(100));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unchanged_writer_and_new_captures_do_not_restart_legacy_history() {
        let root = std::env::temp_dir().join(format!(
            "xwx-history-queue-{}-{}",
            std::process::id(),
            millis()
        ));
        fs::create_dir_all(&root).unwrap();
        let row = json!({"id":"old","source":"codex-cli","startedAt":"2026-10-28T00:00:00Z",
            "request":{"model":"queue-fixture","body":{"input":"old context".repeat(400)}},
            "response":{"statusCode":200},"usage":{"inputUncachedTokens":1,"inputTotalTokens":1,"outputTokens":1,"cacheReadTokens":0,"cacheCreationTokens":0,"totalTokens":2}});
        let source = (row.to_string() + "\n").repeat(1000);
        let mut sessions = vec![];
        for id in ["one", "two"] {
            let file = root.join(format!("{id}.jsonl"));
            fs::write(&file, &source).unwrap();
            sessions.push(json!({"id":id,"source":"codex-cli","jsonlPath":file,"clientConversationKey":format!("existing-{id}"),"traceCount":1000,"errorCount":0,"captureClassificationVersion":1}));
        }
        fs::write(
            root.join("index.json"),
            json!({"version":1,"sessions":sessions}).to_string(),
        )
        .unwrap();
        let store = TraceStore::open_background(root.clone(), u64::MAX, false, &root).unwrap();
        let running = {
            let mut state = store.lock().unwrap();
            let generation = state.history_generation.load(Ordering::SeqCst);
            state.begin_writer().unwrap();
            assert_eq!(state.history_generation.load(Ordering::SeqCst), generation);
            for n in 0..20 {
                let mut fresh = row.clone();
                fresh["id"] = json!(format!("fresh-{n}"));
                state.append(fresh, "fresh-session").unwrap();
            }
            assert_eq!(state.history_generation.load(Ordering::SeqCst), generation);
            assert!(state.history_pending.is_empty());
            state.history_running.clone()
        };
        let wait = || {
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            while running.load(Ordering::SeqCst) {
                assert!(std::time::Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(5));
            }
        };
        wait();
        let other = {
            let mut state = store.lock().unwrap();
            let other = state.legacy_costs["two"].clone();
            let generation = state.history_generation.load(Ordering::SeqCst);
            let mut fresh = row.clone();
            fresh["id"] = json!("resumed-old");
            state.append(fresh, "existing-one").unwrap();
            assert_eq!(state.history_generation.load(Ordering::SeqCst), generation);
            assert_eq!(
                state.history_pending.iter().cloned().collect::<Vec<_>>(),
                vec!["one"]
            );
            other
        };
        wait();
        {
            let state = store.lock().unwrap();
            assert_eq!(state.legacy_costs["two"], other);
            assert_eq!(
                state.legacy_costs["one"]["nativeUsage"]
                    .as_array()
                    .unwrap()
                    .len(),
                1001
            );
            assert_eq!(state.totals().1, 2021);
        }
        assert_eq!(fs::read_to_string(root.join("two.jsonl")).unwrap(), source);
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pending_history_retention_keeps_accounting_and_releases_views() {
        let root = std::env::temp_dir().join(format!(
            "xwx-pending-retention-{}-{}",
            std::process::id(),
            millis()
        ));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("legacy.jsonl");
        let row = json!({"request":{"model":"fixture","body":{"input":"x".repeat(1024)}},
            "usage":{"inputUncachedTokens":1,"inputTotalTokens":1,"outputTokens":1,"cacheReadTokens":0,"cacheCreationTokens":0,"totalTokens":2}});
        let source = (row.to_string() + "\n").repeat(1000);
        let index = json!({"version":1,"sessions":[{"id":"legacy","jsonlPath":file,"traceCount":1000,"captureClassificationVersion":1}]}).to_string();
        for limit in [u64::MAX, 0] {
            fs::write(&file, &source).unwrap();
            fs::write(root.join("index.json"), &index).unwrap();
            let store = TraceStore::open_background(root.clone(), limit, false, &root).unwrap();
            if limit > 0 {
                let mut state = store.lock().unwrap();
                assert!(state.delete("legacy", false).unwrap());
                assert!(state.legacy_costs.is_empty());
                assert!(state.legacy_annotations.is_empty());
                assert!(state.page_cache.lock().unwrap().is_empty());
            }
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            loop {
                let state = store.lock().unwrap();
                if !state.history_running.load(Ordering::SeqCst) {
                    assert_eq!(state.stats()["total"]["tokens"], 2000);
                    assert_eq!(state.totals().0, 0);
                    break;
                }
                drop(state);
                assert!(std::time::Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(5));
            }
            assert!(!file.exists());
            drop(store);
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_cost_view_rebuilds_raw_usage_without_writing_evidence() {
        let root = std::env::temp_dir().join(format!(
            "xwx-legacy-cost-{}-{}",
            std::process::id(),
            millis()
        ));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("legacy.jsonl");
        let frozen = json!({"version":1,"atMs":1,"tokens":2,"knownCostUsd":0.123,"costUsd":0.123,"costComplete":true});
        let row = |input| json!({"startedAt":"2026-10-13T00:00:00Z","protocol":"openai-responses","request":{"model":"legacy-fixture"},"usage":{"totalTokens":0},"usageEvidence":{"upstream":{"protocol":"responses","raw":{"input_tokens":input,"output_tokens":5,"input_tokens_details":{"cached_tokens":if input==100 {60} else {0},"cache_write_tokens":0}}}}});
        let source=[row(100),row(101),json!({"request":{"model":"legacy-fixture"},"usage":{"version":2,"inputUncachedTokens":1,"inputTotalTokens":1,"outputTokens":1,"cacheReadTokens":0,"cacheCreationTokens":0,"totalTokens":2},"costSnapshot":frozen})].iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
        fs::write(&file, &source).unwrap();
        let index=json!({"version":1,"sessions":[{"id":"legacy","jsonlPath":file,"traceCount":3,"captureClassificationVersion":1,"totalTokens":0,"usageByModel":{}}]}).to_string();
        fs::write(root.join("index.json"), &index).unwrap();
        let store = TraceStore::open(root.clone(), u64::MAX, false, &root).unwrap();
        {
            let mut store = store.lock().unwrap();
            store.prices = vec![
                json!({"modelId":"legacy-fixture","input":2,"output":10,"cacheRead":0.1,"cacheWrite":2,"tiers":[{"fromInputTokens":0,"input":2,"output":10,"cacheRead":0.1,"cacheWrite":2},{"fromInputTokens":101,"input":4,"output":15,"cacheRead":0.2,"cacheWrite":4}]}),
            ];
            store.refresh_legacy_costs();
            let view = &store.view_sessions()[0];
            assert_eq!(view["costViewBasis"], "legacy-current-reference");
            assert_eq!(view["totalTokens"], 213);
            assert_eq!(
                view["usageByModel"]["legacy-fixture"]["capturedCost"]["complete"],
                true
            );
            assert!(
                (view["usageByModel"]["legacy-fixture"]["capturedCost"]["cost"]
                    .as_f64()
                    .unwrap()
                    - 0.123615)
                    .abs()
                    < 1e-12
            );
            assert_eq!(view["nativeUsage"][2], frozen);
            assert!(view["nativeUsage"][0]["atMs"].as_u64().is_some());
            assert_eq!(store.index["sessions"][0]["totalTokens"], 0);
            let page = store.page("legacy", Some(0), None, 200).unwrap().unwrap();
            assert_eq!(page["traces"][1]["usage"]["inputTotalTokens"], 100);
            assert_eq!(
                page["traces"][1]["costViewBasis"],
                "legacy-current-reference"
            );
            store.index["sessions"][0]["traceCount"] = json!(4);
            store.refresh_legacy_costs();
            assert_eq!(
                store.view_sessions()[0]["usageByModel"]["legacy-fixture"]["capturedCost"]
                    ["complete"],
                false
            );
        }
        assert_eq!(fs::read_to_string(&file).unwrap(), source);
        assert_eq!(fs::read_to_string(root.join("index.json")).unwrap(), index);
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn live_notifications_do_not_retain_full_request_or_response_bodies() {
        let root = std::env::temp_dir().join(format!(
            "xwx-event-bodies-{}-{}",
            std::process::id(),
            millis()
        ));
        fs::create_dir_all(&root).unwrap();
        let store = TraceStore::open(root.clone(), u64::MAX, false, &root).unwrap();
        let mut receiver = store.lock().unwrap().events.subscribe();
        let body = "large retained context ".repeat(100_000);
        let record = json!({"id":"large-event","source":"codex-cli","startedAt":"2026-10-28T00:00:00Z","request":{"model":"fixture","body":{"input":[{"role":"user","content":"Small first prompt"},{"role":"assistant","content":body}]}},"response":{"statusCode":200,"body":{"output_text":body}},"usage":{"totalTokens":2}});
        store
            .lock()
            .unwrap()
            .append(record, "large-event-session")
            .unwrap();
        let event = loop {
            let event = receiver.try_recv().unwrap();
            if event.starts_with("event: trace") {
                break event;
            }
        };
        assert!(event.len() < 16 * 1024);
        let event: Value =
            serde_json::from_str(event.split_once("data: ").unwrap().1.trim()).unwrap();
        assert_eq!(event["summaryOnly"], true);
        assert_eq!(event["clientFirstPrompt"], "Small first prompt");
        assert!(event["request"]["body"].is_null());
        assert!(event["response"]["body"].is_null());
        let page = store
            .lock()
            .unwrap()
            .page(text(&event, "sessionId"), None, None, 1)
            .unwrap()
            .unwrap();
        assert_eq!(
            page["traces"][0]["request"]["body"]["input"][1]["content"],
            body
        );
        assert_eq!(page["traces"][0]["response"]["body"]["output_text"], body);
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn committed_appends_extend_summary_cache_without_reopening_old_bodies() {
        use std::io::Write;
        let root = std::env::temp_dir().join(format!(
            "xwx-append-cache-{}-{}",
            std::process::id(),
            millis()
        ));
        fs::create_dir_all(&root).unwrap();
        let store = TraceStore::open(root.clone(), u64::MAX, false, &root).unwrap();
        let body = "exact large body ".repeat(1000);
        let row = |id: &str| json!({"id":id,"source":"codex-cli","startedAt":"2026-10-28T00:00:00Z","request":{"model":"unknown-fixture","body":{"input":"small prompt"}},"response":{"statusCode":200,"body":{"output_text":body}},"usage":{"totalTokens":2}});
        let mut state = store.lock().unwrap();
        state.append(row("a"), "append-cache").unwrap();
        let session = state.view_sessions()[0].clone();
        let id = text(&session, "id");
        let file = PathBuf::from(session["jsonlPath"].as_str().unwrap());
        let first = state.page_reader().file_rows(&file).unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].summary["costSnapshot"]["costComplete"], false);
        state.append(row("b"), "append-cache").unwrap();
        let db = trace_content::path(&file);
        let held = db.with_extension("held");
        fs::rename(&db, &held).unwrap();
        // A full rescan would try to decode the missing content database.
        let reader = state.page_reader();
        let updated = reader.file_rows(&file).unwrap();
        assert_eq!(updated.len(), 2);
        assert_eq!(first.len(), 1, "in-flight snapshots keep their old rows");
        assert_eq!(updated[0].summary, first[0].summary);
        assert!(updated
            .iter()
            .all(|r| r.summary["response"]["body"].is_null()));
        assert_eq!(
            reader
                .page(id, None, None, 200, true, None)
                .unwrap()
                .unwrap()["total"],
            2
        );
        fs::rename(&held, &db).unwrap();
        assert_eq!(
            reader
                .page(id, None, None, 1, false, Some("b"))
                .unwrap()
                .unwrap()["traces"][0]["response"]["body"]["output_text"],
            body
        );
        state.page_cache.lock().unwrap().remove(&file);
        let rebuilt = state.page_reader().file_rows(&file).unwrap();
        for (cached, rebuilt) in updated.iter().zip(rebuilt.iter()) {
            assert_eq!(
                cached.summary, rebuilt.summary,
                "append and full-read cost projections agree"
            );
        }
        state.prices = vec![json!({"modelId":"unknown-fixture","input":2,"output":10})];
        state.append(row("c"), "append-cache").unwrap();
        assert!(
            !state.page_cache.lock().unwrap().contains_key(&file),
            "changed prices invalidate the old projection"
        );
        let reader = state.page_reader();
        let repaired = reader
            .page(id, None, None, 200, true, None)
            .unwrap()
            .unwrap();
        assert_eq!(repaired["total"], 3);
        fs::OpenOptions::new()
            .append(true)
            .open(&file)
            .unwrap()
            .write_all(b"\n")
            .unwrap();
        state.append(row("d"), "append-cache").unwrap();
        assert!(
            !state.page_cache.lock().unwrap().contains_key(&file),
            "external writes invalidate the observed prefix"
        );
        assert_eq!(
            state
                .page_reader()
                .page(id, None, None, 200, true, None)
                .unwrap()
                .unwrap()["total"],
            4
        );
        drop(state);
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn page_reader_reuses_metadata_and_observes_committed_appends() {
        use std::io::Write;
        let root = std::env::temp_dir().join(format!(
            "xwx-page-cache-{}-{}",
            std::process::id(),
            millis()
        ));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("cache.jsonl");
        let row = |id: &str| {
            json!({"id":id,"sessionId":"cache","startedAt":"2026-10-16T00:00:00Z","request":{"body":{"input":"exact body"}},"costSnapshot":{"version":1,"costComplete":true}}).to_string()+"\n"
        };
        fs::write(&file, row("a")).unwrap();
        fs::write(root.join("index.json"),json!({"version":1,"sessions":[{"id":"cache","jsonlPath":file,"traceCount":1,"captureClassificationVersion":1}]}).to_string()).unwrap();
        let store = TraceStore::open(root.clone(), u64::MAX, false, &root).unwrap();
        let reader = store.lock().unwrap().page_reader();
        // The reader must work while another operation owns the Gateway lock.
        let guard = store.lock().unwrap();
        let first = reader.file_rows(&file).unwrap();
        assert!(Arc::ptr_eq(&first, &reader.file_rows(&file).unwrap()));
        assert!(first[0].summary["request"]["body"].is_null());
        assert_eq!(
            reader
                .page("cache", None, None, 200, false, Some("a"))
                .unwrap()
                .unwrap()["traces"][0]["request"]["body"]["input"],
            "exact body"
        );
        drop(guard);
        fs::OpenOptions::new()
            .append(true)
            .open(&file)
            .unwrap()
            .write_all(row("b").as_bytes())
            .unwrap();
        // A pre-existing reader stays at its committed boundary.
        assert_eq!(
            reader
                .page("cache", None, None, 200, true, None)
                .unwrap()
                .unwrap()["total"],
            1
        );
        let next = store.lock().unwrap().page_reader();
        assert_eq!(
            next.page("cache", None, None, 200, true, None)
                .unwrap()
                .unwrap()["total"],
            2
        );
        assert!(!Arc::ptr_eq(&first, &next.file_rows(&file).unwrap()));
        let old_prices = next.file_rows(&file).unwrap();
        store.lock().unwrap().prices = vec![json!({"model":"changed-reference"})];
        let repriced = store.lock().unwrap().page_reader();
        assert!(!Arc::ptr_eq(
            &old_prices,
            &repriced.file_rows(&file).unwrap()
        ));
        fs::write(&file, row("c")).unwrap();
        let replaced = store.lock().unwrap().page_reader();
        assert_eq!(
            replaced
                .page("cache", None, None, 200, false, Some("c"))
                .unwrap()
                .unwrap()["traces"][0]["id"],
            "c"
        );
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn json_byte_budget_matches_wire_encoding() {
        let values = [
            Value::Null,
            json!({"empty":[],"nested":{"boolean":true,"number":-1.25e12}}),
            json!({"quote":"\"\\\n\t\u{0000}","unicode":"正文😀","array":[null,42,false]}),
            json!({"body":"正文😀\"\\\n".repeat(100_000)}),
        ];
        for value in values {
            assert_eq!(json_byte_len(&value).unwrap(), value.to_string().len());
        }
    }

    #[test]
    fn large_pages_are_contiguous_from_both_edges_and_keep_latest() {
        let root = std::env::temp_dir().join(format!(
            "xwx-page-boundary-{}-{}",
            std::process::id(),
            millis()
        ));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("large.jsonl");
        let payload = "x".repeat(9 * 1024 * 1024);
        let source = (0..5).map(|n| json!({"id":format!("large-{n}"),"sessionId":"large","startedAt":format!("2026-10-13T00:00:0{n}Z"),"request":{"body":{"input":payload}}}).to_string()).collect::<Vec<_>>().join("\n");
        fs::write(&file, &source).unwrap();
        fs::write(root.join("index.json"),json!({"version":1,"sessions":[{"id":"large","jsonlPath":file,"traceCount":5,"captureClassificationVersion":1,"source":"codex-cli"}]}).to_string()).unwrap();
        let store = TraceStore::open(root.clone(), u64::MAX, false, &root).unwrap();
        {
            let store = store.lock().unwrap();
            let tail = store.page("large", None, None, 200).unwrap().unwrap();
            assert_eq!(tail["offset"], 3);
            assert_eq!(tail["traces"][1]["id"], "large-4");
            let before = store.page("large", None, Some(3), 200).unwrap().unwrap();
            assert_eq!(before["offset"], 1);
            assert_eq!(before["traces"][0]["turn"], 2);
            assert_eq!(before["traces"][1]["id"], "large-2");
            let first = store.page("large", None, Some(1), 200).unwrap().unwrap();
            assert_eq!(first["offset"], 0);
            assert_eq!(first["traces"][0]["id"], "large-0");
            let forward = store.page("large", Some(1), None, 200).unwrap().unwrap();
            assert_eq!(forward["offset"], 1);
            assert_eq!(forward["traces"][1]["id"], "large-2");
            let summary = store
                .page_projection("large", Some(0), None, 200, true, None)
                .unwrap()
                .unwrap();
            assert_eq!(summary["offset"], 0);
            assert_eq!(summary["traces"].as_array().unwrap().len(), 5);
            assert_eq!(summary["traces"][0]["id"], "large-0");
            assert_eq!(summary["traces"][4]["turn"], 5);
            assert_eq!(summary["traces"][0]["summaryOnly"], true);
            assert!(summary["traces"][0]["request"]["body"].is_null());
            assert!(summary.to_string().len() < 10_000);
            let selected = store
                .page_projection("large", None, None, 200, false, Some("large-4"))
                .unwrap()
                .unwrap();
            assert_eq!(selected["traces"].as_array().unwrap().len(), 1);
            assert_eq!(selected["traces"][0]["id"], "large-4");
            assert_eq!(
                selected["traces"][0]["request"]["body"]["input"]
                    .as_str()
                    .unwrap()
                    .len(),
                payload.len()
            );
            assert_eq!(fs::read_to_string(&file).unwrap(), source);
            assert_eq!(
                store.session_file("large").unwrap(),
                file.canonicalize().unwrap()
            );
            assert!(store.session_file("../outside").is_err());
        }
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn native_embeds_repository_prices_for_offline_billing() {
        let rules: Vec<Value> =
            serde_json::from_str(crate::embedded_assets::prices().unwrap()).unwrap();
        assert!(
            !rules.is_empty()
                && rules
                    .iter()
                    .all(|r| r["referenceOnly"] == true && r["source"] == "models.dev"),
            "native build must embed only the standard reference catalog"
        );
        let price = rules
            .iter()
            .find(|r| r["modelId"] == "mimo-v2.6-pro")
            .expect("new provider included offline");
        let usage = json!({"inputUncachedTokens":40,"inputTotalTokens":100,"outputTokens":5,"cacheReadTokens":60,"cacheCreationTokens":0});
        let expected = (40.0 * price["input"].as_f64().unwrap()
            + 5.0 * price["output"].as_f64().unwrap()
            + 60.0 * price["cacheRead"].as_f64().unwrap())
            / 1_000_000.0;
        assert!((model_cost(&rules, "mimo-v2.6-pro", &usage, 0).unwrap() - expected).abs() < 1e-12);
    }
    #[test]
    fn billing_uses_relevant_counters_and_keeps_unknowns() {
        let price = json!({"match":"exact","modelId":"fixture","protocol":"openai","input":1,"output":2,"cacheRead":0.1,"cacheWritePolicy":"input"});
        let raw = json!({"usage":{"input_tokens":100,"output_tokens":5,"input_tokens_details":{"cached_tokens":60}}});
        let u = usage(&raw, "responses");
        assert_eq!(u["incompleteFields"], json!(["cacheWrite"]));
        assert!(
            (model_cost(std::slice::from_ref(&price), "fixture", &u, 0).unwrap() - 0.000056).abs()
                < 1e-12
        );
        let mut premium = price.clone();
        premium["cacheWrite"] = json!(1.25);
        assert!(model_cost(&[premium.clone()], "fixture", &u, 0).is_none());
        let unknown_read = usage(
            &json!({"usage":{"input_tokens":100,"output_tokens":5,"input_tokens_details":{"cache_write_tokens":0}}}),
            "responses",
        );
        assert!(model_cost(std::slice::from_ref(&price), "fixture", &unknown_read, 0).is_none());
        let mut uniform = price.clone();
        uniform["cacheRead"] = json!(1);
        assert!(
            (model_cost(&[uniform], "fixture", &unknown_read, 0).unwrap() - 0.00011).abs() < 1e-12
        );
        let ttl = usage(
            &json!({"usage":{"input_tokens":20,"output_tokens":5,"cache_read_input_tokens":60,"cache_creation_input_tokens":20,"cache_creation":{"ephemeral_5m_input_tokens":10,"ephemeral_1h_input_tokens":10}}}),
            "messages",
        );
        premium["protocol"] = json!("anthropic");
        assert!(
            (model_cost(&[premium.clone()], "fixture", &ttl, 0).unwrap() - 0.0000685).abs() < 1e-12
        );
        let mut unknown_ttl = ttl.clone();
        unknown_ttl["cacheCreation5mTokens"] = Value::Null;
        unknown_ttl["cacheCreation1hTokens"] = Value::Null;
        assert!(model_cost(&[premium.clone()], "fixture", &unknown_ttl, 0).is_none());
        let mut storage_price = premium;
        storage_price["cacheStoragePerHour"] = json!(1);
        assert!(model_cost(&[storage_price], "fixture", &ttl, 0).is_none());
        let mut absent_total = u.clone();
        absent_total["incompleteFields"] = json!(["total", "cacheWrite"]);
        assert!(model_cost(&[price], "fixture", &absent_total, 0).is_some());
        let family = json!({"tokens":["gpt-5"],"protocol":"openai","input":1,"output":2,"cacheRead":0.1,"cacheWritePolicy":"input"});
        assert!(model_cost(std::slice::from_ref(&family), "gpt-5-codex", &u, 0).is_none());
        assert!(
            model_cost(&[family], "gpt-5.7", &u, 0).is_none(),
            "new model versions must not inherit a generic legacy price"
        );
    }

    #[test]
    fn exact_prices_prefer_source_qualification_and_keep_first_tie() {
        let usage = json!({"inputUncachedTokens":10,"inputTotalTokens":10,"outputTokens":0,"cacheReadTokens":0,"cacheCreationTokens":0});
        let bare = json!({"match":"exact","modelId":"fixture","input":1,"output":2});
        let qualified = json!({"match":"exact","modelId":"relay/fixture","input":9,"output":2});
        let later = json!({"match":"exact","modelId":"relay/fixture","input":99,"output":2});
        let cost = model_cost(
            &[bare, qualified.clone(), later],
            "relay/fixture",
            &usage,
            0,
        )
        .unwrap();
        assert!((cost - 0.00009).abs() < 1e-12);
        assert!(model_cost(&[qualified], "fixture", &usage, 0).is_none());
    }

    #[test]
    fn shared_partial_cost_corpus() {
        let cases: Vec<Value> = serde_json::from_str(include_str!(
            "../../tools/shared-core/trace-cost-cases.json"
        ))
        .unwrap();
        for case in cases {
            let u = &case["usage"];
            let mut usage = json!({"inputIncludesCache":u["apiType"] != "messages"});
            for (from, to) in [
                ("input", "inputUncachedTokens"),
                ("inputTotal", "inputTotalTokens"),
                ("output", "outputTokens"),
                ("cacheRead", "cacheReadTokens"),
                ("cacheCreation", "cacheCreationTokens"),
                ("cacheCreation5m", "cacheCreation5mTokens"),
                ("cacheCreation1h", "cacheCreation1hTokens"),
                ("incompleteFields", "incompleteFields"),
                ("invalidFields", "invalidFields"),
                ("reasoning", "reasoningTokens"),
                ("reasoningComplete", "reasoningComplete"),
            ] {
                usage[to] = u[from].clone();
            }
            let mut price = case["price"].clone();
            price["tokens"] = json!(["fixture"]);
            price["match"] = json!("exact");
            let (cost, complete) = model_cost_parts(&[price], "fixture", &usage, 0);
            assert_eq!(
                complete,
                case["complete"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
            assert!(
                (cost.unwrap() - case["cost"].as_f64().unwrap()).abs() < 1e-12,
                "{}: {:?}",
                case["name"],
                cost
            );
        }
    }

    #[test]
    fn cache_usage_preserves_protocol_semantics_and_unknown_buckets() {
        let openai = usage(
            &json!({"usage":{"prompt_tokens":100,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":60}}}),
            "openai-chat-completions",
        );
        assert_eq!(openai["inputUncachedTokens"], 40);
        assert_eq!(openai["inputTotalTokens"], 100);
        assert_eq!(openai["cacheReadTokens"], 60);
        assert_eq!(openai["cacheCreationTokens"], 0);
        assert_eq!(openai["incompleteFields"], json!([]));
        let messages = usage(
            &json!({"usage":{"input_tokens":20,"output_tokens":5,"cache_read_input_tokens":60,"cache_creation_input_tokens":20}}),
            "anthropic-messages",
        );
        assert_eq!(messages["inputUncachedTokens"], 20);
        assert_eq!(messages["inputTotalTokens"], 100);
        assert_eq!(messages["incompleteFields"], json!([]));
        let unknown = usage(
            &json!({"usage":{"input_tokens":20,"output_tokens":5}}),
            "anthropic-messages",
        );
        assert_eq!(unknown["incompleteFields"], json!([]));
        let explicit_zero = usage(
            &json!({"usage":{"input_tokens":20,"output_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}),
            "anthropic-messages",
        );
        assert_eq!(explicit_zero["incompleteFields"], json!([]));
    }

    #[test]
    fn unpolled_client_body_still_runs_finalizer() {
        let evidence = ClientEvidence::default();
        let _capture = evidence.capture();
        let response = evidence.response(Response::new(Body::from("unread")));
        assert!(!evidence.0.lock().unwrap().finished);
        drop(response);
        let state = evidence.0.lock().unwrap();
        assert!(state.finished);
        assert!(!state.ended);
        assert!(state.raw.is_empty());
    }

    #[test]
    fn transport_failure_keeps_only_the_forwarded_prefix() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let evidence = ClientEvidence::default();
                let _capture = evidence.capture();
                let chunks = futures_util::stream::iter([
                    Ok(axum::body::Bytes::from_static(b"visible prefix")),
                    Err(std::io::Error::other("fixture failure")),
                ]);
                let response = evidence.response(Response::new(Body::from_stream(chunks)));
                assert!(to_bytes(response.into_body(), 1024).await.is_err());
                let state = evidence.0.lock().unwrap();
                assert!(state.finished);
                assert!(!state.ended);
                assert_eq!(state.raw, b"visible prefix");
            });
    }

    #[test]
    fn eof_is_distinct_from_dropping_a_body() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let evidence = ClientEvidence::default();
                let _capture = evidence.capture();
                let response = evidence.response(Response::new(Body::from("complete")));
                assert_eq!(
                    &to_bytes(response.into_body(), 1024).await.unwrap()[..],
                    b"complete"
                );
                let state = evidence.0.lock().unwrap();
                assert!(state.finished && state.ended);
            });
    }
}

pub(super) struct Capture {
    pub _detail_lease: Option<DetailLease>,
    pub store: Store,
    pub record: Value,
    pub wire: String,
    pub key: String,
    pub raw: Vec<u8>,
    pub chunk_receipts: Vec<(usize, u128)>,
    pub overflow: bool,
    pub done: bool,
    pub client_evidence: Option<ClientEvidence>,
}
impl Capture {
    pub fn chunk(&mut self, bytes: &[u8]) {
        if self.raw.len() + bytes.len() <= 32 * 1024 * 1024 {
            self.raw.extend_from_slice(bytes);
            self.chunk_receipts.push((
                self.raw.len(),
                millis().saturating_sub(self.record["startedAtMs"].as_u64().unwrap_or(0) as u128),
            ));
        } else {
            self.overflow = true;
        }
    }
    pub fn finish(mut self, value: Option<Value>) {
        self.done = true;
        self.save(value);
    }
    fn save(&mut self, value: Option<Value>) {
        // Codex WS prewarm creates a response with generate=false. It still
        // participates in continuation caching, but is not a generated turn.
        if self.record["request"]["body"]["generate"] == false {
            return;
        }
        let end = millis();
        self.record["completedAt"] = json!(iso(end));
        self.record["durationMs"] =
            json!(end.saturating_sub(self.record["startedAtMs"].as_u64().unwrap_or(0) as u128));
        let raw = String::from_utf8_lossy(&self.raw);
        let parsed = value
            .or_else(|| serde_json::from_slice::<Value>(&self.raw).ok())
            .or_else(|| {
                super::protocol::collapse_sse(
                    &raw,
                    &self.wire,
                    text(&self.record["request"], "model"),
                )
                .ok()
            });
        if self.done && !self.overflow {
            let status = self.record["upstream"]["statusCode"].as_u64().unwrap_or(0) as u16;
            let value = parsed.as_ref().unwrap_or(&Value::Null);
            let success = ((200..300).contains(&status)
                || self.record["request"]["method"] == "WS")
                && parsed.is_some()
                && super::retired_models::successful(&self.wire, value);
            let root = self.store.lock().unwrap().data_root.clone();
            if let Err(error) = super::retired_models::observe(
                &root,
                text(&self.record["provider"], "id"),
                text(&self.record, "catalogIdentity"),
                text(&self.record["request"], "model"),
                status,
                value,
                success,
            ) {
                eprintln!("{error}");
            }
        }
        self.record["usage"] = parsed
            .as_ref()
            .map(|v| record_usage(v, &self.wire, &self.record))
            .unwrap_or_else(|| usage(&Value::Null, &self.wire));
        self.record["upstream"]["rawBody"] = json!(raw);
        self.record["response"]["rawBody"] = self
            .record
            .get("clientRawBody")
            .cloned()
            .unwrap_or(json!(raw));
        self.record.as_object_mut().unwrap().remove("clientRawBody");
        if let Some(ref v) = parsed {
            self.record["upstream"]["body"] = v.clone();
            if self.record["response"].get("body").is_none() {
                self.record["response"]["body"] = v.clone();
            }
            self.record["usageEvidence"] =
                json!({"upstream":{"protocol":self.wire,"raw":v["usage"]}});
        }
        let client_protocol = text(&self.record["contextChanges"], "clientProtocol").to_string();
        if ["chat-completions", "gemini"].contains(&client_protocol.as_str()) {
            let body = self.record["response"]["body"].clone();
            if body["object"] == "response" {
                self.record["intermediateResponse"] = json!({"protocol":"responses","body":body,"rawBody":self.record["response"]["rawBody"]});
                self.record["response"]["body"] =
                    super::ingress::response_json(&body, &client_protocol);
                self.record["response"]["rawBody"] = Value::Null;
                self.record["response"]["bodyFormat"] = json!("assembled");
            }
            self.record["response"]["protocol"] = json!(client_protocol);
        }
        let mut events = vec![];
        let mut block = String::new();
        let mut offset = 0;
        let mut receipt = 0;
        for line in raw.split_inclusive('\n') {
            offset += line.len();
            if line.trim_matches(['\r', '\n']).is_empty() {
                let data = block
                    .lines()
                    .filter_map(|l| l.strip_prefix("data:").map(str::trim_start))
                    .collect::<Vec<_>>()
                    .join("\n");
                if !data.is_empty() {
                    while receipt + 1 < self.chunk_receipts.len()
                        && self.chunk_receipts[receipt].0 < offset
                    {
                        receipt += 1;
                    }
                    let timestamp = self.chunk_receipts.get(receipt).map(|(_, at)| *at);
                    events.push(json!({"event":block.lines().find_map(|l|l.strip_prefix("event:").map(str::trim)),"data":data,"json":serde_json::from_str::<Value>(&data).ok(),"timestampMs":timestamp}));
                }
                block.clear();
            } else {
                block.push_str(line);
            }
        }
        self.record["sse"] =
            json!({"events":events,"timingBasis":"relative-upstream-chunk-receipt"});
        if self.overflow {
            self.record["error"] = json!("记录正文超过 32 MB，已截断；网络转发保持完整");
        }
        if !self.done {
            self.record["error"] = json!("客户端断开或上游流中断，记录为未完成");
        } else if parsed.is_none()
            && self.record["upstream"]["statusCode"]
                .as_u64()
                .is_some_and(|status| (200..300).contains(&status))
        {
            self.record["error"] =
                json!("上游正文或协议流未完整结束，未将 HTTP 成功视为模型请求成功");
        }
        if parsed
            .as_ref()
            .is_some_and(|v| [json!("failed"), json!("incomplete")].contains(&v["status"]))
        {
            self.record["error"] = json!("上游响应未完成");
        }
        if let Some(evidence) = &self.client_evidence {
            evidence.publish(self.store.clone(), self.key.clone(), self.record.clone());
            return;
        }
        if let Err(e) = self
            .store
            .lock()
            .unwrap()
            .append(self.record.clone(), &self.key)
        {
            eprintln!("Trace capture failed: {e}");
        }
    }
}
impl Drop for Capture {
    fn drop(&mut self) {
        if !self.done {
            self.save(None);
        }
    }
}

#[derive(Clone)]
pub(super) struct DashboardState {
    pub store: Store,
    pub stopped: tokio::sync::watch::Receiver<bool>,
}
pub(super) async fn dashboard(State(context): State<DashboardState>, request: Request) -> Response {
    if *context.stopped.borrow() {
        return protocol_error(
            410,
            "responses",
            "Trace directory changed; reopen the dashboard",
        );
    }
    let store = context.store;
    let path = request.uri().path().to_owned();
    let method = request.method().clone();
    let host = request
        .headers()
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !(host.starts_with("127.0.0.1:") || host.starts_with("localhost:")) {
        return protocol_error(403, "responses", "Invalid local Host");
    }
    if path.starts_with("/fonts/") && method == axum::http::Method::GET {
        return match crate::embedded_fonts::get(&path) {
            Some(bytes) => (
                [
                    ("content-type", "font/woff2"),
                    ("cache-control", "public, max-age=31536000, immutable"),
                ],
                bytes,
            )
                .into_response(),
            None => axum::http::StatusCode::NOT_FOUND.into_response(),
        };
    }
    if method != axum::http::Method::GET {
        let origin = request
            .headers()
            .get("origin")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if origin != format!("http://{host}") {
            return protocol_error(403, "responses", "Invalid dashboard Origin");
        }
    }
    if path == "/__native-viewer-smoke"
        && method == axum::http::Method::POST
        && std::env::args().any(|a| a == "--smoke")
    {
        let data = match to_bytes(request.into_body(), 128 * 1024).await {
            Ok(data) => data,
            Err(_) => return protocol_error(400, "responses", "Invalid smoke report"),
        };
        let report: Value = match serde_json::from_slice(&data) {
            Ok(report) => report,
            Err(_) => return protocol_error(400, "responses", "Invalid smoke JSON"),
        };
        if !report["passed"].is_boolean() {
            return protocol_error(400, "responses", "Invalid smoke report");
        }
        let file = match store.lock() {
            Ok(store) => store.root.join("native-viewer-smoke.json"),
            Err(_) => return protocol_error(500, "responses", "Trace store unavailable"),
        };
        if let Err(error) = write(&file, &report.to_string()) {
            return protocol_error(500, "responses", &error);
        }
        return Response::builder()
            .status(200)
            .body(Body::from("{}"))
            .unwrap();
    }
    if path == "/events" && method == axum::http::Method::GET {
        let mut receiver = match store.lock() {
            Ok(store) => store.events.subscribe(),
            Err(_) => return protocol_error(500, "responses", "Trace store unavailable"),
        };
        let mut stopped = context.stopped;
        let stream = async_stream::stream! {
            yield Ok::<_,std::convert::Infallible>(": connected\n\n".to_string());
            loop{if *stopped.borrow(){break;}tokio::select!{
                _=stopped.changed()=>break,
                event=receiver.recv()=>{match event{Ok(event)=>yield Ok(event),Err(tokio::sync::broadcast::error::RecvError::Lagged(_))=>yield Ok("event: reset\ndata: {}\n\n".into()),Err(_)=>break,}}
                _=tokio::time::sleep(Duration::from_secs(10))=>{yield Ok(": heartbeat\n\n".into());}
            }}
        };
        return Response::builder()
            .status(200)
            .header("content-type", "text/event-stream")
            .header("cache-control", "no-cache")
            .body(Body::from_stream(stream))
            .unwrap();
    }
    let result = tokio::task::spawn_blocking(move || -> Result<(String, &str)> {
        let mut store = store.lock().map_err(err)?;
        if ["/", "/dashboard", "/index.html"].contains(&path.as_str()) {
            let preference = serde_json::to_string(&store.theme).map_err(err)?;
            let mut html = crate::embedded_assets::themed_viewer(&preference)?;
            if std::env::args().any(|a| a == "--smoke") {
                html = html.replace(
                    "</body>",
                    &format!(
                        "<script>{}</script></body>",
                        if std::env::args().any(|a| a == "--smoke-performance") {
                            include_str!("../../tools/native/performance-viewer-smoke.js")
                        } else if std::env::args().any(|a| a == "--smoke-window-lifecycle") {
                            include_str!("../../tools/native/window-lifecycle-viewer-smoke.js")
                        } else if std::env::args().any(|a| a == "--smoke-theme") {
                            include_str!("../../tools/native/theme-viewer-smoke.js")
                        } else {
                            include_str!("../../tools/native/viewer-smoke.js")
                        }
                    ),
                );
            }
            return Ok((html, "text/html; charset=utf-8"));
        }
        if path == "/api/theme" {
            return Ok((
                json!({"theme":store.theme,"language":store.language}).to_string(),
                "application/json",
            ));
        }
        if path == "/api/state" {
            return Ok((store.state(store.active).to_string(), "application/json"));
        }
        if let Some(id) = path.strip_prefix("/api/session/") {
            if let Some(id) = id.strip_suffix("/reveal") {
                if method != axum::http::Method::POST {
                    return Err("method not allowed".into());
                }
                let file = store.session_file(id)?;
                // OS Shell dispatch must not hold the Trace store lock.
                drop(store);
                #[cfg(target_os = "macos")]
                let status = std::process::Command::new("/usr/bin/open")
                    .arg("-R")
                    .arg(&file)
                    .status()
                    .map_err(err)?;
                #[cfg(target_os = "windows")]
                windows_reveal::reveal(&file)?;
                #[cfg(not(any(target_os = "macos", target_os = "windows")))]
                let status = std::process::Command::new("xdg-open")
                    .arg(file.parent().ok_or("日志目录无效")?)
                    .status()
                    .map_err(err)?;
                #[cfg(not(target_os = "windows"))]
                if !status.success() {
                    return Err("无法打开日志所在文件夹".into());
                }
                return Ok((json!({"ok":true}).to_string(), "application/json"));
            }
            if method == axum::http::Method::DELETE {
                let url = reqwest::Url::parse(&format!("http://localhost{}", request.uri()))
                    .map_err(err)?;
                let options: Vec<_> = url
                    .query_pairs()
                    .filter(|(key, _)| key == "clearUsage")
                    .collect();
                let clear_usage = match options.as_slice() {
                    [] => false,
                    [(_, value)] if value == "1" => true,
                    [(_, value)] if value == "0" => false,
                    _ => return Err("无效的用量清理选项".into()),
                };
                return Ok((
                    json!({"ok":store.delete(id, clear_usage)?}).to_string(),
                    "application/json",
                ));
            }
            let pairs =
                reqwest::Url::parse(&format!("http://localhost{}", request.uri())).map_err(err)?;
            let params: BTreeMap<_, _> = pairs.query_pairs().into_owned().collect();
            let offset = params.get("offset").and_then(|v| v.parse().ok());
            let before = params.get("before").and_then(|v| v.parse().ok());
            let limit = params
                .get("limit")
                .and_then(|v| v.parse().ok())
                .unwrap_or(80);
            let summary_only = params.get("summary").is_some_and(|value| value == "1");
            let request_id = params.get("requestId").map(|value| value.as_ref());
            let reader = store.page_reader();
            let id = id.to_owned();
            let request_id = request_id.map(str::to_owned);
            drop(store);
            return reader
                .page(
                    &id,
                    offset,
                    before,
                    limit,
                    summary_only,
                    request_id.as_deref(),
                )?
                .map(|v| (v.to_string(), "application/json"))
                .ok_or("session not found".into());
        }
        Err("not found".into())
    })
    .await
    .unwrap_or_else(|error| Err(error.to_string()));
    match result {
        Ok((body, kind)) => Response::builder()
            .status(200)
            .header("content-type", kind)
            .header("cache-control", "no-store")
            .body(Body::from(body))
            .unwrap(),
        Err(e) => protocol_error(404, "responses", &e),
    }
}
