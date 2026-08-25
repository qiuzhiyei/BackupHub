import { el, esc, fmtDate, fmtDateShort, dateToMsStart, dateToMsEnd, toast } from "../dom";
import * as api from "../api";
import { confirmDialog, promptDialog, chooseDialog } from "../modal";
import type { BackupSnapshot } from "../types";

export interface Filters {
  search: string;
  dateFrom: number | null;
  dateTo: number | null;
}

export interface FilterBarHandles {
  element: HTMLElement;
  getFilters: () => Filters;
  setOnApply: (cb: () => void) => void;
}

/** 创建带搜索 + 日期范围 + 应用/重置的筛选栏 */
export function createFilterBar(withDateRange: boolean): FilterBarHandles {
  const search = el("input", {
    class: "input filter-search",
    type: "search",
    placeholder: "关键词搜索…",
  }) as HTMLInputElement;

  let onApply = () => {};

  const apply = () => onApply();
  search.addEventListener("input", () => {
    // 回车或失焦时应用，输入过程即时应用
    apply();
  });

  let dateFromInput: HTMLInputElement | null = null;
  let dateToInput: HTMLInputElement | null = null;

  const children: (HTMLElement | string)[] = [
    el("div", { class: "filter-search-wrap" }, search),
  ];

  if (withDateRange) {
    dateFromInput = el("input", {
      class: "input filter-date",
      type: "date",
      title: "开始日期",
    }) as HTMLInputElement;
    dateToInput = el("input", {
      class: "input filter-date",
      type: "date",
      title: "结束日期",
    }) as HTMLInputElement;
    children.push(
      el("span", { class: "filter-sep" }, "至"),
      dateFromInput,
      dateToInput,
    );
    dateFromInput.addEventListener("change", apply);
    dateToInput.addEventListener("change", apply);
  }

  children.push(
    el("button", {
      class: "btn btn-ghost",
      onclick: () => {
        search.value = "";
        if (dateFromInput) dateFromInput.value = "";
        if (dateToInput) dateToInput.value = "";
        apply();
      },
    }, "重置"),
  );

  const bar = el("div", { class: "filter-bar" }, ...children);

  return {
    element: bar,
    getFilters: () => ({
      search: search.value.trim(),
      dateFrom: dateFromInput ? dateToMsStart(dateFromInput.value) : null,
      dateTo: dateToInput ? dateToMsEnd(dateToInput.value) : null,
    }),
    setOnApply: (cb) => {
      onApply = cb;
    },
  };
}

/** 分页组件 */
export function createPagination(
  page: number,
  total: number,
  pageSize: number,
  onGo: (p: number) => void,
): HTMLElement {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const cur = Math.min(Math.max(1, page), totalPages);

  const wrap = el("div", { class: "pagination" });

  wrap.appendChild(
    el("span", { class: "page-info" }, `共 ${total} 条 · ${cur}/${totalPages} 页`),
  );

  const btn = (label: string, p: number, disabled: boolean, cls = "") => {
    return el("button", {
      class: `btn btn-page ${cls} ${disabled ? "disabled" : ""}`,
      onclick: () => !disabled && onGo(p),
    }, label);
  };
  wrap.appendChild(btn("‹", cur - 1, cur <= 1));

  // 页码窗口
  const pages: number[] = [];
  const span = 4;
  const start = Math.max(1, cur - span);
  const end = Math.min(totalPages, cur + span);
  if (start > 1) pages.push(1);
  if (start > 2) pages.push(-1); // 省略
  for (let i = start; i <= end; i++) pages.push(i);
  if (end < totalPages - 1) pages.push(-1);
  if (end < totalPages) pages.push(totalPages);

  for (const p of pages) {
    if (p === -1) {
      wrap.appendChild(el("span", { class: "page-ellipsis" }, "…"));
    } else {
      wrap.appendChild(
        btn(String(p), p, false, p === cur ? "active" : ""),
      );
    }
  }
  wrap.appendChild(btn("›", cur + 1, cur >= totalPages));
  return wrap;
}

/** 空状态 */
export function emptyState(text: string, sub = ""): HTMLElement {
  return el("div", { class: "empty-state" },
    el("div", { class: "empty-ico" }, "📭"),
    el("div", { class: "empty-text" }, text),
    sub ? el("div", { class: "empty-sub" }, sub) : "",
  );
}

/** 页面标题栏 */
export function pageHeader(title: string, ...actions: (Node | string)[]): HTMLElement {
  return el("div", { class: "page-head" },
    el("h1", { class: "page-title" }, title),
    el("div", { class: "page-actions" }, ...actions),
  );
}

/** 通用信息标签 */
export function statChip(label: string, value: string | number, ico = ""): HTMLElement {
  return el("div", { class: "stat-chip" },
    ico ? el("span", { class: "stat-ico" }, ico) : "",
    el("div", { class: "stat-body" },
      el("div", { class: "stat-val" }, String(value)),
      el("div", { class: "stat-label" }, label),
    ),
  );
}

export { fmtDateShort };

/** 快照行：查看/导出/编辑/删除，供「查看数据」与「设备历史」复用 */
export function createSnapshotRow(
  s: BackupSnapshot,
  opts: {
    onReload: () => void;
    onOpen: (id: string) => void;
    showDevice?: boolean;
    deviceName?: string;
  },
): HTMLElement {
  const cols: HTMLElement[] = [
    el("div", { class: "snap-time" },
      el("div", { class: "snap-date" }, fmtDate(s.created_at)),
      opts.showDevice
        ? el("div", { class: "snap-name" }, opts.deviceName || s.custom_name || "—")
        : el("div", { class: "snap-name" }, s.custom_name || "—"),
    ),
    el("div", { class: "snap-stats" },
      el("span", { class: "mini-chip" }, `✉️ ${s.sms_count}`),
      el("span", { class: "mini-chip" }, `📞 ${s.call_count}`),
      el("span", { class: "mini-chip" }, `👥 ${s.contact_count}`),
    ),
    el("div", { class: "snap-note" }, s.note ? esc(s.note) : ""),
    el("div", { class: "snap-actions" },
      el("button", {
        class: "btn btn-sm btn-primary",
        onclick: () => opts.onOpen(s.id),
      }, "查看"),
      el("button", {
        class: "btn btn-sm btn-ghost",
        onclick: async () => {
          const fmt = await chooseDialog("选择导出格式", [
            { label: "CSV", value: "csv" },
            { label: "JSON", value: "json" },
          ], "导出备份");
          if (!fmt) return;
          const dir = await api.pickExportDir();
          if (!dir) return;
          try {
            const out = await api.exportSnapshot(s.device_serial, s.id, fmt as "csv" | "json", dir);
            toast("已导出到: " + out, "success");
          } catch (e) {
            toast("导出失败: " + String(e), "error");
          }
        },
      }, "导出"),
      el("button", {
        class: "btn btn-sm btn-ghost",
        onclick: async () => {
          const note = await promptDialog("请输入备份备注", s.note, "编辑备注");
          if (note !== null) {
            await api.updateSnapshotNote(s.id, note.trim());
            toast("已更新备注", "success");
            opts.onReload();
          }
        },
      }, "✎"),
      el("button", {
        class: "btn btn-sm btn-danger-ghost",
        onclick: async () => {
          if (await confirmDialog("确定删除此备份快照？此操作不可恢复。", "删除备份")) {
            try {
              await api.deleteSnapshot(s.id);
              toast("已删除", "success");
              opts.onReload();
            } catch (e) {
              toast("删除失败: " + String(e), "error");
            }
          }
        },
      }, "删除"),
    ),
  ];
  return el("div", { class: "snapshot-row" }, ...cols);
}

/** 看板柱状条：单行 label + 比例条 + 数值 */
export function barRow(
  label: string,
  value: number,
  max: number,
  colorClass = "bar-primary",
): HTMLElement {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return el("div", { class: "bar-row" },
    el("div", { class: "bar-label" }, label),
    el("div", { class: "bar-track" },
      el("div", { class: `bar-fill ${colorClass}`, style: { width: `${pct}%` } }),
    ),
    el("div", { class: "bar-value" }, String(value)),
  );
}
