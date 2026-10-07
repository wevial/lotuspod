
  // Without room for the comments panel, one thing at a time opens over the
  // text (docs/design/margin-comments-mockup.html, "Narrow window: a popover"
  // and "Phone", P2): from POPOVER pixels wide, in a popover under the chip
  // or highlight that opened it (div.artifact-comments-popover); narrower, in
  // a sheet fixed to the bottom of the window (div.artifact-comments-bottom-sheet),
  // whose arrows step through every open thread on the page. What opens is a
  // view: a thread, a section's threads that no highlight opens with its
  // form for a new one, or a passage's composer. Its entries are moved in
  // from the panel's groups and back, never drawn twice, and shown as the
  // panel shows them, Resolve included. The side panel (sidePanel in
  // js/comments.js) makes it, and the comments page passes what it reads
  // threads with as `the`.
  function overText(the) {
    var panel = the.panel;
    var groups = the.groups;
    var passages = the.passages;
    var mute = the.mute;
    var over = {};
    var held = { kind: null, view: null, opener: null, anchor: null, members: [], titleKey: null,
      stateKey: null };
    var NAMES = { popover: "artifact-comments-popover", sheet: "artifact-comments-bottom-sheet" };

    function holder(kind) {
      var node = element("div", "artifact-comments-held " + NAMES[kind]);
      node.setAttribute("role", "dialog");
      node.tabIndex = -1;
      node.hidden = true;
      var top = element("header", "artifact-comments-held-head");
      var title = element("p", "artifact-comments-held-title");
      var close = element("button", "artifact-comments-close");
      close.type = "button";
      close.setAttribute("aria-label", "Close");
      close.appendChild(mute(element("span", "", "×")));
      var body = element("div", "artifact-comments-held-body");
      var entries = element("ol", "artifact-comments-entries");
      var extra = element("div", "artifact-comments-held-extra");
      var made = { node: node, title: title, body: body, entries: entries, extra: extra };
      if (kind === "sheet") {
        var nav = element("span", "artifact-comments-bottom-sheet-nav");
        made.nav = nav;
        made.back = element("button", "artifact-comments-step");
        made.back.type = "button";
        made.back.setAttribute("aria-label", "Previous thread");
        made.back.appendChild(mute(element("span", "", "‹")));
        made.at = element("span", "artifact-comments-bottom-sheet-at");
        made.forth = element("button", "artifact-comments-step");
        made.forth.type = "button";
        made.forth.setAttribute("aria-label", "Next thread");
        made.forth.appendChild(mute(element("span", "", "›")));
        nav.append(made.back, made.at, made.forth);
        made.state = element("span", "artifact-comments-held-state");
        top.append(nav, made.state, close);
        body.append(title, entries, extra);
        made.back.addEventListener("click", function () { step(-1); });
        made.forth.addEventListener("click", function () { step(1); });
      } else {
        top.append(title, close);
        body.append(entries, extra);
      }
      node.append(top, body);
      document.body.appendChild(node);
      close.addEventListener("click", function () { release(true); });
      return made;
    }
    var popover = holder("popover");
    var sheet = holder("sheet");
    // Room at the end of the page while the sheet is open, so the last
    // words can scroll above it.
    var room = mute(element("div", "artifact-comments-room"));
    document.body.appendChild(room);

    function holderOf(kind) {
      return kind === "sheet" ? sheet : popover;
    }

    // Whether a thread is open in a popover or the sheet.
    over.holds = function (thread) {
      return held.members.indexOf(thread) >= 0;
    };

    // The list a held thread's entry goes in, if anything is held.
    over.entries = function () {
      return held.kind ? holderOf(held.kind).entries : null;
    };

    // A thread no highlight opens: a section's own, one on a passage not
    // found, or one resolved.
    function unmarked(thread) {
      return thread.marks.length === 0;
    }

    // A section's newest open thread that no highlight opens.
    function newestOwn(box) {
      return the.latest(the.threadsOf(box).filter(function (thread) {
        return unmarked(thread) && !the.resolved(thread);
      }));
    }

    // In the sheet, which steps one thread at a time, a section's view
    // holds only its form for a new thread.
    function membersOf(view) {
      if (view.thread) {
        return [view.thread];
      }
      return view.box && held.kind !== "sheet" ? the.threadsOf(view.box).filter(unmarked) : [];
    }

    function same(a, b) {
      return a.thread === b.thread && a.box === b.box && a.passage === b.passage;
    }

    // Every open thread on the page, in page order: those on passages by
    // their numbers, then each section's own (its decisions' among them),
    // oldest first, then those on sections the page no longer has.
    function steps() {
      var marked = [];
      var rest = [];
      the.ordered().forEach(function (thread) {
        if (!the.resolved(thread)) {
          (thread.root.quote && thread.n ? marked : rest).push(thread);
        }
      });
      marked.sort(function (a, b) { return a.n - b.n; });
      return marked.concat(rest);
    }

    // What a view is called, and the title it shows: "Section HEADING", a
    // passage's number and its opening words, a decision's number and its
    // question, or its composer.
    function caption(view) {
      if (view.passage) {
        var asking = "Comment on the selected words";
        return { name: asking, key: asking, parts: [asking] };
      }
      var thread = view.thread;
      if (thread && thread.root.quote) {
        var words = the.opening(thread.root.quote.exact);
        var lost = passages.detached(thread);
        var number = mute(element("span", "artifact-comments-entry-mark", thread.n ? String(thread.n) : ""));
        return {
          name: (thread.n ? "Passage " + thread.n + ": " : "Passage: ") + words,
          key: thread.n + " " + lost + " " + words,
          parts: [number, " ", element(lost ? "del" : "span", "artifact-passage-quoted", words)],
        };
      }
      var decision = thread && the.decisionOf(thread);
      if (decision) {
        return {
          name: decision.name + ": " + decision.question, key: decision.name + ": " + decision.question,
          parts: [element("span", "artifact-comments-held-kind", decision.name), ": ", decision.question],
        };
      }
      var box = thread ? thread.box : view.box;
      var heading = box && document.getElementById(box.dataset.section);
      var name = box ? the.title(box) : String(thread.root.sectionTitle || thread.root.section || "");
      if (box && (!heading || heading.tagName !== "H2")) {
        return { name: name, key: name, parts: [name] };
      }
      return {
        name: "Section " + name, key: "Section " + name,
        parts: [element("span", "artifact-comments-held-kind", "Section"), " ", name],
      };
    }

    // Draw what is held as it now stands: its entries in order, those no
    // longer in it put back, its title, and the sheet's place and state.
    over.sync = function () {
      var view = held.view;
      if (!view) {
        return;
      }
      var made = holderOf(held.kind);
      var before = held.members;
      var members = membersOf(view);
      held.members = members;
      before.forEach(function (thread) {
        if (members.indexOf(thread) < 0) {
          panel.put(thread);
          passages.shine(thread);
        }
      });
      members.forEach(function (thread, index) {
        panel.put(thread);
        var at = made.entries.children[index];
        if (at !== thread.entry.item) {
          made.entries.insertBefore(thread.entry.item, at || null);
        }
        passages.shine(thread);
      });
      var named = caption(view);
      if (named.key !== held.titleKey) {
        held.titleKey = named.key;
        made.title.replaceChildren.apply(made.title, named.parts);
        made.node.setAttribute("aria-label", named.name);
      }
      made.node.classList.toggle("artifact-comments-held--passage", Boolean(view.thread && view.thread.root.quote));
      if (held.kind === "sheet") {
        var list = steps();
        var at = view.thread ? list.indexOf(view.thread) : -1;
        made.nav.hidden = list.length === 0;
        made.at.textContent = (at < 0 ? "–" : String(at + 1)) + " of " + list.length;
        made.back.disabled = at === 0;
        made.forth.disabled = at === list.length - 1;
        var thread = view.thread;
        var key = thread ? (the.resolved(thread) ? "resolved" :
          the.standing(thread) + " " + the.routed(the.asked(thread))) : "";
        if (key !== held.stateKey) {
          held.stateKey = key;
          if (!thread) {
            made.state.replaceChildren();
          } else if (the.resolved(thread)) {
            made.state.replaceChildren(the.tick(), " Resolved");
          } else {
            made.state.replaceChildren(the.said(thread));
          }
        }
        room.style.height = made.node.offsetHeight + "px";
      } else {
        place();
      }
    };

    // Scroll what is held, never the page, the least that shows node, its
    // top first.
    over.uncover = function (node) {
      if (!held.kind) {
        return;
      }
      var body = holderOf(held.kind).body;
      var outer = body.getBoundingClientRect();
      var inner = node.getBoundingClientRect();
      if (inner.bottom > outer.bottom) {
        body.scrollTop += Math.min(inner.bottom - outer.bottom + 8, inner.top - outer.top);
      } else if (inner.top < outer.top) {
        body.scrollTop -= outer.top - inner.top + 8;
      }
    };

    // The popover under its anchor and inside the window, its tip at the
    // anchor's start. It lies over the text in the page, so it scrolls
    // with what opened it; only when it opens, or the window is resized
    // (refit), and the window leaves the anchor too little room below it
    // or shows it under the title bar, does the page scroll.
    function place(refit) {
      var anchor = held.anchor;
      var node = popover.node;
      if (!anchor || !anchor.isConnected) {
        return;
      }
      var least = 160;
      var gap = 12;
      var fit = refit || !node.style.top;
      var rect = anchor.getBoundingClientRect();
      if (fit && rect.top < the.barBottom()) {
        window.scrollBy({ top: rect.top - the.barBottom() - 8, left: 0, behavior: "instant" });
        rect = anchor.getBoundingClientRect();
      }
      var space = window.innerHeight - rect.bottom - gap - 8;
      if (fit && space < least) {
        window.scrollBy({ top: least - space, left: 0, behavior: "instant" });
        rect = anchor.getBoundingClientRect();
        space = window.innerHeight - rect.bottom - gap - 8;
      }
      var first = anchor.getClientRects()[0] || rect;
      var width = node.offsetWidth;
      var edge = document.documentElement.clientWidth;
      var left = Math.max(8, Math.min(first.left - 16, edge - width - 8));
      node.style.maxHeight = Math.round(Math.max(space, least)) + "px";
      node.style.left = Math.round(left + window.scrollX) + "px";
      node.style.top = Math.round(rect.bottom + gap + window.scrollY) + "px";
      node.style.setProperty("--artifact-comments-tip",
        Math.round(Math.max(16, Math.min(width - 16, first.left + Math.min(first.width / 2, 20) - left))) + "px");
    }

    // Scroll the page, never its layout, so the anchor shows between the
    // title bar and the sheet's top, opening its section if it is folded.
    function clear(anchor) {
      if (!anchor || !anchor.isConnected) {
        return;
      }
      the.unfold(anchor);
      var height = sheet.node.offsetHeight;
      room.style.height = height + "px";
      var top = the.barBottom() + 8;
      var bottom = window.innerHeight - height - 12;
      var rect = anchor.getBoundingClientRect();
      var by = rect.bottom > bottom ? rect.bottom - bottom : 0;
      if (rect.top - by < top) {
        by = rect.top - top;
      }
      if (by) {
        window.scrollBy({ top: by, left: 0, behavior: "instant" });
      }
    }

    // Lift the sheet over an on-screen keyboard, which covers the bottom
    // of the window without making it any smaller.
    function lift() {
      var seen = window.visualViewport;
      var under = seen ? Math.max(0, window.innerHeight - seen.height - seen.offsetTop) : 0;
      sheet.node.style.bottom = under ? Math.round(under) + "px" : "";
      sheet.node.style.maxHeight = under ? Math.round(seen.height * 0.6) + "px" : "";
    }
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", lift);
      window.visualViewport.addEventListener("scroll", lift);
    }

    // Open a view in the popover or the sheet, in place of what it held.
    // opener takes the focus back when it closes; anchor is what the
    // popover sits under, or what the page scrolls above the sheet.
    function hold(kind, view, opener, anchor) {
      if (held.view) {
        release(false, false, kind);
      }
      var made = holderOf(kind);
      held.kind = kind;
      held.view = view;
      held.opener = opener || null;
      held.anchor = anchor || opener || null;
      held.titleKey = null;
      held.stateKey = null;
      if (view.box) {
        var group = groups.get(view.box);
        made.extra.append(group.toggle, group.holder);
      } else if (view.passage) {
        made.extra.appendChild(view.passage.holder);
      }
      popover.node.style.top = "";
      made.node.hidden = false;
      made.node.classList.add(NAMES[kind] + "--open");
      made.body.scrollTop = 0;
      over.sync();
      if (kind === "sheet") {
        lift();
        clear(held.anchor);
      }
    }

    // Close the popover or sheet: what it held goes back to its group, a
    // passage's composer is cancelled unless kept, and with focus the
    // focus goes back to what opened it. next is the kind about to open.
    function release(focus, keep, next) {
      var view = held.view;
      if (!view) {
        return;
      }
      var kind = held.kind;
      var made = holderOf(kind);
      var members = held.members;
      var opener = held.opener;
      held.view = null;
      held.kind = null;
      held.members = [];
      held.opener = null;
      held.anchor = null;
      members.forEach(function (thread) {
        panel.put(thread);
        passages.shine(thread);
      });
      if (view.box) {
        var group = groups.get(view.box);
        the.compose(group, false);
        group.node.append(group.toggle, group.holder);
      } else if (view.passage && !keep) {
        passages.cancel(view.passage);
      }
      if (next !== kind) {
        made.node.classList.remove(NAMES[kind] + "--open");
        made.node.removeAttribute("aria-label");
        if (kind === "popover") {
          made.node.hidden = true;
        } else {
          room.style.height = "";
        }
      }
      if (focus && opener && opener.isConnected) {
        if (!opener.matches("a[href], button, summary, textarea, [tabindex]")) {
          opener.tabIndex = -1;
        }
        opener.focus({ preventScroll: true });
      }
    }

    // Open a view. In a popover, the same view from the same opener closes
    // it again.
    over.show = function (view, opener) {
      var kind = panel.mode === "sheet" ? "sheet" : "popover";
      if (kind === "popover" && held.view && same(held.view, view) && held.opener === opener) {
        release(true);
        return;
      }
      hold(kind, view, opener, opener);
      if (view.box && !held.members.some(function (thread) { return !the.resolved(thread); })) {
        the.compose(groups.get(view.box), true);
      } else {
        holderOf(kind).node.focus({ preventScroll: true });
      }
    };

    // A chip: its section's threads no highlight opens, in a popover, or in
    // the sheet its newest open one; else its newest open thread on a
    // passage; else its form for a new thread.
    over.chip = function (box) {
      var chipNode = box.querySelector("summary");
      var newest = newestOwn(box);
      var view;
      if (newest && panel.mode === "sheet") {
        view = { thread: newest };
      } else if (newest) {
        view = { box: box };
      } else {
        newest = the.latest(the.unresolvedOf(box));
        view = newest ? { thread: newest } : { box: box };
      }
      over.show(view, chipNode);
    };

    // The sheet's arrows: the thread before or after in page order.
    function step(by) {
      var list = steps();
      var at = held.view && held.view.thread ? list.indexOf(held.view.thread) : -1;
      var next = at < 0 ? list[by > 0 ? 0 : list.length - 1] : list[at + by];
      if (!next) {
        return;
      }
      hold("sheet", { thread: next }, held.opener, the.anchorOf(next));
      var focused = document.activeElement;
      if (!sheet.node.contains(focused) || focused.disabled) {
        sheet.node.focus({ preventScroll: true });
      }
    }

    // A passage's composer: in a popover under its words, or in the sheet.
    over.passage = function (mine) {
      if (held.view && held.view.passage === mine) {
        over.sync();
        return;
      }
      hold(panel.mode, { passage: mine }, null, mine.marks[mine.marks.length - 1]);
    };

    // A passage's composer closed: so does what held it.
    over.dropped = function (mine) {
      if (held.view && held.view.passage === mine) {
        release(false);
      }
    };

    // A thread was posted from a passage's composer: it opens under its
    // words or in the sheet.
    over.started = function (thread, focused) {
      hold(panel.mode, { thread: thread }, null, the.anchorOf(thread));
      if (focused) {
        holderOf(panel.mode).node.focus({ preventScroll: true });
      }
    };

    // A section's form posted a thread: a popover shows it among its
    // section's threads, and the sheet moves on to it.
    over.posted = function (thread, focused) {
      if (held.kind === "sheet") {
        hold("sheet", { thread: thread }, held.opener, the.anchorOf(thread));
      } else {
        over.sync();
      }
      if (focused && held.view) {
        holderOf(held.kind).node.focus({ preventScroll: true });
      }
    };

    // The window was resized within a mode: the popover stays under its
    // anchor and in the window, the sheet over the keyboard.
    over.refit = function () {
      if (held.kind === "popover") {
        place(true);
      } else if (held.kind === "sheet") {
        lift();
      }
    };

    // What is held, as over.take returns it, left open.
    over.peek = function () {
      var view = held.view;
      var group = view && view.box ? groups.get(view.box) : null;
      return {
        view: view, opener: held.opener, anchor: held.anchor,
        writing: group && !group.holder.hidden ? group : null,
      };
    };

    // The mode is changing: what is held is put back, a passage's composer
    // kept, and returned to open again where it now goes (over.restore). A
    // section's form being written in stays open where it goes.
    over.take = function () {
      var taken = over.peek();
      release(false, true);
      return taken;
    };

    // The mode changed: only the sheet is drawn, out of sight, between
    // openings, so it can slide up.
    over.mode = function (mode) {
      sheet.node.hidden = mode !== "sheet";
    };

    // Open again what over.take took, or what the panel showed, in a
    // popover or the sheet. A passage's composer is placed by its own
    // (passages.place).
    over.restore = function (taken) {
      var view = taken.view;
      if (!view || view.passage) {
        return;
      }
      if (taken.anchor && taken.anchor.isConnected) {
        the.unfold(taken.anchor);
      }
      if (view.box && panel.mode === "sheet" && !taken.writing) {
        // The sheet shows one thread at a time: a section's newest open
        // one, else its form.
        var newest = newestOwn(view.box);
        hold("sheet", newest ? { thread: newest } : view, taken.opener,
          newest ? the.anchorOf(newest) : taken.anchor);
      } else {
        hold(panel.mode, view, taken.opener, taken.anchor);
      }
    };

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && held.view && !event.defaultPrevented) {
        event.preventDefault();
        release(true);
      }
    });
    // A click outside the popover, its opener, the pill, the banner
    // offering a reload (which keeps it open over the reload) and the image
    // viewer opened from it closes it, before whatever the click is for.
    document.addEventListener("click", function (event) {
      var target = event.target;
      if (held.kind !== "popover" || popover.node.contains(target) ||
          (held.opener && held.opener.contains(target)) ||
          (target.closest && target.closest(".artifact-passage-pill, .artifact-live-page, .artifact-image-viewer"))) {
        return;
      }
      release(true);
    }, true);

    return over;
  }
