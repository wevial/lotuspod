// Lotuspod index script: pods in tabs. A strip above the index header holds a
// "Lotuspod" button, which shows the listing, then a tab per open pod: its
// title, read from its listing row, and a close button. Each tab is the pod's
// own page in an iframe, as serve answers it, so switching tabs keeps its
// scroll position and any text not sent; the active tab's frame fills the
// window under the strip, the others stay loaded but hidden, and the listing
// is hidden while a tab is active.
//
// A plain click (main button, no modifier key) on a link with no target and no
// download, to NAME.html on this origin for a pod the listing has and with no
// version query, opens that pod in a tab with the link's fragment, whether the
// link is in the listing or in a pod already open: just after the active tab
// when it is not open, else by activating its tab. In a framed page, a plain
// click on a link to the index shows the listing, and one on any other link
// loads it in the whole window, as it would outside the strip. Any other click
// is the browser's, so Cmd-click and Ctrl-click still open a browser tab. A
// link to an open pod moves its framed page to the link's fragment, which
// reaches the page as a hashchange, the fragment it already holds included;
// a link marked data-pod-exact with no fragment drops the page's.
//
// The open tabs and the active one are kept in the address, #tabs=NAME,NAME
// &on=NAME, written with history.replaceState, and a load with that fragment
// opens them again, a name the listing does not have dropped. The fragment
// names the Pages view of the index's own script, or ends &view=activity
// for Recent activity, and is written again each time that script shows a
// view ("lotuspod:view"), whose buttons would otherwise drop it. Once no tab
// is open, the fragment is the view's own again: #pages, or none.
//
// Each time the listing shows again, the index's own script is told
// ("lotuspod:listing"), so it reads its marks and counts again, as when the
// browser brings the index back from its back-forward cache.
//
// A tab that is not active shows a dot from the seen route: amber ("new
// version") when its pod was published again since this reader last opened
// it, else orchid ("new replies") when someone else has commented since. The
// route is read on load, when a tab is activated or closed and when the window
// is seen again; activating a tab first posts the framed page's revision, so
// what it shows counts as read. A page with no revision (rendered, never
// published) has no script of its own to record its opening, so each time it
// loads in a tab, it is posted at "", its own. Any answer but 200 (signed out,
// or the demo) shows no dot.
//
// The pod finder (js/pod-finder.js) opens from a "+" after the last tab, a
// "Find a pod" button at the strip's end, and Cmd+K on a Mac or Ctrl+K
// elsewhere, in the index or in a framed page; the key closes it again. Each
// asks it with "lotuspod:find", and it hands back the pod chosen with
// "lotuspod:open", which opens it as a link would and focuses its tab.
//
// Focus moved to a tab after a pointer press (a click on ✕, a mouse pick in
// the finder) draws no ring: with focus({ focusVisible: false }) where the
// browser honours it, else a class the stylesheet reads, gone at the next
// key. After a key, the move keeps its ring.
// Without this script the index is its listing alone.
(() => {
  const main = document.querySelector("main.index");
  if (!main) return;

  const SEEN = "/api/seen";
  const MAC = /^Mac/.test(navigator.platform);
  const FRAGMENT = /^#tabs=([^&]*)(?:&on=([^&]*))?(?:&view=activity)?$/;

  // Each pod the listing has: its title and its link, by name.
  const pods = new Map();
  for (const row of document.querySelectorAll(".index-table tbody tr[data-page]")) {
    const link = row.cells[0] ? row.cells[0].querySelector("a[href]") : null;
    if (link) pods.set(row.dataset.page, { title: link.textContent.trim(), href: link.getAttribute("href") });
  }

  // The directory the index is served from, where every pod sits beside it.
  const root = new URL(".", location.href).pathname;

  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const bar = element("div", "pod-tabs-bar");
  const home = element("button", "pod-tabs-home", "Lotuspod");
  home.type = "button";
  const strip = element("div", "pod-tabs");
  strip.setAttribute("role", "group");
  strip.setAttribute("aria-label", "Open pods");
  const plus = element("button", "pod-tabs-new", "+");
  plus.type = "button";
  plus.setAttribute("aria-label", "Open a pod in a new tab");
  strip.append(plus);
  const findButton = element("button", "pod-tabs-find");
  findButton.type = "button";
  findButton.setAttribute("aria-keyshortcuts", MAC ? "Meta+K" : "Control+K");
  findButton.append(element("span", "pod-tabs-find-text", "Find a pod"),
    element("kbd", "pod-tabs-find-key", MAC ? "⌘K" : "Ctrl K"));
  bar.append(home, strip, findButton);
  const frames = element("div", "pod-tabs-frames");
  document.body.prepend(bar);
  main.after(frames);

  // The open pods in strip order, each {name, tab, title, dot, frame}; the
  // active one's name, null while the listing shows.
  const open = [];
  let active = null;
  // The seen route's pages as last answered 200, else null.
  let seen = null;
  // The fragment the address had before any tab was open, for an index
  // with no views to switch. Under the tabs' fragment it was loaded with,
  // that is #pages.
  let before = FRAGMENT.test(location.hash) ? "#pages" : location.hash;

  const find = (name) => open.find((pod) => pod.name === name) || null;

  // Whether the last press was the pointer's rather than a key's, and
  // whether the browser reads focusVisible when asked to focus.
  let pointed = false;
  let honoured = false;
  try {
    element("button").focus({
      get focusVisible() {
        honoured = true;
        return false;
      },
    });
  } catch (ignored) {
    // Not read: the class stands in.
  }
  window.addEventListener("pointerdown", () => {
    pointed = true;
  }, true);
  window.addEventListener("keydown", () => {
    pointed = false;
    for (const quiet of bar.querySelectorAll(".pod-tab-title--quiet")) quiet.classList.remove("pod-tab-title--quiet");
  }, true);

  // Focus a tab's title, with no ring after a pointer press.
  const focusTab = (pod) => {
    if (!pointed) {
      pod.title.focus();
    } else if (honoured) {
      pod.title.focus({ focusVisible: false });
    } else {
      pod.title.classList.add("pod-tab-title--quiet");
      pod.title.focus();
    }
  };

  // The pod a link names, else null: NAME.html beside the index on this
  // origin, a NAME the listing has, asked with no version.
  const podOf = (url) => {
    if (url.origin !== location.origin || url.searchParams.has("version")) return null;
    if (!url.pathname.startsWith(root)) return null;
    let file;
    try {
      file = decodeURIComponent(url.pathname.slice(root.length));
    } catch (ignored) {
      return null;
    }
    const match = /^([^/]+)\.html$/.exec(file);
    return match && pods.has(match[1]) ? match[1] : null;
  };

  const isIndex = (url) => url.origin === location.origin &&
    (url.pathname === root || url.pathname === `${root}index.html`);

  // The view the index's own script shows, "pages" or "activity"; null
  // while it has no views to switch.
  const viewShown = () => {
    const pressed = document.querySelector('.index-views button[aria-pressed="true"]');
    return pressed ? pressed.dataset.view : null;
  };

  const write = () => {
    if (!FRAGMENT.test(location.hash)) before = location.hash;
    // Until the views can be switched, the view the address names stays.
    const view = viewShown() ||
      (FRAGMENT.test(location.hash) && location.hash.endsWith("&view=activity") ? "activity" : null);
    let fragment = view === null ? before : view === "activity" ? "" : "#pages";
    if (open.length) {
      fragment = `#tabs=${open.map((pod) => encodeURIComponent(pod.name)).join(",")}`;
      if (active !== null) fragment += `&on=${encodeURIComponent(active)}`;
      if (view === "activity") fragment += "&view=activity";
    }
    history.replaceState(history.state, "", location.pathname + location.search + fragment);
  };

  // Each tab's dot, from the seen route's entry for its pod: none on the
  // active tab, nor with no answer of 200.
  const showDots = () => {
    for (const pod of open) {
      const entry = seen && Object.prototype.hasOwnProperty.call(seen, pod.name) ? seen[pod.name] : null;
      let kind = null;
      if (entry && pod.name !== active) {
        if (typeof entry.seen === "string" && entry.seen !== entry.revision) kind = "version";
        else if (Number.isInteger(entry.replies) && entry.replies > 0) kind = "replies";
      }
      if (!kind) {
        if (pod.dot) pod.dot.remove();
        pod.dot = null;
        continue;
      }
      if (pod.dot && pod.dot.dataset.kind === kind) continue;
      if (pod.dot) pod.dot.remove();
      pod.dot = element("span", `pod-tab-dot pod-tab-dot--${kind}`);
      pod.dot.dataset.kind = kind;
      pod.dot.append(element("span", "pod-tab-dot-text", kind === "version" ? "new version" : "new replies"));
      pod.title.append(pod.dot);
    }
  };

  // Answers are drawn in the order they were asked: a later read wins.
  let asked = 0;
  const askSeen = async () => {
    const ask = ++asked;
    let pages = null;
    try {
      const response = await fetch(SEEN, { cache: "no-store" });
      if (response.status === 200) {
        const payload = await response.json();
        if (payload && typeof payload.pages === "object" && payload.pages) pages = payload.pages;
      }
    } catch (ignored) {
      // Shown as if the route had not answered.
    }
    if (ask !== asked) return;
    seen = pages;
    showDots();
  };

  // The revision the framed page was rendered at: "" once a page with no
  // stamp has loaded, null before.
  const revisionOf = (pod) => {
    try {
      const framed = pod.frame.contentDocument;
      const stamp = framed.querySelector('meta[name="lotuspod:revision"]');
      if (stamp) return stamp.content.trim();
      return framed.URL !== "about:blank" && framed.readyState === "complete" ? "" : null;
    } catch (ignored) {
      return null;
    }
  };

  // Mark the pod read at the revision its frame shows, then read the route.
  const markSeen = async (pod) => {
    const revision = revisionOf(pod);
    if (revision !== null) {
      try {
        await fetch(SEEN, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ page: pod.name, revision }),
        });
      } catch (ignored) {
        // Read as it is.
      }
    }
    await askSeen();
  };

  // Show the active tab's frame, or the listing with no tab active.
  const show = () => {
    for (const pod of open) {
      const on = pod.name === active;
      if (on) pod.title.setAttribute("aria-current", "page");
      else pod.title.removeAttribute("aria-current");
      pod.tab.classList.toggle("pod-tab--active", on);
      pod.frame.classList.toggle("pod-frame--active", on);
    }
    if (active === null) home.setAttribute("aria-current", "page");
    else home.removeAttribute("aria-current");
    main.hidden = active !== null;
    frames.classList.toggle("pod-tabs-frames--active", active !== null);
    showDots();
  };

  const activate = (name) => {
    active = name;
    show();
    write();
    const pod = find(name);
    pod.tab.scrollIntoView({ block: "nearest", inline: "nearest" });
    markSeen(pod);
  };

  const showListing = () => {
    active = null;
    show();
    write();
    askSeen();
    document.dispatchEvent(new CustomEvent("lotuspod:listing"));
  };

  const close = (name) => {
    const at = open.findIndex((pod) => pod.name === name);
    if (at < 0) return;
    const [pod] = open.splice(at, 1);
    pod.tab.remove();
    pod.frame.remove();
    if (name === active) {
      const next = open[at] || open[at - 1] || null;
      if (next) activate(next.name);
      else showListing();
    } else {
      write();
      askSeen();
    }
    const now = active === null ? null : find(active);
    if (now) focusTab(now);
    else {
      const search = document.getElementById("index-search");
      if (search) search.focus();
    }
  };

  // Each document a frame loads handles its links, on this origin, from its
  // window: a click reaches it last, after every handler of the page's own,
  // which may take the click first (the image viewer's, on the document). A
  // document is taken as soon as it exists, before it has loaded: a new
  // frame's first, and the next one whenever its page goes (a reload, such as
  // the reload banner's), asked for until it is there. The frame's window
  // cannot key this: it is the same object across loads, each of which brings
  // a new document and a new window behind it with no handler.
  const watched = new WeakSet();
  const WAIT = 50;
  const TRIES = 200;
  const watch = (frame) => {
    const current = () => {
      try {
        return frame.contentDocument;
      } catch (ignored) {
        return null;
      }
    };
    const listen = () => {
      const framed = current();
      if (!framed || framed.URL === "about:blank" || watched.has(framed)) return false;
      const view = framed.defaultView;
      if (!view) return false;
      watched.add(framed);
      view.addEventListener("click", (event) => follow(event, framed));
      view.addEventListener("keydown", findKey, true);
      view.addEventListener("pagehide", soon);
      return true;
    };
    // Ask for the next document until it is there, the frame is gone, or
    // its load takes it anyway.
    function soon() {
      let tries = 0;
      const ask = () => {
        if (!frame.isConnected || listen() || ++tries > TRIES) return;
        setTimeout(ask, WAIT);
      };
      setTimeout(ask, 0);
    }
    frame.addEventListener("load", listen);
    return soon;
  };

  // Add the pod's tab just after the active one, its frame at the address
  // its listing link gives with the fragment.
  const add = (name, hash) => {
    const { title, href } = pods.get(name);
    const tab = element("div", "pod-tab");
    tab.dataset.page = name;
    const button = element("button", "pod-tab-title");
    button.type = "button";
    button.append(element("span", "pod-tab-name", title));
    const cross = element("button", "pod-tab-close", "✕");
    cross.type = "button";
    cross.setAttribute("aria-label", `Close ${title}`);
    tab.append(button, cross);
    const frame = element("iframe", "pod-frame");
    frame.title = title;
    const pod = { name, tab, title: button, dot: null, frame };
    const at = active === null ? -1 : open.findIndex((other) => other.name === active);
    if (at < 0) {
      open.push(pod);
      plus.before(tab);
    } else {
      open.splice(at + 1, 0, pod);
      open[at].tab.after(tab);
    }
    button.addEventListener("click", () => {
      if (active !== name) activate(name);
    });
    cross.addEventListener("click", () => close(name));
    // A page with no stamp records nothing itself: its opening is posted here.
    frame.addEventListener("load", () => {
      if (revisionOf(pod) === "") markSeen(pod);
    });
    const soon = watch(frame);
    frame.src = href + hash;
    frames.append(frame);
    soon();
    return pod;
  };

  // exact (a link marked data-pod-exact, a Recent activity row's): an open
  // pod's page moves to the link's fragment even when that is none, leaving
  // any view a fragment shows, such as its versions.
  const openPod = (name, hash, exact = false) => {
    const pod = find(name);
    if (!pod) {
      add(name, hash);
    } else if (!hash && exact) {
      try {
        const view = pod.frame.contentWindow;
        const framed = view.location;
        if (framed.hash && framed.pathname === new URL(pods.get(name).href, location.href).pathname) {
          // Dropped in place, so the page keeps its state; it is told as a
          // fragment it left.
          const was = framed.href;
          view.history.replaceState(view.history.state, "", `${framed.pathname}${framed.search}`);
          view.dispatchEvent(new view.HashChangeEvent("hashchange", { oldURL: was, newURL: framed.href }));
        }
      } catch (ignored) {
        // The frame stays where it is.
      }
    } else if (hash) {
      // To the fragment within the pod's page once it is there; until then
      // (the frame still blank, its page on the way) the pod's page anew,
      // at the fragment.
      const target = new URL(pods.get(name).href, location.href);
      try {
        const framed = pod.frame.contentWindow.location;
        if (framed.origin === target.origin && framed.pathname === target.pathname) {
          if (framed.hash === hash) {
            // The fragment it already holds fires no hashchange: the page is
            // told as if it had, so a link to a thread opens it again.
            const view = pod.frame.contentWindow;
            view.dispatchEvent(new view.HashChangeEvent("hashchange", { oldURL: framed.href, newURL: framed.href }));
          } else {
            framed.replace(`${framed.pathname}${framed.search}${hash}`);
          }
        } else {
          target.hash = hash;
          framed.replace(target.href);
        }
      } catch (ignored) {
        // The frame stays where it is.
      }
    }
    activate(name);
  };

  // A plain click on a link, in the index (framed null) or in a framed page.
  const follow = (event, framed) => {
    if (event.defaultPrevented || event.button !== 0 ||
        event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target && event.target.closest ? event.target.closest("a[href]") : null;
    if (!link || link.hasAttribute("target") || link.hasAttribute("download")) return;
    let url;
    try {
      url = new URL(link.getAttribute("href"), link.baseURI);
    } catch (ignored) {
      return;
    }
    if (framed) {
      // A link within the framed page itself only scrolls it.
      const here = new URL(framed.location.href);
      if (url.hash && url.origin === here.origin && url.pathname === here.pathname &&
          url.search === here.search) return;
    }
    const name = podOf(url);
    if (name !== null) {
      event.preventDefault();
      openPod(name, url.hash, link.hasAttribute("data-pod-exact"));
    } else if (framed && isIndex(url)) {
      event.preventDefault();
      showListing();
    } else if (framed && /^https?:$/.test(url.protocol)) {
      event.preventDefault();
      location.assign(url.href);
    }
  };

  // Ask the finder to open, or with the key to close again.
  const ask = (toggle) => document.dispatchEvent(new CustomEvent("lotuspod:find", { detail: { toggle } }));

  // Cmd+K on a Mac, Ctrl+K elsewhere, taken in the capture phase so the
  // browser keeps none of it (Chromium's own search box).
  function findKey(event) {
    if (typeof event.key !== "string" || event.key.toLowerCase() !== "k" ||
        event.shiftKey || event.altKey ||
        (MAC ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    if (!event.repeat) ask(true);
  }

  home.addEventListener("click", () => {
    if (active !== null) showListing();
  });
  plus.addEventListener("click", () => ask(false));
  findButton.addEventListener("click", () => ask(false));
  window.addEventListener("keydown", findKey, true);
  // The finder's choice, opened as a link to it would be, its tab focused.
  document.addEventListener("lotuspod:open", (event) => {
    const name = event.detail ? event.detail.name : null;
    if (!pods.has(name)) return;
    openPod(name, "");
    focusTab(find(name));
  });
  document.addEventListener("click", (event) => follow(event, null));
  document.addEventListener("lotuspod:view", () => {
    if (open.length) write();
  });
  window.addEventListener("focus", askSeen);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") askSeen();
  });

  // The tabs the address names, in its order, the listing's pods alone.
  const named = FRAGMENT.exec(location.hash);
  if (named) {
    const decode = (part) => {
      try {
        return decodeURIComponent(part);
      } catch (ignored) {
        return "";
      }
    };
    for (const name of named[1].split(",").map(decode)) {
      if (pods.has(name) && !find(name)) add(name, "");
    }
    const on = named[2] === undefined ? null : decode(named[2]);
    if (on !== null && find(on)) {
      activate(on);
      return;
    }
  }
  show();
  if (named) write();
  askSeen();
})();
