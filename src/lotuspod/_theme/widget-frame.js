(function () {
  "use strict";
  function post(data) { parent.postMessage(data, "*"); }
  var last = -1;
  new ResizeObserver(function () {
    var height = Math.ceil(document.documentElement.getBoundingClientRect().height);
    if (height !== last) {
      last = height;
      post({type: "lotuspod:resize", height: height});
    }
  }).observe(document.documentElement);
  window.addEventListener("load", function () { post({type: "lotuspod:ready"}); }, {once: true});
  function error(message) { post({type: "lotuspod:error", message: String(message).slice(0, 200)}); }
  window.addEventListener("error", function (event) { error(event.message); });
  window.addEventListener("unhandledrejection", function (event) { error(event.reason && event.reason.message || event.reason); });
  // Where the reader is, in the widget's words, for the page's chrome and a
  // comment started from the block: cut to 80 characters, never inside a
  // surrogate pair. A new document names none until its widget does.
  function state(label) { post({type: "lotuspod:state", label: String(label).slice(0, 80).replace(/[\uD800-\uDBFF]$/, "")}); }
  // The reader's theme, "night" or "dawn": the system's until the page
  // names it, which it does as this document opens (its opening state) and
  // on each switch. Only the page may name it, in exactly this form. The
  // root's data-lotus-theme picks the --lotus-* set, and a widget drawing on
  // a canvas hears lotuspod:theme on the document to draw again.
  var theme = window.matchMedia("(prefers-color-scheme: light)").matches ? "dawn" : "night";
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (event.source !== parent || !data || typeof data !== "object" || Array.isArray(data) ||
        Object.keys(data).sort().join(",") !== "theme,type" || data.type !== "lotuspod:theme" ||
        (data.theme !== "night" && data.theme !== "dawn")) return;
    document.documentElement.setAttribute("data-lotus-theme", data.theme);
    if (data.theme === theme) return;
    theme = data.theme;
    if (window.lotuspod) window.lotuspod.theme = theme;
    document.dispatchEvent(new CustomEvent("lotuspod:theme", {detail: {theme: theme}}));
  });
  window.lotuspod = {state: state, theme: theme};
  state("");
  window.addEventListener("keydown", function (event) {
    if (event.key === "Escape") post({type: "lotuspod:escape"});
  });
})();
