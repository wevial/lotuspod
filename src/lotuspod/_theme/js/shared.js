
  // What the page script and the old-version script both use, joined just
  // after each one's opening source (js/page-open.js, js/old-version-open.js).

  // A stamp as the reader's locale writes a date and time; the stamp itself
  // when it is no date.
  function when(stamp) {
    var date = new Date(stamp);
    if (isNaN(date.getTime())) {
      return String(stamp);
    }
    return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }
