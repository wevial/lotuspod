
  // The tab a link opens in. A link to the page's own site (a relative path,
  // an `#anchor` or an absolute URL on this origin) opens in the same tab;
  // any other http(s) link in a new one, with no opener and no referrer. The
  // origin is only known here, in the browser, so a comment's links
  // (js/comment-markdown.js) and the page body's own take their tab from
  // this, the body's once at load: a newer revision reloads the page
  // (js/live-page.js) rather than swapping its body. A body link that names
  // its own target keeps it.
  function linkTab(link) {
    var url;
    try {
      url = new URL(link.getAttribute("href"), location.href);
    } catch (ignored) {
      return;
    }
    if (url.origin === location.origin || !/^https?:$/.test(url.protocol)) {
      return;
    }
    link.target = "_blank";
    link.relList.add("noopener", "noreferrer");
  }

  all(".artifact-body a[href]:not([target])").forEach(linkTab);
