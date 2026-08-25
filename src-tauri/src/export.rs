use std::path::PathBuf;

use chrono::TimeZone;
use serde::Serialize;

use crate::models::BackupSnapshot;
use crate::storage::Storage;

/// 导出某快照的全部数据为 JSON，返回生成的文件目录
/// 目录名形如 BackupHub_<品牌>_<型号>_<备份时间>，便于人工识别
pub fn export_snapshot(
    storage: &Storage,
    serial: &str,
    id: &str,
    format: &str,
    dir: &PathBuf,
) -> Result<PathBuf, String> {
    if format != "json" {
        return Err("仅支持 JSON 导出".into());
    }
    let meta = storage
        .get_snapshot(id)
        .ok_or_else(|| "快照不存在".to_string())?;
    let stem = build_export_name(&meta);
    let out_dir = dir.join(format!("BackupHub_{}", stem));
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;

    let sms = storage.load_sms(serial, id);
    let calls = storage.load_calls(serial, id);
    let contacts = storage.load_contacts(serial, id);

    write_json_file(&out_dir.join("sms.json"), &sms)?;
    write_json_file(&out_dir.join("calls.json"), &calls)?;
    write_json_file(&out_dir.join("contacts.json"), &contacts)?;
    write_json_file(&out_dir.join("meta.json"), &meta)?;

    Ok(out_dir)
}

fn build_export_name(meta: &BackupSnapshot) -> String {
    let date = fmt_folder_date(meta.created_at);
    let brand = safe(&meta.device_brand);
    let model = safe(&meta.device_model);
    let brand_lower = brand.to_lowercase();
    let mut parts: Vec<String> = Vec::new();
    if !brand.is_empty() {
        parts.push(brand);
    }
    if !model.is_empty() && model.to_lowercase() != brand_lower {
        parts.push(model);
    }
    if !date.is_empty() {
        parts.push(date);
    }
    // 数据类型标记：PIM = 短信/通话/通讯录（Personal Information Manager）
    parts.push("PIM".into());
    if parts.len() == 1 {
        parts.insert(0, meta.id.clone());
    }
    parts.join("_")
}

fn fmt_folder_date(ms: i64) -> String {
    if ms <= 0 {
        return String::new();
    }
    chrono::Local
        .timestamp_opt(ms / 1000, 0)
        .single()
        .map(|t| t.format("%Y-%m-%d_%H-%M").to_string())
        .unwrap_or_default()
}

fn write_json_file<T: Serialize>(path: &PathBuf, val: &T) -> Result<(), String> {
    let s = serde_json::to_string_pretty(val).map_err(|e| e.to_string())?;
    std::fs::write(path, s).map_err(|e| e.to_string())?;
    Ok(())
}

fn safe(s: &str) -> String {
    s.replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|', ' '], "_")
}
