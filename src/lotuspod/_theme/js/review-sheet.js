
  // The review sheet over a page's decision forms (js/decisions.js), drawn
  // once the page's answers are read. Each question's shown choice is its
  // picked option, else its stored answer at its version, else its default
  // (the form's data-default); it is Open with none, Default at its default
  // (a checklist with every box at its default), else Changed, "was:" the
  // default's label, or "was: open" with no default. A form with a default
  // and no stored answer gets its default picked, so it shows "Not saved".
  // The title bar ends in "Next open: QUESTION ↓", which jumps to the next
  // open question, and "N to answer · Respond", which opens the Respond
  // panel: every question under its section's heading, its options as
  // pressed buttons (a checklist's as checkboxes), its state, and one Save
  // that posts each answer whose shown choice or note is not stored, in page
  // order. A page whose answers could not be read gets no sheet, and nor
  // does an archived one, which takes no answer.
  // Each h2 whose section asks open questions, and its outline link, is
  // marked "N open". The panel and the forms are one state: a pick in
  // either moves the other.
  function reviewSheet(the) {
    var bar = document.querySelector(".artifact-topbar");
    var body = document.querySelector("section.artifact-body");
    if (!bar || !body || ARCHIVED) {
      return;
    }
    var outline = document.querySelector("ol.artifact-outline-list");
    var headings = all("h2", body);
    var MARKS = ".artifact-section-mark, .artifact-changed-tag, .artifact-review-open";

    function words(node) {
      return node ? node.textContent.replace(/\s+/g, " ").trim() : "";
    }

    function mute(node) {
      node.setAttribute("aria-hidden", "true");
      return node;
    }

    // A heading's own words: its fold button's, without the marks in it.
    function headingTitle(heading) {
      var copy = (heading.querySelector(".artifact-section-toggle") || heading).cloneNode(true);
      all(MARKS, copy).forEach(function (mark) { mark.remove(); });
      return copy.textContent.replace(/\s+/g, " ").trim();
    }

    function radios(form) {
      return all('input[type="radio"][name="choice"]', form);
    }

    function boxes(form) {
      return all('input[type="checkbox"][name="item"]', form);
    }

    function radioOf(question, value) {
      return radios(question.form).filter(function (radio) { return radio.value === value; })[0] || null;
    }

    // Each question in page order, under the nearest h2 before its form.
    var questions = forms.map(function (form) {
      var heading = null;
      headings.forEach(function (h2) {
        if (h2.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING) {
          heading = h2;
        }
      });
      var question = {
        form: form, heading: heading, checklist: the.isChecklist(form),
        text: words(form.querySelector(".artifact-decision-text")),
        number: words(form.querySelector(".artifact-decision-number")),
      };
      question.fallback = radioOf(question, form.dataset.default || "") ? form.dataset.default : "";
      return question;
    });
    if (!questions.length) {
      return;
    }

    // The value of a decision's shown choice; "" when it has none.
    function shown(question) {
      var picked = question.form.querySelector('input[name="choice"]:checked');
      if (picked) {
        return picked.value;
      }
      var answer = the.saved(question.form);
      return answer ? String(answer.choice) : question.fallback;
    }

    function label(question, value) {
      var radio = radioOf(question, value);
      return radio ? the.optionText(radio) : value;
    }

    // {name, was, pending}: Open, Default or Changed, the "was" line, and
    // whether its shown choice, or its note, differs from its stored answer.
    function state(question) {
      var form = question.form;
      var answer = the.saved(form);
      if (question.checklist) {
        var now = the.ticked(form, "checked");
        var kept = the.same(now, the.ticked(form, "defaultChecked"));
        return {
          name: kept ? "Default" : "Changed", was: kept ? "" : the.summary(form, now),
          pending: !answer || the.dirty(form),
        };
      }
      var value = shown(question);
      var name = !value ? "Open" : value === question.fallback ? "Default" : "Changed";
      return {
        name: name,
        was: name !== "Changed" ? "" :
          "was: " + (question.fallback ? label(question, question.fallback) : "open"),
        pending: Boolean(value) && (!answer || String(answer.choice) !== value || the.dirty(form)),
      };
    }

    function opened(question) {
      return state(question).name === "Open";
    }

    // Where the title bar ends, in the window, as the comments panel reads it.
    function barBottom() {
      return Math.max(0, bar.getBoundingClientRect().bottom);
    }

    // Open a form's section if it is folded, as a row's "change" does, put
    // the form just below the title bar and focus its first option, or its
    // "change" when it is folded to its answer.
    function jump(form) {
      var wrapper = form.closest("div.artifact-section-body");
      if (wrapper && wrapper.hasAttribute("hidden")) {
        wrapper.dispatchEvent(new Event("beforematch"));
      }
      var top = form.getBoundingClientRect().top;
      window.scrollBy({ top: top - barBottom() - 16, left: 0, behavior: "instant" });
      var target = form.classList.contains("artifact-decision--saved") ?
        form.querySelector(".artifact-decision-saved .artifact-decision-change") :
        form.querySelector("input");
      if (target) {
        target.focus({ preventScroll: true });
      }
    }

    // The title bar's controls.
    var tools = element("div", "artifact-review-bar");
    var next = element("a", "artifact-review-next");
    next.href = "#";
    var nextQuestion = element("span", "artifact-review-next-question");
    var nextText = element("span", "artifact-review-next-text");
    nextText.append("Next open", nextQuestion);
    next.append(nextText, mute(element("span", "artifact-review-next-arrow", "↓")));
    var count = element("button", "artifact-review-count");
    count.type = "button";
    count.setAttribute("aria-expanded", "false");
    count.setAttribute("aria-controls", "artifact-review-panel");
    var countText = element("span");
    count.append(mute(element("span", "artifact-review-dot")), countText);
    tools.append(next, count);
    bar.appendChild(tools);

    // The question Next open jumps to last, by its place on the page.
    var last = -1;

    // The first open question after the last one jumped to, wrapping round.
    function upcoming() {
      for (var step = 1; step <= questions.length; step += 1) {
        var index = (last + step) % questions.length;
        if (opened(questions[index])) {
          return index;
        }
      }
      return -1;
    }

    next.addEventListener("click", function (event) {
      event.preventDefault();
      var index = upcoming();
      if (index >= 0) {
        last = index;
        jump(questions[index].form);
        refresh();
      }
    });

    // The marks on each h2 and outline link whose section asks open questions.
    var marks = new Map();

    function markOf(heading) {
      if (!marks.has(heading)) {
        var mark = { heading: element("span", "artifact-review-open"), link: null };
        mark.heading.hidden = true;
        heading.appendChild(mark.heading);
        var link = outline && heading.id &&
          outline.querySelector('a[href="#' + CSS.escape(heading.id) + '"]');
        if (link) {
          mark.link = element("span", "artifact-review-outline");
          mark.number = element("span", "artifact-review-outline-number");
          mark.link.append(mute(element("span", "artifact-review-dot")), mark.number,
            element("span", "artifact-review-hidden", " open"));
          mark.link.hidden = true;
          link.appendChild(mark.link);
        }
        marks.set(heading, mark);
      }
      return marks.get(heading);
    }

    // The panel.
    var panel = element("div", "artifact-review-panel");
    panel.id = "artifact-review-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-labelledby", "artifact-review-tally");
    panel.hidden = true;
    var head = element("header", "artifact-review-head");
    var tally = element("p", "artifact-review-tally");
    tally.id = "artifact-review-tally";
    var close = element("button", "artifact-review-close", "✕");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    head.append(tally, close);
    var list = element("div", "artifact-review-list");
    var foot = element("footer", "artifact-review-foot");
    var save = element("button", "artifact-review-save");
    save.type = "button";
    var outcome = element("p", "artifact-review-outcome");
    outcome.setAttribute("role", "status");
    foot.append(save, outcome);
    panel.append(head, list, foot);
    document.body.appendChild(panel);

    // One group per section asking a question, in page order; a question
    // before the first h2 is under the page's title.
    var groups = new Map();
    questions.forEach(function (question) {
      if (!groups.has(question.heading)) {
        var group = element("section", "artifact-review-group");
        group.appendChild(element("h3", "artifact-review-group-title", question.heading ?
          headingTitle(question.heading) : words(document.querySelector(".artifact-title"))));
        group.appendChild(element("ol", "artifact-review-entries"));
        list.appendChild(group);
        groups.set(question.heading, group);
      }
      groups.get(question.heading).querySelector("ol").appendChild(entry(question));
    });

    // Tell the form a pick moved it, as the reader's own pick would.
    function moved(input) {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }

    // A question's entry: its text, its options, and where it stands.
    function entry(question) {
      var item = element("li", "artifact-review-entry");
      item.dataset.question = question.form.dataset.question;
      var text = element("p", "artifact-review-question");
      if (question.number) {
        text.appendChild(element("span", "artifact-review-number", question.number));
        text.append(" ");
      }
      text.append(question.text);
      var options = element("div", "artifact-review-options");
      question.controls = [];
      if (question.checklist) {
        boxes(question.form).forEach(function (box) {
          var row = element("label", "artifact-review-item");
          var copy = element("input");
          copy.type = "checkbox";
          copy.addEventListener("change", function () {
            box.checked = copy.checked;
            moved(box);
          });
          row.append(copy, " ", the.optionText(box));
          options.appendChild(row);
          question.controls.push({ input: box, control: copy });
        });
      } else {
        radios(question.form).forEach(function (radio) {
          var button = element("button", "artifact-review-option", the.optionText(radio));
          button.type = "button";
          button.addEventListener("click", function () {
            radio.checked = true;
            moved(radio);
          });
          options.appendChild(button);
          question.controls.push({ input: radio, control: button });
        });
      }
      var standing = element("p", "artifact-review-standing");
      question.state = element("span", "artifact-review-state");
      question.was = element("span", "artifact-review-was");
      question.unsaved = element("span", "artifact-review-unsaved", "not saved");
      var show = element("a", "artifact-review-show", "Show on page");
      show.href = "#";
      show.addEventListener("click", function (event) {
        event.preventDefault();
        shut(false);
        jump(question.form);
      });
      standing.append(question.state, question.was, question.unsaved, show);
      item.append(text, options, standing);
      return item;
    }

    function plural(n, one, many) {
      return n + " " + (n === 1 ? one : many);
    }

    var saving = false;

    // Draw everything from the forms as they stand.
    function refresh() {
      var states = questions.map(state);
      var open = states.filter(function (s) { return s.name === "Open"; }).length;
      var changed = states.filter(function (s) { return s.name === "Changed"; }).length;
      var due = states.filter(function (s) { return s.pending; }).length;

      countText.textContent = (open ? open + " to answer" : "All answered") + " · Respond";
      count.classList.toggle("artifact-review-count--done", !open);
      var index = upcoming();
      next.hidden = index < 0;
      nextQuestion.textContent = index < 0 ? "" : ": " + questions[index].text;

      var opens = new Map();
      questions.forEach(function (question, at) {
        if (question.heading) {
          opens.set(question.heading, (opens.get(question.heading) || 0) +
            (states[at].name === "Open" ? 1 : 0));
        }
      });
      opens.forEach(function (n, heading) {
        var mark = markOf(heading);
        mark.heading.textContent = n ? n + " open" : "";
        mark.heading.hidden = !n;
        if (mark.link) {
          mark.number.textContent = n ? String(n) : "";
          mark.link.hidden = !n;
        }
      });

      tally.textContent = (open ? open + " to answer" : "All answered") + " · " +
        changed + " changed · " + questions.length + " in all";
      questions.forEach(function (question, at) {
        var s = states[at];
        question.controls.forEach(function (pair) {
          if (question.checklist) {
            pair.control.checked = pair.input.checked;
          } else {
            pair.control.setAttribute("aria-pressed", pair.input.value === shown(question) ? "true" : "false");
          }
        });
        question.state.textContent = s.name;
        question.state.className = "artifact-review-state artifact-review-state--" + s.name.toLowerCase();
        question.was.textContent = s.was;
        question.was.hidden = !s.was;
        question.unsaved.hidden = !s.pending;
      });
      save.textContent = saving ? "Saving…" :
        due ? "Save " + plural(due, "answer", "answers") : "Nothing new to save";
      save.disabled = saving || !due;
    }

    // Post each answer not stored, in page order, as its form's own Save
    // does; an open question has nothing to post.
    save.addEventListener("click", async function () {
      var due = questions.filter(function (question) { return state(question).pending; });
      saving = true;
      outcome.textContent = "";
      refresh();
      var failed = 0;
      for (var i = 0; i < due.length; i += 1) {
        var question = due[i];
        if (!question.checklist && !question.form.querySelector('input[name="choice"]:checked')) {
          radioOf(question, shown(question)).checked = true;
        }
        if (!(await the.save(question.form))) {
          failed += 1;
        }
      }
      saving = false;
      refresh();
      var open = questions.filter(opened).length;
      var stay = plural(open, "question stays", "questions stay") + " open.";
      var time = new Date().toLocaleTimeString(undefined, { timeStyle: "short" });
      if (failed === due.length) {
        outcome.textContent = "Nothing was saved: see each question's form. " + stay;
      } else {
        outcome.textContent = "Saved at " + time + ". " + stay +
          (failed ? " " + plural(failed, "answer was", "answers were") + " not saved." : "");
      }
    });

    function shut(refocus) {
      if (panel.hidden) {
        return;
      }
      panel.hidden = true;
      count.setAttribute("aria-expanded", "false");
      if (refocus) {
        count.focus();
      }
    }

    count.addEventListener("click", function () {
      if (!panel.hidden) {
        shut(true);
        return;
      }
      panel.hidden = false;
      count.setAttribute("aria-expanded", "true");
      close.focus();
    });
    close.addEventListener("click", function () { shut(true); });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !panel.hidden && !event.defaultPrevented) {
        shut(true);
      }
    });

    // A default picked once the answers are read, so the read never takes
    // the form for one the reader touched: for each form with no answer to
    // the question as the page now asks it, one to an earlier wording too.
    questions.forEach(function (question) {
      var form = question.form;
      if (question.fallback && !the.saved(form) &&
          !form.querySelector('input[name="choice"]:checked')) {
        var radio = radioOf(question, question.fallback);
        radio.checked = true;
        moved(radio);
      }
      form.addEventListener("change", refresh);
      form.addEventListener("input", refresh);
      form.addEventListener(SAVED, refresh);
    });
    refresh();
  }

  // Without the page's answers there is no telling what is answered: no
  // sheet, so no default is picked or saved over an answer.
  //
  // #question=ID, a link from the index's Recent activity: once the answers
  // are drawn, an answered form folded to its saved line, and again on each
  // hashchange, the form asking ID has its section opened if it is folded
  // and lands just under the title bar, as jump() places it, with or without
  // the sheet. A question the page does not ask leaves the page where it is.
  // A link followed before the answers are drawn is no reload's fragment,
  // and one after waits for every other hashchange listener, such as the
  // versions view's (js/versions.js), which may still hide the text.
  if (answering && forms.length) {
    var toQuestion = function (first) {
      var id = linkedTo("question", first);
      var form = forms.filter(function (each) { return each.dataset.question === id; })[0];
      if (!form) {
        return;
      }
      var wrapper = form.closest("div.artifact-section-body");
      if (wrapper && wrapper.hasAttribute("hidden")) {
        wrapper.dispatchEvent(new Event("beforematch"));
      }
      var bar = document.querySelector(".artifact-topbar");
      var under = bar ? Math.max(0, bar.getBoundingClientRect().bottom) : 0;
      window.scrollBy({ top: form.getBoundingClientRect().top - under - 16, left: 0, behavior: "instant" });
    };
    var drawnAnswers = false;
    var followed = false;
    window.addEventListener("hashchange", function () {
      followed = true;
      if (drawnAnswers) {
        setTimeout(function () { toQuestion(false); }, 0);
      }
    });
    document.addEventListener(ANSWERED, function () {
      if (answering.read) {
        reviewSheet(answering);
      }
      drawnAnswers = true;
      toQuestion(!followed);
    }, { once: true });
  }
