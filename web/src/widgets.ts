// Only the WindowProxy of a widget on this page can speak for it.
var WIDGET: "lotuspod:widget" = "lotuspod:widget";
interface WidgetState {
  ready: boolean;
  errors: number;
  lastError: string;
  // The widget's latest lotuspod.state() label; "" before the first, and
  // again as each new document's bridge opens with "".
  label: string;
  accepted: number[];
  height?: number;
  pending: boolean;
  paused?: boolean;
  expanded?: boolean;
}
// Render calls this in the head before parsing any widget frames. The deferred
// page bundle only declares it: startup must not depend on that download.
function installWidgetBridge(): void {
  const widgetStates = new WeakMap<HTMLIFrameElement, WidgetState>();
  const stateFor = (frame: HTMLIFrameElement): WidgetState => {
    let state = widgetStates.get(frame);
    if (!state) {
      state = {ready: false, errors: 0, lastError: "", label: "", accepted: [], pending: false};
      widgetStates.set(frame, state);
    }
    return state;
  };
  const initialize = (event: Event): void => {
    document.querySelectorAll<HTMLElement>("figure.artifact-live").forEach((figure) => {
      const frame = figure.querySelector<HTMLIFrameElement>("iframe.artifact-widget");
      const chrome = figure.querySelector<HTMLElement>(".artifact-live-chrome");
      const badge = figure.querySelector<HTMLElement>(".artifact-live-badge");
      if (!frame || !chrome || !badge) return;
      const state = stateFor(frame);
      if (frame.hasAttribute("data-height-full") && state.height === undefined) {
        const bar = document.querySelector(".artifact-topbar");
        frame.height = String(Math.max(0, Math.ceil(window.innerHeight - (bar?.getBoundingClientRect().height ?? 0))));
      }
      // A carried frame may have lost its published fixed height. Its content
      // need not resize again, so restore the last normal measurement now.
      if (state.height !== undefined && !state.paused && !state.expanded && !frame.hasAttribute("data-height-fixed")) {
        frame.height = String(state.height);
      }
      // The page bundle's Comment (commentChrome) may come first.
      if (chrome.querySelector(".artifact-live-expand")) return;
      // Only fresh chrome needs tint: a carried figure already has buttons.
      // Keep this duration and class aligned with page-swap's part tint.
      if (event.type === "lotuspod:swapped") {
        const TINTED = "artifact-swapped";
        const TINT = 2000;
        chrome.classList.add(TINTED);
        setTimeout(() => chrome.classList.remove(TINTED), TINT);
      }
      const source = frame.getAttribute("src")!;
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
      // Widget text: only ever set as text.
      const where = document.createElement("span");
      where.className = "artifact-live-state";
      badge.after(where);
      const updateLabel = (): void => {
        where.textContent = state.label;
        where.hidden = !state.label;
      };
      const updateBadge = (): void => {
        badge.textContent = state.errors ? `${state.errors} ${state.errors === 1 ? "error" : "errors"}` : state.ready ? "Live" : "loading";
        if (state.errors) badge.setAttribute("title", state.lastError);
        else badge.removeAttribute("title");
      };
      const close = (): void => {
        if (!figure.classList.contains("artifact-live--expanded")) return;
        state.expanded = false;
        figure.classList.remove("artifact-live--expanded");
        expand.textContent = "Expand";
        expand.setAttribute("aria-expanded", "false");
        expand.focus();
      };
      expand.addEventListener("click", () => {
        if (figure.classList.contains("artifact-live--expanded")) close();
        else {
          state.expanded = true;
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
        // Stopped or started again, the widget is at no state it has named.
        state.label = "";
        updateLabel();
        if (!state.paused) {
          state.ready = false;
          state.errors = 0;
          state.lastError = "";
          state.accepted = [];
          updateBadge();
        }
        if (state.paused) frame.dataset.pausedSource = source;
        else delete frame.dataset.pausedSource;
        frame.src = state.paused ? "about:blank" : source;
      });
      frame.addEventListener(WIDGET, (event) => {
        updateBadge();
        updateLabel();
        if (event.detail.kind === "escape") close();
      });
      updateBadge();
      updateLabel();
    });
  };
  // Each document the frame loads names no state until its widget does,
  // whatever messages the quota let through: the frame's own load event
  // clears the label, also for a document without the bridge. A label the
  // new document names before the page sees its load is cleared with it,
  // which leaves the block with no state rather than a stale one.
  document.addEventListener("load", (event) => {
    const frame = event.target;
    if (!(frame instanceof HTMLIFrameElement) || !frame.matches("iframe.artifact-widget")) return;
    const state = stateFor(frame);
    if (!state.label) return;
    state.label = "";
    frame.dispatchEvent(new CustomEvent<WidgetDetail>(WIDGET, {detail: {kind: "state", message: ""}}));
  }, true);
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
      case "lotuspod:state":
        if (keys !== "label,type" || typeof data.label !== "string" || data.label.length > 80 ||
            !data.label.isWellFormed() || /[\u0000-\u001f\u007f-\u009f]/.test(data.label)) return;
        kind = "state";
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
      // Expanded viewport measurements must not replace the normal height.
      if (state.expanded) return;
      state.height = data.height as number;
      if (frame.hasAttribute("data-height-fixed")) return;
      if (!state.pending) {
        state.pending = true;
        requestAnimationFrame(() => {
          state.pending = false;
          if (!state.paused && !state.expanded && !frame.hasAttribute("data-height-fixed")) frame.height = String(state.height);
        });
      }
      return;
    }
    const message = kind === "error" ? data.message as string : kind === "state" ? data.label as string : "";
    if (kind === "ready") state.ready = true;
    if (kind === "state") {
      // The same label again changes nothing.
      if (state.label === message) return;
      state.label = message;
    }
    if (kind === "error") {
      state.errors++;
      state.lastError = message;
    }
    frame.dispatchEvent(new CustomEvent<WidgetDetail>(WIDGET, {detail: {kind, message}}));
  });
}

// Set by the comments island (web/src/islands/bridge.ts) before the page
// bundle reaches this source; never given a value here, so that stays.
var startComment: ((request: { anchor: BlockAnchor }) => void) | undefined;

// Each live block's pin, which the comments island numbers with the block's
// open threads, and its Comment button, after the title and badge, on a page
// that takes new comments: as the page bundle runs and on each swap, the
// head's chrome before or after it.
function commentChrome(): void {
  document.querySelectorAll<HTMLElement>("figure.artifact-live[data-widget]").forEach((figure) => {
    const frame = figure.querySelector<HTMLIFrameElement>("iframe.artifact-widget");
    const badge = figure.querySelector<HTMLElement>(".artifact-live-badge");
    if (!frame || !badge || figure.querySelector(":scope > .artifact-live-pin")) return;
    const pin = document.createElement("span");
    pin.className = "artifact-live-pin";
    pin.setAttribute("role", "button");
    pin.tabIndex = 0;
    pin.hidden = true;
    figure.append(pin);
    const start = startComment;
    if (!start) return;
    const comment = document.createElement("button");
    comment.type = "button";
    comment.className = "artifact-live-comment";
    comment.textContent = "Comment";
    (figure.querySelector(".artifact-live-chrome > .artifact-live-state") ?? badge).after(comment);
    comment.addEventListener("click", () => {
      // An expanded block would cover its composer: it closes first.
      if (figure.classList.contains("artifact-live--expanded")) {
        figure.querySelector<HTMLButtonElement>(".artifact-live-expand")?.click();
      }
      // The file the block shows, also while it is paused.
      const source = frame.dataset.pausedSource || frame.getAttribute("src") || "";
      const hash = /\.w-([0-9a-f]{12})\.html$/.exec(source)?.[1] || "";
      // The label the widget showed as the reader pressed Comment.
      const state = figure.querySelector(".artifact-live-chrome > .artifact-live-state")?.textContent ?? "";
      start({anchor: {kind: "block", id: figure.dataset.widget!, hash, state}});
    });
  });
}

// This source also runs alone in the head for early bridge messages. The
// deferred page bundle supplies holdSwap and registers this test once.
if (typeof holdSwap === "function") {
  holdSwap((nodes) => nodes.some((node) =>
    node.matches("figure.artifact-live--expanded") ||
    node.querySelector("figure.artifact-live--expanded") !== null));
  commentChrome();
  document.addEventListener("lotuspod:swapped", commentChrome);
}
