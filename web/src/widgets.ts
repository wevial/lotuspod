// Only the WindowProxy of a widget on this page can speak for it.
var WIDGET: "lotuspod:widget" = "lotuspod:widget";
interface WidgetState {
  ready: boolean;
  errors: number;
  lastError: string;
  accepted: number[];
  height?: number;
  pending: boolean;
  paused?: boolean;
}
// Render calls this in the head before parsing any widget frames. The deferred
// page bundle only declares it: startup must not depend on that download.
function installWidgetBridge(): void {
  const widgetStates = new WeakMap<HTMLIFrameElement, WidgetState>();
  const stateFor = (frame: HTMLIFrameElement): WidgetState => {
    let state = widgetStates.get(frame);
    if (!state) {
      state = {ready: false, errors: 0, lastError: "", accepted: [], pending: false};
      widgetStates.set(frame, state);
    }
    return state;
  };
  const initialize = (): void => {
    document.querySelectorAll<HTMLElement>("figure.artifact-live").forEach((figure) => {
      const frame = figure.querySelector<HTMLIFrameElement>("iframe.artifact-widget");
      const chrome = figure.querySelector<HTMLElement>(".artifact-live-chrome");
      const badge = figure.querySelector<HTMLElement>(".artifact-live-badge");
      if (!frame || !chrome || !badge || chrome.querySelector("button")) return;
      const source = frame.getAttribute("src")!;
      const state = stateFor(frame);
      const expand = document.createElement("button");
      expand.type = "button";
      expand.className = "artifact-live-expand";
      expand.textContent = "Expand";
      expand.setAttribute("aria-expanded", "false");
      const pause = document.createElement("button");
      pause.type = "button";
      pause.className = "artifact-live-pause";
      pause.textContent = "Pause";
      chrome.insertBefore(expand, chrome.querySelector("a"));
      chrome.append(pause);
      const placeholder = document.createElement("div");
      placeholder.className = "artifact-live-paused";
      placeholder.textContent = "Paused. The widget's scripts are stopped. Press Resume to start it again from the beginning.";
      placeholder.hidden = true;
      figure.append(placeholder);
      const updateBadge = (): void => {
        badge.textContent = state.errors ? `${state.errors} ${state.errors === 1 ? "error" : "errors"}` : state.ready ? "Live" : "loading";
        if (state.errors) badge.setAttribute("title", state.lastError);
        else badge.removeAttribute("title");
      };
      const close = (): void => {
        if (!figure.classList.contains("artifact-live--expanded")) return;
        figure.classList.remove("artifact-live--expanded");
        expand.textContent = "Expand";
        expand.setAttribute("aria-expanded", "false");
        expand.focus();
      };
      expand.addEventListener("click", () => {
        if (figure.classList.contains("artifact-live--expanded")) close();
        else {
          figure.classList.add("artifact-live--expanded");
          expand.textContent = "Close";
          expand.setAttribute("aria-expanded", "true");
        }
      });
      document.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); });
      pause.addEventListener("click", () => {
        state.paused = !state.paused;
        placeholder.hidden = !state.paused;
        pause.textContent = state.paused ? "Resume" : "Pause";
        if (!state.paused) {
          state.ready = false;
          state.errors = 0;
          state.lastError = "";
          state.accepted = [];
          updateBadge();
        }
        frame.src = state.paused ? "about:blank" : source;
      });
      frame.addEventListener(WIDGET, (event) => {
        updateBadge();
        if (event.detail.kind === "escape") close();
      });
      updateBadge();
    });
  };
  document.addEventListener("DOMContentLoaded", initialize);
  document.addEventListener("lotuspod:swapped", initialize);
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    const frame = Array.from(document.querySelectorAll<HTMLIFrameElement>("iframe.artifact-widget"))
      .find((candidate) => candidate.contentWindow === event.source);
    if (!frame || !event.data || typeof event.data !== "object" || Array.isArray(event.data)) return;
    const data = event.data as Record<string, unknown>;
    const keys = Object.keys(data).sort().join(",");
    let kind: WidgetDetail["kind"] | "resize";
    switch (data.type) {
      case "lotuspod:resize":
        if (keys !== "height,type" || typeof data.height !== "number" ||
            !Number.isInteger(data.height) || data.height < 0 || data.height > 10000) return;
        kind = "resize";
        break;
      case "lotuspod:error":
        if (keys !== "message,type" || typeof data.message !== "string" || data.message.length > 200) return;
        kind = "error";
        break;
      case "lotuspod:ready":
      case "lotuspod:escape":
        if (keys !== "type") return;
        kind = data.type === "lotuspod:ready" ? "ready" : "escape";
        break;
      default: return;
    }
    const state = stateFor(frame);
    if (state.paused) return;
    const now = performance.now();
    state.accepted = state.accepted.filter((time) => now - time < 1000);
    if (state.accepted.length >= 60) return;
    state.accepted.push(now);
    if (kind === "resize") {
      if (frame.hasAttribute("data-height-fixed")) return;
      state.height = data.height as number;
      if (!state.pending) {
        state.pending = true;
        requestAnimationFrame(() => {
          state.pending = false;
          if (!state.paused) frame.height = String(state.height);
        });
      }
      return;
    }
    const message = kind === "error" ? data.message as string : "";
    if (kind === "ready") state.ready = true;
    if (kind === "error") {
      state.errors++;
      state.lastError = message;
    }
    frame.dispatchEvent(new CustomEvent<WidgetDetail>(WIDGET, {detail: {kind, message}}));
  });
}
