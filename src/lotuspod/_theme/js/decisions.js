
  // The page's decision forms, and the "Answered" table that ends its body:
  // one row per answered question, newest first, read from the answers route
  // for the page every form and comment box names. forms may be empty, on a
  // page whose decisions are no longer asked.
  function answerForms(forms, page) {
    // Each question the read found answered, to its current answer.
    var stored = new Map();
    var answered = null;

    function radios(form) {
      return all('input[type="radio"][name="choice"]', form);
    }

    // A checklist (lotuspod.decisions) asks one question about a list of
    // items: its inputs are checkboxes, each preset to its default, and its
    // answer is the set of items checked.
    function isChecklist(form) {
      return form.classList.contains("artifact-decision--checklist");
    }

    function boxes(form) {
      return all('input[type="checkbox"][name="item"]', form);
    }

    // The ids of a checklist's items checked now ("checked"), or by default
    // ("defaultChecked"), in page order.
    function ticked(form, state) {
      return boxes(form).filter(function (box) { return box[state]; })
        .map(function (box) { return box.value; });
    }

    // Whether two lists of item ids hold the same items.
    function same(a, b) {
      return a.length === b.length && a.every(function (item) { return b.indexOf(item) !== -1; });
    }

    function optionText(input) {
      var text = input.parentNode.querySelector(".artifact-decision-label");
      return text ? text.textContent.replace(/\s+/g, " ").trim() : input.value;
    }

    // The items whose state in checked differs from their defaults, by label
    // in page order, worded as the server words a checklist's answer.
    function summary(form, checked) {
      var on = [];
      var off = [];
      boxes(form).forEach(function (box) {
        var now = checked.indexOf(box.value) !== -1;
        if (now !== box.defaultChecked) {
          (now ? on : off).push(optionText(box));
        }
      });
      var parts = [];
      if (on.length) {
        parts.push("On: " + on.join(", "));
      }
      if (off.length) {
        parts.push("Off: " + off.join(", "));
      }
      return parts.join(" \u00b7 ") || "No change from the defaults";
    }

    // An answer in the words it was given in: its kept label, else its items
    // or its choice.
    function kept(answer) {
      var asked = answer.asked || {};
      if (asked.label) {
        return String(asked.label);
      }
      return Array.isArray(answer.checked) ? answer.checked.join(", ") : String(answer.choice);
    }

    // The label the form shows for an answer: a decision's option label, or
    // the choice itself when it offers no such option (an answer to an
    // earlier wording); a checklist's summary while the answer is at the
    // form's version, else the words it was given in.
    function label(form, answer) {
      if (isChecklist(form)) {
        return answer.version === form.dataset.version ? summary(form, answer.checked || []) :
          kept(answer);
      }
      var found = radios(form).filter(function (radio) { return radio.value === answer.choice; })[0];
      var text = found && found.parentNode.querySelector(".artifact-decision-label");
      return text ? text.textContent : String(answer.choice);
    }

    function status(form, text) {
      form.querySelector(".artifact-decision-status").textContent = text;
    }

    // The answer to the question as the page now asks it, if any.
    function saved(form) {
      var current = form.lotuspodAnswers.current;
      return current && current.version === form.dataset.version ? current : null;
    }

    // Whether the picked option or the note differs from the saved answer;
    // for a checklist, whether the items checked differ from the saved
    // answer's, or from their defaults while it has none.
    function dirty(form) {
      var answer = saved(form);
      if (isChecklist(form)) {
        if (!same(ticked(form, "checked"), answer ? answer.checked || [] : ticked(form, "defaultChecked"))) {
          return true;
        }
      } else {
        var picked = form.querySelector('input[name="choice"]:checked');
        if (picked && (!answer || picked.value !== answer.choice)) {
          return true;
        }
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
        item.appendChild(element("span", "artifact-decision-history-choice", label(form, row)));
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
      line.append(check, " Saved · ", element("strong", "", label(form, answer)),
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
      if (isChecklist(form)) {
        var checked = answer.checked || [];
        boxes(form).forEach(function (box) {
          box.checked = checked.indexOf(box.value) !== -1;
        });
      } else {
        radios(form).forEach(function (radio) {
          radio.checked = radio.value === answer.choice;
        });
      }
      form.elements.note.value = answer.note || "";
    }

    // The words of a form's part, its whitespace collapsed.
    function words(form, selector) {
      var node = form.querySelector(selector);
      return node ? node.textContent.replace(/\s+/g, " ").trim() : "";
    }

    // The form asking question, if the page asks it.
    function formOf(question) {
      return forms.filter(function (form) { return form.dataset.question === question; })[0] || null;
    }

    // The current answer to each answered question, newest first: what the
    // read found, and what a form has saved since.
    function currents() {
      var found = new Map(stored);
      forms.forEach(function (form) {
        if (form.lotuspodAnswers.current) {
          found.set(form.dataset.question, form.lotuspodAnswers.current);
        }
      });
      return Array.from(found.values()).sort(function (a, b) { return b.id - a.id; });
    }

    // A row of the table. A question the page asks at the answer's version
    // takes its number, question and label from its card, and has "change";
    // any other takes the words it was answered in, or else its id and the
    // choice. A checklist has no number.
    function row(answer) {
      var question = String(answer.question);
      var form = formOf(question);
      var asks = Boolean(form) && form.dataset.version === answer.version;
      var asked = answer.asked || {};
      var id = Array.isArray(answer.checked) ? "" : question.replace(/^decision-/, "");
      var number = asks ? words(form, ".artifact-decision-number") || id : id;
      var text = asks ? words(form, ".artifact-decision-text") :
        asked.text ? String(asked.text) : question;
      var chosen = asks ? label(form, answer) : kept(answer);
      var line = element("p", "artifact-answered-choice");
      line.appendChild(element("strong", "", chosen));
      if (asks) {
        var change = element("button", "artifact-decision-change", "change");
        change.type = "button";
        change.addEventListener("click", function () { reopen(form); });
        line.append(" \u00b7 ", change);
      }
      var cell = element("td", "artifact-answered-answer");
      cell.appendChild(line);
      if (answer.note) {
        cell.appendChild(element("p", "artifact-answered-note", answer.note));
      }
      var tr = element("tr");
      tr.dataset.question = question;
      tr.append(element("td", "artifact-answered-number", number),
        element("td", "artifact-answered-when", when(answer.createdAt)),
        element("td", "artifact-answered-question", text), cell,
        element("td", "artifact-answered-by", reader(answer)));
      return tr;
    }

    // Draw the table from the current answers, after the body's last
    // section, so folding a section never hides it; none while nothing is
    // answered.
    function table() {
      var rows = currents();
      if (!rows.length) {
        if (answered) {
          answered.remove();
          answered = null;
        }
        return;
      }
      var body = document.querySelector("section.artifact-body");
      if (!body) {
        return;
      }
      if (!answered) {
        answered = element("div", "artifact-answered");
        var grid = element("table");
        grid.appendChild(element("caption", "", "Answered"));
        var head = element("tr");
        ["#", "When", "Question", "Answer", "By"].forEach(function (name) {
          var th = element("th", "", name);
          th.scope = "col";
          head.appendChild(th);
        });
        grid.appendChild(element("thead")).appendChild(head);
        grid.appendChild(element("tbody"));
        answered.appendChild(grid);
        var last = all(":scope > .artifact-section-body", body).pop();
        if (last) {
          last.after(answered);
        } else {
          body.appendChild(answered);
        }
      }
      var tbody = answered.querySelector("tbody");
      tbody.replaceChildren.apply(tbody, rows.map(row));
    }

    // A row's "change": the card's section opened if it is folded, as find
    // in page opens it, then the card scrolled to and opened again.
    function reopen(form) {
      var wrapper = form.closest("div.artifact-section-body");
      if (wrapper && wrapper.hasAttribute("hidden")) {
        wrapper.dispatchEvent(new Event("beforematch"));
      }
      form.scrollIntoView({ block: "center" });
      unfold(form);
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
      var picked = form.querySelector('input[name="choice"]:checked, input[name="item"]:checked');
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
      var checklist = isChecklist(form);
      var picked = form.querySelector('input[name="choice"]:checked');
      if (!checklist && !picked) {
        status(form, "Pick an option first.");
        return;
      }
      var body = {
        page: form.dataset.page,
        question: form.dataset.question,
        version: form.dataset.version,
      };
      if (checklist) {
        body.checked = ticked(form, "checked");
      } else {
        body.choice = picked.value;
      }
      body.note = form.elements.note.value;
      var button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      status(form, "Saving your answer...");
      try {
        var response = await fetch(ANSWERS, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
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
        table();
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
      var response = await fetch(ANSWERS + "?page=" + encodeURIComponent(page));
      if (!response.ok) {
        return;
      }
      var questions = (await response.json()).questions || {};
      Object.keys(questions).forEach(function (question) {
        var entry = questions[question];
        if (entry && entry.current) {
          stored.set(question, entry.current);
        }
      });
      forms.forEach(function (form) {
        var entry = Object.prototype.hasOwnProperty.call(questions, form.dataset.question)
          ? questions[form.dataset.question] : null;
        // A form answered while this was loading already shows the newest,
        // and one picked or written in (or restored by the browser) other
        // than its answer stays open as the reader left it.
        if (entry && !form.lotuspodAnswers.current) {
          var touched = (isChecklist(form) ? !same(ticked(form, "checked"), ticked(form, "defaultChecked")) :
            form.querySelector('input[name="choice"]:checked')) || form.elements.note.value;
          form.lotuspodAnswers = { current: entry.current, earlier: entry.earlier.slice() };
          if (touched && dirty(form)) {
            form.lotuspodEditing = true;
          } else {
            fill(form);
          }
          draw(form);
        }
      });
      table();
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

  // A page with no form names itself on its comment boxes.
  var forms = all("form.artifact-decision");
  var named = forms[0] || document.querySelector("details.artifact-comment[data-page]");
  if (named) {
    answerForms(forms, named.dataset.page);
  }
