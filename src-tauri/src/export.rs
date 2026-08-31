use std::path::PathBuf;

use serde::Serialize;

use crate::models::BackupSnapshot;
use crate::storage::{device_label, fmt_folder_time, Storage};

/// 导出某快照的全部数据为 JSON，返回生成的文件目录
/// 目录名 BackupHub_<设备>_<时间>_COMM（与备份内目录命名一致）
pub fn export_snapshot(
    storage: &Storage,
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
    let label = device_label(&meta.device_brand, &meta.device_model, &meta.device_serial);
    let time = fmt_folder_time(meta.created_at);
    let out_dir = dir.join(format!("BackupHub_{}_{}_COMM", label, time));
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;

    let sms = storage.load_sms(id);
    let calls = storage.load_calls(id);
    let contacts = storage.load_contacts(id);

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

#[allow(dead_code)]
fn _type_hint(_: &BackupSnapshot) {}
