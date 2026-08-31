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
    renderBackupDir(),
    renderDiagnostic(),
    el("div", { class: "panel hint-panel" },
      el("h3", {}, "使用提示"),
      el("ul", {},
        el("li", {}, "在手机「开发者选项」中开启「USB 调试」，并用数据线连接电脑。"),
        el("li", {}, "首次连接时手机会弹出授权提示，请允许本电脑调试。"),
        el("li", {}, "若无法识别设备，请在上方手动指定 platform-tools 目录中的 adb.exe 路径。"),
        el("li", {}, "短信/通话/通讯录读取依赖系统 content provider，部分厂商 ROM 可能限制访问。"),
        el("li", {}, "读不到数据时，用上方「数据访问诊断」查看 content provider 的原始返回/报错。"),
      ),
    ),
  );

  void loadStatus();
  return wrap;
}

function renderBackupDir(): HTMLElement {
  const panel = el("div", { class: "panel" });
  const input = el("input", { class: "input", type: "text", placeholder: "留空 = 默认(exe 同级 Back_File，不可写回退 AppData)" }) as HTMLInputElement;
  const resolved = el("div", { class: "hint-line" }, "加载中…");

  async function load() {
    try {
      const info = await api.backupDirInfo();
      input.value = info.configured;
      resolved.textContent = "实际备份目录：" + info.resolved;
    } catch (e) {
      resolved.textContent = "加载失败: " + String(e);
    }
  }

  panel.replaceChildren(
    el("div", { class: "panel-head" }, el("h3", {}, "备份目录")),
    el("div", { class: "form-row" },
      el("label", { class: "form-label" }, "自定义路径（可选，留空用默认）"),
      el("div", { class: "adb-row" },
        input,
        el("button", {
          class: "btn btn-ghost",
          onclick: async () => {
            const sel = await open({ multiple: false, directory: true });
            if (sel) input.value = typeof sel === "string" ? sel : sel[0];
          },
        }, "浏览…"),
        el("button", {
          class: "btn btn-primary",
          onclick: async () => {
            try {
              const r = await api.setBackupDir(input.value.trim());
              toast("已保存，备份目录：" + r, "success");
              load();
            } catch (e) {
              toast("保存失败: " + String(e), "error");
            }
          },
        }, "保存"),
        el("button", {
          class: "btn btn-ghost",
          onclick: async () => {
            try {
              const info = await api.backupDirInfo();
              void api.openFolder(info.resolved);
            } catch (e) {
              toast("打开失败: " + String(e), "error");
            }
          },
        }, "打开目录"),
      ),
    ),
    resolved,
    el("div", { class: "hint-line" }, "所有备份统一存此目录下：<设备名>/<时间>/<COMM|PHOTO|VIDEO>/。照片视频不再选目录，直接落到此处的 PHOTO/VIDEO。"),
  );
  void load();
  return panel;
}

function renderDiagnostic(): HTMLElement {
  const panel = el("div", { class: "panel" });
  const deviceSelect = el("select", { class: "input" }) as HTMLSelectElement;
  const out = el("pre", { class: "diag-output" }, "选择设备后点击下方按钮，查看 content provider 的原始返回（含报错）。");

  async function refreshDevices() {
    try {
      const list = (await api.listDevices()).filter((d) => d.state === "device");
      deviceSelect.replaceChildren(...(list.length
        ? list.map((d) => el("option", { value: d.serial }, `${d.model || d.serial} · ${d.serial}`))
        : [el("option", { value: "" }, "无可用设备")]));
    } catch {
      deviceSelect.replaceChildren(el("option", { value: "" }, "ADB 不可用"));
    }
  }

  const runTest = async (uri: string, label: string) => {
    const serial = deviceSelect.value;
    if (!serial) { toast("请先选择设备", "error"); return; }
    out.textContent = `正在查询 ${label} …`;
    try {
      const res = await api.diagnoseProvider(serial, uri);
      out.textContent = res || "(无输出)";
    } catch (e) {
      out.textContent = "错误: " + String(e);
    }
  };

  panel.replaceChildren(
    el("div", { class: "panel-head" },
      el("h3", {}, "数据访问诊断"),
      el("button", { class: "btn btn-ghost btn-sm", onclick: () => void refreshDevices() }, "刷新设备"),
    ),
    el("div", { class: "form-row" },
      el("label", { class: "form-label" }, "设备"),
      deviceSelect,
    ),
    el("div", { class: "diag-actions" },
      el("button", { class: "btn btn-ghost", onclick: () => runTest("content://sms", "短信") }, "测试短信"),
      el("button", { class: "btn btn-ghost", onclick: () => runTest("content://call_log/calls", "通话") }, "测试通话"),
      el("button", { class: "btn btn-ghost", onclick: () => runTest("content://com.android.contacts/data", "通讯录") }, "测试通讯录"),
    ),
    out,
  );
  void refreshDevices();
  return panel;
}
