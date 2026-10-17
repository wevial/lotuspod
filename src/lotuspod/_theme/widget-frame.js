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
  window.addEventListener("keydown", function (event) {
    if (event.key === "Escape") post({type: "lotuspod:escape"});
  });
})();
