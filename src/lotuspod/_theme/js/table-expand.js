
  // A top-level table that scrolls inside itself, where the window has free
  // width right of it, gets an Expand button: pressed, the table lifts its
  // --measure-full cap to the room js/tables.js publishes and grows to the
  // right, never past its natural width, up to just short of the comments
  // panel. Its left edge stays put, so nothing above or beside it moves; what
  // is below follows its new height, and the table's top is kept where it was
  // in the window. The button sits in the table's bottom margin and takes no
  // room. The choice is kept per table for the session, and is set aside
  // while the room is too small for it to matter. A table a swap brings in
  // (web/src/page-swap.ts) gets its button as one at load, and takes the
  // choice of the one it replaces at the same place in its section.
  function tableExpand(body) {
    // Each page's expanded tables are kept under this, its path, the table's
    // position among its section's tables and the section's id ("" for the
    // intro).
    var KEPT = "lotuspod:table-expanded:" + location.pathname + ":";
    // How much more room than a table takes is worth a button, in rem.
    var MORE = 4;
    var aside = document.querySelector("aside.artifact-comments-panel");

    function freeId(base) {
      var id = base;
      for (var n = 2; document.getElementById(id); n += 1) {
        id = base + "-" + n;
      }
      return id;
    }

    // Where a table is kept: its place in its section, which a swap
    // elsewhere does not shift.
    function placeOf(table) {
      var parent = table.parentElement;
      var section = parent === body ? "" : parent.getAttribute("data-section");
      return all(":scope > table", parent).indexOf(table) + ":" + section;
    }

    // Whether a table is top-level: in the body, or in a section's wrapper
    // in it.
    function topLevel(table) {
      var parent = table.parentElement;
      return parent === body ||
        (parent.parentElement === body && parent.classList.contains("artifact-section-body"));
    }

    // The choices made on this load, by place, for a table that replaces
    // one where storage refuses them.
    var chosen = {};

    function kept(place) {
      if (Object.prototype.hasOwnProperty.call(chosen, place)) {
        return chosen[place];
      }
      try {
        return sessionStorage.getItem(KEPT + place) === "1";
      } catch (ignored) {
        return false;
      }
    }

    function keep(entry) {
      chosen[entry.place] = entry.expanded;
      try {
        if (entry.expanded) {
          sessionStorage.setItem(KEPT + entry.place, "1");
        } else {
          sessionStorage.removeItem(KEPT + entry.place);
        }
      } catch (ignored) {
        // Storage refused: the table still expands, only unremembered.
      }
    }

    var entries = [];
    // How many tables have had an id given, so a new one is named after
    // them.
    var named = 0;

    function add(table) {
      named += 1;
      if (!table.id) {
        table.id = freeId("table-" + named);
      }
      var holder = element("div", "artifact-table-expand");
      holder.hidden = true;
      var button = element("button", "artifact-table-expand-button");
      button.type = "button";
      button.setAttribute("aria-controls", table.id);
      holder.appendChild(button);
      table.after(holder);
      var place = placeOf(table);
      var entry = { table: table, place: place, holder: holder, button: button, expanded: kept(place) };
      button.addEventListener("click", function () {
        toggle(entry);
      });
      entries.push(entry);
    }

    all("table", body).filter(topLevel).forEach(add);

    // The width each table takes at the reading default and whether it
    // scrolls there, measured on a copy of it set straight in the body, out
    // of the flow, so that a table in a folded section is measured as well
    // and nothing on the page moves.
    function measure() {
      var copies = entries.map(function (entry) {
        var copy = entry.table.cloneNode(true);
        copy.removeAttribute("id");
        copy.classList.remove("artifact-table--expanded");
        copy.setAttribute("aria-hidden", "true");
        copy.style.position = "absolute";
        copy.style.visibility = "hidden";
        copy.style.left = "0";
        copy.style.top = "0";
        body.appendChild(copy);
        return copy;
      });
      var sizes = copies.map(function (copy) {
        return { width: copy.getBoundingClientRect().width, scrolls: copy.scrollWidth > copy.clientWidth };
      });
      copies.forEach(function (copy) {
        copy.remove();
      });
      return sizes;
    }

    // Show each button where its table scrolls and the room exceeds what the
    // table takes by MORE, and set each table as the reader chose where it
    // is shown.
    function fit() {
      var rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      var room = parseFloat(body.style.getPropertyValue("--table-room"));
      var sizes = measure();
      entries.forEach(function (entry, index) {
        var size = sizes[index];
        var shown = size.scrolls && !isNaN(room) && room - size.width >= MORE * rem;
        var wide = shown && entry.expanded;
        entry.holder.hidden = !shown;
        entry.table.classList.toggle("artifact-table--expanded", wide);
        entry.button.textContent = wide ? "Collapse" : "Expand";
        entry.button.setAttribute("aria-expanded", wide ? "true" : "false");
      });
    }

    // Expand or collapse a table, keeping its top where it was in the window.
    // While it changes, scroll anchoring leaves it be: the scroll is set
    // here.
    function toggle(entry) {
      var table = entry.table;
      var before = table.getBoundingClientRect().top;
      table.classList.add("artifact-table--holding");
      entry.expanded = !entry.expanded;
      keep(entry);
      fit();
      var moved = table.getBoundingClientRect().top - before;
      if (moved) {
        window.scrollBy(0, moved);
      }
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          table.classList.remove("artifact-table--holding");
        });
      });
    }

    // A swap drops the tables it took out, with their buttons, and adds the
    // top-level ones it put in.
    document.addEventListener(SWAPPED, function (event) {
      var before = [];
      var after = [];
      event.detail.units.forEach(function (unit) {
        before = before.concat(unit.before);
        after = after.concat(unit.after);
      });
      entries = entries.filter(function (entry) {
        var gone = before.some(function (node) {
          return node === entry.table || node.contains(entry.table);
        });
        if (gone) {
          entry.holder.remove();
        }
        return !gone;
      });
      after.forEach(function (node) {
        if (!(node instanceof Element)) {
          return;
        }
        var tables = node.matches("table") ? [node] : all("table", node);
        tables.filter(topLevel).forEach(add);
      });
      fit();
    });

    fit();
    window.addEventListener("resize", fit);
    if (aside && window.ResizeObserver) {
      new ResizeObserver(fit).observe(aside);
    }
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(fit);
    }
  }

  var expandBody = document.querySelector(".artifact-body");
  if (expandBody) {
    tableExpand(expandBody);
  }
