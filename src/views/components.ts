import { el, esc, fmtDate, fmtDateShort, dateToMsStart, dateToMsEnd, toast } from "../dom";
import * as api from "../api";
import { confirmDialog, promptDialog } from "../modal";
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

/** 统一的设备显示名：品牌 型号（如 Xiaomi 23116PN5BC），缺则回退序列号 */
export function deviceLabel(d: { brand?: string; model?: string; serial: string }): string {
  const bm = [d.brand, d.model].filter(Boolean).join(" ").trim();
  return bm || d.serial;
}

/** 紧凑分页器：上一页/下一页 + 跳转到第几页（无数字条、无首页末页） */
export function createCompactPager(
  page: number,
  totalPages: number,
  total: number,
  onGo: (p: number) => void,
): HTMLElement {
  const tp = Math.max(1, totalPages);
  const cur = Math.min(Math.max(1, page), tp);
  const btn = (label: string, p: number, disabled: boolean, cls = "") =>
    el("button", {
      class: `btn btn-ghost cp-btn ${cls} ${disabled ? "disabled" : ""}`,
      onclick: () => !disabled && onGo(p),
    }, label);
  const input = el("input", {
    class: "input cp-input",
    type: "number",
    min: "1",
    max: String(tp),
    value: String(cur),
    title: "跳转到第几页",
  }) as HTMLInputElement;
  const go = () => {
    const n = parseInt(input.value, 10);
    if (!Number.isNaN(n) && n >= 1 && n <= tp) onGo(n);
    else input.value = String(cur);
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  return el("div", { class: "compact-pager" },
    el("span", { class: "cp-info" }, `共 ${total} · ${cur}/${tp} 页`),
    el("div", { class: "cp-group" },
      btn("‹ 上一页", cur - 1, cur <= 1, "cp-lg"),
      btn("下一页 ›", cur + 1, cur >= tp, "cp-lg"),
    ),
    el("div", { class: "cp-jump" },
      "第", input, "页",
      el("button", { class: "btn btn-primary cp-btn cp-go", onclick: go }, "跳"),
    ),
  );
}

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
