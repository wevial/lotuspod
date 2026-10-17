
  // The comment boxes (lotuspod.comments): one per section, or one for the
  // page. The threads, the reads that fill them, the replies to the reader
  // and the decisions' Ask are the islands' store
  // (web/src/islands/comments/store.ts); this keeps what is kept over a
  // reload and swaps, and reaches the threads through the store.
  function commentBoxes(boxes, parts) {
    // The page's decision forms, in page order.
    var decisions = all("form.artifact-decision[data-question]");

    var store = parts.store({
      boxes: boxes, decisions: decisions, restore: restore, boxWith: boxWith,
    });
    var sections = store.sections;
    var shown = store.shown;
    var forms = store.forms;
    var attached = store.attached;
    var refresh = store.refresh;

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
        var passage = store.passages.writing();
        return Boolean(passage && (passage.text.trim() || passage.held)) || composers().some(holding) ||
          awaiting.size > 0;
      },
      save: function () {
        return {
          open: store.panel.held(),
          passage: store.passages.writing(),
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
          store.panel.reopen({ section: now.dataset.section, writing: true });
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
          if (!(each.quote && store.passages.reopen(each))) {
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
        store.panel.reopen(was.open);
      }
      var passage = was.passage && typeof was.passage === "object" ? was.passage : null;
      if (passage && !store.passages.reopen(passage) && worth(passage)) {
        moved = rehome(passage, PASSAGE_GONE);
      }
      if (moved) {
        store.panel.reopen({ section: moved.dataset.section, writing: true });
      }
      live.place();
    }

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
    var sending = store.composer.sending;
    function wire(box) { return store.composer.wire(box); }
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
      store.swapped(event.detail.revision);
      var focused = document.activeElement;
      var writing = store.passages.swept();
      if (writing && takenAt.has(writing.box)) {
        writing.index = takenAt.get(writing.box);
      }
      store.passages.moved();
      var unsent = [];
      var olds = [];
      var news = [];
      var gone = [];
      var fresh = [];
      units.forEach(function (unit) {
        if (unit.kind === "header") {
          // The swap gave the tab the new revision's title.
          store.retitle();
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
        store.panel.forget(form);
      });
      decisions.push.apply(decisions, fresh);
      decisions.sort(function (a, b) {
        return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      });
      store.ask();
      fresh.forEach(store.askAbout);
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
            store.panel.reopen({ section: box.dataset.section, writing: true });
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
            store.panel.reopen({ section: box.dataset.section, writing: true });
          }
        });
      } else if (writing) {
        moved = rewrite(writing) || moved;
      }
      if (moved) {
        store.panel.reopen({ section: moved.dataset.section, writing: true });
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
      if (store.passages.reopen(writing) || !worth(writing)) {
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
      var taken = store.panel.take(olds.concat(replaced.map(function (pair) { return pair[0]; })));
      replaced.forEach(function (pair) { replaceBox(pair[0], pair[1]); });
      olds.forEach(function (old) {
        var each = dropBox(old);
        if (each) {
          unsent.push(each);
        }
      });
      added.forEach(addBox);
      store.panel.remounted();
      var order = boxes.map(function (box) { return [box, forms.get(box)]; });
      forms.clear();
      order.forEach(function (pair) { forms.set(pair[0], pair[1]); });
      shown.forEach(store.put);
      refresh();
      store.panel.give(taken);
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
      store.panel.replace(old, box);
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
          thread.node.insertBefore(store.whereFrom(thread.root), thread.node.firstChild);
        }
      });
      store.panel.unmount(old, at);
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
      store.enlist(box);
      wire(box);
      store.panel.mount(box, at);
      shown.forEach(function (thread) {
        if (!thread.box && store.boxFor(thread.root) === box) {
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
      if (store.passages.writes(nodes)) {
        return true;
      }
      return removed && boxes.some(function (box) {
        var form = forms.get(box);
        return nodes.some(function (node) { return node.contains(box); }) &&
          holding({ field: form.elements.text, images: attached.get(form) });
      });
    });

    store.start();
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
