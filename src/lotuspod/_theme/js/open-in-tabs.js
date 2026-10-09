// Lotuspod page script: a pod opened on its own. A current page loaded at the
// top level (not framed) over http or https, asked with no version and no
// standalone query, listed on the index (lotuspod:visible), and whose brand
// link names index.html beside it, replaces its location with that index's
// directory, that pod its one tab and the active one, at the fragment
// the page was asked with: #tabs=NAME&on=NAME&at=FRAGMENT, which the index
// script (js/pod-tabs.js) reads. So a pod opened from a link or a bookmark
// has the tabs and the finder too, and the bare page leaves no history entry.
// A file opened from disk has no index to go to, and a page whose brand link
// names another index (the demo's pages.html, whose / comes back to a page)
// stays where it is.
//
// This source opens the page script's one statement: the rest of it, from
// js/page-open.js to js/page-close.js, runs only when the page stays, so a
// load that goes to the index posts nothing, not even its opening to the
// seen route; its frame posts that once it loads.
if (!(function () {
  "use strict";

  if (window.top !== window) {
    return false;
  }
  if (location.protocol !== "http:" && location.protocol !== "https:") {
    return false;
  }
  var asked = new URLSearchParams(location.search);
  if (asked.has("version") || asked.has("standalone")) {
    return false;
  }
  var listed = document.querySelector('meta[name="lotuspod:visible"]');
  if (!listed || listed.content.trim().toLowerCase() !== "true") {
    return false;
  }
  var home = document.querySelector("a.artifact-topbar-brand");
  if (!home || home.href !== new URL("index.html", location.href).href) {
    return false;
  }
  var file;
  try {
    file = decodeURIComponent(location.pathname.split("/").pop());
  } catch (ignored) {
    return false;
  }
  var match = /^(.+)\.html$/.exec(file);
  if (!match) {
    return false;
  }
  var name = encodeURIComponent(match[1]);
  var fragment = "#tabs=" + name + "&on=" + name;
  if (location.hash.length > 1) {
    fragment += "&at=" + encodeURIComponent(location.hash.slice(1));
  }
  location.replace(new URL(".", location.href).pathname + fragment);
  return true;
})())
