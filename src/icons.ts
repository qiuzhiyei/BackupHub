import { createIcons, icons } from "lucide";

/**
 * 扫描文档，把带 `data-lucide` 的元素替换为 Lucide SVG 图标。
 * 图标用 currentColor 描边、随字号缩放（svg.lucide { width/height: 1.15em }）。
 * 每次视图渲染后调用，新插入的 [data-lucide] 会被替换；已替换的不会重复处理。
 */
export function renderIcons(): void {
  createIcons({ icons });
}
