// Lotuspod page and index script: serve's change stream. Each browser tab
// holds one EventSource on /api/events, and each "change" it carries,
// {what, page}, is sent on the document as "lotuspod:change", whose
// listeners run the checks they already have at once
// (features/live/ts/live-page.js, the comments island,
// features/index/ts/pod-tabs.js and the index's own script). Their schedules
// stay, so a stream refused, dropped or blocked leaves the page as it was
// without it.
//
// The browser opens a stream that ends again itself, after the stream's
// retry. One it closes (an HTTP error: 503 past serve's cap, 401 once signed
// out, 404 with no database) is opened again here after a backoff: BACKOFF
// ms, doubled each time up to MAX_BACKOFF, and BACKOFF again once a stream
// opens. A stream that opens again after a drop sends {what: "resync",
// page: null} once, since ticks may have been missed while it was down; the
// first open sends nothing, as the page has just loaded. The stream stays
// open while the tab is hidden, as the revision check does. It opens once
// the document has loaded (the index's once its frames have), so it never
// competes with the page's own loading for the browser's connections.
//
// A page framed in a same-origin window whose document holds the stream (the
// index's tabs, features/index/ts/pod-tabs.js) opens none of its own: it sends
// each tick that document gets again on its own, until its pagehide.
(() => {
  const EVENTS = "/api/events";
  const HELD = "data-lotuspod-events";
  const BACKOFF = 2000;
  const MAX_BACKOFF = 60000;

  const send = (detail: LotuspodChangeDetail): void => {
    document.dispatchEvent(new CustomEvent("lotuspod:change", { detail }));
  };

  // The top window's document when it holds the stream, else null.
  const holder = (): Document | null => {
    if (window.top === window) return null;
    try {
      const held = window.top!.document;
      return held.documentElement.hasAttribute(HELD) ? held : null;
    } catch (ignored) {
      return null;
    }
  };

  const top = holder();
  if (top) {
    const relay = (event: CustomEvent<LotuspodChangeDetail>): void => {
      const { what, page } = event.detail;
      send({ what, page });
    };
    top.addEventListener("lotuspod:change", relay);
    window.addEventListener("pagehide", () => top.removeEventListener("lotuspod:change", relay));
    window.addEventListener("pageshow", (event) => {
      if (event.persisted) {
        top.addEventListener("lotuspod:change", relay);
        send({ what: "resync", page: null });
      }
    });
    return;
  }
  if (typeof EventSource !== "function") return;
  document.documentElement.setAttribute(HELD, "");

  let wait = BACKOFF;
  let dropped = false;

  const open = (): void => {
    const source = new EventSource(EVENTS);
    source.addEventListener("open", () => {
      wait = BACKOFF;
      if (dropped) {
        dropped = false;
        send({ what: "resync", page: null });
      }
    });
    source.addEventListener("change", (event) => {
      let detail: unknown = null;
      try {
        detail = JSON.parse((event as MessageEvent<string>).data);
      } catch (ignored) {
        return;
      }
      if (!detail || typeof detail !== "object") return;
      const { what, page } = detail as { what?: unknown; page?: unknown };
      if (typeof what !== "string") return;
      send({ what, page: typeof page === "string" ? page : null });
    });
    source.addEventListener("error", () => {
      dropped = true;
      // Still CONNECTING: the browser opens it again itself.
      if (source.readyState !== EventSource.CLOSED) return;
      source.close();
      setTimeout(open, wait);
      wait = Math.min(wait * 2, MAX_BACKOFF);
    });
  };
  if (document.readyState === "complete") open();
  else window.addEventListener("load", open, { once: true });
})();
