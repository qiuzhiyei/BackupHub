// 与 Rust 后端模型对应的 TypeScript 类型

export interface AdbStatus {
  available: boolean;
  path: string;
  configured: string;
  version: string;
}

export interface DeviceStatus {
  serial: string;
  /** "device" | "unauthorized" | "offline" | "recovery" | ... */
  state: string;
  model: string;
  manufacturer: string;
  brand: string;
}

export interface DeviceRecord {
  serial: string;
  model: string;
  manufacturer: string;
  brand: string;
  custom_name: string;
  first_seen: number;
  last_backup: number;
  backup_count: number;
}

export interface BackupOptions {
  sms: boolean;
  calls: boolean;
  contacts: boolean;
}

export interface BackupSnapshot {
  id: string;
  device_serial: string;
  device_model: string;
  device_manufacturer: string;
  device_brand: string;
  custom_name: string;
  note: string;
  created_at: number;
  sms_count: number;
  call_count: number;
  contact_count: number;
}

export interface ProgressPayload {
  /** "sms" | "calls" | "contacts" | "saving" | "done" | "error" */
  stage: string;
  current: number;
  total: number;
  message: string;
}

export interface Sms {
  address: string;
  body: string;
  date: number;
  /** 1=接收 2=发送 */
  sms_type: number;
  /** 0=未读 1=已读 */
  read: number;
  thread_id: number;
  /** "sms" | "mms" */
  protocol: string;
}

export interface SmsThread {
  thread_id: number;
  address: string;
  /** 从通讯录匹配到的姓名 */
  name: string | null;
  last_body: string;
  last_date: number;
  count: number;
  unread: number;
}

export interface CallLog {
  number: string;
  duration: number;
  date: number;
  /** 1=呼入 2=呼出 3=未接 5=拒接 */
  call_type: number;
  name: string | null;
}

export interface Contact {
  id: string;
  name: string;
  phones: string[];
  emails: string[];
  notes: string;
}

export interface PageQuery {
  snapshot_id: string;
  page: number;
  page_size: number;
  search: string;
  date_from: number | null;
  date_to: number | null;
}

export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

// 相册（照片）
export interface PhotoFile {
  path: string;
  name: string;
  size: number;
  date: number;
}

export interface PhotoFolder {
  dir: string;
  name: string;
  count: number;
  total_size: number;
  files: PhotoFile[];
}

export interface PullSummary {
  folders: number;
  dest: string;
}
