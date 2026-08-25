use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;

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

        // 对已授权设备，通过 getprop 补全 manufacturer/brand
        let mut manufacturer = String::new();
        let mut brand_final = brand;
        if state == "device" {
            if let Ok(m) = run_adb(adb, &["-s", &serial, "shell", "getprop", "ro.product.manufacturer"]) {
                manufacturer = m.trim().to_string();
            }
            if let Ok(b) = run_adb(adb, &["-s", &serial, "shell", "getprop", "ro.product.brand"]) {
                let b = b.trim().to_string();
                if !b.is_empty() {
                    brand_final = b;
                }
            }
            if model.is_empty() {
                if let Ok(m) = run_adb(adb, &["-s", &serial, "shell", "getprop", "ro.product.model"]) {
                    model = m.trim().to_string();
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

/// 查询 content provider，返回每行 key=>value 的 map 列表
/// projection 为有序列名，解析时按此顺序定位列边界，能正确处理含逗号的值
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
    let out = run_adb(adb, &arg_refs)?;

    let mut rows = Vec::new();
    for line in out.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("Row:") {
            // 跳过行号
            let rest = rest.trim_start();
            let row_content = match rest.find(' ') {
                Some(i) => &rest[i..].trim_start(),
                None => rest.trim(),
            };
            let map = parse_row(row_content, projection);
            if !map.is_empty() {
                rows.push(map);
            }
        }
    }
    Ok(rows)
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
