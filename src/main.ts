import { el } from "./dom";
import { startRouter } from "./router";
import { adbStatus } from "./api";

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
        el("a", { class: "nav-link", href: "#/backup" }, el("span", { class: "nav-ico" }, "💾"), "新建备份"),
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
    ),
  );
  document.body.replaceChildren(app);
  document.body.appendChild(el("div", { id: "toast-host" }));
}

window.addEventListener("DOMContentLoaded", async () => {
  buildShell();
  startRouter();
  // 延迟加载一次 adb 状态显示
  const status = document.querySelector(".topbar-status");
  if (status) {
    try {
      const s = await adbStatus();
      status.textContent = s.available ? `ADB 已就绪` : "ADB 未就绪";
      status.classList.add(s.available ? "ok" : "err");
    } catch {
      status.textContent = "ADB 状态未知";
    }
  }
});
