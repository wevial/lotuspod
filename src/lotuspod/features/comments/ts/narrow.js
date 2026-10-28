
  // Without room for the comments panel, one thing at a time opens over the
  // text (docs/design/margin-comments-mockup.html, "Narrow window: a popover"
  // and "Phone", P2): from POPOVER pixels wide, in a popover under the chip
  // or highlight that opened it (div.artifact-comments-popover); narrower, in
  // a sheet fixed to the bottom of the window (div.artifact-comments-bottom-sheet),
  // whose arrows step through every open thread on the page. What opens is a
  // view: a thread, a section's threads that no highlight opens with its
  // form for a new one, or a passage's composer. Its entries are moved in
  // from the panel's groups and back, never drawn twice, and shown as the
  // panel shows them, Resolve included. The comments island's placement
  // (features/comments/ts/islands/comments/placement.ts) makes it, and passes
  // what it reads threads with as `the`.
  // On a page that asks questions, or lists its versions, the sheet's head
  // is its tabs, Decisions, Comments and History, each there as the page
  // has it, and Close: on Decisions it holds the comments panel's Decisions
  // tab, and on History its History tab, their nodes moved in and back as
  // the threads' are, and on Comments it steps through the threads as above,
  // its arrows and the thread's state under the tabs. The title bar's count
  // opens it on Decisions (over.decisions), and its "N changed" and the
  // header's "Versions · N" on History (over.history), from any width
  // without room for the panel. On a page that takes no comments
  // (the.comments false) it holds no threads, no Comments tab, and `the` is
  // no more than the other tabs need.
  function overText(the) {
    var panel = the.panel;
    var groups = the.groups;
    var passages = the.passages;
    var mute = the.mute;
    var over = {};
    var held = { kind: null, view: null, opener: null, anchor: null, members: [], titleKey: null,
      stateKey: null };
    // What the sheet's Comments tab goes back to, with its anchor, once
    // Decisions or History took its place.
    var back = null;
    // The line naming its block above each block thread's comments in a
    // section's view, by thread.
    var leads = new Map();
    var NAMES = { popover: "artifact-comments-popover", sheet: "artifact-comments-bottom-sheet" };
    var TABS = ["decisions", "comments", "history"];

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
      var made = { node: node, top: top, close: close, title: title, body: body, entries: entries, extra: extra };
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
        // Over its tabs, Close is spelled out in place of the ×.
        close.appendChild(element("span", "artifact-comments-close-word", "Close"));
        made.tabs = element("div", "artifact-comments-bottom-sheet-tabs");
        made.tabs.setAttribute("role", "tablist");
        made.tabs.hidden = true;
        made.tabs.addEventListener("keydown", tabKey);
        made.tab = { decisions: tab(made, "decisions", "Decisions"), comments: tab(made, "comments", "Comments"),
          history: tab(made, "history", "History") };
        // History says how many sections changed unseen, out of sight, and
        // marks them with a dot.
        var history = made.tab.history;
        history.unseen = element("span", "artifact-comments-tab-unseen");
        history.dot = mute(element("span", "artifact-comments-tab-dot"));
        history.button.replaceChildren(element("span", "", "History"));
        made.bar = element("div", "artifact-comments-bottom-sheet-bar");
        made.bar.hidden = true;
        made.comments = element("div", "artifact-comments-bottom-sheet-comments");
        made.comments.id = "artifact-comments-bottom-sheet-comments";
        ["decisions", "history"].forEach(function (name) {
          made[name] = element("div", "artifact-comments-bottom-sheet-" + name);
          made[name].id = "artifact-comments-bottom-sheet-" + name;
          made[name].setAttribute("role", "tabpanel");
          made[name].setAttribute("aria-labelledby", made.tab[name].button.id);
          made[name].hidden = true;
        });
        top.append(made.tabs, nav, made.state, close);
        body.append(title, entries, extra);
        made.comments.append(made.bar, body);
        node.append(top, made.comments, made.decisions, made.history);
        made.back.addEventListener("click", function () { step(-1); });
        made.forth.addEventListener("click", function () { step(1); });
        // A question's words and its Show on page close the sheet before
        // the card is scrolled to, its nodes back in the panel.
        made.decisions.addEventListener("click", function (event) {
          var target = event.target;
          if (held.view && held.view.decisions && target.closest &&
              target.closest(".artifact-decisions-question, .artifact-decisions-show")) {
            release(false);
          }
        }, true);
        // A link in what changed closes the sheet before the browser
        // follows it, its nodes back in the panel. Mark as seen takes away
        // the button that has the focus: the focus goes to the tab.
        made.history.addEventListener("click", function (event) {
          var target = event.target;
          if (!(held.view && held.view.history && target.closest)) {
            return;
          }
          if (target.closest("a[href]")) {
            release(false);
          } else if (target.closest(".artifact-history-mark")) {
            made.tab.history.button.focus({ preventScroll: true });
          }
        }, true);
      } else {
        top.append(title, close);
        body.append(entries, extra);
        node.append(top, body);
      }
      document.body.appendChild(node);
      close.addEventListener("click", function () { release(true); });
      return made;
    }
    // One of the sheet's tabs, with its count.
    function tab(made, name, words) {
      var button = element("button", "artifact-comments-tab", words);
      button.type = "button";
      button.id = "artifact-comments-bottom-sheet-tab-" + name;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-controls", "artifact-comments-bottom-sheet-" + name);
      var badge = element("span", "artifact-comments-tab-badge");
      button.append(" ", badge);
      button.addEventListener("click", function () { choose(name); });
      made.tabs.appendChild(button);
      return { button: button, badge: badge };
    }

    // The arrows go to the tab before or after, round from the last to the
    // first; Home and End to the first and last.
    function tabKey(event) {
      var order = present();
      var at = order.indexOf(showing());
      var by = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      var to = by ? order[(at + by + order.length) % order.length] :
        event.key === "Home" ? order[0] : event.key === "End" ? order[order.length - 1] : null;
      if (!to || order.length < 2) {
        return;
      }
      event.preventDefault();
      choose(to);
    }

    // The tab a view shows: Decisions or History, whose nodes are lent,
    // else Comments.
    function tabOf(view) {
      return view && view.decisions ? "decisions" : view && view.history ? "history" : "comments";
    }

    function showing() {
      return tabOf(held.view);
    }

    // Whether the sheet has a tab, and the tabs it has, in order.
    function has(name) {
      return name === "decisions" ? the.tabs.asks() : name === "history" ? the.tabs.history() : the.comments;
    }

    function present() {
      return TABS.filter(has);
    }

    // The node in the comments panel whose children a lent tab shows.
    function lender(name) {
      return name === "decisions" ? the.tabs.node() : the.tabs.historyNode();
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

    // The comments panel's Decisions tab's nodes, lent to the sheet while it
    // shows Decisions, and given back.
    function move(from, to) {
      while (from && to && from.firstChild) {
        to.appendChild(from.firstChild);
      }
    }

    // The sheet's tabs as they now stand: shown once the page's questions
    // are counted or its versions listed, each there as the page has it, the
    // one held selected, each with its count, History with its dot while
    // sections changed unseen; the arrows and the thread's state under them,
    // else in the head.
    function retab() {
      var order = present();
      var tabbed = the.tabs.asks() || the.tabs.history();
      var shown = showing();
      sheet.node.classList.toggle("artifact-comments-bottom-sheet--tabs", tabbed);
      sheet.tabs.hidden = !tabbed;
      sheet.bar.hidden = !tabbed;
      if (tabbed && sheet.nav.parentNode !== sheet.bar) {
        sheet.bar.append(sheet.nav, sheet.state);
      } else if (!tabbed && sheet.nav.parentNode !== sheet.top) {
        sheet.top.insertBefore(sheet.nav, sheet.close);
        sheet.top.insertBefore(sheet.state, sheet.close);
      }
      var names = order.map(function (name, at) { return at ? name : name[0].toUpperCase() + name.slice(1); });
      sheet.tabs.setAttribute("aria-label", names.length > 1 ?
        names.slice(0, -1).join(", ") + " and " + names[names.length - 1] : names[0] || "Decisions");
      TABS.forEach(function (name) {
        var button = sheet.tab[name].button;
        button.hidden = order.indexOf(name) < 0;
        button.setAttribute("aria-selected", name === shown ? "true" : "false");
        button.tabIndex = name === shown ? 0 : -1;
        sheet[name].hidden = name !== shown;
      });
      var unseen = the.tabs.unseen();
      var history = sheet.tab.history;
      if (unseen > 0) {
        history.unseen.textContent = ", " + unseen + (unseen === 1 ? " section" : " sections") + " changed";
        history.button.firstChild.appendChild(history.unseen);
        history.button.appendChild(history.dot);
      } else {
        history.unseen.remove();
        history.dot.remove();
      }
      var count = the.tabs.count();
      var badge = sheet.tab.decisions.badge;
      badge.hidden = count === null;
      badge.textContent = count ? String(count) : "✓";
      badge.classList.toggle("artifact-comments-tab-badge--done", count === 0);
      if (the.comments) {
        sheet.tab.comments.badge.textContent = String(steps().length);
      }
      if (tabbed) {
        sheet.comments.setAttribute("role", "tabpanel");
        sheet.comments.setAttribute("aria-labelledby", sheet.tab.comments.button.id);
      } else {
        sheet.comments.removeAttribute("role");
        sheet.comments.removeAttribute("aria-labelledby");
      }
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

    // "On TITLE", and " · STATE" when the block's widget named one, as the
    // panel's entry says it: its words, and its parts with the title bold.
    function onBlock(block) {
      var state = block.state ? " · " + block.state : "";
      return {
        name: "On " + block.title + state,
        parts: ["On ", element("span", "artifact-comments-entry-block", block.title), state],
      };
    }

    // In a section's view, a block thread's comments are led by the line
    // naming its block, as its hidden head does in the panel; else by none.
    function lead(thread, shown) {
      var line = leads.get(thread);
      var block = shown ? the.blockOf(thread) : null;
      if (!block) {
        if (line) {
          line.remove();
          leads.delete(thread);
        }
        return;
      }
      var said = onBlock(block);
      if (!line || line.dataset.key !== said.name) {
        if (line) {
          line.remove();
        }
        line = element("p", "artifact-comments-held-on");
        line.dataset.key = said.name;
        line.append.apply(line, said.parts);
        leads.set(thread, line);
      }
      if (line.nextSibling !== thread.node && thread.node.parentNode) {
        thread.node.parentNode.insertBefore(line, thread.node);
      }
    }

    // What a view is called, and the title it shows: "Section HEADING", a
    // passage's number and its opening words, a decision's number and its
    // question, a block's title and state, or its composer.
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
      var block = thread && the.blockOf(thread);
      if (block) {
        var on = onBlock(block);
        return { name: on.name, key: on.name, parts: on.parts };
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
      var lent = tabOf(view);
      if (lent !== "comments") {
        // The questions, or the versions, gone, the sheet goes back to
        // Comments, or closes.
        if (!has(lent)) {
          var inside = made.node.contains(document.activeElement);
          var to = the.comments ? target() : null;
          if (to) {
            unlend(to, held.opener);
          } else if (the.comments || view.history) {
            release(false);
          }
          if (to && inside) {
            made.node.focus({ preventScroll: true });
          }
          return;
        }
        move(lender(lent), sheet[lent]);
        retab();
        made.node.setAttribute("aria-label", lent === "decisions" ? "Decisions" : "History");
        held.titleKey = null;
        room.style.height = made.node.offsetHeight + "px";
        return;
      }
      var before = held.members;
      var members = membersOf(view);
      held.members = members;
      before.forEach(function (thread) {
        if (members.indexOf(thread) < 0) {
          lead(thread, false);
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
        lead(thread, Boolean(view.box));
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
        retab();
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
    // popover sits under, or what the page scrolls above the sheet. Held
    // still, the page does not scroll for it.
    function hold(kind, view, opener, anchor, still) {
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
      if (!still) {
        popover.node.style.top = "";
      }
      made.node.hidden = false;
      made.node.classList.add(NAMES[kind] + "--open");
      made.body.scrollTop = 0;
      over.sync();
      if (kind === "sheet") {
        lift();
        if (!still) {
          clear(held.anchor);
        }
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
        lead(thread, false);
        panel.put(thread);
        passages.shine(thread);
      });
      if (view.decisions || view.history) {
        move(sheet[tabOf(view)], lender(tabOf(view)));
        // Closed, the sheet no longer keeps a passage's composer behind
        // Decisions or History; a mode change keeps it.
        if (!keep && back && back.view.passage) {
          passages.cancel(back.view.passage);
        }
        if (!keep) {
          back = null;
        }
      } else if (view.box) {
        var group = groups.get(view.box);
        the.compose(group, false);
        group.node.append(group.toggle, group.holder);
      } else if (view.passage && !keep) {
        passages.cancel(view.passage);
      }
      if (next !== kind) {
        made.node.classList.remove(NAMES[kind] + "--open");
        made.node.removeAttribute("aria-label");
        // Out of the sheet's mode, it opens only on Decisions.
        if (kind === "popover" || the.panel.mode !== "sheet") {
          made.node.hidden = true;
        }
        if (kind === "sheet") {
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
      // Kept behind Decisions or History, a composer stays there as the
      // width changes.
      if (tabOf(held.view) !== "comments" && back && back.view.passage === mine) {
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

    // The title bar's count: the sheet on Decisions, the focus on the first
    // question to answer, else on the tab. Comments goes back to the thread
    // or form the sheet held.
    over.decisions = function (opener) {
      if (!(held.view && held.view.decisions)) {
        lendTo("decisions", opener);
      }
      var question = sheet.decisions.querySelector(".artifact-decisions-entry .artifact-decisions-question");
      (question || sheet.tab.decisions.button).focus({ preventScroll: true });
    };

    // The title bar's "N changed" and the header's "Versions · N": the sheet
    // on History, the focus on the tab.
    over.history = function (opener) {
      if (!(held.view && held.view.history)) {
        lendTo("history", opener);
      }
      sheet.tab.history.button.focus({ preventScroll: true });
    };

    // Decisions or History takes the place of what the sheet holds. What
    // Comments goes back to is kept from Comments, never from the other
    // lent tab.
    function lendTo(name, opener, still) {
      if (tabOf(held.view) !== "comments") {
        release(false, true, "sheet");
      } else if (held.view) {
        lend();
      } else {
        back = null;
      }
      hold("sheet", name === "history" ? { history: true } : { decisions: true }, opener, null, still);
    }

    // What the sheet holds, kept for Comments to go back to: a passage's
    // composer, and a section's form as it was being written in.
    function lend() {
      var group = held.view.box ? groups.get(held.view.box) : null;
      back = { view: held.view, anchor: held.anchor, writing: Boolean(group && !group.holder.hidden) };
      release(false, true, "sheet");
    }

    // What Comments goes back to: what the sheet held before Decisions or
    // History, else the first open thread, else the first section's form, else null.
    function target() {
      if (back && there(back.view)) {
        return back;
      }
      var first = steps()[0];
      var box = groups.keys().next().value;
      return first ? { view: { thread: first }, anchor: the.anchorOf(first) } :
        box ? { view: { box: box }, anchor: box.querySelector("summary") } : null;
    }

    // Comments in the sheet's place again, at to. The page stays where it is.
    function unlend(to, opener) {
      back = null;
      hold("sheet", to.view, opener, to.anchor, true);
      if (to.view.box && to.writing) {
        the.compose(groups.get(to.view.box), true);
      }
    }

    // Whether a view the Comments tab would go back to is still there.
    function there(view) {
      return view.thread ? the.ordered().indexOf(view.thread) >= 0 :
        view.box ? groups.has(view.box) : view.passage.holder.isConnected;
    }

    // A tab pressed: Decisions shows the questions, and History what
    // changed, in place of what the sheet held (lendTo), Comments what it
    // held before them (unlend).
    function choose(name) {
      if (!held.view || name === showing() || !has(name)) {
        return;
      }
      var opener = held.opener;
      if (name !== "comments") {
        lendTo(name, opener, true);
      } else {
        var to = target();
        if (!to) {
          return;
        }
        unlend(to, opener);
      }
      sheet.tab[name].button.focus({ preventScroll: true });
    }

    // What is held, as over.take returns it, left open.
    over.peek = function () {
      var view = held.view;
      var group = view && view.box ? groups.get(view.box) : null;
      return {
        view: view, opener: held.opener, anchor: held.anchor,
        writing: group && !group.holder.hidden ? group : null,
        scroll: held.kind ? holderOf(held.kind).body.scrollTop : 0,
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
    // (passages.place). Taken over a swap (taken.still), a view on a box
    // the swap replaced opens on the box that replaced it, under its chip,
    // without scrolling the page; one on a box taken away stays closed.
    over.restore = function (taken) {
      var view = taken.view;
      if (!view || view.passage) {
        return;
      }
      if (view.decisions || view.history) {
        hold("sheet", view, taken.opener, null, true);
        return;
      }
      var opener = taken.opener;
      var anchor = taken.anchor;
      if (view.box && !view.box.isConnected) {
        var box = the.standsFor(view.box);
        if (!box) {
          return;
        }
        view = { box: box };
      }
      if (anchor && !anchor.isConnected) {
        anchor = view.thread ? the.anchorOf(view.thread) : view.box.querySelector("summary");
        if (!anchor) {
          return;
        }
        if (!opener || !opener.isConnected) {
          opener = anchor;
        }
      }
      if (anchor && !taken.still) {
        the.unfold(anchor);
      }
      if (view.box && panel.mode === "sheet" && !taken.writing) {
        // The sheet shows one thread at a time: a section's newest open
        // one, else its form.
        var newest = newestOwn(view.box);
        hold("sheet", newest ? { thread: newest } : view, opener,
          newest ? the.anchorOf(newest) : anchor, taken.still);
      } else {
        hold(panel.mode, view, opener, anchor, taken.still);
      }
      // Over a swap, it is scrolled where the reader left it.
      if (taken.still && held.kind) {
        holderOf(held.kind).body.scrollTop = taken.scroll || 0;
      }
    };

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && held.view && !event.defaultPrevented) {
        event.preventDefault();
        release(true);
      }
    });
    // A click outside the popover, its opener, the pill, the banner
    // offering a reload (which keeps it open over the reload), the image
    // viewer opened from it and the title bar's count (which keeps it
    // behind Decisions) closes it, before whatever the click is for.
    document.addEventListener("click", function (event) {
      var target = event.target;
      if (held.kind !== "popover" || popover.node.contains(target) ||
          (held.opener && held.opener.contains(target)) ||
          (target.closest && target.closest(".artifact-passage-pill, .artifact-live-page, .artifact-image-viewer, .artifact-review-count"))) {
        return;
      }
      release(true);
    }, true);

    return over;
  }
