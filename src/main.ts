import { el } from "./dom";
import { startRouter } from "./router";
import * as api from "./api";
import type { ProgressPayload } from "./types";

function buildShell(): void {
  const app = el("div", { class: "app" },
    el("aside", { class: "sidebar" },
      el("div", { class: "brand" },
        el("div", { class: "brand-logo" }, "📱"),
        el("div", { class: "brand-text" },
          el("div", { class: "brand-title" }, "BackupHub"),
          el("div", { class: "brand-sub" }, "安卓数据备份助手"),
        ),
      ),
      el("nav", { class: "nav" },
        el("a", { class: "nav-link", href: "#/" }, el("span", { class: "nav-ico" }, "📊"), "仪表盘"),
        el("a", { class: "nav-link", href: "#/backup" }, el("span", { class: "nav-ico" }, "💾"), "短信/通话/通讯录备份"),
        el("a", { class: "nav-link", href: "#/photos" }, el("span", { class: "nav-ico" }, "🖼️"), "照片备份"),
        el("a", { class: "nav-link", href: "#/data" }, el("span", { class: "nav-ico" }, "📂"), "查看数据"),
        el("a", { class: "nav-link", href: "#/devices" }, el("span", { class: "nav-ico" }, "📱"), "设备"),
        el("a", { class: "nav-link", href: "#/settings" }, el("span", { class: "nav-ico" }, "⚙️"), "设置"),
      ),
      el("div", { class: "sidebar-foot" }, "v0.1.0 · qiuzhiye"),
    ),
    el("main", { class: "main" },
      el("header", { class: "topbar" },
        el("div", { class: "topbar-title" }, "BackupHub"),
        el("div", { class: "topbar-task", style: { display: "none" } },
          el("span", { class: "tt-ico" }, "⏳"),
          el("span", { class: "tt-text" }, ""),
          el("div", { class: "tt-bar" }, el("div", { class: "tt-fill" })),
          el("button", { class: "btn btn-sm btn-ghost tt-open", style: { display: "none" } }, "打开"),
        ),
        el("div", { class: "topbar-status" }, "ADB: 检测中…"),
      ),
      el("section", { id: "view" }),
    ),
  );
  document.body.replaceChildren(app);
  document.body.appendChild(el("div", { id: "toast-host" }));
}

// 顶栏通用任务进度徽标：照片拉取 / 短信备份 等都走它，切页不丢
function setupTaskProgress(): void {
  const task = document.querySelector(".topbar-task") as HTMLElement | null;
  if (!task) return;
  const text = task.querySelector(".tt-text") as HTMLElement;
  const fill = task.querySelector(".tt-fill") as HTMLElement;
  const openBtn = task.querySelector(".tt-open") as HTMLButtonElement;
  let hideT: number | undefined;
  let lastDest = "";

  const onP = (p: ProgressPayload) => {
    task.style.display = "";
    openBtn.style.display = "none";
    const pct = p.total > 0
      ? Math.round((p.current / Math.max(p.total, 1)) * 100)
      : p.stage === "done" ? 100 : 0;
    fill.style.width = `${pct}%`;
    if (p.stage === "done") {
      text.textContent = "✓ " + p.message;
      const m = p.message.match(/到\s+(.+)$/);
      if (m) {
        lastDest = m[1];
        openBtn.style.display = "";
        openBtn.onclick = () => void api.openFolder(lastDest);
      }
      window.clearTimeout(hideT);
      hideT = window.setTimeout(() => { task.style.display = "none"; }, 15000);
    } else if (p.stage === "error") {
      text.textContent = "⚠ " + p.message;
      window.clearTimeout(hideT);
      hideT = window.setTimeout(() => { task.style.display = "none"; }, 8000);
    } else {
      text.textContent = p.message;
    }
  };
  void api.onMediaProgress(onP);
  void api.onBackupProgress(onP);
}

window.addEventListener("DOMContentLoaded", async () => {
  buildShell();
  startRouter();
  setupTaskProgress();
  const status = document.querySelector(".topbar-status");
  if (status) {
    try {
      const s = await api.adbStatus();
      status.textContent = s.available ? "ADB 已就绪" : "ADB 未就绪";
      status.classList.add(s.available ? "ok" : "err");
    } catch {
      status.textContent = "ADB 状态未知";
    }
  }
});
