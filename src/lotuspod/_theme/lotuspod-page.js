// Lotuspod page script: answers a page's decision forms (form.artifact-decision),
// shows and posts the comments of its sections (details.artifact-comment) and
// folds each section (div.artifact-section-body) under its heading.
//
// For decisions it reads the page's answers, folds each question answered as
// the page now asks it to one saved line with a "change" button, marks a
// choice or note not yet saved, and posts the reader's answer when a form is
// submitted. For
// comments it reads the page's threads, draws each in its section's box as a
// chat (the reader's comments on the right, agents' replies on the left, each
// state as its own mark outside what anyone wrote), and posts new threads and
// replies. While a thread waits for an agent and the page is seen, it reads
// the threads again, less often while nothing changes, and draws what is new
// in place. Where the window has room right of the reading column, the
// threads live in a side panel (aside.artifact-comments-panel) folded to a
// rail of status dots, each box's summary becomes a one-line chip that opens
// its section's thread there, and a thread can be resolved and reopened. It
// sends no credential of its own: the reader's Cloudflare Access session is
// the only identity. Everything anyone wrote is set as text, never as markup.
(function () {
  "use strict";

  var ANSWERS = "/api/answers";
  var COMMENTS = "/api/comments";
  var SIGNED_OUT = "You are signed out. Reload the page to sign in.";
  var STALE = "This question has changed since the page loaded. Reload it.";
  var CHANGED = "Comments on sections that have changed";
  var CHANGED_GROUP = "Sections that have changed";
  // Whether the reader left the comments panel open or folded.
  var PANEL = "lotuspod:comments-panel";
  // The room the panel needs right of the reading column, in rem.
  var ROOM = 21;
  // Each page's folded sections are kept under this and its path.
  var SECTIONS = "lotuspod:folded:";
  // Sent on a comment box when rows are drawn into it, and on the document
  // once the page's read of answers has finished.
  var DRAWN = "lotuspod:drawn";
  var ANSWERED = "lotuspod:answered";

  function when(stamp) {
    var date = new Date(stamp);
    if (isNaN(date.getTime())) {
      return String(stamp);
    }
    return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }

  function reader(row) {
    return row && row.actor && row.actor.email ? String(row.actor.email) : "someone";
  }

  function all(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  async function json(response) {
    try {
      return await response.json();
    } catch (ignored) {
      return null;
    }
  }

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }

  // The page's sections (div.artifact-section-body, each just after its h2):
  // each heading's text becomes a button that folds its section away with
  // hidden="until-found", so find-in-page and a text fragment still reach it
  // and open it. A link to a heading or to anything in a folded section opens
  // it. What the reader folded is kept per page in localStorage, when the
  // browser lets the page keep anything. A folded heading's button ends in a
  // mark saying what waits in its section: the comments and replies drawn
  // into its box while it was folded, and its questions with no saved answer.
  function foldSections(wrappers) {
    var key = SECTIONS + location.pathname;
    var sections = [];
    // False until the page's read of answers has finished.
    var answered = false;

    function freeId(base) {
      var id = base;
      for (var n = 2; document.getElementById(id); n += 1) {
        id = base + "-" + n;
      }
      return id;
    }

    wrappers.forEach(function (wrapper) {
      var heading = wrapper.previousElementSibling;
      if (!heading || heading.tagName !== "H2") {
        return;
      }
      if (!wrapper.id) {
        wrapper.id = freeId("section-body-" + wrapper.dataset.section);
      }
      // A button may not hold a link: such a section stays open.
      if (heading.querySelector("a")) {
        return;
      }
      var button = element("button", "artifact-section-toggle");
      button.type = "button";
      button.setAttribute("aria-controls", wrapper.id);
      button.setAttribute("aria-expanded", "true");
      while (heading.firstChild) {
        button.appendChild(heading.firstChild);
      }
      // The mark is inside the button, so its words are part of its name.
      var mark = element("span", "artifact-section-mark");
      mark.hidden = true;
      button.append(" ", mark);
      heading.appendChild(button);
      var section = {
        id: wrapper.dataset.section, heading: heading, wrapper: wrapper, button: button,
        mark: mark, fresh: 0,
      };
      sections.push(section);
      button.addEventListener("click", function () {
        change([section], !folded(section));
      });
      // The browser opens a section itself when find or a fragment lands in
      // it; one dispatched by a script leaves the attribute for us to remove.
      wrapper.addEventListener("beforematch", function () {
        change([section], false);
      });
      wrapper.addEventListener(DRAWN, function (event) {
        if (folded(section)) {
          section.fresh += event.detail.rows;
          tally(section);
        }
      });
    });
    if (!sections.length) {
      return;
    }

    function folded(section) {
      return section.wrapper.hasAttribute("hidden");
    }

    function set(section, fold) {
      if (fold) {
        section.wrapper.setAttribute("hidden", "until-found");
      } else {
        section.wrapper.removeAttribute("hidden");
        section.fresh = 0;
      }
      section.button.setAttribute("aria-expanded", fold ? "false" : "true");
      tally(section);
    }

    // Draw a section's mark: "N new", "N to answer" or both, only while it
    // is folded and something waits. A question waits once the answers are
    // read while its form is not folded to a saved answer.
    function tally(section) {
      var parts = [];
      if (section.fresh) {
        parts.push(section.fresh + " new");
      }
      var open = answered ? all("form.artifact-decision", section.wrapper).filter(function (form) {
        return !form.classList.contains("artifact-decision--saved");
      }).length : 0;
      if (open) {
        parts.push(open + " to answer");
      }
      // An open section's mark is empty as well as hidden, so its heading's
      // text stays its title.
      var shown = folded(section) && parts.length > 0;
      section.mark.textContent = shown ? parts.join(" \u00b7 ") : "";
      section.mark.hidden = !shown;
    }

    document.addEventListener(ANSWERED, function () {
      answered = true;
      sections.forEach(tally);
    });

    function change(some, fold) {
      some.forEach(function (section) { set(section, fold); });
      label();
      try {
        var ids = sections.filter(folded).map(function (section) { return section.id; });
        if (ids.length) {
          localStorage.setItem(key, JSON.stringify(ids));
        } else {
          localStorage.removeItem(key);
        }
      } catch (ignored) {
        // Storage refused: the sections still fold, only unremembered.
      }
    }

    // Open the section the element named id is in or heads; true if it was
    // folded.
    function reveal(id) {
      var target = id && document.getElementById(id);
      var found = target && sections.filter(function (section) {
        return section.heading === target || section.wrapper.contains(target);
      })[0];
      if (!found || !folded(found)) {
        return false;
      }
      change([found], false);
      return true;
    }

    function fragment(hash) {
      try {
        return decodeURIComponent(hash.slice(1));
      } catch (ignored) {
        return hash.slice(1);
      }
    }

    var every = null;
    var outline = document.querySelector("nav.artifact-outline");
    if (outline) {
      every = element("button", "artifact-sections-all");
      every.type = "button";
      outline.appendChild(every);
      every.addEventListener("click", function () {
        change(sections, sections.some(function (section) { return !folded(section); }));
      });
    }

    function label() {
      if (every) {
        every.textContent = sections.every(folded) ? "Expand all" : "Collapse all";
      }
    }

    var kept = [];
    try {
      kept = JSON.parse(localStorage.getItem(key) || "[]");
    } catch (ignored) {
      kept = [];
    }
    var restored = false;
    sections.forEach(function (section) {
      if (Array.isArray(kept) && kept.indexOf(section.id) >= 0) {
        set(section, true);
        restored = true;
      }
    });
    label();

    // After the kept state, so the section the URL names ends open.
    var target = location.hash && document.getElementById(fragment(location.hash));
    if (target && (reveal(target.id) || restored)) {
      target.scrollIntoView();
    }
    window.addEventListener("hashchange", function () {
      var id = fragment(location.hash);
      if (reveal(id)) {
        document.getElementById(id).scrollIntoView();
      }
    });
    // A link to the fragment the URL already holds fires no hashchange.
    document.addEventListener("click", function (event) {
      var link = event.target.closest && event.target.closest("a[href^='#']");
      if (link) {
        reveal(fragment(link.getAttribute("href")));
      }
    });
  }

  function answerForms(forms) {
    function radios(form) {
      return all('input[type="radio"][name="choice"]', form);
    }

    // The label the form shows for a choice; the choice itself when it offers
    // no such option (an answer to an earlier wording).
    function label(form, choice) {
      var found = radios(form).filter(function (radio) { return radio.value === choice; })[0];
      var text = found && found.parentNode.querySelector(".artifact-decision-label");
      return text ? text.textContent : String(choice);
    }

    function status(form, text) {
      form.querySelector(".artifact-decision-status").textContent = text;
    }

    // The answer to the question as the page now asks it, if any.
    function saved(form) {
      var current = form.lotuspodAnswers.current;
      return current && current.version === form.dataset.version ? current : null;
    }

    // Whether the picked option or the note differs from the saved answer.
    function dirty(form) {
      var answer = saved(form);
      var picked = form.querySelector('input[name="choice"]:checked');
      if (picked && (!answer || picked.value !== answer.choice)) {
        return true;
      }
      return form.elements.note.value !== (answer && answer.note ? answer.note : "");
    }

    // The lavender rule and "Not saved" while the form differs from its
    // answer; "Not answered yet" while nothing is answered or picked.
    function mark(form) {
      var changed = dirty(form);
      form.classList.toggle("artifact-decision--dirty", changed);
      var unsaved = form.querySelector(".artifact-decision-unsaved");
      if (unsaved) {
        unsaved.hidden = !changed;
      }
      var hint = form.querySelector(".artifact-decision-hint");
      if (hint) {
        hint.hidden = changed || Boolean(form.lotuspodAnswers.current);
      }
    }

    function history(form) {
      var details = form.querySelector(".artifact-decision-history");
      if (!details) {
        details = document.createElement("details");
        details.className = "artifact-decision-history";
        details.appendChild(document.createElement("summary"));
        details.appendChild(document.createElement("ol"));
        form.querySelector("fieldset").appendChild(details);
      }
      var earlier = form.lotuspodAnswers.earlier;
      details.hidden = earlier.length === 0;
      details.querySelector("summary").textContent =
        earlier.length + (earlier.length === 1 ? " earlier answer" : " earlier answers");
      var list = details.querySelector("ol");
      list.replaceChildren();
      earlier.forEach(function (row) {
        var item = document.createElement("li");
        item.appendChild(element("span", "artifact-decision-history-choice", label(form, row.choice)));
        if (row.note) {
          item.appendChild(document.createTextNode(" "));
          item.appendChild(element("span", "artifact-decision-history-note", row.note));
        }
        item.appendChild(document.createTextNode(" "));
        item.appendChild(element("span", "artifact-decision-history-by",
          reader(row) + ", " + when(row.createdAt)));
        list.appendChild(item);
      });
    }

    // The folded card: "✓ Saved · LABEL · change", the note, who and when.
    function fold(form, answer) {
      var block = form.querySelector(".artifact-decision-saved");
      if (!block) {
        block = element("div", "artifact-decision-saved");
        var legend = form.querySelector("legend");
        legend.parentNode.insertBefore(block, legend.nextSibling);
      }
      var line = element("p", "artifact-decision-saved-line");
      var check = element("span", "artifact-decision-check", "✓");
      check.setAttribute("aria-hidden", "true");
      var change = element("button", "artifact-decision-change", "change");
      change.type = "button";
      change.addEventListener("click", function () { unfold(form); });
      line.append(check, " Saved · ", element("strong", "", label(form, answer.choice)),
        " · ", change);
      var parts = [line];
      if (answer.note) {
        parts.push(element("p", "artifact-decision-saved-note", answer.note));
      }
      var by = reader(answer) + " · " + when(answer.createdAt);
      if (answer.supersedes) {
        by += " · replaced an earlier answer";
      }
      parts.push(element("p", "artifact-decision-saved-by", by));
      block.replaceChildren.apply(block, parts);
      return change;
    }

    // Draw a form from its answers: folded under its legend when it holds an
    // answer to the question as the page now asks it, open otherwise.
    function draw(form) {
      var answer = saved(form);
      var folded = Boolean(answer) && !form.lotuspodEditing;
      var current = form.lotuspodAnswers.current;
      var earlier = form.querySelector(".artifact-decision-earlier");
      if (current && !answer) {
        if (!earlier) {
          earlier = element("p", "artifact-decision-earlier");
          var options = form.querySelector(".artifact-decision-options");
          options.parentNode.insertBefore(earlier, options);
        }
        earlier.textContent = "Answered to an earlier wording by " + reader(current) + ", " +
          when(current.createdAt);
      } else if (earlier) {
        earlier.remove();
      }
      var change = folded ? fold(form, answer) : null;
      Array.prototype.forEach.call(form.querySelector("fieldset").children, function (child) {
        if (child.tagName === "LEGEND" || child.classList.contains("artifact-decision-history")) {
          return;
        }
        child.hidden = child.classList.contains("artifact-decision-saved") ? !folded : folded;
      });
      form.classList.toggle("artifact-decision--saved", folded);
      history(form);
      mark(form);
      return change;
    }

    // Fill a form's inputs from its answer to the question as the page now
    // asks it; an answer to an earlier wording fills nothing.
    function fill(form) {
      var answer = saved(form);
      if (!answer) {
        return;
      }
      radios(form).forEach(function (radio) {
        radio.checked = radio.value === answer.choice;
      });
      form.elements.note.value = answer.note || "";
    }

    // "change": the card open again with its answer picked and its note.
    function unfold(form) {
      fill(form);
      var note = form.querySelector("details.artifact-decision-note");
      if (note) {
        note.open = Boolean(form.elements.note.value);
      }
      form.lotuspodEditing = true;
      status(form, "");
      draw(form);
      var picked = form.querySelector('input[name="choice"]:checked');
      if (picked) {
        picked.focus();
      }
    }

    function failure(response, payload) {
      if (response.status === 401) {
        return SIGNED_OUT;
      }
      if (response.status === 409) {
        return STALE;
      }
      var error = payload && payload.error ? String(payload.error) : "status " + response.status;
      return "Your answer was not saved (" + error + "). Try again.";
    }

    async function submit(event) {
      event.preventDefault();
      var form = event.currentTarget;
      var picked = form.querySelector('input[name="choice"]:checked');
      if (!picked) {
        status(form, "Pick an option first.");
        return;
      }
      var button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      status(form, "Saving your answer...");
      try {
        var response = await fetch(ANSWERS, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            page: form.dataset.page,
            question: form.dataset.question,
            version: form.dataset.version,
            choice: picked.value,
            note: form.elements.note.value,
          }),
        });
        var payload = await json(response);
        if (response.status !== 201 || !payload) {
          status(form, failure(response, payload));
          return;
        }
        var answers = form.lotuspodAnswers;
        if (answers.current) {
          answers.earlier.unshift(answers.current);
        }
        answers.current = payload;
        // A pick or note changed while this was saving stays open, not saved.
        form.lotuspodEditing = dirty(form);
        status(form, "");
        var change = draw(form);
        if (change) {
          change.focus();
        }
      } catch (ignored) {
        status(form, "Your answer was not saved: the site did not answer. Try again.");
      } finally {
        button.disabled = false;
      }
    }

    async function load() {
      var page = forms[0].dataset.page;
      var response = await fetch(ANSWERS + "?page=" + encodeURIComponent(page));
      if (!response.ok) {
        return;
      }
      var questions = (await response.json()).questions || {};
      forms.forEach(function (form) {
        var entry = Object.prototype.hasOwnProperty.call(questions, form.dataset.question)
          ? questions[form.dataset.question] : null;
        // A form answered while this was loading already shows the newest,
        // and one picked or written in (or restored by the browser) other
        // than its answer stays open as the reader left it.
        if (entry && !form.lotuspodAnswers.current) {
          var touched = form.querySelector('input[name="choice"]:checked') || form.elements.note.value;
          form.lotuspodAnswers = { current: entry.current, earlier: entry.earlier.slice() };
          if (touched && dirty(form)) {
            form.lotuspodEditing = true;
          } else {
            fill(form);
          }
          draw(form);
        }
      });
    }

    forms.forEach(function (form) {
      form.lotuspodAnswers = { current: null, earlier: [] };
      form.lotuspodEditing = false;
      form.addEventListener("submit", submit);
      form.addEventListener("input", function () { mark(form); });
      form.addEventListener("change", function () { mark(form); });
      mark(form);
    });
    load().catch(function () {}).then(function () {
      document.dispatchEvent(new CustomEvent(ANSWERED));
    });
  }

  // The comment boxes (lotuspod.comments): one per section, or one for the
  // page. Threads come from the comments route; each is shown in the box of
  // its section, or, when the page no longer has that section, in a list at
  // the end of the body. Where the window has room for it, every thread is
  // shown in the side panel instead (sidePanel below), and each box is a chip.
  function commentBoxes(boxes) {
    var page = boxes[0].dataset.page;
    var tag = document.querySelector('meta[name="lotuspod:owner"]');
    var owner = tag ? tag.content : "";
    // Maps, not objects: a section id is the author's and may be any name,
    // "__proto__" included.
    var sections = new Map();
    var shown = new Map();
    // Each box's form for a new thread, wherever it is shown.
    var forms = new Map();

    boxes.forEach(function (box) {
      sections.set(box.dataset.section, box);
      forms.set(box, box.querySelector("form.artifact-comment-form"));
    });

    // An agent's handle when an agent wrote the row; "" for anyone else. Only
    // the verified actor's kind says a row is an agent's, never an address.
    function agent(row) {
      var actor = row && row.actor;
      if (!actor || actor.kind !== "agent") {
        return "";
      }
      return actor.handle ? String(actor.handle) : "agent";
    }

    // Who wrote a row that is not an agent's: an address, else a handle.
    function author(row) {
      var actor = row && row.actor;
      if (actor && actor.email) {
        return String(actor.email);
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

    // An agent's name line: the handle in the mono voice and its AGENT tag.
    function agentName(handle) {
      var by = element("p", "artifact-comment-by");
      by.appendChild(element("span", "artifact-comment-handle", handle));
      by.appendChild(document.createTextNode(" "));
      by.appendChild(element("span", "artifact-comment-agent", "AGENT"));
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
        by = agentName(handle);
      } else {
        by = element("p", "artifact-comment-by");
        by.appendChild(element("span", "artifact-comment-author", name));
      }
      var time = element("time", "artifact-comment-time", when(entry.createdAt));
      time.dateTime = String(entry.createdAt || "");
      by.appendChild(document.createTextNode(" "));
      by.appendChild(time);
      drawn.column.appendChild(by);
      drawn.column.appendChild(element("p", "artifact-comment-text", String(entry.text || "")));
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
      var error = payload && payload.error ? String(payload.error) : "status " + response.status;
      return "Not saved (" + error + "). Try again.";
    }

    // Post body from form; the stored row, or null with the form told why.
    async function post(form, body) {
      var status = form.querySelector(".artifact-comment-status");
      var button = form.querySelector('button[type="submit"]');
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
        return payload;
      } catch (ignored) {
        status.textContent = "Not saved: the site did not answer. Try again.";
        return null;
      } finally {
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
      thread.toggle = toggle;
      thread.field = text;

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

    function summary(box) {
      var count = threadsOf(box).length;
      box.querySelector("summary").textContent = count ? "Comments (" + count + ")" : "Comment";
    }

    // The side panel (layout C of docs/design/margin-comments-mockup.html),
    // shown while the window leaves ROOM right of the reading column: fixed
    // to the window's right edge, folded to a rail of one dot per open thread
    // or open with every thread listed under its section's heading, one
    // entry open at a time. A thread's node is moved into its entry, never
    // drawn twice, so its live reads, composer and live region go on as they
    // were. Each box's summary is then a chip saying where its section's
    // open threads stand, which opens them here: a box never opens, and
    // nothing in the column moves when the panel or a thread changes.
    function sidePanel() {
      var column = document.querySelector(".artifact-body");
      var api = { wide: false };
      var arranged = false;
      var open = false;
      // The thread whose entry is open, if any.
      var current = null;
      var groups = new Map();
      var dotsKey = null;

      try {
        open = localStorage.getItem(PANEL) === "open";
      } catch (ignored) {
        open = false;
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
      head.append(element("h2", "artifact-comments-title", "Comments"), count, fold);
      var list = element("div", "artifact-comments-groups");
      sheet.append(head, list);
      aside.append(rail, sheet);
      document.body.appendChild(aside);

      // The text of a box's section heading, without the mark a folded
      // heading ends in.
      function title(box) {
        var heading = document.getElementById(box.dataset.section);
        if (!heading || heading.tagName !== "H2") {
          return "This page";
        }
        var copy = heading.cloneNode(true);
        all(".artifact-section-mark", copy).forEach(function (mark) { mark.remove(); });
        return copy.textContent.replace(/\s+/g, " ").trim() || "This page";
      }

      // A group: a section's heading, its threads, and for a section the
      // page has, the control that opens the box's form here.
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
        groups.set(box, group(title(box), box, index));
      });
      var strays = group(CHANGED_GROUP, null, -1);
      strays.node.hidden = true;

      // Unfold or fold a group's form for a new thread; unfolded, its field
      // has focus.
      function compose(made, show) {
        made.holder.hidden = !show;
        made.toggle.setAttribute("aria-expanded", show ? "true" : "false");
        if (show) {
          reveal(made.holder);
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
        open = show;
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
        function lead() {
          var lines = [mute(element("span", "artifact-comments-entry-mark",
            thread.root.quote ? "" : "§"))];
          lines.push(element("span", "artifact-comments-entry-words", opening(thread.root.text)));
          return lines;
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
        var folded = element("div", "artifact-comments-entry-resolved");
        var reopen = element("button", "artifact-comments-reopen", "Reopen");
        reopen.type = "button";
        var done = element("span", "artifact-comments-entry-done");
        done.append(tick(), " resolved · ", reopen);
        folded.append.apply(folded, lead().concat([done]));
        var tools = element("div", "artifact-comments-entry-tools");
        var resolve = element("button", "artifact-comments-resolve", "Resolve");
        resolve.type = "button";
        tools.appendChild(resolve);
        body.appendChild(tools);
        var status = element("p", "artifact-comments-entry-status");
        status.setAttribute("role", "status");
        item.append(top, folded, body, status);
        var dot = element("li", "artifact-comments-dot");
        thread.entry = {
          item: item, head: top, state: state, folded: folded, body: body, resolve: resolve,
          reopen: reopen, status: status, dot: dot, key: "",
        };
        top.addEventListener("click", function () {
          if (current === thread) {
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
      // resolved to one dashed line.
      function draw(thread) {
        var made = entry(thread);
        var done = resolved(thread);
        var opened = !done && current === thread;
        made.item.classList.toggle("artifact-comments-entry--resolved", done);
        made.item.classList.toggle("artifact-comments-entry--open", opened);
        made.head.hidden = done;
        made.folded.hidden = !done;
        made.body.hidden = !opened;
        made.head.setAttribute("aria-expanded", opened ? "true" : "false");
        var kind = standing(thread);
        var handle = routed(asked(thread));
        var key = [kind, handle, thread.replies.length].join("\n");
        if (key === made.key) {
          return;
        }
        made.key = key;
        var said = element("span", "artifact-comments-entry-said artifact-comments-entry-said--" + kind);
        if (kind === "answered") {
          said.append(tick(), " Answered");
        } else if (kind === "writing") {
          said.textContent = handle + " is writing";
        } else if (kind === "waiting") {
          said.textContent = "Waiting for " + handle;
        } else {
          said.textContent = handle + " couldn't answer";
        }
        made.state.replaceChildren(said, " · ",
          element("span", "artifact-comments-entry-count",
            plural(thread.replies.length, "reply", "replies")));
      }

      function expand(thread) {
        var before = current;
        current = thread;
        if (before && before !== thread) {
          draw(before);
        }
        if (thread) {
          draw(thread);
          reveal(thread.entry.item);
        }
      }

      // Bring a thread's chip into the window, opening its section first
      // through its heading's button if it is folded.
      function bring(thread) {
        if (!thread.box) {
          return;
        }
        var wrapper = thread.box.closest(".artifact-section-body");
        if (wrapper && wrapper.hasAttribute("hidden")) {
          var heading = wrapper.previousElementSibling;
          var button = heading && heading.querySelector("button.artifact-section-toggle");
          if (button) {
            button.click();
          }
        }
        var chip = thread.box.querySelector("summary");
        var bar = document.querySelector(".artifact-topbar");
        var top = bar ? bar.getBoundingClientRect().bottom : 0;
        var rect = chip.getBoundingClientRect();
        if (rect.top < top || rect.bottom > window.innerHeight) {
          chip.scrollIntoView({ block: "center" });
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
            (resolve ? made.reopen : made.head).focus({ preventScroll: true });
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

      // A box's chip: where its section's open threads stand, in one line.
      function chip(box) {
        var summaryNode = box.querySelector("summary");
        var threads = unresolvedOf(box);
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
        var text = element("span", "artifact-comment-chip-text");
        text.append.apply(text, parts);
        var key = kind + "\n" + faces.innerHTML + "\n" + text.textContent;
        if (summaryNode.lotuspodChip === key) {
          return;
        }
        summaryNode.lotuspodChip = key;
        summaryNode.className = "artifact-comment-summary artifact-comment-chip artifact-comment-chip--" + kind;
        summaryNode.replaceChildren(faces, text);
      }

      // The box's form for a new thread posted one: in the panel, the form
      // folds and the new thread's entry opens.
      api.posted = function (box, thread) {
        if (!api.wide || !thread) {
          return;
        }
        var made = groups.get(box);
        var focused = made.holder.contains(document.activeElement)
          || document.activeElement === document.body;
        compose(made, false);
        expand(thread);
        if (focused) {
          thread.entry.head.focus({ preventScroll: true });
        }
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

      boxes.forEach(function (box) {
        var summaryNode = box.querySelector("summary");
        summaryNode.addEventListener("click", function (event) {
          if (api.wide) {
            event.preventDefault();
            show(box);
          }
        });
        summaryNode.addEventListener("keydown", function (event) {
          if (api.wide && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            show(box);
          }
        });
        summaryNode.addEventListener("keyup", function (event) {
          if (api.wide && event.key === " ") {
            event.preventDefault();
          }
        });
        box.addEventListener("toggle", function () {
          if (api.wide && box.open) {
            box.open = false;
          }
        });
      });

      api.put = function (thread) {
        var made = entry(thread);
        if (thread.node.parentNode !== made.body) {
          made.body.appendChild(thread.node);
        }
        var target = thread.box ? groups.get(thread.box) : strays;
        if (made.item.parentNode !== target.entries) {
          var after = all(":scope > li", target.entries).filter(function (item) {
            return Number(item.dataset.thread) > thread.root.id;
          })[0] || null;
          target.entries.insertBefore(made.item, after);
        }
        strays.node.hidden = !strays.entries.firstChild;
        draw(thread);
      };

      api.refresh = function () {
        var threads = ordered();
        var unresolved = threads.filter(function (thread) { return !resolved(thread); });
        badge.textContent = String(unresolved.length);
        badge.hidden = unresolved.length === 0;
        count.textContent = unresolved.length + " open · " +
          (threads.length - unresolved.length) + " resolved";
        threads.forEach(draw);
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
      };

      // Whether the window leaves ROOM right of the reading column.
      function roomy() {
        if (!column) {
          return false;
        }
        var rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
        return document.documentElement.clientWidth - column.getBoundingClientRect().right >= ROOM * rem;
      }

      // Show the threads in the panel or in the boxes, as the window allows.
      api.arrange = function () {
        var wide = roomy();
        if (arranged && wide === api.wide) {
          return;
        }
        arranged = true;
        api.wide = wide;
        aside.hidden = !wide;
        boxes.forEach(function (box) {
          var form = forms.get(box);
          if (wide) {
            box.open = false;
            groups.get(box).holder.appendChild(form);
          } else {
            box.appendChild(form);
            var summaryNode = box.querySelector("summary");
            summaryNode.className = "artifact-comment-summary";
            summaryNode.lotuspodChip = "";
          }
        });
        var old = document.querySelector(".artifact-comments-changed");
        if (old) {
          old.hidden = wide;
        }
        shown.forEach(put);
        refresh();
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
      node.appendChild(list);
      replyForm(thread, node);
      shown.set(root.id, thread);
      merge(thread, entry.replies || []);
      put(thread);
      return true;
    }

    function resolved(thread) {
      return Boolean(thread.resolution && thread.resolution.resolved);
    }

    // Show a thread where the window has room for it: in the panel, else in
    // its section's box or the list of changed sections.
    function put(thread) {
      if (panel.wide) {
        panel.put(thread);
      } else if (thread.box) {
        thread.box.querySelector(".artifact-comment-threads").appendChild(thread.node);
      } else {
        changed().appendChild(thread.node);
      }
    }

    // Draw what the threads say outside them: the boxes' summaries, or the
    // panel and its chips.
    function refresh() {
      if (panel.wide) {
        panel.refresh();
      } else {
        boxes.forEach(summary);
      }
    }

    // The checks for replies: while a thread waits and the page is seen,
    // read the threads again FIRST after the last read, each gap half again
    // as long as the one before up to LAST, and the first gap again after
    // any change or a comment the reader posts.
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
      if (reading || !checking || hidden() || !waiting()) {
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
        // In the panel a box's form may be folded away: the thread says it.
        var status = first.box && !panel.wide
          ? forms.get(first.box).querySelector(".artifact-comment-status")
          : first.node.querySelector(":scope > .artifact-comment-status");
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
          signedOut();
          return;
        }
        if (response.status === 200) {
          var payload = await json(response);
          ((payload && payload.threads) || []).forEach(function (entry) {
            if (add(entry)) {
              touched = true;
            }
          });
        }
      } catch (ignored) {
        // A failed read keeps the schedule.
      }
      reading = false;
      refresh();
      gap = touched || fresh ? FIRST : Math.min(gap * 1.5, LAST);
      fresh = false;
      plan();
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

    document.addEventListener("visibilitychange", function () {
      if (hidden()) {
        clearTimeout(timer);
        timer = null;
      } else if (!timer && !reading && checking && waiting()) {
        fresh = true;
        read();
      }
    });

    boxes.forEach(function (box) {
      var form = forms.get(box);
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

    var panel = sidePanel();
    panel.arrange();
    window.addEventListener("resize", panel.arrange);
    read();
  }

  var wrappers = all("div.artifact-section-body");
  if (wrappers.length) {
    foldSections(wrappers);
  }
  var forms = all("form.artifact-decision");
  if (forms.length) {
    answerForms(forms);
  }
  var boxes = all("details.artifact-comment");
  if (boxes.length) {
    commentBoxes(boxes);
  }
})();
