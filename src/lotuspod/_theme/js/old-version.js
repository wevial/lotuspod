
  // An earlier version's banner gains the page's version menu
  // (js/version-menu.js) before its "All versions" link: a "Choose a
  // version ▾" button whose menu marks the version shown "viewing". The
  // page's name is the address's, the one serve answered this version for:
  // a data-page in the page's body may be anyone's. The seen route is never
  // asked: an old version records no visit, so the menu has no "you last
  // looked".
  function oldVersionMenu() {
    var links = document.querySelector(".artifact-version-banner .artifact-version-banner-links");
    var every = links && links.querySelector('a[href$="#versions"]');
    if (!every) {
      return;
    }
    var page = decodeURIComponent(location.pathname.split("/").pop()).replace(/\.html$/, "");
    var shown = new URLSearchParams(location.search).get("version");

    (async function () {
      var response = await fetch("/api/versions?page=" + encodeURIComponent(page));
      if (response.status !== 200) {
        return;
      }
      var payload = await response.json();
      if (!payload || !Array.isArray(payload.versions)) {
        return;
      }
      var menu = versionMenu(payload.versions, page, shown, null, true);
      // The words name the button; the arrow only shows it opens a menu.
      var arrow = element("span", "artifact-version-banner-arrow", "▾");
      arrow.setAttribute("aria-hidden", "true");
      menu.button.textContent = "Choose a version ";
      menu.button.appendChild(arrow);
      var box = element("span", "artifact-version-banner-menu");
      box.append(menu.button, menu.menu);
      links.insertBefore(box, every);
      // The current item opens the page itself, alone in the window: a
      // plain click on it leaves a mark for that one load, which
      // js/open-in-tabs.js takes in place of opening the index's tabs.
      var current = encodeURIComponent(page) + ".html";
      menu.menu.addEventListener("click", function (event) {
        var link = event.target.closest('[role="menuitem"]');
        if (!link || link.getAttribute("href") !== current || event.button !== 0 ||
            event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
          return;
        }
        try {
          sessionStorage.setItem("lotuspod:stay", page);
        } catch (ignored) {
          // No storage: the page opens in the index's tabs, as any link does.
        }
      });
    })().catch(function () {
      // No menu: the banner keeps its links.
    });
  }

  oldVersionMenu();
