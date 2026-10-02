
  // A top-level table that scrolls inside itself, where the window has free
  // width right of it, gets an Expand button: pressed, the table lifts its
  // --measure-full cap to the room js/tables.js publishes and grows to the
  // right, never past its natural width, up to just short of the comments
  // panel. Its left edge stays put, so nothing above or beside it moves; what
  // is below follows its new height, and the table's top is kept where it was
  // in the window. The button sits in the table's bottom margin and takes no
  // room. The choice is kept per table for the session, and is set aside
  // while the room is too small for it to matter.
  function tableExpand(body, tables) {
    // Each page's expanded tables are kept under this, its path and the
    // table's index.
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

    function kept(index) {
      try {
        return sessionStorage.getItem(KEPT + index) === "1";
      } catch (ignored) {
        return false;
      }
    }

    function keep(entry) {
      try {
        if (entry.expanded) {
          sessionStorage.setItem(KEPT + entry.index, "1");
        } else {
          sessionStorage.removeItem(KEPT + entry.index);
        }
      } catch (ignored) {
        // Storage refused: the table still expands, only unremembered.
      }
    }

    var entries = tables.map(function (table, index) {
      if (!table.id) {
        table.id = freeId("table-" + (index + 1));
      }
      var holder = element("div", "artifact-table-expand");
      holder.hidden = true;
      var button = element("button", "artifact-table-expand-button");
      button.type = "button";
      button.setAttribute("aria-controls", table.id);
      holder.appendChild(button);
      table.after(holder);
      var entry = { table: table, index: index, holder: holder, button: button, expanded: kept(index) };
      button.addEventListener("click", function () {
        toggle(entry);
      });
      return entry;
    });

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
  var expandTables = expandBody ? all(":scope > table, :scope > .artifact-section-body > table", expandBody) : [];
  if (expandTables.length) {
    tableExpand(expandBody, expandTables);
  }
