
  // A top-level table steps out of the reading column (css/prose.css), but
  // the comments panel is fixed over the margin it steps into. The room such
  // a table has is published on the body as --table-room: from the body's
  // content edge to the panel's left edge, or the window's when no panel is
  // shown, less a 1rem gutter. It is read again as the window resizes and as
  // the panel's box changes: shown, hidden, opened or folded, and every frame
  // of its width transition, so the tables follow it. The reading column is
  // kept inside the same room (css/base.css), so a panel widened into it
  // (js/panel-resize.js) narrows the column as well as its tables.
  function tableRoom(body) {
    var aside = document.querySelector("aside.artifact-comments-panel");

    function measure() {
      var rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      var edge = document.documentElement.clientWidth;
      var panel = aside && aside.getBoundingClientRect();
      if (panel && panel.width > 0) {
        edge = Math.min(edge, panel.left);
      }
      var start = body.getBoundingClientRect().left + (parseFloat(getComputedStyle(body).paddingLeft) || 0);
      body.style.setProperty("--table-room", Math.max(0, Math.floor(edge - start - rem)) + "px");
    }

    measure();
    window.addEventListener("resize", measure);
    if (aside && window.ResizeObserver) {
      new ResizeObserver(measure).observe(aside);
    }
  }

  var tableBody = document.querySelector(".artifact-body");
  if (tableBody) {
    tableRoom(tableBody);
  }
