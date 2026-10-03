
  // The open comments panel's width, set by the reader from a handle on its
  // left edge (a separator): dragged, or a rem at a time with Left Arrow to
  // widen and Right Arrow to narrow. It stays between MIN_WIDTH and the
  // window's maximum: MAX_WIDTH, at most MAX_SHARE of the window, and never
  // so wide that the reading column keeps less than COLUMN_MIN up to the
  // panel. The column narrows as the
  // panel grows into it (css/base.css, from the room js/tables.js publishes).
  // The width is kept for every page under WIDTH; a stored width the window
  // has no room for is shown clamped and kept as stored, so a wider window
  // opens it again. A double-click goes back to DEFAULT_WIDTH and forgets the
  // stored width. The panel's width is the custom property PANEL_WIDTH on the
  // aside, in rem. While the width changes the reader's place is kept: the
  // block at the window's top stays where it was as the column reflows. The
  // browser's own scroll anchoring stands aside for a change to the width
  // of the column it reflows in, so the page script does it.
  var WIDTH = "lotuspod:comments-width";
  var PANEL_WIDTH = "--comments-panel-width";
  var DEFAULT_WIDTH = 20;
  var MIN_WIDTH = 16;
  var MAX_WIDTH = 40;
  // The most of the window's width the panel takes: 40rem in a 1920 pixel
  // window, 30rem in a 1440 pixel one.
  var MAX_SHARE = 1 / 3;
  // The column's narrowest, and the gutter js/tables.js leaves before the
  // panel, in rem.
  var COLUMN_MIN = 32;
  var COLUMN_GUTTER = 1;
  var RESIZING = "artifact-comments-panel--resizing";

  function panelResize(aside) {
    var column = document.querySelector(".artifact-body");
    // The reader's width, and the width shown, in rem.
    var wanted = DEFAULT_WIDTH;
    var width = DEFAULT_WIDTH;
    var drag = null;

    try {
      var stored = parseFloat(localStorage.getItem(WIDTH));
      if (isFinite(stored) && stored > 0) {
        wanted = stored;
      }
    } catch (ignored) {
      wanted = DEFAULT_WIDTH;
    }

    function rem() {
      return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    }

    // The widest the window now allows, in rem.
    function widest() {
      var size = rem();
      var left = column ? column.getBoundingClientRect().left : 0;
      var across = document.documentElement.clientWidth;
      var room = (across - left) / size - COLUMN_MIN - COLUMN_GUTTER;
      return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, across * MAX_SHARE / size, room));
    }

    function rounded(value) {
      return String(Math.round(value * 100) / 100);
    }

    function remember(value) {
      try {
        if (value === null) {
          localStorage.removeItem(WIDTH);
        } else {
          localStorage.setItem(WIDTH, rounded(value));
        }
      } catch (ignored) {
        // Storage refused: the panel still resizes, only unremembered.
      }
    }

    var handle = element("div", "artifact-comments-resize");
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "vertical");
    handle.setAttribute("aria-label", "Resize comments");
    handle.setAttribute("aria-valuemin", String(MIN_WIDTH));
    handle.tabIndex = 0;
    aside.insertBefore(handle, aside.firstChild);

    // The reader's place: the deepest block of the column that crosses the
    // window's top or is the first below it, and its top then.
    var place = null;
    var watching = false;

    function anchorIn(parent) {
      for (var child = parent.firstElementChild; child; child = child.nextElementSibling) {
        var rect = child.getBoundingClientRect();
        if (!rect.height || rect.bottom <= 0) {
          continue;
        }
        return rect.top >= 0 ? child : anchorIn(child) || child;
      }
      return null;
    }

    // Keep the place until the width has stopped changing: no drag and no
    // transition, for two frames, so the column's last reflow is followed.
    function hold() {
      if (!place && column && window.scrollY > 0) {
        var node = anchorIn(column);
        place = node ? { node: node, top: node.getBoundingClientRect().top } : null;
      }
      if (!place || watching) {
        return;
      }
      watching = true;
      var quiet = 0;
      requestAnimationFrame(function tick() {
        quiet = drag || aside.getAnimations().length ? 0 : quiet + 1;
        if (quiet < 2) {
          requestAnimationFrame(tick);
          return;
        }
        watching = false;
        place = null;
      });
    }

    // After each reflow of the column, before it is drawn, scroll the place
    // back to where it was.
    if (column && window.ResizeObserver) {
      new ResizeObserver(function () {
        if (!place || !place.node.isConnected) {
          return;
        }
        var moved = place.node.getBoundingClientRect().top - place.top;
        if (Math.abs(moved) >= 0.5) {
          window.scrollTo({ top: window.scrollY + moved, behavior: "instant" });
        }
      }).observe(column);
    }

    // Show a width, clamped to what the window allows.
    function show(next) {
      var most = widest();
      var was = width;
      width = Math.max(MIN_WIDTH, Math.min(most, next));
      if (width !== was) {
        hold();
      }
      aside.style.setProperty(PANEL_WIDTH, width + "rem");
      handle.setAttribute("aria-valuenow", rounded(width));
      handle.setAttribute("aria-valuemax", rounded(most));
    }

    // The width the page loads with is set without the panel sliding to it.
    aside.classList.add(RESIZING);
    show(wanted);
    void aside.offsetWidth;
    aside.classList.remove(RESIZING);

    handle.addEventListener("pointerdown", function (event) {
      if (event.button !== 0) {
        return;
      }
      // No text is selected while dragging; the handle is focused as a
      // press would.
      event.preventDefault();
      handle.focus({ preventScroll: true });
      handle.setPointerCapture(event.pointerId);
      drag = { pointer: event.pointerId, x: event.clientX, from: width, moved: false };
      aside.classList.add(RESIZING);
    });
    handle.addEventListener("pointermove", function (event) {
      if (!drag || event.pointerId !== drag.pointer) {
        return;
      }
      drag.moved = true;
      show(drag.from + (drag.x - event.clientX) / rem());
      wanted = width;
    });
    function end(event) {
      if (!drag || event.pointerId !== drag.pointer) {
        return;
      }
      var moved = drag.moved;
      drag = null;
      aside.classList.remove(RESIZING);
      if (moved) {
        remember(width);
      }
    }
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    handle.addEventListener("lostpointercapture", end);

    handle.addEventListener("keydown", function (event) {
      var step = event.key === "ArrowLeft" ? 1 : event.key === "ArrowRight" ? -1 : 0;
      if (!step) {
        return;
      }
      event.preventDefault();
      show(width + step);
      wanted = width;
      remember(width);
    });

    handle.addEventListener("dblclick", function () {
      wanted = DEFAULT_WIDTH;
      show(wanted);
      remember(null);
    });

    window.addEventListener("resize", function () {
      show(wanted);
    });
  }

  var resizable = document.querySelector("aside.artifact-comments-panel");
  if (resizable) {
    panelResize(resizable);
  }
