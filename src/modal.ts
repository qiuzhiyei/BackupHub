import { el } from "./dom";

function mount(): HTMLDivElement {
  let host = document.getElementById("modal-host") as HTMLDivElement | null;
  if (!host) {
    host = el("div", { id: "modal-host" }) as HTMLDivElement;
    document.body.appendChild(host);
  }
  return host;
}

function overlay(content: HTMLElement): HTMLDivElement {
  const backdrop = el("div", { class: "modal-backdrop" },
    el("div", { class: "modal", onclick: (e: Event) => e.stopPropagation() }, content),
  );
  backdrop.addEventListener("click", () => backdrop.remove());
  mount().appendChild(backdrop);
  return backdrop;
}

export function confirmDialog(message: string, title = "请确认"): Promise<boolean> {
  return new Promise((resolve) => {
    let result = false;
    const close = () => backdrop.remove();
    const content = el("div", {},
      el("div", { class: "modal-title" }, title),
      el("div", { class: "modal-body" }, message),
      el("div", { class: "modal-actions" },
        el("button", {
          class: "btn btn-ghost",
          onclick: () => { result = false; close(); },
        }, "取消"),
        el("button", {
          class: "btn btn-primary",
          onclick: () => { result = true; close(); },
        }, "确定"),
      ),
    );
    const backdrop = overlay(content);
    // 监听移除以 resolve
    const obs = new MutationObserver(() => {
      if (!document.body.contains(backdrop)) {
        obs.disconnect();
        resolve(result);
      }
    });
    obs.observe(mount(), { childList: true });
  });
}

export function promptDialog(
  message: string,
  defaultValue = "",
  title = "输入",
): Promise<string | null> {
  return new Promise((resolve) => {
    const input = el("input", { class: "input", type: "text", value: defaultValue }) as HTMLInputElement;
    let result: string | null = null;
    const close = () => backdrop.remove();
    const submit = () => { result = input.value; close(); };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
      if (e.key === "Escape") { result = null; close(); }
    });
    const content = el("div", {},
      el("div", { class: "modal-title" }, title),
      el("div", { class: "modal-body" }, message),
      input,
      el("div", { class: "modal-actions" },
        el("button", { class: "btn btn-ghost", onclick: () => { result = null; close(); } }, "取消"),
        el("button", { class: "btn btn-primary", onclick: submit }, "确定"),
      ),
    );
    const backdrop = overlay(content);
    setTimeout(() => { input.focus(); input.select(); }, 50);
    const obs = new MutationObserver(() => {
      if (!document.body.contains(backdrop)) {
        obs.disconnect();
        resolve(result);
      }
    });
    obs.observe(mount(), { childList: true });
  });
}

export function chooseDialog(
  message: string,
  options: { label: string; value: string }[],
  title = "选择",
): Promise<string | null> {
  return new Promise((resolve) => {
    let result: string | null = null;
    const close = () => backdrop.remove();
    const content = el("div", {},
      el("div", { class: "modal-title" }, title),
      el("div", { class: "modal-body" }, message),
      el("div", { class: "modal-actions" },
        el("button", { class: "btn btn-ghost", onclick: () => { result = null; close(); } }, "取消"),
        ...options.map((o) =>
          el("button", {
            class: "btn btn-primary",
            onclick: () => { result = o.value; close(); },
          }, o.label),
        ),
      ),
    );
    const backdrop = overlay(content);
    const obs = new MutationObserver(() => {
      if (!document.body.contains(backdrop)) {
        obs.disconnect();
        resolve(result);
      }
    });
    obs.observe(mount(), { childList: true });
  });
}

/** 单按钮通知弹窗（完成/出错时用，需要用户点确定关闭） */
export function notifyDialog(message: string, title = "提示", isError = false): Promise<void> {
  return new Promise((resolve) => {
    const content = el("div", {},
      el("div", { class: `modal-title${isError ? " err" : ""}` }, title),
      el("div", { class: "modal-body" }, message),
      el("div", { class: "modal-actions" },
        el("button", {
          class: isError ? "btn btn-danger-ghost" : "btn btn-primary",
          onclick: () => backdrop.remove(),
        }, "确定"),
      ),
    );
    const backdrop = overlay(content);
    const obs = new MutationObserver(() => {
      if (!document.body.contains(backdrop)) {
        obs.disconnect();
        resolve();
      }
    });
    obs.observe(mount(), { childList: true });
  });
}
