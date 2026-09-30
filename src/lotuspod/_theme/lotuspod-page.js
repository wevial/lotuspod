// Lotuspod page script: answers a page's decision forms (form.artifact-decision)
// and shows and posts the comments of its sections (details.artifact-comment).
//
// For decisions it reads the page's answers, marks each current choice and
// fills its note, and posts the reader's answer when a form is submitted. For
// comments it reads the page's threads, shows each in its section's box with
// every comment's state, and posts new threads and replies. It sends no
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

    function answered(form, row) {
      var line = "Answered by " + reader(row) + ", " + when(row.createdAt);
      if (row.version !== form.dataset.version) {
        line += ", to an earlier wording of this question";
      }
      status(form, line);
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
        var choice = document.createElement("span");
        choice.className = "artifact-decision-history-choice";
        choice.textContent = label(form, row.choice);
        item.appendChild(choice);
        if (row.note) {
          var note = document.createElement("span");
          note.className = "artifact-decision-history-note";
          note.textContent = row.note;
          item.appendChild(document.createTextNode(" "));
          item.appendChild(note);
        }
        var by = document.createElement("span");
        by.className = "artifact-decision-history-by";
        by.textContent = reader(row) + ", " + when(row.createdAt);
        item.appendChild(document.createTextNode(" "));
        item.appendChild(by);
        list.appendChild(item);
      });
    }

    // Show a form's stored answers; fill its inputs only when asked to, and
    // only from an answer to the question as the page now asks it.
    function show(form, fill) {
      var current = form.lotuspodAnswers.current;
      if (current) {
        answered(form, current);
        if (fill && current.version === form.dataset.version) {
          radios(form).forEach(function (radio) {
            radio.checked = radio.value === current.choice;
          });
          form.elements.note.value = current.note || "";
        }
      }
      history(form);
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
        var payload = null;
        try {
          payload = await response.json();
        } catch (ignored) {
          payload = null;
        }
        if (response.status !== 201 || !payload) {
          status(form, failure(response, payload));
          return;
        }
        var answers = form.lotuspodAnswers;
        if (answers.current) {
          answers.earlier.unshift(answers.current);
        }
        answers.current = payload;
        show(form, false);
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
        // A form answered while this was loading already shows the newest.
        if (entry && !form.lotuspodAnswers.current) {
          form.lotuspodAnswers = { current: entry.current, earlier: entry.earlier.slice() };
          show(form, true);
        }
      });
    }

    forms.forEach(function (form) {
      form.lotuspodAnswers = { current: null, earlier: [] };
      form.addEventListener("submit", submit);
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

    // An agent's handle when an agent wrote the row; "" for a reader.
    function agent(row) {
      var actor = row && row.actor;
      return actor && actor.kind !== "human" && actor.handle ? String(actor.handle) : "";
    }

    // Where a reader's comment stands. The handle is the agent it is routed
    // to, else the page's owner.
    function state(row) {
      var handle = row.owner ? String(row.owner) : owner || "an agent";
      switch (row.state) {
        case "pending":
          return "waiting for " + handle;
        case "unavailable":
          return handle + " is offline; queued for it";
        case "claimed":
          return handle + " is answering";
        case "answered":
          return "answered";
        case "failed":
          return handle + " could not answer: " +
            (row.reason ? String(row.reason) : "no reason given");
        case "paused":
          return "the responder is paused";
        default:
          return String(row.state || "");
      }
    }

    function comment(row) {
      var handle = agent(row);
      var item = element("li", "artifact-comment-item");
      if (handle) {
        item.classList.add("artifact-comment-item--agent");
      }
      var by = element("p", "artifact-comment-by");
      by.appendChild(element("span", handle ? "artifact-comment-agent" : "artifact-comment-author",
        handle || reader(row)));
      var time = element("time", "artifact-comment-time", when(row.createdAt));
      time.dateTime = String(row.createdAt || "");
      by.appendChild(document.createTextNode(" "));
      by.appendChild(time);
      item.appendChild(by);
      item.appendChild(element("p", "artifact-comment-text", String(row.text || "")));
      if (!handle) {
        var standing = element("p", "artifact-comment-state", state(row));
        standing.dataset.state = String(row.state || "");
        item.appendChild(standing);
      } else if (row.revision) {
        // The reply carries the revision of the page it made.
        var revised = element("p", "artifact-comment-revision");
        var link = element("a", "", "Revised the page · revision " + row.revision);
        link.href = encodeURIComponent(page) + ".html";
        revised.appendChild(link);
        item.appendChild(revised);
      }
      return item;
    }

    function fill(thread) {
      thread.list.replaceChildren(comment(thread.root));
      thread.replies.forEach(function (row) {
        thread.list.appendChild(comment(row));
      });
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
