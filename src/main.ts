import { el, toast } from "./dom";
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
        el("a", { class: "nav-link", href: "#/videos" }, el("span", { class: "nav-ico" }, "🎬"), "视频备份"),
        el("a", { class: "nav-link", href: "#/data" }, el("span", { class: "nav-ico" }, "📂"), "查看数据"),
        el("a", { class: "nav-link", href: "#/devices" }, el("span", { class: "nav-ico" }, "📱"), "设备"),
        el("a", { class: "nav-link", href: "#/settings" }, el("span", { class: "nav-ico" }, "⚙️"), "设置"),
      ),
      el("div", { class: "sidebar-foot" }, "v0.1.0 · qiuzhiye"),
    ),
    el("main", { class: "main" },
      el("header", { class: "topbar" },
        el("div", { class: "topbar-title" }, "BackupHub"),
        el("div", { class: "topbar-status" }, "ADB: 检测中…"),
      ),
      el("section", { id: "view" }),
      el("div", { class: "taskbar", style: { display: "none" } }),
    ),
  );
  document.body.replaceChildren(app);
  document.body.appendChild(el("div", { id: "toast-host" }));
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
    if (g === "scan") return "🔍";
    if (g === "pull-photo") return "🖼️";
    if (g === "pull-video") return "🎬";
    if (g === "backup") return "💾";
    return "⏳";
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
        el("span", { class: "tb-icon" }, iconFor(g)),
        el("span", { class: "tb-text" }, p.message),
        el("div", { class: "tb-bar" }, el("div", { class: "tb-fill" })),
      );
      taskbar.appendChild(row);
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
