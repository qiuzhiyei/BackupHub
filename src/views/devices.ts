import { el, esc, toast } from "../dom";
import { navigate } from "../router";
import * as api from "../api";
import type { DeviceStatus } from "../types";
import { emptyState, pageHeader, deviceLabel } from "./components";
import { getSelectedSerial, setSelectedSerial, setSelectedLabel } from "../state";

function deviceCard(d: DeviceStatus, selected: boolean): HTMLElement {
  const isWifi = d.serial.includes(":");
  return el("div", {
    class: `card record-card ${selected ? "active" : ""}`,
    onclick: () => {
      setSelectedSerial(d.serial);
      setSelectedLabel(deviceLabel(d));
      toast("已选择：" + deviceLabel(d), "success");
      navigate("#/backup");
    },
  },
    el("div", { class: "card-top" },
      el("div", { class: "card-icon" }, el("i", { "data-lucide": "smartphone" })),
      el("div", { class: "card-info" },
        el("div", { class: "card-title" }, deviceLabel(d)),
        el("div", { class: "card-sub" }, [d.brand, d.model].filter(Boolean).join(" · ") || "—"),
      ),
      el("span", { class: `badge ${d.state === "device" ? "badge-ok" : "badge-warn"}` },
        isWifi ? "WiFi" : "USB",
      ),
    ),
    el("div", { class: "card-meta" },
      el("div", { class: "meta-line" }, `序列号: ${esc(d.serial)}`),
      el("div", { class: "meta-line" }, `状态: ${d.state === "device" ? "就绪" : d.state}`),
    ),
    selected ? el("div", { class: "card-stats" },
      el("span", { class: "mini-stat" }, el("strong", {}, "✓"), " 当前选择"),
    ) : "",
  );
}

export async function devicesGridView(): Promise<HTMLElement> {
  const grid = el("div", { class: "card-grid" }, emptyState("加载中…"));

  async function load() {
    try {
      const list = await api.listDevices();
      const connected = list.filter((d) => d.state === "device");
      grid.replaceChildren(...(connected.length
        ? connected.map((d) => deviceCard(d, d.serial === getSelectedSerial()))
        : [emptyState("没有连接的设备", "USB 连接手机 或 点顶栏 WiFi 图标连接")]));
    } catch (e) {
      grid.replaceChildren(emptyState("加载失败", String(e)));
    }
  }

  void load();
  return el("div", { class: "page" },
    pageHeader("设备",
      el("button", { class: "btn btn-ghost btn-sm", onclick: () => void load() }, "刷新"),
    ),
    el("div", { class: "section-hint", style: { marginBottom: "12px" } },
      "点击设备卡片选择它，选中的设备在短信/照片/视频备份页自动使用。备份历史请到「查看数据」。",
    ),
    grid,
  );
}
