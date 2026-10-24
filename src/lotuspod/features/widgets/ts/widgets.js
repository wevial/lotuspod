// Built from src/lotuspod/features/widgets/ts/widgets.ts by web/build.ts. Edit that file, not this one.
var WIDGET = "lotuspod:widget";
function installWidgetBridge() {
  const widgetStates = new WeakMap;
  const stateFor = (frame) => {
    let state = widgetStates.get(frame);
    if (!state) {
      state = { ready: false, errors: 0, lastError: "", label: "", accepted: [], pending: false };
      widgetStates.set(frame, state);
    }
    return state;
  };
  const initialize = (event) => {
    document.querySelectorAll("figure.artifact-live").forEach((figure) => {
      const frame = figure.querySelector("iframe.artifact-widget");
      const chrome = figure.querySelector(".artifact-live-chrome");
      const badge = figure.querySelector(".artifact-live-badge");
      if (!frame || !chrome || !badge)
        return;
      const state = stateFor(frame);
      if (frame.hasAttribute("data-height-full") && state.height === undefined) {
        const bar = document.querySelector(".artifact-topbar");
        frame.height = String(Math.max(0, Math.ceil(window.innerHeight - (bar?.getBoundingClientRect().height ?? 0))));
      }
      if (state.height !== undefined && !state.paused && !state.expanded && !frame.hasAttribute("data-height-fixed")) {
        frame.height = String(state.height);
      }
      if (chrome.querySelector(".artifact-live-expand"))
        return;
      if (event.type === "lotuspod:swapped") {
        const TINTED = "artifact-swapped";
        const TINT = 2000;
        chrome.classList.add(TINTED);
        setTimeout(() => chrome.classList.remove(TINTED), TINT);
      }
      const source = frame.getAttribute("src");
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
      const where = document.createElement("span");
      where.className = "artifact-live-state";
      badge.after(where);
      const updateLabel = () => {
        where.textContent = state.label;
        where.hidden = !state.label;
      };
      const updateBadge = () => {
        badge.textContent = state.errors ? `${state.errors} ${state.errors === 1 ? "error" : "errors"}` : state.ready ? "Live" : "loading";
        if (state.errors)
          badge.setAttribute("title", state.lastError);
        else
          badge.removeAttribute("title");
      };
      const close = () => {
        if (!figure.classList.contains("artifact-live--expanded"))
          return;
        state.expanded = false;
        figure.classList.remove("artifact-live--expanded");
        expand.textContent = "Expand";
        expand.setAttribute("aria-expanded", "false");
        expand.focus();
      };
      expand.addEventListener("click", () => {
        if (figure.classList.contains("artifact-live--expanded"))
          close();
        else {
          state.expanded = true;
          figure.classList.add("artifact-live--expanded");
          expand.textContent = "Close";
          expand.setAttribute("aria-expanded", "true");
        }
      });
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape")
          close();
      });
      pause.addEventListener("click", () => {
        state.paused = !state.paused;
        placeholder.hidden = !state.paused;
        pause.textContent = state.paused ? "Resume" : "Pause";
        state.label = "";
        updateLabel();
        if (!state.paused) {
          state.ready = false;
          state.errors = 0;
          state.lastError = "";
          state.accepted = [];
          updateBadge();
        }
        if (state.paused)
          frame.dataset.pausedSource = source;
        else
          delete frame.dataset.pausedSource;
        frame.src = state.paused ? "about:blank" : source;
      });
      frame.addEventListener(WIDGET, (event) => {
        updateBadge();
        updateLabel();
        if (event.detail.kind === "escape")
          close();
      });
      updateBadge();
      updateLabel();
    });
  };
  document.addEventListener("load", (event) => {
    const frame = event.target;
    if (!(frame instanceof HTMLIFrameElement) || !frame.matches("iframe.artifact-widget"))
      return;
    const state = stateFor(frame);
    if (!state.label)
      return;
    state.label = "";
    frame.dispatchEvent(new CustomEvent(WIDGET, { detail: { kind: "state", message: "" } }));
  }, true);
  document.addEventListener("DOMContentLoaded", initialize);
  document.addEventListener("lotuspod:swapped", initialize);
  const postTheme = (frame) => {
    const theme = document.documentElement.getAttribute("data-theme");
    if (theme !== "night" && theme !== "dawn")
      return;
    frame.contentWindow?.postMessage({ type: "lotuspod:theme", theme }, "*");
  };
  document.addEventListener("lotuspod:theme", () => {
    document.querySelectorAll("iframe.artifact-widget").forEach((frame) => {
      if (!stateFor(frame).paused)
        postTheme(frame);
    });
  });
  window.addEventListener("message", (event) => {
    const frame = Array.from(document.querySelectorAll("iframe.artifact-widget")).find((candidate) => candidate.contentWindow === event.source);
    if (!frame || !event.data || typeof event.data !== "object" || Array.isArray(event.data))
      return;
    const data = event.data;
    const keys = Object.keys(data).sort().join(",");
    let kind;
    switch (data.type) {
      case "lotuspod:resize":
        if (keys !== "height,type" || typeof data.height !== "number" || !Number.isInteger(data.height) || data.height < 0 || data.height > 1e4)
          return;
        kind = "resize";
        break;
      case "lotuspod:error":
        if (keys !== "message,type" || typeof data.message !== "string" || data.message.length > 200)
          return;
        kind = "error";
        break;
      case "lotuspod:state":
        if (keys !== "label,type" || typeof data.label !== "string" || data.label.length > 80 || !data.label.isWellFormed() || /[\u0000-\u001f\u007f-\u009f]/.test(data.label))
          return;
        kind = "state";
        break;
      case "lotuspod:ready":
      case "lotuspod:escape":
        if (keys !== "type")
          return;
        kind = data.type === "lotuspod:ready" ? "ready" : "escape";
        break;
      default:
        return;
    }
    const state = stateFor(frame);
    if (state.paused)
      return;
    const now = performance.now();
    state.accepted = state.accepted.filter((time) => now - time < 1000);
    if (state.accepted.length >= 60) {
      if (kind === "state" && data.label === "" && !state.themeOwed) {
        state.themeOwed = true;
        setTimeout(() => {
          state.themeOwed = false;
          if (state.paused)
            return;
          state.accepted.push(performance.now());
          postTheme(frame);
        }, 1000 - (now - state.accepted[0]));
      }
      return;
    }
    state.accepted.push(now);
    if (kind === "state" && data.label === "")
      postTheme(frame);
    if (kind === "resize") {
      if (state.expanded)
        return;
      state.height = data.height;
      if (frame.hasAttribute("data-height-fixed"))
        return;
      if (!state.pending) {
        state.pending = true;
        requestAnimationFrame(() => {
          state.pending = false;
          if (!state.paused && !state.expanded && !frame.hasAttribute("data-height-fixed"))
            frame.height = String(state.height);
        });
      }
      return;
    }
    const message = kind === "error" ? data.message : kind === "state" ? data.label : "";
    if (kind === "ready")
      state.ready = true;
    if (kind === "state") {
      if (state.label === message)
        return;
      state.label = message;
    }
    if (kind === "error") {
      state.errors++;
      state.lastError = message;
    }
    frame.dispatchEvent(new CustomEvent(WIDGET, { detail: { kind, message } }));
  });
}
var startComment;
function commentChrome() {
  document.querySelectorAll("figure.artifact-live[data-widget]").forEach((figure) => {
    const frame = figure.querySelector("iframe.artifact-widget");
    const badge = figure.querySelector(".artifact-live-badge");
    if (!frame || !badge || figure.querySelector(":scope > .artifact-live-pin"))
      return;
    const pin = document.createElement("span");
    pin.className = "artifact-live-pin";
    pin.setAttribute("role", "button");
    pin.tabIndex = 0;
    pin.hidden = true;
    figure.append(pin);
    const start = startComment;
    if (!start)
      return;
    const comment = document.createElement("button");
    comment.type = "button";
    comment.className = "artifact-live-comment";
    comment.textContent = "Comment";
    (figure.querySelector(".artifact-live-chrome > .artifact-live-state") ?? badge).after(comment);
    comment.addEventListener("click", () => {
      if (figure.classList.contains("artifact-live--expanded")) {
        figure.querySelector(".artifact-live-expand")?.click();
      }
      const source = frame.dataset.pausedSource || frame.getAttribute("src") || "";
      const hash = /\.w-([0-9a-f]{12})\.html$/.exec(source)?.[1] || "";
      const state = figure.querySelector(".artifact-live-chrome > .artifact-live-state")?.textContent ?? "";
      start({ anchor: { kind: "block", id: figure.dataset.widget, hash, state } });
    });
  });
}
if (typeof holdSwap === "function") {
  holdSwap((nodes) => nodes.some((node) => node.matches("figure.artifact-live--expanded") || node.querySelector("figure.artifact-live--expanded") !== null));
  commentChrome();
  document.addEventListener("lotuspod:swapped", commentChrome);
}
