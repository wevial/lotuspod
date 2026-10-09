
  // The page's versions (lotuspod.versions): a page with a revision asks the
  // versions route once. When it answers 200, even with no versions (a
  // directory that is not the top of its own repository has none), the
  // header's date line gains a
  // "Versions · N" link to #versions, and while the hash is #versions the
  // page shows its versions view in place of its header and body: a
  // breadcrumb back to the page, the heading, and the versions newest first,
  // each with its date and time, the current one marked and every other with
  // a "View" link to its read-only old version (NAME.html?version=COMMIT).
  // The list shows SHOWN entries, and "Show older versions" shows SHOWN more
  // each time. Any other answer leaves the page as it is: no link, no view.
  function pageVersions() {
    var VERSIONS = "/api/versions";
    var HASH = "#versions";
    var SHOWN = 20;
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

    function draw(versions) {
      var count = versions.length;
      var link = element("a", "artifact-versions-link", "Versions · " + count);
      link.href = HASH;
      // The link takes the slot the theme kept for it at the end of the
      // line, so the header does not move when it arrives.
      var slot = element("span", "artifact-versions-slot", "· ");
      slot.appendChild(link);
      line.appendChild(slot);
      line.classList.add("artifact-meta--versions");

      // The view, made the first time it is shown.
      var view = null;
      var heading = null;

      function entry(version) {
        var item = element("li", "artifact-versions-entry");
        var time = element("time", "artifact-versions-date", when(version.date));
        time.setAttribute("datetime", version.date);
        item.appendChild(time);
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

    (async function () {
      try {
        var response = await fetch(VERSIONS + "?page=" + encodeURIComponent(page));
        if (response.status !== 200) {
          return;
        }
        var payload = await json(response);
        if (payload && Array.isArray(payload.versions)) {
          draw(payload.versions);
        }
      } catch (ignored) {
        // No list: the page shows no versions.
      }
    })();
  }

  pageVersions();
