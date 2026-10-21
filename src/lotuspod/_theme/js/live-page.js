
  // The page's revision while it is open (lotuspod:revision). The page learns
  // the revision its page is now published at from each read of its threads
  // (live.seen, which the comments page calls) and from the revision route,
  // every CHECK ms, at once when the page is seen again, and at once on a
  // tick from serve's stream (js/live-events.js) that it was published again,
  // or a resync. Once that is not its own, the swap web/src/page-swap.ts
  // registers (live.swapWith) is tried first: it swaps in only the parts the
  // new revision changed and answers the revision the page now shows, which
  // becomes its own (live.revision), so a later publish is noticed too; a
  // swap that throws partway reloads the page. When it answers null, or none
  // is registered, a banner fixed over the top of the window offers a reload;
  // a hidden page with no unsent text in a composer reloads itself, so it is
  // current when the reader comes back. Before a reload, the banner's or the
  // browser's (pagehide), and while its tab is hidden, the page keeps where
  // the reader was, per page in sessionStorage: the scroll position, kept
  // from the top of the page's text (div.artifact-main) so a box drawn above
  // it after the load moves nothing, and what
  // the comments page keeps (live.keep: the thread open, the text not sent),
  // which it gets back after the load (live.kept); once that is open again,
  // live.place scrolls to where the reader was once more, as opening a thread
  // over the text may scroll, and the page may only now be long enough. The
  // banner still shows and the reload still happens when the browser lets
  // the page keep nothing. Once per load the page also posts its own revision
  // to the seen route, which keeps the reader's last visit for the index, and
  // posts each revision a swap brings in the same way, unless it is framed
  // in an index tab not shown, which keeps its "new version" dot until it is
  // opened; live.previous() is a promise of the revision that route answers
  // the reader last opened the page at, null the first time or on any failure.
  // live.note(text) shows one line in the banner's place for NOTED ms, as a
  // swap says what it changed; a banner shown takes it away, and none shows
  // beside one.
  function livePage() {
    var REVISION = "/api/revision";
    var SEEN = "/api/seen";
    var KEPT = "lotuspod:reload:";
    var CHECK = 60000;
    var NOTED = 6000;
    var NEWER = "A newer version of this page is available";
    var live = {
      seen: function () {},
      keep: function () {},
      kept: function () { return null; },
      place: function () {},
      previous: function () { return Promise.resolve(null); },
      revision: function () { return own; },
      swapWith: function () {},
      note: function () {},
      reload: function () { location.reload(); },
    };
    var stamp = document.querySelector('meta[name="lotuspod:revision"]');
    var own = stamp ? stamp.content.trim() : "";
    if (!own) {
      return live;
    }
    var page = pageName();
    var key = KEPT + page;

    // Where the page's text starts in the document.
    function origin() {
      var text = document.querySelector(".artifact-main");
      return text ? text.getBoundingClientRect().top + window.scrollY : 0;
    }

    // Record that the reader opened the page at revision, so the index can
    // mark it once it is republished; the revision they opened it at before.
    // A reader signed out, or a failure, is shown nothing.
    function record(revision) {
      return fetch(SEEN, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page: page, revision: revision }),
      }).then(async function (response) {
        var payload = response.status === 200 ? await json(response) : null;
        return payload && typeof payload.previous === "string" ? payload.previous : null;
      }).catch(function () {
        return null;
      });
    }

    // Whether the page is framed in an index tab that is not shown: the
    // index hides a tab's frame with visibility, which checkVisibility
    // weighs only when asked.
    function away() {
      var frame = window.frameElement;
      return Boolean(frame && typeof frame.checkVisibility === "function" &&
        !frame.checkVisibility({ visibilityProperty: true }));
    }

    // Once per load, and kept: the revision the reader opened it at before.
    var previous = record(own);
    live.previous = function () {
      return previous;
    };

    // What the comments page keeps: save() is what to keep, and unsent()
    // says whether a composer holds text not sent.
    var keeper = null;
    var noticed = false;
    var asking = false;
    var timer = null;
    var reloading = false;
    // The swap to try first, and the one under way, which a later revision
    // seen waits for.
    var swap = null;
    var swapping = null;

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
      window.scrollTo(at.x, origin() + at.y);
    }

    // The banner's live region is there from the start, so what it is given
    // is announced.
    var region = element("div", "artifact-live-page");
    region.setAttribute("role", "status");
    document.body.appendChild(region);
    var button = null;
    var note = null;
    var noting = null;

    function unnote() {
      clearTimeout(noting);
      noting = null;
      if (note) {
        note.remove();
        note = null;
      }
    }

    live.note = function (text) {
      unnote();
      // Never beside the banner, which already says the page is behind.
      if (region.querySelector(".artifact-live-page-banner")) {
        return;
      }
      note = element("div", "artifact-live-page-note", text);
      region.appendChild(note);
      noting = setTimeout(unnote, NOTED);
    };

    function show() {
      unnote();
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
          x: window.scrollX, y: window.scrollY - origin(), comments: keeper ? keeper.save() : null,
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

    function offer() {
      if (hidden() && !(keeper && keeper.unsent())) {
        reload();
      } else {
        show();
      }
    }

    live.seen = function (revision) {
      if (swapping) {
        swapping.then(function () { live.seen(revision); });
        return;
      }
      if (noticed || typeof revision !== "string" || !revision || revision === own) {
        return;
      }
      noticed = true;
      clearTimeout(timer);
      timer = null;
      if (!swap) {
        offer();
        return;
      }
      swapping = swap(revision).then(function (now) {
        swapping = null;
        if (typeof now !== "string" || !now) {
          offer();
          return;
        }
        own = now;
        noticed = false;
        if (!away()) {
          record(own);
        }
        plan();
      }, function () {
        // Never left half-swapped.
        swapping = null;
        reload();
      });
    };

    live.reload = reload;

    live.swapWith = function (made) {
      swap = made;
    };

    live.keep = function (made) {
      keeper = made;
    };

    live.place = function () {
      if (at) {
        window.scrollTo(at.x, origin() + at.y);
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

    // Left by the browser's own reload, or by any other way, the page keeps
    // the same as before the banner's Reload, which the next load of the
    // page in this tab gets back; and so does a page whose tab is hidden, as
    // a mobile browser may put it away without pagehide. A page shown again
    // lives on: what it kept goes, so no later load brings back a comment
    // the reader has sent since. Once left, the page keeps what it had as
    // pagehide came: the tab hidden after it, the posts still sending are
    // given up, which says less.
    var left = false;
    function unsave() {
      try {
        sessionStorage.removeItem(key);
      } catch (ignored) {
        // Storage refused: nothing was kept.
      }
    }
    window.addEventListener("pagehide", function () {
      left = true;
      save();
    });
    window.addEventListener("pageshow", function (event) {
      if (event.persisted) {
        left = false;
        unsave();
      }
    });
    document.addEventListener("visibilitychange", function () {
      if (hidden()) {
        if (!left) {
          save();
        }
        return;
      }
      left = false;
      unsave();
      if (timer) {
        check();
      }
    });
    // A tick from serve's stream (js/live-events.js) that this page was
    // published again, or that the stream missed some, checks at once.
    document.addEventListener("lotuspod:change", function (event) {
      var tick = event.detail;
      if (timer && (tick.what === "resync" || (tick.what === "publish" && tick.page === page))) {
        check();
      }
    });
    plan();
    return live;
  }

  var live = livePage();
