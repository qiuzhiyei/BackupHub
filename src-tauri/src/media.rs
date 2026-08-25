use std::collections::HashMap;
use std::path::PathBuf;

use tauri::{AppHandle, Emitter};

use crate::adb;
use crate::models::{PhotoFile, PhotoFolder, ProgressPayload};

/// 扫描设备相册（content://media/external/images/media），按原目录分组
pub fn scan_photos(adb: &PathBuf, serial: &str) -> Result<Vec<PhotoFolder>, String> {
    let rows = adb::query_provider(
        adb,
        serial,
        "content://media/external/images/media",
        &["_data", "_size", "date_added", "display_name"],
        None,
        None,
    )?;

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
        let name = row
            .get("display_name")
            .cloned()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| basename(&data));
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

/// 拉取选中的目录到本地 dest（每个目录 adb pull 一次），过程经 media://progress 推送
pub fn pull_photo_folders(
    app: &AppHandle,
    adb: &PathBuf,
    serial: &str,
    folders: &[String],
    dest: &str,
) -> Result<usize, String> {
    if folders.is_empty() {
        return Err("未选择任何目录".into());
    }
    std::fs::create_dir_all(dest).map_err(|e| format!("无法创建目标目录: {}", e))?;
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
        let args: Vec<&str> = vec!["-s", serial, "pull", folder.as_str(), dest];
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
            message: format!("完成：成功拉取 {}/{} 个目录到 {}", ok, total, dest),
        },
    );
    Ok(ok)
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
