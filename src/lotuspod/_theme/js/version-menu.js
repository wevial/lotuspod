
  // A page's version menu (js/versions.js draws it on the current page): a
  // "▾" button that opens a menu of the page's versions, newest first, each
  // with its date and time, its summary on one line ("First version" when it
  // has none), and "current" or "you last looked" where those apply, then a
  // last item "See all versions" linking to #versions. An older version's
  // item links to NAME.html?version=COMMIT, the current one's to NAME.html,
  // which carries aria-current="page". It follows the menu-button
  // pattern: Enter, Space or ArrowDown on the button opens it on the newest
  // version, ArrowUp on "See all versions"; in it the arrows, Home and End
  // move between the items, Escape closes it and returns focus to the
  // button, and Tab or a click outside closes it.
  //
  // It reads nothing and posts nothing: its inputs are the versions, the
  // page's name and the commit the reader last looked at (null when none),
  // so a script of its own can join it as it is. It returns the button and
  // the menu, to be put side by side in a positioned box, and close(), which
  // closes the menu.
  function versionMenu(versions, page, seen) {
    var HASH = "#versions";
    var button = element("button", "artifact-versions-menu-button", "▾");
    button.type = "button";
    button.id = "artifact-versions-menu-button";
    button.setAttribute("aria-label", "Choose a version");
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-controls", "artifact-versions-menu");
    button.setAttribute("aria-expanded", "false");
    var menu = element("div", "artifact-versions-menu");
    menu.id = "artifact-versions-menu";
    menu.hidden = true;
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-labelledby", button.id);

    function item(href, className) {
      var link = element("a", "artifact-versions-menu-item" + (className ? " " + className : ""));
      link.href = href;
      link.tabIndex = -1;
      link.setAttribute("role", "menuitem");
      return link;
    }

    var list = element("div", "artifact-versions-menu-list");
    list.setAttribute("role", "none");
    versions.forEach(function (version) {
      var link = item(encodeURIComponent(page) + ".html" + (version.current ? "" :
        "?version=" + encodeURIComponent(version.commit)));
      if (version.current) {
        link.setAttribute("aria-current", "page");
      }
      var top = element("span", "artifact-versions-menu-top");
      var time = element("time", "artifact-versions-menu-date", when(version.date));
      time.setAttribute("datetime", version.date);
      top.appendChild(time);
      if (version.current) {
        top.appendChild(element("span", "artifact-versions-current", "current"));
      }
      if (version.commit === seen) {
        top.appendChild(element("span", "artifact-versions-seen", "you last looked"));
      }
      link.append(top, element("span", "artifact-versions-menu-note",
        String(version.summary || "") || "First version"));
      list.appendChild(link);
    });
    var seeAll = item(HASH, "artifact-versions-menu-all");
    seeAll.textContent = "See all versions";
    menu.append(list, seeAll);

    function items() {
      return Array.prototype.slice.call(menu.querySelectorAll('[role="menuitem"]'));
    }

    // The menu kept inside the window's width: shifted left when its right
    // edge would pass it.
    function fit() {
      menu.style.left = "";
      var box = menu.getBoundingClientRect();
      var room = document.documentElement.clientWidth - 8;
      if (box.right > room) {
        menu.style.left = (room - box.right) + "px";
      }
    }

    function open(index) {
      menu.hidden = false;
      button.setAttribute("aria-expanded", "true");
      fit();
      var choices = items();
      var target = choices[index < 0 ? choices.length + index : index];
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: "nearest" });
    }

    function close(focus) {
      menu.hidden = true;
      button.setAttribute("aria-expanded", "false");
      if (focus) {
        button.focus();
      }
    }

    button.addEventListener("click", function () {
      if (menu.hidden) {
        open(0);
      } else {
        close(true);
      }
    });
    button.addEventListener("keydown", function (event) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        open(event.key === "ArrowDown" ? 0 : -1);
      }
    });
    menu.addEventListener("keydown", function (event) {
      var choices = items();
      var at = choices.indexOf(document.activeElement);
      var to = null;
      if (event.key === "ArrowDown") {
        to = (at + 1) % choices.length;
      } else if (event.key === "ArrowUp") {
        to = at <= 0 ? choices.length - 1 : at - 1;
      } else if (event.key === "Home") {
        to = 0;
      } else if (event.key === "End") {
        to = choices.length - 1;
      } else if (event.key === "Escape") {
        event.stopPropagation();
        event.preventDefault();
        close(true);
        return;
      } else if (event.key === "Tab") {
        close(false);
        return;
      } else if (event.key === " ") {
        // Space follows the focused item as Enter does.
        event.preventDefault();
        if (at >= 0) {
          choices[at].click();
        }
        return;
      } else {
        return;
      }
      event.preventDefault();
      choices[to].focus({ preventScroll: true });
      choices[to].scrollIntoView({ block: "nearest" });
    });
    // Choosing an item closes the menu, "See all versions" among them,
    // which stays on the page.
    menu.addEventListener("click", function (event) {
      if (event.target.closest('[role="menuitem"]')) {
        close(false);
      }
    });
    // A click outside the button and the menu closes it; focus left in the
    // menu goes back to the button.
    document.addEventListener("click", function (event) {
      if (menu.hidden || button.contains(event.target) || menu.contains(event.target)) {
        return;
      }
      close(menu.contains(document.activeElement));
    });
    window.addEventListener("resize", function () {
      if (!menu.hidden) {
        fit();
      }
    });

    return { button: button, menu: menu, close: close };
  }
