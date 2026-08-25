import { dashboardView } from "./views/dashboard";
import { devicesGridView } from "./views/devices";
import { historyView } from "./views/history";
import { snapshotView } from "./views/snapshot";
import { backupView } from "./views/backup";
import { dataView } from "./views/data";
import { settingsView } from "./views/settings";
import { clear } from "./dom";

export interface RouteParams {
  params: Record<string, string>;
  query: URLSearchParams;
}

type ViewFn = (p: RouteParams) => Promise<HTMLElement>;

interface RouteEntry {
  pattern: RegExp;
  keys: string[];
  view: ViewFn;
}

const routes: RouteEntry[] = [
  { pattern: /^#\/$/, keys: [], view: () => dashboardView() },
  { pattern: /^#\/backup$/, keys: [], view: (p) => backupView(p) },
  { pattern: /^#\/data$/, keys: [], view: () => dataView() },
  { pattern: /^#\/devices$/, keys: [], view: () => devicesGridView() },
  { pattern: /^#\/devices\/([^/]+)$/, keys: ["serial"], view: (p) => historyView(p) },
  { pattern: /^#\/snapshot\/([^/]+)$/, keys: ["id"], view: (p) => snapshotView(p) },
  { pattern: /^#\/settings$/, keys: [], view: () => settingsView() },
];

export function navigate(to: string): void {
  if (location.hash === to) {
    render();
  } else {
    location.hash = to;
  }
}

export async function render(): Promise<void> {
  const hash = location.hash || "#/";
  const view = document.getElementById("view");
  if (!view) return;
  clear(view);
  view.appendChild(elSkeleton());

  // 高亮导航（前缀匹配，#/devices/:serial 也高亮「设备」）
  document.querySelectorAll(".nav-link").forEach((a) => {
    const link = a as HTMLAnchorElement;
    const href = link.getAttribute("href") || "";
    const active = hash === href || (href !== "#/" && hash.startsWith(href));
    link.classList.toggle("active", active);
  });

  const [pathPart, queryPart] = hash.split("?");
  const query = new URLSearchParams(queryPart || "");
  let matched: ViewFn | null = null;
  const params: Record<string, string> = {};
  for (const r of routes) {
    const m = pathPart.match(r.pattern);
    if (m) {
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      matched = r.view;
      break;
    }
  }
  try {
    if (!matched) {
      const notFound = document.createElement("div");
      notFound.className = "empty-state";
      notFound.textContent = "页面不存在";
      clear(view);
      view.appendChild(notFound);
      return;
    }
    const content = await matched({ params, query });
    clear(view);
    view.appendChild(content);
  } catch (err) {
    clear(view);
    const box = document.createElement("div");
    box.className = "empty-state error";
    box.textContent = "加载失败: " + String(err);
    view.appendChild(box);
  }
}

function elSkeleton(): HTMLElement {
  const s = document.createElement("div");
  s.className = "loading-skeleton";
  s.textContent = "加载中…";
  return s;
}

export function startRouter(): void {
  window.addEventListener("hashchange", render);
  render();
}
