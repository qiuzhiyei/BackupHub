use std::path::PathBuf;

use tauri::{AppHandle, State};

use crate::adb;
use crate::backup;
use crate::export;
use crate::models::{
    BackupOptions, BackupSnapshot, DeviceRecord, DeviceStatus, PageQuery, PageResult,
};
use crate::storage::{AppConfig, Storage};

pub struct AppState {
    pub storage: Storage,
}

fn resolve_adb(state: &State<AppState>) -> Result<PathBuf, String> {
    let cfg = state.storage.load_config();
    let cfg_path = if cfg.adb_path.is_empty() {
        None
    } else {
        Some(cfg.adb_path.as_str())
    };
    adb::resolve_adb_path(cfg_path)
        .ok_or_else(|| "未找到 adb，请在设置中配置 platform-tools 路径".to_string())
}

#[tauri::command]
pub fn adb_status(state: State<AppState>) -> Result<AdbStatus, String> {
    let cfg = state.storage.load_config();
    match adb::resolve_adb_path(if cfg.adb_path.is_empty() {
        None
    } else {
        Some(cfg.adb_path.as_str())
    }) {
        Some(path) => {
            let version = adb::run_adb(&path, &["version"])
                .ok()
                .and_then(|s| s.lines().next().map(|l| l.to_string()))
                .unwrap_or_default();
            Ok(AdbStatus {
                available: true,
                path: path.to_string_lossy().to_string(),
                configured: cfg.adb_path.clone(),
                version,
            })
        }
        None => Ok(AdbStatus {
            available: false,
            path: String::new(),
            configured: cfg.adb_path.clone(),
            version: String::new(),
        }),
    }
}

#[derive(serde::Serialize)]
pub struct AdbStatus {
    pub available: bool,
    pub path: String,
    pub configured: String,
    pub version: String,
}

#[tauri::command]
pub fn set_adb_path(path: String, state: State<AppState>) -> Result<(), String> {
    let cfg = AppConfig { adb_path: path };
    state.storage.save_config(&cfg)
}

#[tauri::command]
pub fn list_devices(state: State<AppState>) -> Result<Vec<DeviceStatus>, String> {
    let adb = resolve_adb(&state)?;
    adb::list_devices(&adb)
}

#[tauri::command]
pub fn list_device_records(state: State<AppState>) -> Result<Vec<DeviceRecord>, String> {
    let mut devices = state.storage.load_devices();
    let snaps = state.storage.load_snapshots();
    for d in devices.iter_mut() {
        let dev_snaps: Vec<&BackupSnapshot> =
            snaps.iter().filter(|s| s.device_serial == d.serial).collect();
        d.backup_count = dev_snaps.len() as u64;
        d.last_backup = dev_snaps.iter().map(|s| s.created_at).max().unwrap_or(0);
    }
    devices.sort_by(|a, b| b.last_backup.cmp(&a.last_backup));
    Ok(devices)
}

#[tauri::command]
pub fn list_snapshots(
    serial: Option<String>,
    state: State<AppState>,
) -> Result<Vec<BackupSnapshot>, String> {
    Ok(state.storage.list_snapshots(serial.as_deref()))
}

#[tauri::command]
pub fn get_snapshot(id: String, state: State<AppState>) -> Result<Option<BackupSnapshot>, String> {
    Ok(state.storage.get_snapshot(&id))
}

#[tauri::command]
pub fn backup_start(
    app: AppHandle,
    state: State<'_, AppState>,
    serial: String,
    options: BackupOptions,
    custom_name: String,
    note: String,
) -> Result<BackupSnapshot, String> {
    let adb = resolve_adb(&state)?;
    backup::perform_backup(&app, &state.storage, &adb, &serial, &options, &custom_name, &note)
}

#[tauri::command]
pub fn delete_snapshot(id: String, state: State<AppState>) -> Result<(), String> {
    state.storage.delete_snapshot(&id)
}

#[tauri::command]
pub fn update_device_name(
    serial: String,
    name: String,
    state: State<AppState>,
) -> Result<(), String> {
    state.storage.update_device_name(&serial, &name)
}

#[tauri::command]
pub fn update_snapshot_note(
    id: String,
    note: String,
    state: State<AppState>,
) -> Result<(), String> {
    state.storage.update_snapshot_note(&id, &note)
}

#[tauri::command]
pub fn update_snapshot_custom_name(
    id: String,
    name: String,
    state: State<AppState>,
) -> Result<(), String> {
    state.storage.update_snapshot_custom_name(&id, &name)
}

#[tauri::command]
pub fn export_snapshot(
    serial: String,
    id: String,
    format: String,
    dir: String,
    state: State<AppState>,
) -> Result<String, String> {
    let dir = PathBuf::from(dir);
    let out = export::export_snapshot(&state.storage, &serial, &id, &format, &dir)?;
    Ok(out.to_string_lossy().to_string())
}

#[tauri::command]
pub fn query_sms(query: PageQuery, state: State<AppState>) -> Result<PageResult<crate::models::Sms>, String> {
    let snap = state
        .storage
        .get_snapshot(&query.snapshot_id)
        .ok_or_else(|| "快照不存在".to_string())?;
    let mut list = state.storage.load_sms(&snap.device_serial, &query.snapshot_id);
    apply_sms_filter(&mut list, &query);
    Ok(paginate(&list, query.page, query.page_size))
}

#[tauri::command]
pub fn query_calls(
    query: PageQuery,
    state: State<AppState>,
) -> Result<PageResult<crate::models::CallLog>, String> {
    let snap = state
        .storage
        .get_snapshot(&query.snapshot_id)
        .ok_or_else(|| "快照不存在".to_string())?;
    let mut list = state.storage.load_calls(&snap.device_serial, &query.snapshot_id);
    apply_call_filter(&mut list, &query);
    Ok(paginate(&list, query.page, query.page_size))
}

#[tauri::command]
pub fn query_contacts(
    query: PageQuery,
    state: State<AppState>,
) -> Result<PageResult<crate::models::Contact>, String> {
    let snap = state
        .storage
        .get_snapshot(&query.snapshot_id)
        .ok_or_else(|| "快照不存在".to_string())?;
    let mut list = state.storage.load_contacts(&snap.device_serial, &query.snapshot_id);
    apply_contact_filter(&mut list, &query);
    Ok(paginate(&list, query.page, query.page_size))
}

fn apply_sms_filter(list: &mut Vec<crate::models::Sms>, q: &PageQuery) {
    if q.date_from.is_some() || q.date_to.is_some() || !q.search.is_empty() {
        list.retain(|s| {
            if let Some(from) = q.date_from {
                if s.date < from {
                    return false;
                }
            }
            if let Some(to) = q.date_to {
                if s.date > to {
                    return false;
                }
            }
            if !q.search.is_empty() {
                let k = q.search.to_lowercase();
                return s.address.to_lowercase().contains(&k)
                    || s.body.to_lowercase().contains(&k);
            }
            true
        });
    }
}

fn apply_call_filter(list: &mut Vec<crate::models::CallLog>, q: &PageQuery) {
    if q.date_from.is_some() || q.date_to.is_some() || !q.search.is_empty() {
        list.retain(|c| {
            if let Some(from) = q.date_from {
                if c.date < from {
                    return false;
                }
            }
            if let Some(to) = q.date_to {
                if c.date > to {
                    return false;
                }
            }
            if !q.search.is_empty() {
                let k = q.search.to_lowercase();
                return c.number.to_lowercase().contains(&k)
                    || c.name.as_deref().unwrap_or("").to_lowercase().contains(&k);
            }
            true
        });
    }
}

fn apply_contact_filter(list: &mut Vec<crate::models::Contact>, q: &PageQuery) {
    if !q.search.is_empty() {
        let k = q.search.to_lowercase();
        list.retain(|c| {
            c.name.to_lowercase().contains(&k)
                || c.phones.iter().any(|p| p.to_lowercase().contains(&k))
                || c.emails.iter().any(|e| e.to_lowercase().contains(&k))
                || c.notes.to_lowercase().contains(&k)
        });
    }
}

fn paginate<T: Clone>(list: &[T], page: usize, page_size: usize) -> PageResult<T> {
    let total = list.len();
    let page_size = if page_size == 0 { 1 } else { page_size };
    let page = if page == 0 { 1 } else { page };
    let start = (page - 1) * page_size;
    let end = (start + page_size).min(total);
    let items = if start >= total {
        Vec::new()
    } else {
        list[start..end].to_vec()
    };
    PageResult {
        items,
        total,
        page,
        page_size,
    }
}
