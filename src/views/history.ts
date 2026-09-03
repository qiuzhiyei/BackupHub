import { el, fmtDate, toast } from "../dom";
import { navigate } from "../router";
import * as api from "../api";
import type { BackupSnapshot, DeviceRecord } from "../types";
import { emptyState, pageHeader, statChip, createSnapshotRow, deviceLabel } from "./components";
import { promptDialog } from "../modal";

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
      pageHeader(dev?.custom_name || (dev ? deviceLabel(dev) : serial),
        el("button", { class: "btn btn-ghost", onclick: () => navigate("#/devices") }, "← 返回设备"),
        el("button", { class: "btn btn-primary", onclick: () => navigate(`#/backup?serial=${encodeURIComponent(serial)}`) }, "＋ 新建备份"),
      ),
      el("div", { class: "device-summary" },
        statChip("型号", dev?.model || "—", "smartphone"),
        statChip("制造商", dev?.manufacturer || "—", "factory"),
        statChip("序列号", serial, "key"),
        statChip("备份次数", dev?.backup_count ?? snaps.length, "layers"),
        statChip("最近备份", dev?.last_backup ? fmtDate(dev.last_backup) : "—", "clock"),
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
    list.replaceChildren(...snaps.map((s) =>
      createSnapshotRow(s, {
        onReload: () => void load(),
        onOpen: (id) => navigate(`#/snapshot/${encodeURIComponent(id)}`),
      }),
    ));
  }

  void load();
  return wrap;
}
