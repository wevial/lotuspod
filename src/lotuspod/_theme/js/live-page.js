
  // The page's revision while it is open (lotuspod:revision). The page learns
  // the revision its page is now published at from each read of its threads
  // (live.seen, which the comments page calls) and from the revision route,
  // every CHECK ms and at once when the page is seen again. Once that is not
  // its own, a banner fixed over the top of the window offers a reload; a
  // hidden page with no unsent text in a composer reloads itself, so it is
  // current when the reader comes back. Before a reload the page keeps where
  // the reader was, per page in sessionStorage: the scroll position and what
  // the comments page keeps (live.keep: the thread open, the text not sent),
  // which it gets back after the load (live.kept); once that is open again,
  // live.place scrolls to where the reader was once more, as opening a thread
  // over the text may scroll, and the page may only now be long enough. The
  // banner still shows and the reload still happens when the browser lets
  // the page keep nothing.
  function livePage() {
    var REVISION = "/api/revision";
    var KEPT = "lotuspod:reload:";
    var CHECK = 60000;
    var NEWER = "A newer version of this page is available";
    var live = {
      seen: function () {},
      keep: function () {},
      kept: function () { return null; },
      place: function () {},
    };
    var stamp = document.querySelector('meta[name="lotuspod:revision"]');
    var own = stamp ? stamp.content.trim() : "";
    if (!own) {
      return live;
    }
    var named = document.querySelector("[data-page]");
    var page = named ? named.dataset.page :
      decodeURIComponent(location.pathname.split("/").pop()).replace(/\.html$/, "");
    var key = KEPT + page;
    // What the comments page keeps: save() is what to keep, and unsent()
    // says whether a composer holds text not sent.
    var keeper = null;
    var noticed = false;
    var asking = false;
    var timer = null;
    var reloading = false;

    // What was kept before the reload that loaded this page, taken once.
    var kept = null;
    try {
      kept = JSON.parse(sessionStorage.getItem(key) || "null");
      sessionStorage.removeItem(key);
    } catch (ignored) {
      kept = null;
    }
    // Where the reader was, until live.place has scrolled there again.
    var at = kept && typeof kept.y === "number" ? { x: Number(kept.x) || 0, y: kept.y } : null;
    if (at) {
      window.scrollTo(at.x, at.y);
    }

    // The banner's live region is there from the start, so what it is given
    // is announced.
    var region = element("div", "artifact-live-page");
    region.setAttribute("role", "status");
    document.body.appendChild(region);
    var button = null;

    function show() {
      var banner = element("div", "artifact-live-page-banner");
      var dot = element("span", "artifact-live-page-dot", "·");
      dot.setAttribute("aria-hidden", "true");
      button = element("button", "artifact-live-page-reload", "Reload");
      button.type = "button";
      button.addEventListener("click", reload);
      banner.append(element("span", "artifact-live-page-text", NEWER), dot, button);
      region.appendChild(banner);
    }

    function save() {
      try {
        sessionStorage.setItem(key, JSON.stringify({
          x: window.scrollX, y: window.scrollY, comments: keeper ? keeper.save() : null,
        }));
      } catch (ignored) {
        // Storage refused: the page reloads at its top, nothing kept.
      }
    }

    async function reload() {
      if (reloading) {
        return;
      }
      reloading = true;
      if (button) {
        button.disabled = true;
      }
      try {
        // Fetched afresh first: a publish in the second the page was served
        // leaves its date as it was, and the reload alone could then be
        // answered from the cache with the page this one is.
        await fetch(location.href, { cache: "reload" });
      } catch (ignored) {
        // The reload asks again.
      }
      // Kept only now, with nothing left to wait for: the reader may write
      // and scroll while the page is fetched.
      save();
      location.reload();
    }

    function hidden() {
      return document.visibilityState === "hidden";
    }

    live.seen = function (revision) {
      if (noticed || typeof revision !== "string" || !revision || revision === own) {
        return;
      }
      noticed = true;
      clearTimeout(timer);
      timer = null;
      if (hidden() && !(keeper && keeper.unsent())) {
        reload();
      } else {
        show();
      }
    };

    live.keep = function (made) {
      keeper = made;
    };

    live.place = function () {
      if (at) {
        window.scrollTo(at.x, at.y);
        at = null;
      }
    };

    live.kept = function () {
      var found = kept && kept.comments;
      kept = null;
      return found && typeof found === "object" ? found : null;
    };

    function plan() {
      clearTimeout(timer);
      timer = noticed ? null : setTimeout(check, CHECK);
    }

    // Ask the revision route; a reader signed out, or a page no longer
    // served, is asked no more.
    async function check() {
      if (asking || noticed) {
        return;
      }
      asking = true;
      var again = true;
      try {
        var response = await fetch(REVISION + "?page=" + encodeURIComponent(page));
        if (response.status === 200) {
          var payload = await json(response);
          live.seen(payload && payload.revision);
        } else if (response.status === 401 || response.status === 404) {
          again = false;
        }
      } catch (ignored) {
        // A failed check keeps the schedule.
      }
      asking = false;
      if (again) {
        plan();
      } else {
        clearTimeout(timer);
        timer = null;
      }
    }

    document.addEventListener("visibilitychange", function () {
      if (!hidden() && timer) {
        check();
      }
    });
    plan();
    return live;
  }

  var live = livePage();
