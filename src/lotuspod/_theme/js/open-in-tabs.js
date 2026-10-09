// Lotuspod page script: a pod opened on its own. A current page loaded at the
// top level (not framed) over http or https, asked with no version and no
// standalone query, and listed on the index (lotuspod:visible), replaces its
// location with the index its brand link names (index.html is its directory;
// the demo names pages.html), that pod its one tab and the active one, at the
// fragment the page was asked with: #tabs=NAME&on=NAME&at=FRAGMENT, which the
// index script (js/pod-tabs.js) reads. So a pod opened from a link or a
// bookmark has the tabs and the finder too, and the bare page leaves no
// history entry. It goes only once that index answers a HEAD itself, 2xx and
// not redirected: a page rendered with no index beside it, or one whose index
// sends it back to a page (the demo's / and /index.html), stays, as does a
// file opened from disk.
//
// This source opens the page script's one statement: it is a function handed
// the rest, from js/page-open.js to js/page-close.js, and runs that only
// when the page stays, so a load that goes to the index posts nothing, not
// even its opening to the seen route; its frame posts that once it loads.
// The rest waits for the index's answer only on a load that may go.
(function () {
  "use strict";

  // The address this page opens in tabs at, or null when it stays.
  function destination() {
    if (window.top !== window) {
      return null;
    }
    if (location.protocol !== "http:" && location.protocol !== "https:") {
      return null;
    }
    var asked = new URLSearchParams(location.search);
    if (asked.has("version") || asked.has("standalone")) {
      return null;
    }
    var listed = document.querySelector('meta[name="lotuspod:visible"]');
    if (!listed || listed.content.trim().toLowerCase() !== "true") {
      return null;
    }
    var home = document.querySelector("a.artifact-topbar-brand");
    if (!home) {
      return null;
    }
    var index = new URL(home.href);
    if (index.origin !== location.origin || index.pathname === location.pathname) {
      return null;
    }
    var file;
    try {
      file = decodeURIComponent(location.pathname.split("/").pop());
    } catch (ignored) {
      return null;
    }
    var match = /^(.+)\.html$/.exec(file);
    if (!match) {
      return null;
    }
    var name = encodeURIComponent(match[1]);
    var fragment = "#tabs=" + name + "&on=" + name;
    if (location.hash.length > 1) {
      fragment += "&at=" + encodeURIComponent(location.hash.slice(1));
    }
    return index.pathname.replace(/\/index\.html$/, "/") + fragment;
  }

  return function (page) {
    return function () {
      var there = destination();
      if (there === null) {
        page();
        return;
      }
      fetch(there.split("#")[0], { method: "HEAD", credentials: "same-origin", cache: "no-store" })
        .then(function (response) {
          if (response.ok && !response.redirected) {
            location.replace(there);
          } else {
            page();
          }
        }, page);
    };
  };
})()
