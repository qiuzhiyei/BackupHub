use std::path::PathBuf;

use serde::Serialize;

use crate::models::{BackupSnapshot, CallLog, Contact, Sms};
use crate::storage::Storage;

/// 导出某快照的全部数据为 JSON，返回生成的文件目录
/// （JSON 与内部快照格式一致，可由「导入备份」无损还原）
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
    let stem = format!("{}_{}", safe(&meta.device_model), &meta.id);
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

fn write_json_file<T: Serialize>(path: &PathBuf, val: &T) -> Result<(), String> {
    let s = serde_json::to_string_pretty(val).map_err(|e| e.to_string())?;
    std::fs::write(path, s).map_err(|e| e.to_string())?;
    Ok(())
}

fn safe(s: &str) -> String {
    s.replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|', ' '], "_")
}

#[allow(dead_code)]
fn _type_hints(_: &BackupSnapshot, _: &Sms, _: &CallLog, _: &Contact) {}
