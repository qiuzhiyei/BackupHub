import { el } from "../dom";
import { navigate } from "../router";
import * as api from "../api";
import type { BackupSnapshot, DeviceRecord } from "../types";
import { emptyState, pageHeader, createSnapshotRow } from "./components";
import { toast } from "../dom";

export async function dataView(): Promise<HTMLElement> {
  const list = el("div", { class: "snapshot-list" }, emptyState("加载中…"));
  const filterSelect = el("select", { class: "input filter-device" }) as HTMLSelectElement;
  const searchInput = el("input", {
    class: "input filter-search",
    type: "search",
    placeholder: "按备注/设备名搜索…",
  }) as HTMLInputElement;

  let allSnaps: BackupSnapshot[] = [];
  let devices: DeviceRecord[] = [];
  let serialFilter = "";

  function nameOf(s: BackupSnapshot): string {
    const dev = devices.find((d) => d.serial === s.device_serial);
    return s.custom_name || dev?.custom_name || s.device_model || s.device_serial;
  }

  function render() {
    const kw = searchInput.value.trim().toLowerCase();
    const filtered = allSnaps
      .filter((s) => !serialFilter || s.device_serial === serialFilter)
      .filter((s) => {
        if (!kw) return true;
        return (
          (s.note || "").toLowerCase().includes(kw) ||
          nameOf(s).toLowerCase().includes(kw)
        );
      })
      .sort((a, b) => b.created_at - a.created_at);

    if (!filtered.length) {
      list.replaceChildren(emptyState("没有匹配的备份", "试试调整筛选或搜索条件"));
      return;
    }
    list.replaceChildren(...filtered.map((s) =>
      createSnapshotRow(s, {
        onReload: () => void load(),
        onOpen: (id) => navigate(`#/snapshot/${encodeURIComponent(id)}`),
        showDevice: true,
        deviceName: nameOf(s),
      }),
    ));
  }

  async function load() {
    try {
      devices = await api.listDeviceRecords();
    } catch {
      devices = [];
    }
    try {
      allSnaps = await api.listSnapshots();
    } catch (e) {
      list.replaceChildren(emptyState("加载失败", String(e)));
      return;
    }
    filterSelect.replaceChildren(
      el("option", { value: "" }, "全部设备"),
      ...devices.map((d) =>
        el("option", { value: d.serial }, d.custom_name || d.model || d.serial),
      ),
    );
    render();
  }

  filterSelect.addEventListener("change", () => {
    serialFilter = filterSelect.value;
    render();
  });
  searchInput.addEventListener("input", () => render());

  const importBtn = el("button", { class: "btn btn-primary" }, "⬆ 导入备份");
  importBtn.onclick = async () => {
    const dir = await api.pickExportDir();
    if (!dir) return;
    try {
      const snap = await api.importSnapshot(dir);
      toast(
        `已导入：${snap.custom_name || snap.device_model}（短信 ${snap.sms_count} · 通话 ${snap.call_count} · 联系人 ${snap.contact_count}）`,
        "success",
      );
      void load();
    } catch (e) {
      toast("导入失败: " + String(e), "error");
    }
  };

  void load();
  return el("div", { class: "page" },
    pageHeader("查看数据", importBtn),
    el("div", { class: "filter-bar" },
      el("div", { class: "filter-search-wrap" }, searchInput),
      el("span", { class: "filter-sep" }, "设备"),
      filterSelect,
    ),
    list,
  );
}
