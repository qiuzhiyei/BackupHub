// 轻量 DOM 工具集

export type Child = string | Node | (string | Node | undefined)[];

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    if (k === "class") {
      node.className = String(v);
    } else if (k === "style" && typeof v === "object" && !Array.isArray(v)) {
      const target = node as HTMLElement;
      for (const [sk, sv] of Object.entries(v as Record<string, string>)) {
        (target.style as unknown as Record<string, string>)[sk] = String(sv);
      }
    } else if (k === "dataset" && typeof v === "object") {
        for (const [dk, dv] of Object.entries(v as Record<string, string>)) {
        node.dataset[dk] = String(dv);
      }
    } else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === "html") {
      node.innerHTML = String(v);
    } else if (k in node) {
      (node as unknown as Record<string, unknown>)[k] = v;
    } else {
      node.setAttribute(k, String(v));
    }
  }
  append(node, children);
  return node;
}

export function append(parent: Node, children: Child[]): void {
  for (const c of children) {
    if (c === undefined || c === null) continue;
    const arr = Array.isArray(c) ? c : [c];
    for (const item of arr) {
      if (item === undefined || item === null) continue;
      if (typeof item === "string") {
        parent.appendChild(document.createTextNode(item));
      } else {
        parent.appendChild(item);
      }
    }
  }
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** 转义文本，防止注入 */
export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function fmtDate(ms: number): string {
  if (!ms || ms <= 0) return "—";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtDateShort(ms: number): string {
  if (!ms || ms <= 0) return "—";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function fmtDuration(sec: number): string {
  if (sec <= 0) return "0秒";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m <= 0) return `${s}秒`;
  return `${m}分${s}秒`;
}

/** 日期字符串(yyyy-MM-dd) -> 当天起始毫秒 */
export function dateToMsStart(s: string): number | null {
  if (!s) return null;
  const d = new Date(s + "T00:00:00");
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/** 日期字符串(yyyy-MM-dd) -> 当天结束毫秒 */
export function dateToMsEnd(s: string): number | null {
  if (!s) return null;
  const d = new Date(s + "T23:59:59.999");
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

export function toast(msg: string, type: "info" | "error" | "success" = "info"): void {
  const host = document.getElementById("toast-host");
  if (!host) {
    alert(msg);
    return;
  }
  const t = el("div", { class: `toast toast-${type}` }, msg);
  host.appendChild(t);
  setTimeout(() => {
    t.classList.add("toast-out");
    setTimeout(() => t.remove(), 300);
  }, 2600);
}
