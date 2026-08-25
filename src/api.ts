import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

import type {
  AdbStatus,
  BackupOptions,
  BackupSnapshot,
  CallLog,
  Contact,
  DeviceRecord,
  DeviceStatus,
  PageQuery,
  PageResult,
  ProgressPayload,
  Sms,
} from "./types";

export async function adbStatus(): Promise<AdbStatus> {
  return invoke<AdbStatus>("adb_status");
}

export async function setAdbPath(path: string): Promise<void> {
  await invoke("set_adb_path", { path });
}

export async function listDevices(): Promise<DeviceStatus[]> {
  return invoke<DeviceStatus[]>("list_devices");
}

export async function diagnoseProvider(serial: string, uri: string): Promise<string> {
  return invoke<string>("diagnose_provider", { serial, uri });
}

export async function listDeviceRecords(): Promise<DeviceRecord[]> {
  return invoke<DeviceRecord[]>("list_device_records");
}

export async function listSnapshots(serial?: string): Promise<BackupSnapshot[]> {
  return invoke<BackupSnapshot[]>("list_snapshots", { serial });
}

export async function getSnapshot(id: string): Promise<BackupSnapshot | null> {
  return invoke<BackupSnapshot | null>("get_snapshot", { id });
}

export async function backupStart(
  serial: string,
  options: BackupOptions,
  customName: string,
  note: string,
): Promise<BackupSnapshot> {
  return invoke<BackupSnapshot>("backup_start", {
    serial,
    options,
    customName,
    note,
  });
}

export async function deleteSnapshot(id: string): Promise<void> {
  await invoke("delete_snapshot", { id });
}

export async function updateDeviceName(serial: string, name: string): Promise<void> {
  await invoke("update_device_name", { serial, name });
}

export async function updateSnapshotNote(id: string, note: string): Promise<void> {
  await invoke("update_snapshot_note", { id, note });
}

export async function updateSnapshotCustomName(
  id: string,
  name: string,
): Promise<void> {
  await invoke("update_snapshot_custom_name", { id, name });
}

export async function querySms(query: PageQuery): Promise<PageResult<Sms>> {
  return invoke<PageResult<Sms>>("query_sms", { query });
}

export async function queryCalls(query: PageQuery): Promise<PageResult<CallLog>> {
  return invoke<PageResult<CallLog>>("query_calls", { query });
}

export async function queryContacts(query: PageQuery): Promise<PageResult<Contact>> {
  return invoke<PageResult<Contact>>("query_contacts", { query });
}

export async function pickExportDir(): Promise<string | null> {
  const sel = await open({ directory: true, multiple: false });
  if (!sel) return null;
  return typeof sel === "string" ? sel : sel[0];
}

export async function exportSnapshot(
  serial: string,
  id: string,
  format: "csv" | "json",
  dir: string,
): Promise<string> {
  return invoke<string>("export_snapshot", { serial, id, format, dir });
}

export function onBackupProgress(
  cb: (p: ProgressPayload) => void,
): Promise<UnlistenFn> {
  return listen<ProgressPayload>("backup://progress", (e) => cb(e.payload));
}
