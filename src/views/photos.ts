import { el, esc, fmtDate, toast } from "../dom";
import { navigate } from "../router";
import * as api from "../api";
import type { BackupSnapshot, PhotoFolder, ProgressPayload } from "../types";
import { emptyState, pageHeader, deviceLabel } from "./components";

export type MediaKind = "photos" | "videos";

function fmtSize(b: number): string {
  if (b <= 0) return "0 B";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// 模块级缓存（按 kind 隔离）：切走再回（同设备）保留扫描结果
interface Cache {
  selected: Set<string>;
  folders: PhotoFolder[];
  scannedSerial: string;
  /** 扁平存放：勾选后所有文件直接放 PHOTO/VIDEO 根目录，不保留目录结构 */
  flatten: boolean;
  /** 忽略缩略图/缓存等垃圾目录（默认开） */
  ignoreJunk: boolean;
}
const caches: Record<MediaKind, Cache> = {
  photos: { selected: new Set(), folders: [], scannedSerial: "", flatten: false, ignoreJunk: true },
  videos: { selected: new Set(), folders: [], scannedSerial: "", flatten: false, ignoreJunk: true },
};

const LABEL: Record<MediaKind, string> = { photos: "照片", videos: "视频" };

export async function mediaView(kind: MediaKind): Promise<HTMLElement> {
  const c = caches[kind];
  const word = LABEL[kind];
  const wrap = el("div", { class: "page" });
  const deviceSelect = el("select", { class: "input" }) as HTMLSelectElement;
  const scanBtn = el("button", { class: "btn btn-primary" }, `扫描${word}`);
  const folderWrap = el("div", { class: "photo-folders" }, emptyState(`先选择设备并扫描${word}`, `将按设备原目录分类列出${word}`));
  const footer = el("div", { class: "photo-footer" });
  const progressPanel = el("div", { class: "panel photo-progress", style: { display: "none" } });

  // 备份重入保护：进行中禁止再次点击「开始备份」，避免并发拉取/弹多个完成窗
  let backupRunning = false;
  // 完成态由 renderDonePanel 负责渲染，置 true 后忽略后续进度事件，防止覆盖完成面板
  let backupFinalized = false;
  // 取消中：点击「取消备份」后置 true，停止重复触发，按钮变「取消中…」
  let cancelling = false;

  function setProgressVisible(visible: boolean) {
    progressPanel.style.display = visible ? "" : "none";
    // 进度面板 sticky 钉底时，footer 让位为 static，避免两个 sticky-bottom 叠在底部重叠
    footer.style.position = visible ? "static" : "";
  }

  async function refreshDevices() {
    try {
      const list = (await api.listDevices()).filter((d) => d.state === "device");
      deviceSelect.replaceChildren(...(list.length
        ? list.map((d) => el("option", { value: d.serial }, deviceLabel(d)))
        : [el("option", { value: "" }, "无可用设备")]));
    } catch {
      deviceSelect.replaceChildren(el("option", { value: "" }, "ADB 不可用"));
    }
    // 恢复上次扫描结果（仅当该设备仍在线）
    if (c.scannedSerial) {
      const has = [...deviceSelect.options].some((o) => o.value === c.scannedSerial);
      if (has) {
        deviceSelect.value = c.scannedSerial;
        if (c.folders.length) renderFolders();
      } else {
        c.folders = [];
        c.selected.clear();
        c.scannedSerial = "";
      }
    }
  }

  /** 判断是否为垃圾目录（缩略图缓存、回收站、时间戳缓存等） */
  function isJunkDir(dir: string): boolean {
    const JUNK = [".thumbnails", ".thumb", ".thumbdata", ".globalTrash",
      ".app_icon_back", ".gs", ".gs_fs0", ".gs_fs2", ".gs_fs6",
      ".estrongs", ".nomedia", ".cache"];
    const basename = dir.split("/").pop() || dir;
    if (basename.length >= 10 && /^\d+$/.test(basename)) return true;
    return dir.split("/").some((comp) => JUNK.includes(comp));
  }

  function renderFolders() {
    // 按开关过滤垃圾目录
    const shown = c.ignoreJunk ? c.folders.filter((f) => !isJunkDir(f.dir)) : c.folders;
    if (!shown.length) {
      folderWrap.replaceChildren(emptyState(`未扫描到${word}`, c.ignoreJunk ? `该设备无${word}（或全是缩略图缓存，关闭「忽略缓存」可查看全部）` : `该设备无${word}`));
      footer.replaceChildren();
      return;
    }
    const allSelected = shown.every((f) => c.selected.has(f.dir));
    folderWrap.replaceChildren(
      el("div", { class: "photo-folder photo-folder-head" },
        checkboxEl(allSelected, () => {
          if (allSelected) shown.forEach((f) => c.selected.delete(f.dir));
          else shown.forEach((f) => c.selected.add(f.dir));
          renderFolders();
        }),
        el("span", { class: "pf-name" }, `${shown.length} 个目录`),
        el("span", { class: "pf-meta" }, `共 ${shown.reduce((a, f) => a + f.count, 0)} 个${word}`),
      ),
      ...shown.map(folderRow),
    );
    renderFooter();
  }

  function folderRow(f: PhotoFolder): HTMLElement {
    const checked = c.selected.has(f.dir);
    const expanded = el("div", { class: "pf-files" });
    let shown = false;
    const row = el("div", { class: "photo-folder" },
      checkboxEl(checked, () => {
        if (checked) c.selected.delete(f.dir);
        else c.selected.add(f.dir);
        renderFolders();
      }),
      el("span", { class: `pf-toggle ${checked ? "" : "closed"}`, onclick: (e: Event) => {
        e.stopPropagation();
        shown = !shown;
        if (shown) {
          expanded.replaceChildren(...f.files.slice(0, 200).map((file) =>
            el("div", { class: "pf-file" },
              el("span", { class: "pf-file-name" }, esc(file.name)),
              el("span", { class: "pf-file-meta" }, fmtSize(file.size)),
              el("span", { class: "pf-file-meta" }, fmtDate(file.date)),
            ),
          ));
          if (f.files.length > 200) {
            expanded.appendChild(el("div", { class: "pf-file-more" }, `… 共 ${f.files.length} 个${word}`));
          }
        } else {
          expanded.replaceChildren();
        }
        row.querySelector(".pf-toggle")?.classList.toggle("closed", !shown);
      } }, "▾"),
      f.app ? el("span", { class: "pf-app" }, esc(f.app)) : el("span", { class: "pf-name" }, esc(f.name)),
      el("span", { class: "pf-path" }, esc(f.dir)),
      el("span", { class: "pf-meta" }, `${f.count} 个${word} · ${fmtSize(f.total_size)}`),
    );
    row.appendChild(expanded);
    return row;
  }

  function checkboxEl(checked: boolean, onToggle: () => void): HTMLElement {
    const cb = el("input", { type: "checkbox", checked }) as HTMLInputElement;
    cb.checked = checked;
    cb.addEventListener("change", onToggle);
    return el("label", { class: "pf-check" }, cb);
  }

  function renderFooter() {
    // 只统计可见目录的选中状态（忽略缓存开启时排除垃圾目录）
    const visible = c.ignoreJunk ? c.folders.filter((f) => !isJunkDir(f.dir)) : c.folders;
    const selCount = visible.filter((f) => c.selected.has(f.dir)).length;
    const selSize = visible.filter((f) => c.selected.has(f.dir)).reduce((a, f) => a + f.total_size, 0);
    const pullBtn = el("button", {
      class: "btn btn-primary",
      disabled: selCount === 0 || backupRunning,
    }, backupRunning ? "备份中…" : "开始备份");
    pullBtn.onclick = async () => {
      if (backupRunning) return;
      const serial = deviceSelect.value;
      if (!serial) { toast("请先选择设备", "error"); return; }
      // 只拉扫描到的媒体文件（按扩展名过滤，不拉整个目录，避免 .bin 等无关文件）
      // 只备份选中目录的文件；忽略缓存开关开启时也排除垃圾目录的文件
      const visible = c.ignoreJunk ? (f: PhotoFolder) => !isJunkDir(f.dir) : () => true;
      const files = c.folders
        .filter((f) => c.selected.has(f.dir) && visible(f))
        .flatMap((f) => f.files);
      if (!files.length) { toast("请至少选择一个目录", "error"); return; }
      backupRunning = true;
      backupFinalized = false;
      cancelling = false;
      pullBtn.disabled = true;
      pullBtn.textContent = "备份中…";
      scanBtn.disabled = true;
      setProgressVisible(true);
      renderProgress({ stage: "start", current: 0, total: files.length, message: "准备拉取…" });
      let unlisten: Awaited<ReturnType<typeof api.onMediaProgress>> | null = null;
      try {
        unlisten = await api.onMediaProgress((p) => renderProgress(p));
        const snap = kind === "photos"
          ? await api.pullPhotos(serial, files, c.flatten)
          : await api.pullVideos(serial, files, c.flatten);
        backupFinalized = true;
        renderDonePanel(snap);
      } catch (e) {
        const msg = String(e);
        if (msg.includes("设备已断开")) {
          toast("备份失败：" + msg, "error");
          renderProgress({ stage: "failed", current: 0, total: 0, message: msg });
        } else if (msg.includes("已取消")) {
          toast("已取消", "info");
          renderProgress({ stage: "cancelled", current: 0, total: 0, message: "已取消" });
        } else {
          renderProgress({ stage: "error", current: 0, total: 0, message: "拉取失败: " + msg });
          toast("拉取失败: " + msg, "error");
        }
      } finally {
        if (unlisten) (await unlisten)();
        backupRunning = false;
        scanBtn.disabled = false;
        renderFooter();
      }
    };
    const flattenCb = el("input", { type: "checkbox", checked: c.flatten }) as HTMLInputElement;
    flattenCb.checked = c.flatten;
    const flattenLabel = el("label", { class: `pf-flatten ${c.flatten ? "on" : ""}`, title: `勾选后所有文件直接放在 ${kind === "photos" ? "PHOTO" : "VIDEO"} 根目录，不保留目录结构，便于一次性浏览；同名文件自动加后缀` },
      flattenCb,
      el("span", { class: "pf-flatten-dot" }),
      el("span", {}, "统一存放"),
    );
    flattenCb.addEventListener("change", () => {
      c.flatten = flattenCb.checked;
      flattenLabel.classList.toggle("on", flattenCb.checked);
    });
    const junkCb = el("input", { type: "checkbox", checked: c.ignoreJunk }) as HTMLInputElement;
    junkCb.checked = c.ignoreJunk;
    const junkLabel = el("label", { class: `pf-flatten ${c.ignoreJunk ? "on" : ""}`, title: "勾选后隐藏缩略图缓存、回收站、时间戳缓存等目录，减少列表噪音；关闭则显示全部" },
      junkCb,
      el("span", { class: "pf-flatten-dot" }),
      el("span", {}, "忽略缓存"),
    );
    junkCb.addEventListener("change", () => {
      c.ignoreJunk = junkCb.checked;
      junkLabel.classList.toggle("on", junkCb.checked);
      if (c.ignoreJunk) {
        // 开启时：自动取消选中垃圾目录
        c.folders.filter((f) => isJunkDir(f.dir)).forEach((f) => c.selected.delete(f.dir));
      } else {
        // 关闭时：自动全选（恢复默认）
        c.folders.forEach((f) => c.selected.add(f.dir));
      }
      renderFolders();
    });
    footer.replaceChildren(
      el("span", { class: "pf-summary" }, `已选 ${selCount}/${visible.length} 个目录 · ${fmtSize(selSize)}`),
      el("div", { class: "pf-foot-right" },
        junkLabel,
        flattenLabel,
        pullBtn,
      ),
    );
  }

  function renderProgress(p: ProgressPayload) {
    // 完成态由 renderDonePanel 负责渲染；进行中事件到达即刷新，防止覆盖完成面板
    if (backupFinalized || p.stage === "done") return;
    const pct = p.total > 0 ? Math.round((p.current / p.total) * 100) : 0;
    const failed = p.stage === "failed";
    const err = p.stage === "error";
    const cancelled = p.stage === "cancelled";
    const terminal = failed || cancelled;
    const actions: HTMLElement[] = [];
    if (!terminal) {
      const cancelBtn = el("button", { class: "btn btn-ghost btn-sm", disabled: cancelling }, cancelling ? "取消中…" : "取消备份");
      cancelBtn.onclick = async () => {
        if (cancelling) return;
        cancelling = true;
        cancelBtn.disabled = true;
        cancelBtn.textContent = "取消中…";
        try { await api.cancelBackup(); } catch { /* ignore */ }
      };
      actions.push(cancelBtn);
    }
    const title = failed ? "拉取失败" : cancelled ? "已取消" : err ? "拉取出错" : "拉取进度";
    const badgeCls = failed ? "badge-err" : cancelled ? "badge-warn" : err ? "badge-err" : "badge-info";
    const badgeTxt = failed ? "失败" : cancelled ? "已取消" : err ? "错误" : "进行中";
    const fillCls = failed ? " fail" : cancelled ? " warn" : "";
    const pctCls = failed ? " fail" : cancelled ? " warn" : "";
    progressPanel.replaceChildren(
      el("div", { class: "panel-head" }, el("h3", {}, title)),
      el("div", { class: "progress-stage" },
        el("span", { class: `badge ${badgeCls}` }, badgeTxt),
        el("div", { class: "progress-right" },
          el("span", { class: `progress-pct${pctCls}` }, `${terminal ? 100 : pct}%`),
          el("span", { class: "progress-count" }, p.total > 0 ? `${p.current} / ${p.total} 个文件` : ""),
        ),
      ),
      el("div", { class: "progress-bar" }, el("div", { class: `progress-fill${fillCls}`, style: { width: `${terminal ? 100 : pct}%` } })),
      el("div", { class: "progress-msg" }, p.message),
      el("div", { class: "progress-actions" }, ...actions),
    );
  }

  function renderDonePanel(snap: BackupSnapshot) {
    // 备注含失败/未完成/设备已断开 → 失败（红）；已取消 → 黄；否则完成（绿）。绝不把中断显示成「完成」。
    const failed = /失败|未完成|设备已断开/.test(snap.note);
    const cancelled = !failed && snap.note.includes("已取消");
    const title = failed ? "拉取失败" : cancelled ? "已取消" : "拉取完成";
    const badgeCls = failed ? "badge-err" : cancelled ? "badge-warn" : "badge-ok";
    const badgeTxt = failed ? "失败" : cancelled ? "已取消" : "完成";
    const fillCls = failed ? " fail" : cancelled ? " warn" : " done";
    const pctCls = failed ? " fail" : cancelled ? " warn" : " done";
    progressPanel.replaceChildren(
      el("div", { class: "panel-head" }, el("h3", {}, title)),
      el("div", { class: "progress-stage" },
        el("span", { class: `badge ${badgeCls}` }, badgeTxt),
        el("div", { class: "progress-right" },
          el("span", { class: `progress-pct${pctCls}` }, "100%"),
        ),
      ),
      el("div", { class: "progress-bar" }, el("div", { class: `progress-fill${fillCls}`, style: { width: "100%" } })),
      el("div", { class: "progress-msg" }, snap.note || "备份完成"),
      el("div", { class: "progress-actions" },
        el("button", { class: "btn btn-primary btn-sm", onclick: async () => {
          try {
            const p = await api.getSnapshotPath(snap.id);
            if (p) await api.openFolder(p);
            else toast("未找到备份目录", "error");
          } catch (e) {
            toast("打开文件夹失败: " + String(e), "error");
          }
        } }, "打开文件夹"),
        el("button", { class: "btn btn-ghost btn-sm", onclick: () => navigate(`#/snapshot/${encodeURIComponent(snap.id)}`) }, "查看记录"),
      ),
    );
  }

  scanBtn.onclick = async () => {
    if (backupRunning) { toast("备份进行中，请稍候", "error"); return; }
    const serial = deviceSelect.value;
    if (!serial) { toast("请先选择设备", "error"); return; }
    setProgressVisible(false);
    scanBtn.disabled = true;
    scanBtn.textContent = `扫描${word}中…`;
    folderWrap.replaceChildren(el("div", { class: "loading-row" }, `扫描设备${word}…`));
    try {
      c.folders = kind === "photos" ? await api.scanPhotos(serial) : await api.scanVideos(serial);
      c.scannedSerial = serial;
      c.selected.clear();
      c.folders.forEach((f) => c.selected.add(f.dir));
      renderFolders();
    } catch (e) {
      folderWrap.replaceChildren(emptyState("扫描失败", String(e)));
    } finally {
      scanBtn.disabled = false;
      scanBtn.textContent = `扫描${word}`;
    }
  };

  deviceSelect.addEventListener("change", () => {
    const v = deviceSelect.value;
    if (v && v !== c.scannedSerial) {
      c.folders = [];
      c.selected.clear();
      c.scannedSerial = "";
      setProgressVisible(false);
      folderWrap.replaceChildren(emptyState(`先选择设备并扫描${word}`, `将按设备原目录分类列出${word}`));
      footer.replaceChildren();
    }
  });

  wrap.replaceChildren(
    pageHeader(`${word}备份`),
    el("div", { class: "panel" },
      el("div", { class: "form-row row-inline" },
        el("label", { class: "form-label" }, "设备"),
        deviceSelect,
        scanBtn,
        el("button", { class: "btn btn-ghost btn-sm", onclick: () => void refreshDevices() }, "刷新"),
      ),
      el("div", { class: "hint-line" }, `扫描后按设备原目录分类列出${word}，默认全选（=全部备份），可取消个别目录。同一应用的多个子目录会归拢为一项（如「酷狗音乐」），点「开始备份」只拉取扫描到的${word}文件（不拉整个目录，避免 .bin 等无关文件）。默认按应用名/原目录结构存入「备份目录」下的 <设备>/<时间>/${kind === "photos" ? "PHOTO" : "VIDEO"} 子目录；目录太多时可勾选底部「统一存放」，所有文件直接放进根目录、不再分层，便于一次性浏览（同名自动加后缀）。并生成备份记录（仪表盘/查看数据/设备页可见）。备份目录可在设置中改。`),
    ),
    folderWrap,
    footer,
    progressPanel,
  );

  void refreshDevices();
  return wrap;
}
