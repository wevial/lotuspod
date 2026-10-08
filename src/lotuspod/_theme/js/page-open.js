// Lotuspod page script: answers a page's decision forms (form.artifact-decision),
// shows and posts the comments of its sections (details.artifact-comment) and
// folds each section (div.artifact-section-body) under its heading.
//
// For decisions it reads the page's answers, folds each question answered as
// the page now asks it to one saved line with a "change" button, marks a
// choice or note not yet saved, and posts the reader's answer when a form is
// submitted. Once any question is answered, the page ends in an "Answered"
// table (div.artifact-answered), one row per answered question, newest first,
// each with a "change" that opens its card while the page asks it as it was
// answered, folded under its heading as a section is. On a page that takes
// comments each form also has an Ask, which posts its note as a question
// thread on the decision, and once the decision has threads a chip under it
// opens them as a section's chip does. For
// comments it reads the page's threads, draws each in its section's box as a
// chat (the reader's comments on the right, agents' replies on the left, each
// state as its own mark outside what anyone wrote), and posts new threads and
// replies. While a thread waits for an agent and the page is seen, it reads
// the threads again, less often while nothing changes, and draws what is new
// in place. Each box's summary becomes a one-line chip that opens its
// section's thread, and a thread can be resolved and reopened. Where the
// window has room right of the reading column, the threads live in a side
// panel (aside.artifact-comments-panel) folded to a rail of status dots;
// without that room a thread opens over the text, in a popover under what
// opened it (div.artifact-comments-popover), or on a phone in a bottom sheet
// (div.artifact-comments-bottom-sheet) that steps through the page's threads.
// A top-level table is kept short of the panel, open or folded.
// One that scrolls, where the window has free width beside it, can be
// expanded into that width, up to the panel.
// Words selected in the body can be commented on: a pill by the selection
// opens a composer, and each thread on a passage highlights its words with a
// number, found again from its quote on every revision of the page. It
// sends no credential of its own: the reader's Cloudflare Access session is
// the only identity. Everything anyone wrote is set as text, never as markup.
(function () {
  "use strict";

  var ANSWERS = "/api/answers";
  var COMMENTS = "/api/comments";
  var SIGNED_OUT = "You are signed out. Reload the page to sign in.";
  var STALE = "This question has changed since the page loaded. Reload it.";
  var STALE_PAGE = "This page has changed since it loaded. Reload it to comment on this passage.";
  var STALE_QUESTION = "This page has changed since it loaded. Reload it to ask about this decision.";
  var NO_QUESTION = "Write your question in the note, then press Ask.";
  var PASSAGE_GONE = "The words you selected have changed since. Your comment is kept here, on the section.";
  var PLACE_GONE = "Where you were writing has changed since. Your text is kept here.";
  var CHANGED = "Comments on sections that have changed";
  var CHANGED_GROUP = "Sections that have changed";
  // Whether the reader left the comments panel open or folded.
  var PANEL = "lotuspod:comments-panel";
  // Whether the reader shows the panel's resolved threads, kept for the
  // session under this and the page's path.
  var RESOLVED_SHOWN = "lotuspod:resolved-shown:";
  // The room the panel needs right of the reading column, in rem.
  var ROOM = 21;
  // Without that room, the narrowest window a popover opens in; narrower,
  // a thread opens in a bottom sheet.
  var POPOVER = "(min-width: 700px)";
  // Where the primary pointer is a finger, the pill sits below the selection.
  var COARSE = "(pointer: coarse)";
  // Each page's folded sections are kept under this and its path, the
  // Answered table among them as FOLDED_ANSWERED: a number, where a section is
  // kept as its id, a string, so no authored heading's id can be taken for it.
  var SECTIONS = "lotuspod:folded:";
  var FOLDED_ANSWERED = 0;
  // Sent on a comment box when rows are drawn into it, and on the document
  // once the page's read of answers has finished.
  var DRAWN = "lotuspod:drawn";
  var ANSWERED = "lotuspod:answered";
  // What the page's text leaves out and no passage may hold: the comment UI,
  // decision forms and their chips, the Answered table, diagrams and the list
  // of changed sections.
  var APART = "details.artifact-comment, .artifact-comments-changed, .artifact-comments-panel, " +
    ".artifact-comments-popover, .artifact-comments-bottom-sheet, .artifact-passage-composer, " +
    "form.artifact-decision, .artifact-decision-chip, .artifact-answered, pre.mermaid, svg";
  // What the page's text leaves out as never read: the marks and numbers the
  // page script draws, and what is not shown at all.
  var UNSEEN = "script, style, template, noscript, .artifact-section-mark, .artifact-passage-number, " +
    ".artifact-table-expand";
  var BLOCK = new RegExp("^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|BR|CAPTION|DD|DETAILS|DIV|DL|DT|" +
    "FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|" +
    "SUMMARY|TABLE|TBODY|TD|TFOOT|TH|THEAD|TR|UL)$");
  // A passage's length and the words kept either side of it, in code
  // points, as the comments route counts them.
  var MAX_EXACT = 500;
  var CONTEXT = 32;
  // How long the selection must keep still before the pill shows, in ms.
  var STILL = 200;

  function when(stamp) {
    var date = new Date(stamp);
    if (isNaN(date.getTime())) {
      return String(stamp);
    }
    return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }

  // A reader's name, else a handle; never an address.
  function reader(row) {
    var actor = row && row.actor;
    if (actor && actor.name) {
      return String(actor.name);
    }
    return actor && actor.handle ? String(actor.handle) : "someone";
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

  // Whitespace of any kind, a no-break or thin space as much as a newline:
  // the text and the quotes found in it collapse the same runs.
  var WHITE = /\s/;
  var WHITE_RUNS = /\s+/g;

  // The page's text, from which a passage is anchored and found again: the
  // text nodes of root in document order, leaving out APART and UNSEEN, with
  // the start of each block element as one space and every run of whitespace
  // as one space. spots.get(node)[k] is the text's length before the node's
  // character k; a character that adds nothing (whitespace in a run) has the
  // same spot as the one after it.
  function textModel(root) {
    var model = { text: "", nodes: [], spots: new Map() };
    var parts = [];
    var length = 0;
    // True while the text is empty or ends in a space.
    var space = true;
    var skip = APART + ", " + UNSEEN;
    function walk(parent) {
      for (var child = parent.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === Node.TEXT_NODE) {
          var data = child.data;
          var spots = new Int32Array(data.length + 1);
          var out = "";
          for (var k = 0; k < data.length; k += 1) {
            spots[k] = length;
            if (!WHITE.test(data.charAt(k))) {
              out += data.charAt(k);
              length += 1;
              space = false;
            } else if (!space) {
              out += " ";
              length += 1;
              space = true;
            }
          }
          spots[data.length] = length;
          parts.push(out);
          model.nodes.push(child);
          model.spots.set(child, spots);
        } else if (child.nodeType === Node.ELEMENT_NODE && !child.matches(skip)) {
          if (BLOCK.test(child.tagName) && !space) {
            parts.push(" ");
            length += 1;
            space = true;
          }
          walk(child);
        }
      }
    }
    if (root) {
      walk(root);
    }
    model.text = parts.join("");
    return model;
  }

  // Where in a model's text a boundary point falls: at the first of its
  // text nodes the point is not after.
  function offsetOf(model, container, offset) {
    var spots = model.spots.get(container);
    if (spots) {
      return spots[Math.min(offset, spots.length - 1)];
    }
    var point = document.createRange();
    point.setStart(container, offset);
    var low = 0;
    var high = model.nodes.length;
    while (low < high) {
      var middle = (low + high) >> 1;
      if (point.comparePoint(model.nodes[middle], 0) >= 0) {
        high = middle;
      } else {
        low = middle + 1;
      }
    }
    return low < model.nodes.length ? model.spots.get(model.nodes[low])[0] : model.text.length;
  }

  // The runs of text nodes that hold text[start, end) of a model, in order:
  // each {node, from, to}, without whitespace in a run before start.
  function pieces(model, start, end) {
    var found = [];
    model.nodes.forEach(function (node) {
      var spots = model.spots.get(node);
      if (spots[spots.length - 1] <= start || spots[0] >= end) {
        return;
      }
      var from = -1;
      var to = -1;
      for (var k = 0; k + 1 < spots.length; k += 1) {
        var said = spots[k + 1] > spots[k];
        if (spots[k] < end && (said ? spots[k] >= start : spots[k] > start)) {
          if (from < 0) {
            from = k;
          }
          to = k + 1;
        }
      }
      if (from >= 0) {
        found.push({ node: node, from: from, to: to });
      }
    });
    return found;
  }

  // Of a model's occurrences of a quote's words, the one between its prefix
  // and suffix when it is the only such one, else the only one; null when
  // there is none or more than one to choose between.
  function locate(model, quote) {
    var squeeze = function (words) { return String(words || "").replace(WHITE_RUNS, " "); };
    var exact = squeeze(quote.exact).trim();
    var prefix = squeeze(quote.prefix);
    var suffix = squeeze(quote.suffix);
    var text = model.text;
    if (!exact) {
      return null;
    }
    var hits = [];
    for (var at = text.indexOf(exact); at >= 0; at = text.indexOf(exact, at + 1)) {
      hits.push(at);
    }
    var framed = hits.filter(function (hit) {
      return text.slice(0, hit).endsWith(prefix) && text.startsWith(suffix, hit + exact.length);
    });
    var hit = framed.length === 1 ? framed[0] : hits.length === 1 ? hits[0] : -1;
    return hit < 0 ? null : { start: hit, end: hit + exact.length };
  }

  // Wrap text[start, end) of the root's text in elements make() returns,
  // one around each run of a text node, split at the passage's edges and
  // never across an element. A run of whitespace beside a block is left out:
  // drawn, it would take a line of its own. The wrappers, in order.
  function wrap(root, start, end, make) {
    var made = [];
    pieces(textModel(root), start, end).forEach(function (piece) {
      var node = piece.node;
      // A passage starts and ends in words, so a run of whitespace is a
      // whole text node.
      if (!/\S/.test(node.data) && [node.previousSibling, node.nextSibling].some(function (side) {
        return !side || BLOCK.test(side.nodeName);
      })) {
        return;
      }
      if (piece.to < node.length) {
        node.splitText(piece.to);
      }
      if (piece.from > 0) {
        node = node.splitText(piece.from);
      }
      var wrapper = make();
      node.parentNode.insertBefore(wrapper, node);
      wrapper.appendChild(node);
      made.push(wrapper);
    });
    return made;
  }

  // Take wrappers away, leaving what they held where they were.
  function unwrap(wrappers) {
    wrappers.forEach(function (wrapper) {
      var parent = wrapper.parentNode;
      if (!parent) {
        return;
      }
      while (wrapper.firstChild) {
        parent.insertBefore(wrapper.firstChild, wrapper);
      }
      parent.removeChild(wrapper);
      parent.normalize();
    });
  }

  // The page's sections (div.artifact-section-body, each just after its h2):
  // each heading's text becomes a button that folds its section away with
  // hidden="until-found", so find-in-page and a text fragment still reach it
  // and open it. A link to a heading or to anything in a folded section opens
  // it. What the reader folded is kept per page in localStorage, when the
  // browser lets the page keep anything. A folded heading's button ends in a
  // mark saying what waits in its section: the comments and replies drawn
  // into its box while it was folded, and its questions with no saved answer.
  // What it returns folds a later heading and body the same way, as the
  // Answered table does once it is drawn.
  function foldSections(wrappers) {
    var key = SECTIONS + location.pathname;
    var sections = [];
    // False until the page's read of answers has finished.
    var answered = false;
    var kept = [];
    try {
      kept = JSON.parse(localStorage.getItem(key) || "[]");
    } catch (ignored) {
      kept = [];
    }
    if (!Array.isArray(kept)) {
      kept = [];
    }

    function freeId(base) {
      var id = base;
      for (var n = 2; document.getElementById(id); n += 1) {
        id = base + "-" + n;
      }
      return id;
    }

    // Fold wrapper under heading's button, kept as id; the section, or null
    // when its heading holds a link.
    function add(heading, wrapper, id) {
      if (!wrapper.id) {
        wrapper.id = freeId(id === FOLDED_ANSWERED ? "artifact-answered-body" : "section-body-" + id);
      }
      // A button may not hold a link: such a section stays open.
      if (heading.querySelector("a")) {
        return null;
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
        id: id, heading: heading, wrapper: wrapper, button: button, mark: mark, fresh: 0,
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
      return section;
    }

    wrappers.forEach(function (wrapper) {
      var heading = wrapper.previousElementSibling;
      if (heading && heading.tagName === "H2") {
        add(heading, wrapper, wrapper.dataset.section);
      }
    });

    function folded(section) {
      return section.wrapper.hasAttribute("hidden");
    }

    function drawn(id) {
      return sections.some(function (section) { return section.id === id; });
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
        // The Answered table is drawn once the answers are read: until then
        // its kept fold stays kept.
        if (!drawn(FOLDED_ANSWERED) && kept.indexOf(FOLDED_ANSWERED) >= 0) {
          ids.push(FOLDED_ANSWERED);
        }
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

    // The outline's control, once there is a section to fold.
    var every = null;
    var outline = document.querySelector("nav.artifact-outline");

    function label() {
      if (!every && outline && sections.length) {
        every = element("button", "artifact-sections-all");
        every.type = "button";
        outline.appendChild(every);
        every.addEventListener("click", function () {
          var fold = sections.some(function (section) { return !folded(section); });
          // While the answers are being read, the Answered table still to be
          // drawn is drawn as this leaves the rest.
          if (!answered && !drawn(FOLDED_ANSWERED)) {
            kept = kept.filter(function (id) { return id !== FOLDED_ANSWERED; });
            if (fold) {
              kept.push(FOLDED_ANSWERED);
            }
          }
          change(sections, fold);
        });
      }
      if (every) {
        every.textContent = sections.every(folded) ? "Expand all" : "Collapse all";
      }
    }

    var restored = false;
    sections.forEach(function (section) {
      if (kept.indexOf(section.id) >= 0) {
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

    // A later section, folded if the reader left it folded or folded all
    // before it was drawn.
    return function (heading, wrapper, id) {
      var section = add(heading, wrapper, id);
      if (section && kept.indexOf(id) >= 0) {
        set(section, true);
      }
      label();
    };
  }

  var foldSection = foldSections(all("div.artifact-section-body"));
