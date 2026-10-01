// Lotuspod page script: answers a page's decision forms (form.artifact-decision)
// and shows and posts the comments of its sections (details.artifact-comment).
//
// For decisions it reads the page's answers, folds each question answered as
// the page now asks it to one saved line with a "change" button, marks a
// choice or note not yet saved, and posts the reader's answer when a form is
// submitted. For
// comments it reads the page's threads, draws each in its section's box as a
// chat (the reader's comments on the right, agents' replies on the left, each
// state as its own mark outside what anyone wrote), and posts new threads and
// replies. It sends no
// credential of its own: the reader's Cloudflare Access session is the only
// identity. Everything anyone wrote is set as text, never as markup.
(function () {
  "use strict";

  var ANSWERS = "/api/answers";
  var COMMENTS = "/api/comments";
  var SIGNED_OUT = "You are signed out. Reload the page to sign in.";
  var STALE = "This question has changed since the page loaded. Reload it.";
  var CHANGED = "Comments on sections that have changed";

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
    load().catch(function () {});
  }

  // The comment boxes (lotuspod.comments): one per section, or one for the
  // page. Threads come from the comments route; each is shown in the box of
  // its section, or, when the page no longer has that section, in a list at
  // the end of the body.
  function commentBoxes(boxes) {
    var page = boxes[0].dataset.page;
    var tag = document.querySelector('meta[name="lotuspod:owner"]');
    var owner = tag ? tag.content : "";
    // Maps, not objects: a section id is the author's and may be any name,
    // "__proto__" included.
    var sections = new Map();
    var shown = new Map();

    boxes.forEach(function (box) {
      sections.set(box.dataset.section, box);
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

    // What a reader's comment's state draws after it; null for none.
    function after(entry) {
      var handle = routed(entry);
      switch (entry.state) {
        case "unavailable":
          return notice("unavailable", "hollow", handle + " is offline",
            ["Your comment goes to " + handle + " when it checks in again."]);
        case "paused":
          return notice("paused", "pause", "The responder is paused",
            ["Your comment waits until it is resumed."]);
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
    // no answer yet; null for none.
    function typing(entry) {
      var handle = routed(entry);
      var drawn;
      var bubble;
      if (entry.state === "pending") {
        drawn = row("artifact-comment-typing artifact-comment-typing--pending",
          "artifact-comment-avatar--ghost", handle.charAt(0).toUpperCase());
        bubble = element("p", "artifact-comment-bubble artifact-comment-bubble--ghost",
          "Waiting for " + handle);
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
      drawn.item.setAttribute("role", "status");
      drawn.column.appendChild(bubble);
      return drawn.item;
    }

    function fill(thread) {
      var rows = [thread.root].concat(thread.replies);
      var newest = null;
      thread.list.replaceChildren();
      rows.forEach(function (entry) {
        thread.list.appendChild(comment(entry));
        if (agent(entry)) {
          if (entry.revision) {
            thread.list.appendChild(revised(entry));
          }
          return;
        }
        newest = entry;
        var line = after(entry);
        if (line) {
          thread.list.appendChild(line);
        }
      });
      var waiting = newest && typing(newest);
      if (waiting) {
        thread.list.appendChild(waiting);
      }
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

    function replyForm(thread) {
      var form = element("form", "artifact-comment-reply");
      var text = element("textarea");
      text.name = "text";
      text.rows = 2;
      text.maxLength = 4000;
      text.required = true;
      text.setAttribute("aria-label", "Reply");
      form.appendChild(text);
      var actions = element("div", "artifact-comment-actions");
      var button = element("button", "", "Reply");
      button.type = "submit";
      actions.appendChild(button);
      var status = element("p", "artifact-comment-status");
      status.setAttribute("role", "status");
      actions.appendChild(status);
      form.appendChild(actions);
      form.addEventListener("submit", async function (event) {
        event.preventDefault();
        var row = await post(form, { page: page, parent: thread.root.id, text: text.value });
        if (row) {
          thread.replies.push(row);
          fill(thread);
        }
      });
      return form;
    }

    function summary(box) {
      var count = box.querySelectorAll(".artifact-comment-thread").length;
      box.querySelector("summary").textContent = count ? "Comments (" + count + ")" : "Comment";
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

    function add(entry) {
      var root = entry.root;
      if (!root || shown.has(root.id)) {
        return;
      }
      var thread = {
        root: root,
        replies: (entry.replies || []).slice(),
        list: element("ol", "artifact-comment-list"),
      };
      shown.set(root.id, thread);
      var node = element("div", "artifact-comment-thread");
      node.dataset.thread = String(root.id);
      var box = sections.get(root.section) || null;
      if (!box) {
        node.appendChild(element("p", "artifact-comment-section",
          "On " + String(root.sectionTitle || root.section || "an earlier section")));
      }
      node.appendChild(thread.list);
      node.appendChild(replyForm(thread));
      fill(thread);
      if (box) {
        box.querySelector(".artifact-comment-threads").appendChild(node);
        summary(box);
      } else {
        changed().appendChild(node);
      }
    }

    boxes.forEach(function (box) {
      var form = box.querySelector("form.artifact-comment-form");
      form.addEventListener("submit", async function (event) {
        event.preventDefault();
        var row = await post(form, {
          page: page, section: box.dataset.section, text: form.elements.text.value,
        });
        if (row) {
          add({ root: row, replies: [] });
        }
      });
    });

    async function load() {
      var response = await fetch(COMMENTS + "?page=" + encodeURIComponent(page));
      if (!response.ok) {
        return;
      }
      ((await response.json()).threads || []).forEach(add);
    }

    load().catch(function () {});
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
