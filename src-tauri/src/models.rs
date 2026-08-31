use serde::{Deserialize, Serialize};

/// ADB 实时检测到的设备状态
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceStatus {
    pub serial: String,
    /// "device" | "unauthorized" | "offline" | "recovery" | ...
    pub state: String,
    pub model: String,
    pub manufacturer: String,
    pub brand: String,
}

/// 设备注册表条目（已备份过的设备，可自定义名称）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceRecord {
    pub serial: String,
    pub model: String,
    pub manufacturer: String,
    pub brand: String,
    pub custom_name: String,
    pub first_seen: i64,
    pub last_backup: i64,
    pub backup_count: u64,
}

/// 一条短信
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Sms {
    pub address: String,
    pub body: String,
    /// 毫秒时间戳
    pub date: i64,
    /// 1 = 接收, 2 = 发送
    pub sms_type: i32,
    /// 0 = 未读, 1 = 已读
    pub read: i32,
    /// 会话 id，用于对话气泡分组
    pub thread_id: i64,
    /// "sms" | "mms"
    pub protocol: String,
}

/// 一条通话记录
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallLog {
    pub number: String,
    /// 秒
    pub duration: i64,
    /// 毫秒时间戳
    pub date: i64,
    /// 1=呼入 2=呼出 3=未接 5=拒接
    pub call_type: i32,
    pub name: Option<String>,
}

/// 一个联系人（含多号码）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Contact {
    pub id: String,
    pub name: String,
    pub phones: Vec<String>,
    pub emails: Vec<String>,
    pub notes: String,
}

/// 备份快照元数据
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupSnapshot {
    pub id: String,
    /// 备份类型："COMM"（短信/通话/通讯录） | "PHOTO"（照片） | "VIDEO"（视频）
    /// 旧 index.json 无此字段时按 "COMM" 反序列化，保证向后兼容
    #[serde(default = "default_kind")]
    pub kind: String,
    pub device_serial: String,
    pub device_model: String,
    pub device_manufacturer: String,
    pub device_brand: String,
    pub custom_name: String,
    pub note: String,
    /// 毫秒时间戳
    pub created_at: i64,
    pub sms_count: usize,
    pub call_count: usize,
    pub contact_count: usize,
}

/// BackupSnapshot.kind 的反序列化默认值：旧索引无 kind 字段时视为 COMM 备份
fn default_kind() -> String {
    "COMM".into()
}

/// 备份过程中前端需要选择的数据类型
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupOptions {
    pub sms: bool,
    pub calls: bool,
    pub contacts: bool,
}

impl Default for BackupOptions {
    fn default() -> Self {
        Self {
            sms: true,
            calls: true,
            contacts: true,
        }
    }
}

/// 进度事件载荷
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProgressPayload {
    /// "sms" | "calls" | "contacts" | "done" | "error"
    pub stage: String,
    pub current: usize,
    pub total: usize,
    pub message: String,
}

/// 短信会话（按 thread_id 聚合）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SmsThread {
    pub thread_id: i64,
    pub address: String,
    /// 从通讯录匹配到的姓名（无则为 None）
    pub name: Option<String>,
    pub last_body: String,
    pub last_date: i64,
    pub count: usize,
    pub unread: usize,
}

/// 分页查询参数
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageQuery {
    pub snapshot_id: String,
    pub page: usize,
    pub page_size: usize,
    pub search: String,
    pub date_from: Option<i64>,
    pub date_to: Option<i64>,
}

/// 分页结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageResult<T> {
    pub items: Vec<T>,
    pub total: usize,
    pub page: usize,
    pub page_size: usize,
}

// ---------- 相册（照片） ----------
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PhotoFile {
    pub path: String,
    pub name: String,
    pub size: i64,
    /// 毫秒时间戳
    pub date: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PhotoFolder {
    /// 设备上的目录绝对路径
    pub dir: String,
    /// 目录最后一段名
    pub name: String,
    /// 所属应用名（Android/data|media|obb/<pkg> 解析；非应用目录为 None）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
    pub count: usize,
    pub total_size: i64,
    pub files: Vec<PhotoFile>,
}
