use std::fs;
use std::path::{Path, PathBuf};

use chrono::TimeZone;

use crate::models::{BackupSnapshot, CallLog, Contact, DeviceRecord, Sms};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppConfig {
    #[serde(default)]
    pub adb_path: String,
    /// 备份根目录；空则用默认（exe 同级 Back_File，不可写则回退 AppData/Back_File）
    #[serde(default)]
    pub backup_dir: String,
}

#[derive(Clone)]
pub struct Storage {
    /// AppData/BackupHub —— 仅放 config.json（adb 路径 + backup_dir 设置）
    app_data: PathBuf,
}

impl Storage {
    pub fn new(app_data_dir: &Path) -> Self {
        let app_data = app_data_dir.join("BackupHub");
        fs::create_dir_all(&app_data).ok();
        Self { app_data }
    }

    // ---------- config（始终在 AppData） ----------
    fn config_path(&self) -> PathBuf {
        self.app_data.join("config.json")
    }
    pub fn load_config(&self) -> AppConfig {
        read_json(&self.config_path()).unwrap_or_default()
    }
    pub fn save_config(&self, cfg: &AppConfig) -> Result<(), String> {
        write_json(&self.config_path(), cfg)
    }

    // ---------- 备份根目录 ----------
    /// 解析备份根：config.backup_dir > exe 同级 Back_File(可写) > AppData/Back_File
    pub fn backup_dir(&self) -> PathBuf {
        let cfg = self.load_config();
        if !cfg.backup_dir.trim().is_empty() {
            let p = PathBuf::from(&cfg.backup_dir);
            if fs::create_dir_all(&p).is_ok() {
                return p;
            }
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(parent) = exe.parent() {
                let p = parent.join("Back_File");
                if fs::create_dir_all(&p).is_ok() && is_writable(&p) {
                    return p;
                }
            }
        }
        let p = self.app_data.join("Back_File");
        let _ = fs::create_dir_all(&p);
        p
    }

    fn index_path(&self) -> PathBuf {
        self.backup_dir().join("index.json")
    }
    fn devices_path(&self) -> PathBuf {
        self.backup_dir().join("devices.json")
    }

    /// 某快照的数据目录：<备份根>/<设备名>/<时间>/<kind>
    fn snapshot_dir(&self, meta: &BackupSnapshot, kind: &str) -> PathBuf {
        let label = device_label(&meta.device_brand, &meta.device_model, &meta.device_serial);
        let time = fmt_folder_time(meta.created_at);
        self.backup_dir().join(label).join(time).join(kind)
    }

    // ---------- 设备注册表 ----------
    pub fn load_devices(&self) -> Vec<DeviceRecord> {
        read_json(&self.devices_path()).unwrap_or_default()
    }
    pub fn save_devices(&self, list: &[DeviceRecord]) -> Result<(), String> {
        write_json(&self.devices_path(), list)
    }
    pub fn upsert_device(&self, rec: DeviceRecord) -> Result<(), String> {
        let mut list = self.load_devices();
        if let Some(existing) = list.iter_mut().find(|d| d.serial == rec.serial) {
            existing.model = rec.model;
            existing.manufacturer = rec.manufacturer;
            existing.brand = rec.brand;
            if !rec.custom_name.is_empty() {
                existing.custom_name = rec.custom_name;
            }
            if rec.last_backup > existing.last_backup {
                existing.last_backup = rec.last_backup;
            }
            existing.backup_count = rec.backup_count.max(existing.backup_count);
            existing.first_seen = existing.first_seen.min(rec.first_seen);
        } else {
            list.push(rec);
        }
        self.save_devices(&list)
    }
    pub fn update_device_name(&self, serial: &str, name: &str) -> Result<(), String> {
        let mut list = self.load_devices();
        if let Some(d) = list.iter_mut().find(|d| d.serial == serial) {
            d.custom_name = name.to_string();
            return self.save_devices(&list);
        }
        Err("设备不存在".into())
    }

    // ---------- 快照索引 ----------
    pub fn load_snapshots(&self) -> Vec<BackupSnapshot> {
        read_json(&self.index_path()).unwrap_or_default()
    }
    fn save_snapshots(&self, list: &[BackupSnapshot]) -> Result<(), String> {
        write_json(&self.index_path(), list)
    }
    pub fn list_snapshots(&self, serial: Option<&str>) -> Vec<BackupSnapshot> {
        let mut all = self.load_snapshots();
        all.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        match serial {
            None => all,
            Some(s) => all.into_iter().filter(|snp| snp.device_serial == s).collect(),
        }
    }
    pub fn get_snapshot(&self, id: &str) -> Option<BackupSnapshot> {
        self.load_snapshots().into_iter().find(|s| s.id == id)
    }

    pub fn save_snapshot(
        &self,
        mut meta: BackupSnapshot,
        sms: &[Sms],
        calls: &[CallLog],
        contacts: &[Contact],
    ) -> Result<BackupSnapshot, String> {
        // 短信/通话/通讯录备份固定为 COMM 类型
        meta.kind = "COMM".into();
        meta.sms_count = sms.len();
        meta.call_count = calls.len();
        meta.contact_count = contacts.len();

        let dir = self.snapshot_dir(&meta, &meta.kind);
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        write_json(&dir.join("meta.json"), &meta)?;
        write_json(&dir.join("sms.json"), sms)?;
        write_json(&dir.join("calls.json"), calls)?;
        write_json(&dir.join("contacts.json"), contacts)?;

        let mut list = self.load_snapshots();
        list.retain(|s| s.id != meta.id);
        list.push(meta.clone());
        self.save_snapshots(&list)?;

        let rec = DeviceRecord {
            serial: meta.device_serial.clone(),
            model: meta.device_model.clone(),
            manufacturer: meta.device_manufacturer.clone(),
            brand: meta.device_brand.clone(),
            custom_name: meta.custom_name.clone(),
            first_seen: meta.created_at,
            last_backup: meta.created_at,
            backup_count: self.list_snapshots(Some(&meta.device_serial)).len() as u64,
        };
        self.upsert_device(rec)?;

        Ok(meta)
    }

    /// 保存媒体备份快照（PHOTO/VIDEO）：媒体文件已由调用方拉取到
    /// `<备份根>/<设备>/<时间>/<kind>` 目录，此处仅写 meta.json 并登记到
    /// index.json / devices.json，使仪表盘/查看数据/设备页可见。
    /// file_count 仅用于调用方备注，不落库到结构字段。
    pub fn save_media_snapshot(
        &self,
        mut meta: BackupSnapshot,
        _file_count: usize,
    ) -> Result<BackupSnapshot, String> {
        meta.sms_count = 0;
        meta.call_count = 0;
        meta.contact_count = 0;

        let dir = self.snapshot_dir(&meta, &meta.kind);
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        write_json(&dir.join("meta.json"), &meta)?;

        let mut list = self.load_snapshots();
        list.retain(|s| s.id != meta.id);
        list.push(meta.clone());
        self.save_snapshots(&list)?;

        let rec = DeviceRecord {
            serial: meta.device_serial.clone(),
            model: meta.device_model.clone(),
            manufacturer: meta.device_manufacturer.clone(),
            brand: meta.device_brand.clone(),
            custom_name: meta.custom_name.clone(),
            first_seen: meta.created_at,
            last_backup: meta.created_at,
            backup_count: self.list_snapshots(Some(&meta.device_serial)).len() as u64,
        };
        self.upsert_device(rec)?;

        Ok(meta)
    }

    /// 快照在本地磁盘的数据目录绝对路径，供前端「打开文件夹」
    pub fn snapshot_path(&self, id: &str) -> Option<String> {
        let meta = self.get_snapshot(id)?;
        Some(self.snapshot_dir(&meta, &meta.kind).to_string_lossy().to_string())
    }

    pub fn delete_snapshot(&self, id: &str) -> Result<(), String> {
        let mut list = self.load_snapshots();
        let pos = list.iter().position(|s| s.id == id);
        if let Some(i) = pos {
            let snp = list.remove(i);
            self.save_snapshots(&list)?;
            let dir = self.snapshot_dir(&snp, &snp.kind);
            if dir.exists() {
                fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
            }
            let mut devices = self.load_devices();
            if let Some(d) = devices.iter_mut().find(|d| d.serial == snp.device_serial) {
                d.backup_count = d.backup_count.saturating_sub(1);
                d.last_backup = self
                    .list_snapshots(Some(&snp.device_serial))
                    .first()
                    .map(|s| s.created_at)
                    .unwrap_or(0);
            }
            self.save_devices(&devices)?;
            Ok(())
        } else {
            Err("快照不存在".into())
        }
    }

    pub fn update_snapshot_note(&self, id: &str, note: &str) -> Result<(), String> {
        let mut list = self.load_snapshots();
        let idx = list.iter().position(|s| s.id == id).ok_or_else(|| "快照不存在".to_string())?;
        list[idx].note = note.to_string();
        let dir = self.snapshot_dir(&list[idx], &list[idx].kind);
        write_json(&dir.join("meta.json"), &list[idx])?;
        self.save_snapshots(&list)
    }

    pub fn update_snapshot_custom_name(&self, id: &str, name: &str) -> Result<(), String> {
        let mut list = self.load_snapshots();
        let idx = list.iter().position(|s| s.id == id).ok_or_else(|| "快照不存在".to_string())?;
        list[idx].custom_name = name.to_string();
        let dir = self.snapshot_dir(&list[idx], &list[idx].kind);
        write_json(&dir.join("meta.json"), &list[idx])?;
        let serial = list[idx].device_serial.clone();
        let res = self.save_snapshots(&list)?;
        let _ = self.update_device_name(&serial, name);
        Ok(res)
    }

    // ---------- 快照数据（位于 <备份根>/<设备>/<时间>/COMM/） ----------
    pub fn load_sms(&self, id: &str) -> Vec<Sms> {
        let meta = match self.get_snapshot(id) {
            Some(m) => m,
            None => return Vec::new(),
        };
        let dir = self.snapshot_dir(&meta, "COMM");
        read_json(&dir.join("sms.json")).unwrap_or_default()
    }
    pub fn load_calls(&self, id: &str) -> Vec<CallLog> {
        let meta = match self.get_snapshot(id) {
            Some(m) => m,
            None => return Vec::new(),
        };
        let dir = self.snapshot_dir(&meta, "COMM");
        read_json(&dir.join("calls.json")).unwrap_or_default()
    }
    pub fn load_contacts(&self, id: &str) -> Vec<Contact> {
        let meta = match self.get_snapshot(id) {
            Some(m) => m,
            None => return Vec::new(),
        };
        let dir = self.snapshot_dir(&meta, "COMM");
        read_json(&dir.join("contacts.json")).unwrap_or_default()
    }

    // ---------- 导入 ----------
    pub fn import_json(&self, dir: &Path) -> Result<BackupSnapshot, String> {
        let target = if dir.join("meta.json").exists() {
            dir.to_path_buf()
        } else {
            let mut found = None;
            let entries = fs::read_dir(dir).map_err(|e| format!("无法读取目录: {}", e))?;
            for entry in entries {
                let entry = entry.map_err(|e| e.to_string())?;
                let p = entry.path();
                if p.is_dir() && p.join("meta.json").exists() {
                    found = Some(p);
                    break;
                }
            }
            found.ok_or_else(|| "未找到 meta.json，请选择 JSON 导出产生的文件夹".to_string())?
        };

        let mut meta: BackupSnapshot = read_json(&target.join("meta.json"))
            .ok_or_else(|| "meta.json 解析失败".to_string())?;
        let sms: Vec<Sms> = read_json(&target.join("sms.json")).unwrap_or_default();
        let calls: Vec<CallLog> = read_json(&target.join("calls.json")).unwrap_or_default();
        let contacts: Vec<Contact> = read_json(&target.join("contacts.json")).unwrap_or_default();

        // 新 id 避免与本地已有快照冲突；保留原始备份时间 created_at
        meta.id = chrono::Utc::now().timestamp_millis().to_string();
        self.save_snapshot(meta, &sms, &calls, &contacts)
    }
}

// ---------- 共享辅助 ----------
pub fn device_label(brand: &str, model: &str, serial: &str) -> String {
    let b = safe(brand);
    let m = safe(model);
    let b_lower = b.to_lowercase();
    let mut parts: Vec<String> = Vec::new();
    if !b.is_empty() {
        parts.push(b);
    }
    if !m.is_empty() && m.to_lowercase() != b_lower {
        parts.push(m);
    }
    if parts.is_empty() {
        parts.push(safe(serial));
    }
    parts.join("_")
}

pub fn safe(s: &str) -> String {
    s.replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|', ' '], "_")
}

/// yyyyMMdd_HH_mm_ss
pub fn fmt_folder_time(ms: i64) -> String {
    if ms <= 0 {
        return "unknown".to_string();
    }
    chrono::Local
        .timestamp_opt(ms / 1000, 0)
        .single()
        .map(|t| t.format("%Y%m%d_%H_%M_%S").to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

fn is_writable(dir: &Path) -> bool {
    let test = dir.join(".wtest");
    if fs::write(&test, b"").is_ok() {
        let _ = fs::remove_file(&test);
        true
    } else {
        false
    }
}

fn read_json<T: for<'de> serde::Deserialize<'de>>(path: &Path) -> Option<T> {
    let txt = fs::read_to_string(path).ok()?;
    serde_json::from_str(&txt).ok()
}

fn write_json<T: serde::Serialize + ?Sized>(path: &Path, val: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let s = serde_json::to_string_pretty(val).map_err(|e| e.to_string())?;
    fs::write(path, s).map_err(|e| e.to_string())
}
