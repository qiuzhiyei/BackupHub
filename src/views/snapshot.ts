import { el, esc, fmtDate, fmtDuration, toast } from "../dom";
import { navigate } from "../router";
import * as api from "../api";
import type { BackupSnapshot, CallLog, Contact, PageResult, Sms } from "../types";
import { createFilterBar, createPagination, emptyState, pageHeader, statChip } from "./components";
import { promptDialog, chooseDialog } from "../modal";

type Tab = "sms" | "calls" | "contacts";
const PAGE_SIZE = 50;

export async function snapshotView(p: { params: Record<string, string> }): Promise<HTMLElement> {
  const id = p.params.id;
  let snapshot: BackupSnapshot | null = null;

  const wrap = el("div", { class: "page" });
  wrap.appendChild(el("div", {}, emptyState("加载中…")));

  try {
    snapshot = await api.getSnapshot(id);
  } catch (e) {
    wrap.replaceChildren(emptyState("加载失败", String(e)));
    return wrap;
  }
  if (!snapshot) {
    wrap.replaceChildren(emptyState("快照不存在"));
    return wrap;
  }

  const s = snapshot;
  let tab: Tab = "sms";
  let page = 1;
  let filters = { search: "", dateFrom: null as number | null, dateTo: null as number | null };
  let debounceT: number | undefined;

  const tabsEl = el("div", { class: "tabs" },
    tabBtn("sms", "短信", `✉️ ${s.sms_count}`, s.sms_count > 0),
    tabBtn("calls", "通话记录", `📞 ${s.call_count}`, s.call_count > 0),
    tabBtn("contacts", "通讯录", `👥 ${s.contact_count}`, s.contact_count > 0),
  );

  const toolbarEl = el("div", { class: "tab-toolbar" });
  const contentEl = el("div", { class: "tab-content" });
  const pageEl = el("div", { class: "tab-pagination" });

  const exportBtn = el("button", { class: "btn btn-ghost" }, "导出");
  exportBtn.onclick = async () => {
    const fmt = await chooseDialog("选择导出格式", [
      { label: "CSV", value: "csv" },
      { label: "JSON", value: "json" },
    ], "导出快照");
    if (!fmt) return;
    const dir = await api.pickExportDir();
    if (!dir) return;
    try {
      const out = await api.exportSnapshot(s.device_serial, s.id, fmt as "csv" | "json", dir);
      toast("已导出到: " + out, "success");
    } catch (e) {
      toast("导出失败: " + String(e), "error");
    }
  };

  wrap.replaceChildren(
    pageHeader(s.custom_name || s.device_model || "备份快照",
      el("button", { class: "btn btn-ghost", onclick: () => navigate(`#/devices/${encodeURIComponent(s.device_serial)}`) }, "← 备份历史"),
      exportBtn,
    ),
    el("div", { class: "device-summary" },
      statChip("设备型号", s.device_model || "—", "📟"),
      statChip("制造商", s.device_manufacturer || "—", "🏭"),
      statChip("设备序列号", s.device_serial, "🔑"),
      statChip("备份时间", fmtDate(s.created_at), "🕐"),
      el("div", { class: "stat-chip stat-edit", title: "编辑名称" },
        el("span", { class: "stat-ico" }, "🏷️"),
        el("div", { class: "stat-body" },
          el("div", { class: "stat-val" }, "编辑名称"),
          el("div", { class: "stat-label" }, s.custom_name || "点击设置"),
        ),
      ),
    ),
    tabsEl,
    toolbarEl,
    contentEl,
    pageEl,
  );

  // 编辑名称
  wrap.querySelector(".stat-edit")?.addEventListener("click", async () => {
    const name = await promptDialog("请输入设备名称", s.custom_name || s.device_model || "", "编辑设备名称");
    if (name !== null) {
      await api.updateSnapshotCustomName(s.id, name.trim());
      toast("已更新名称", "success");
      snapshotView(p).then((n) => { wrap.replaceWith(n); });
    }
  });

  function tabBtn(t: Tab, label: string, count: string, enabled: boolean): HTMLElement {
    const btn = el("button", {
      class: `tab-btn ${tab === t ? "active" : ""} ${enabled ? "" : "disabled"}`,
      onclick: () => switchTab(t),
    },
      el("span", { class: "tab-label" }, label),
      el("span", { class: "tab-count" }, count),
    );
    return btn;
  }

  function switchTab(t: Tab) {
    if (t === tab) return;
    tab = t;
    page = 1;
    tabsEl.querySelectorAll(".tab-btn").forEach((b, i) => {
      b.classList.toggle("active", (["sms", "calls", "contacts"] as Tab[])[i] === t);
    });
    renderToolbar();
    void fetchData();
  }

  function renderToolbar() {
    toolbarEl.replaceChildren();
    const withDate = tab !== "contacts";
    const bar = createFilterBar(withDate);
    bar.setOnApply(() => {
      filters = bar.getFilters();
      page = 1;
      if (debounceT) clearTimeout(debounceT);
      debounceT = window.setTimeout(() => void fetchData(), 220);
    });
    toolbarEl.appendChild(bar.element);
  }

  async function fetchData() {
    const q = { snapshot_id: s.id, page, page_size: PAGE_SIZE, search: filters.search, date_from: filters.dateFrom, date_to: filters.dateTo };
    contentEl.replaceChildren(el("div", { class: "loading-row" }, "加载中…"));
    pageEl.replaceChildren();
    try {
      if (tab === "sms") {
        const res = await api.querySms(q);
        renderSms(res);
      } else if (tab === "calls") {
        const res = await api.queryCalls(q);
        renderCalls(res);
      } else {
        const res = await api.queryContacts(q);
        renderContacts(res);
      }
    } catch (e) {
      contentEl.replaceChildren(emptyState("加载失败", String(e)));
    }
  }

  function renderSms(res: PageResult<Sms>) {
    if (!res.items.length) {
      contentEl.replaceChildren(emptyState("没有短信记录", "尝试调整筛选条件"));
      return;
    }
    const list = el("div", { class: "sms-list" },
      ...res.items.map((m) => smsBubble(m)),
    );
    contentEl.replaceChildren(list);
    renderPagination(res);
  }

  function smsBubble(m: Sms): HTMLElement {
    const sent = m.sms_type === 2;
    return el("div", { class: `sms-row ${sent ? "sent" : "recv"}` },
      el("div", { class: "bubble" },
        el("div", { class: "bubble-head" },
          el("span", { class: "bubble-addr" }, esc(m.address || (sent ? "我" : "未知号码"))),
          el("span", { class: "bubble-tags" },
            m.protocol === "mms" ? el("span", { class: "tag tag-mms" }, "MMS") : "",
            m.read === 0 ? el("span", { class: "tag tag-unread" }, "未读") : "",
          ),
        ),
        el("div", { class: "bubble-body" }, esc(m.body)),
        el("div", { class: "bubble-time" }, fmtDate(m.date)),
      ),
    );
  }

  function renderCalls(res: PageResult<CallLog>) {
    if (!res.items.length) {
      contentEl.replaceChildren(emptyState("没有通话记录"));
      return;
    }
    const map: Record<number, { icon: string; label: string; cls: string }> = {
      1: { icon: "↙️", label: "呼入", cls: "call-in" },
      2: { icon: "↗️", label: "呼出", cls: "call-out" },
      3: { icon: "✕", label: "未接", cls: "call-miss" },
      5: { icon: "🚫", label: "拒接", cls: "call-rej" },
    };
    const info = map[res.items[0].call_type] || { icon: "•", label: "其他", cls: "" };
    const list = el("div", { class: "call-list" },
      ...res.items.map((c) => {
        const t = map[c.call_type] || info;
        return el("div", { class: `call-row ${t.cls}` },
          el("div", { class: `call-ico ${t.cls}` }, t.icon),
          el("div", { class: "call-main" },
            el("div", { class: "call-name" }, esc(c.name || c.number || "未知号码")),
            el("div", { class: "call-sub" }, c.name ? esc(c.number) : t.label),
          ),
          el("div", { class: "call-type" }, t.label),
          el("div", { class: "call-duration" }, c.call_type === 3 || c.call_type === 5 ? "—" : fmtDuration(c.duration)),
          el("div", { class: "call-time" }, fmtDate(c.date)),
        );
      }),
    );
    contentEl.replaceChildren(list);
    renderPagination(res);
  }

  function renderContacts(res: PageResult<Contact>) {
    if (!res.items.length) {
      contentEl.replaceChildren(emptyState("没有联系人"));
      return;
    }
    const list = el("div", { class: "contact-grid" },
      ...res.items.map((c) => {
        const avatar = el("div", { class: "contact-avatar" }, esc((c.name || "?").slice(0, 1).toUpperCase()));
        const phones = c.phones.length
          ? c.phones.map((p) => el("div", { class: "contact-phone" }, el("span", {}, "📞"), el("span", {}, esc(p))))
          : [el("div", { class: "contact-phone empty" }, "无电话号码")];
        const emails = c.emails.length
          ? c.emails.map((e) => el("div", { class: "contact-mail" }, el("span", {}, "✉️"), el("span", {}, esc(e))))
          : [];
        return el("div", { class: "contact-card" },
          avatar,
          el("div", { class: "contact-body" },
            el("div", { class: "contact-name" }, esc(c.name || "未命名")),
            el("div", { class: "contact-phones" }, ...phones),
            emails.length ? el("div", { class: "contact-mails" }, ...emails) : "",
            c.notes ? el("div", { class: "contact-note" }, esc(c.notes)) : "",
          ),
        );
      }),
    );
    contentEl.replaceChildren(list);
    renderPagination(res);
  }

  function renderPagination(res: PageResult<unknown>) {
    if (res.total === 0) { pageEl.replaceChildren(); return; }
    pageEl.replaceChildren(createPagination(page, res.total, PAGE_SIZE, (p) => {
      page = p;
      void fetchData();
    }));
  }

  renderToolbar();
  void fetchData();
  return wrap;
}
