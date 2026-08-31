use std::collections::HashMap;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Emitter};

use crate::adb;
use crate::backup;
use crate::models::{BackupSnapshot, PhotoFile, PhotoFolder, ProgressPayload};
use crate::storage::{self, Storage};

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
    // find 遍历时遇到无权限目录会非零退出，但仍会输出可访问的文件；
    // 故用 run_adb_raw 不管退出码都取 stdout，避免误判为扫描失败
    let (out, _stderr, _ok) = adb::run_adb_raw(adb, &["-s", serial, "shell", &cmd])?;

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

/// 执行媒体备份：按文件拉取（仅扫描到的图片/视频，不拉整个目录，避免 .bin 等无关文件），
/// 按父目录分组批量 adb pull 保留设备原目录结构；完成后创建 BackupSnapshot(kind=tag) 写入索引，
/// 使仪表盘/查看数据/设备页可见。
///
/// - `files`：设备侧绝对路径（已按扩展名过滤，来自 scan_* 的 PhotoFile.path）
/// - `tag`：`"PHOTO"` | `"VIDEO"`，同时作为本地子目录名与快照 kind
pub fn pull_media_files(
    app: &AppHandle,
    storage: &Storage,
    adb: &PathBuf,
    serial: &str,
    files: &[String],
    tag: &str,
    custom_name: &str,
) -> Result<BackupSnapshot, String> {
    if files.is_empty() {
        return Err("未选择任何文件".into());
    }

    let (model, manufacturer, brand) = backup::fetch_device_info(adb, serial);
    let now = chrono::Utc::now().timestamp_millis();
    let id = now.to_string();
    let label = storage::device_label(&brand, &model, serial);
    let time = storage::fmt_folder_time(now);
    // 与 storage::snapshot_dir(meta, &meta.kind) 解析到同一目录，故 meta.json 会写入此 dest
    let dest = storage.backup_dir().join(label).join(time).join(tag);
    std::fs::create_dir_all(&dest).map_err(|e| format!("无法创建目标目录: {}", e))?;
    let dest_str = dest.to_string_lossy().to_string();

    let total = files.len();
    let (ok, _total) = pull_files_grouped(app, adb, serial, files, &dest, tag, total)?;

    // 自动备注：照片/视频备份（N 个）
    let word = if tag == "VIDEO" { "视频" } else { "照片" };
    let note = format!("{}备份（{} 个）", word, ok);

    let meta = BackupSnapshot {
        id,
        kind: tag.to_string(),
        device_serial: serial.to_string(),
        device_model: model,
        device_manufacturer: manufacturer,
        device_brand: brand,
        custom_name: custom_name.to_string(),
        note,
        created_at: now,
        sms_count: 0,
        call_count: 0,
        contact_count: 0,
    };
    let saved = storage.save_media_snapshot(meta, ok)?;

    let _ = app.emit(
        "media://progress",
        ProgressPayload {
            stage: "done".into(),
            current: ok,
            total,
            message: format!("完成：成功拉取 {}/{} 个文件到 {}", ok, total, dest_str),
        },
    );
    Ok(saved)
}

/// 按文件父目录分组批量 adb pull，保留原目录结构。
/// 返回 (成功文件数, 总文件数)。进度经 media://progress 推送。
fn pull_files_grouped(
    app: &AppHandle,
    adb: &PathBuf,
    serial: &str,
    files: &[String],
    dest: &Path,
    tag: &str,
    total: usize,
) -> Result<(usize, usize), String> {
    let stage = if tag == "VIDEO" { "video" } else { "photo" };

    // 按父目录分组
    let mut groups: HashMap<String, Vec<&str>> = HashMap::new();
    for f in files {
        groups.entry(dirname(f)).or_default().push(f.as_str());
    }
    let mut group_list: Vec<(String, Vec<&str>)> = groups.into_iter().collect();
    group_list.sort_by(|a, b| a.0.cmp(&b.0));

    let mut ok = 0usize;
    let mut done_before = 0usize;

    for (parent_dir, group_files) in &group_list {
        let base = basename(parent_dir);
        // 本地子目录：保留设备原目录结构（相对扫描根 /storage/emulated/0 镜像）
        let rel = relative_under_root(parent_dir);
        let local_subdir = if rel.is_empty() {
            dest.to_path_buf()
        } else {
            dest.join(&rel)
        };
        std::fs::create_dir_all(&local_subdir)
            .map_err(|e| format!("无法创建本地目录 {}: {}", local_subdir.display(), e))?;
        let local_str = local_subdir.to_string_lossy().to_string();

        let group_len = group_files.len();
        let _ = app.emit(
            "media://progress",
            ProgressPayload {
                stage: stage.into(),
                current: done_before,
                total,
                message: format!("正在拉取 {}（{} 个）", base, group_len),
            },
        );

        // 批量拉取：本地目录已存在，adb pull 把各文件按 basename 放入该目录
        let mut args: Vec<String> = Vec::with_capacity(group_len + 4);
        args.push("-s".into());
        args.push(serial.into());
        args.push("pull".into());
        for f in group_files {
            args.push((*f).to_string());
        }
        args.push(local_str.clone());
        let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();

        let app2 = app;
        let stage2 = stage;
        let base2 = base.clone();
        let done2 = done_before;
        let glen2 = group_len;
        let total2 = total;
        let mut last_pct: Option<u32> = None;
        let batch = adb::run_adb_pull_streaming(adb, &arg_refs, |pct, _line| {
            if let Some(p) = pct {
                if last_pct == Some(p) {
                    return;
                }
                last_pct = Some(p);
                // 全局进度估算：已完成 + 当前批次内百分比
                let cur = done2 + ((p as usize) * glen2 / 100).min(glen2);
                let _ = app2.emit(
                    "media://progress",
                    ProgressPayload {
                        stage: stage2.into(),
                        current: cur,
                        total: total2,
                        message: format!("正在拉取 {} — {}%", base2, p),
                    },
                );
            }
        });

        match batch {
            Ok(_) => ok += group_len,
            Err(_) => {
                // 批次失败（常因单文件无权限致整批非零退出）→ 逐文件回退，尽量抢救可拉取的文件
                for (gi, f) in group_files.iter().enumerate() {
                    let f_args: Vec<&str> = vec!["-s", serial, "pull", f, &local_str];
                    let f_base = basename(f);
                    let res = adb::run_adb_pull_streaming(adb, &f_args, |pct, _line| {
                        if let Some(p) = pct {
                            let cur = done2 + gi + (p as usize).min(1);
                            let _ = app2.emit(
                                "media://progress",
                                ProgressPayload {
                                    stage: stage2.into(),
                                    current: cur,
                                    total: total2,
                                    message: format!("正在拉取 {} — {}%", f_base, p),
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
                                    current: done2 + gi,
                                    total: total2,
                                    message: format!("拉取失败 {}: {}", f_base, e),
                                },
                            );
                        }
                    }
                }
            }
        }

        done_before += group_len;
    }

    Ok((ok, total))
}

/// 设备路径相对扫描根 `/storage/emulated/0` 的相对路径，用于本地镜像保留原目录结构。
/// 不在扫描根下时回退为对完整路径做 safe 处理（避免路径分隔符等非法字符）。
fn relative_under_root(path: &str) -> String {
    const ROOT: &str = "/storage/emulated/0";
    if path == ROOT {
        return String::new();
    }
    if let Some(rest) = path.strip_prefix(ROOT) {
        // rest 形如 "/DCIM/Camera"
        return rest.trim_start_matches('/').to_string();
    }
    storage::safe(path)
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
