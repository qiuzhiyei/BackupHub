import { el, fmtDate, esc } from "../dom";
import { navigate } from "../router";
import * as api from "../api";
import type { DeviceRecord, DeviceStatus } from "../types";
import { emptyState, pageHeader } from "./components";

let pollTimer: number | undefined;

function stateBadge(state: string): HTMLElement {
  const map: Record<string, { t: string; c: string }> = {
    device: { t: "已连接", c: "badge-ok" },
    unauthorized: { t: "未授权", c: "badge-warn" },
    offline: { t: "离线", c: "badge-err" },
    recovery: { t: "恢复模式", c: "badge-warn" },
  };
  const s = map[state] || { t: state || "未知", c: "badge-err" };
  return el("span", { class: `badge ${s.c}` }, s.t);
}

function liveDeviceCard(d: DeviceStatus): HTMLElement {
  const isReady = d.state === "device";
  const card = el("div", { class: "card live-card" },
    el("div", { class: "card-top" },
      el("div", { class: "card-icon" }, "📱"),
      el("div", { class: "card-info" },
        el("div", { class: "card-title" }, d.model || "未知型号"),
        el("div", { class: "card-sub" }, [d.brand, d.manufacturer].filter(Boolean).join(" · ") || "—"),
      ),
      stateBadge(d.state),
    ),
    el("div", { class: "card-meta" },
      el("span", { class: "meta-line" }, `序列号: ${esc(d.serial || "—")}`),
    ),
  );
  if (!isReady) {
    const tip =
      d.state === "unauthorized"
        ? "请在手机弹窗中允许 USB 调试授权，然后重新检测"
        : "设备未就绪，请检查 USB 连接与调试模式";
    card.appendChild(el("div", { class: "live-tip warn" }, tip));
  } else {
    card.appendChild(
      el("div", { class: "card-actions" },
        el("button", {
          class: "btn btn-primary",
          onclick: () => navigate(`#/backup?serial=${encodeURIComponent(d.serial)}`),
        }, "新建备份"),
      ),
    );
  }
  return card;
}

function recordCard(r: DeviceRecord): HTMLElement {
  return el("div", { class: "card record-card", onclick: () => navigate(`#/devices/${encodeURIComponent(r.serial)}`) },
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

export async function devicesView(): Promise<HTMLElement> {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }

  const liveWrap = el("div", { class: "card-grid", id: "live-grid" }, emptyState("检测中…"));
  const recordsWrap = el("div", { class: "card-grid", id: "records-grid" }, emptyState("加载中…"));

  async function refreshLive() {
    try {
      const list = await api.listDevices();
      liveWrap.replaceChildren(...(list.length
        ? list.map(liveDeviceCard)
        : [emptyState("未检测到连接的设备", "请用 USB 连接安卓手机并开启 USB 调试")]));
    } catch (e) {
      liveWrap.replaceChildren(emptyState("ADB 不可用", String(e)));
    }
  }

  async function refreshRecords() {
    try {
      const list = await api.listDeviceRecords();
      recordsWrap.replaceChildren(...(list.length
        ? list.map(recordCard)
        : [emptyState("还没有备份记录", "连接设备后点击「新建备份」开始")]));
    } catch (e) {
      recordsWrap.replaceChildren(emptyState("加载失败", String(e)));
    }
  }

  pollTimer = window.setInterval(refreshLive, 4000);
  void refreshLive();
  void refreshRecords();

  return el("div", { class: "page" },
    pageHeader("仪表盘",
      el("button", { class: "btn btn-primary", onclick: () => navigate("#/backup") }, "＋ 新建备份"),
    ),
    el("section", { class: "section" },
      el("div", { class: "section-head" },
        el("h2", { class: "section-title" }, "当前连接设备"),
        el("button", { class: "btn btn-ghost btn-sm", onclick: () => void refreshLive() }, "刷新"),
      ),
      liveWrap,
    ),
    el("section", { class: "section" },
      el("div", { class: "section-head" },
        el("h2", { class: "section-title" }, "已备份设备"),
        el("span", { class: "section-hint" }, "点击卡片查看该设备的备份历史"),
      ),
      recordsWrap,
    ),
  );
}
