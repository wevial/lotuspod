// Lotuspod page script: answers a page's decision forms (form.artifact-decision).
//
// It reads the page's answers, marks each current choice and fills its note,
// and posts the reader's answer when a form is submitted. It sends no
// credential of its own: the reader's Cloudflare Access session is the only
// identity. Everything a reader wrote is set as text, never as markup.
(function () {
  "use strict";

  var ANSWERS = "/api/answers";
  var SIGNED_OUT = "You are signed out. Reload the page to sign in.";
  var STALE = "This question has changed since the page loaded. Reload it.";

  var forms = Array.prototype.slice.call(document.querySelectorAll("form.artifact-decision"));
  if (!forms.length) {
    return;
  }

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

  function radios(form) {
    return Array.prototype.slice.call(form.querySelectorAll('input[type="radio"][name="choice"]'));
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
        radios(form).forEach(function (radio) { radio.checked = radio.value === current.choice; });
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
})();
