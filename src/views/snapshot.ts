import { el, esc, fmtDate, fmtDuration, toast } from "../dom";
import { navigate } from "../router";
import * as api from "../api";
import type { BackupSnapshot, CallLog, Contact, PageResult, Sms, SmsThread } from "../types";
import { createFilterBar, createCompactPager, createPagination, emptyState, pageHeader } from "./components";
import { promptDialog } from "../modal";

type Tab = "sms" | "calls" | "contacts";
const PAGE_SIZE = 50;
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
  const isMedia = s.kind === "PHOTO" || s.kind === "VIDEO";

  // 媒体快照（照片/视频）：不显示短信/通话/通讯录标签，改为「打开文件夹」
  if (isMedia) {
    const word = s.kind === "PHOTO" ? "照片" : "视频";
    const ico = s.kind === "PHOTO" ? "camera" : "film";
    const openBtn = el("button", { class: "btn btn-primary" }, "打开文件夹");
    openBtn.addEventListener("click", async () => {
      try {
        const p = await api.getSnapshotPath(s.id);
        if (p) {
          await api.openFolder(p);
        } else {
          toast("未找到备份目录", "error");
        }
      } catch (e) {
        toast("打开文件夹失败: " + String(e), "error");
      }
    });
    wrap.replaceChildren(
      pageHeader(s.custom_name || s.device_model || `${word}备份`,
        el("button", { class: "btn btn-ghost btn-sm", onclick: () => navigate(`#/devices/${encodeURIComponent(s.device_serial)}`) }, "← 备份历史"),
      ),
      el("div", { class: "snap-meta" },
        el("span", { class: "sm-item" }, esc([s.device_brand, s.device_model].filter(Boolean).join(" ") || "—")),
        el("span", { class: "sm-sep" }, "·"),
        el("span", { class: "sm-item" }, `序列号 ${esc(s.device_serial)}`),
        el("span", { class: "sm-sep" }, "·"),
        el("span", { class: "sm-item" }, fmtDate(s.created_at)),
        el("span", { class: "badge badge-ok" }, `${word}备份`),
        el("button", { class: "btn btn-ghost btn-sm sm-edit", title: "编辑名称" }, "✎ 编辑名称"),
      ),
      el("div", { class: "panel media-snap-panel" },
        el("div", { class: "media-snap-ico" }, el("i", { "data-lucide": ico })),
        el("div", { class: "media-snap-body" },
          el("div", { class: "media-snap-title" }, `${word}备份`),
          el("div", { class: "media-snap-note" }, s.note ? esc(s.note) : `点击下方按钮在文件管理器中查看已备份的${word}`),
          openBtn,
        ),
      ),
    );
    wrap.querySelector(".sm-edit")?.addEventListener("click", async () => {
      const name = await promptDialog("请输入设备名称", s.custom_name || s.device_model || "", "编辑设备名称");
      if (name !== null) {
        await api.updateSnapshotCustomName(s.id, name.trim());
        toast("已更新名称", "success");
        snapshotView(p).then((n) => { wrap.replaceWith(n); });
      }
    });
    return wrap;
  }

  let tab: Tab = "sms";
  let page = 1;
  let filters = { search: "", dateFrom: null as number | null, dateTo: null as number | null };
  let debounceT: number | undefined;

  // SMS 会话视图状态
  let threadPage = 1;
  let threadSearch = "";
  let selectedThreadId: number | null = null;
  let lastThreads: SmsThread[] = [];
  let loadedMsgFor: number | null = null;
  let threadPageSize = 8;
  let lastUsedPageSize = 0;
  let threadResizeObs: ResizeObserver | undefined;
  let msgPage = 1;
  let msgTotalPages = 1;
  let msgLoading = false;
  let suppressScroll = false;
  let smsThreadListEl: HTMLElement;
  let smsThreadPagerEl: HTMLElement;
  let smsMsgHeadEl: HTMLElement;
  let smsMsgListEl: HTMLElement;

  const tabsEl = el("div", { class: "tabs" },
    tabBtn("sms", "短信", el("i", { "data-lucide": "mail" }), ` ${s.sms_count}`, s.sms_count > 0),
    tabBtn("calls", "通话记录", el("i", { "data-lucide": "phone" }), ` ${s.call_count}`, s.call_count > 0),
    tabBtn("contacts", "通讯录", el("i", { "data-lucide": "users" }), ` ${s.contact_count}`, s.contact_count > 0),
  );

  const toolbarEl = el("div", { class: "tab-toolbar" });
  const contentEl = el("div", { class: "tab-content" });
  const pageEl = el("div", { class: "tab-pagination" });

  wrap.replaceChildren(
    pageHeader(s.custom_name || s.device_model || "备份快照",
      el("button", { class: "btn btn-ghost btn-sm", onclick: () => navigate(`#/devices/${encodeURIComponent(s.device_serial)}`) }, "← 备份历史"),
    ),
    el("div", { class: "snap-meta" },
      el("span", { class: "sm-item" }, esc([s.device_brand, s.device_model].filter(Boolean).join(" ") || "—")),
      el("span", { class: "sm-sep" }, "·"),
      el("span", { class: "sm-item" }, `序列号 ${esc(s.device_serial)}`),
      el("span", { class: "sm-sep" }, "·"),
      el("span", { class: "sm-item" }, fmtDate(s.created_at)),
      el("button", { class: "btn btn-ghost btn-sm sm-edit", title: "编辑名称" }, "✎ 编辑名称"),
    ),
    tabsEl,
    toolbarEl,
    contentEl,
    pageEl,
  );

  wrap.querySelector(".sm-edit")?.addEventListener("click", async () => {
    const name = await promptDialog("请输入设备名称", s.custom_name || s.device_model || "", "编辑设备名称");
    if (name !== null) {
      await api.updateSnapshotCustomName(s.id, name.trim());
      toast("已更新名称", "success");
      snapshotView(p).then((n) => { wrap.replaceWith(n); });
    }
  });

  function tabBtn(t: Tab, label: string, iconEl: Node, count: string, enabled: boolean): HTMLElement {
    return el("button", {
      class: `tab-btn ${tab === t ? "active" : ""} ${enabled ? "" : "disabled"}`,
      onclick: () => switchTab(t),
    },
      el("span", { class: "tab-ico" }, iconEl),
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
      loadedMsgFor = null;
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
      await loadThreadsPage();
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
    // 自适应每页条数：随左栏高度变化重算并刷新
    if (threadResizeObs) threadResizeObs.disconnect();
    let rt: number | undefined;
    threadResizeObs = new ResizeObserver(() => {
      window.clearTimeout(rt);
      rt = window.setTimeout(() => {
        recomputePageSize();
        if (threadPageSize !== lastUsedPageSize) {
          threadPage = 1;
          void loadThreadsPage();
        }
      }, 180);
    });
    threadResizeObs.observe(smsThreadListEl);
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

  function recomputePageSize() {
    const h = smsThreadListEl.clientHeight;
    if (h <= 0) return;
    let itemH = 60;
    const sample = smsThreadListEl.querySelector(".thread-item") as HTMLElement | null;
    if (sample && sample.offsetHeight) itemH = sample.offsetHeight + 1;
    threadPageSize = Math.max(4, Math.floor(h / itemH));
  }

  function ensureShell() {
    const first = contentEl.firstElementChild as HTMLElement | null;
    if (!first || !first.classList.contains("sms-chat")) {
      contentEl.replaceChildren(buildSmsShell());
    }
  }

  async function loadThreadsPage() {
    ensureShell();
    recomputePageSize();
    lastUsedPageSize = threadPageSize;
    smsThreadListEl.replaceChildren(el("div", { class: "loading-row" }, "加载中…"));
    smsThreadPagerEl.replaceChildren();
    try {
      const res = await api.listSmsThreads({
        snapshot_id: s.id, page: threadPage, page_size: threadPageSize,
        search: threadSearch, date_from: null, date_to: null,
      });
      lastThreads = res.items;
      renderThreadList(res);
      const totalPages = Math.max(1, Math.ceil(res.total / threadPageSize));
      smsThreadPagerEl.replaceChildren(
        createCompactPager(threadPage, totalPages, res.total, (p) => {
          threadPage = p;
          void loadThreadsPage();
        }),
      );
      if (selectedThreadId === null && res.items.length) {
        selectedThreadId = res.items[0].thread_id;
      }
      if (selectedThreadId !== null && selectedThreadId !== loadedMsgFor) {
        void loadThreadMessages(selectedThreadId);
      } else if (selectedThreadId === null) {
        smsMsgHeadEl.replaceChildren("选择会话");
        smsMsgListEl.replaceChildren(emptyState(res.items.length ? "选择左侧会话查看短信" : "没有会话"));
      }
    } catch (e) {
      smsThreadListEl.replaceChildren(emptyState("加载失败", String(e)));
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
    loadedMsgFor = tid;
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
      el("div", { class: "tv-tools" },
        el("span", { class: "tv-count" }, thread ? `${thread.count} 条` : ""),
        el("button", {
          class: "btn btn-ghost btn-sm tv-jump",
          title: "跳到最早",
          disabled: msgPage <= 1,
          onclick: () => void jumpToEarliest(tid),
        }, "⏮ 最早"),
        el("button", {
          class: "btn btn-ghost btn-sm tv-jump",
          title: "跳到最新",
          disabled: msgPage >= msgTotalPages,
          onclick: () => void jumpToLatest(tid),
        }, "最新 ⏭"),
      ),
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

  async function jumpToEarliest(tid: number) {
    if (msgPage <= 1) return;
    smsMsgListEl.replaceChildren(el("div", { class: "loading-row" }, "加载中…"));
    try {
      msgPage = 1;
      const res = await api.getSmsThread(s.id, tid, 1, MSG_PAGE);
      renderMessages(tid, res);
      smsMsgListEl.scrollTop = 0;
    } catch (e) {
      toast("加载失败: " + String(e), "error");
    }
  }

  async function jumpToLatest(tid: number) {
    if (msgPage >= msgTotalPages) return;
    smsMsgListEl.replaceChildren(el("div", { class: "loading-row" }, "加载中…"));
    try {
      msgPage = msgTotalPages;
      const res = await api.getSmsThread(s.id, tid, msgPage, MSG_PAGE);
      renderMessages(tid, res);
      smsMsgListEl.scrollTop = smsMsgListEl.scrollHeight;
    } catch (e) {
      toast("加载失败: " + String(e), "error");
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
      1: { icon: "phone-incoming", label: "呼入", cls: "call-in" },
      2: { icon: "phone-outgoing", label: "呼出", cls: "call-out" },
      3: { icon: "phone-missed", label: "未接", cls: "call-miss" },
      5: { icon: "phone-off", label: "拒接", cls: "call-rej" },
    };
    const info = map[res.items[0].call_type] || { icon: "phone", label: "其他", cls: "" };
    const list = el("div", { class: "call-list" },
      ...res.items.map((c) => {
        const t = map[c.call_type] || info;
        return el("div", { class: `call-row ${t.cls}` },
          el("div", { class: `call-ico ${t.cls}` }, el("i", { "data-lucide": t.icon })),
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
          ? c.phones.map((p) => el("div", { class: "contact-phone" }, el("span", { class: "ci-ico" }, el("i", { "data-lucide": "phone" })), el("span", {}, esc(p))))
          : [el("div", { class: "contact-phone empty" }, "无电话号码")];
        const emails = c.emails.length
          ? c.emails.map((e) => el("div", { class: "contact-mail" }, el("span", { class: "ci-ico" }, el("i", { "data-lucide": "mail" })), el("span", {}, esc(e))))
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
