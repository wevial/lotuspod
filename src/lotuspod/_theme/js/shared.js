
  // What the page script and the old-version script both use, joined into
  // each one's closure (THEME_CLOSURES in cli.py), after js/page-open.js in the
  // page script and first in the old-version script.

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
