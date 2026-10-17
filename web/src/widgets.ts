// Only the WindowProxy of a widget on this page can speak for it.
var WIDGET: "lotuspod:widget" = "lotuspod:widget";
interface WidgetState {
  ready: boolean;
  errors: number;
  lastError: string;
  accepted: number[];
  height?: number;
  pending: boolean;
}
const widgetStates = new WeakMap<HTMLIFrameElement, WidgetState>();
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
  let state = widgetStates.get(frame);
  if (!state) {
    state = {ready: false, errors: 0, lastError: "", accepted: [], pending: false};
    widgetStates.set(frame, state);
  }
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
        frame.height = String(state.height);
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
