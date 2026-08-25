import { el, esc, fmtDate } from "../dom";
import { navigate } from "../router";
import * as api from "../api";
import type { BackupSnapshot, DeviceRecord, DeviceStatus } from "../types";
import { emptyState, pageHeader, statChip, barRow, deviceLabel } from "./components";

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

function recentRow(s: BackupSnapshot): HTMLElement {
  const name = s.custom_name || s.device_model || "—";
  return el("div", { class: "recent-row", onclick: () => navigate(`#/snapshot/${encodeURIComponent(s.id)}`) },
    el("div", { class: "recent-main" },
      el("div", { class: "recent-name" }, esc(name)),
      el("div", { class: "recent-time" }, fmtDate(s.created_at)),
    ),
    el("div", { class: "recent-chips" },
      el("span", { class: "mini-chip" }, `✉️ ${s.sms_count}`),
      el("span", { class: "mini-chip" }, `📞 ${s.call_count}`),
      el("span", { class: "mini-chip" }, `👥 ${s.contact_count}`),
    ),
  );
}

function compactLiveCard(d: DeviceStatus): HTMLElement {
  const ready = d.state === "device";
  return el("div", { class: "card live-card compact" },
    el("div", { class: "card-top" },
      el("div", { class: "card-icon sm" }, "📱"),
      el("div", { class: "card-info" },
        el("div", { class: "card-title" }, deviceLabel(d)),
        el("div", { class: "card-sub" }, esc(d.serial)),
      ),
      stateBadge(d.state),
    ),
    ready
      ? el("button", {
          class: "btn btn-sm btn-primary",
          onclick: () => navigate(`#/backup?serial=${encodeURIComponent(d.serial)}`),
        }, "新建备份")
      : el("div", { class: "live-tip warn sm" },
          d.state === "unauthorized" ? "请在手机上允许调试授权" : "设备未就绪"),
  );
}

export async function dashboardView(): Promise<HTMLElement> {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }

  const statsRow = el("div", { class: "device-summary" });
  const recentWrap = el("div", { class: "recent-list" }, emptyState("加载中…"));
  const compWrap = el("div", { class: "bar-list" });
  const devBarsWrap = el("div", { class: "bar-list" });
  const liveWrap = el("div", { class: "card-grid live-grid" }, emptyState("检测中…"));

  async function load() {
    let devices: DeviceRecord[] = [];
    let snaps: BackupSnapshot[] = [];
    try {
      devices = await api.listDeviceRecords();
    } catch { /* ignore */ }
    try {
      snaps = await api.listSnapshots();
    } catch { /* ignore */ }

    const smsT = snaps.reduce((a, s) => a + s.sms_count, 0);
    const callT = snaps.reduce((a, s) => a + s.call_count, 0);
    const contactT = snaps.reduce((a, s) => a + s.contact_count, 0);

    statsRow.replaceChildren(
      statChip("已备份设备", devices.length, "📱"),
      statChip("备份快照", snaps.length, "🗂️"),
      statChip("短信总数", smsT, "✉️"),
      statChip("通话总数", callT, "📞"),
      statChip("联系人总数", contactT, "👥"),
    );

    const recent = [...snaps].sort((a, b) => b.created_at - a.created_at).slice(0, 6);
    recentWrap.replaceChildren(...(recent.length
      ? recent.map(recentRow)
      : [emptyState("暂无备份", "去「新建备份」创建第一个快照")]));

    const compMax = Math.max(smsT, callT, contactT, 1);
    compWrap.replaceChildren(
      barRow("短信", smsT, compMax, "bar-sms"),
      barRow("通话", callT, compMax, "bar-call"),
      barRow("联系人", contactT, compMax, "bar-contact"),
    );

    const devCounts = devices
      .map((d) => ({
        name: d.custom_name || d.model || d.serial,
        count: snaps.filter((s) => s.device_serial === d.serial).length,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);
    const dmax = Math.max(1, ...devCounts.map((d) => d.count));
    devBarsWrap.replaceChildren(...(devCounts.length
      ? devCounts.map((d) => barRow(d.name, d.count, dmax, "bar-primary"))
      : [emptyState("无设备")]));
  }

  async function refreshLive() {
    try {
      const list = await api.listDevices();
      liveWrap.replaceChildren(...(list.length
        ? list.map(compactLiveCard)
        : [emptyState("未检测到设备", "用 USB 连接手机并开启调试")]));
    } catch {
      liveWrap.replaceChildren(emptyState("ADB 不可用", "请在设置中配置 adb 路径"));
    }
  }

  pollTimer = window.setInterval(refreshLive, 4000);
  void load();
  void refreshLive();

  return el("div", { class: "page" },
    pageHeader("仪表盘"),
    statsRow,
    el("div", { class: "board-grid" },
      el("section", { class: "panel board-panel" },
        el("div", { class: "panel-head" },
          el("h3", {}, "最近备份"),
          el("span", { class: "panel-link", onclick: () => navigate("#/data") }, "查看全部 →"),
        ),
        recentWrap,
      ),
      el("div", { class: "board-col" },
        el("section", { class: "panel board-panel-sm" },
          el("div", { class: "panel-head" }, el("h3", {}, "数据构成")),
          compWrap,
        ),
        el("section", { class: "panel board-panel-sm" },
          el("div", { class: "panel-head" },
            el("h3", {}, "各设备快照数"),
            el("span", { class: "panel-link", onclick: () => navigate("#/devices") }, "管理 →"),
          ),
          devBarsWrap,
        ),
      ),
    ),
    el("section", { class: "panel" },
      el("div", { class: "panel-head" },
        el("h3", {}, "当前连接设备"),
        el("button", { class: "btn btn-ghost btn-sm", onclick: () => void refreshLive() }, "刷新"),
      ),
      liveWrap,
    ),
  );
}
