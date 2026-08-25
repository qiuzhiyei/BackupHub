import { el, esc, fmtDate } from "../dom";
import { navigate } from "../router";
import * as api from "../api";
import type { DeviceRecord } from "../types";
import { emptyState, pageHeader } from "./components";

function recordCard(r: DeviceRecord): HTMLElement {
  return el("div", {
    class: "card record-card",
    onclick: () => navigate(`#/devices/${encodeURIComponent(r.serial)}`),
  },
    el("div", { class: "card-top" },
      el("div", { class: "card-icon" }, "📲"),
      el("div", { class: "card-info" },
        el("div", { class: "card-title" }, r.custom_name || r.model || "未命名设备"),
        el("div", { class: "card-sub" }, [r.brand, r.model].filter(Boolean).join(" · ") || "—"),
      ),
    ),
    el("div", { class: "card-meta" },
      el("div", { class: "meta-line" }, `制造商: ${esc(r.manufacturer || "—")}`),
      el("div", { class: "meta-line" }, `序列号: ${esc(r.serial)}`),
      el("div", { class: "meta-line" }, `最近备份: ${r.last_backup ? fmtDate(r.last_backup) : "尚未备份"}`),
    ),
    el("div", { class: "card-stats" },
      el("span", { class: "mini-stat" }, el("strong", {}, String(r.backup_count)), " 次备份"),
    ),
  );
}

export async function devicesGridView(): Promise<HTMLElement> {
  const grid = el("div", { class: "card-grid" }, emptyState("加载中…"));

  async function load() {
    try {
      const list = await api.listDeviceRecords();
      grid.replaceChildren(...(list.length
        ? list.map(recordCard)
        : [emptyState("还没有备份过的设备", "连接设备后去「新建备份」开始")]));
    } catch (e) {
      grid.replaceChildren(emptyState("加载失败", String(e)));
    }
  }

  void load();
  return el("div", { class: "page" },
    pageHeader("设备",
      el("span", { class: "section-hint" }, "点击卡片查看该设备的备份历史"),
    ),
    grid,
  );
}
