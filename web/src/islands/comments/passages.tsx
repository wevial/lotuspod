import { render } from "preact";
import { createPortal } from "preact/compat";
import type { Page, PassagesBridge, Thread, TextModel, PassageQuote } from "../bridge";
import type { Passages } from "./parts";
import { anchorOf } from "./anchor";

type OpenPassage = ReturnType<ReturnType<typeof import('./composer').composers>['passage']> & {
  box: HTMLElement;
  marks: HTMLElement[];
  quote: PassageQuote & { exact: string };
};

interface Selected { box: HTMLElement; start: number; tail: Range; quote: PassageQuote & { exact: string } }
function passageQuote(thread: Thread) {
  const anchor = anchorOf(thread.root);
  return anchor.kind === "passage" ? anchor.quote : null;
}
function quoteOf(thread: Thread): PassageQuote { return passageQuote(thread)!; }
// Highlights stay imperative: the author's text is never a Preact render root.
export function passages(page: Page, bridge: PassagesBridge): Passages {
  const { article, boxes, shown, resolved, revision, attached, composer, placement } = bridge;
  const { element, textModel, offsetOf, pieces, locate, wrap, unwrap } = page;
  const { apart: APART, maxExact: MAX_EXACT, context: CONTEXT, still: STILL, coarse: COARSE, archived: ARCHIVED } = page;
  var api = {} as Passages;
  var pointed: Record<"page" | "entry", Thread | null> = { page: null, entry: null };
  var open: OpenPassage | null = null;
  // Where a thread just posted from a selection starts in the page's
  // text, so its words are those selected even where they occur twice.
  var hints = new Map<number, number>();

  api.detached = function (thread) {
    return Boolean(passageQuote(thread)) && thread.spot === null && !resolved(thread);
  };

  // What a passage's entry and box say of its words: the quote, struck
  // through once the words are not found, and why.
  api.said = function (thread) {
    var exact = String(quoteOf(thread).exact || "");
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
    if (revision()) {
      node.title = "Changed in revision " + revision();
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
    var on = thread === pointed.page || thread === pointed.entry || placement().lit(thread);
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

  function find(model: TextModel, thread: Thread) {
    var exact = String(quoteOf(thread).exact || "");
    var hint = hints.get(thread.root.id);
    hints.delete(thread.root.id);
    if (hint !== undefined && model.text.slice(hint, hint + exact.length) === exact) {
      return { start: hint, end: hint + exact.length };
    }
    return locate(model, quoteOf(thread));
  }

  function draw(thread: Thread) {
    var id = String(thread.root.id);
    thread.marks = wrap(article, thread.spot!.start, thread.spot!.end, function () {
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
    for (var link = after.closest("a"); link && article!.contains(link); link = link.parentElement!.closest("a")) {
      after = link;
    }
    after.parentNode!.insertBefore(number, after.nextSibling);
    thread.number = number;
    api.shine(thread);
  }

  function erase(thread: Thread) {
    if (thread.number) {
      thread.number.remove();
      thread.number = null;
    }
    unwrap(thread.marks);
    thread.marks = [];
  }

  // Where a thread's section is in the page, those it no longer has last.
  function sectionAt(thread: Thread) {
    var at = thread.box ? boxes.indexOf(thread.box) : -1;
    return at < 0 ? boxes.length : at;
  }

  // Find each open passage thread not looked for yet, draw it or take a
  // resolved one away, and number them: those drawn in page order, then
  // those not found.
  api.update = function () {
    var threads: Thread[] = [];
    shown.forEach(function (thread) {
      if (passageQuote(thread)) {
        threads.push(thread);
      }
    });
    var model: TextModel | null = null;
    var found: Thread[] = [];
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
      return a.spot!.start - b.spot!.start || a.root.id - b.root.id;
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
      if (thread.number!.textContent !== String(thread.n)) {
        thread.number!.textContent = String(thread.n);
        thread.number!.setAttribute("aria-label", "Open comment " + thread.n);
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

  api.place = function () {
    if (!open) {
      return;
    }
    if (placement().wide) {
      placement().compose(open.box, open.holder);
    } else {
      placement().passage(open);
    }
  };

  // Close a composer if it is still open: its popover or sheet was.
  api.cancel = function (mine) {
    if (open === mine) {
      close(open);
    }
  };

  // The open composer's words, its section (and where its box is among
  // the page's), what is written in it and the images attached, to open
  // again after a reload (api.reopen); null when none is open. held
  // says whether it has images attached or on their way.
  api.writing = function () {
    return open ? {
      quote: open.quote, section: open.box.dataset.section, index: boxes.indexOf(open.box),
      text: open.field.value, images: attached.get(open.form)!.kept(),
      held: attached.get(open.form)!.held(),
    } : null;
  };

  // Open a composer again on the words kept, where the page still has
  // them, holding the text and images kept; false when it has them no
  // more, or when another composer is open: one the reader opened
  // since is never closed for it.
  api.reopen = function (kept) {
    if (open || ARCHIVED || !article || !kept.quote || typeof kept.quote.exact !== "string") {
      return false;
    }
    var model = textModel(article);
    var spot = locate(model, kept.quote);
    var runs = spot ? pieces(model, spot.start, spot.end) : [];
    var box = runs.length ? boxAfter(runs[0].node, runs[0].from) : null;
    if (!box || !spot) {
      return false;
    }
    const restored = compose({ box: box, start: spot.start, quote: { ...kept.quote, exact: kept.quote.exact } });
    restored.field.value = String(kept.text || "");
    var images = attached.get(restored.form)!;
    var over = kept.from ? kept.from.pass(images) : images.restore(kept.images);
    if (over) {
      restored.form.querySelector<HTMLElement>(".artifact-comment-status")!.textContent = over;
    }
    return true;
  };

  // A swap moved the page's text. A thread whose highlight went with a
  // part it took out, its marks wrapped into the old text and never
  // unwrapped, is looked for again in the new text, as is one not found
  // before: the new revision may have its words back. Each other drawn
  // thread's words start where its highlight now does, so the threads
  // number in page order. A hint is into the old text, so none is kept.
  api.moved = function () {
    var model: TextModel | null = null;
    shown.forEach(function (thread) {
      if (!passageQuote(thread)) {
        return;
      }
      if (thread.spot === null || (thread.marks.length && !thread.marks[0].isConnected)) {
        if (thread.number && thread.number.isConnected) {
          thread.number.remove();
        }
        thread.marks = [];
        thread.number = null;
        thread.spot = undefined;
      } else if (article && thread.spot && thread.marks.length) {
        model = model || textModel(article);
        var start = offsetOf(model, thread.marks[0], 0);
        thread.spot = { start: start, end: start + thread.spot!.end - thread.spot!.start };
      }
    });
    hints.clear();
  };

  api.writes = function (nodes) {
    return open !== null && open.marks.some(function (mark) {
      return nodes.some(function (node) { return node.contains(mark); });
    });
  };

  // The open composer whose words a swap took out, closed, with what
  // api.writing kept of it to open again (api.reopen), its box, and
  // the post it is sending, if any (saving: its row, or null when not
  // saved); else null. Its marks left with the old text, so they stay
  // as they are.
  api.swept = function () {
    if (!open || !open.marks.length || open.marks[0].isConnected) {
      return null;
    }
    var kept = api.writing()!;
    var mine = open;
    kept.from = attached.get(mine.form)!;
    kept.box = mine.box;
    kept.saving = mine.saving || null;
    mine.holder.remove();
    open = null;
    placement().dropped(mine);
    return kept;
  };

  if (!article) {
    return api;
  }

  function close(mine: OpenPassage) {
    mine.holder.remove();
    unwrap(mine.marks);
    if (open === mine) {
      open = null;
    }
    placement().dropped(mine);
  }

  // Whether a boundary point may be part of a passage: in the body, out
  // of everything APART.
  function inside(node: Node) {
    var parent = node instanceof Element ? node : node.parentElement;
    return parent !== null && article!.contains(parent) && !parent.closest(APART);
  }

  function boxAfter(node: Node, offset: number) {
    var point = document.createRange();
    point.setStart(node, offset);
    return boxes.filter(function (box) { return point.comparePoint(box, 0) > 0; })[0] || null;
  }

  // The passage the reader has selected, or null when it is not one a
  // comment can be on: 1 to MAX_EXACT characters of the page's text, all
  // in it and in one section, on a page that is not archived.
  function selected() {
    var selection = document.getSelection();
    if (ARCHIVED || !selection || !selection.rangeCount || selection.isCollapsed) {
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
    if (Array.from(article!.querySelectorAll(APART)).some(function (node) { return span.intersectsNode(node); })) {
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

  // The portal appends only the island's button; the body remains page-owned.
  const root = document.createElement("div");
  let pill!: HTMLButtonElement;
  render(createPortal(<button ref={node => { if (node) pill = node; }}
    class="artifact-passage-pill" type="button" tabIndex={-1} hidden
    aria-keyshortcuts="Control+Alt+M">
    <span class="artifact-passage-pill-icon" aria-hidden="true" />Comment
  </button>, document.body), root);

  // The pill just above the end of the selection, leaning left of it and
  // inside the reading column; on a touch screen, whose own menu takes
  // the room above, just below it.
  function offer(found: Selected) {
    var rects = found.tail.getClientRects();
    var line = rects[rects.length - 1];
    if (!line) {
      return;
    }
    pill.hidden = false;
    var width = pill.offsetWidth;
    var column = article!.getBoundingClientRect();
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
  var settling: ReturnType<typeof setTimeout> | undefined;
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
    pressed = !pill.contains(event.target as Node);
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

  function compose(found: Pick<Selected, "box" | "start" | "quote">) {
    if (open) {
      close(open);
    }
    pill.hidden = true;
    var handles = composer.passage(found.box, found.quote, function () { close(mine); }, function (row) {
      // A swap may have moved the marks or removed the quoted words.
      var start = marks.length && article!.contains(marks[0]) ?
        offsetOf(textModel(article), marks[0], 0) : null;
      if (open === mine) close(mine);
      if (start !== null) hints.set(row.id, start);
    });
    var field = handles.field;
    var marks = wrap(article, found.start, found.start + found.quote.exact.length, function () {
      return element("mark", "artifact-passage artifact-passage--pending");
    });
    var mine = Object.assign(handles, { marks: marks, box: found.box, quote: found.quote });
    open = mine;
    document.getSelection()?.removeAllRanges();
    api.place();
    field.focus({ preventScroll: true });
    return mine;
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

  function threadAt(node: EventTarget | null) {
    var drawn = node instanceof Element &&
      node.closest<HTMLElement>("mark.artifact-passage[data-thread], .artifact-passage-number");
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
    if (!(event.target as Element).closest(".artifact-passage-number") &&
        ((selection && !selection.isCollapsed) || (event.target as Element).closest("a"))) {
      return;
    }
    if (placement().wide) {
      placement().open(thread);
    } else {
      placement().show({ thread: thread }, (event.target as Element).closest("mark, .artifact-passage-number"));
    }
  });
  return api;
}
