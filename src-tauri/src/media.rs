use std::collections::HashMap;
use std::path::PathBuf;

use tauri::{AppHandle, Emitter};

use crate::adb;
use crate::models::{PhotoFile, PhotoFolder, ProgressPayload};

/// 扫描设备相册（content://media/external/images/media），按原目录分组
pub fn scan_photos(adb: &PathBuf, serial: &str) -> Result<Vec<PhotoFolder>, String> {
    // 个别 ROM 对 display_name/_size 等列校验严格，整条查询会因无效列失败；
    // 先用常用投影，失败则降级为仅 _data（文件名从路径 basename 推导）
    let rows = match adb::query_provider(
        adb,
        serial,
        "content://media/external/images/media",
        &["_data", "_size", "date_added"],
        None,
        None,
    ) {
        Ok(r) => r,
        Err(_) => adb::query_provider(adb, serial, "content://media/external/images/media", &["_data"], None, None)?,
    };

    let mut groups: HashMap<String, Vec<PhotoFile>> = HashMap::new();
    for row in &rows {
        let data = match row.get("_data") {
            Some(v) => v.clone(),
            None => continue,
        };
        if data.is_empty() {
            continue;
        }
        let dir = dirname(&data);
        let name = basename(&data);
        let size = row.get("_size").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
        // date_added 是秒，转毫秒
        let date = row
            .get("date_added")
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(0)
            .saturating_mul(1000);
        groups.entry(dir).or_default().push(PhotoFile { path: data, name, size, date });
    }

    let mut folders: Vec<PhotoFolder> = groups
        .into_iter()
        .map(|(dir, mut files)| {
            files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
            let count = files.len();
            let total_size = files.iter().map(|f| f.size).sum();
            let name = basename(&dir);
            PhotoFolder { dir, name, count, total_size, files }
        })
        .collect();
    folders.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(folders)
}

/// 拉取选中的目录到本地：在 parent 下自动创建 BackupHub_<设备>_<时间> 目录，
/// 各选中目录 adb pull 到其中，过程经 media://progress 推送
pub fn pull_photo_folders(
    app: &AppHandle,
    adb: &PathBuf,
    serial: &str,
    folders: &[String],
    parent: &str,
) -> Result<(usize, String), String> {
    if folders.is_empty() {
        return Err("未选择任何目录".into());
    }
    // 设备名 + 本地时间，命名与导出一致
    let get = |prop: &str| {
        adb::run_adb(adb, &["-s", serial, "shell", "getprop", prop])
            .map(|s| s.trim().to_string())
            .unwrap_or_default()
    };
    let brand = get("ro.product.brand");
    let model = get("ro.product.model");
    let label = device_label(&brand, &model, serial);
    let now = chrono::Local::now().format("%Y-%m-%d_%H-%M").to_string();
    let dest = PathBuf::from(parent).join(format!("BackupHub_{}_{}", label, now));
    std::fs::create_dir_all(&dest).map_err(|e| format!("无法创建目标目录: {}", e))?;
    let dest_str = dest.to_string_lossy().to_string();

    let total = folders.len();
    let mut ok = 0usize;
    for (i, folder) in folders.iter().enumerate() {
        let _ = app.emit(
            "media://progress",
            ProgressPayload {
                stage: "photo".into(),
                current: i,
                total,
                message: format!("正在拉取 {} ({}/{})", basename(folder), i + 1, total),
            },
        );
        let args: Vec<&str> = vec!["-s", serial, "pull", folder.as_str(), &dest_str];
        match adb::run_adb(adb, &args) {
            Ok(_) => ok += 1,
            Err(e) => {
                let _ = app.emit(
                    "media://progress",
                    ProgressPayload {
                        stage: "error".into(),
                        current: i,
                        total,
                        message: format!("拉取失败 {}: {}", basename(folder), e),
                    },
                );
            }
        }
    }
    let _ = app.emit(
        "media://progress",
        ProgressPayload {
            stage: "done".into(),
            current: ok,
            total,
            message: format!("完成：成功拉取 {}/{} 个目录到 {}", ok, total, dest_str),
        },
    );
    Ok((ok, dest_str))
}

fn device_label(brand: &str, model: &str, serial: &str) -> String {
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

fn safe(s: &str) -> String {
    s.replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|', ' '], "_")
}

fn basename(p: &str) -> String {
    p.rsplit('/').next().unwrap_or(p).to_string()
}

fn dirname(p: &str) -> String {
    match p.rfind('/') {
        Some(i) => p[..i].to_string(),
        None => String::new(),
    }
}
