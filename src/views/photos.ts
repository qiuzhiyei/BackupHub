import { el, esc, fmtDate, toast } from "../dom";
import * as api from "../api";
import type { PhotoFolder, ProgressPayload } from "../types";
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
}
const caches: Record<MediaKind, Cache> = {
  photos: { selected: new Set(), folders: [], scannedSerial: "" },
  videos: { selected: new Set(), folders: [], scannedSerial: "" },
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

  function renderFolders() {
    if (!c.folders.length) {
      folderWrap.replaceChildren(emptyState(`未扫描到${word}`, `该设备 MediaStore 无${word}记录`));
      footer.replaceChildren();
      return;
    }
    const allSelected = c.folders.every((f) => c.selected.has(f.dir));
    folderWrap.replaceChildren(
      el("div", { class: "photo-folder photo-folder-head" },
        checkboxEl(allSelected, () => {
          if (allSelected) c.selected.clear();
          else c.folders.forEach((f) => c.selected.add(f.dir));
          renderFolders();
        }),
        el("span", { class: "pf-name" }, `${c.folders.length} 个目录`),
        el("span", { class: "pf-meta" }, `共 ${c.folders.reduce((a, f) => a + f.count, 0)} 个${word}`),
      ),
      ...c.folders.map(folderRow),
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
      el("span", { class: "pf-name" }, esc(f.name)),
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
    const selCount = c.selected.size;
    const selSize = c.folders.filter((f) => c.selected.has(f.dir)).reduce((a, f) => a + f.total_size, 0);
    const pullBtn = el("button", {
      class: "btn btn-primary",
      disabled: selCount === 0,
    }, "开始备份");
    pullBtn.onclick = async () => {
      const serial = deviceSelect.value;
      if (!serial) { toast("请先选择设备", "error"); return; }
      if (!c.selected.size) { toast(`请至少选择一个目录`, "error"); return; }
      progressPanel.style.display = "";
      renderProgress({ stage: "start", current: 0, total: c.selected.size, message: "准备拉取…" });
      let unlisten: Awaited<ReturnType<typeof api.onMediaProgress>> | null = null;
      try {
        unlisten = await api.onMediaProgress((p) => renderProgress(p));
        const res = kind === "photos"
          ? await api.pullPhotos(serial, [...c.selected])
          : await api.pullVideos(serial, [...c.selected]);
        progressPanel.appendChild(
          el("button", { class: "btn btn-ghost btn-sm", onclick: () => void api.openFolder(res.dest) }, "打开文件夹"),
        );
      } catch (e) {
        toast("拉取失败: " + String(e), "error");
      } finally {
        if (unlisten) (await unlisten)();
      }
    };
    footer.replaceChildren(
      el("span", { class: "pf-summary" }, `已选 ${selCount}/${c.folders.length} 个目录 · ${fmtSize(selSize)}`),
      pullBtn,
    );
  }

  function renderProgress(p: ProgressPayload) {
    const pct = p.total > 0 ? Math.round((p.current / p.total) * 100) : 0;
    const done = p.stage === "done";
    progressPanel.replaceChildren(
      el("div", { class: "panel-head" }, el("h3", {}, done ? "拉取完成" : "拉取进度")),
      el("div", { class: "progress-stage" },
        el("span", { class: `badge ${done ? "badge-ok" : p.stage === "error" ? "badge-err" : "badge-info"}` }, done ? "完成" : p.stage === "error" ? "错误" : "进行中"),
        el("span", { class: "progress-count" }, p.total > 0 ? `${p.current}/${p.total}` : ""),
      ),
      el("div", { class: "progress-bar" }, el("div", { class: "progress-fill", style: { width: `${pct}%` } })),
      el("div", { class: "progress-msg" }, p.message),
    );
  }

  scanBtn.onclick = async () => {
    const serial = deviceSelect.value;
    if (!serial) { toast("请先选择设备", "error"); return; }
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
      el("div", { class: "hint-line" }, `扫描后按设备原目录分类列出${word}，默认全选（=全部备份），可取消个别目录。点「开始备份」直接备份到「备份目录」下的 <设备>/<时间>/${kind === "photos" ? "PHOTO" : "VIDEO"} 子目录（备份目录可在设置中改）。`),
    ),
    folderWrap,
    footer,
    progressPanel,
  );

  void refreshDevices();
  return wrap;
}
