import { el, esc, fmtDate } from "../dom";
import { navigate } from "../router";
import * as api from "../api";
import type { BackupSnapshot } from "../types";
import { emptyState, pageHeader, createSnapshotRow, snapshotDeviceLabel } from "./components";

export async function dataView(): Promise<HTMLElement> {
  const wrap = el("div", { class: "page" });
  let allSnaps: BackupSnapshot[] = [];
  let view: "devices" | "snapshots" = "devices";
  let currentDeviceSerial = "";

  async function load() {
    try {
      allSnaps = await api.listSnapshots();
    } catch (e) {
      wrap.replaceChildren(pageHeader("查看数据"), emptyState("加载失败", String(e)));
      return;
    }
    render();
  }

  function render() {
    if (view === "devices") {
      renderDeviceList();
    } else {
      renderSnapshotList();
    }
  }

  // 设备列表：按设备分组，点击进入该设备的备份列表
  function renderDeviceList() {
    // 按序列号分组快照
    const groups = new Map<string, BackupSnapshot[]>();
    for (const s of allSnaps) {
      const arr = groups.get(s.device_serial) || [];
      arr.push(s);
      groups.set(s.device_serial, arr);
    }

    if (!groups.size) {
      wrap.replaceChildren(
        pageHeader("查看数据"),
        emptyState("还没有备份记录", "去「设备」页选择设备开始备份"),
      );
      return;
    }

    // 按最近备份时间排序
    const deviceList = [...groups.entries()].sort((a, b) => {
      const aLast = Math.max(...a[1].map((s) => s.created_at));
      const bLast = Math.max(...b[1].map((s) => s.created_at));
      return bLast - aLast;
    });

    const grid = el("div", { class: "card-grid" },
      ...deviceList.map(([serial, snaps]) => {
        const first = snaps[0];
        const name = snapshotDeviceLabel(first);
        const lastBackup = Math.max(...snaps.map((s) => s.created_at));
        const photoCount = snaps.filter((s) => s.kind === "PHOTO").length;
        const videoCount = snaps.filter((s) => s.kind === "VIDEO").length;
        const commCount = snaps.filter((s) => s.kind === "COMM").length;

        return el("div", {
          class: "card record-card",
          onclick: () => {
            currentDeviceSerial = serial;
            view = "snapshots";
            render();
          },
        },
          el("div", { class: "card-top" },
            el("div", { class: "card-icon" }, el("i", { "data-lucide": "smartphone" })),
            el("div", { class: "card-info" },
              el("div", { class: "card-title" }, esc(name)),
              el("div", { class: "card-sub" }, `${snaps.length} 次备份`),
            ),
          ),
          el("div", { class: "card-meta" },
            el("div", { class: "meta-line" }, `最近备份: ${fmtDate(lastBackup)}`),
            el("div", { class: "meta-line" }, commCount > 0 ? `短信/通话/通讯录 ${commCount} 次` : ""),
            el("div", { class: "meta-line" }, photoCount > 0 ? `照片 ${photoCount} 次` : ""),
            el("div", { class: "meta-line" }, videoCount > 0 ? `视频 ${videoCount} 次` : ""),
          ),
        );
      }),
    );

    wrap.replaceChildren(
      pageHeader("查看数据",
        el("button", { class: "btn btn-ghost btn-sm", onclick: () => void load() }, "刷新"),
      ),
      el("div", { class: "section-hint", style: { marginBottom: "12px" } }, "点击设备卡片查看该设备的所有备份记录"),
      grid,
    );
    void apiOnRender();
  }

  // 备份列表：某台设备的所有备份
  function renderSnapshotList() {
    const snaps = allSnaps
      .filter((s) => s.device_serial === currentDeviceSerial)
      .sort((a, b) => b.created_at - a.created_at);

    if (!snaps.length) {
      wrap.replaceChildren(
        pageHeader("查看数据"),
        emptyState("该设备没有备份记录"),
      );
      return;
    }

    const first = snaps[0];
    wrap.replaceChildren(
      pageHeader(snapshotDeviceLabel(first),
        el("button", { class: "btn btn-ghost btn-sm", onclick: () => { view = "devices"; render(); } }, "← 返回设备列表"),
      ),
      el("div", { class: "snapshot-list" },
        ...snaps.map((s) =>
          createSnapshotRow(s, {
            onReload: () => void load(),
            onOpen: (id) => navigate(`#/snapshot/${encodeURIComponent(id)}`),
          }),
        ),
      ),
    );
    void apiOnRender();
  }

  void load();
  return wrap;
}

// 触发图标渲染（router 也会调，这里补一次确保卡片图标显示）
function apiOnRender(): void {
  // router 的 renderIcons 已经会调，这里不需要额外操作
}
