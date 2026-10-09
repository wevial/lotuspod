
  // The page's versions (lotuspod.versions): a page with a revision asks the
  // versions route once. When it answers 200, even with no versions (a
  // directory that is not the top of its own repository has none), the
  // header's date line gains a
  // "Versions · N" link to #versions, and while the hash is #versions the
  // page shows its versions view in place of its header and body: a
  // breadcrumb back to the page, the heading, and the versions newest first,
  // each with its date and time, a note under it saying what it changed (its
  // summary, "First version" when it has none), the current one marked and
  // every other with a "View" link to its read-only old version
  // (NAME.html?version=COMMIT).
  // The list shows SHOWN entries, and "Show older versions" shows SHOWN more
  // each time. Any other answer leaves the page as it is: no link, no view.
  //
  // When the reader last opened the page at another revision (live.previous,
  // from the seen route), the page asks the changes route what changed since.
  // Unless it answers changed: false or fails, a box under the header says
  // when that version was published, how many versions ago, and which
  // sections changed, were added or were removed, with "See the full diff"
  // and "Dismiss"; each changed or added section's heading gains a "changed"
  // or "new" tag. The versions view then shows a pane beside the list
  // comparing that version with the current one, a line diff of the source
  // or else the sections, and marks its entry "you last looked".
  function pageVersions() {
    var VERSIONS = "/api/versions";
    var CHANGES = "/api/changes";
    var HASH = "#versions";
    var SHOWN = 20;
    var NO_SOURCE = "This page has no kept source for that version, so it compares by section.";
    // What the comparison calls the text before the first h2, the whole
    // text of a body without one (lotuspod.versions.PAGE_TEXT).
    var PAGE_TEXT = "The page text";
    var stamp = document.querySelector('meta[name="lotuspod:revision"]');
    var line = document.querySelector("header.artifact-header .artifact-meta");
    var main = document.querySelector("main.artifact");
    if (!stamp || !stamp.content.trim() || !line || !main) {
      return;
    }
    var named = document.querySelector("[data-page]");
    var page = named ? named.dataset.page :
      decodeURIComponent(location.pathname.split("/").pop()).replace(/\.html$/, "");
    var title = document.querySelector(".artifact-title");
    var own = stamp.content.trim();

    // The changes route's answer since the revision the reader last opened
    // the page at, when anything changed; else null.
    var changes = live.previous().then(async function (previous) {
      if (!previous || previous === own) {
        return null;
      }
      var response = await fetch(CHANGES + "?page=" + encodeURIComponent(page) +
        "&since=" + encodeURIComponent(previous));
      var payload = response.status === 200 ? await json(response) : null;
      return payload && payload.changed === true && payload.since && payload.sections ?
        payload : null;
    }).catch(function () {
      return null;
    });

    function plural(count, noun) {
      return count + " " + noun + (count === 1 ? "" : "s");
    }

    function stamped(date, className) {
      var time = element("time", className, when(date));
      time.setAttribute("datetime", date);
      return time;
    }

    // One item per changed, added or removed section, each changed or added
    // one a link to its section.
    function sectionList(sections) {
      var list = element("ul", "artifact-changes-list");
      [["changed", "Changed"], ["added", "New"], ["removed", "Removed"]].forEach(function (kind) {
        (Array.isArray(sections[kind[0]]) ? sections[kind[0]] : []).forEach(function (section) {
          var item = element("li", "artifact-changes-item artifact-changes-item--" + kind[0]);
          item.append(element("span", "artifact-changes-kind", kind[1]), " ");
          var name = String(section.title || "");
          if (section.id && kind[0] !== "removed") {
            var link = element("a", "artifact-changes-section", name);
            link.href = "#" + encodeURIComponent(section.id);
            item.appendChild(link);
          } else {
            item.appendChild(element("span", "artifact-changes-section", name));
          }
          list.appendChild(item);
        });
      });
      if (!list.children.length) {
        list.appendChild(element("li", "artifact-changes-item", "No section's text changed."));
      }
      return list;
    }

    // The words of a heading, without the marks the page script adds.
    function headingText(heading) {
      var copy = heading.cloneNode(true);
      Array.prototype.forEach.call(copy.querySelectorAll(".artifact-section-mark, .artifact-changed-tag"),
        function (mark) { mark.remove(); });
      return copy.textContent.replace(/\s+/g, " ").trim();
    }

    // A free id from base, as the outline makes them.
    function freeId(base) {
      var id = base;
      for (var n = 2; document.getElementById(id); n += 1) {
        id = base + "-" + n;
      }
      return id;
    }

    // The body's h2 for a changed or added section: by its id, else, as a
    // page left with one heading gives it none, by its words, given an id
    // here (as the outline would make it) so the box can link to it. The
    // text before the first h2 has no heading: its link goes to the start of
    // the body, given an id for it.
    function sectionHeading(section) {
      if (section.id) {
        var named = document.getElementById(section.id);
        return named && named.tagName === "H2" && named.closest(".artifact-body") ? named : null;
      }
      var title = String(section.title || "");
      var found = null;
      Array.prototype.forEach.call(document.querySelectorAll(".artifact-body h2:not([id])"), function (heading) {
        if (!found && !heading.closest("pre") && headingText(heading) === title) {
          found = heading;
        }
      });
      if (found) {
        found.id = freeId(title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") ||
          "section");
        section.id = found.id;
      } else if (title === PAGE_TEXT) {
        var body = main.querySelector("section.artifact-body");
        if (body) {
          body.id = body.id || freeId("page-text");
          section.id = body.id;
        }
      }
      return found;
    }

    // The box under the header, and the tags on the sections' headings.
    function box(found) {
      var header = main.querySelector("header.artifact-header");
      if (!header) {
        return;
      }
      var tagged = [];
      [["changed", "changed"], ["added", "new"]].forEach(function (kind) {
        (Array.isArray(found.sections[kind[0]]) ? found.sections[kind[0]] : []).forEach(function (section) {
          var target = sectionHeading(section);
          if (target && !target.querySelector(".artifact-changed-tag")) {
            tagged.push([target, kind[1]]);
          }
        });
      });
      var node = element("section", "artifact-changes");
      node.setAttribute("aria-labelledby", "artifact-changes-heading");
      var heading = element("h2", "artifact-changes-heading", "What changed since you last looked");
      heading.id = "artifact-changes-heading";
      var said = element("p", "artifact-changes-when", "You last opened this on ");
      said.append(stamped(found.since.date), " \u00b7 " +
        plural(Number(found.behind) || 0, "version") + " ago");
      var actions = element("p", "artifact-changes-actions");
      var diff = element("a", "artifact-changes-diff", "See the full diff");
      diff.href = HASH;
      var dismiss = element("button", "artifact-changes-dismiss", "Dismiss");
      dismiss.type = "button";
      dismiss.addEventListener("click", function () {
        node.remove();
      });
      actions.append(diff, dismiss);
      node.append(heading, said, sectionList(found.sections), actions);
      main.insertBefore(node, header.nextSibling);
      tagged.forEach(function (pair) {
        pair[0].appendChild(element("span", "artifact-changed-tag", pair[1]));
      });
    }

    // The pane beside the versions list: that version against the current one.
    function pane(found) {
      var node = element("aside", "artifact-versions-diff");
      node.setAttribute("aria-labelledby", "artifact-versions-diff-heading");
      var heading = element("h3", "artifact-versions-diff-heading");
      heading.id = "artifact-versions-diff-heading";
      heading.append(stamped(found.since.date), " \u2192 current");
      node.appendChild(heading);
      if (!Array.isArray(found.lines)) {
        node.append(element("p", "artifact-versions-diff-note", NO_SOURCE),
          sectionList(found.sections));
        return node;
      }
      var lines = element("div", "artifact-diff");
      found.lines.forEach(function (line) {
        var op = String(line.op);
        var row = element(op === "+" ? "ins" : op === "-" ? "del" : "div",
          "artifact-diff-line artifact-diff-line--" +
          (op === "+" ? "added" : op === "-" ? "removed" : op === "@" ? "hunk" : "same"));
        if (op !== "@") {
          var mark = element("span", "artifact-diff-op", op === " " ? "" : op);
          mark.setAttribute("aria-hidden", "true");
          row.appendChild(mark);
        }
        row.appendChild(element("span", "artifact-diff-text", String(line.text)));
        lines.appendChild(row);
      });
      node.appendChild(lines);
      if (found.truncated === true) {
        node.appendChild(element("p", "artifact-versions-diff-more", "More changes not shown."));
      }
      return node;
    }

    function draw(versions, found) {
      var count = versions.length;
      var link = element("a", "artifact-versions-link", "Versions · " + count);
      link.href = HASH;
      // The link takes the slot the theme kept for it at the end of the
      // line, so the header does not move when it arrives; only the badge
      // of replies to the reader (js/comments.js) comes after it.
      var slot = element("span", "artifact-versions-slot", "· ");
      slot.appendChild(link);
      line.insertBefore(slot, line.querySelector(".artifact-unread"));
      line.classList.add("artifact-meta--versions");

      // The view, made the first time it is shown.
      var view = null;
      var heading = null;

      function entry(version) {
        var item = element("li", "artifact-versions-entry");
        var time = stamped(version.date, "artifact-versions-date");
        var dated = element("div", "artifact-versions-when");
        dated.append(time, element("p", "artifact-versions-note",
          String(version.summary || "") || "First version"));
        item.appendChild(dated);
        if (found && version.commit === found.since.commit) {
          item.classList.add("artifact-versions-entry--seen");
          item.appendChild(element("span", "artifact-versions-seen", "you last looked"));
        }
        if (version.current) {
          item.classList.add("artifact-versions-entry--current");
          item.appendChild(element("span", "artifact-versions-current", "current"));
        } else {
          var open = element("a", "artifact-versions-view", "View");
          open.href = encodeURIComponent(page) + ".html?version=" +
            encodeURIComponent(version.commit);
          open.setAttribute("aria-label", "View the version of " + time.textContent);
          item.appendChild(open);
        }
        return item;
      }

      function make() {
        view = element("section", "artifact-versions");
        view.id = "versions";
        view.hidden = true;
        view.setAttribute("aria-labelledby", "artifact-versions-heading");
        var crumbs = element("nav", "artifact-versions-crumbs");
        crumbs.setAttribute("aria-label", "Breadcrumb");
        var back = element("a", "artifact-versions-back", title ? title.textContent.trim() : page);
        back.href = "#top";
        var here = element("span", "artifact-versions-here", "Versions");
        here.setAttribute("aria-current", "page");
        crumbs.append(back, element("span", "artifact-versions-sep", " \u203a "), here);
        heading = element("h2", "artifact-versions-heading", "Versions");
        heading.id = "artifact-versions-heading";
        heading.tabIndex = -1;
        var said = element("p", "artifact-versions-count",
          count === 0 ? "This page has no versions yet." :
            count === 1 ? "This is the only version." : count + ", newest first");
        var list = element("ol", "artifact-versions-list");
        var more = element("button", "artifact-versions-more", "Show older versions");
        more.type = "button";
        view.append(crumbs, heading, said, list, more);
        if (found) {
          view.classList.add("artifact-versions--diff");
          view.appendChild(pane(found));
        }
        main.insertBefore(view, main.querySelector(".artifact-footer"));

        function showMore() {
          var from = list.children.length;
          versions.slice(from, from + SHOWN).forEach(function (version) {
            list.appendChild(entry(version));
          });
          more.hidden = list.children.length >= count;
          return list.children[from];
        }

        more.addEventListener("click", function () {
          var first = showMore();
          var target = first && first.querySelector("a");
          if (target) {
            target.focus();
          }
        });
        showMore();
      }

      function show() {
        var open = location.hash === HASH;
        if (open === Boolean(view && !view.hidden)) {
          return;
        }
        if (!view) {
          make();
        }
        view.hidden = !open;
        main.classList.toggle("artifact--versions", open);
        document.body.classList.toggle("artifact-versions-shown", open);
        if (open) {
          window.scrollTo(0, 0);
          heading.focus({ preventScroll: true });
        }
      }
      window.addEventListener("hashchange", show);
      show();
    }

    changes.then(function (found) {
      if (found) {
        box(found);
      }
    });

    (async function () {
      try {
        var response = await fetch(VERSIONS + "?page=" + encodeURIComponent(page));
        if (response.status !== 200) {
          return;
        }
        var payload = await json(response);
        if (payload && Array.isArray(payload.versions)) {
          draw(payload.versions, await changes);
        }
      } catch (ignored) {
        // No list: the page shows no versions.
      }
    })();
  }

  pageVersions();
