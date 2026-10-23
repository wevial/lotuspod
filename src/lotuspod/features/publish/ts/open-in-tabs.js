// Lotuspod page script: a pod opened on its own. A current page loaded at the
// top level (not framed) over http or https, asked with no version and no
// standalone query, and listed on the index (lotuspod:visible), replaces its
// location with the index its brand link names (index.html is its directory;
// the demo names pages.html), that pod its one tab and the active one, at the
// fragment the page holds then: #tabs=NAME&on=NAME&at=FRAGMENT, which the
// index script (js/pod-tabs.js) reads. So a pod opened from a link or a
// bookmark has the tabs and the finder too, and the bare page leaves no
// history entry. It goes only once that index answers itself, 2xx and not
// redirected, however long it takes, with a row for this pod in its
// listing, as pod-tabs.js reads it: a page rendered with no index beside
// it, one the index does not list yet, one whose index sends it back to a
// page (the demo's / and /index.html) or cannot be read, stays, as does a
// file opened from disk.
//
// This source opens the page script's one statement: it is a function handed
// the rest, the closure the join opens just after it and closes after the
// last source (THEME_CLOSURES in cli.py), and runs that only when the page
// stays, so a load that goes to the index posts nothing, not
// even its opening to the seen route; its frame posts that once it loads.
// The rest waits for the index's answer only on a load that may go.
(function () {
  "use strict";

  // The index this page may open in, its name and its file, or null when
  // it stays.
  function candidate() {
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
    return { index: index.pathname.replace(/\/index\.html$/, "/"), name: match[1] };
  }

  // Whether the index's listing has a row for the pod, with its link.
  function lists(html, name) {
    var listing = new DOMParser().parseFromString(html, "text/html");
    return Array.prototype.some.call(listing.querySelectorAll(".index-table tbody tr[data-page]"),
      function (row) {
        return row.dataset.page === name && Boolean(row.cells[0] && row.cells[0].querySelector("a[href]"));
      });
  }

  return function (page) {
    return function () {
      var there = candidate();
      if (there === null) {
        page();
        return;
      }
      fetch(there.index, { credentials: "same-origin", cache: "no-store" })
        .then(function (response) {
          if (!response.ok || response.redirected) {
            return false;
          }
          return response.text().then(function (html) { return lists(html, there.name); });
        })
        .then(function (go) {
          if (!go) {
            page();
            return;
          }
          // The fragment the page holds now, a link followed while the index
          // answered included.
          var name = encodeURIComponent(there.name);
          var fragment = "#tabs=" + name + "&on=" + name;
          if (location.hash.length > 1) {
            fragment += "&at=" + encodeURIComponent(location.hash.slice(1));
          }
          location.replace(there.index + fragment);
        }, function () {
          page();
        });
    };
  };
})()
