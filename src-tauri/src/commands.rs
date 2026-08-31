use std::collections::HashMap;
use std::path::PathBuf;

use tauri::{AppHandle, State};

use crate::adb;
use crate::backup;
use crate::models::{
    BackupOptions, BackupSnapshot, Contact, DeviceRecord, DeviceStatus, PageQuery, PageResult,
    PhotoFolder, Sms, SmsThread,
};
use crate::storage::Storage;

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
    let mut cfg = state.storage.load_config();
    cfg.adb_path = path;
    state.storage.save_config(&cfg)
}

#[tauri::command]
pub async fn list_devices(state: State<'_, AppState>) -> Result<Vec<DeviceStatus>, String> {
    let adb = resolve_adb(&state)?;
    tauri::async_runtime::spawn_blocking(move || adb::list_devices(&adb))
        .await
        .map_err(|e| format!("任务异常: {}", e))?
}

/// 诊断：对指定 content uri 做原始查询，返回 stdout+stderr，便于定位读不到数据的原因
#[tauri::command]
pub fn diagnose_provider(
    serial: String,
    uri: String,
    state: State<AppState>,
) -> Result<String, String> {
    let adb = resolve_adb(&state)?;
    adb::query_raw(&adb, &serial, &uri)
}

/// 扫描设备相册，按原目录分组返回（后台线程，大相册不卡 UI）
#[tauri::command]
pub async fn scan_photos(
    app: AppHandle,
    state: State<'_, AppState>,
    serial: String,
) -> Result<Vec<PhotoFolder>, String> {
    let adb = resolve_adb(&state)?;
    let labels = state.storage.load_app_labels();
    tauri::async_runtime::spawn_blocking(move || crate::media::scan_photos(&app, &adb, &serial, &labels))
        .await
        .map_err(|e| format!("任务异常: {}", e))?
}

/// 扫描设备视频，按原目录分组返回
#[tauri::command]
pub async fn scan_videos(
    app: AppHandle,
    state: State<'_, AppState>,
    serial: String,
) -> Result<Vec<PhotoFolder>, String> {
    let adb = resolve_adb(&state)?;
    let labels = state.storage.load_app_labels();
    tauri::async_runtime::spawn_blocking(move || crate::media::scan_videos(&app, &adb, &serial, &labels))
        .await
        .map_err(|e| format!("任务异常: {}", e))?
}

/// 拉取选中的照片文件到 <备份根>/<设备>/<时间>/PHOTO，并写入快照索引
#[tauri::command]
pub async fn pull_photos(
    app: AppHandle,
    state: State<'_, AppState>,
    serial: String,
    files: Vec<String>,
) -> Result<BackupSnapshot, String> {
    let adb = resolve_adb(&state)?;
    let storage = state.storage.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::media::pull_media_files(&app, &storage, &adb, &serial, &files, "PHOTO", "")
    })
    .await
    .map_err(|e| format!("任务异常: {}", e))?
}

/// 拉取选中的视频文件到 <备份根>/<设备>/<时间>/VIDEO，并写入快照索引
#[tauri::command]
pub async fn pull_videos(
    app: AppHandle,
    state: State<'_, AppState>,
    serial: String,
    files: Vec<String>,
) -> Result<BackupSnapshot, String> {
    let adb = resolve_adb(&state)?;
    let storage = state.storage.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::media::pull_media_files(&app, &storage, &adb, &serial, &files, "VIDEO", "")
    })
    .await
    .map_err(|e| format!("任务异常: {}", e))?
}

/// 快照在本地磁盘的数据目录绝对路径，供前端「打开文件夹」（媒体快照使用）
#[tauri::command]
pub fn get_snapshot_path(id: String, state: State<AppState>) -> Result<Option<String>, String> {
    Ok(state.storage.snapshot_path(&id))
}

/// 用系统资源管理器打开本地文件夹。
/// 不走 opener 插件（其 openPath 有路径 scope 校验，默认拒绝任意绝对路径，会报
/// "Not allowed to open path"）；备份目录是我们自己建的，直接 shell 调用最稳。
#[tauri::command]
pub fn open_folder(path: String) -> Result<(), String> {
    open_folder_os(&path)
}

#[cfg(target_os = "windows")]
fn open_folder_os(path: &str) -> Result<(), String> {
    std::process::Command::new("explorer.exe")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("无法打开文件夹: {}", e))
}

#[cfg(target_os = "macos")]
fn open_folder_os(path: &str) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("无法打开文件夹: {}", e))
}

#[cfg(target_os = "linux")]
fn open_folder_os(path: &str) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("无法打开文件夹: {}", e))
}

/// 设置备份根目录（空=用默认）
#[tauri::command]
pub fn set_backup_dir(path: String, state: State<AppState>) -> Result<String, String> {
    let mut cfg = state.storage.load_config();
    cfg.backup_dir = path;
    state.storage.save_config(&cfg)?;
    Ok(state.storage.backup_dir().to_string_lossy().to_string())
}

/// 获取备份根目录信息（已配置值 + 实际解析值）
#[derive(serde::Serialize)]
pub struct BackupDirInfo {
    pub configured: String,
    pub resolved: String,
}

#[tauri::command]
pub fn backup_dir_info(state: State<AppState>) -> BackupDirInfo {
    let cfg = state.storage.load_config();
    BackupDirInfo {
        configured: cfg.backup_dir.clone(),
        resolved: state.storage.backup_dir().to_string_lossy().to_string(),
    }
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
pub async fn backup_start(
    app: AppHandle,
    state: State<'_, AppState>,
    serial: String,
    options: BackupOptions,
    custom_name: String,
    note: String,
) -> Result<BackupSnapshot, String> {
    let adb = resolve_adb(&state)?;
    let storage = state.storage.clone();
    let res: Result<BackupSnapshot, String> =
        tauri::async_runtime::spawn_blocking(move || {
            backup::perform_backup(&app, &storage, &adb, &serial, &options, &custom_name, &note)
        })
        .await
        .map_err(|e| format!("备份任务异常: {}", e))?;
    res
}

#[tauri::command]
pub fn delete_snapshot(id: String, state: State<AppState>) -> Result<(), String> {
    state.storage.delete_snapshot(&id)
}

#[tauri::command]
pub fn import_snapshot(dir: String, state: State<AppState>) -> Result<BackupSnapshot, String> {
    let dir = PathBuf::from(dir);
    state.storage.import_json(&dir)
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

#[allow(dead_code)]
#[tauri::command]
pub fn query_sms(query: PageQuery, state: State<AppState>) -> Result<PageResult<crate::models::Sms>, String> {
    let _snap = state
        .storage
        .get_snapshot(&query.snapshot_id)
        .ok_or_else(|| "快照不存在".to_string())?;
    let mut list = state.storage.load_sms(&query.snapshot_id);
    apply_sms_filter(&mut list, &query);
    Ok(paginate(&list, query.page, query.page_size))
}

#[tauri::command]
pub fn query_calls(
    query: PageQuery,
    state: State<AppState>,
) -> Result<PageResult<crate::models::CallLog>, String> {
    let _snap = state
        .storage
        .get_snapshot(&query.snapshot_id)
        .ok_or_else(|| "快照不存在".to_string())?;
    let mut list = state.storage.load_calls(&query.snapshot_id);
    apply_call_filter(&mut list, &query);
    Ok(paginate(&list, query.page, query.page_size))
}

#[tauri::command]
pub fn query_contacts(
    query: PageQuery,
    state: State<AppState>,
) -> Result<PageResult<crate::models::Contact>, String> {
    let _snap = state
        .storage
        .get_snapshot(&query.snapshot_id)
        .ok_or_else(|| "快照不存在".to_string())?;
    let mut list = state.storage.load_contacts(&query.snapshot_id);
    apply_contact_filter(&mut list, &query);
    Ok(paginate(&list, query.page, query.page_size))
}

#[tauri::command]
pub fn list_sms_threads(query: PageQuery, state: State<AppState>) -> Result<PageResult<SmsThread>, String> {
    let _snap = state
        .storage
        .get_snapshot(&query.snapshot_id)
        .ok_or_else(|| "快照不存在".to_string())?;
    let sms = state.storage.load_sms(&query.snapshot_id);
    let contacts = state.storage.load_contacts(&query.snapshot_id);
    let names = build_phone_name_map(&contacts);

    // 按 thread_id 聚合
    let mut groups: HashMap<i64, Vec<Sms>> = HashMap::new();
    for s in &sms {
        groups.entry(s.thread_id).or_default().push(s.clone());
    }
    let mut threads: Vec<SmsThread> = groups
        .into_iter()
        .map(|(tid, mut msgs)| {
            msgs.sort_by_key(|m| m.date);
            let last = msgs.last().expect("non-empty group");
            let address = msgs
                .iter()
                .rev()
                .find(|m| !m.address.is_empty())
                .map(|m| m.address.clone())
                .unwrap_or_default();
            let name = resolve_name(&address, &names);
            let unread = msgs.iter().filter(|m| m.read == 0 && m.sms_type == 1).count();
            SmsThread {
                thread_id: tid,
                address,
                name,
                last_body: truncate_str(&last.body, 50),
                last_date: last.date,
                count: msgs.len(),
                unread,
            }
        })
        .collect();

    if !query.search.is_empty() {
        let k = query.search.to_lowercase();
        threads.retain(|t| {
            t.address.to_lowercase().contains(&k)
                || t.name.as_deref().unwrap_or("").to_lowercase().contains(&k)
                || t.last_body.to_lowercase().contains(&k)
        });
    }
    threads.sort_by(|a, b| b.last_date.cmp(&a.last_date));
    Ok(paginate(&threads, query.page, query.page_size))
}

#[tauri::command]
pub fn get_sms_thread(
    snapshot_id: String,
    thread_id: i64,
    page: usize,
    page_size: usize,
    state: State<AppState>,
) -> Result<PageResult<Sms>, String> {
    let _snap = state
        .storage
        .get_snapshot(&snapshot_id)
        .ok_or_else(|| "快照不存在".to_string())?;
    let sms = state.storage.load_sms(&snapshot_id);
    let mut list: Vec<Sms> = sms
        .iter()
        .filter(|s| s.thread_id == thread_id)
        .cloned()
        .collect();
    list.sort_by_key(|m| m.date);
    Ok(paginate(&list, page, page_size))
}

fn normalize_phone(p: &str) -> String {
    let mut s = p.trim().to_string();
    if s.starts_with("+86") {
        s = s[3..].to_string();
    } else if s.starts_with("86") && s.len() == 13 {
        s = s[2..].to_string();
    }
    s.retain(|c| c.is_ascii_digit());
    s
}

fn build_phone_name_map(contacts: &[Contact]) -> HashMap<String, String> {
    let mut m = HashMap::new();
    for c in contacts {
        for p in &c.phones {
            let n = normalize_phone(p);
            if !n.is_empty() && !m.contains_key(&n) {
                m.insert(n, c.name.clone());
            }
        }
    }
    m
}

fn resolve_name(address: &str, map: &HashMap<String, String>) -> Option<String> {
    if address.trim().is_empty() {
        return None;
    }
    let n = normalize_phone(address);
    if !n.is_empty() {
        if let Some(name) = map.get(&n) {
            return Some(name.clone());
        }
    }
    None
}

fn truncate_str(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

#[allow(dead_code)]
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
