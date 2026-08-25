use std::fs;
use std::path::{Path, PathBuf};

use crate::models::{BackupSnapshot, CallLog, Contact, DeviceRecord, Sms};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppConfig {
    #[serde(default)]
    pub adb_path: String,
}

pub struct Storage {
    base: PathBuf,
}

impl Storage {
    pub fn new(app_data_dir: &Path) -> Self {
        let base = app_data_dir.join("BackupHub");
        fs::create_dir_all(&base).ok();
        fs::create_dir_all(base.join("backups")).ok();
        Self { base }
    }

    #[allow(dead_code)]
    pub fn base(&self) -> &Path {
        &self.base
    }

    // ---------- config ----------
    pub fn load_config(&self) -> AppConfig {
        let p = self.base.join("config.json");
        read_json(&p).unwrap_or_default()
    }

    pub fn save_config(&self, cfg: &AppConfig) -> Result<(), String> {
        write_json(&self.base.join("config.json"), cfg)
    }

    // ---------- device registry ----------
    fn registry_path(&self) -> PathBuf {
        self.base.join("devices.json")
    }

    pub fn load_devices(&self) -> Vec<DeviceRecord> {
        read_json(&self.registry_path()).unwrap_or_default()
    }

    pub fn save_devices(&self, list: &[DeviceRecord]) -> Result<(), String> {
        write_json(&self.registry_path(), list)
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

    // ---------- snapshot index ----------
    fn index_path(&self) -> PathBuf {
        self.base.join("backups").join("index.json")
    }

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
        self.load_snapshots()
            .into_iter()
            .find(|s| s.id == id)
    }

    pub fn save_snapshot(
        &self,
        mut meta: BackupSnapshot,
        sms: &[Sms],
        calls: &[CallLog],
        contacts: &[Contact],
    ) -> Result<BackupSnapshot, String> {
        meta.sms_count = sms.len();
        meta.call_count = calls.len();
        meta.contact_count = contacts.len();

        let dir = self.snapshot_dir(&meta.device_serial, &meta.id);
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        write_json(&dir.join("meta.json"), &meta)?;
        write_json(&dir.join("sms.json"), sms)?;
        write_json(&dir.join("calls.json"), calls)?;
        write_json(&dir.join("contacts.json"), contacts)?;

        let mut list = self.load_snapshots();
        list.retain(|s| s.id != meta.id);
        list.push(meta.clone());
        self.save_snapshots(&list)?;

        // 更新设备注册表
        let rec = DeviceRecord {
            serial: meta.device_serial.clone(),
            model: meta.device_model.clone(),
            manufacturer: meta.device_manufacturer.clone(),
            brand: meta.device_brand.clone(),
            custom_name: meta.custom_name.clone(),
            first_seen: meta.created_at,
            last_backup: meta.created_at,
            backup_count: self
                .list_snapshots(Some(&meta.device_serial))
                .len() as u64,
        };
        self.upsert_device(rec)?;

        Ok(meta)
    }

    pub fn delete_snapshot(&self, id: &str) -> Result<(), String> {
        let mut list = self.load_snapshots();
        let pos = list.iter().position(|s| s.id == id);
        if let Some(i) = pos {
            let snp = list.remove(i);
            self.save_snapshots(&list)?;
            let dir = self.snapshot_dir(&snp.device_serial, &snp.id);
            if dir.exists() {
                fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
            }
            // 更新设备注册表的备份次数
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
        let idx = list
            .iter()
            .position(|s| s.id == id)
            .ok_or_else(|| "快照不存在".to_string())?;
        list[idx].note = note.to_string();
        let dir = self.snapshot_dir(&list[idx].device_serial, &list[idx].id);
        write_json(&dir.join("meta.json"), &list[idx])?;
        self.save_snapshots(&list)
    }

    pub fn update_snapshot_custom_name(
        &self,
        id: &str,
        name: &str,
    ) -> Result<(), String> {
        let mut list = self.load_snapshots();
        let idx = list
            .iter()
            .position(|s| s.id == id)
            .ok_or_else(|| "快照不存在".to_string())?;
        list[idx].custom_name = name.to_string();
        let dir = self.snapshot_dir(&list[idx].device_serial, &list[idx].id);
        write_json(&dir.join("meta.json"), &list[idx])?;
        let serial = list[idx].device_serial.clone();
        self.save_snapshots(&list)?;
        let _ = self.update_device_name(&serial, name);
        Ok(())
    }

    // ---------- snapshot data ----------
    fn sanitize(serial: &str) -> String {
        serial.replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "_")
    }

    fn snapshot_dir(&self, serial: &str, id: &str) -> PathBuf {
        self.base.join("backups").join(Self::sanitize(serial)).join(id)
    }

    pub fn load_sms(&self, serial: &str, id: &str) -> Vec<Sms> {
        read_json(&self.snapshot_dir(serial, id).join("sms.json")).unwrap_or_default()
    }

    pub fn load_calls(&self, serial: &str, id: &str) -> Vec<CallLog> {
        read_json(&self.snapshot_dir(serial, id).join("calls.json")).unwrap_or_default()
    }

    pub fn load_contacts(&self, serial: &str, id: &str) -> Vec<Contact> {
        read_json(&self.snapshot_dir(serial, id).join("contacts.json")).unwrap_or_default()
    }

    #[allow(dead_code)]
    pub fn snapshot_data_dir(&self, serial: &str, id: &str) -> PathBuf {
        self.snapshot_dir(serial, id)
    }
}

// ---------- helpers ----------
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
