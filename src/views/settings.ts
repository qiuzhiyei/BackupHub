import { el, toast } from "../dom";
import * as api from "../api";
import type { AdbStatus } from "../types";
import { pageHeader, statChip } from "./components";
import { open } from "@tauri-apps/plugin-dialog";

export async function settingsView(): Promise<HTMLElement> {
  const wrap = el("div", { class: "page" });
  const statusBox = el("div", { class: "panel" }, "加载中…");

  async function loadStatus() {
    statusBox.replaceChildren(el("div", {}, "检测中…"));
    try {
      const s = await api.adbStatus();
      statusBox.replaceChildren(renderStatus(s));
    } catch (e) {
      statusBox.replaceChildren(el("div", { class: "empty-state error" }, "检测失败: " + String(e)));
    }
  }

  function renderStatus(s: AdbStatus): HTMLElement {
    return el("div", {},
      el("div", { class: `status-banner ${s.available ? "ok" : "err"}` },
        el("span", { class: "status-dot" }),
        el("span", {}, s.available ? "ADB 已就绪" : "ADB 未就绪"),
      ),
      el("div", { class: "device-summary" },
        statChip("版本", s.version || "—", "🏷️"),
        statChip("当前路径", s.path || "—", "📁"),
        statChip("用户配置", s.configured || "默认", "⚙️"),
      ),
      el("div", { class: "form-row" },
        el("label", { class: "form-label" }, "ADB 路径（可选）"),
        el("div", { class: "adb-row" },
          el("input", { class: "input adb-input", id: "adb-input", type: "text", value: s.configured, placeholder: "留空则自动检测；例如 D:\\platform-tools\\adb.exe" }),
          el("button", {
            class: "btn btn-ghost",
            onclick: async () => {
              const sel = await open({
                multiple: false,
                directory: false,
                filters: [{ name: "adb", extensions: ["exe", ""] }],
              });
              if (!sel) return;
              const path = typeof sel === "string" ? sel : sel[0];
              const inp = wrap.querySelector("#adb-input") as HTMLInputElement;
              if (path) inp.value = path;
            },
          }, "浏览…"),
          el("button", {
            class: "btn btn-primary",
            onclick: async () => {
              const inp = wrap.querySelector("#adb-input") as HTMLInputElement;
              const val = inp.value.trim();
              try {
                await api.setAdbPath(val);
                toast("已保存 ADB 路径", "success");
                loadStatus();
              } catch (e) {
                toast("保存失败: " + String(e), "error");
              }
            },
          }, "保存"),
        ),
      ),
      el("div", { class: "form-row" },
        el("button", {
          class: "btn btn-ghost",
          onclick: async () => {
            try {
              const list = await api.listDevices();
              toast(`检测到 ${list.length} 台设备`, list.length ? "success" : "info");
            } catch (e) {
              toast("检测失败: " + String(e), "error");
            }
          },
        }, "测试设备检测"),
      ),
    );
  }

  wrap.replaceChildren(
    pageHeader("设置"),
    statusBox,
    el("div", { class: "panel hint-panel" },
      el("h3", {}, "使用提示"),
      el("ul", {},
        el("li", {}, "在手机「开发者选项」中开启「USB 调试」，并用数据线连接电脑。"),
        el("li", {}, "首次连接时手机会弹出授权提示，请允许本电脑调试。"),
        el("li", {}, "若无法识别设备，请在上方手动指定 platform-tools 目录中的 adb.exe 路径。"),
        el("li", {}, "短信/通话/通讯录读取依赖系统 content provider，部分厂商 ROM 可能限制访问。"),
      ),
    ),
  );

  void loadStatus();
  return wrap;
}
