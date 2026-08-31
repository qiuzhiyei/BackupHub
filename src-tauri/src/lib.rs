mod adb;
mod backup;
mod commands;
mod export;
mod media;
mod models;
mod storage;

use tauri::Manager;

use commands::AppState;
use storage::Storage;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("无法获取应用数据目录");
            let storage = Storage::new(&data_dir);
            app.manage(AppState { storage });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::adb_status,
            commands::set_adb_path,
            commands::list_devices,
            commands::diagnose_provider,
            commands::scan_photos,
            commands::pull_photos,
            commands::scan_videos,
            commands::pull_videos,
            commands::set_backup_dir,
            commands::backup_dir_info,
            commands::list_device_records,
            commands::list_snapshots,
            commands::get_snapshot,
            commands::backup_start,
            commands::delete_snapshot,
            commands::import_snapshot,
            commands::update_device_name,
            commands::update_snapshot_note,
            commands::update_snapshot_custom_name,
            commands::export_snapshot,
            commands::query_sms,
            commands::list_sms_threads,
            commands::get_sms_thread,
            commands::query_calls,
            commands::query_contacts,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
