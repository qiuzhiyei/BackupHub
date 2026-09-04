import { el, toast } from "./dom";
import { startRouter, refreshCurrent } from "./router";
import { renderIcons } from "./icons";
import * as api from "./api";
import type { ProgressPayload } from "./types";
import { deviceLabel } from "./views/components";
import { setSelectedSerial, setSelectedLabel } from "./state";

const THEME_KEY = "backuphub-theme";

function applyTheme(theme: "light" | "dark"): void {
  document.documentElement.dataset.theme = theme;
}
function initTheme(): void {
  const saved = (localStorage.getItem(THEME_KEY) as "light" | "dark" | null) ?? "light";
  applyTheme(saved);
}

function buildShell(): void {
  const themeBtn = el("button", { class: "topbar-icon-btn", title: "切换深/浅色" },
    el("i", { class: "nav-ico", "data-lucide": "sun-moon" }),
  );
  themeBtn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(next);
    localStorage.setItem(THEME_KEY, next);
    renderIcons();
  });
  const wifiBtn = el("button", { class: "topbar-icon-btn", title: "WiFi 连接" },
    el("i", { class: "nav-ico", "data-lucide": "wifi" }),
  );
  wifiBtn.addEventListener("click", () => void openWifiDialog());
  const usbBtn = el("button", { class: "topbar-icon-btn", title: "USB 状态" },
    el("i", { class: "nav-ico", "data-lucide": "usb" }),
  );
  const app = el("div", { class: "app" },
    el("aside", { class: "sidebar" },
      el("div", { class: "brand" },
        el("div", { class: "brand-logo" }, el("i", { "data-lucide": "hard-drive-download" })),
        el("div", { class: "brand-text" },
          el("div", { class: "brand-title" }, "BackupHub"),
          el("div", { class: "brand-sub" }, "安卓数据备份助手"),
        ),
      ),
      el("nav", { class: "nav" },
        el("a", { class: "nav-link", href: "#/" }, el("span", { class: "nav-ico", "data-lucide": "layout-dashboard" }), "仪表盘"),
        el("a", { class: "nav-link", href: "#/backup" }, el("span", { class: "nav-ico", "data-lucide": "messages-square" }), "短信/通话/通讯录备份"),
        el("a", { class: "nav-link", href: "#/photos" }, el("span", { class: "nav-ico", "data-lucide": "image" }), "照片备份"),
        el("a", { class: "nav-link", href: "#/videos" }, el("span", { class: "nav-ico", "data-lucide": "video" }), "视频备份"),
        el("a", { class: "nav-link", href: "#/data" }, el("span", { class: "nav-ico", "data-lucide": "database" }), "查看数据"),
        el("a", { class: "nav-link", href: "#/devices" }, el("span", { class: "nav-ico", "data-lucide": "smartphone" }), "设备"),
        el("a", { class: "nav-link", href: "#/settings" }, el("span", { class: "nav-ico", "data-lucide": "settings" }), "设置"),
      ),
      el("div", { class: "sidebar-foot" }, "v0.1.0 · qiuzhiye"),
    ),
    el("main", { class: "main" },
      el("header", { class: "topbar" },
        el("div", { class: "topbar-title" }, "BackupHub"),
        el("div", { class: "topbar-right" },
          usbBtn,
          wifiBtn,
          themeBtn,
          el("div", { class: "topbar-status" }, "ADB: 检测中…"),
        ),
      ),
      el("section", { id: "view" }),
      el("div", { class: "taskbar", style: { display: "none" } }),
    ),
  );
  document.body.replaceChildren(app);
  document.body.appendChild(el("div", { id: "toast-host" }));
}

/** WiFi 连接弹窗：已连接设备 + 扫描按钮 + 手动输入 */
async function openWifiDialog(): Promise<void> {
  const content = el("div", {},
    el("div", { class: "modal-title" }, "WiFi 连接"),
    el("div", { class: "wifi-scan-section" },
      el("div", { class: "wifi-section-title" }, "已连接 / 可发现的设备"),
      el("div", { id: "wifi-device-list", class: "wifi-saved-list" }, el("div", { class: "wifi-empty" }, "加载中…")),
      el("button", { id: "wifi-rescan", class: "btn btn-ghost btn-sm", style: { marginTop: "8px" } }, "重新扫描"),
    ),
    el("div", { class: "wifi-sep" }),
    el("div", { class: "wifi-section-title" }, "手动输入"),
    el("div", { class: "wifi-input-row" },
      el("input", { id: "wifi-addr", class: "input", placeholder: "192.168.1.100:43171", style: { flex: "1" } }),
      el("button", { id: "wifi-connect-btn", class: "btn btn-primary" }, "连接"),
    ),
    el("div", { class: "modal-actions" },
      el("button", { class: "btn btn-ghost", id: "wifi-close" }, "关闭"),
    ),
  );

  const host = document.getElementById("modal-host") || (() => {
    const h = el("div", { id: "modal-host" });
    document.body.appendChild(h);
    return h;
  })();
  const backdrop = el("div", { class: "modal-backdrop" },
    el("div", { class: "modal wifi-modal", onclick: (e: Event) => e.stopPropagation() }, content),
  );
  backdrop.addEventListener("click", () => backdrop.remove());
  host.appendChild(backdrop);

  document.getElementById("wifi-close")?.addEventListener("click", () => backdrop.remove());

  // 手动输入
  const input = document.getElementById("wifi-addr") as HTMLInputElement | null;
  const connBtn = document.getElementById("wifi-connect-btn");
  async function doManualConnect(): Promise<void> {
    const addr = input?.value.trim() || "";
    if (!addr) { toast("请输入 IP:端口", "error"); return; }
    if (connBtn) { connBtn.textContent = "连接中…"; (connBtn as HTMLButtonElement).disabled = true; }
    try {
      const name = await api.wifiConnect(addr);
      setSelectedSerial(addr);
      setSelectedLabel(name);
      toast("已连接：" + name, "success");
      backdrop.remove();
      void refreshTopbarStatus();
      void refreshCurrent();
    } catch (e) {
      toast("连接失败：" + String(e), "error");
    } finally {
      if (connBtn) { connBtn.textContent = "连接"; (connBtn as HTMLButtonElement).disabled = false; }
    }
  }
  connBtn?.addEventListener("click", () => void doManualConnect());
  input?.addEventListener("keydown", (e) => { if (e.key === "Enter") void doManualConnect(); });

  // 加载设备列表
  const listEl = document.getElementById("wifi-device-list");
  async function loadList(): Promise<void> {
    if (!listEl) return;
    listEl.replaceChildren(el("div", { class: "wifi-empty" }, "加载中…"));
    try {
      const allDevices = await api.listDevices();
      // 已连接的 WiFi 设备（serial 含 : 且 state=device）
      const connectedWifi = allDevices.filter((d) => d.state === "device" && d.serial.includes(":"));
      // mDNS 发现的（不连接，只列出）
      const mdns = await api.wifiMdnsScan();
      // 去重：mDNS 中 IP 已在 connectedWifi 里的跳过
      const connectedIPs = connectedWifi.map((d) => d.serial.split(":")[0]);
      const newDevices = mdns.filter((d) => !connectedIPs.includes(d.addr.split(":")[0]));

      const rows: HTMLElement[] = [];
      for (const d of connectedWifi) {
        rows.push(el("div", { class: "wifi-saved-row wifi-connected" },
          el("span", { class: "wifi-saved-name" }, deviceLabel(d)),
          el("span", { class: "badge badge-ok" }, "已连接"),
        ));
      }
      for (const d of newDevices) {
        rows.push(el("div", { class: "wifi-saved-row" },
          el("span", { class: "wifi-saved-name" }, d.serial),
          el("span", { class: "wifi-saved-addr" }, d.addr),
          el("button", { class: "btn btn-primary btn-sm", onclick: async () => {
            const btn = event?.target as HTMLButtonElement;
            if (btn) { btn.textContent = "连接中…"; btn.disabled = true; }
            try {
              const name = await api.wifiConnect(d.addr);
              setSelectedSerial(d.addr);
              setSelectedLabel(d.serial);
              toast("已连接：" + name, "success");
              backdrop.remove();
              void refreshTopbarStatus();
              void refreshCurrent();
            } catch (e) {
              toast("连接失败：" + String(e), "error");
              if (btn) { btn.textContent = "连接"; btn.disabled = false; }
            }
          } }, "连接"),
        ));
      }
      if (!rows.length) {
        listEl.replaceChildren(el("div", { class: "wifi-empty" }, "没有发现设备\n请确认手机无线调试已打开"));
      } else {
        listEl.replaceChildren(...rows);
      }
    } catch {
      listEl.replaceChildren(el("div", { class: "wifi-empty" }, "加载失败"));
    }
  }
  document.getElementById("wifi-rescan")?.addEventListener("click", () => void loadList());
  void loadList();
  setTimeout(() => input?.focus(), 50);
}

// 底部状态栏：每项操作一行，并发时不冲突
interface TaskEntry { row: HTMLElement; done: boolean; }

function setupTaskProgress(): void {
  const taskbar = document.querySelector(".taskbar") as HTMLElement | null;
  if (!taskbar) return;
  const tasks = new Map<string, TaskEntry>();
  let lastGroup = "";

  const groupOf = (stage: string): string => {
    if (stage === "scan") return "scan";
    if (stage === "photo") return "pull-photo";
    if (stage === "video") return "pull-video";
    if (["sms", "calls", "contacts", "saving", "start"].includes(stage)) return "backup";
    return "";
  };
  const iconFor = (g: string): string => {
    if (g === "scan") return "search";
    if (g === "pull-photo") return "image";
    if (g === "pull-video") return "video";
    if (g === "backup") return "database";
    return "loader";
  };
  const refresh = () => { taskbar.style.display = tasks.size > 0 ? "" : "none"; };

  const setText = (row: HTMLElement, t: string) => {
    const el2 = row.querySelector(".tb-text"); if (el2) el2.textContent = t;
  };
  const setFill = (row: HTMLElement, pct: number) => {
    const f = row.querySelector(".tb-fill"); if (f) (f as HTMLElement).style.width = `${pct}%`;
  };

  const onP = (p: ProgressPayload) => {
    if (p.stage === "done") {
      let g = "";
      if (p.message.includes("扫描")) g = "scan";
      else if (p.message.includes("拉取")) g = lastGroup;
      else g = "backup";
      const t = g ? tasks.get(g) : undefined;
      if (t) {
        t.done = true;
        setText(t.row, "✓ " + p.message);
        setFill(t.row, 100);
        t.row.classList.add("task-done");
        const m = p.message.match(/到\s+(.+)$/);
        if (m) {
          const dest = m[1];
          const btn = el("button", { class: "btn btn-sm btn-ghost tb-open" }, "打开");
          btn.onclick = async () => {
            try {
              await api.openFolder(dest);
            } catch (e) {
              toast("打开文件夹失败: " + String(e), "error");
            }
          };
          t.row.appendChild(btn);
        }
        setTimeout(() => { tasks.delete(g); t.row.remove(); refresh(); }, 8000);
      }
      refresh();
      return;
    }
    if (p.stage === "error") {
      const t = lastGroup ? tasks.get(lastGroup) : undefined;
      if (t) {
        setText(t.row, "⚠ " + p.message);
        t.row.classList.add("task-error");
        setTimeout(() => { if (lastGroup) { tasks.delete(lastGroup); t.row.remove(); refresh(); } }, 8000);
      }
      refresh();
      return;
    }
    const g = groupOf(p.stage);
    if (!g) return;
    lastGroup = g;
    let t = tasks.get(g);
    if (!t) {
      const row = el("div", { class: "taskbar-row" },
        el("span", { class: "tb-icon", "data-lucide": iconFor(g) }),
        el("span", { class: "tb-text" }, p.message),
        el("div", { class: "tb-bar" }, el("div", { class: "tb-fill" })),
      );
      taskbar.appendChild(row);
      renderIcons();
      t = { row, done: false };
      tasks.set(g, t);
    }
    setText(t.row, p.message);
    const pct = p.total > 0 ? Math.round((p.current / Math.max(p.total, 1)) * 100) : 0;
    setFill(t.row, pct);
    refresh();
  };
  void api.onMediaProgress(onP);
  void api.onBackupProgress(onP);
}

window.addEventListener("DOMContentLoaded", async () => {
  initTheme();
  buildShell();
  renderIcons();
  startRouter();
  setupTaskProgress();
  await refreshTopbarStatus();
});

/** 刷新顶栏状态：USB/WiFi 图标变绿 + 状态文字显示设备名 */
export async function refreshTopbarStatus(): Promise<void> {
  const status = document.querySelector(".topbar-status") as HTMLElement | null;
  const wifiIcon = document.querySelector('[title="WiFi 连接"]') as HTMLElement | null;
  const usbIcon = document.querySelector('[title="USB 状态"]') as HTMLElement | null;
  if (!status) return;
  try {
    const devices = await api.listDevices();
    const connected = devices.filter((d) => d.state === "device");
    const hasUsb = connected.some((d) => !d.serial.includes(":"));
    const hasWifi = connected.some((d) => d.serial.includes(":"));
    if (wifiIcon) wifiIcon.classList.toggle("connected", hasWifi);
    if (usbIcon) usbIcon.classList.toggle("connected", hasUsb);
    if (connected.length) {
      status.textContent = connected.map((d) => deviceLabel(d)).join(" · ");
      status.className = "topbar-status ok";
    } else {
      const s = await api.adbStatus();
      status.textContent = s.available ? "无设备" : "ADB 未就绪";
      status.className = `topbar-status ${s.available ? "" : "err"}`;
    }
  } catch {
    status.textContent = "ADB 状态未知";
    status.className = "topbar-status";
    wifiIcon?.classList.remove("connected");
    usbIcon?.classList.remove("connected");
  }
}
