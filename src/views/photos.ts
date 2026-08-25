import { el, esc, fmtDate, toast } from "../dom";
import * as api from "../api";
import type { PhotoFolder, ProgressPayload } from "../types";
import { emptyState, pageHeader, deviceLabel } from "./components";

function fmtSize(b: number): string {
  if (b <= 0) return "0 B";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export async function photosView(): Promise<HTMLElement> {
  const wrap = el("div", { class: "page" });
  const deviceSelect = el("select", { class: "input" }) as HTMLSelectElement;
  const scanBtn = el("button", { class: "btn btn-primary" }, "扫描相册");
  const folderWrap = el("div", { class: "photo-folders" }, emptyState("先选择设备并扫描", "将按设备原目录分类列出照片"));
  const footer = el("div", { class: "photo-footer" });
  const progressPanel = el("div", { class: "panel photo-progress", style: { display: "none" } });

  const selected = new Set<string>();
  let folders: PhotoFolder[] = [];

  async function refreshDevices() {
    try {
      const list = (await api.listDevices()).filter((d) => d.state === "device");
      deviceSelect.replaceChildren(...(list.length
        ? list.map((d) => el("option", { value: d.serial }, deviceLabel(d)))
        : [el("option", { value: "" }, "无可用设备")]));
    } catch {
      deviceSelect.replaceChildren(el("option", { value: "" }, "ADB 不可用"));
    }
  }

  function renderFolders() {
    if (!folders.length) {
      folderWrap.replaceChildren(emptyState("未扫描到照片", "该设备 MediaStore 无图片记录"));
      footer.replaceChildren();
      return;
    }
    const allSelected = folders.every((f) => selected.has(f.dir));
    const selSize = folders.filter((f) => selected.has(f.dir)).reduce((a, f) => a + f.total_size, 0);
    folderWrap.replaceChildren(
      el("div", { class: "photo-folder photo-folder-head" },
        checkboxEl(allSelected, () => {
          if (allSelected) selected.clear();
          else folders.forEach((f) => selected.add(f.dir));
          renderFolders();
          renderFooter(selSize);
        }),
        el("span", { class: "pf-name" }, `${folders.length} 个目录`),
        el("span", { class: "pf-meta" }, `共 ${folders.reduce((a, f) => a + f.count, 0)} 张`),
      ),
      ...folders.map(folderRow),
    );
    void 0;
    renderFooter(selSize);
  }

  function folderRow(f: PhotoFolder): HTMLElement {
    const checked = selected.has(f.dir);
    const expanded = el("div", { class: "pf-files" });
    let shown = false;
    const row = el("div", { class: "photo-folder" },
      checkboxEl(checked, () => {
        if (checked) selected.delete(f.dir);
        else selected.add(f.dir);
        renderFolders();
        renderFooter();
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
            expanded.appendChild(el("div", { class: "pf-file-more" }, `… 共 ${f.files.length} 张`));
          }
        } else {
          expanded.replaceChildren();
        }
        row.querySelector(".pf-toggle")?.classList.toggle("closed", !shown);
      } }, "▾"),
      el("span", { class: "pf-name" }, esc(f.name)),
      el("span", { class: "pf-path" }, esc(f.dir)),
      el("span", { class: "pf-meta" }, `${f.count} 张 · ${fmtSize(f.total_size)}`),
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

  function renderFooter(selSize = 0) {
    const selCount = selected.size;
    const pullBtn = el("button", {
      class: "btn btn-primary",
      disabled: selCount === 0,
    }, "选中备份到…");
    pullBtn.onclick = async () => {
      const serial = deviceSelect.value;
      if (!serial) { toast("请先选择设备", "error"); return; }
      if (!selected.size) { toast("请至少选择一个目录", "error"); return; }
      const dir = await api.pickExportDir();
      if (!dir) return;
      progressPanel.style.display = "";
      renderProgress({ stage: "start", current: 0, total: selected.size, message: "准备拉取…" });
      let unlisten: Awaited<ReturnType<typeof api.onMediaProgress>> | null = null;
      try {
        unlisten = await api.onMediaProgress((p) => renderProgress(p));
        const res = await api.pullPhotos(serial, [...selected], dir);
        toast(`完成：成功 ${res.folders}/${selected.size} 个目录 → ${res.dest}`, "success");
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
      el("span", { class: "pf-summary" }, `已选 ${selCount}/${folders.length} 个目录 · ${fmtSize(selSize)}`),
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
    scanBtn.textContent = "扫描中…";
    folderWrap.replaceChildren(el("div", { class: "loading-row" }, "扫描设备相册…"));
    try {
      folders = await api.scanPhotos(serial);
      selected.clear();
      folders.forEach((f) => selected.add(f.dir)); // 默认全选
      renderFolders();
    } catch (e) {
      folderWrap.replaceChildren(emptyState("扫描失败", String(e)));
    } finally {
      scanBtn.disabled = false;
      scanBtn.textContent = "扫描相册";
    }
  };

  wrap.replaceChildren(
    pageHeader("照片备份"),
    el("div", { class: "panel" },
      el("div", { class: "form-row row-inline" },
        el("label", { class: "form-label" }, "设备"),
        deviceSelect,
        scanBtn,
        el("button", { class: "btn btn-ghost btn-sm", onclick: () => void refreshDevices() }, "刷新"),
      ),
      el("div", { class: "hint-line" }, "扫描后按设备原目录分类列出，默认全选（=全部备份），可取消个别目录。点「选中备份到…」选一个父目录，会自动在其下创建 BackupHub_设备_时间 子目录保存。"),
    ),
    folderWrap,
    footer,
    progressPanel,
  );

  void refreshDevices();
  return wrap;
}
