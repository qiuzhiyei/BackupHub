use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};

use crate::models::DeviceStatus;

/// 在系统中解析 adb 可执行文件路径
/// 优先级：用户配置 > PATH > 常见安装目录
pub fn resolve_adb_path(configured: Option<&str>) -> Option<PathBuf> {
    // 1. 用户配置
    if let Some(cfg) = configured {
        let p = PathBuf::from(cfg);
        if p.exists() {
            return Some(p);
        }
    }

    // 2. PATH 上的 adb
    if Command::new("adb").arg("version").output().is_ok() {
        if let Ok(out) = Command::new("where").arg("adb").output() {
            if out.status.success() {
                let txt = String::from_utf8_lossy(&out.stdout);
                if let Some(first) = txt.lines().next() {
                    let pb = PathBuf::from(first.trim());
                    if pb.exists() {
                        return Some(pb);
                    }
                }
            }
        }
        // where 失败但仍可执行，视为可用
        return Some(PathBuf::from("adb"));
    }

    // 3. 常见安装目录
    let candidates = common_adb_candidates();
    for c in candidates {
        if c.exists() {
            return Some(c);
        }
    }

    None
}

#[cfg(windows)]
fn common_adb_candidates() -> Vec<PathBuf> {
    let mut v = Vec::new();
    let env_home = std::env::var("LOCALAPPDATA").unwrap_or_default();
    if !env_home.is_empty() {
        v.push(PathBuf::from(&env_home).join("Android/Sdk/platform-tools/adb.exe"));
    }
    if let Ok(sdk) = std::env::var("ANDROID_SDK_ROOT") {
        v.push(PathBuf::from(&sdk).join("platform-tools/adb.exe"));
    }
    if let Ok(sdk) = std::env::var("ANDROID_HOME") {
        v.push(PathBuf::from(&sdk).join("platform-tools/adb.exe"));
    }
    v.push(PathBuf::from("C:/Android/platform-tools/adb.exe"));
    v.push(PathBuf::from(
        "C:/Program Files/Android/Android Studio/platform-tools/adb.exe",
    ));
    v
}

#[cfg(not(windows))]
fn common_adb_candidates() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Ok(home) = std::env::var("HOME") {
        v.push(PathBuf::from(&home).join("Library/Android/sdk/platform-tools/adb"));
        v.push(PathBuf::from(&home).join("Android/Sdk/platform-tools/adb"));
    }
    v.push(PathBuf::from("/usr/local/bin/adb"));
    v.push(PathBuf::from("/usr/bin/adb"));
    v
}

/// 执行 adb 命令并返回 stdout
pub fn run_adb(adb: &PathBuf, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new(adb);
    for a in args {
        cmd.arg(a);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("无法执行 adb: {}", e))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).to_string();
        let combined = if err.trim().is_empty() {
            String::from_utf8_lossy(&out.stdout).to_string()
        } else {
            err
        };
        return Err(combined.trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// 流式执行 adb pull：逐块读取 stderr 解析百分比进度并回调，
/// 用于大文件（视频）拉取时显示实时百分比，避免长时间无反馈。
/// `cancel` 置 true 时立即 kill adb 子进程并返回 Err("已取消")，实现取消。
pub fn run_adb_pull_streaming(
    adb: &PathBuf,
    args: &[&str],
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(Option<u32>, &str),
) -> Result<(), String> {
    let mut cmd = Command::new(adb);
    cmd.args(args);
    // stdout 不需要（adb 把进度写到 stderr），置 null 避免 pipe 缓冲死锁
    cmd.stdout(Stdio::null()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("无法执行 adb: {}", e))?;
    let mut stderr = child.stderr.take().ok_or("无法获取 stderr")?;

    let mut buf = String::new();
    let mut chunk = [0u8; 2048];
    let mut last_line = String::new();
    loop {
        // 取消：立即杀死 adb 子进程，停止当前拉取
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("已取消".into());
        }
        let n = stderr.read(&mut chunk).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        // adb 输出可能非 UTF8 边界，用 lossy
        buf.push_str(&String::from_utf8_lossy(&chunk[..n]));
        // adb 用 \r 更新进度条，按 \r 或 \n 分段处理
        loop {
            let pos = buf.find(|c| c == '\r' || c == '\n');
            let pos = match pos {
                Some(p) => p,
                None => break,
            };
            let line: String = buf.drain(..=pos).collect();
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            last_line = line.to_string();
            let pct = extract_percent(line);
            on_progress(pct, line);
        }
    }

    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() {
        let detail = last_line.trim();
        return Err(if detail.is_empty() {
            format!("adb 拉取未成功（退出码 {}）", status.code().unwrap_or(-1))
        } else {
            format!("adb 拉取未成功（退出码 {}）: {}", status.code().unwrap_or(-1), detail)
        });
    }
    Ok(())
}

/// 从一行 adb 输出里提取最后一个 "NN%"
fn extract_percent(line: &str) -> Option<u32> {
    let bytes = line.as_bytes();
    let mut last: Option<u32> = None;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let mut j = i;
            while j > 0 && bytes[j - 1].is_ascii_digit() {
                j -= 1;
            }
            if j < i {
                if let Ok(n) = line[j..i].parse::<u32>() {
                    last = Some(n);
                }
            }
        }
        i += 1;
    }
    last
}

/// 列出当前通过 USB 连接的设备
pub fn list_devices(adb: &PathBuf) -> Result<Vec<DeviceStatus>, String> {
    let out = run_adb(adb, &["devices", "-l"])?;
    let mut result = Vec::new();
    let mut parsing = false;
    for line in out.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with("List of devices") {
            parsing = true;
            continue;
        }
        if !parsing {
            continue;
        }
        // 行格式: serial  state  key:val key:val ...
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 2 {
            continue;
        }
        let serial = parts[0].to_string();
        let state = parts[1].to_string();

        // 从行里解析 model:xxx device:xxx product:xxx
        let mut model = String::new();
        let mut brand = String::new();
        for p in &parts[2..] {
            if let Some(v) = p.strip_prefix("model:") {
                model = v.to_string();
            } else if let Some(v) = p.strip_prefix("product:") {
                if brand.is_empty() {
                    brand = v.to_string();
                }
            }
        }

        // 对已授权设备，一次 shell 调用取 manufacturer/brand/model（原来 3 次 adb 进程→1 次）
        let mut manufacturer = String::new();
        let mut brand_final = brand;
        if state == "device" {
            if let Ok(out) = run_adb(adb, &["-s", &serial, "shell", "getprop ro.product.manufacturer; getprop ro.product.brand; getprop ro.product.model"]) {
                let lines: Vec<&str> = out.lines().collect();
                if let Some(v) = lines.first() {
                    manufacturer = v.trim().to_string();
                }
                if let Some(v) = lines.get(1) {
                    let b = v.trim().to_string();
                    if !b.is_empty() {
                        brand_final = b;
                    }
                }
                if model.is_empty() {
                    if let Some(v) = lines.get(2) {
                        model = v.trim().to_string();
                    }
                }
            }
        }

        result.push(DeviceStatus {
            serial,
            state,
            model,
            manufacturer,
            brand: brand_final,
        });
    }
    Ok(result)
}

/// 执行 adb 命令，返回 (stdout, stderr, 是否成功)
pub fn run_adb_raw(adb: &PathBuf, args: &[&str]) -> Result<(String, String, bool), String> {
    let mut cmd = Command::new(adb);
    for a in args {
        cmd.arg(a);
    }
    let out = cmd.output().map_err(|e| format!("无法执行 adb: {}", e))?;
    Ok((
        String::from_utf8_lossy(&out.stdout).to_string(),
        String::from_utf8_lossy(&out.stderr).to_string(),
        out.status.success(),
    ))
}

/// 查询 content provider，返回每行 key=>value 的 map 列表
/// projection 为有序列名，解析时按此顺序定位列边界，能正确处理含逗号/换行的值
pub fn query_provider(
    adb: &PathBuf,
    serial: &str,
    uri: &str,
    projection: &[&str],
    where_clause: Option<&str>,
    sort: Option<&str>,
) -> Result<Vec<HashMap<String, String>>, String> {
    let mut args: Vec<String> = vec![
        "-s".into(),
        serial.into(),
        "shell".into(),
        "content".into(),
        "query".into(),
        "--uri".into(),
        uri.into(),
    ];
    if !projection.is_empty() {
        args.push("--projection".into());
        args.push(projection.join(":"));
    }
    if let Some(w) = where_clause {
        args.push("--where".into());
        args.push(w.into());
    }
    if let Some(s) = sort {
        args.push("--sort".into());
        args.push(s.into());
    }
    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let (stdout, stderr, _ok) = run_adb_raw(adb, &arg_refs)?;

    // 解析行：一条记录可能因 body 含换行而跨多行，
    // 故以 "Row:" 开头作为记录起点，后续非 "Row:" 行视为续行并入当前记录
    let mut rows: Vec<HashMap<String, String>> = Vec::new();
    let mut current: Option<String> = None;
    for line in stdout.lines() {
        if line.starts_with("Row:") {
            if let Some(buf) = current.take() {
                push_parsed(&mut rows, &buf, projection);
            }
            current = Some(line.to_string());
        } else if let Some(buf) = current.as_mut() {
            buf.push('\n');
            buf.push_str(line);
        }
    }
    if let Some(buf) = current {
        push_parsed(&mut rows, &buf, projection);
    }

    // 没有数据行时：若 stderr 有内容（如 SecurityException 堆栈），作为错误抛出，
    // 避免静默返回 0 条；表本身为空(stderr 为空)时返回 Ok(空)
    if rows.is_empty() {
        let err = stderr.trim();
        if !err.is_empty() {
            return Err(err.to_string());
        }
    }
    Ok(rows)
}

fn push_parsed(rows: &mut Vec<HashMap<String, String>>, raw: &str, projection: &[&str]) {
    let rest = match raw.strip_prefix("Row:") {
        Some(r) => r,
        None => return,
    };
    let rest = rest.trim_start();
    // 跳过行号
    let row_content = match rest.find(' ') {
        Some(i) => rest[i..].trim_start(),
        None => rest.trim(),
    };
    let map = parse_row(row_content, projection);
    if !map.is_empty() {
        rows.push(map);
    }
}

/// 诊断：对指定 uri 执行 content query，返回原始 stdout+stderr（截断）
pub fn query_raw(adb: &PathBuf, serial: &str, uri: &str) -> Result<String, String> {
    let args: Vec<&str> = vec!["-s", serial, "shell", "content", "query", "--uri", uri];
    let (stdout, stderr, ok) = run_adb_raw(adb, &args)?;
    let mut combined = String::new();
    combined.push_str("[exit ok] ");
    combined.push_str(if ok { "true" } else { "false" });
    combined.push('\n');
    if !stdout.trim().is_empty() {
        combined.push_str("--- stdout ---\n");
        combined.push_str(&stdout);
        if combined.chars().filter(|c| *c == '\n').count() > 60 {
            // 截断过长输出
            combined = combined.chars().take(4000).collect::<String>();
            combined.push_str("\n...(已截断)\n");
        }
    }
    if !stderr.trim().is_empty() {
        combined.push_str("--- stderr ---\n");
        combined.push_str(&stderr);
    }
    Ok(combined)
}

/// 解析单行: 已知有序列名，按列名边界切片，兼容值中含逗号
fn parse_row(row: &str, keys: &[&str]) -> HashMap<String, String> {
    let mut entries: Vec<(String, usize, usize)> = Vec::new(); // (key, value_start, sep_start)
    for (i, key) in keys.iter().enumerate() {
        if i == 0 {
            let needle = format!("{}=", key);
            if let Some(p) = row.find(&needle) {
                entries.push((key.to_string(), p + needle.len(), p));
            }
        } else {
            let needle = format!(", {}=", key);
            if let Some(p) = row.find(&needle) {
                entries.push((key.to_string(), p + needle.len(), p));
            }
        }
    }
    entries.sort_by_key(|e| e.2);
    let mut map = HashMap::new();
    for i in 0..entries.len() {
        let (k, vstart, _) = &entries[i];
        let vend = if i + 1 < entries.len() {
            entries[i + 1].2
        } else {
            row.len()
        };
        if *vstart <= vend {
            let val = row[*vstart..vend].trim().to_string();
            map.insert(k.clone(), val);
        }
    }
    map
}
