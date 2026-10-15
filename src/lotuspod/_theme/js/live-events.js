// Built from web/src/live-events.ts by web/build.ts. Edit that file, not this one.
(() => {
  const EVENTS = "/api/events";
  const HELD = "data-lotuspod-events";
  const BACKOFF = 2000;
  const MAX_BACKOFF = 60000;
  const send = (detail) => {
    document.dispatchEvent(new CustomEvent("lotuspod:change", { detail }));
  };
  const holder = () => {
    if (window.top === window)
      return null;
    try {
      const held = window.top.document;
      return held.documentElement.hasAttribute(HELD) ? held : null;
    } catch (ignored) {
      return null;
    }
  };
  const top = holder();
  if (top) {
    const relay = (event) => {
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
  if (typeof EventSource !== "function")
    return;
  document.documentElement.setAttribute(HELD, "");
  let wait = BACKOFF;
  let dropped = false;
  const open = () => {
    const source = new EventSource(EVENTS);
    source.addEventListener("open", () => {
      wait = BACKOFF;
      if (dropped) {
        dropped = false;
        send({ what: "resync", page: null });
      }
    });
    source.addEventListener("change", (event) => {
      let detail = null;
      try {
        detail = JSON.parse(event.data);
      } catch (ignored) {
        return;
      }
      if (!detail || typeof detail !== "object")
        return;
      const { what, page } = detail;
      if (typeof what !== "string")
        return;
      send({ what, page: typeof page === "string" ? page : null });
    });
    source.addEventListener("error", () => {
      dropped = true;
      if (source.readyState !== EventSource.CLOSED)
        return;
      source.close();
      setTimeout(open, wait);
      wait = Math.min(wait * 2, MAX_BACKOFF);
    });
  };
  open();
})();
