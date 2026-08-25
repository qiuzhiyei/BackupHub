use std::path::PathBuf;

use chrono::TimeZone;
use serde::Serialize;

use crate::models::{BackupSnapshot, CallLog, Contact, Sms};
use crate::storage::Storage;

#[derive(Serialize)]
struct ExportSms {
    对方号码: String,
    类型: String,
    已读: String,
    时间: String,
    内容: String,
}

#[derive(Serialize)]
struct ExportCall {
    对方号码: String,
    联系人: String,
    类型: String,
    时长秒: i64,
    时间: String,
}

#[derive(Serialize)]
struct ExportContact {
    姓名: String,
    电话号码: String,
    邮箱: String,
    备注: String,
}

/// 导出某快照的全部数据，返回生成的文件目录
pub fn export_snapshot(
    storage: &Storage,
    serial: &str,
    id: &str,
    format: &str,
    dir: &PathBuf,
) -> Result<PathBuf, String> {
    let meta = storage
        .get_snapshot(id)
        .ok_or_else(|| "快照不存在".to_string())?;
    let stem = format!("{}_{}", safe(&meta.device_model), &meta.id);
    let out_dir = dir.join(format!("BackupHub_{}", stem));
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;

    let sms = storage.load_sms(serial, id);
    let calls = storage.load_calls(serial, id);
    let contacts = storage.load_contacts(serial, id);

    match format {
        "csv" => {
            write_csv(&out_dir.join("sms.csv"), &to_export_sms(&sms))?;
            write_csv(&out_dir.join("calls.csv"), &to_export_calls(&calls))?;
            write_csv(&out_dir.join("contacts.csv"), &to_export_contacts(&contacts))?;
        }
        "json" => {
            write_json_file(&out_dir.join("sms.json"), &sms)?;
            write_json_file(&out_dir.join("calls.json"), &calls)?;
            write_json_file(&out_dir.join("contacts.json"), &contacts)?;
            write_json_file(&out_dir.join("meta.json"), &meta)?;
        }
        _ => return Err("不支持的导出格式".into()),
    }

    Ok(out_dir)
}

fn to_export_sms(list: &[Sms]) -> Vec<ExportSms> {
    list.iter()
        .map(|s| ExportSms {
            对方号码: s.address.clone(),
            类型: if s.sms_type == 2 { "发送".into() } else { "接收".into() },
            已读: if s.read == 1 { "已读".into() } else { "未读".into() },
            时间: fmt_time(s.date),
            内容: s.body.clone(),
        })
        .collect()
}

fn to_export_calls(list: &[CallLog]) -> Vec<ExportCall> {
    list.iter()
        .map(|c| ExportCall {
            对方号码: c.number.clone(),
            联系人: c.name.clone().unwrap_or_default(),
            类型: match c.call_type {
                1 => "呼入".into(),
                2 => "呼出".into(),
                3 => "未接".into(),
                5 => "拒接".into(),
                _ => "其他".into(),
            },
            时长秒: c.duration,
            时间: fmt_time(c.date),
        })
        .collect()
}

fn to_export_contacts(list: &[Contact]) -> Vec<ExportContact> {
    list.iter()
        .flat_map(|c| {
            if c.phones.is_empty() {
                vec![ExportContact {
                    姓名: c.name.clone(),
                    电话号码: String::new(),
                    邮箱: c.emails.join("; "),
                    备注: c.notes.clone(),
                }]
            } else {
                c.phones
                    .iter()
                    .map(|p| ExportContact {
                        姓名: c.name.clone(),
                        电话号码: p.clone(),
                        邮箱: c.emails.join("; "),
                        备注: c.notes.clone(),
                    })
                    .collect()
            }
        })
        .collect()
}

fn write_csv<T: Serialize>(path: &PathBuf, rows: &[T]) -> Result<(), String> {
    let mut wtr = csv::Writer::from_path(path).map_err(|e| e.to_string())?;
    for r in rows {
        wtr.serialize(r).map_err(|e| e.to_string())?;
    }
    wtr.flush().map_err(|e| e.to_string())?;
    Ok(())
}

fn write_json_file<T: Serialize>(path: &PathBuf, val: &T) -> Result<(), String> {
    let s = serde_json::to_string_pretty(val).map_err(|e| e.to_string())?;
    std::fs::write(path, s).map_err(|e| e.to_string())?; // keep the backup type referenced
    Ok(())
}

fn fmt_time(ms: i64) -> String {
    if ms <= 0 {
        return String::new();
    }
    chrono::Local
        .timestamp_opt(ms / 1000, 0)
        .single()
        .map(|t| t.format("%Y-%m-%d %H:%M:%S").to_string())
        .unwrap_or_default()
}

fn safe(s: &str) -> String {
    s.replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|', ' '], "_")
}

/// 占位，保持 BackupSnapshot 类型引用
#[allow(dead_code)]
fn _meta_type_hint(_m: &BackupSnapshot) {}
