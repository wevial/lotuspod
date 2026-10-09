
  // The comment boxes (lotuspod.comments): one per section, or one for the
  // page. Threads come from the comments route; each is shown in the box of
  // its section, or, when the page no longer has that section, in a list at
  // the end of the body. With the page script each box is a chip instead,
  // and its threads open in the side panel, a popover or a bottom sheet
  // (sidePanel below), never in the box. A thread on a passage
  // (selectPassages below) is also drawn on its words.
  function commentBoxes(boxes) {
    var page = boxes[0].dataset.page;
    var tag = document.querySelector('meta[name="lotuspod:owner"]');
    var owner = tag ? tag.content : "";
    var stamp = document.querySelector('meta[name="lotuspod:revision"]');
    var revision = stamp ? stamp.content : null;
    var article = document.querySelector(".artifact-body");
    // Maps, not objects: a section id is the author's and may be any name,
    // "__proto__" included.
    var sections = new Map();
    var shown = new Map();
    // Each box's form for a new thread, wherever it is shown.
    var forms = new Map();
    // Each composer's attachments, by its form.
    var attached = new Map();
    // Replies to the reader: the ids the comments route last named
    // `unread`, each thread's mark as this page last knew it, and the
    // comments of each open thread that were unread as it opened, which
    // stay marked while it stays open; threads by their first comment's
    // id. A route that names none (signed out, the demo) marks nothing.
    var SEEN = "/api/seen";
    var unread = new Set();
    // Whether the route named any: only then is a thread opened posted.
    var tracked = false;
    var seenTo = new Map();
    var opening = new Map();
    var tabTitle = document.title;
    var dateLine = document.querySelector("header.artifact-header .artifact-meta");
    var newBadge = null;

    // The page's decision forms, in page order, and each by its question.
    var decisions = all("form.artifact-decision[data-question]");
    var questions = new Map();

    boxes.forEach(function (box) {
      sections.set(box.dataset.section, box);
      forms.set(box, box.querySelector("form.artifact-comment-form"));
    });
    decisions.forEach(function (form) {
      questions.set(form.dataset.question, form);
    });

    // The text of a form's part, its whitespace collapsed.
    function words(form, selector) {
      var node = form.querySelector(selector);
      return node ? node.textContent.replace(/\s+/g, " ").trim() : "";
    }

    // The decision a thread asks about: its form, its number ("" for none),
    // its question and what it is called; null for any other thread, and
    // for one on a decision the page no longer asks.
    function decisionOf(thread) {
      var question = thread.root.question;
      var form = question !== undefined && question !== null ? questions.get(String(question)) : null;
      if (!form) {
        return null;
      }
      var number = words(form, ".artifact-decision-number");
      return {
        form: form, number: number, question: words(form, ".artifact-decision-text"),
        name: number ? "Decision " + number : "Decision",
      };
    }

    // An agent's handle when an agent wrote the row; "" for anyone else. Only
    // the verified actor's kind says a row is an agent's, never an address.
    function agent(row) {
      var actor = row && row.actor;
      if (!actor || actor.kind !== "agent") {
        return "";
      }
      return actor.handle ? String(actor.handle) : "agent";
    }

    // Who wrote a row that is not an agent's: a reader's name, else a handle.
    function author(row) {
      var actor = row && row.actor;
      if (actor && actor.name) {
        return String(actor.name);
      }
      return actor && actor.handle ? String(actor.handle) : "someone";
    }

    // The agent a reader's comment is routed to, else the page's owner.
    function routed(row) {
      return row.owner ? String(row.owner) : owner || "an agent";
    }

    // A mark drawn by the stylesheet: no text, hidden from assistive technology.
    function mark(kind) {
      var node = element("span", "artifact-comment-mark artifact-comment-mark--" + kind);
      node.setAttribute("aria-hidden", "true");
      if (kind === "dots") {
        node.append(element("i"), element("i"), element("i"));
      }
      return node;
    }

    // A row: an avatar, then a column of a name line and what is said.
    function row(className, avatar, avatarText) {
      var item = element("li", "artifact-comment-row " + className);
      var face = element("span", "artifact-comment-avatar " + avatar, avatarText);
      face.setAttribute("aria-hidden", "true");
      item.appendChild(face);
      var column = element("div", "artifact-comment-col");
      item.appendChild(column);
      return { item: item, column: column };
    }

    // An agent's name line: the handle in the mono voice, its AGENT tag,
    // and the model the reply names as its writer, when it names one.
    function agentName(handle, model) {
      var by = element("p", "artifact-comment-by");
      by.appendChild(element("span", "artifact-comment-handle", handle));
      by.appendChild(document.createTextNode(" "));
      by.appendChild(element("span", "artifact-comment-agent", "AGENT"));
      if (model) {
        by.appendChild(document.createTextNode(" "));
        by.appendChild(element("span", "artifact-comment-model", String(model)));
      }
      return by;
    }

    function comment(entry) {
      var handle = agent(entry);
      var name = handle || author(entry);
      var drawn = handle
        ? row("artifact-comment-item artifact-comment-item--agent", "artifact-comment-avatar--agent",
          name.charAt(0).toUpperCase())
        : row("artifact-comment-item artifact-comment-item--reader", "",
          name.slice(0, 2).toUpperCase());
      var by;
      if (handle) {
        by = agentName(handle, entry.model);
      } else {
        by = element("p", "artifact-comment-by");
        by.appendChild(element("span", "artifact-comment-author", name));
      }
      var time = element("time", "artifact-comment-time", when(entry.createdAt));
      time.dateTime = String(entry.createdAt || "");
      by.appendChild(document.createTextNode(" "));
      by.appendChild(time);
      drawn.column.appendChild(by);
      var said = commentMarkdown(element("div", "artifact-comment-text"), String(entry.text || ""));
      // A passage's highlight is described by its thread's first comment.
      said.id = "artifact-comment-text-" + entry.id;
      drawn.column.appendChild(said);
      var images = commentImages(entry);
      if (images) {
        said.hidden = !entry.text;
        drawn.column.appendChild(images);
      }
      return drawn.item;
    }

    // The centred line after an agent's reply that revised the page.
    function revised(entry) {
      var line = element("li", "artifact-comment-event");
      var text = element("span");
      text.appendChild(document.createTextNode(agent(entry) + " "));
      var link = element("a", "", "revised the page \u2192 revision ");
      link.href = encodeURIComponent(page) + ".html";
      link.appendChild(element("code", "", String(entry.revision)));
      text.appendChild(link);
      line.appendChild(text);
      return line;
    }

    // A centred system line: a title behind its mark, then what follows.
    function notice(state, kind, title, lines) {
      var line = element("li", "artifact-comment-notice artifact-comment-notice--" + state);
      line.dataset.state = state;
      line.setAttribute("role", "note");
      var head = element("p", "artifact-comment-notice-title");
      head.appendChild(mark(kind));
      head.appendChild(element("span", "", title));
      line.appendChild(head);
      lines.forEach(function (text) {
        line.appendChild(element("p", "artifact-comment-notice-text", text));
      });
      return line;
    }

    // A system line that only restates a state: the thread's live region
    // does not read it out.
    function quiet(line) {
      line.setAttribute("aria-hidden", "true");
      return line;
    }

    // What a reader's comment's state draws after it; null for none.
    function after(entry) {
      var handle = routed(entry);
      switch (entry.state) {
        case "unavailable":
          return quiet(notice("unavailable", "hollow", handle + " is offline",
            ["Your comment goes to " + handle + " when it checks in again."]));
        case "paused":
          return quiet(notice("paused", "pause", "The responder is paused",
            ["Your comment waits until it is resumed."]));
        case "failed":
          return notice("failed", "bang", handle + " couldn't answer", [
            entry.reason ? String(entry.reason) : "No reason given",
            "To send it again, write a new comment.",
          ]);
        default:
          return null;
      }
    }

    // The typing bubble a thread ends in while its newest reader comment has
    // no answer yet; null for none. It only restates the state, so the
    // thread's live region does not read it out.
    function typing(entry) {
      var handle = routed(entry);
      var drawn;
      var bubble;
      if (entry.state === "pending") {
        drawn = row("artifact-comment-typing artifact-comment-typing--pending",
          "artifact-comment-avatar--ghost", handle.charAt(0).toUpperCase());
        bubble = element("p", "artifact-comment-bubble artifact-comment-bubble--ghost",
          (checking ? "Checking for a reply from " : "Waiting for ") + handle);
        bubble.appendChild(mark("dots"));
      } else if (entry.state === "claimed") {
        drawn = row("artifact-comment-typing artifact-comment-typing--claimed",
          "artifact-comment-avatar--agent", handle.charAt(0).toUpperCase());
        var by = agentName(handle);
        by.appendChild(document.createTextNode(" is writing"));
        drawn.column.appendChild(by);
        bubble = element("p", "artifact-comment-bubble artifact-comment-bubble--typing");
        bubble.appendChild(mark("dots"));
        bubble.appendChild(element("span", "artifact-comment-sr", handle + " is writing a reply"));
      } else {
        return null;
      }
      drawn.item.setAttribute("aria-hidden", "true");
      drawn.column.appendChild(bubble);
      return drawn.item;
    }

    function rows(thread) {
      return [thread.root].concat(thread.replies);
    }

    // Whether a comment counts as unread: the route named it, and neither
    // a mark this page posted nor the reader's own reply since has read it.
    function counted(thread, entry) {
      return unread.has(entry.id) && entry.id > (seenTo.get(thread.root.id) || 0);
    }

    // How many comments in some threads count as unread.
    function unreadIn(threads) {
      return threads.reduce(function (n, thread) {
        return n + rows(thread).filter(function (entry) { return counted(thread, entry); }).length;
      }, 0);
    }

    // The thread is read up to comment id: by a mark posted, or the
    // reader's own reply.
    function readTo(thread, id) {
      seenTo.set(thread.root.id, Math.max(seenTo.get(thread.root.id) || 0, id));
    }

    // Mark a thread's unread comments, each with a "New" tag before its
    // byline, and put the divider above the first.
    function markUnread(thread) {
      var held = opening.get(thread.root.id);
      var first = null;
      rows(thread).forEach(function (entry) {
        var drawn = thread.drawn.get(entry.id);
        if (!drawn) {
          return;
        }
        var marked = counted(thread, entry) || Boolean(held && held.has(entry.id));
        if (marked && !first) {
          first = drawn.item;
        }
        if (drawn.item.classList.contains("artifact-comment--unread") === marked) {
          return;
        }
        drawn.item.classList.toggle("artifact-comment--unread", marked);
        var by = drawn.item.querySelector(".artifact-comment-by");
        if (marked) {
          by.insertBefore(element("span", "artifact-comment-new", "New"), by.firstChild);
        } else {
          by.querySelector(".artifact-comment-new").remove();
        }
      });
      if (!first) {
        if (thread.divider) {
          thread.divider.remove();
        }
        return;
      }
      if (!thread.divider) {
        // The tags say it to assistive technology; the line only shows it.
        thread.divider = element("li", "artifact-comment-divider");
        thread.divider.setAttribute("aria-hidden", "true");
        thread.divider.appendChild(element("span", "", "New since you last looked"));
      }
      if (thread.divider.nextSibling !== first) {
        thread.list.insertBefore(thread.divider, first);
      }
    }

    // Draw the replies to the reader outside the chips: each thread's
    // marks, the badge ending the header's date line and the tab's title.
    function showUnread() {
      var threads = [];
      shown.forEach(function (thread) {
        markUnread(thread);
        threads.push(thread);
      });
      var n = unreadIn(threads);
      document.title = n > 0 ? "(" + n + ") " + tabTitle : tabTitle;
      if (!dateLine) {
        return;
      }
      if (n > 0) {
        newBadge = newBadge || element("span", "artifact-unread");
        newBadge.textContent = (n === 1 ? "1 new reply" : n + " new replies") + " to you";
        if (dateLine.lastChild !== newBadge) {
          dateLine.appendChild(newBadge);
        }
      } else if (newBadge) {
        newBadge.remove();
      }
    }

    // A thread opened or closed, in the panel, a popover or the sheet, all
    // of which draw it (sidePanel's draw). Opened, it posts its newest
    // comment's id as seen, and keeps any comments unread marked while it
    // stays open; closed, it marks only what is still unread.
    function looked(thread, open) {
      if (!open) {
        if (opening.delete(thread.root.id)) {
          markUnread(thread);
        }
        return;
      }
      if (!tracked) {
        return;
      }
      var fresh = rows(thread).filter(function (entry) { return counted(thread, entry); });
      if (fresh.length) {
        opening.set(thread.root.id, new Set(fresh.map(function (entry) { return entry.id; })));
        markUnread(thread);
      }
      seeThread(thread);
    }

    // Post that the reader has seen a thread up to its newest comment; the
    // counts drop once it is stored. A failure leaves them as they were.
    async function seeThread(thread) {
      var newest = rows(thread).reduce(function (n, entry) { return Math.max(n, entry.id); }, 0);
      try {
        var response = await fetch(SEEN, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ page: page, thread: thread.root.id, comment: newest }),
        });
        var payload = await json(response);
        if (response.status === 200 && payload && typeof payload.comment === "number") {
          readTo(thread, payload.comment);
          refresh();
        }
      } catch (ignored) {
        // Still unread, as if never opened.
      }
    }

    // A thread waits while any reader comment in it has no answer yet.
    function waits(thread) {
      return rows(thread).some(function (entry) {
        return !agent(entry) && (entry.state === "pending" || entry.state === "claimed");
      });
    }

    // What a row draws after it, as a key: a mark is drawn again only when
    // its key changes.
    function markKey(entry) {
      if (agent(entry)) {
        return entry.revision ? "revision " + entry.revision : "";
      }
      return [entry.state, routed(entry), entry.reason || ""].join("\n");
    }

    // Draw what a thread does not show yet, in place: each comment once, by
    // id, and a mark after it or the typing bubble at its end only when what
    // that says has changed. Nothing drawn is moved, so the thread's live
    // region reads out only what is new. The box is told how many comments
    // and replies were drawn. True when anything was drawn.
    function sync(thread) {
      var list = thread.list;
      var at = null;
      var newest = null;
      var touched = false;
      var count = 0;
      function place(node) {
        list.insertBefore(node, at ? at.nextSibling : list.firstChild);
        at = node;
      }
      rows(thread).forEach(function (entry) {
        var drawn = thread.drawn.get(entry.id);
        if (drawn) {
          at = drawn.item;
        } else {
          drawn = { item: comment(entry), mark: null, key: "" };
          thread.drawn.set(entry.id, drawn);
          place(drawn.item);
          touched = true;
          count += 1;
        }
        if (!agent(entry)) {
          newest = entry;
        }
        var key = markKey(entry);
        if (key !== drawn.key) {
          if (drawn.mark) {
            drawn.mark.remove();
          }
          drawn.mark = agent(entry) ? (entry.revision ? revised(entry) : null) : after(entry);
          drawn.key = key;
          touched = true;
        }
        if (drawn.mark) {
          if (drawn.mark.parentNode) {
            at = drawn.mark;
          } else {
            place(drawn.mark);
          }
        }
      });
      var waitKey = newest ? [newest.state, routed(newest), checking].join("\n") : "";
      if (waitKey !== thread.waitKey) {
        if (thread.typing) {
          thread.typing.remove();
        }
        thread.typing = newest && typing(newest);
        if (thread.typing) {
          list.appendChild(thread.typing);
        }
        thread.waitKey = waitKey;
        touched = true;
      }
      label(thread, newest || thread.root);
      if (count && thread.box) {
        thread.box.dispatchEvent(new CustomEvent(DRAWN, { bubbles: true, detail: { rows: count } }));
      }
      return touched;
    }

    // Take rows into a thread by id: a new one is added, a known one takes
    // the copy just read. True when anything was drawn.
    function merge(thread, entries) {
      entries.forEach(function (entry) {
        if (!entry) {
          return;
        }
        if (entry.id === thread.root.id) {
          thread.root = entry;
          return;
        }
        var known = thread.replies.findIndex(function (reply) { return reply.id === entry.id; });
        if (known < 0) {
          thread.replies.push(entry);
        } else {
          thread.replies[known] = entry;
        }
      });
      thread.replies.sort(function (a, b) { return a.id - b.id; });
      return sync(thread);
    }

    function failure(response, payload) {
      if (response.status === 401) {
        return SIGNED_OUT;
      }
      if (response.status === 409 && payload && payload.error === "stale_page") {
        return STALE_PAGE;
      }
      var error = payload && payload.error ? String(payload.error) : "status " + response.status;
      return "Not saved (" + error + "). Try again.";
    }

    // Post body from form, with the images attached to it; the stored row,
    // or null with the form told why. While it saves, the composer takes no
    // other image and keeps those it sends.
    async function post(form, body) {
      var status = form.querySelector(".artifact-comment-status");
      var button = form.querySelector('button[type="submit"]');
      var images = attached.get(form);
      if (images && images.busy()) {
        status.textContent = "Wait until the images have uploaded.";
        return null;
      }
      var names = images ? images.sending() : [];
      if (names.length) {
        body.images = names;
      }
      var saved = false;
      button.disabled = true;
      status.textContent = "Saving...";
      try {
        var response = await fetch(COMMENTS, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        var payload = await json(response);
        if (response.status !== 201 || !payload) {
          status.textContent = failure(response, payload);
          return null;
        }
        status.textContent = "";
        form.elements.text.value = "";
        saved = true;
        return payload;
      } catch (ignored) {
        status.textContent = "Not saved: the site did not answer. Try again.";
        return null;
      } finally {
        if (images) {
          images.sent(saved);
        }
        button.disabled = false;
      }
    }

    // The composer's control: "Reply" once an agent has answered in the
    // thread; before that the quieter "Add to your comment", its field
    // saying the agent reads it with the comment.
    function label(thread, entry) {
      var answered = rows(thread).some(function (each) { return agent(each) !== ""; });
      var name = answered ? "Reply" : "Add to your comment";
      var hint = answered ? "" : "Add detail. " + routed(entry) + " reads it with your comment.";
      if (thread.toggle.textContent !== name) {
        thread.toggle.textContent = name;
        thread.toggle.classList.toggle("artifact-comment-toggle--quiet", !answered);
        thread.field.setAttribute("aria-label", name);
      }
      if (thread.field.placeholder !== hint) {
        thread.field.placeholder = hint;
      }
    }

    // A thread's composer: a control that unfolds the reply form, folded
    // until clicked.
    function replyForm(thread, node) {
      var toggle = element("button", "artifact-comment-toggle");
      toggle.type = "button";
      var form = element("form", "artifact-comment-reply");
      form.id = "artifact-comment-reply-" + thread.root.id;
      toggle.setAttribute("aria-controls", form.id);
      var text = element("textarea");
      text.name = "text";
      text.rows = 2;
      text.maxLength = 4000;
      text.required = true;
      form.appendChild(text);
      var actions = element("div", "artifact-comment-actions");
      var button = element("button", "", "Send");
      button.type = "submit";
      actions.appendChild(button);
      var status = element("p", "artifact-comment-status");
      status.setAttribute("role", "status");
      actions.appendChild(status);
      form.appendChild(actions);
      attached.set(form, attachments(form, text));
      thread.toggle = toggle;
      thread.field = text;
      thread.unfold = unfold;

      function unfold(open) {
        form.hidden = !open;
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
      }
      unfold(false);
      toggle.addEventListener("click", function () {
        unfold(form.hidden);
        if (!form.hidden) {
          text.focus();
        }
      });
      form.addEventListener("submit", async function (event) {
        event.preventDefault();
        var row = await post(form, { page: page, parent: thread.root.id, text: text.value });
        if (row) {
          var focused = form.contains(document.activeElement)
            || document.activeElement === document.body;
          unfold(false);
          if (focused) {
            toggle.focus();
          }
          readTo(thread, row.id);
          merge(thread, [row]);
          posted();
        }
      });
      node.appendChild(toggle);
      node.appendChild(form);
    }

    // The threads of a section's box, oldest first.
    function threadsOf(box) {
      var found = [];
      shown.forEach(function (thread) {
        if (thread.box === box) {
          found.push(thread);
        }
      });
      return found.sort(function (a, b) { return a.root.id - b.root.id; });
    }

    // Comments on passages. Words selected in the body, within one section,
    // show a pill just above the selection's end (below it on a touch
    // screen), and pressing it (or Control+Alt+M) opens a composer quoting
    // them, the words under a dashed mark: in the panel's group of their
    // section, else in a popover or the bottom sheet. A thread whose first
    // comment quotes a passage is found in the page's text from its quote
    // and drawn on its words: a highlight, then its number, which is its
    // entry's in the panel. One not found is listed with its quote struck
    // through; a resolved one is not drawn.
    function selectPassages() {
      var api = {};
      // The thread the pointer is on, on the page and in the panel.
      var pointed = { page: null, entry: null };
      // The open composer: its holder, the marks on its words and its box.
      var open = null;
      // Where a thread just posted from a selection starts in the page's
      // text, so its words are those selected even where they occur twice.
      var hints = new Map();

      api.detached = function (thread) {
        return Boolean(thread.root.quote) && thread.spot === null && !resolved(thread);
      };

      // What a passage's entry and box say of its words: the quote, struck
      // through once the words are not found, and why.
      api.said = function (thread) {
        var exact = String(thread.root.quote.exact || "");
        if (!api.detached(thread)) {
          return [element("span", "artifact-passage-quoted", exact)];
        }
        return [
          element("del", "artifact-passage-quoted", exact),
          why(),
        ];
      };

      // Why the words are struck through; the revision that changed them is
      // only in its title.
      function why() {
        var node = element("span", "artifact-passage-why", " · this passage has changed since");
        if (revision) {
          node.title = "Changed in revision " + revision;
        }
        return node;
      }

      // What a thread's entry and head show change only with this.
      api.key = function (thread) {
        return thread.n + " " + api.detached(thread);
      };

      // A thread's words are lit while the pointer is on them or on its
      // entry, and while it is open in the panel, a popover or the sheet.
      api.shine = function (thread) {
        var on = thread === pointed.page || thread === pointed.entry || panel.lit(thread);
        thread.marks.forEach(function (mark) {
          mark.classList.toggle("artifact-passage--lit", on);
        });
        if (thread.number) {
          thread.number.classList.toggle("artifact-passage-number--lit", on);
        }
      };

      api.point = function (thread, where) {
        var before = pointed[where];
        if (before === thread) {
          return;
        }
        pointed[where] = thread;
        if (before) {
          api.shine(before);
        }
        if (thread) {
          api.shine(thread);
        }
      };

      function find(model, thread) {
        var exact = String(thread.root.quote.exact || "");
        var hint = hints.get(thread.root.id);
        hints.delete(thread.root.id);
        if (hint !== undefined && model.text.slice(hint, hint + exact.length) === exact) {
          return { start: hint, end: hint + exact.length };
        }
        return locate(model, thread.root.quote);
      }

      function draw(thread) {
        var id = String(thread.root.id);
        thread.marks = wrap(article, thread.spot.start, thread.spot.end, function () {
          var mark = element("mark", "artifact-passage");
          mark.dataset.thread = id;
          mark.setAttribute("aria-describedby", "artifact-comment-text-" + id);
          return mark;
        });
        if (!thread.marks.length) {
          thread.spot = null;
          return;
        }
        thread.marks[0].classList.add("artifact-passage--first");
        // Its number is a button that opens it, after the last mark or,
        // when that is in a link, after the outermost link: the link and the
        // thread each keep their own target.
        var number = element("button", "artifact-passage-number");
        number.type = "button";
        number.dataset.thread = id;
        var after = thread.marks[thread.marks.length - 1];
        for (var link = after.closest("a"); link && article.contains(link); link = link.parentNode.closest("a")) {
          after = link;
        }
        after.parentNode.insertBefore(number, after.nextSibling);
        thread.number = number;
        api.shine(thread);
      }

      function erase(thread) {
        if (thread.number) {
          thread.number.remove();
          thread.number = null;
        }
        unwrap(thread.marks);
        thread.marks = [];
      }

      // Where a thread's section is in the page, those it no longer has last.
      function sectionAt(thread) {
        var at = boxes.indexOf(thread.box);
        return at < 0 ? boxes.length : at;
      }

      // Find each open passage thread not looked for yet, draw it or take a
      // resolved one away, and number them: those drawn in page order, then
      // those not found.
      api.update = function () {
        var threads = [];
        shown.forEach(function (thread) {
          if (thread.root.quote) {
            threads.push(thread);
          }
        });
        var model = null;
        var found = [];
        threads.forEach(function (thread) {
          if (resolved(thread)) {
            erase(thread);
            thread.spot = undefined;
          } else if (thread.spot === undefined) {
            model = model || textModel(article);
            thread.spot = find(model, thread);
            if (thread.spot) {
              found.push(thread);
            }
          }
        });
        // Drawing splits text nodes, never the text: each draws from its own read.
        found.forEach(draw);
        var drawn = threads.filter(function (thread) {
          return thread.marks.length > 0;
        }).sort(function (a, b) {
          return a.spot.start - b.spot.start || a.root.id - b.root.id;
        });
        var lost = threads.filter(api.detached).sort(function (a, b) {
          return sectionAt(a) - sectionAt(b) || a.root.id - b.root.id;
        });
        threads.forEach(function (thread) {
          thread.n = 0;
        });
        drawn.concat(lost).forEach(function (thread, index) {
          thread.n = index + 1;
        });
        drawn.forEach(function (thread) {
          if (thread.number.textContent !== String(thread.n)) {
            thread.number.textContent = String(thread.n);
            thread.number.setAttribute("aria-label", "Open comment " + thread.n);
          }
        });
        threads.forEach(function (thread) {
          var key = api.key(thread);
          if (thread.head && thread.headKey !== key) {
            thread.headKey = key;
            thread.head.replaceChildren.apply(thread.head, api.said(thread));
          }
        });
      };

      // Put the open composer where the window has room for it.
      api.place = function () {
        if (!open) {
          return;
        }
        if (panel.wide) {
          panel.compose(open.box, open.holder);
        } else {
          panel.passage(open);
        }
      };

      // Close a composer if it is still open: its popover or sheet was.
      api.cancel = function (mine) {
        if (open === mine) {
          close(mine);
        }
      };

      // The open composer's words, its section (and where its box is among
      // the page's), what is written in it and the images attached, to open
      // again after a reload (api.reopen); null when none is open. held
      // says whether it has images attached or on their way.
      api.writing = function () {
        return open ? {
          quote: open.quote, section: open.box.dataset.section, index: boxes.indexOf(open.box),
          text: open.field.value, images: attached.get(open.form).kept(),
          held: attached.get(open.form).held(),
        } : null;
      };

      // Open a composer again on the words kept, where the page still has
      // them, holding the text and images kept; false when it has them no
      // more.
      api.reopen = function (kept) {
        if (!article || !kept.quote || typeof kept.quote.exact !== "string") {
          return false;
        }
        var model = textModel(article);
        var spot = locate(model, kept.quote);
        var runs = spot ? pieces(model, spot.start, spot.end) : [];
        var box = runs.length ? boxAfter(runs[0].node, runs[0].from) : null;
        if (!box) {
          return false;
        }
        compose({ box: box, start: spot.start, quote: kept.quote });
        open.field.value = String(kept.text || "");
        var over = attached.get(open.form).restore(kept.images);
        if (over) {
          open.form.querySelector(".artifact-comment-status").textContent = over;
        }
        return true;
      };

      if (!article) {
        return api;
      }

      function close(mine) {
        mine.holder.remove();
        unwrap(mine.marks);
        if (open === mine) {
          open = null;
        }
        panel.dropped(mine);
      }

      // Whether a boundary point may be part of a passage: in the body, out
      // of everything APART.
      function inside(node) {
        var parent = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
        return Boolean(parent) && article.contains(parent) && !parent.closest(APART);
      }

      // The first section box after a boundary point.
      function boxAfter(node, offset) {
        var point = document.createRange();
        point.setStart(node, offset);
        return boxes.filter(function (box) { return point.comparePoint(box, 0) > 0; })[0] || null;
      }

      // The passage the reader has selected, or null when it is not one a
      // comment can be on: 1 to MAX_EXACT characters of the page's text, all
      // in it and in one section.
      function selected() {
        var selection = document.getSelection();
        if (!selection || !selection.rangeCount || selection.isCollapsed) {
          return null;
        }
        var range = selection.getRangeAt(0);
        if (!inside(range.startContainer) || !inside(range.endContainer)) {
          return null;
        }
        var model = textModel(article);
        var text = model.text;
        var start = offsetOf(model, range.startContainer, range.startOffset);
        var end = offsetOf(model, range.endContainer, range.endOffset);
        while (start < end && text.charAt(start) === " ") {
          start += 1;
        }
        while (end > start && text.charAt(end - 1) === " ") {
          end -= 1;
        }
        var exact = text.slice(start, end);
        var size = Array.from(exact).length;
        var runs = pieces(model, start, end);
        if (size < 1 || size > MAX_EXACT || !runs.length) {
          return null;
        }
        var first = runs[0];
        var last = runs[runs.length - 1];
        var span = document.createRange();
        span.setStart(first.node, first.from);
        span.setEnd(last.node, last.to);
        if (all(APART, article).some(function (node) { return span.intersectsNode(node); })) {
          return null;
        }
        var box = boxAfter(first.node, first.from);
        if (!box || box !== boxAfter(last.node, last.to)) {
          return null;
        }
        var tail = document.createRange();
        tail.setStart(last.node, last.from);
        tail.setEnd(last.node, last.to);
        // A few units more than the context, so no code point is cut in two.
        var before = Array.from(text.slice(Math.max(0, start - 2 * CONTEXT - 2), start));
        var after = Array.from(text.slice(end, end + 2 * CONTEXT + 2));
        return {
          box: box, start: start, tail: tail,
          quote: {
            exact: exact,
            prefix: before.slice(Math.max(0, before.length - CONTEXT)).join(""),
            suffix: after.slice(0, CONTEXT).join(""),
          },
        };
      }

      var pill = element("button", "artifact-passage-pill");
      pill.type = "button";
      // It never takes focus: the selection stays as it is.
      pill.tabIndex = -1;
      pill.hidden = true;
      pill.setAttribute("aria-keyshortcuts", "Control+Alt+M");
      var icon = element("span", "artifact-passage-pill-icon");
      icon.setAttribute("aria-hidden", "true");
      pill.append(icon, "Comment");
      document.body.appendChild(pill);

      // The pill just above the end of the selection, leaning left of it and
      // inside the reading column; on a touch screen, whose own menu takes
      // the room above, just below it.
      function offer(found) {
        var rects = found.tail.getClientRects();
        var line = rects[rects.length - 1];
        if (!line) {
          return;
        }
        pill.hidden = false;
        var width = pill.offsetWidth;
        var column = article.getBoundingClientRect();
        var left = Math.max(column.left, Math.min(line.right - width * 0.75, column.right - width));
        var below = window.matchMedia(COARSE).matches;
        pill.classList.toggle("artifact-passage-pill--below", below);
        pill.style.left = Math.round(left + window.scrollX) + "px";
        pill.style.top = Math.round(window.scrollY +
          (below ? line.bottom + 8 : line.top - pill.offsetHeight - 8)) + "px";
        pill.style.setProperty("--artifact-passage-tip",
          Math.round(Math.max(12, Math.min(width - 12, line.right - left))) + "px");
      }

      // Once the selection keeps still, with no button held, offer the pill.
      var settling = null;
      var pressed = false;
      function steady() {
        pill.hidden = true;
        clearTimeout(settling);
        settling = setTimeout(function () {
          var found = pressed ? null : selected();
          if (found) {
            offer(found);
          }
        }, STILL);
      }
      document.addEventListener("selectionchange", steady);
      document.addEventListener("pointerdown", function (event) {
        pressed = !pill.contains(event.target);
      });
      document.addEventListener("pointerup", function () {
        if (pressed) {
          pressed = false;
          steady();
        }
      });
      window.addEventListener("resize", function () {
        pill.hidden = true;
      });

      function compose(found) {
        if (open) {
          close(open);
        }
        pill.hidden = true;
        var holder = element("div", "artifact-passage-composer");
        holder.appendChild(element("p", "artifact-passage-quote", found.quote.exact));
        var form = element("form", "artifact-comment-form artifact-passage-form");
        var field = element("textarea");
        field.name = "text";
        field.rows = 2;
        field.maxLength = 4000;
        field.required = true;
        field.setAttribute("aria-label", "Comment on the selected words");
        var actions = element("div", "artifact-comment-actions");
        var send = element("button", "", "Comment");
        send.type = "submit";
        var status = element("p", "artifact-comment-status");
        status.setAttribute("role", "status");
        actions.append(send, status);
        form.append(field, actions);
        attached.set(form, attachments(form, field));
        var quit = element("button", "artifact-passage-cancel", "Cancel");
        quit.type = "button";
        holder.append(form, quit);
        var marks = wrap(article, found.start, found.start + found.quote.exact.length, function () {
          return element("mark", "artifact-passage artifact-passage--pending");
        });
        var mine = {
          holder: holder, marks: marks, box: found.box, quote: found.quote, field: field, form: form,
        };
        open = mine;
        document.getSelection().removeAllRanges();
        api.place();
        field.focus({ preventScroll: true });

        quit.addEventListener("click", function () { close(mine); });
        holder.addEventListener("keydown", function (event) {
          if (event.key === "Escape") {
            // The panel would fold on it too.
            event.preventDefault();
            event.stopPropagation();
            close(mine);
          }
        });
        form.addEventListener("submit", async function (event) {
          event.preventDefault();
          var fields = {
            page: page, section: found.box.dataset.section, text: field.value, quote: found.quote,
          };
          if (revision !== null) {
            fields.revision = revision;
          }
          var row = await post(form, fields);
          if (!row) {
            return;
          }
          var focused = holder.contains(document.activeElement) || document.activeElement === document.body;
          if (open === mine) {
            close(mine);
          }
          hints.set(row.id, found.start);
          add({ root: row, replies: [] });
          posted();
          panel.started(shown.get(row.id), focused);
        });
      }

      pill.addEventListener("mousedown", function (event) {
        event.preventDefault();
      });
      pill.addEventListener("click", function () {
        var found = selected();
        if (found) {
          compose(found);
        }
      });
      document.addEventListener("keydown", function (event) {
        if (!event.ctrlKey || !event.altKey || event.metaKey || event.shiftKey ||
            (event.code !== "KeyM" && String(event.key).toLowerCase() !== "m")) {
          return;
        }
        var found = selected();
        if (found) {
          event.preventDefault();
          compose(found);
        }
      });

      // The thread whose highlight or number a node is in, if any.
      function threadAt(node) {
        var drawn = node && node.closest &&
          node.closest("mark.artifact-passage[data-thread], .artifact-passage-number");
        return drawn ? shown.get(Number(drawn.dataset.thread)) || null : null;
      }
      article.addEventListener("mouseover", function (event) {
        api.point(threadAt(event.target), "page");
      });
      article.addEventListener("mouseleave", function () {
        api.point(null, "page");
      });
      // A highlight or its number opens its thread: in the panel, else in a
      // popover under it or the bottom sheet. A click on a highlight that
      // ends a selection, or is in a link, is left to them; its number, a
      // button outside any link, opens the thread whatever is selected.
      article.addEventListener("click", function (event) {
        var thread = threadAt(event.target);
        var selection = document.getSelection();
        if (!thread) {
          return;
        }
        if (!event.target.closest(".artifact-passage-number") &&
            ((selection && !selection.isCollapsed) || event.target.closest("a"))) {
          return;
        }
        if (panel.wide) {
          panel.open(thread);
        } else {
          panel.show({ thread: thread }, event.target.closest("mark, .artifact-passage-number"));
        }
      });
      return api;
    }

    // The side panel (layout C of docs/design/margin-comments-mockup.html),
    // shown while the window leaves ROOM right of the reading column: fixed
    // to the window's right edge, folded to a rail of one dot per open thread
    // or open with every thread listed under its section's heading, one
    // entry open at a time. A thread's node is moved into its entry, never
    // drawn twice, so its live reads, composer and live region go on as they
    // were. Each box's summary is a chip saying where its section's open
    // threads stand, which opens them here: a box never opens, and nothing
    // in the column moves when the panel or a thread changes. Without that
    // room the entries stay in their groups out of sight, and one at a time
    // is moved into a popover or the bottom sheet (js/narrow.js).
    function sidePanel() {
      var column = document.querySelector(".artifact-body");
      var api = { wide: false, mode: null };
      var arranged = false;
      var open = false;
      // The thread whose entry is open, if any.
      var current = null;
      // The resolved thread the reader opened to read, if any: a thread
      // resolved while open closes, unless it is this one.
      var toRead = null;
      // While the threads move to another layout (api.arrange), none opens
      // or closes: one open in the old place is open in the new.
      var moving = false;
      var groups = new Map();
      // Each decision's chip, by its form, once it has a thread.
      var decisionChips = new Map();
      var dotsKey = null;
      // Whether resolved threads are listed: hidden unless the reader shows
      // them, for the page in this session.
      var resolvedShown = false;
      var resolvedKey = RESOLVED_SHOWN + location.pathname;

      try {
        open = localStorage.getItem(PANEL) === "open";
      } catch (ignored) {
        open = false;
      }
      try {
        resolvedShown = sessionStorage.getItem(resolvedKey) === "1";
      } catch (ignored) {
        resolvedShown = false;
      }

      function mute(node) {
        node.setAttribute("aria-hidden", "true");
        return node;
      }

      var aside = element("aside", "artifact-comments-panel");
      aside.setAttribute("aria-label", "Comments");
      aside.hidden = true;

      var rail = element("div", "artifact-comments-rail");
      var opener = element("button", "artifact-comments-opener");
      opener.type = "button";
      opener.setAttribute("aria-label", "Comments");
      opener.setAttribute("aria-controls", "artifact-comments-sheet");
      opener.setAttribute("aria-describedby", "artifact-comments-count");
      opener.appendChild(mute(element("span", "artifact-comments-icon")));
      var badge = element("span", "artifact-comments-badge");
      var dots = mute(element("ol", "artifact-comments-dots"));
      rail.append(opener, badge, dots,
        mute(element("span", "artifact-comments-rail-label", "Comments")));

      var sheet = element("div", "artifact-comments-sheet");
      sheet.id = "artifact-comments-sheet";
      var head = element("header", "artifact-comments-head");
      var count = element("p", "artifact-comments-count");
      count.id = "artifact-comments-count";
      var fold = element("button", "artifact-comments-fold");
      fold.type = "button";
      fold.setAttribute("aria-label", "Fold comments");
      fold.appendChild(mute(element("span", "", "»")));
      // Shows or hides the resolved threads; not drawn while there are none.
      var showResolved = element("button", "artifact-comments-show-resolved");
      showResolved.type = "button";
      showResolved.hidden = true;
      var tally = element("div", "artifact-comments-tally");
      tally.append(count, showResolved);
      head.append(element("h2", "artifact-comments-title", "Comments"), tally, fold);
      var list = element("div", "artifact-comments-groups");
      // The one way to start a thread on a section: a button opening a list
      // of the page's sections, under a word saying when there are no threads.
      var start = element("div", "artifact-comments-start");
      var none = element("p", "artifact-comments-none", "No comments yet");
      var pick = element("button", "artifact-comments-pick", "Comment on a section");
      pick.type = "button";
      var choices = element("ul", "artifact-comments-choices");
      choices.id = "artifact-comments-choices";
      choices.setAttribute("role", "listbox");
      choices.setAttribute("aria-label", "Sections");
      choices.tabIndex = -1;
      choices.hidden = true;
      pick.setAttribute("aria-haspopup", "listbox");
      pick.setAttribute("aria-expanded", "false");
      pick.setAttribute("aria-controls", choices.id);
      start.append(none, pick, choices);
      sheet.append(head, start, list);
      aside.append(rail, sheet);
      document.body.appendChild(aside);

      // The text of a box's section heading, without the mark a folded
      // heading ends in or the tag saying it changed.
      function title(box) {
        var heading = document.getElementById(box.dataset.section);
        if (!heading || heading.tagName !== "H2") {
          return "This page";
        }
        var copy = heading.cloneNode(true);
        all(".artifact-section-mark, .artifact-changed-tag, .artifact-review-open", copy).forEach(function (mark) { mark.remove(); });
        return copy.textContent.replace(/\s+/g, " ").trim() || "This page";
      }

      // A group: a section's heading, its threads, and for a section the
      // page has, the control that opens the box's form here. The panel
      // never draws that control; a popover or the sheet does.
      function group(name, box, index) {
        var node = element("section", "artifact-comments-group");
        var entries = element("ol", "artifact-comments-entries");
        node.append(element("h3", "artifact-comments-group-title", name), entries);
        list.appendChild(node);
        var made = { node: node, entries: entries, box: box, toggle: null, holder: null };
        if (box) {
          var toggle = element("button", "artifact-comments-new", "Comment on this section");
          toggle.type = "button";
          var holder = element("div", "artifact-comments-compose");
          holder.id = "artifact-comments-compose-" + index;
          holder.hidden = true;
          toggle.setAttribute("aria-controls", holder.id);
          toggle.setAttribute("aria-expanded", "false");
          toggle.addEventListener("click", function () { compose(made, holder.hidden); });
          node.append(toggle, holder);
          made.toggle = toggle;
          made.holder = holder;
        }
        return made;
      }

      boxes.forEach(function (box, index) {
        var name = title(box);
        var made = group(name, box, index);
        made.node.hidden = true;
        groups.set(box, made);
        var option = element("li", "artifact-comments-choice", name);
        option.id = "artifact-comments-choice-" + index;
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", "false");
        option.addEventListener("click", function () { choose(box); });
        choices.appendChild(option);
      });
      var strays = group(CHANGED_GROUP, null, -1);
      strays.node.hidden = true;

      // The option lit in the list of sections, or -1.
      var active = -1;

      function light(index) {
        active = index;
        all(":scope > li", choices).forEach(function (option, at) {
          option.setAttribute("aria-selected", at === index ? "true" : "false");
        });
        if (index < 0) {
          choices.removeAttribute("aria-activedescendant");
          return;
        }
        var option = choices.children[index];
        choices.setAttribute("aria-activedescendant", option.id);
        if (option.offsetTop < choices.scrollTop) {
          choices.scrollTop = option.offsetTop;
        } else if (option.offsetTop + option.offsetHeight > choices.scrollTop + choices.clientHeight) {
          choices.scrollTop = option.offsetTop + option.offsetHeight - choices.clientHeight;
        }
      }

      // Close the list of sections; with focus, the focus goes back to its
      // button.
      function unpick(focus) {
        if (choices.hidden) {
          return;
        }
        choices.hidden = true;
        pick.setAttribute("aria-expanded", "false");
        light(-1);
        if (focus) {
          pick.focus({ preventScroll: true });
        }
      }

      // A section chosen: its group shows with its form open.
      function choose(box) {
        unpick(false);
        compose(groups.get(box), true);
      }

      pick.addEventListener("click", function () {
        if (!choices.hidden) {
          unpick(true);
          return;
        }
        choices.hidden = false;
        pick.setAttribute("aria-expanded", "true");
        light(-1);
        choices.focus({ preventScroll: true });
      });
      choices.addEventListener("keydown", function (event) {
        var last = choices.children.length - 1;
        if (event.key === "ArrowDown") {
          light(Math.min(active + 1, last));
        } else if (event.key === "ArrowUp") {
          light(active < 0 ? last : Math.max(active - 1, 0));
        } else if (event.key === "Home") {
          light(0);
        } else if (event.key === "End") {
          light(last);
        } else if (event.key === "Enter" || event.key === " ") {
          if (active >= 0) {
            choose(boxes[active]);
          }
        } else if (event.key === "Escape") {
          // The panel would fold on it too.
          event.stopPropagation();
          unpick(true);
        } else {
          if (event.key === "Tab") {
            unpick(false);
          }
          return;
        }
        event.preventDefault();
      });
      // A click outside the list closes it; the focus goes back to its
      // button unless the click gave it to something else.
      document.addEventListener("click", function (event) {
        if (choices.hidden || start.contains(event.target)) {
          return;
        }
        unpick(document.activeElement === document.body || start.contains(document.activeElement));
      }, true);

      // Whether a group holds a thread that is listed: an open one, or a
      // resolved one while they are shown.
      function showing(made) {
        return Boolean(resolvedShown ? made.entries.firstChild :
          made.entries.querySelector(":scope > .artifact-comments-entry:not(.artifact-comments-entry--resolved)"));
      }

      // Whether a group is listed: it holds a listed thread, or a form open
      // in it.
      function busy(made) {
        return showing(made) ||
          (!made.holder.hidden && made.node.contains(made.holder)) ||
          Boolean(made.node.querySelector(".artifact-passage-composer"));
      }

      // List the groups that are busy, each in its place in the page's
      // order, keeping the reader's place: the group at the top of the list
      // stays where it is.
      function tidy() {
        none.hidden = shown.size > 0;
        strays.node.hidden = !showing(strays);
        var changes = [];
        groups.forEach(function (made) {
          if (made.node.hidden === busy(made)) {
            changes.push(made);
          }
        });
        if (!changes.length) {
          return;
        }
        var top = list.getBoundingClientRect().top;
        var anchor = all(":scope > .artifact-comments-group:not([hidden])", list).filter(function (node) {
          return node.getBoundingClientRect().bottom > top;
        })[0];
        var before = anchor ? anchor.getBoundingClientRect().top : 0;
        changes.forEach(function (made) {
          made.node.hidden = !made.node.hidden;
        });
        if (anchor) {
          list.scrollTop += anchor.getBoundingClientRect().top - before;
        }
      }

      // Unfold or fold a group's form for a new thread; unfolded, its field
      // has focus. In the panel one form is open at a time: another left
      // empty folds.
      function compose(made, show) {
        if (show && api.wide) {
          groups.forEach(function (other) {
            if (other !== made && !other.holder.hidden && !forms.get(other.box).elements.text.value) {
              other.holder.hidden = true;
              other.toggle.setAttribute("aria-expanded", "false");
            }
          });
        }
        made.holder.hidden = !show;
        made.toggle.setAttribute("aria-expanded", show ? "true" : "false");
        tidy();
        if (show) {
          if (api.wide) {
            reveal(made.holder);
          } else {
            over.uncover(made.holder);
          }
          forms.get(made.box).elements.text.focus({ preventScroll: true });
        }
      }

      // Scroll the panel's list, never the page, until node is in view.
      function reveal(node) {
        var outer = list.getBoundingClientRect();
        var inner = node.getBoundingClientRect();
        if (inner.top < outer.top || inner.bottom > outer.bottom) {
          list.scrollTop += inner.top - outer.top - 8;
        }
      }

      function setOpen(show, remember) {
        var was = open;
        open = show;
        // The thread open in it goes out of view or comes back into it,
        // drawn once the caller has chosen which thread that is, so one
        // only passing through is never taken as seen.
        if (show !== was) {
          queueMicrotask(function () {
            if (current) {
              draw(current);
            }
            showUnread();
          });
        }
        aside.classList.toggle("artifact-comments-panel--open", show);
        rail.hidden = show;
        sheet.hidden = !show;
        opener.setAttribute("aria-expanded", show ? "true" : "false");
        if (remember) {
          try {
            localStorage.setItem(PANEL, show ? "open" : "folded");
          } catch (ignored) {
            // Storage refused: the panel still opens, only unremembered.
          }
        }
      }
      setOpen(open, false);

      // Show or hide the resolved threads, and the groups holding only them.
      function setResolvedShown(show, remember) {
        resolvedShown = show;
        aside.classList.toggle("artifact-comments-panel--resolved-shown", show);
        showResolved.setAttribute("aria-pressed", show ? "true" : "false");
        if (remember) {
          try {
            if (show) {
              sessionStorage.setItem(resolvedKey, "1");
            } else {
              sessionStorage.removeItem(resolvedKey);
            }
          } catch (ignored) {
            // Storage refused: the threads still show, only unremembered.
          }
        }
      }
      setResolvedShown(resolvedShown, false);

      // The control's words, for the page's n resolved threads.
      function labelResolved(n) {
        showResolved.hidden = n === 0;
        showResolved.textContent = resolvedShown ? "Hide resolved" : "Show resolved (" + n + ")";
      }

      showResolved.addEventListener("click", function () {
        setResolvedShown(!resolvedShown, true);
        // A resolved thread open to read is hidden with the rest: it closes.
        if (!resolvedShown && current && current === toRead && resolved(current)) {
          expand(null);
        }
        api.refresh();
      });

      rail.addEventListener("click", function () {
        setOpen(true, true);
        fold.focus({ preventScroll: true });
      });
      fold.addEventListener("click", function () {
        setOpen(false, true);
        opener.focus({ preventScroll: true });
      });
      aside.addEventListener("keydown", function (event) {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          setOpen(false, true);
          opener.focus({ preventScroll: true });
        }
      });

      // The newest reader comment in a thread.
      function asked(thread) {
        var found = thread.root;
        rows(thread).forEach(function (entry) {
          if (!agent(entry)) {
            found = entry;
          }
        });
        return found;
      }

      // Where a thread stands: answered, writing, waiting or failed.
      function standing(thread) {
        switch (asked(thread).state) {
          case "claimed":
            return "writing";
          case "failed":
            return "failed";
          case "pending":
          case "unavailable":
          case "paused":
            return "waiting";
          default:
            return "answered";
        }
      }

      // Of some threads, the one whose newest reader comment is newest.
      function latest(threads) {
        var found = null;
        threads.forEach(function (thread) {
          if (!found || asked(thread).id > asked(found).id) {
            found = thread;
          }
        });
        return found;
      }

      function unresolvedOf(box) {
        return threadsOf(box).filter(function (thread) { return !resolved(thread); });
      }

      function plural(n, one, many) {
        return n + " " + (n === 1 ? one : many);
      }

      // The first words of what a thread's first comment says.
      function opening(text) {
        var words = String(text || "").replace(/\s+/g, " ").trim();
        return words.length > 80 ? words.slice(0, 80).replace(/\s\S*$/, "") + "…" : words;
      }

      function tick() {
        return mute(element("span", "artifact-comments-tick", "✓"));
      }

      function entry(thread) {
        if (thread.entry) {
          return thread.entry;
        }
        var id = thread.root.id;
        // A mark and words, filled in by draw: a passage's number and quote,
        // or § and what the thread's first comment says.
        var marks = [];
        var words = [];
        function lead() {
          var mark = mute(element("span", "artifact-comments-entry-mark"));
          var said = element("span", "artifact-comments-entry-words");
          marks.push(mark);
          words.push(said);
          return [mark, said];
        }
        var item = element("li", "artifact-comments-entry");
        item.dataset.thread = String(id);
        var body = element("div", "artifact-comments-entry-body");
        body.id = "artifact-comments-entry-" + id;
        var top = element("button", "artifact-comments-entry-head");
        top.type = "button";
        top.setAttribute("aria-controls", body.id);
        var state = element("span", "artifact-comments-entry-state");
        top.append.apply(top, lead().concat([state]));
        // Resolved, the line's words open the thread to read and close it
        // again, as the head does; it stays resolved. Reopen is beside them.
        var folded = element("div", "artifact-comments-entry-resolved");
        var read = element("button", "artifact-comments-entry-read");
        read.type = "button";
        read.setAttribute("aria-controls", body.id);
        read.append.apply(read, lead());
        var reopen = element("button", "artifact-comments-reopen", "Reopen");
        reopen.type = "button";
        var done = element("span", "artifact-comments-entry-done");
        done.append(tick(), " resolved · ", reopen);
        folded.append(read, done);
        var tools = element("div", "artifact-comments-entry-tools");
        // Where the thread stands, beside Resolve: in a popover, which shows
        // no head.
        var note = element("span", "artifact-comments-entry-note");
        var resolve = element("button", "artifact-comments-resolve", "Resolve");
        resolve.type = "button";
        tools.append(note, resolve);
        body.appendChild(tools);
        var status = element("p", "artifact-comments-entry-status");
        status.setAttribute("role", "status");
        item.append(top, folded, body, status);
        var dot = element("li", "artifact-comments-dot");
        thread.entry = {
          item: item, head: top, state: state, note: note, folded: folded, read: read, body: body,
          resolve: resolve, reopen: reopen, status: status, dot: dot, key: "", marks: marks, words: words,
          leadKey: null,
        };
        // Pointing at a passage's entry lights its words.
        item.addEventListener("mouseenter", function () { passages.point(thread, "entry"); });
        item.addEventListener("mouseleave", function () { passages.point(null, "entry"); });
        top.addEventListener("click", function () {
          if (current === thread) {
            expand(null);
          } else {
            expand(thread);
            bring(thread);
          }
        });
        // Open to read only while drawn so: a thread resolved elsewhere while
        // open may still be current.
        read.addEventListener("click", function () {
          var was = current === thread && toRead === thread;
          toRead = was ? null : thread;
          if (was) {
            expand(null);
          } else {
            expand(thread);
            bring(thread);
          }
        });
        resolve.addEventListener("click", function () { settle(thread, true); });
        reopen.addEventListener("click", function () { settle(thread, false); });
        return thread.entry;
      }

      // Draw an entry as its thread now stands: open, folded to its head, or
      // resolved to one dashed line, under which it opens only when the
      // reader opens it to read.
      function draw(thread) {
        var made = entry(thread);
        var done = resolved(thread);
        // Reopened, here or elsewhere, it is no longer open to read: resolved
        // again, it folds as any thread does.
        if (!done && toRead === thread) {
          toRead = null;
        }
        var opened = done ? current === thread && toRead === thread :
          current === thread || over.holds(thread);
        // Open in a folded panel, it is not in view: folding closes it, and
        // unfolding opens it again.
        var viewed = opened && (over.holds(thread) || (api.wide && open));
        if (!moving && viewed !== thread.lit) {
          thread.lit = viewed;
          looked(thread, viewed);
        }
        made.item.classList.toggle("artifact-comments-entry--resolved", done);
        made.item.classList.toggle("artifact-comments-entry--open", opened);
        made.head.hidden = done;
        made.folded.hidden = !done;
        made.body.hidden = !opened;
        made.resolve.hidden = done;
        made.head.setAttribute("aria-expanded", opened ? "true" : "false");
        made.read.setAttribute("aria-expanded", opened ? "true" : "false");
        var decision = decisionOf(thread);
        var leadKey = (decision ? "decision " : "") + passages.key(thread);
        if (leadKey !== made.leadKey) {
          made.leadKey = leadKey;
          var quoted = Boolean(thread.root.quote);
          made.item.classList.toggle("artifact-comments-entry--passage", quoted);
          made.item.classList.toggle("artifact-comments-entry--detached", passages.detached(thread));
          made.item.classList.toggle("artifact-comments-entry--decision", Boolean(decision));
          made.marks.forEach(function (mark) {
            mark.textContent = quoted ? (thread.n ? String(thread.n) : "") : decision ? "?" : "§";
          });
          made.words.forEach(function (words) {
            if (quoted) {
              words.replaceChildren.apply(words, passages.said(thread));
            } else if (decision) {
              words.replaceChildren(element("span", "artifact-comments-entry-kind", decision.name),
                " · " + decision.question);
            } else {
              words.textContent = opening(thread.root.text || imageWords(thread.root));
            }
          });
        }
        var key = [standing(thread), routed(asked(thread)), thread.replies.length].join("\n");
        if (key === made.key) {
          return;
        }
        made.key = key;
        [made.state, made.note].forEach(function (node) {
          node.replaceChildren(said(thread), " · ",
            element("span", "artifact-comments-entry-count",
              plural(thread.replies.length, "reply", "replies")));
        });
      }

      // Where a thread stands, in words: answered, or who it waits for.
      function said(thread) {
        var kind = standing(thread);
        var handle = routed(asked(thread));
        var node = element("span", "artifact-comments-entry-said artifact-comments-entry-said--" + kind);
        if (kind === "answered") {
          node.append(tick(), " Answered");
        } else if (kind === "writing") {
          node.textContent = handle + " is writing";
        } else if (kind === "waiting") {
          node.textContent = "Waiting for " + handle;
        } else {
          node.textContent = handle + " couldn't answer";
        }
        return node;
      }

      function expand(thread) {
        var before = current;
        current = thread;
        if (before && before !== thread) {
          draw(before);
          passages.shine(before);
        }
        if (thread) {
          draw(thread);
          passages.shine(thread);
          reveal(thread.entry.item);
        }
      }

      // A thread's highlight, else its decision's chip, else its section's.
      function anchorOf(thread) {
        var decision = decisionOf(thread);
        return thread.marks[0] || (decision && decisionChips.get(decision.form)) ||
          (thread.box && thread.box.querySelector("summary")) || null;
      }

      // Open the section a node is in through its heading's button, if it is
      // folded.
      function unfold(target) {
        var wrapper = target.closest(".artifact-section-body");
        if (wrapper && wrapper.hasAttribute("hidden")) {
          var heading = wrapper.previousElementSibling;
          var button = heading && heading.querySelector("button.artifact-section-toggle");
          if (button) {
            button.click();
          }
        }
      }

      // Where the title bar ends, in the window.
      function barBottom() {
        var bar = document.querySelector(".artifact-topbar");
        return bar ? Math.max(0, bar.getBoundingClientRect().bottom) : 0;
      }

      // Bring a thread's highlight, else its chip, into the window, opening
      // its section first if it is folded.
      function bring(thread) {
        var target = anchorOf(thread);
        if (!target) {
          return;
        }
        unfold(target);
        var rect = target.getBoundingClientRect();
        if (rect.top < barBottom() || rect.bottom > window.innerHeight) {
          target.scrollIntoView({ block: "center" });
        }
      }

      // Resolve a thread, or reopen it.
      async function settle(thread, resolve) {
        var made = entry(thread);
        var control = resolve ? made.resolve : made.reopen;
        var focused = document.activeElement === control;
        control.disabled = true;
        made.status.textContent = "Saving...";
        try {
          var response = await fetch(COMMENTS, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ page: page, thread: thread.root.id, resolved: resolve }),
          });
          var payload = await json(response);
          if (response.status !== 200 || !payload || !payload.resolution) {
            made.status.textContent = failure(response, payload);
            return;
          }
          made.status.textContent = "";
          thread.resolution = payload.resolution;
          if (resolve && current === thread) {
            current = null;
          }
          if (!resolve) {
            expand(thread);
          }
          refresh();
          if (focused) {
            // A popover or the sheet shows no head: Resolve takes the focus.
            // A thread resolved in the panel while resolved ones are hidden
            // leaves the list: the control showing them takes it.
            var gone = resolve && api.wide && !resolvedShown;
            (gone ? showResolved : resolve ? made.reopen : api.wide ? made.head : made.resolve)
              .focus({ preventScroll: true });
          }
        } catch (ignored) {
          made.status.textContent = "Not saved: the site did not answer. Try again.";
        } finally {
          control.disabled = false;
        }
      }

      // Every thread in page order: each box's, oldest first, then those
      // on sections the page no longer has.
      function ordered() {
        var found = [];
        boxes.forEach(function (box) {
          found.push.apply(found, threadsOf(box));
        });
        var rest = [];
        shown.forEach(function (thread) {
          if (!thread.box) {
            rest.push(thread);
          }
        });
        return found.concat(rest.sort(function (a, b) { return a.root.id - b.root.id; }));
      }

      function face(text, agentFace) {
        var node = element("span", "artifact-comment-chip-face" +
          (agentFace ? " artifact-comment-chip-face--agent" : ""));
        node.dataset.initial = text;
        return node;
      }

      // Where some open threads stand, in one line: its kind, the faces of
      // who wrote and answered, and its words, ending in how many replies
      // to the reader are unread when any are.
      function line(threads, fresh) {
        var newest = latest(threads);
        var kind = newest ? standing(newest) : "none";
        var faces = mute(element("span", "artifact-comment-chip-faces"));
        var parts = [];
        if (newest) {
          var question = asked(newest);
          var handle = routed(question);
          faces.appendChild(face(author(question).charAt(0).toUpperCase(), false));
          if (kind === "writing") {
            faces.appendChild(face(handle.charAt(0).toUpperCase(), true));
            parts.push(mute(element("span", "artifact-comment-chip-pulse")),
              handle + " is writing…");
          } else if (kind === "waiting") {
            var messages = threads.reduce(function (n, thread) { return n + rows(thread).length; }, 0);
            parts.push(plural(messages, "comment", "comments"), " · ",
              mute(element("span", "artifact-comment-chip-hollow")), "waiting");
          } else if (kind === "failed") {
            parts.push(mute(element("span", "artifact-comment-chip-bang")),
              handle + " couldn't answer");
          } else {
            var replies = 0;
            var answer = null;
            threads.forEach(function (thread) {
              replies += thread.replies.length;
              thread.replies.forEach(function (reply) {
                if (agent(reply) && (!answer || reply.id > answer.id)) {
                  answer = reply;
                }
              });
            });
            var answerer = answer ? agent(answer) : handle;
            faces.appendChild(face(answerer.charAt(0).toUpperCase(), true));
            parts.push(plural(replies, "reply", "replies"), " · ",
              element("span", "artifact-comment-chip-done"));
            parts[parts.length - 1].append(tick(), " " + answerer + " answered");
          }
        } else {
          faces.appendChild(element("span", "artifact-comment-chip-icon"));
          parts.push("No comments", " · ", element("span", "artifact-comment-chip-act", "Comment"));
        }
        if (fresh > 0) {
          parts.push(" · ", element("span", "artifact-comment-chip-unread", fresh + " new"));
        }
        var text = element("span", "artifact-comment-chip-text");
        text.append.apply(text, parts);
        return { kind: kind, faces: faces, text: text };
      }

      // Draw a line on a chip, when it says anything new.
      function paint(node, className, drawn) {
        var key = drawn.kind + "\n" + drawn.faces.innerHTML + "\n" + drawn.text.textContent;
        if (node.lotuspodChip === key) {
          return;
        }
        node.lotuspodChip = key;
        node.className = className + " artifact-comment-chip artifact-comment-chip--" + drawn.kind;
        node.replaceChildren(drawn.faces, drawn.text);
      }

      // A box's chip: where its section's open threads stand, in one line.
      function chip(box) {
        paint(box.querySelector("summary"), "artifact-comment-summary",
          line(unresolvedOf(box), unreadIn(threadsOf(box))));
      }

      // A decision's threads, oldest first.
      function threadsOn(form) {
        var found = [];
        shown.forEach(function (thread) {
          var decision = decisionOf(thread);
          if (decision && decision.form === form) {
            found.push(thread);
          }
        });
        return found.sort(function (a, b) { return a.root.id - b.root.id; });
      }

      // A decision's chip, right after its form (a thread's composer is a
      // form, and forms do not nest), while it has threads: where its open
      // threads stand as a section's chip says it, or how many are resolved.
      function decisionChip(form) {
        var threads = threadsOn(form);
        var node = decisionChips.get(form);
        if (!threads.length) {
          return;
        }
        if (!node) {
          node = element("button");
          node.type = "button";
          node.addEventListener("click", function () { openDecision(form); });
          form.parentNode.insertBefore(node, form.nextSibling);
          decisionChips.set(form, node);
        }
        var unresolved = threads.filter(function (thread) { return !resolved(thread); });
        var fresh = unreadIn(threads);
        var drawn = line(unresolved, fresh);
        if (!unresolved.length) {
          var faces = mute(element("span", "artifact-comment-chip-faces"));
          faces.appendChild(element("span", "artifact-comment-chip-icon"));
          var text = element("span", "artifact-comment-chip-text");
          text.textContent = threads.length + " resolved";
          if (fresh > 0) {
            text.append(" · ", element("span", "artifact-comment-chip-unread", fresh + " new"));
          }
          drawn = { kind: "resolved", faces: faces, text: text };
        }
        paint(node, "artifact-decision-chip", drawn);
      }

      // A decision's chip: its newest open thread, else its newest, in the
      // panel, a popover under the chip or the sheet.
      function openDecision(form) {
        var threads = threadsOn(form);
        var thread = latest(threads.filter(function (each) { return !resolved(each); })) ||
          latest(threads);
        if (!thread) {
          return;
        }
        reach(thread, decisionChips.get(form), false);
      }

      // A thread opened from outside its entry: in a popover under opener or
      // in the sheet; in the panel as a highlight opens it, or, resolved,
      // listed with the resolved threads and its entry in view. With read, a
      // resolved thread is also opened to read, as its dashed line opens it.
      function reach(thread, opener, read) {
        if (!api.wide) {
          over.show({ thread: thread }, opener);
          if (read && resolved(thread)) {
            toRead = thread;
            expand(thread);
          }
        } else if (resolved(thread)) {
          // Listed with the resolved threads, its Reopen at hand.
          setOpen(true, true);
          setResolvedShown(true, true);
          if (read) {
            toRead = thread;
            expand(thread);
          }
          api.refresh();
          reveal(thread.entry.item);
          thread.entry.reopen.focus({ preventScroll: true });
        } else {
          api.open(thread);
        }
      }

      // A link to a thread (#thread=ID): it opens as its highlight, else its
      // chip, would open it, a resolved one opened to read. Already open in
      // view, its replies since are seen, as on opening it, and its entry is
      // brought into the panel's view.
      api.reach = function (thread) {
        if (thread.lit) {
          looked(thread, true);
          if (api.wide) {
            reveal(thread.entry.item);
          }
          return;
        }
        reach(thread, anchorOf(thread), true);
      };

      // A thread just asked about a decision: its entry opens in the panel,
      // else it opens in a popover under the decision's chip or in the sheet.
      api.asked = function (thread) {
        if (!thread) {
          return;
        }
        if (api.wide) {
          api.open(thread);
        } else {
          over.show({ thread: thread }, anchorOf(thread));
        }
      };

      // The box's form for a new thread posted one: the form folds, and in
      // the panel the new thread's entry opens; a popover shows it among its
      // section's threads, and the sheet moves on to it.
      api.posted = function (box, thread) {
        if (!thread) {
          return;
        }
        var made = groups.get(box);
        var focused = made.holder.contains(document.activeElement)
          || document.activeElement === document.body;
        compose(made, false);
        if (api.wide) {
          expand(thread);
          if (focused) {
            thread.entry.head.focus({ preventScroll: true });
          }
          return;
        }
        over.posted(thread, focused);
      };

      // A highlight: the panel opens at its thread.
      api.open = function (thread) {
        setOpen(true, true);
        expand(thread);
        thread.entry.head.focus({ preventScroll: true });
      };

      // A passage's composer: in its section's group, above the threads, with
      // the panel open.
      api.compose = function (box, holder) {
        setOpen(true, true);
        var made = groups.get(box);
        made.node.insertBefore(holder, made.entries);
        tidy();
        reveal(holder);
      };

      // A thread was posted from a passage's composer: its entry opens, or
      // it opens in a popover under its words or in the sheet.
      api.started = function (thread, focused) {
        if (!thread) {
          return;
        }
        if (api.wide) {
          expand(thread);
          if (focused) {
            thread.entry.head.focus({ preventScroll: true });
          }
          return;
        }
        over.started(thread, focused);
      };

      // A chip: the panel opens at its section's newest open thread, or at
      // its form for a new one.
      function show(box) {
        setOpen(true, true);
        var newest = latest(unresolvedOf(box));
        if (newest) {
          expand(newest);
          newest.entry.head.focus({ preventScroll: true });
        } else {
          compose(groups.get(box), true);
        }
      }

      // A chip opens its section's threads in the panel, a popover or the
      // sheet, never in its box.
      function chipped(box) {
        if (api.wide) {
          show(box);
        } else {
          over.chip(box);
        }
      }

      boxes.forEach(function (box) {
        var summaryNode = box.querySelector("summary");
        summaryNode.addEventListener("click", function (event) {
          event.preventDefault();
          chipped(box);
        });
        summaryNode.addEventListener("keydown", function (event) {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            chipped(box);
          }
        });
        summaryNode.addEventListener("keyup", function (event) {
          if (event.key === " ") {
            event.preventDefault();
          }
        });
        box.addEventListener("toggle", function () {
          if (box.open) {
            box.open = false;
          }
        });
      });

      // Show a thread where it belongs: its entry in its group, or in the
      // popover or sheet holding it, with its node in the entry; without
      // the panel, a thread on a section the page no longer has is in the
      // list at the end of the body unless it is held.
      api.put = function (thread) {
        var made = entry(thread);
        var keep = over.holds(thread);
        if (!api.wide && !thread.box && !keep) {
          var listed = changed();
          if (thread.node.parentNode !== listed) {
            listed.appendChild(thread.node);
          }
        } else if (thread.node.parentNode !== made.body) {
          made.body.appendChild(thread.node);
        }
        if (keep) {
          if (made.item.parentNode !== over.entries()) {
            over.entries().appendChild(made.item);
          }
        } else {
          var target = thread.box ? groups.get(thread.box) : strays;
          if (made.item.parentNode !== target.entries) {
            target.entries.appendChild(made.item);
            sort(target);
          }
        }
        draw(thread);
        strays.node.hidden = !showing(strays);
      };

      // Without room for the panel, one thing at a time opens over the text,
      // in a popover or the bottom sheet (overText in js/narrow.js).
      var over = overText({
        panel: api, groups: groups, passages: passages, mute: mute,
        compose: compose, threadsOf: threadsOf, unresolvedOf: unresolvedOf, resolved: resolved,
        ordered: ordered,
        latest: latest, standing: standing, routed: routed, asked: asked, said: said, tick: tick,
        title: title, opening: opening, anchorOf: anchorOf, unfold: unfold, barBottom: barBottom,
        decisionOf: decisionOf,
      });
      api.show = over.show;
      api.passage = over.passage;
      api.dropped = function (mine) {
        over.dropped(mine);
        tidy();
      };

      // Whether a thread is open: in the panel, a popover or the sheet.
      api.lit = function (thread) {
        return (api.wide && current === thread) || over.holds(thread);
      };

      // Where a thread is listed in its group: its passages by number, then
      // its resolved passages, then its decisions' threads in the decisions'
      // order, then its § threads, each oldest first.
      function rank(thread) {
        if (thread.root.quote) {
          return thread.n ? [0, thread.n, 0] : [1, thread.root.id, 0];
        }
        var decision = decisionOf(thread);
        if (decision) {
          return [2, decisions.indexOf(decision.form), thread.root.id];
        }
        return [3, 0, thread.root.id];
      }

      // Put a group's entries in order, moving only those out of place.
      function sort(made) {
        var threads = all(":scope > li", made.entries).map(function (item) {
          return shown.get(Number(item.dataset.thread));
        });
        threads.sort(function (a, b) {
          var left = rank(a);
          var right = rank(b);
          return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
        });
        threads.forEach(function (thread, index) {
          var at = made.entries.children[index];
          if (at !== thread.entry.item) {
            made.entries.insertBefore(thread.entry.item, at);
          }
        });
      }

      api.refresh = function () {
        var threads = ordered();
        var unresolved = threads.filter(function (thread) { return !resolved(thread); });
        badge.textContent = String(unresolved.length);
        badge.hidden = unresolved.length === 0;
        count.textContent = unresolved.length + " open · " +
          (threads.length - unresolved.length) + " resolved";
        labelResolved(threads.length - unresolved.length);
        threads.forEach(draw);
        groups.forEach(sort);
        sort(strays);
        tidy();
        var key = unresolved.map(function (thread) { return thread.root.id; }).join(" ");
        if (key !== dotsKey) {
          dotsKey = key;
          dots.replaceChildren.apply(dots, unresolved.map(function (thread) { return thread.entry.dot; }));
        }
        unresolved.forEach(function (thread) {
          var name = "artifact-comments-dot artifact-comments-dot--" + standing(thread);
          if (thread.entry.dot.className !== name) {
            thread.entry.dot.className = name;
          }
        });
        boxes.forEach(chip);
        decisions.forEach(decisionChip);
        over.sync();
      };

      // Whether the window leaves ROOM right of the reading column at its
      // full measure: a panel widened into the column narrows it
      // (css/base.css), which must not change where the threads live. The
      // measure is read from a probe set in the column's font, out of sight
      // and outside the column, so it is no part of the page's text.
      var probe = element("div");
      probe.setAttribute("aria-hidden", "true");
      probe.style.cssText = "position: absolute; left: 0; top: 0; height: 0; visibility: hidden; pointer-events: none";
      function roomy() {
        if (!column) {
          return false;
        }
        var rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
        var style = getComputedStyle(column);
        ["fontFamily", "fontSize", "fontStyle", "fontWeight", "fontStretch"].forEach(function (name) {
          probe.style[name] = style[name];
        });
        probe.style.width = style.getPropertyValue("--measure-prose") || "66ch";
        document.body.appendChild(probe);
        var measure = probe.getBoundingClientRect().width;
        probe.remove();
        var left = column.getBoundingClientRect().left;
        var holder = column.parentElement;
        var edge = holder.getBoundingClientRect().right -
          (parseFloat(getComputedStyle(holder).paddingRight) || 0) -
          (parseFloat(getComputedStyle(holder).borderRightWidth) || 0);
        var right = left + Math.min(measure, edge - left);
        return document.documentElement.clientWidth - right >= ROOM * rem;
      }

      // What the open panel shows, to open again in a popover or the sheet
      // (over.restore) when the window narrows: a section's form being
      // written in, else the open entry's thread. A passage's composer is
      // placed by its own (passages.place).
      function opened() {
        var none = { view: null, opener: null, anchor: null, writing: null };
        if (!open) {
          return none;
        }
        var writing = null;
        groups.forEach(function (made) {
          if (made.holder && !made.holder.hidden) {
            writing = made;
          }
        });
        if (writing) {
          var chipNode = writing.box.querySelector("summary");
          return { view: { box: writing.box }, opener: chipNode, anchor: chipNode, writing: writing };
        }
        if (current && (!resolved(current) || current === toRead)) {
          var anchor = anchorOf(current);
          return { view: { thread: current }, opener: anchor, anchor: anchor, writing: null };
        }
        return none;
      }

      // Show the threads in the panel, or else open them in a popover or the
      // sheet, as the window allows. What is open moves to the new place.
      api.arrange = function () {
        var mode = roomy() ? "panel" : window.matchMedia(POPOVER).matches ? "popover" : "sheet";
        if (arranged && mode === api.mode) {
          over.refit();
          return;
        }
        if (!arranged) {
          boxes.forEach(function (box) {
            box.open = false;
            groups.get(box).holder.appendChild(forms.get(box));
          });
        }
        arranged = true;
        moving = true;
        // Moving a field takes its focus away: it is given back after.
        var focused = document.activeElement;
        var taken = api.wide ? opened() : over.take();
        var view = taken.view;
        var writing = taken.writing;
        api.mode = mode;
        api.wide = mode === "panel";
        aside.hidden = !api.wide;
        over.mode(mode);
        var old = document.querySelector(".artifact-comments-changed");
        if (old) {
          old.hidden = api.wide;
        }
        shown.forEach(put);
        refresh();
        if (!api.wide) {
          over.restore(taken);
        } else if (view && view.thread) {
          setOpen(true, false);
          expand(view.thread);
        } else if (writing) {
          setOpen(true, false);
        }
        if (writing) {
          compose(writing, true);
        }
        // In its new place, a thread opens or closes as it now stands.
        moving = false;
        refresh();
        // A passage's composer goes where the window now has room for it.
        passages.place();
        if (focused && focused !== document.body && focused.isConnected && document.activeElement !== focused) {
          focused.focus({ preventScroll: true });
        }
      };

      // What is open, to open again after a reload (api.reopen): a thread by
      // its first comment's id, or a section and whether its form is being
      // written in; null for nothing, or a passage's composer.
      api.held = function () {
        var taken = api.wide ? opened() : over.peek();
        var view = taken.view;
        if (view && view.thread) {
          return { thread: view.thread.root.id };
        }
        if (view && view.box) {
          return { section: view.box.dataset.section, writing: Boolean(taken.writing) };
        }
        return null;
      };

      // Open again what api.held kept, where the window now has room for it.
      api.reopen = function (kept) {
        var thread = shown.get(kept.thread);
        var box = typeof kept.section === "string" ? sections.get(kept.section) : null;
        var view = thread && !resolved(thread) ? { thread: thread } : box ? { box: box } : null;
        if (!view) {
          return;
        }
        var writing = view.box && kept.writing ? groups.get(view.box) : null;
        if (api.wide) {
          setOpen(true, false);
          if (view.thread) {
            expand(view.thread);
          }
        } else {
          var anchor = view.thread ? anchorOf(view.thread) : view.box.querySelector("summary");
          over.restore({ view: view, opener: anchor, anchor: anchor, writing: writing });
        }
        if (writing) {
          compose(writing, true);
        }
      };

      return api;
    }

    // The list at the end of the body for threads on sections the page no
    // longer has.
    function changed() {
      var list = document.querySelector(".artifact-comments-changed");
      if (!list) {
        list = element("section", "artifact-comments-changed");
        list.appendChild(element("h2", "", CHANGED));
        (document.querySelector(".artifact-body") || document.body).appendChild(list);
      }
      return list;
    }

    // Show a thread as read: a new one lands in its section's box, a known
    // one takes what it does not show yet. True when anything was drawn.
    function add(entry) {
      var root = entry.root;
      if (!root) {
        return false;
      }
      var known = shown.get(root.id);
      if (known) {
        var moved = Boolean(entry.resolution) && resolved(known) !== Boolean(entry.resolution.resolved);
        if (entry.resolution) {
          known.resolution = entry.resolution;
        }
        return merge(known, [root].concat(entry.replies || [])) || moved;
      }
      var list = element("ol", "artifact-comment-list");
      list.setAttribute("aria-live", "polite");
      var thread = {
        root: root, replies: [], list: list, drawn: new Map(), typing: null, waitKey: null,
        resolution: entry.resolution || null, entry: null,
        // Whether it is open, and the line above its first unread comment.
        lit: false, divider: null,
        // A passage thread's words: undefined until looked for, null when
        // not found; its highlights, its number node and its number.
        spot: undefined, marks: [], number: null, n: 0, head: null, headKey: null,
      };
      var node = element("div", "artifact-comment-thread");
      node.dataset.thread = String(root.id);
      thread.node = node;
      var box = sections.get(root.section) || null;
      thread.box = box;
      if (!box) {
        node.appendChild(element("p", "artifact-comment-section",
          "On " + String(root.sectionTitle || root.section || "an earlier section")));
      }
      if (root.quote) {
        // Headed by its quote in a box; the panel's entry says it instead.
        thread.head = element("p", "artifact-passage-head");
        node.appendChild(thread.head);
      }
      node.appendChild(list);
      replyForm(thread, node);
      shown.set(root.id, thread);
      watch(node);
      merge(thread, entry.replies || []);
      put(thread);
      return true;
    }

    function resolved(thread) {
      return Boolean(thread.resolution && thread.resolution.resolved);
    }

    // Show a thread in its entry, where the window has room for it.
    function put(thread) {
      panel.put(thread);
    }

    // Draw what the threads say outside them: the passages' highlights, the
    // panel, the chips, what a popover or the sheet holds and the replies
    // to the reader.
    function refresh() {
      passages.update();
      panel.refresh();
      showUnread();
    }

    // The checks for replies: while a thread waits, or the reader has a
    // thread in view (an agent may add to one it answered), and the page is
    // seen, read the threads again FIRST after the last read, each gap half
    // again as long as the one before up to LAST, and the first gap again
    // after any change or a comment the reader posts.
    var FIRST = 3000;
    var LAST = 30000;
    var gap = FIRST;
    var last = 0;
    var timer = null;
    var reading = false;
    // The read in flight is followed by the first gap.
    var fresh = false;
    // False once a read finds the reader signed out.
    var checking = true;
    // The thread nodes in view, in a box, the panel, a popover or the sheet.
    var viewed = new Set();
    var viewing = typeof IntersectionObserver === "function"
      ? new IntersectionObserver(function (changes) {
        changes.forEach(function (change) {
          if (change.isIntersecting) {
            viewed.add(change.target);
          } else {
            viewed.delete(change.target);
          }
        });
        plan();
      })
      : null;

    function watch(node) {
      if (viewing) {
        viewing.observe(node);
      }
    }

    // Whether anything calls for another read.
    function wanted() {
      return viewed.size > 0 || Boolean(waiting());
    }

    function waiting() {
      var found = null;
      shown.forEach(function (thread) {
        if (!found && waits(thread)) {
          found = thread;
        }
      });
      return found;
    }

    function hidden() {
      return document.visibilityState === "hidden";
    }

    function plan() {
      clearTimeout(timer);
      timer = null;
      if (reading || !checking || hidden() || !wanted()) {
        return;
      }
      timer = setTimeout(read, Math.max(0, last + gap - Date.now()));
    }

    function signedOut() {
      checking = false;
      clearTimeout(timer);
      timer = null;
      var first = waiting();
      if (first) {
        // A box's form may be folded away: the thread says it.
        var status = first.node.querySelector(":scope > .artifact-comment-status");
        if (!status) {
          status = element("p", "artifact-comment-status");
          status.setAttribute("role", "status");
          first.node.appendChild(status);
        }
        status.textContent = SIGNED_OUT;
      }
      shown.forEach(sync);
      refresh();
    }

    async function read() {
      timer = null;
      reading = true;
      last = Date.now();
      var touched = false;
      try {
        var response = await fetch(COMMENTS + "?page=" + encodeURIComponent(page));
        if (response.status === 401) {
          reading = false;
          settleImageCap(null, SIGNED_OUT);
          signedOut();
          restore();
          return;
        }
        var payload = response.status === 200 ? await json(response) : null;
        if (payload && typeof payload.maxImageBytes === "number") {
          settleImageCap(payload.maxImageBytes);
        } else {
          settleImageCap(null, NO_CAP);
        }
        if (payload) {
          tracked = Array.isArray(payload.unread);
          unread = new Set(tracked ? payload.unread : []);
          (payload.threads || []).forEach(function (entry) {
            if (add(entry)) {
              touched = true;
            }
          });
          live.seen(payload && payload.revision);
        }
      } catch (ignored) {
        // A failed read keeps the schedule.
        settleImageCap(null, NO_CAP);
      }
      reading = false;
      refresh();
      restore();
      if (!linked || relink) {
        // A link followed before the first read is no reload's fragment.
        openLinked(!relink);
        linked = true;
        relink = false;
      }
      gap = touched || fresh ? FIRST : Math.min(gap * 1.5, LAST);
      fresh = false;
      plan();
    }

    // Each composer of a section's form or a thread's reply, with what it
    // is kept by over a reload: its thread, its section and where the
    // section's box is among the page's.
    function composers() {
      var found = [];
      forms.forEach(function (form, box) {
        found.push({
          section: box.dataset.section, index: boxes.indexOf(box), field: form.elements.text,
          images: attached.get(form),
        });
      });
      shown.forEach(function (thread) {
        found.push({
          thread: thread.root.id, section: thread.root.section, index: boxes.indexOf(thread.box),
          field: thread.field, images: attached.get(thread.field.form),
        });
      });
      return found;
    }

    // Whether a composer holds text or images not sent.
    function holding(each) {
      return each.field.value.trim() !== "" || each.images.held();
    }

    // Kept over a reload of the page (js/live-page.js): what is open, and
    // the text and uploaded images not sent in each composer. An image
    // still uploading is unsent too, so a hidden page waits for the reader.
    live.keep({
      unsent: function () {
        var passage = passages.writing();
        return Boolean(passage && (passage.text.trim() || passage.held)) || composers().some(holding);
      },
      save: function () {
        return {
          open: panel.held(),
          passage: passages.writing(),
          texts: composers().filter(holding).map(function (each) {
            return {
              thread: each.thread, section: each.section, index: each.index, text: each.field.value,
              images: each.images.kept(),
            };
          }),
        };
      },
    });

    // What was kept before the page reloaded, given back once the threads
    // are first read: the text and images in each composer, then what was
    // open, then
    // the scroll position the reader had (live.place: opening a thread over
    // the text may scroll the page to it). Text whose place the new
    // revision no longer has (a section renamed or gone, a passage's words
    // changed, a thread not read) is never lost: it goes to the form for a
    // new thread on its section, else on the box where its section was,
    // else on the page's first, which opens with the reason beside it.
    // Images go with their text, up to MAX_IMAGES a composer.
    var kept = live.kept();
    function restore() {
      var was = kept;
      kept = null;
      if (!was) {
        return;
      }
      var moved = null;
      // Add each's text and images to form; why some images were not.
      function join(form, each) {
        var field = form.elements.text;
        var text = String(each.text || "");
        if (text.trim()) {
          field.value = field.value.trim() ? field.value + "\n\n" + text : text;
        }
        return attached.get(form).restore(each.images);
      }
      function told(form, why) {
        if (why) {
          form.querySelector(".artifact-comment-status").textContent = why;
        }
      }
      function rehome(each, why) {
        var box = (typeof each.section === "string" && sections.get(each.section)) ||
          boxes[Number(each.index)] || boxes[0];
        var form = forms.get(box);
        var over = join(form, each);
        told(form, over ? why + " " + over : why);
        moved = box;
      }
      function worth(each) {
        return String(each.text || "").trim() !== "" || (Array.isArray(each.images) && each.images.length > 0);
      }
      (Array.isArray(was.texts) ? was.texts : []).forEach(function (each) {
        if (!each || typeof each !== "object" || !worth(each)) {
          return;
        }
        var thread = each.thread ? shown.get(each.thread) : null;
        var box = !each.thread && typeof each.section === "string" ? sections.get(each.section) : null;
        if (thread) {
          thread.field.value = String(each.text || "");
          told(thread.field.form, attached.get(thread.field.form).restore(each.images));
          thread.unfold(true);
        } else if (box) {
          told(forms.get(box), join(forms.get(box), each));
        } else {
          rehome(each, PLACE_GONE);
        }
      });
      if (was.open && typeof was.open === "object") {
        panel.reopen(was.open);
      }
      var passage = was.passage && typeof was.passage === "object" ? was.passage : null;
      if (passage && !passages.reopen(passage) && worth(passage)) {
        rehome(passage, PASSAGE_GONE);
      }
      if (moved) {
        panel.reopen({ section: moved.dataset.section, writing: true });
      }
      live.place();
    }

    // The reader posted a comment: check again from the first gap.
    function posted() {
      if (!checking) {
        checking = true;
        shown.forEach(sync);
      }
      gap = FIRST;
      last = Date.now();
      fresh = reading;
      refresh();
      plan();
    }

    // #thread=ID, a link from the index's Recent activity, opens the thread
    // whose first comment is ID (panel.reach) once the first read has drawn
    // the threads, and again on each hashchange after the threads are read
    // again, so a reply since is among what it marks seen; one before the
    // first read waits for it. An ID no thread here has, or not a number,
    // opens nothing.
    var linked = false;
    var relink = false;
    function openLinked(first) {
      var id = linkedTo("thread", first);
      var thread = id !== null && /^[1-9][0-9]*$/.test(id) ? shown.get(Number(id)) : null;
      if (thread) {
        panel.reach(thread);
      }
    }
    window.addEventListener("hashchange", function () {
      if (linkedTo("thread") === null) {
        return;
      }
      relink = true;
      if (linked && !reading) {
        clearTimeout(timer);
        fresh = true;
        read();
      }
    });

    document.addEventListener("visibilitychange", function () {
      if (hidden()) {
        clearTimeout(timer);
        timer = null;
      } else if (!timer && !reading && checking && wanted()) {
        fresh = true;
        read();
      }
    });

    boxes.forEach(function (box) {
      var form = forms.get(box);
      attached.set(form, attachments(form, form.elements.text));
      form.addEventListener("submit", async function (event) {
        event.preventDefault();
        var row = await post(form, {
          page: page, section: box.dataset.section, text: form.elements.text.value,
        });
        if (row) {
          add({ root: row, replies: [] });
          posted();
          panel.posted(box, shown.get(row.id));
        }
      });
    });

    // Why a question about a decision was not sent.
    function unasked(response, payload) {
      if (response.status === 401) {
        return SIGNED_OUT;
      }
      if (response.status === 409 && payload && payload.error === "stale_page") {
        return STALE_QUESTION;
      }
      var error = payload && payload.error ? String(payload.error) : "status " + response.status;
      return "Your question was not sent (" + error + "). Try again.";
    }

    // Each decision's Ask, beside "Save answer": the note's text posted as
    // a question thread on the decision, which saves no answer. Sent, the
    // note is emptied and folded, so it is never saved as the answer's note,
    // and the thread opens where the window has room for it.
    function askAbout(form) {
      var save = form.querySelector('button[type="submit"]');
      var note = form.elements.note;
      if (!save || !note) {
        return;
      }
      var button = element("button", "artifact-decision-ask", "Ask");
      button.type = "button";
      save.parentNode.insertBefore(button, save.nextSibling);
      var status = form.querySelector(".artifact-decision-status");
      function say(text) {
        if (status) {
          status.textContent = text;
        }
      }
      button.addEventListener("click", async function () {
        var sent = note.value;
        var text = sent.trim();
        if (!text) {
          say(NO_QUESTION);
          return;
        }
        var body = { page: page, question: form.dataset.question, text: text };
        if (revision !== null) {
          body.revision = revision;
        }
        button.disabled = true;
        say("Sending your question...");
        try {
          var response = await fetch(COMMENTS, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          var payload = await json(response);
          if (response.status !== 201 || !payload) {
            say(unasked(response, payload));
            return;
          }
          say("");
          // A note changed while the question was sending holds a question
          // not yet sent: it stays, open, and the card keeps it unsaved.
          if (note.value === sent) {
            note.value = "";
            var fold = note.closest("details");
            if (fold) {
              fold.open = false;
            }
            // The card marks itself as its note now reads.
            note.dispatchEvent(new Event("input", { bubbles: true }));
          }
          add({ root: payload, replies: [] });
          posted();
          panel.asked(shown.get(payload.id));
        } catch (ignored) {
          say("Your question was not sent: the site did not answer. Try again.");
        } finally {
          button.disabled = false;
        }
      });
    }

    var passages = selectPassages();
    var panel = sidePanel();
    decisions.forEach(askAbout);
    panel.arrange();
    window.addEventListener("resize", panel.arrange);
    read();
  }

  var boxes = all("details.artifact-comment");
  if (boxes.length) {
    commentBoxes(boxes);
  }
