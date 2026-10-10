
  // A flowchart followed by a Nodes table (pre[data-node-table], marked at
  // render) becomes a card for each box the table lists. Once Mermaid has
  // drawn the diagram, each listed box is a button: a click, Enter or Space
  // opens the page's one card beside it, filled from the box's row, with
  // what it waits for and what it unblocks read from the diagram's arrows.
  // The hovered or keyboard-focused box, else the one whose card is open,
  // has its arrows drawn again above the boxes in cyan while every other
  // arrow is dimmed. Each box takes its row's status color, unless the
  // author styled it in Mermaid. The heading and table are hidden only when
  // every row names a box the diagram draws, so nothing the author wrote
  // disappears. While a diagram is in its view (js/diagram-view.js), the
  // card opens inside the view's dialog and follows its box as the view
  // moves; Esc there closes the card before the view.
  function diagramCards(pres) {
    // Mermaid 11.4.1's ids: a box's group is flowchart-ID-N and an arrow's
    // path L_START_END_N. Neither carries the diagram's id, so every lookup
    // stays inside its own svg.
    var BOX_ID = /^flowchart-(.+)-\d+$/;
    var ARROW_ID = /^L_(.+)_\d+$/;
    var SVG = "http://www.w3.org/2000/svg";
    // The room kept between the card and its box, and the window's edge, in px.
    var GAP = 12;
    var EDGE = 8;
    var card = null;
    var title = null;
    var link = null;
    var fields = null;
    var graph = null;
    // The box whose card is open, and the one hovered or focused by the reader.
    var opened = null;
    var hovered = null;
    var focused = null;
    // True while the script itself puts focus back on a box.
    var returning = false;
    // Each bound diagram: its svg, boxes by id, arrows and the copies drawn.
    var diagrams = [];

    // A node's words, a space wherever its lines break: at a <br> in an
    // HTML label, and around each SVG <text> or placed <tspan> line.
    function text(node) {
      var pieces = [];
      function walk(at) {
        if (at.nodeType === Node.TEXT_NODE) {
          pieces.push(at.nodeValue);
        } else if (at.nodeType === Node.ELEMENT_NODE) {
          var name = at.localName;
          var line = name === "br" || name === "text" ||
            (name === "tspan" && (at.hasAttribute("x") || at.hasAttribute("y")));
          if (line) {
            pieces.push(" ");
          }
          for (var child = at.firstChild; child; child = child.nextSibling) {
            walk(child);
          }
          if (line) {
            pieces.push(" ");
          }
        }
      }
      if (node) {
        walk(node);
      }
      return pieces.join("").replace(/\s+/g, " ").trim();
    }

    // The box ids of an arrow's two ends: the one split of START_END that
    // names two drawn boxes, else null.
    function ends(path, boxes) {
      var match = ARROW_ID.exec(path.id);
      var found = [];
      if (match) {
        var both = match[1];
        for (var at = both.indexOf("_"); at >= 0; at = both.indexOf("_", at + 1)) {
          var from = both.slice(0, at);
          var to = both.slice(at + 1);
          if (boxes.has(from) && boxes.has(to)) {
            found.push([from, to]);
          }
        }
      }
      return found.length === 1 ? found[0] : null;
    }

    function bind(pre, svg) {
      var table = document.getElementById(pre.dataset.nodeTable);
      if (!table) {
        return;
      }
      var heading = table.previousElementSibling;
      var boxes = new Map();
      all("g.node", svg).forEach(function (group) {
        var match = BOX_ID.exec(group.id);
        if (match && !boxes.has(match[1])) {
          boxes.set(match[1], group);
        }
      });
      // Each arrow's ends, and which way it points: an arrowhead at its end
      // points into `to`, one at its start into `from` (both for A <--> B,
      // neither for a plain line).
      var arrows = [];
      all("path.flowchart-link", svg).forEach(function (path) {
        var pair = ends(path, boxes);
        if (pair) {
          arrows.push({
            path: path, from: pair[0], to: pair[1],
            forward: path.hasAttribute("marker-end"), back: path.hasAttribute("marker-start"),
          });
        }
      });
      // The header and body rows, as render reads them: the header is the
      // first row of the thead, else the first row that starts with a th; a
      // body row is any other outside the thead that starts with a td.
      var every = Array.prototype.slice.call(table.rows);
      var starts = function (row, tag) {
        return row.cells.length > 0 && row.cells[0].tagName === tag;
      };
      var head = table.tHead && table.tHead.rows[0] || every.filter(function (row) {
        return starts(row, "TH");
      })[0];
      var headers = head ? Array.prototype.map.call(head.cells, text) : [];
      var rows = every.filter(function (row) {
        return row !== head && row.parentNode !== table.tHead && starts(row, "TD");
      });
      var diagram = { svg: svg, arrows: arrows, statuses: new Map(), overlays: [] };
      diagrams.push(diagram);
      rows.forEach(function (row) {
        if (row.dataset.node && row.dataset.status) {
          diagram.statuses.set(row.dataset.node, row.dataset.status);
        }
      });
      var drawn = rows.filter(function (row) {
        var id = row.dataset.node;
        var group = id && boxes.get(id);
        if (!group) {
          return false;
        }
        listen({ diagram: diagram, id: id, group: group, row: row, headers: headers });
        return true;
      });
      if (rows.length && drawn.length === rows.length) {
        if (heading && heading.classList.contains("artifact-node-heading")) {
          heading.hidden = true;
        }
        table.hidden = true;
        // The Expand button js/table-expand.js may have put after the table.
        var after = table.nextElementSibling;
        if (after && after.classList.contains("artifact-table-expand")) {
          after.hidden = true;
        }
      }
    }

    // Make a listed box a button that opens its card.
    function listen(box) {
      var group = box.group;
      var status = box.row.dataset.status;
      box.label = text(group.querySelector(".nodeLabel")) || text(group) || box.id;
      group.classList.add("artifact-node");
      // A box styled in Mermaid itself (style, class or :::) keeps that look:
      // Mermaid 11.4.1 writes it on the shape's style, empty otherwise.
      var shape = group.querySelector(":scope > .label-container");
      if (status && !(shape && shape.getAttribute("style"))) {
        group.classList.add("artifact-node--" + status);
      }
      group.setAttribute("tabindex", "0");
      group.setAttribute("role", "button");
      group.setAttribute("aria-expanded", "false");
      group.setAttribute("aria-label", status ? box.label + ", " + status : box.label);
      group.addEventListener("click", function () {
        open(box);
      });
      group.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open(box);
        }
      });
      group.addEventListener("mouseenter", function () {
        hovered = box;
        light();
      });
      group.addEventListener("mouseleave", function () {
        if (hovered === box) {
          hovered = null;
          light();
        }
      });
      group.addEventListener("focus", function () {
        if (!returning) {
          focused = box;
          light();
        }
      });
      group.addEventListener("blur", function () {
        if (focused === box) {
          focused = null;
          light();
        }
      });
    }

    // A marker drawn in cyan beside the one an arrow ends in, made once.
    function marker(svg, reference) {
      var match = /^url\(["']?#(.+?)["']?\)$/.exec(reference || "");
      var original = match && all("marker", svg).filter(function (node) {
        return node.id === match[1];
      })[0];
      if (!original) {
        return null;
      }
      var id = original.id + "-lit";
      var made = all("marker", svg).filter(function (node) { return node.id === id; })[0];
      if (!made) {
        made = original.cloneNode(true);
        made.id = id;
        made.classList.add("artifact-node-marker");
        original.after(made);
      }
      return "url(#" + id + ")";
    }

    function copy(path, className, markers) {
      var made = path.cloneNode(false);
      made.removeAttribute("id");
      made.removeAttribute("style");
      made.setAttribute("class", className);
      ["marker-start", "marker-end"].forEach(function (name) {
        var reference = path.getAttribute(name);
        made.removeAttribute(name);
        var lit = markers && reference && marker(path.ownerSVGElement, reference);
        if (lit) {
          made.setAttribute(name, lit);
        }
      });
      return made;
    }

    // Draw the highlighted box's arrows, or none.
    function light() {
      var box = hovered || focused || opened;
      diagrams.forEach(function (diagram) {
        diagram.overlays.forEach(function (overlay) { overlay.remove(); });
        diagram.overlays = [];
        diagram.svg.classList.remove("artifact-diagram--lit");
      });
      if (!box) {
        return;
      }
      var diagram = box.diagram;
      diagram.svg.classList.add("artifact-diagram--lit");
      // Each copy goes in its original's own g.root, after that root's
      // g.nodes, so it keeps the original's coordinate space and paints above
      // the boxes.
      var layers = new Map();
      diagram.arrows.forEach(function (arrow) {
        if (arrow.from !== box.id && arrow.to !== box.id) {
          return;
        }
        var root = arrow.path.closest("g.root");
        var nodes = root && all(":scope > g.nodes", root)[0];
        if (!nodes) {
          return;
        }
        var layer = layers.get(root);
        if (!layer) {
          layer = document.createElementNS(SVG, "g");
          layer.setAttribute("class", "artifact-node-arrows");
          nodes.after(layer);
          layers.set(root, layer);
          diagram.overlays.push(layer);
        }
        layer.append(copy(arrow.path, "artifact-node-arrow-halo", false),
          copy(arrow.path, "artifact-node-arrow", true));
      });
    }

    function named(diagram, ids) {
      if (!ids.length) {
        return "nothing";
      }
      return ids.map(function (id) {
        var status = diagram.statuses.get(id);
        return status ? id + " (" + status + ")" : id;
      }).join(", ");
    }

    function build() {
      card = element("div", "artifact-node-card");
      card.id = "artifact-node-card";
      card.hidden = true;
      card.tabIndex = -1;
      card.setAttribute("role", "dialog");
      card.setAttribute("aria-labelledby", "artifact-node-card-title");
      var top = element("div", "artifact-node-card-head");
      title = element("h3", "artifact-node-card-title");
      title.id = "artifact-node-card-title";
      var close = element("button", "artifact-node-card-close", "✕");
      close.type = "button";
      close.setAttribute("aria-label", "Close");
      close.addEventListener("click", function () {
        shut(true);
      });
      top.append(title, close);
      link = element("p", "artifact-node-card-link");
      fields = element("dl", "artifact-node-card-fields");
      graph = element("dl", "artifact-node-card-graph");
      card.append(top, link, fields, graph);
      document.body.appendChild(card);
    }

    function fill(box) {
      var cells = Array.prototype.slice.call(box.row.cells);
      var anchor = box.row.querySelector("a[href]");
      var linked = anchor ? anchor.closest("td, th") : null;
      title.textContent = box.label;
      link.textContent = "";
      link.hidden = !anchor;
      if (anchor) {
        var made = element("a", "", anchor.textContent);
        made.href = anchor.getAttribute("href");
        link.appendChild(made);
      }
      fields.textContent = "";
      cells.slice(1).forEach(function (cell, index) {
        // Every column after the id, an empty one too; the link's cell is the
        // card's link instead.
        if (cell === linked) {
          return;
        }
        fields.append(element("dt", "", box.headers[index + 1] || ""), element("dd", "", text(cell)));
      });
      fields.hidden = !fields.firstChild;
      var diagram = box.diagram;
      var waits = [];
      var unblocks = [];
      var add = function (list, id) {
        if (list.indexOf(id) < 0) {
          list.push(id);
        }
      };
      // An arrowhead at a box means the box waits for the other end.
      diagram.arrows.forEach(function (arrow) {
        if (arrow.forward && arrow.to === box.id) {
          add(waits, arrow.from);
        }
        if (arrow.forward && arrow.from === box.id) {
          add(unblocks, arrow.to);
        }
        if (arrow.back && arrow.from === box.id) {
          add(waits, arrow.to);
        }
        if (arrow.back && arrow.to === box.id) {
          add(unblocks, arrow.from);
        }
      });
      graph.textContent = "";
      graph.append(
        element("dt", "", "Waits for"), element("dd", "", named(diagram, waits)),
        element("dt", "", "Unblocks"), element("dd", "", named(diagram, unblocks)));
    }

    // Set the card beside its box: on the right where the window has room,
    // else on the left, else below (or above), always inside the window. In
    // the page it is set in the page's coordinates, in the view's dialog,
    // which fills the window, in the window's.
    function place() {
      if (!opened || card.hidden) {
        return;
      }
      var rect = opened.group.getBoundingClientRect();
      var width = card.offsetWidth;
      var height = card.offsetHeight;
      var wide = document.documentElement.clientWidth;
      var tall = window.innerHeight;
      var clamp = function (value, low, high) { return Math.max(low, Math.min(value, high)); };
      var left;
      var top;
      if (rect.right + GAP + width <= wide - EDGE) {
        left = rect.right + GAP;
      } else if (rect.left - GAP - width >= EDGE) {
        left = rect.left - GAP - width;
      }
      if (left !== undefined) {
        top = clamp(rect.top, EDGE, tall - height - EDGE);
      } else {
        left = clamp(rect.left, EDGE, wide - width - EDGE);
        top = rect.bottom + GAP + height <= tall - EDGE ? rect.bottom + GAP
          : rect.top - GAP - height >= EDGE ? rect.top - GAP - height
            : clamp(rect.bottom + GAP, EDGE, tall - height - EDGE);
      }
      var paged = card.parentNode === document.body;
      card.style.left = Math.round(left + (paged ? window.scrollX : 0)) + "px";
      card.style.top = Math.round(top + (paged ? window.scrollY : 0)) + "px";
    }

    function open(box) {
      if (!card) {
        build();
      }
      if (opened && opened !== box) {
        opened.group.setAttribute("aria-expanded", "false");
      }
      opened = box;
      box.group.setAttribute("aria-expanded", "true");
      fill(box);
      // The card's place: the dialog its box is in, as the modal view makes
      // the rest of the page inert, else the page.
      var parent = box.group.closest("dialog") || document.body;
      if (card.parentNode !== parent) {
        parent.appendChild(card);
      }
      card.hidden = false;
      place();
      card.focus({ preventScroll: true });
      light();
    }

    // Close the card; back, put focus on its box again.
    function shut(back) {
      if (!opened) {
        return;
      }
      var box = opened;
      opened = null;
      card.hidden = true;
      box.group.setAttribute("aria-expanded", "false");
      if (back) {
        returning = true;
        box.group.focus({ preventScroll: true });
        returning = false;
      }
      light();
    }

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && opened) {
        event.preventDefault();
        shut(true);
      }
    });
    // The view's dialog keeps Esc from the page, so a card open in it is
    // closed here first, and the canceled key leaves the view open.
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && opened && card.parentNode !== document.body) {
        event.preventDefault();
        event.stopPropagation();
        shut(true);
      }
    }, true);
    // The view closing, by Esc or its ✕, closes the card in it and puts the
    // card back in the page. A close event does not bubble, so it is caught
    // on its way down.
    document.addEventListener("close", function (event) {
      if (card && event.target.contains(card)) {
        shut(false);
        document.body.appendChild(card);
      }
    }, true);
    // A click on a listed box opens its own card; one anywhere else outside
    // the card closes it.
    document.addEventListener("click", function (event) {
      var target = event.target;
      if (!opened || !target || !target.closest || card.contains(target)) {
        return;
      }
      var group = target.closest("g.artifact-node");
      if (!group) {
        shut(false);
      }
    });
    window.addEventListener("resize", place);
    document.addEventListener(MOVED, place);
    // The card is set in the page, so a scroll of the page would carry it
    // out of the window: it is set again, beside its box as far as the
    // window lets it be.
    window.addEventListener("scroll", place, { passive: true });

    pres.forEach(function (pre) {
      pre.addEventListener("scroll", place);
      var svg = pre.querySelector(":scope > svg");
      if (svg) {
        bind(pre, svg);
        return;
      }
      // Mermaid draws on the window's load, after this script has run. It
      // draws in a holder inside the pre, then sets the finished svg in the
      // pre's place: an svg is drawn once it is the pre's own child.
      var watch = new MutationObserver(function () {
        var drawn = pre.querySelector(":scope > svg");
        if (drawn) {
          watch.disconnect();
          bind(pre, drawn);
        }
      });
      watch.observe(pre, { childList: true, subtree: true });
    });
  }

  var diagramPres = all("pre.mermaid[data-node-table]");
  if (diagramPres.length) {
    diagramCards(diagramPres);
  }
