use std::collections::HashMap;
use std::path::PathBuf;

use tauri::{AppHandle, Emitter};

use crate::adb;
use crate::models::{PhotoFile, PhotoFolder, ProgressPayload};

/// 扫描设备相册：文件系统 find + stat（完整，含 Android/data 与 .nomedia 目录，
/// MediaStore 在 Android 11+ 不索引应用私有目录，会漏）
pub fn scan_photos(app: &AppHandle, adb: &PathBuf, serial: &str) -> Result<Vec<PhotoFolder>, String> {
    const PHOTO_EXTS: &[&str] = &["jpg", "jpeg", "png", "gif", "webp", "bmp", "heic", "heif"];
    scan_media_fs(app, adb, serial, PHOTO_EXTS, "相册")
}

/// 扫描设备视频：文件系统 find + stat
pub fn scan_videos(app: &AppHandle, adb: &PathBuf, serial: &str) -> Result<Vec<PhotoFolder>, String> {
    const VIDEO_EXTS: &[&str] = &["mp4", "mov", "mkv", "3gp", "m4v", "ts", "avi", "flv", "webm"];
    scan_media_fs(app, adb, serial, VIDEO_EXTS, "视频")
}

fn scan_media_fs(app: &AppHandle, adb: &PathBuf, serial: &str, exts: &[&str], label: &str) -> Result<Vec<PhotoFolder>, String> {
    let _ = app.emit(
        "media://progress",
        ProgressPayload {
            stage: "scan".into(),
            current: 0,
            total: 0,
            message: format!("正在扫描{}（遍历全部目录，可能需要 1-2 分钟）…", label),
        },
    );
    // find /storage/emulated/0 -type f \( -iname '*.mp4' -o ... \) -exec stat -c '%n|%s|%Y' {} + 2>/dev/null
    let ext_part = exts.iter().map(|e| format!("-iname '*.{}'", e)).collect::<Vec<_>>().join(" -o ");
    let cmd = format!(
        "find /storage/emulated/0 -type f \\( {} \\) -exec stat -c '%n|%s|%Y' {{}} + 2>/dev/null",
        ext_part
    );
    let out = adb::run_adb(adb, &["-s", serial, "shell", &cmd])?;

    let mut groups: HashMap<String, Vec<PhotoFile>> = HashMap::new();
    for line in out.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // 格式 path|size|mtime；路径可能含 |，故从右取 3 段
        let parts: Vec<&str> = line.rsplitn(3, '|').collect();
        if parts.len() < 3 {
            continue;
        }
        let mtime = parts[0].parse::<i64>().unwrap_or(0).saturating_mul(1000);
        let size = parts[1].parse::<i64>().unwrap_or(0);
        let path = parts[2];
        if path.is_empty() {
            continue;
        }
        let dir = dirname(path);
        let name = basename(path);
        groups.entry(dir).or_default().push(PhotoFile { path: path.to_string(), name, size, date: mtime });
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
    let total_count: usize = folders.iter().map(|f| f.count).sum();
    let _ = app.emit(
        "media://progress",
        ProgressPayload {
            stage: "done".into(),
            current: folders.len(),
            total: total_count,
            message: format!("{}扫描完成：{} 个目录 / {} 个", label, folders.len(), total_count),
        },
    );
    Ok(folders)
}

/// 拉取选中的目录到本地：在 parent 下自动创建 BackupHub_<设备>_<时间>_<TAG> 目录，
/// 各选中目录 adb pull 到其中，过程经 media://progress 推送
pub fn pull_media_folders(
    app: &AppHandle,
    adb: &PathBuf,
    serial: &str,
    folders: &[String],
    parent: &str,
    tag: &str,
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
    let dest = PathBuf::from(parent).join(format!("BackupHub_{}_{}_{}", label, now, tag));
    std::fs::create_dir_all(&dest).map_err(|e| format!("无法创建目标目录: {}", e))?;
    let dest_str = dest.to_string_lossy().to_string();

    let total = folders.len();
    let mut ok = 0usize;
    let stage = if tag == "VIDEO" { "video" } else { "photo" };
    for (i, folder) in folders.iter().enumerate() {
        let base = basename(folder);
        let _ = app.emit(
            "media://progress",
            ProgressPayload {
                stage: stage.into(),
                current: i,
                total,
                message: format!("正在拉取 {} ({}/{})", base, i + 1, total),
            },
        );
        let args: Vec<&str> = vec!["-s", serial, "pull", folder.as_str(), &dest_str];
        let app2 = app;
        let stage2 = stage;
        let base2 = base.clone();
        let i2 = i;
        // 节流：仅百分比变化时才推送，避免 adb 高频进度刷屏卡 UI
        let mut last_pct: Option<u32> = None;
        let res = adb::run_adb_pull_streaming(adb, &args, |pct, _line| {
            if let Some(p) = pct {
                if last_pct == Some(p) {
                    return;
                }
                last_pct = Some(p);
                let _ = app2.emit(
                    "media://progress",
                    ProgressPayload {
                        stage: stage2.into(),
                        current: i2,
                        total,
                        message: format!("正在拉取 {} — {}%", base2, p),
                    },
                );
            }
        });
        match res {
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
