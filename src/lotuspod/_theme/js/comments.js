
  // The comment boxes (lotuspod.comments): one per section, or one for the
  // page. Threads come from the comments route; each is shown in the box of
  // its section, or, when the page no longer has that section, in a list at
  // the end of the body. With the page script each box is a chip instead,
  // and its threads open in the side panel, a popover or a bottom sheet
  // (the placement island), never in the box. A thread on a passage
  // (the passages part) is also drawn on its words.
  function commentBoxes(boxes, parts) {
    var page = boxes[0].dataset.page;
    var tag = document.querySelector('meta[name="lotuspod:owner"]');
    var owner = tag ? tag.content : "";
    // The revision the page shows now, which a swap moves on
    // (js/live-page.js); null on a page with none. While a swap's SWAPPED
    // is handled, live.revision() is still the one before it.
    var swappedTo = "";
    function revision() {
      return swappedTo || live.revision() || null;
    }
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

    // A box joins the page's: by its section, and its form for a new thread.
    function enlist(box) {
      sections.set(box.dataset.section, box);
      forms.set(box, box.querySelector("form.artifact-comment-form"));
    }
    boxes.forEach(enlist);
    function ask() {
      questions.clear();
      decisions.forEach(function (form) {
        questions.set(form.dataset.question, form);
      });
    }
    ask();

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

    var threadRows = parts.thread({
      owner: owner, page: page, checking: function () { return checking; },
      counted: counted, opening: opening, label: function (thread, row) { composer.label(thread, row); },
    });
    var agent = threadRows.agent;
    var author = threadRows.author;
    var routed = threadRows.routed;
    var rows = threadRows.rows;
    var sync = threadRows.sync;
    var merge = threadRows.merge;
    var markUnread = threadRows.markUnread;

    var composer = parts.composer({
      page: page, revision: revision, attached: attached, forms: forms,
      sending: new Map(), boxWith: boxWith, rows: rows, agent: agent, routed: routed,
      readTo: readTo, merge: merge, posted: posted, add: add, shown: shown,
      placement: function () { return panel; },
    });

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
    // of which draw it (the thread-list part's draw). Opened, it posts its newest
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
        root: root, replies: [], list: list,
        resolution: entry.resolution || null, entry: null,
        // Whether it is open.
        lit: false,
        // A passage thread's words: undefined until looked for, null when
        // not found; its highlights, its number node and its number.
        spot: undefined, marks: [], number: null, n: 0, head: null, headKey: null,
      };
      var node = element("div", "artifact-comment-thread");
      node.dataset.thread = String(root.id);
      thread.node = node;
      var box = boxFor(root);
      thread.box = box;
      if (!box) {
        node.appendChild(whereFrom(root));
      }
      if (root.quote) {
        // Headed by its quote in a box; the panel's entry says it instead.
        thread.head = element("p", "artifact-passage-head");
        node.appendChild(thread.head);
      }
      node.appendChild(list);
      Object.assign(thread, composer.reply(thread, node));
      shown.set(root.id, thread);
      watch(node);
      merge(thread, entry.replies || []);
      put(thread);
      return true;
    }

    // The box a thread's first comment is on, or null when the page no
    // longer has its section. A thread on the whole page of a page that has
    // kept only its "page" box (republished with fewer sections) is that
    // box's, and a thread on that "page" box is the whole page's once the
    // page has sections.
    function boxFor(root) {
      return sections.get(root.section) ||
        (root.section === WHOLE_PAGE && sections.get("page")) ||
        (root.section === "page" && sections.get(WHOLE_PAGE)) || null;
    }

    // The line a thread on a section the page no longer has starts with.
    function whereFrom(root) {
      return element("p", "artifact-comment-section",
        "On " + String(root.sectionTitle || root.section || "an earlier section"));
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
    // A note's thread not read yet (noted below), and how many notes were
    // saved: only a read begun after the newest finds its thread.
    var owed = false;
    var notes = 0;
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

    // Whether anything calls for another read: a note saved with an
    // answer calls for one until a read finds its thread.
    function wanted() {
      return viewed.size > 0 || owed || Boolean(waiting());
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
      var asOf = notes;
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
          owed = owed && asOf !== notes;
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
      if (again) {
        again = false;
        // A hidden page reads it once it is seen again.
        if (hidden()) {
          ticked = true;
        } else {
          fresh = true;
          read();
          return;
        }
      }
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
        return Boolean(passage && (passage.text.trim() || passage.held)) || composers().some(holding) ||
          awaiting.size > 0;
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
          }).concat(Array.from(awaiting, function (each) {
            return {
              section: each.section, index: each.index, text: String(each.text || ""),
              images: each.from ? each.from.kept() : each.images, quote: each.quote, why: each.why,
            };
          })),
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

    // Add each's text and images to form; why some images were not. Those
    // of a composer still on the page (each.from: its attachments, as a
    // swap takes it away) come as they are now, any still uploading too.
    function join(form, each) {
      var field = form.elements.text;
      var text = String(each.text || "");
      if (text.trim()) {
        field.value = field.value.trim() ? field.value + "\n\n" + text : text;
      }
      var images = attached.get(form);
      return each.from ? each.from.pass(images) : images.restore(each.images);
    }

    function told(form, why) {
      if (why) {
        form.querySelector(".artifact-comment-status").textContent = why;
      }
    }

    // What rehome() keeps for a form until the post it is sending is saved:
    // held only here meanwhile, so kept over a reload too (why: what its
    // form is to say). Each leaves once it joins a form.
    var awaiting = new Set();

    // Text whose place is gone goes to the form for a new thread on its
    // section, else on the box at its index, else on the page's first,
    // saying why; that box. A form sending a post empties once it is saved,
    // so what goes to one joins it after, opened for the reader (or goes on
    // to another form, should a swap take this one away meanwhile).
    function rehome(each, why) {
      var box = (typeof each.section === "string" && sections.get(each.section)) ||
        boxes[Number(each.index)] || boxes[0];
      var form = forms.get(box);
      var saving = sending.get(form);
      if (saving) {
        each.why = why;
        awaiting.add(each);
        saving.then(function () {
          awaiting.delete(each);
          var now = boxWith(form);
          if (!now) {
            now = rehome(each, why);
          } else {
            // A post not saved says why first.
            var said = form.querySelector(".artifact-comment-status").textContent;
            land(form, each, said ? said + " " + why : why);
          }
          panel.reopen({ section: now.dataset.section, writing: true });
        });
        return box;
      }
      land(form, each, why);
      return box;
    }

    // Join each to form, saying why.
    function land(form, each, why) {
      var over = join(form, each);
      told(form, over ? why + " " + over : why);
    }

    function worth(each) {
      return String(each.text || "").trim() !== "" || (Array.isArray(each.images) && each.images.length > 0) ||
        Boolean(each.from && each.from.held());
    }

    function restore() {
      var was = kept;
      kept = null;
      if (!was) {
        return;
      }
      var moved = null;
      (Array.isArray(was.texts) ? was.texts : []).forEach(function (each) {
        if (!each || typeof each !== "object" || !worth(each)) {
          return;
        }
        var thread = each.thread ? shown.get(each.thread) : null;
        var box = !each.thread && typeof each.section === "string" ? sections.get(each.section) : null;
        if (each.why) {
          // Waiting for a post when the page reloaded: a passage's composer
          // opens again on its words where the page has them; else it goes
          // where it was to go, still to say why.
          if (!(each.quote && passages.reopen(each))) {
            moved = rehome(each, String(each.why));
          }
        } else if (thread) {
          thread.field.value = String(each.text || "");
          told(thread.field.form, attached.get(thread.field.form).restore(each.images));
          // On an archived page the text is kept, folded away, for a reload
          // once it takes replies again.
          if (!ARCHIVED) {
            thread.unfold(true);
          }
        } else if (box) {
          told(forms.get(box), join(forms.get(box), each));
        } else {
          moved = rehome(each, PLACE_GONE);
        }
      });
      if (was.open && typeof was.open === "object") {
        panel.reopen(was.open);
      }
      var passage = was.passage && typeof was.passage === "object" ? was.passage : null;
      if (passage && !passages.reopen(passage) && worth(passage)) {
        moved = rehome(passage, PASSAGE_GONE);
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
      } else if (ticked && checking) {
        ticked = false;
        readNow();
      } else if (!timer && !reading && checking && wanted()) {
        fresh = true;
        read();
      }
    });

    // Read the threads at once, or once more after the read in flight, which
    // may have missed what called for this one.
    function readNow() {
      if (reading) {
        again = true;
        return;
      }
      clearTimeout(timer);
      fresh = true;
      read();
    }

    // A tick from serve's stream (js/live-events.js) that this page's
    // threads or answers changed, or that the stream missed some, reads the
    // threads at once; one while the page is hidden is read once it is seen
    // again. Signed out, nothing is read.
    var ticked = false;
    document.addEventListener("lotuspod:change", function (event) {
      var tick = event.detail;
      if (!checking || !(tick.what === "resync" ||
          ((tick.what === "comment" || tick.what === "answer") && tick.page === page))) {
        return;
      }
      if (hidden()) {
        ticked = true;
        return;
      }
      readNow();
    });

    // The box whose form for a new thread form is: a swap gives a section's
    // new box the form of the box it replaced.
    function boxWith(form) {
      var found = null;
      forms.forEach(function (each, box) {
        if (each === form) {
          found = box;
        }
      });
      return found;
    }

    // The post each form for a new thread is sending: its row, or null.
    var sending = composer.sending;
    function wire(box) { return composer.wire(box); }
    boxes.forEach(wire);

    // A swap (web/src/page-swap.ts) brought in a newer revision's parts:
    // each box in a part it replaced, took away or added is mounted in place
    // of the one it replaces, taken out, or added, and the threads, chips
    // and panel are drawn from the boxes as they now are. A thread open in
    // the panel stays open, and one in a popover or the sheet opens again;
    // a section's form, with what is written in it, stays its section's.
    // Threads on a section taken away are listed with those on sections
    // the page no longer has, and a section added takes back its own. Each
    // decision form taken out or put in leaves or joins the decisions, in
    // page order, a new one with its Ask, and a thread on a question the
    // page no longer asks is drawn as on a reload. The passages of the
    // parts swapped are found again in the new text, and numbered in page
    // order. A passage composer whose words went with a part (one held
    // back, applied by its Update) opens again on them where the new text
    // has them; else, like the text in the form of a section taken away,
    // what was written goes to a section's form saying why, as after a
    // reload.
    document.addEventListener(SWAPPED, function (event) {
      var units = event.detail.units;
      swappedTo = event.detail.revision;
      var focused = document.activeElement;
      var writing = passages.swept();
      if (writing && takenAt.has(writing.box)) {
        writing.index = takenAt.get(writing.box);
      }
      passages.moved();
      var unsent = [];
      var olds = [];
      var news = [];
      var gone = [];
      var fresh = [];
      units.forEach(function (unit) {
        if (unit.kind === "header") {
          // The swap gave the tab the new revision's title.
          tabTitle = document.title;
        }
        olds.push.apply(olds, boxesIn(unit.before).filter(function (box) { return boxes.indexOf(box) >= 0; }));
        news.push.apply(news, boxesIn(unit.after));
        gone.push.apply(gone, decisionsIn(unit.before).filter(function (form) {
          return decisions.indexOf(form) >= 0;
        }));
        fresh.push.apply(fresh, decisionsIn(unit.after));
      });
      gone.forEach(function (form) {
        decisions.splice(decisions.indexOf(form), 1);
        panel.forget(form);
      });
      decisions.push.apply(decisions, fresh);
      decisions.sort(function (a, b) {
        return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      });
      ask();
      fresh.forEach(askAbout);
      if (olds.length || news.length) {
        remount(olds, news, unsent);
      } else {
        refresh();
      }
      var moved = null;
      unsent.forEach(function (each) {
        if (!each.saving) {
          moved = rehome(each, PLACE_GONE);
          return;
        }
        // Sent already: kept only if it is not saved.
        var held = pend(each, PLACE_GONE);
        each.saving.then(function (row) {
          awaiting.delete(held);
          var box = row ? null : rehome(each, PLACE_GONE);
          if (box) {
            panel.reopen({ section: box.dataset.section, writing: true });
          }
        });
      });
      if (writing && writing.saving) {
        // Sent already: kept only if it is not saved.
        var held = pend(writing, PASSAGE_GONE);
        writing.saving.then(function (row) {
          awaiting.delete(held);
          var box = row ? null : rewrite(writing);
          if (box) {
            panel.reopen({ section: box.dataset.section, writing: true });
          }
        });
      } else if (writing) {
        moved = rewrite(writing) || moved;
      }
      if (moved) {
        panel.reopen({ section: moved.dataset.section, writing: true });
      }
      if (focused && focused !== document.body && focused.isConnected && document.activeElement !== focused) {
        focused.focus({ preventScroll: true });
      }
    });

    // What a form or composer a swap took away holds while the post it is
    // sending is not yet saved, kept over a reload meanwhile (awaiting) to
    // go where rehome() would put it, saying why; that snapshot, for the
    // caller to let go of once the post settles.
    function pend(each, why) {
      var held = {
        section: each.section, index: each.index, text: each.text, from: each.from, images: each.images,
        quote: each.quote, why: why,
      };
      awaiting.add(held);
      return held;
    }

    // A passage composer a swap took the words of opens again on them
    // where the page still has them and no other composer is open; else
    // what was written goes to a section's form, saying why: that box,
    // else null.
    function rewrite(writing) {
      if (passages.reopen(writing) || !worth(writing)) {
        return null;
      }
      return rehome(writing, PASSAGE_GONE);
    }

    // Mount the boxes a swap brought in (news) in place of those it took
    // out (olds): what was written in the form of each taken away for good
    // is added to unsent.
    function remount(olds, news, unsent) {
      news.sort(function (a, b) {
        return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      });
      var replaced = [];
      var added = [];
      news.forEach(function (box) {
        var old = olds.filter(function (each) { return each.dataset.section === box.dataset.section; })[0];
        if (old) {
          olds.splice(olds.indexOf(old), 1);
          replaced.push([old, box]);
        } else {
          added.push(box);
        }
      });
      var taken = panel.take(olds.concat(replaced.map(function (pair) { return pair[0]; })));
      replaced.forEach(function (pair) { replaceBox(pair[0], pair[1]); });
      olds.forEach(function (old) {
        var each = dropBox(old);
        if (each) {
          unsent.push(each);
        }
      });
      added.forEach(addBox);
      panel.remounted();
      var order = boxes.map(function (box) { return [box, forms.get(box)]; });
      forms.clear();
      order.forEach(function (pair) { forms.set(pair[0], pair[1]); });
      shown.forEach(put);
      refresh();
      panel.give(taken);
      refresh();
    }

    // The comment boxes among some nodes and in them.
    function boxesIn(nodes) {
      var found = [];
      nodes.forEach(function (node) {
        if (node instanceof Element) {
          if (node.matches("details.artifact-comment")) {
            found.push(node);
          }
          found.push.apply(found, all("details.artifact-comment", node));
        }
      });
      return found;
    }

    // The decision forms among some nodes and in them.
    function decisionsIn(nodes) {
      var found = [];
      nodes.forEach(function (node) {
        if (node instanceof Element) {
          if (node.matches("form.artifact-decision[data-question]")) {
            found.push(node);
          }
          found.push.apply(found, all("form.artifact-decision[data-question]", node));
        }
      });
      return found;
    }

    // A section's new box takes the place of old: its threads, and its
    // form, which stays the section's wherever it is shown, the new box's
    // own taken out.
    function replaceBox(old, box) {
      boxes[boxes.indexOf(old)] = box;
      if (sections.get(old.dataset.section) === old) {
        sections.set(box.dataset.section, box);
      }
      var form = forms.get(old);
      var own = box.querySelector("form.artifact-comment-form");
      if (own && own !== form) {
        if (old.contains(form)) {
          own.replaceWith(form);
        } else {
          own.remove();
        }
      }
      forms.delete(old);
      forms.set(box, form);
      takenAt.delete(old);
      shown.forEach(function (thread) {
        if (thread.box === old) {
          thread.box = box;
        }
      });
      panel.replace(old, box);
    }

    // The index each section a swap took away had as it was taken away,
    // while it is held back: where a reload would put what its form holds.
    var takenAt = new Map();

    // A section taken away takes its box and form with it; its threads say
    // which section they were on. What its form holds not sent, to go where
    // the section was, as on a reload; else null.
    function dropBox(old) {
      var at = boxes.indexOf(old);
      var place = takenAt.has(old) ? takenAt.get(old) : at;
      takenAt.delete(old);
      var form = forms.get(old);
      var each = { field: form.elements.text, images: attached.get(form) };
      var unsent = holding(each) ? {
        section: old.dataset.section, index: place, text: each.field.value,
        images: each.images.kept(), from: each.images, saving: sending.get(form) || null,
      } : null;
      boxes.splice(at, 1);
      if (sections.get(old.dataset.section) === old) {
        sections.delete(old.dataset.section);
      }
      attached.delete(form);
      forms.delete(old);
      shown.forEach(function (thread) {
        if (thread.box === old) {
          thread.box = null;
          thread.node.insertBefore(whereFrom(thread.root), thread.node.firstChild);
        }
      });
      panel.unmount(old, at);
      return unsent;
    }

    // A section added: its box joins the boxes in page order, and takes
    // the threads on its section.
    function addBox(box) {
      var at = boxes.findIndex(function (other) {
        return Boolean(box.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING);
      });
      at = at < 0 ? boxes.length : at;
      boxes.splice(at, 0, box);
      enlist(box);
      wire(box);
      panel.mount(box, at);
      shown.forEach(function (thread) {
        if (!thread.box && boxFor(thread.root) === box) {
          thread.box = box;
          var line = thread.node.querySelector(":scope > .artifact-comment-section");
          if (line) {
            line.remove();
          }
        }
      });
    }

    // A swap holds back a part holding the open passage composer's words,
    // and a section it would take away whose form holds text or images not
    // sent, until the reader's Update: then the SWAPPED handler above keeps
    // what was written.
    holdSwap(function (nodes, removed) {
      // Its index from when a swap first takes it away; a section that is
      // only changed is not taken away.
      boxes.forEach(function (box, at) {
        if (!nodes.some(function (node) { return node.contains(box); })) {
          return;
        }
        if (!removed) {
          takenAt.delete(box);
        } else if (!takenAt.has(box)) {
          takenAt.set(box, at);
        }
      });
      if (passages.writes(nodes)) {
        return true;
      }
      return removed && boxes.some(function (box) {
        var form = forms.get(box);
        return nodes.some(function (node) { return node.contains(box); }) &&
          holding({ field: form.elements.text, images: attached.get(form) });
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

    // An answer saved with a note opens a thread on its decision, or adds
    // to one: the threads are read again at once, so its chip shows it. A
    // read already in flight may have missed it, and is followed by another;
    // one that fails is tried again after the schedule's first gap.
    var again = false;
    function noted(event) {
      if (!event.detail.comment) {
        return;
      }
      owed = true;
      notes += 1;
      readNow();
    }

    // Each decision's Ask, beside "Save answer": the note's text posted as
    // a question thread on the decision, which saves no answer. Sent, the
    // note is emptied and folded, so it is never saved as the answer's note,
    // and the thread opens where the window has room for it.
    function askAbout(form) {
      form.addEventListener(SAVED, noted);
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
        if (revision() !== null) {
          body.revision = revision();
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

    var passages = parts.passages({
      article: article, boxes: boxes, shown: shown, resolved: resolved,
      revision: revision, attached: attached, composer: composer,
      placement: function () { return panel; },
    });
    var panel = parts.placement({
      all: all, boxes: boxes, shown: shown, forms: forms, decisions: decisions,
      rows: rows, resolved: resolved, agent: agent, routed: routed,
      threadsOf: threadsOf, decisionOf: decisionOf, passages: passages,
      imageWords: imageWords, looked: looked, refresh: refresh, failure: composer.failure, json: json,
      page: page, sections: sections, showUnread: showUnread, changed: changed, author: author, unreadIn: unreadIn,
    });
    decisions.forEach(askAbout);
    panel.arrange();
    read();
  }

  // A page with section boxes also takes threads on the whole page, section
  // WHOLE_PAGE. Its box is served under the title, first among the boxes so
  // its threads are listed first. Older pages need a copy of the first box.
  // A page whose only box is "page" has its box for the whole page already.
  function pageBox(boxes) {
    if (boxes[0].dataset.section === WHOLE_PAGE &&
        boxes[0].parentNode.matches("header.artifact-header")) {
      return boxes;
    }
    var meta = document.querySelector("header.artifact-header .artifact-meta");
    var sectioned = boxes.some(function (box) { return box.dataset.section !== "page"; });
    if (!meta || !sectioned) {
      return boxes;
    }
    var box = boxes[0].cloneNode(true);
    box.open = false;
    box.dataset.section = WHOLE_PAGE;
    box.querySelector(".artifact-comment-threads").replaceChildren();
    var form = box.querySelector("form.artifact-comment-form");
    form.reset();
    form.elements.text.textContent = "";
    form.elements.text.setAttribute("aria-label", "Comment on this page");
    box.querySelector(".artifact-comment-status").textContent = "";
    meta.parentNode.insertBefore(box, meta.nextSibling);
    return [box].concat(boxes);
  }

  var boxes = all("details.artifact-comment");
  var commenting = boxes.length ? {
    start: function (parts) {
      commentBoxes(pageBox(boxes), parts);
    },
  } : null;
