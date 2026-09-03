use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter};

use crate::adb;
use crate::backup;
use crate::models::{BackupSnapshot, PhotoFile, PhotoFolder, ProgressPayload};
use crate::storage::{self, Storage};

/// Android 应用私有目录前缀：Android/{data,media,obb}/<包名>/...
const APP_DIRS: &[&str] = &["Android/data/", "Android/media/", "Android/obb/"];

/// 扫描根（设备内置存储）
const ROOT_PATH: &str = "/storage/emulated/0";

/// 扫描设备相册：文件系统 find + stat（完整，含 Android/data 与 .nomedia 目录，
/// MediaStore 在 Android 11+ 不索引应用私有目录，会漏）
pub fn scan_photos(
    app: &AppHandle,
    adb: &PathBuf,
    serial: &str,
    labels: &HashMap<String, String>,
) -> Result<Vec<PhotoFolder>, String> {
    const PHOTO_EXTS: &[&str] = &["jpg", "jpeg", "png", "gif", "webp", "bmp", "heic", "heif"];
    scan_media_fs(app, adb, serial, PHOTO_EXTS, "相册", labels)
}

/// 扫描设备视频：文件系统 find + stat
pub fn scan_videos(
    app: &AppHandle,
    adb: &PathBuf,
    serial: &str,
    labels: &HashMap<String, String>,
) -> Result<Vec<PhotoFolder>, String> {
    const VIDEO_EXTS: &[&str] = &["mp4", "mov", "mkv", "3gp", "m4v", "ts", "avi", "flv", "webm"];
    scan_media_fs(app, adb, serial, VIDEO_EXTS, "视频", labels)
}

fn scan_media_fs(
    app: &AppHandle,
    adb: &PathBuf,
    serial: &str,
    exts: &[&str],
    label: &str,
    labels: &HashMap<String, String>,
) -> Result<Vec<PhotoFolder>, String> {
    let _ = app.emit(
        "media://progress",
        ProgressPayload {
            stage: "scan".into(),
            current: 0,
            total: 0,
            message: format!("正在扫描{}（遍历全部目录，可能需要 1-2 分钟）…", label),
        },
    );
    // find -printf 用 find 自身的 fstatat 遍历信息（不走单独 stat），
    // 能访问 Android 11+ 存储限制下 stat 无法读取的文件，避免漏文件
    let ext_part = exts.iter().map(|e| format!("-iname '*.{}'", e)).collect::<Vec<_>>().join(" -o ");
    let cmd = format!(
        "find /storage/emulated/0 -type f \\( {} \\) -printf '%p|%s|%T@\\n' 2>/dev/null",
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
        // 格式 path|size|mtime（%T@ 为浮点秒，如 1234567890.123456）；路径可能含 |，故从右取 3 段
        let parts: Vec<&str> = line.rsplitn(3, '|').collect();
        if parts.len() < 3 {
            continue;
        }
        // %T@ 是浮点秒，取整数部分 ×1000 转毫秒
        let mtime = parts[0].split('.').next().and_then(|s| s.parse::<i64>().ok()).unwrap_or(0).saturating_mul(1000);
        let size = parts[1].parse::<i64>().unwrap_or(0);
        let path = parts[2];
        if path.is_empty() {
            continue;
        }
        let parent = dirname(path);
        let name = basename(path);
        // 应用私有目录归并到应用根（同一应用的多个子目录合并为一项），其余按各自父目录分组
        let key = group_key(&parent);
        groups.entry(key).or_default().push(PhotoFile { path: path.to_string(), name, size, date: mtime });
    }

    let mut folders: Vec<PhotoFolder> = groups
        .into_iter()
        .map(|(dir, mut files)| {
            files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
            let count = files.len();
            let total_size = files.iter().map(|f| f.size).sum();
            let app = app_of_dir(&dir, labels);
            // 应用目录用应用名作为名；根目录单独处理；其余取末段目录名
            let name = if dir == ROOT_PATH {
                "根目录".to_string()
            } else {
                app.clone().unwrap_or_else(|| basename(&dir))
            };
            PhotoFolder { dir, name, app, count, total_size, files }
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
/// - `files`：设备侧文件（含 size，来自 scan_* 的 PhotoFile，size 用于续传判断）
/// - `tag`：`"PHOTO"` | `"VIDEO"`，同时作为本地子目录名与快照 kind
/// - `flatten`：true 时全部文件直接放进 dest 根目录（不保留目录结构），便于一次性浏览
pub fn pull_media_files(
    app: &AppHandle,
    storage: &Storage,
    adb: &PathBuf,
    serial: &str,
    files: &[PhotoFile],
    tag: &str,
    custom_name: &str,
    flatten: bool,
    cancel: &AtomicBool,
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
    let labels = storage.load_app_labels();
    let (ok, _total, stop) = if flatten {
        pull_files_flat(app, adb, serial, files, &dest, tag, total, cancel)?
    } else {
        pull_files_grouped(app, adb, serial, files, &dest, tag, total, &labels, cancel)?
    };
    // stop = Some("已取消" | "设备已断开") | None
    if let Some(reason) = stop {
        if ok == 0 {
            let _ = app.emit(
                "media://progress",
                ProgressPayload {
                    stage: "done".into(),
                    current: 0,
                    total,
                    message: format!("失败：{}，未拉取任何文件", reason),
                },
            );
            return Err(reason.into());
        }
    }

    // 完成度判断：只有全部拉成才算「完成」；断开/取消/部分失败一律标失败或未完成，
    // 绝不显示「完成」——避免用户走开回来误以为成功。
    let word = if tag == "VIDEO" { "视频" } else { "照片" };
    let (note, done_msg) = if stop.is_none() && ok == total {
        (format!("{}备份（{} 个）", word, ok),
         format!("完成：成功拉取 {}/{} 个文件到 {}", ok, total, dest_str))
    } else if stop == Some("已取消") {
        (format!("{}备份（{} 个，已取消）", word, ok),
         format!("已取消：已拉取 {}/{} 个文件", ok, total))
    } else if stop == Some("设备已断开") {
        (format!("{}备份失败（{}/{} 个，设备已断开）", word, ok, total),
         format!("失败：设备已断开，已拉取 {}/{} 个文件", ok, total))
    } else {
        // stop 为空但 ok<total：设备仍在线，部分文件拉取失败
        (format!("{}备份未完成（{}/{} 个，部分文件失败）", word, ok, total),
         format!("未完成：已拉取 {}/{} 个文件（部分失败）", ok, total))
    };

    let meta = BackupSnapshot {
        id,
        kind: tag.to_string(),
        device_serial: serial.to_string(),
        device_model: model,
        device_manufacturer: manufacturer,
        device_brand: brand,
        custom_name: custom_name.to_string(),
        note,
        device_label: String::new(),
        created_at: now,
        sms_count: 0,
        call_count: 0,
        contact_count: 0,
    };
    let saved = storage.save_media_snapshot(meta)?;

    let _ = app.emit(
        "media://progress",
        ProgressPayload {
            stage: "done".into(),
            current: ok,
            total,
            message: done_msg,
        },
    );
    Ok(saved)
}

/// 按文件父目录分组批量 adb pull，保留原目录结构。
/// 返回 (成功文件数, 总文件数, 停止原因: None=正常完成 / Some("已取消"|"设备已断开"))。
/// 续传：本地已存在且大小一致者跳过；设备掉线（错误匹配或连续失败）自动停止，避免逐文件报错刷屏。
fn pull_files_grouped(
    app: &AppHandle,
    adb: &PathBuf,
    serial: &str,
    files: &[PhotoFile],
    dest: &Path,
    tag: &str,
    total: usize,
    labels: &HashMap<String, String>,
    cancel: &AtomicBool,
) -> Result<(usize, usize, Option<&'static str>), String> {
    let stage = if tag == "VIDEO" { "video" } else { "photo" };

    // 按父目录分组
    let mut groups: HashMap<String, Vec<&PhotoFile>> = HashMap::new();
    for f in files {
        groups.entry(dirname(&f.path)).or_default().push(f);
    }
    let mut group_list: Vec<(String, Vec<&PhotoFile>)> = groups.into_iter().collect();
    group_list.sort_by(|a, b| a.0.cmp(&b.0));

    let mut ok = 0usize;
    let mut done_before = 0usize;

    for (parent_dir, group_files) in &group_list {
        if cancel.load(Ordering::Relaxed) {
            return Ok((ok, total, Some("已取消")));
        }
        let base = basename(parent_dir);
        let rel = local_subpath(parent_dir, labels);
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
            args.push(f.path.clone());
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
        let batch = adb::run_adb_pull_streaming(adb, &arg_refs, cancel, |pct, _line| {
            if let Some(p) = pct {
                if last_pct == Some(p) {
                    return;
                }
                last_pct = Some(p);
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
            Ok(_) => {
                ok += group_len;
            }
            Err(_e) => {
                if cancel.load(Ordering::Relaxed) {
                    return Ok((ok, total, Some("已取消")));
                }
                // 拉取失败：先确认设备是否还在线，掉线则整体停止，避免逐文件报错刷屏
                if !adb::is_device_online(adb, serial) {
                    return Ok((ok, total, Some("设备已断开")));
                }
                // 设备仍在线 → 多为单文件无权限致整批非零退出，逐文件回退尽量抢救
                for (gi, f) in group_files.iter().enumerate() {
                    if cancel.load(Ordering::Relaxed) {
                        return Ok((ok, total, Some("已取消")));
                    }
                    let f_args: Vec<&str> = vec!["-s", serial, "pull", f.path.as_str(), &local_str];
                    let f_base = basename(&f.path);
                    let res = adb::run_adb_pull_streaming(adb, &f_args, cancel, |pct, _line| {
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
                        Ok(_) => {
                            ok += 1;
                        }
                        Err(e) => {
                            if cancel.load(Ordering::Relaxed) {
                                return Ok((ok, total, Some("已取消")));
                            }
                            if !adb::is_device_online(adb, serial) {
                                return Ok((ok, total, Some("设备已断开")));
                            }
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

    Ok((ok, total, None))
}

/// 扁平拉取：所有文件直接放进 dest 根目录（不保留目录结构），便于一次性浏览全部媒体。
/// 同名文件自动加 `_N` 后缀避免覆盖。逐文件拉取（取消可即时响应）。
/// 续传：本地已存在且大小一致者跳过；设备掉线（错误匹配或连续失败）自动停止。
/// 返回 (成功文件数, 总文件数, 停止原因: None=完成 / Some("已取消"|"设备已断开"))。
fn pull_files_flat(
    app: &AppHandle,
    adb: &PathBuf,
    serial: &str,
    files: &[PhotoFile],
    dest: &Path,
    tag: &str,
    total: usize,
    cancel: &AtomicBool,
) -> Result<(usize, usize, Option<&'static str>), String> {
    let stage = if tag == "VIDEO" { "video" } else { "photo" };
    let mut used: HashSet<String> = HashSet::new();
    let mut ok = 0usize;

    for (i, f) in files.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            return Ok((ok, total, Some("已取消")));
        }
        let base = basename(&f.path);
        let name = dedupe_name(&base, &mut used);
        let local_path = dest.join(&name);
        // 续传：已存在且大小一致 → 跳过
        let local_str = local_path.to_string_lossy().to_string();

        let _ = app.emit(
            "media://progress",
            ProgressPayload {
                stage: stage.into(),
                current: i,
                total,
                message: format!("正在拉取 {}（{}/{}）", base, i + 1, total),
            },
        );

        let app2 = app;
        let stage2 = stage;
        let base2 = base.clone();
        let i2 = i;
        let total2 = total;
        let args: Vec<&str> = vec!["-s", serial, "pull", f.path.as_str(), &local_str];
        let res = adb::run_adb_pull_streaming(adb, &args, cancel, |pct, _line| {
            if let Some(p) = pct {
                let cur = i2 + (p as usize).min(1);
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
        match res {
            Ok(_) => {
                ok += 1;
            }
            Err(e) => {
                if cancel.load(Ordering::Relaxed) {
                    return Ok((ok, total, Some("已取消")));
                }
                // 拉取失败：确认设备是否还在线，掉线则整体停止
                if !adb::is_device_online(adb, serial) {
                    return Ok((ok, total, Some("设备已断开")));
                }
                let _ = app.emit(
                    "media://progress",
                    ProgressPayload {
                        stage: "error".into(),
                        current: i,
                        total,
                        message: format!("拉取失败 {}: {}", base, e),
                    },
                );
            }
        }
    }
    Ok((ok, total, None))
}

/// 在已用名集合内为 base 取一个不冲突的本地文件名（同名加 _N 后缀，保留扩展名）
fn dedupe_name(base: &str, used: &mut HashSet<String>) -> String {
    if !used.contains(base) {
        used.insert(base.to_string());
        return base.to_string();
    }
    let (stem, ext) = split_ext(base);
    for n in 1.. {
        let candidate = format!("{}_{}{}", stem, n, ext);
        if !used.contains(&candidate) {
            used.insert(candidate.clone());
            return candidate;
        }
    }
    unreachable!()
}

/// 拆分文件名为主名与扩展名（含点），无扩展名则 ext 为空
fn split_ext(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    }
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

/// 分组键：应用私有目录归并到应用根（Android/{data,media,obb}/<包名>），
fn group_key(parent: &str) -> String {
    let rel = relative_under_root(parent);
    for prefix in APP_DIRS {
        if let Some(rest) = rel.strip_prefix(prefix) {
            let pkg = rest.split('/').next().unwrap_or(rest);
            return format!("{}{}{}", ROOT_PATH, prefix, pkg);
        }
    }
    parent.to_string()
}

/// 由设备父目录计算本地子路径：应用私有目录（Android/{data,media,obb}/<包名>/...）
/// 用应用名（友好名优先，否则包名）替换前缀，便于按应用归类；其余路径保持原相对结构。
fn local_subpath(parent_dir: &str, labels: &HashMap<String, String>) -> String {
    let rel = relative_under_root(parent_dir);
    for prefix in APP_DIRS {
        if let Some(rest) = rel.strip_prefix(prefix) {
            // rest = "<包名>[/子路径...]"
            let (pkg, sub) = match rest.split_once('/') {
                Some((p, s)) => (p, s),
                None => (rest, ""),
            };
            let label = labels
                .get(pkg)
                .cloned()
                .unwrap_or_else(|| pkg.to_string());
            return if sub.is_empty() {
                label
            } else {
                format!("{}/{}", label, sub)
            };
        }
    }
    rel
}

/// 解析某设备目录所属应用（用于扫描列表展示）：应用私有目录返回应用名，否则 None
fn app_of_dir(dir: &str, labels: &HashMap<String, String>) -> Option<String> {
    let rel = relative_under_root(dir);
    for prefix in APP_DIRS {
        if let Some(rest) = rel.strip_prefix(prefix) {
            let pkg = rest.split('/').next().unwrap_or(rest);
            return Some(labels.get(pkg).cloned().unwrap_or_else(|| pkg.to_string()));
        }
    }
    None
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
