
  // The diagram view: once Mermaid has drawn a diagram (pre.mermaid), an
  // Expand button in the pre's top right corner opens it in a modal dialog
  // that fills the window. The page's own svg moves into the dialog's stage,
  // so its ids and the listeners js/diagram-cards.js set on its boxes stay as
  // they are, and the pre keeps its height so the page behind holds still.
  // A drag, a two-finger scroll, the arrow keys or the bar's buttons move and
  // zoom it by rewriting the svg's viewBox, so text stays sharp at any zoom;
  // 100% is Mermaid's own size. Fit (or 0, or F) shows it whole again. The
  // dialog's own Escape or its ✕ puts the svg back in its pre, with every
  // attribute the view changed restored, and the focus on its Expand button.
  function diagramView(pres) {
    // The room kept round the diagram at Fit, in px, and the zoom Fit stops at.
    var MARGIN = 24;
    var FIT_MOST = 2;
    var LEAST = 0.25;
    var MOST = 4;
    // A button's or a key's zoom step, and an arrow key's move, in px.
    var STEP = 1.25;
    var MOVE = 60;
    // A wheel's zoom: exp(-deltaY / PINCH).
    var PINCH = 300;
    // The keys that would scroll the page behind.
    var SCROLLING = /^( |Spacebar|PageUp|PageDown|Home|End)$/;
    var OPEN = "artifact-diagram-view-open";
    var dialog = null;
    var parts = null;
    // The diagram shown: its pre, svg and Expand button, where the svg sat,
    // the attributes the view changes as they were, and its natural box.
    var shown = null;
    // The view: the zoom (px per viewBox unit) and the viewBox's top left.
    var zoom = 1;
    var left = 0;
    var top = 0;
    // The pointer dragging the diagram, and where it last was.
    var dragging = null;

    function button(className, text, label) {
      var made = element("button", className, text);
      made.type = "button";
      if (label) {
        made.setAttribute("aria-label", label);
      }
      return made;
    }

    function make() {
      dialog = element("dialog", "artifact-diagram-view");
      dialog.setAttribute("aria-labelledby", "artifact-diagram-view-title");
      var bar = element("div", "artifact-diagram-view-bar");
      var title = element("h2", "artifact-diagram-view-title");
      title.id = "artifact-diagram-view-title";
      var tools = element("div", "artifact-diagram-view-tools");
      var out = button("artifact-diagram-view-zoom-out", "−", "Zoom out");
      var readout = element("output", "artifact-diagram-view-readout");
      readout.setAttribute("aria-label", "Zoom");
      var into = button("artifact-diagram-view-zoom-in", "+", "Zoom in");
      var fit = button("artifact-diagram-view-fit", "Fit");
      var close = button("artifact-diagram-view-close", "✕", "Close");
      tools.append(out, readout, into, fit, close);
      bar.append(title, tools);
      var stage = element("div", "artifact-diagram-view-stage");
      stage.tabIndex = 0;
      stage.setAttribute("role", "group");
      stage.setAttribute("aria-label", "Diagram: drag or use the arrow keys to move, plus and minus to zoom");
      dialog.append(bar, stage);
      document.body.appendChild(dialog);
      parts = { title: title, readout: readout, stage: stage };

      out.addEventListener("click", function () { zoomBy(1 / STEP); });
      into.addEventListener("click", function () { zoomBy(STEP); });
      fit.addEventListener("click", fitAll);
      close.addEventListener("click", function () { dialog.close(); });
      // The dialog closes on Escape itself; what is open under it (a
      // thread's popover or sheet) stays open.
      dialog.addEventListener("keydown", keys);
      dialog.addEventListener("close", restore);
      stage.addEventListener("pointerdown", grab);
      stage.addEventListener("pointermove", drag);
      stage.addEventListener("pointerup", drop);
      stage.addEventListener("pointercancel", drop);
      stage.addEventListener("lostpointercapture", drop);
      stage.addEventListener("wheel", wheel, { passive: false });
      window.addEventListener("resize", function () {
        if (shown) {
          draw();
        }
      });
    }

    // Tab and Shift+Tab go round the dialog's controls, never out of it.
    function keepFocus(event) {
      var stops = all("button, [tabindex='0']", dialog).filter(function (node) {
        return !node.disabled && node.getClientRects().length;
      });
      if (!stops.length) {
        return;
      }
      var first = stops[0];
      var last = stops[stops.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    function keys(event) {
      var key = event.key;
      if (key === "Escape") {
        event.stopPropagation();
        return;
      }
      if (key === "Tab") {
        keepFocus(event);
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }
      var moves = { ArrowLeft: [-MOVE, 0], ArrowRight: [MOVE, 0], ArrowUp: [0, -MOVE], ArrowDown: [0, MOVE] };
      if (key === "+" || key === "=") {
        zoomBy(STEP);
      } else if (key === "-" || key === "_") {
        zoomBy(1 / STEP);
      } else if (key === "0" || key === "f" || key === "F") {
        fitAll();
      } else if (moves[key]) {
        pan(moves[key][0], moves[key][1]);
      } else if (SCROLLING.test(key) && !event.target.closest("button")) {
        // Nothing behind the dialog scrolls; a button keeps its Space.
        event.preventDefault();
        return;
      } else {
        return;
      }
      event.preventDefault();
    }

    function size() {
      return { width: parts.stage.clientWidth, height: parts.stage.clientHeight };
    }

    function clamp(value) {
      return Math.max(LEAST, Math.min(value, MOST));
    }

    function draw() {
      var room = size();
      shown.svg.setAttribute("viewBox", [left, top, room.width / zoom, room.height / zoom].join(" "));
      parts.readout.textContent = Math.round(zoom * 100) + "%";
    }

    // The whole diagram, centred, with MARGIN round it.
    function fitAll() {
      var room = size();
      var box = shown.box;
      zoom = clamp(Math.min((room.width - 2 * MARGIN) / box.width,
        (room.height - 2 * MARGIN) / box.height, FIT_MOST));
      left = box.x + box.width / 2 - room.width / 2 / zoom;
      top = box.y + box.height / 2 - room.height / 2 / zoom;
      draw();
    }

    // Move the diagram by x and y px on the screen.
    function pan(x, y) {
      left -= x / zoom;
      top -= y / zoom;
      draw();
    }

    // Zoom by factor, keeping the diagram's point at x, y in the stage
    // still; by default the stage's centre.
    function zoomBy(factor, x, y) {
      var room = size();
      var atX = x === undefined ? room.width / 2 : x;
      var atY = y === undefined ? room.height / 2 : y;
      var pointX = left + atX / zoom;
      var pointY = top + atY / zoom;
      zoom = clamp(zoom * factor);
      left = pointX - atX / zoom;
      top = pointY - atY / zoom;
      draw();
    }

    function grab(event) {
      if (dragging || (event.pointerType === "mouse" && event.button !== 0)) {
        return;
      }
      dragging = { id: event.pointerId, x: event.clientX, y: event.clientY };
      parts.stage.setPointerCapture(event.pointerId);
      parts.stage.classList.add("artifact-diagram-view-stage--dragging");
    }

    function drag(event) {
      if (!dragging || event.pointerId !== dragging.id) {
        return;
      }
      var x = event.clientX - dragging.x;
      var y = event.clientY - dragging.y;
      dragging.x = event.clientX;
      dragging.y = event.clientY;
      if (x || y) {
        pan(x, y);
      }
    }

    function drop(event) {
      if (!dragging || event.pointerId !== dragging.id) {
        return;
      }
      dragging = null;
      parts.stage.classList.remove("artifact-diagram-view-stage--dragging");
      if (parts.stage.hasPointerCapture(event.pointerId)) {
        parts.stage.releasePointerCapture(event.pointerId);
      }
    }

    // A pinch (ctrl or cmd and a wheel) zooms about the pointer; a scroll
    // moves the diagram with the fingers.
    function wheel(event) {
      event.preventDefault();
      var unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size().height : 1;
      var x = event.deltaX * unit;
      var y = event.deltaY * unit;
      if (event.ctrlKey || event.metaKey) {
        var rect = parts.stage.getBoundingClientRect();
        zoomBy(Math.exp(-y / PINCH), event.clientX - rect.left, event.clientY - rect.top);
      } else if (event.shiftKey && !x) {
        pan(y, 0);
      } else {
        pan(x, y);
      }
    }

    // The nearest shown heading before the diagram, else the page's title.
    function heading(pre) {
      var found = null;
      all("h1, h2, h3, h4, h5, h6", pre.closest("main") || document).forEach(function (node) {
        if ((node.compareDocumentPosition(pre) & Node.DOCUMENT_POSITION_FOLLOWING) &&
            !node.classList.contains("artifact-node-heading") && node.getClientRects().length) {
          found = node;
        }
      });
      found = found || document.querySelector("h1.artifact-title");
      if (!found) {
        return "Diagram";
      }
      var copy = found.cloneNode(true);
      all(UNSEEN, copy).forEach(function (unseen) { unseen.remove(); });
      return copy.textContent.replace(/\s+/g, " ").trim();
    }

    function open(pre, svg, expand) {
      if (!dialog) {
        make();
      }
      var natural = svg.viewBox && svg.viewBox.baseVal;
      var drawn = svg.getBoundingClientRect();
      var box = natural && natural.width && natural.height
        ? { x: natural.x, y: natural.y, width: natural.width, height: natural.height }
        : { x: 0, y: 0, width: drawn.width || 1, height: drawn.height || 1 };
      shown = {
        pre: pre, svg: svg, expand: expand, next: svg.nextSibling, box: box,
        saved: [[svg, "viewBox"], [svg, "width"], [svg, "height"], [svg, "style"], [pre, "style"]].map(function (at) {
          return [at[0], at[1], at[0].getAttribute(at[1])];
        }),
      };
      pre.style.boxSizing = "border-box";
      pre.style.height = pre.getBoundingClientRect().height + "px";
      parts.title.textContent = heading(pre);
      document.documentElement.classList.add(OPEN);
      svg.setAttribute("width", "100%");
      svg.setAttribute("height", "100%");
      svg.setAttribute("style", "display: block; max-width: none; position: absolute; inset: 0;");
      parts.stage.appendChild(svg);
      dialog.showModal();
      fitAll();
      parts.stage.focus({ preventScroll: true });
    }

    function restore() {
      var was = shown;
      shown = null;
      dragging = null;
      parts.stage.classList.remove("artifact-diagram-view-stage--dragging");
      was.pre.insertBefore(was.svg, was.next && was.next.parentNode === was.pre ? was.next : was.expand);
      was.saved.forEach(function (at) {
        if (at[2] === null) {
          at[0].removeAttribute(at[1]);
        } else {
          at[0].setAttribute(at[1], at[2]);
        }
      });
      document.documentElement.classList.remove(OPEN);
      if (was.expand.isConnected) {
        was.expand.focus({ preventScroll: true });
      }
    }

    function add(pre) {
      // Its icon is drawn by the stylesheet, so the pre's one svg stays the
      // diagram.
      var expand = button("artifact-diagram-expand", undefined, "Expand diagram");
      expand.addEventListener("click", function () {
        var svg = pre.querySelector(":scope > svg");
        if (svg && !shown) {
          open(pre, svg, expand);
        }
      });
      pre.appendChild(expand);
    }

    pres.forEach(function (pre) {
      if (pre.querySelector(":scope > svg")) {
        add(pre);
        return;
      }
      // As in js/diagram-cards.js: Mermaid draws on the window's load, and a
      // diagram is drawn once an svg is the pre's own child.
      var watch = new MutationObserver(function () {
        if (pre.querySelector(":scope > svg")) {
          watch.disconnect();
          add(pre);
        }
      });
      watch.observe(pre, { childList: true, subtree: true });
    });
  }

  var viewPres = all("pre.mermaid");
  if (viewPres.length) {
    diagramView(viewPres);
  }
