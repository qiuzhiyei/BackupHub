import { el, esc, fmtDate, fmtDuration, toast } from "../dom";
import { navigate } from "../router";
import * as api from "../api";
import type { BackupSnapshot, CallLog, Contact, PageResult, Sms, SmsThread } from "../types";
import { createFilterBar, createPagination, emptyState, pageHeader, statChip } from "./components";
import { promptDialog, chooseDialog } from "../modal";

type Tab = "sms" | "calls" | "contacts";
const PAGE_SIZE = 50;
const THREAD_PAGE = 30;
const MSG_PAGE = 50;

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

  // SMS 会话视图状态
  let threadPage = 1;
  let threadSearch = "";
  let selectedThreadId: number | null = null;
  let lastThreads: SmsThread[] = [];
  let msgPage = 1;
  let msgTotalPages = 1;
  let msgLoading = false;
  let suppressScroll = false;
  let smsThreadListEl: HTMLElement;
  let smsThreadPagerEl: HTMLElement;
  let smsMsgHeadEl: HTMLElement;
  let smsMsgListEl: HTMLElement;

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

  wrap.querySelector(".stat-edit")?.addEventListener("click", async () => {
    const name = await promptDialog("请输入设备名称", s.custom_name || s.device_model || "", "编辑设备名称");
    if (name !== null) {
      await api.updateSnapshotCustomName(s.id, name.trim());
      toast("已更新名称", "success");
      snapshotView(p).then((n) => { wrap.replaceWith(n); });
    }
  });

  function tabBtn(t: Tab, label: string, count: string, enabled: boolean): HTMLElement {
    return el("button", {
      class: `tab-btn ${tab === t ? "active" : ""} ${enabled ? "" : "disabled"}`,
      onclick: () => switchTab(t),
    },
      el("span", { class: "tab-label" }, label),
      el("span", { class: "tab-count" }, count),
    );
  }

  function switchTab(t: Tab) {
    if (t === tab) return;
    tab = t;
    if (t === "sms") {
      threadPage = 1;
      threadSearch = "";
      selectedThreadId = null;
    } else {
      page = 1;
    }
    tabsEl.querySelectorAll(".tab-btn").forEach((b, i) => {
      b.classList.toggle("active", (["sms", "calls", "contacts"] as Tab[])[i] === t);
    });
    renderToolbar();
    void fetchData();
  }

  function renderToolbar() {
    toolbarEl.replaceChildren();
    const withDate = tab === "calls";
    const bar = createFilterBar(withDate);
    bar.setOnApply(() => {
      const f = bar.getFilters();
      if (tab === "sms") {
        threadSearch = f.search;
        threadPage = 1;
      } else {
        filters = f;
        page = 1;
      }
      if (debounceT) clearTimeout(debounceT);
      debounceT = window.setTimeout(() => void fetchData(), 220);
    });
    toolbarEl.appendChild(bar.element);
  }

  async function fetchData() {
    if (tab === "sms") {
      pageEl.replaceChildren();
      await fetchThreads();
      return;
    }
    const q = { snapshot_id: s.id, page, page_size: PAGE_SIZE, search: filters.search, date_from: filters.dateFrom, date_to: filters.dateTo };
    contentEl.replaceChildren(el("div", { class: "loading-row" }, "加载中…"));
    pageEl.replaceChildren();
    try {
      if (tab === "calls") {
        renderCalls(await api.queryCalls(q));
      } else {
        renderContacts(await api.queryContacts(q));
      }
    } catch (e) {
      contentEl.replaceChildren(emptyState("加载失败", String(e)));
    }
  }

  // ---------- 短信：会话视图 ----------
  function buildSmsShell(): HTMLElement {
    smsThreadListEl = el("div", { class: "thread-list" }, emptyState("加载中…"));
    smsThreadPagerEl = el("div", { class: "thread-list-pager" });
    smsMsgHeadEl = el("div", { class: "thread-view-head" }, "选择会话");
    smsMsgListEl = el("div", { class: "msg-list" }, emptyState("选择左侧会话查看短信"));
    smsMsgListEl.addEventListener("scroll", onMsgScroll);
    return el("div", { class: "sms-chat" },
      el("div", { class: "thread-list-pane" },
        smsThreadListEl,
        smsThreadPagerEl,
      ),
      el("div", { class: "thread-view-pane" },
        smsMsgHeadEl,
        smsMsgListEl,
      ),
    );
  }

  async function fetchThreads() {
    contentEl.replaceChildren(el("div", { class: "loading-row" }, "加载会话…"));
    try {
      const res = await api.listSmsThreads({
        snapshot_id: s.id, page: threadPage, page_size: THREAD_PAGE,
        search: threadSearch, date_from: null, date_to: null,
      });
      lastThreads = res.items;
      contentEl.replaceChildren(buildSmsShell());
      renderThreadList(res);
      smsThreadPagerEl.replaceChildren(
        createPagination(threadPage, res.total, THREAD_PAGE, (pg) => {
          threadPage = pg;
          selectedThreadId = null;
          void fetchData();
        }),
      );
      if (selectedThreadId === null && res.items.length) {
        selectedThreadId = res.items[0].thread_id;
      }
      if (selectedThreadId !== null) {
        void loadThreadMessages(selectedThreadId);
      } else {
        smsMsgHeadEl.replaceChildren("选择会话");
        smsMsgListEl.replaceChildren(emptyState(res.items.length ? "选择左侧会话查看短信" : "没有会话"));
      }
    } catch (e) {
      contentEl.replaceChildren(emptyState("加载失败", String(e)));
    }
  }

  function renderThreadList(res: PageResult<SmsThread>) {
    if (!res.items.length) {
      smsThreadListEl.replaceChildren(emptyState("没有会话", threadSearch ? "试试其他关键词" : "该快照无短信"));
      return;
    }
    smsThreadListEl.replaceChildren(...res.items.map((t) => threadItem(t)));
  }

  function threadItem(t: SmsThread): HTMLElement {
    const name = t.name || t.address || "未知";
    return el("div", {
      class: `thread-item ${t.thread_id === selectedThreadId ? "active" : ""}`,
      dataset: { tid: String(t.thread_id) },
      onclick: () => selectThread(t.thread_id),
    },
      el("div", { class: "ti-main" },
        el("div", { class: "ti-name" }, esc(name)),
        el("div", { class: "ti-preview" }, esc(t.last_body || "")),
      ),
      el("div", { class: "ti-meta" },
        el("div", { class: "ti-time" }, chatTime(t.last_date)),
        el("span", { class: "ti-count" }, `${t.count}`),
      ),
    );
  }

  function selectThread(tid: number) {
    selectedThreadId = tid;
    smsThreadListEl.querySelectorAll(".thread-item").forEach((it) => {
      const el2 = it as HTMLElement;
      el2.classList.toggle("active", el2.dataset.tid === String(tid));
    });
    void loadThreadMessages(tid);
  }

  async function loadThreadMessages(tid: number) {
    smsMsgHeadEl.replaceChildren("加载中…");
    smsMsgListEl.replaceChildren(el("div", { class: "loading-row" }, "加载中…"));
    try {
      const first = await api.getSmsThread(s.id, tid, 1, MSG_PAGE);
      msgTotalPages = Math.max(1, Math.ceil(first.total / MSG_PAGE));
      msgPage = msgTotalPages;
      const res = msgTotalPages === 1 ? first : await api.getSmsThread(s.id, tid, msgPage, MSG_PAGE);
      renderMessages(tid, res);
    } catch (e) {
      smsMsgListEl.replaceChildren(emptyState("加载失败", String(e)));
    }
  }

  function renderMessages(tid: number, res: PageResult<Sms>) {
    const thread = lastThreads.find((t) => t.thread_id === tid);
    const title = thread?.name || thread?.address || "会话";
    smsMsgHeadEl.replaceChildren(
      el("div", { class: "tv-title" }, esc(title)),
      el("div", { class: "tv-count" }, thread ? `${thread.count} 条` : ""),
    );
    if (!res.items.length) {
      smsMsgListEl.replaceChildren(emptyState("该会话没有消息"));
      return;
    }
    const nodes: (Node | string)[] = [];
    if (msgPage <= 1) nodes.push(el("div", { class: "msg-top-hint" }, "— 已到最早 —"));
    for (const m of res.items) nodes.push(smsBubble(m));
    smsMsgListEl.replaceChildren(...nodes);
    smsMsgListEl.scrollTop = smsMsgListEl.scrollHeight;
  }

  function onMsgScroll() {
    if (suppressScroll) {
      suppressScroll = false;
      return;
    }
    if (msgLoading || selectedThreadId === null || msgPage <= 1) return;
    if (smsMsgListEl.scrollTop < 40) {
      void autoLoadOlder(selectedThreadId);
    }
  }

  async function autoLoadOlder(tid: number) {
    if (msgLoading || msgPage <= 1) return;
    msgLoading = true;
    const nextPage = msgPage - 1;
    try {
      const res = await api.getSmsThread(s.id, tid, nextPage, MSG_PAGE);
      msgPage = nextPage;
      // 同步：记录锚点 -> 插入旧消息 -> 校正滚动，同帧完成，视觉不闪跳
      const prevH = smsMsgListEl.scrollHeight;
      const prevTop = smsMsgListEl.scrollTop;
      const frag = document.createDocumentFragment();
      if (msgPage <= 1) frag.appendChild(el("div", { class: "msg-top-hint" }, "— 已到最早 —"));
      for (const m of res.items) frag.appendChild(smsBubble(m));
      smsMsgListEl.insertBefore(frag, smsMsgListEl.firstChild);
      const added = smsMsgListEl.scrollHeight - prevH;
      suppressScroll = true;
      smsMsgListEl.scrollTop = prevTop + added;
    } catch (e) {
      toast("加载失败: " + String(e), "error");
    } finally {
      msgLoading = false;
    }
  }

  function smsBubble(m: Sms): HTMLElement {
    const sent = m.sms_type === 2;
    return el("div", { class: `msg-row ${sent ? "sent" : "recv"}` },
      el("div", { class: "bubble" },
        el("div", { class: "bubble-body" }, esc(m.body)),
        el("div", { class: "bubble-time" }, msgTime(m.date)),
      ),
    );
  }

  function chatTime(ms: number): string {
    if (!ms) return "";
    const d = new Date(ms);
    const now = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    if (d.toDateString() === now.toDateString()) return `${p(d.getHours())}:${p(d.getMinutes())}`;
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }

  function msgTime(ms: number): string {
    if (!ms) return "";
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // ---------- 通话 ----------
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

  // ---------- 通讯录 ----------
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
