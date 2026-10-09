
  // An earlier version's banner gains the page's version menu
  // (js/version-menu.js) before its "All versions" link: a "Choose a
  // version ▾" button whose menu marks the version shown "viewing". The
  // page's name is read as js/versions.js reads it, the version shown from
  // the address's version query. It asks the versions route once; only a 200
  // with a list draws the menu, and any other answer, or a failed request,
  // leaves the banner as it is. The seen route is never asked: an old
  // version records no visit, so the menu has no "you last looked".
  function oldVersionMenu() {
    var links = document.querySelector(".artifact-version-banner .artifact-version-banner-links");
    var every = links && links.querySelector('a[href$="#versions"]');
    if (!every) {
      return;
    }
    var named = document.querySelector("[data-page]");
    var page = named ? named.dataset.page :
      decodeURIComponent(location.pathname.split("/").pop()).replace(/\.html$/, "");
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
    })().catch(function () {
      // No menu: the banner keeps its links.
    });
  }

  oldVersionMenu();
