import { el, esc, fmtDate, toast } from "../dom";
import { navigate } from "../router";
import * as api from "../api";
import type { BackupSnapshot, DeviceRecord } from "../types";
import { emptyState, pageHeader, statChip } from "./components";
import { confirmDialog, promptDialog, chooseDialog } from "../modal";

export async function historyView(p: { params: Record<string, string> }): Promise<HTMLElement> {
  const serial = p.params.serial;
  const wrap = el("div", { class: "page" });

  const list = el("div", { class: "snapshot-list" }, emptyState("加载中…"));

  async function load() {
    let dev: DeviceRecord | undefined;
    let snaps: BackupSnapshot[] = [];
    try {
      dev = (await api.listDeviceRecords()).find((r) => r.serial === serial);
    } catch { /* ignore */ }
    try {
      snaps = await api.listSnapshots(serial);
    } catch (e) {
      list.replaceChildren(emptyState("加载失败", String(e)));
    }

    wrap.replaceChildren(
      pageHeader(dev?.custom_name || dev?.model || serial,
        el("button", { class: "btn btn-ghost", onclick: () => navigate("#/") }, "← 返回仪表盘"),
        el("button", { class: "btn btn-primary", onclick: () => navigate(`#/backup?serial=${encodeURIComponent(serial)}`) }, "＋ 新建备份"),
      ),
      el("div", { class: "device-summary" },
        statChip("型号", dev?.model || "—", "📟"),
        statChip("制造商", dev?.manufacturer || "—", "🏭"),
        statChip("序列号", serial, "🔑"),
        statChip("备份次数", dev?.backup_count ?? snaps.length, "🗂️"),
        statChip("最近备份", dev?.last_backup ? fmtDate(dev.last_backup) : "—", "🕐"),
      ),
      el("div", { class: "section-head" },
        el("h2", { class: "section-title" }, "备份历史"),
        el("button", {
          class: "btn btn-ghost btn-sm",
          onclick: async () => {
            const name = await promptDialog("请输入设备名称", dev?.custom_name || dev?.model || "", "编辑设备名称");
            if (name !== null) {
              await api.updateDeviceName(serial, name.trim());
              toast("已更新名称", "success");
              load();
            }
          },
        }, "✎ 编辑名称"),
      ),
      list,
    );

    if (snaps.length === 0) {
      list.replaceChildren(emptyState("暂无备份记录", "点击「新建备份」创建第一个快照"));
      return;
    }
    list.replaceChildren(...snaps.map((s) => snapshotRow(s, serial, load)));
  }

  void load();
  return wrap;
}

function snapshotRow(s: BackupSnapshot, serial: string, onReload: () => void): HTMLElement {
  const row = el("div", { class: "snapshot-row" },
    el("div", { class: "snap-time" },
      el("div", { class: "snap-date" }, fmtDate(s.created_at)),
      el("div", { class: "snap-name" }, s.custom_name || "—"),
    ),
    el("div", { class: "snap-stats" },
      el("span", { class: "mini-chip" }, `✉️ ${s.sms_count}`),
      el("span", { class: "mini-chip" }, `📞 ${s.call_count}`),
      el("span", { class: "mini-chip" }, `👥 ${s.contact_count}`),
    ),
    el("div", { class: "snap-note" }, s.note ? esc(s.note) : ""),
    el("div", { class: "snap-actions" },
      el("button", { class: "btn btn-sm btn-primary", onclick: () => navigate(`#/snapshot/${encodeURIComponent(s.id)}`) }, "查看"),
      el("button", {
        class: "btn btn-sm btn-ghost",
        onclick: async () => {
          const fmt = await chooseDialog("选择导出格式", [
            { label: "CSV", value: "csv" },
            { label: "JSON", value: "json" },
          ], "导出备份");
          if (!fmt) return;
          const dir = await api.pickExportDir();
          if (!dir) return;
          try {
            const out = await api.exportSnapshot(serial, s.id, fmt as "csv" | "json", dir);
            toast("已导出到: " + out, "success");
          } catch (e) {
            toast("导出失败: " + String(e), "error");
          }
        },
      }, "导出"),
      el("button", {
        class: "btn btn-sm btn-ghost",
        onclick: async () => {
          const note = await promptDialog("请输入备份备注", s.note, "编辑备注");
          if (note !== null) {
            await api.updateSnapshotNote(s.id, note.trim());
            toast("已更新备注", "success");
            onReload();
          }
        },
      }, "✎"),
      el("button", {
        class: "btn btn-sm btn-danger-ghost",
        onclick: async () => {
          if (await confirmDialog("确定删除此备份快照？此操作不可恢复。", "删除备份")) {
            try {
              await api.deleteSnapshot(s.id);
              toast("已删除", "success");
              onReload();
            } catch (e) {
              toast("删除失败: " + String(e), "error");
            }
          }
        },
      }, "删除"),
    ),
  );
  return row;
}
