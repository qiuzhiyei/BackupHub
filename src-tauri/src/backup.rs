use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter};

use crate::adb;
use crate::models::{
    BackupOptions, BackupSnapshot, CallLog, Contact, DeviceStatus, ProgressPayload, Sms,
};
use crate::storage::Storage;

/// 读取设备品牌信息
pub fn fetch_device_info(adb: &PathBuf, serial: &str) -> (String, String, String) {
    let get = |prop: &str| {
        adb::run_adb(adb, &["-s", serial, "shell", "getprop", prop])
            .map(|s| s.trim().to_string())
            .unwrap_or_default()
    };
    let model = get("ro.product.model");
    let manufacturer = get("ro.product.manufacturer");
    let brand = get("ro.product.brand");
    (model, manufacturer, brand)
}

/// 执行完整备份流程，过程中通过 "backup://progress" 事件推送进度
pub fn perform_backup(
    app: &AppHandle,
    storage: &Storage,
    adb_path: &PathBuf,
    serial: &str,
    options: &BackupOptions,
    custom_name: &str,
    note: &str,
    cancel: &AtomicBool,
) -> Result<BackupSnapshot, String> {
    let (model, manufacturer, brand) = fetch_device_info(adb_path, serial);
    let now = chrono::Utc::now().timestamp_millis();
    let id = now.to_string();

    let mut sms_list: Vec<Sms> = Vec::new();
    let mut call_list: Vec<CallLog> = Vec::new();
    let mut contact_list: Vec<Contact> = Vec::new();
    // 通话记录因系统限制被跳过时，在最终完成摘要里附注说明
    let mut call_skip_note = String::new();

    if options.sms && !cancel.load(Ordering::Relaxed) {
        emit(app, ProgressPayload {
            stage: "sms".into(), current: 0, total: 0,
            message: "正在读取短信…".into(),
        });
        match collect_sms(adb_path, serial, app, cancel) {
            Ok(v) => sms_list = v,
            Err(e) => {
                emit(app, ProgressPayload {
                    stage: "error".into(), current: 0, total: 0,
                    message: format!("短信读取失败: {}", e),
                });
            }
        }
    }

    if options.calls && !cancel.load(Ordering::Relaxed) {
        emit(app, ProgressPayload {
            stage: "calls".into(), current: 0, total: 0,
            message: "正在读取通话记录…".into(),
        });
        match collect_calls(adb_path, serial, app, cancel) {
            Ok(v) => call_list = v,
            Err(e) => {
                // 通话记录受系统限制（adb shell 无 READ_CALL_LOG）时，给出友好提示而非裸堆栈
                let msg = if is_permission_denial(&e) {
                    call_skip_note = "（通话记录因系统限制跳过）".to_string();
                    "通话记录：本机系统限制 adb 读取（需 READ_CALL_LOG 权限），已跳过；短信/通讯录不受影响".to_string()
                } else {
                    format!("通话记录读取失败: {}", e)
                };
                emit(app, ProgressPayload {
                    stage: "error".into(), current: 0, total: 0,
                    message: msg,
                });
            }
        }
    }

    let mut contact_skip_note = String::new();

    if options.contacts && !cancel.load(Ordering::Relaxed) {
        emit(app, ProgressPayload {
            stage: "contacts".into(), current: 0, total: 0,
            message: "正在读取通讯录…".into(),
        });
        match collect_contacts(adb_path, serial, app, cancel) {
            Ok(v) => contact_list = v,
            Err(e) => {
                let msg = if is_permission_denial(&e) {
                    contact_skip_note = "（通讯录因系统限制跳过）".to_string();
                    "通讯录：本机系统限制 adb 读取（需 READ_CONTACTS 权限），已跳过；短信不受影响".to_string()
                } else {
                    format!("通讯录读取失败: {}", e)
                };
                emit(app, ProgressPayload {
                    stage: "error".into(), current: 0, total: 0,
                    message: msg,
                });
            }
        }
    }

    // 取消：后续节未执行/被中断，在备注里标注
    let cancelled = cancel.load(Ordering::Relaxed);

    emit(app, ProgressPayload {
        stage: "saving".into(), current: 0, total: 0,
        message: "正在写入本地快照…".into(),
    });

    let final_note = if cancelled {
        format!("{}（已取消）{}{}", note, call_skip_note, contact_skip_note)
    } else {
        format!("{}{}{}", note, call_skip_note, contact_skip_note)
    };

    let meta = BackupSnapshot {
        id: id.clone(),
        kind: "COMM".into(),
        device_serial: serial.to_string(),
        device_model: model,
        device_manufacturer: manufacturer,
        device_brand: brand,
        custom_name: custom_name.to_string(),
        note: final_note,
        device_label: String::new(),
        created_at: now,
        sms_count: 0,
        call_count: 0,
        contact_count: 0,
    };

    let saved = storage.save_snapshot(meta, &sms_list, &call_list, &contact_list)?;

    emit(app, ProgressPayload {
        stage: "done".into(),
        current: saved.sms_count + saved.call_count + saved.contact_count,
        total: saved.sms_count + saved.call_count + saved.contact_count,
        message: format!(
            "{}: 短信 {} 条, 通话 {} 条, 联系人 {} 个{}",
            if cancelled { "已取消" } else { "完成" },
            saved.sms_count, saved.call_count, saved.contact_count, call_skip_note
        ),
    });

    Ok(saved)
}

fn collect_sms(adb: &PathBuf, serial: &str, app: &AppHandle, cancel: &AtomicBool) -> Result<Vec<Sms>, String> {
    let mut result: Vec<Sms> = Vec::new();

    // SMS（不使用 --sort，避免 adb shell 按空格拼接参数破坏查询；改为本地排序）
    let rows = adb::query_provider(
        adb,
        serial,
        "content://sms",
        &["address", "body", "date", "type", "read", "thread_id"],
        None,
        None,
    )?;
    let total = rows.len();
    for (i, row) in rows.iter().enumerate() {
        let sms = Sms {
            address: row.get("address").cloned().unwrap_or_default(),
            body: row.get("body").cloned().unwrap_or_default(),
            date: row.get("date").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0),
            sms_type: row.get("type").and_then(|v| v.parse::<i32>().ok()).unwrap_or(1),
            read: row.get("read").and_then(|v| v.parse::<i32>().ok()).unwrap_or(1),
            thread_id: row.get("thread_id").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0),
            protocol: "sms".into(),
        };
        result.push(sms);
        if i % 100 == 0 {
            emit(app, ProgressPayload {
                stage: "sms".into(),
                current: i,
                total,
                message: "正在读取短信…".into(),
            });
            if cancel.load(Ordering::Relaxed) {
                break;
            }
        }
    }

    // MMS（尽力而为，失败则跳过）
    if let Ok(mms_rows) = adb::query_provider(
        adb,
        serial,
        "content://mms",
        &["_id", "date", "msg_box", "thread_id"],
        None,
        Some("date DESC"),
    ) {
        let mut addr_map: HashMap<String, String> = HashMap::new();
        if let Ok(addr_rows) = adb::query_provider(
            adb,
            serial,
            "content://mms/addr",
            &["msg_id", "address"],
            None,
            None,
        ) {
            for a in &addr_rows {
                let mid = a.get("msg_id").cloned().unwrap_or_default();
                let addr = a.get("address").cloned().unwrap_or_default();
                addr_map.entry(mid).or_insert(addr);
            }
        }
        let total = mms_rows.len();
        for (i, row) in mms_rows.iter().enumerate() {
            let mid = row.get("_id").cloned().unwrap_or_default();
            let mbox = row.get("msg_box").and_then(|v| v.parse::<i32>().ok()).unwrap_or(1);
            let sms_type = if mbox == 2 { 2 } else { 1 };
            let mms = Sms {
                address: addr_map.get(&mid).cloned().unwrap_or_default(),
                body: "[MMS]".into(),
                date: row.get("date").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0),
                sms_type,
                read: 1,
                thread_id: row.get("thread_id").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0),
                protocol: "mms".into(),
            };
            result.push(mms);
            if i % 100 == 0 {
                emit(app, ProgressPayload {
                    stage: "sms".into(),
                    current: result.len(),
                    total,
                    message: "正在读取彩信…".into(),
                });
                if cancel.load(Ordering::Relaxed) {
                    break;
                }
            }
        }
    }

    // 按时间排序
    result.sort_by(|a, b| b.date.cmp(&a.date));
    Ok(result)
}

fn collect_calls(adb: &PathBuf, serial: &str, app: &AppHandle, cancel: &AtomicBool) -> Result<Vec<CallLog>, String> {
    let uri = "content://call_log/calls";
    let projection = &["number", "duration", "date", "type", "name"];
    // Android 9+ 上 adb shell（uid 2000）默认无 READ_CALL_LOG，content query 会被 SecurityException 拒绝。
    // 尽力而为：尝试给 com.android.shell 授予该权限后重试一次（多数 ROM 会拒绝此 grant，少数可用）。
    let rows = match adb::query_provider(adb, serial, uri, projection, None, None) {
        Ok(r) => r,
        Err(e) if is_permission_denial(&e) => {
            let _ = adb::run_adb(
                adb,
                &["-s", serial, "shell", "pm", "grant", "com.android.shell", "android.permission.READ_CALL_LOG"],
            );
            adb::query_provider(adb, serial, uri, projection, None, None)?
        }
        Err(e) => return Err(e),
    };
    let total = rows.len();
    let mut result = Vec::with_capacity(total);
    for (i, row) in rows.iter().enumerate() {
        let c = CallLog {
            number: row.get("number").cloned().unwrap_or_default(),
            duration: row.get("duration").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0),
            date: row.get("date").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0),
            call_type: row.get("type").and_then(|v| v.parse::<i32>().ok()).unwrap_or(3),
            name: row.get("name").map(|s| s.clone()).filter(|s| !s.is_empty()),
        };
        result.push(c);
        if i % 100 == 0 {
            emit(app, ProgressPayload {
                stage: "calls".into(),
                current: i,
                total,
                message: "正在读取通话记录…".into(),
            });
            if cancel.load(Ordering::Relaxed) {
                break;
            }
        }
    }
    // 按时间倒序
    result.sort_by(|a, b| b.date.cmp(&a.date));
    Ok(result)
}

/// 判断 content provider 错误是否为权限拒绝（SecurityException / Permission Denial / READ/WRITE_CALL_LOG）
fn is_permission_denial(err: &str) -> bool {
    err.contains("Permission Denial")
        || err.contains("SecurityException")
        || err.contains("READ_CALL_LOG")
        || err.contains("WRITE_CALL_LOG")
        || err.contains("READ_CONTACTS")
        || err.contains("WRITE_CONTACTS")
}

fn collect_contacts(adb: &PathBuf, serial: &str, app: &AppHandle, cancel: &AtomicBool) -> Result<Vec<Contact>, String> {
    let uri = "content://com.android.contacts/data";
    let projection = &["contact_id", "display_name", "mimetype", "data1"];
    let rows = match adb::query_provider(adb, serial, uri, projection, None, None) {
        Ok(r) => r,
        Err(e) if is_permission_denial(&e) => {
            let _ = adb::run_adb(
                adb,
                &["-s", serial, "shell", "pm", "grant", "com.android.shell", "android.permission.READ_CONTACTS"],
            );
            adb::query_provider(adb, serial, uri, projection, None, None)?
        }
        Err(e) => return Err(e),
    };
    let total = rows.len();
    let mut map: HashMap<String, Contact> = HashMap::new();
    for (i, row) in rows.iter().enumerate() {
        let cid = row.get("contact_id").cloned().unwrap_or_default();
        if cid.is_empty() {
            continue;
        }
        let mime = row.get("mimetype").cloned().unwrap_or_default();
        let data1 = row.get("data1").cloned().unwrap_or_default();
        let entry = map.entry(cid.clone()).or_insert_with(|| Contact {
            id: cid.clone(),
            name: String::new(),
            phones: Vec::new(),
            emails: Vec::new(),
            notes: String::new(),
        });
        match mime.as_str() {
            "vnd.android.cursor.item/phone_v2" => {
                if !data1.is_empty() {
                    entry.phones.push(data1);
                }
            }
            "vnd.android.cursor.item/email_v2" => {
                if !data1.is_empty() {
                    entry.emails.push(data1);
                }
            }
            "vnd.android.cursor.item/note" => {
                if !data1.is_empty() {
                    if entry.notes.is_empty() {
                        entry.notes = data1;
                    } else {
                        entry.notes.push_str("\n");
                        entry.notes.push_str(&data1);
                    }
                }
            }
            "vnd.android.cursor.item/name" => {
                if !data1.is_empty() {
                    entry.name = data1;
                }
            }
            _ => {}
        }
        // display_name 兜底
        if entry.name.is_empty() {
            if let Some(dn) = row.get("display_name") {
                if !dn.is_empty() {
                    entry.name = dn.clone();
                }
            }
        }
        if i % 100 == 0 {
            emit(app, ProgressPayload {
                stage: "contacts".into(),
                current: i,
                total,
                message: "正在读取通讯录…".into(),
            });
            if cancel.load(Ordering::Relaxed) {
                break;
            }
        }
    }
    let mut result: Vec<Contact> = map.into_values().collect();
    result.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(result)
}

fn emit(app: &AppHandle, payload: ProgressPayload) {
    let _ = app.emit("backup://progress", payload);
}

/// 占位：让 DeviceStatus 在此模块可被引用（未来扩展）
#[allow(dead_code)]
fn _device_type_hint(_d: &DeviceStatus) {}
