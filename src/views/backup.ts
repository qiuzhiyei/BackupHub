import { el, esc, toast } from "../dom";
import { navigate } from "../router";
import * as api from "../api";
import type { BackupOptions, DeviceStatus, DeviceRecord, ProgressPayload } from "../types";
import { emptyState, pageHeader } from "./components";

export async function backupView(p: { query: URLSearchParams }): Promise<HTMLElement> {
  const preSerial = p.query.get("serial") || "";

  const wrap = el("div", { class: "page" },
    pageHeader("新建备份"),
    el("div", { class: "backup-layout" },
      el("div", { class: "panel", id: "picker-panel" }, emptyState("正在检测设备…")),
      el("div", { class: "panel", id: "form-panel" }),
    ),
    el("div", { class: "panel", id: "progress-panel", style: { display: "none" } }),
  );

  let ready: DeviceStatus[] = [];
  let records: DeviceRecord[] = [];
  let selectedSerial = preSerial;

  const pickerPanel = wrap.querySelector("#picker-panel") as HTMLElement;
  const formPanel = wrap.querySelector("#form-panel") as HTMLElement;
  const progressPanel = wrap.querySelector("#progress-panel") as HTMLElement;

  async function loadAll() {
    try {
      ready = (await api.listDevices()).filter((d) => d.state === "device");
    } catch (e) {
      ready = [];
      toast("ADB 不可用: " + String(e), "error");
    }
    try {
      records = await api.listDeviceRecords();
    } catch {
      records = [];
    }
    if (selectedSerial && !ready.some((d) => d.serial === selectedSerial)) {
      selectedSerial = "";
    }
    renderPicker();
    renderForm();
  }

  function renderPicker() {
    pickerPanel.replaceChildren(
      el("div", { class: "panel-head" }, el("h3", {}, "1. 选择设备")),
      ...(ready.length
        ? ready.map((d) => devicePickerCard(d, d.serial === selectedSerial))
        : [emptyState("没有可用的设备", "请用 USB 连接手机并允许调试授权")]),
    );
  }

  function devicePickerCard(d: DeviceStatus, active: boolean): HTMLElement {
    return el("div", {
      class: `picker-card ${active ? "active" : ""}`,
      onclick: () => {
        selectedSerial = d.serial;
        renderPicker();
        renderForm();
      },
    },
      el("div", { class: "card-top" },
        el("div", { class: "card-icon" }, "📱"),
        el("div", { class: "card-info" },
          el("div", { class: "card-title" }, d.model || "未知型号"),
          el("div", { class: "card-sub" }, [d.brand, d.manufacturer].filter(Boolean).join(" · ")),
        ),
        el("span", { class: "badge badge-ok" }, "就绪"),
      ),
      el("div", { class: "card-meta" }, el("span", { class: "meta-line" }, `序列号: ${esc(d.serial)}`)),
    );
  }

  function renderForm() {
    if (!selectedSerial) {
      formPanel.replaceChildren(
        el("div", { class: "panel-head" }, el("h3", {}, "2. 备份设置")),
        emptyState("请先选择设备"),
      );
      return;
    }
    const dev = ready.find((d) => d.serial === selectedSerial)!;
    const rec = records.find((r) => r.serial === selectedSerial);
    const defaultName = rec?.custom_name || `${dev.brand || ""} ${dev.model || ""}`.trim() || dev.serial;

    const nameInput = el("input", {
      class: "input",
      type: "text",
      value: defaultName,
      placeholder: "设备自定义名称",
    }) as HTMLInputElement;
    const noteInput = el("textarea", {
      class: "input textarea",
      placeholder: "备份备注（可选）",
    }) as HTMLTextAreaElement;

    const optChip = (label: string, ico: string) => {
      const cb = el("input", { type: "checkbox", checked: true }) as HTMLInputElement;
      return el("label", { class: "opt-chip" },
        cb,
        el("span", { class: "opt-ico" }, ico),
        label,
      );
    };
    const smsOpt = optChip("短信", "✉️");
    const callOpt = optChip("通话记录", "📞");
    const contactOpt = optChip("通讯录", "👥");

    const startBtn = el("button", { class: "btn btn-primary btn-lg" }, "开始备份");

    startBtn.onclick = async () => {
      const options: BackupOptions = {
        sms: (smsOpt.querySelector("input") as HTMLInputElement).checked,
        calls: (callOpt.querySelector("input") as HTMLInputElement).checked,
        contacts: (contactOpt.querySelector("input") as HTMLInputElement).checked,
      };
      if (!options.sms && !options.calls && !options.contacts) {
        toast("请至少选择一种数据类型", "error");
        return;
      }
      const name = nameInput.value.trim();
      const note = noteInput.value.trim();
      startBtn.setAttribute("disabled", "true");
      startBtn.textContent = "备份进行中…";

      progressPanel.style.display = "";
      renderProgress({ stage: "start", current: 0, total: 0, message: "正在初始化…" });

      let unlisten: Awaited<ReturnType<typeof api.onBackupProgress>> | null = null;
      try {
        unlisten = await api.onBackupProgress((pp) => renderProgress(pp));
        const snap = await api.backupStart(selectedSerial, options, name, note);
        toast(`备份完成：短信 ${snap.sms_count} · 通话 ${snap.call_count} · 联系人 ${snap.contact_count}`, "success");
        await new Promise((r) => setTimeout(r, 600));
        navigate(`#/snapshot/${encodeURIComponent(snap.id)}`);
      } catch (e) {
        toast("备份失败: " + String(e), "error");
        startBtn.removeAttribute("disabled");
        startBtn.textContent = "开始备份";
        progressPanel.style.display = "none";
      } finally {
        if (unlisten) (await unlisten)();
      }
    };

    formPanel.replaceChildren(
      el("div", { class: "panel-head" }, el("h3", {}, "2. 备份设置")),
      el("div", { class: "form-row" },
        el("label", { class: "form-label" }, "设备名称"),
        nameInput,
      ),
      el("div", { class: "form-row" },
        el("label", { class: "form-label" }, "备份备注"),
        noteInput,
      ),
      el("div", { class: "form-row" },
        el("label", { class: "form-label" }, "备份数据类型"),
        el("div", { class: "opt-group" }, smsOpt, callOpt, contactOpt),
      ),
      el("div", { class: "form-row" }, startBtn),
    );
  }

  function renderProgress(pp: ProgressPayload) {
    const total = pp.total || 0;
    const pct = total > 0 ? Math.round((pp.current / total) * 100) : 0;
    const stageLabel: Record<string, string> = {
      sms: "短信", calls: "通话记录", contacts: "通讯录",
      saving: "写入", done: "完成", error: "错误", start: "初始化",
    };
    const label = stageLabel[pp.stage] || pp.stage;
    const bar = el("div", { class: "progress-bar" },
      el("div", { class: "progress-fill", style: { width: `${pct}%` } }),
    );
    progressPanel.replaceChildren(
      el("div", { class: "panel-head" }, el("h3", {}, "备份进度")),
      el("div", { class: "progress-stage" },
        el("span", { class: `badge ${pp.stage === "done" ? "badge-ok" : pp.stage === "error" ? "badge-err" : "badge-info"}` }, label),
        el("span", { class: "progress-count" }, total > 0 ? `${pp.current} / ${total}` : "扫描中…"),
      ),
      bar,
      el("div", { class: "progress-msg" }, pp.message),
    );
  }

  void loadAll();
  return wrap;
}
