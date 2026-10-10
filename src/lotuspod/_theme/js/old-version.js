
  // The page's name is the address's, the one serve answered this version
  // for: a data-page in the page's body may be anyone's. The seen route is
  // never asked: an old version records no visit.
  function oldVersionMenu() {
    var links = document.querySelector(".artifact-version-banner .artifact-version-banner-links");
    var every = links && links.querySelector('a[href$="#versions"]');
    if (!every) {
      return;
    }
    var page = decodeURIComponent(location.pathname.split("/").pop()).replace(/\.html$/, "");
    var shown = new URLSearchParams(location.search).get("version");

    // Only the request and its answer fail quietly; an error above throws.
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
