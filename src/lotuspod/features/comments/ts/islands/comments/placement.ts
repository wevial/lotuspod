import type { Page, Thread, PlacementBridge } from "../bridge";
import type { Placement, Group, Taken, Mode } from "./parts";
import { shell as makeShell } from "./shell";
import { threadList as makeThreadList } from "./thread-list";
import { anchorOf as threadAnchor, blockTitle, frameOf } from "./anchor";
import { chips as makeChips } from "./chips";
import { pins as makePins } from "./pins";
import { barBottom, modeOf, unfold } from "./room";
import { decisionsTab, opensIn, sheetTabs } from "./tabs";
import { effect, untracked } from "@preact/signals";

// Placement owns no thread rendering: movable nodes stay in their existing
// independent roots, while narrow.js owns the popover and sheet surfaces.
export function placement(page: Page, bridge: PlacementBridge): Placement {
  const { boxes, shown, forms, sections, passages, resolved, decisionOf,
    threadsOf, routed, looked, refresh, showUnread, changed } = bridge;
  var api = { wide: false, mode: null } as Placement;
  var arranged = false;
  // While the threads move to another layout (api.arrange), none opens
  // or closes: one open in the old place is open in the new.
  var moving = false;

  var shell = makeShell(page, {
    opened: function () {
      if (threadList.current) {
        threadList.draw(threadList.current);
      }
      showUnread();
    },
    resolvedChanged: function () {
      if (!shell.resolvedShown() && threadList.current && threadList.current === threadList.toRead && resolved(threadList.current)) {
        threadList.expand(null);
      }
      api.refresh();
    },
    compose: function (box) {
      if (groups.has(box)) {
        threadList.compose(groups.get(box)!, true);
      }
    },
  });

  var threadList = makeThreadList(page, shell, {
    ...bridge,
    wide: function () { return api.wide; },
    moving: function () { return moving; },
    holds: function (thread) { return over.holds(thread); },
    uncover: function (node) { over.uncover(node); }, bring: bring,
  });
  var groups = threadList.groups;
  var chips = makeChips(page, { ...bridge, list: threadList, chipped, reach });
  boxes.forEach(chips.mount);
  var pins = makePins({ shown, resolved, reach: function (thread, opener) { reach(thread, opener, false); } });
  api.refresh = function () {
    threadList.refresh();
    chips.refresh();
    pins.refresh();
    over.sync();
  };

  function mount(box: HTMLElement, at: number) {
    threadList.mount(box, at);
    chips.mount(box);
    if (arranged) house(box);
  }

  // A detached passage falls back to its section chip, as a thread on a
  // live block the page no longer has does.
  function anchorOf(thread: Thread): HTMLElement | null {
    const anchor = threadAnchor(thread.root);
    switch (anchor.kind) {
      case "passage": return thread.marks[0] || chips.anchor(thread);
      case "block": return (thread.box && frameOf(anchor.id)?.closest("figure")) || chips.anchor(thread);
      case "decision":
      case "page":
      case "section": return chips.anchor(thread);
      default: { const never: never = anchor; return never; }
    }
  }

  function blockOf(thread: Thread) {
    const anchor = threadAnchor(thread.root);
    return anchor.kind === "block" ? { title: blockTitle(anchor), state: anchor.state } : null;
  }

  // Bring a thread's highlight, else its chip, into the window, opening
  // its section first if it is folded.
  function bring(thread: Thread) {
    var target = anchorOf(thread);
    if (!target) {
      return;
    }
    unfold(target);
    var rect = target.getBoundingClientRect();
    if (rect.top < barBottom() || rect.bottom > window.innerHeight) {
      target.scrollIntoView({ block: "center" });
    }
  }

  // A thread opened from outside its entry: in a popover under opener or
  // in the sheet; in the panel as a highlight opens it, or, resolved,
  // listed with the resolved threads and its entry in view. With read, a
  // resolved thread is also opened to read, as its dashed line opens it.
  function reach(thread: Thread, opener: HTMLElement | null, read: boolean) {
    if (!api.wide) {
      over.show({ thread: thread }, opener);
      if (read && resolved(thread)) {
        threadList.toRead = thread;
        threadList.expand(thread);
      }
    } else if (resolved(thread)) {
      shell.setOpen(true, true);
      shell.setResolvedShown(true, true);
      if (read) {
        threadList.toRead = thread;
        threadList.expand(thread);
      }
      api.refresh();
      threadList.reveal(thread.entry!.item);
      thread.entry!.reopen.focus({ preventScroll: true });
    } else {
      api.open(thread);
    }
  }

  // A link to a thread (#thread=ID): it opens as its highlight, else its
  // chip, would open it, a resolved one opened to read. Already open in
  // view, its replies since are seen, as on opening it, and its entry is
  // brought into the panel's view.
  api.reach = function (thread) {
    if (thread.lit) {
      looked(thread, true);
      if (api.wide) {
        threadList.reveal(thread.entry!.item);
      }
      return;
    }
    reach(thread, anchorOf(thread), true);
  };

  // A thread just asked about a decision: its entry opens in the panel,
  // else it opens in a popover under the decision's chip or in the sheet.
  api.asked = function (thread) {
    if (!thread) {
      return;
    }
    if (api.wide) {
      api.open(thread);
    } else {
      over.show({ thread: thread }, anchorOf(thread));
    }
  };

  // The box's form for a new thread posted one: the form folds, and in
  // the panel the new thread's entry opens; a popover shows it among its
  // section's threads, and the sheet moves on to it.
  api.posted = function (box, thread) {
    if (!thread) {
      return;
    }
    var made = groups.get(box)!;
    var focused = made.holder.contains(document.activeElement)
      || document.activeElement === document.body;
    threadList.compose(made, false);
    if (api.wide) {
      threadList.expand(thread);
      if (focused) {
        thread.entry!.head.focus({ preventScroll: true });
      }
      return;
    }
    over.posted(thread, focused);
  };

  // A decision's open threads, newest by its newest reader comment, which
  // opens as the decision's chip opens it.
  api.about = function (question) {
    var threads = [...shown.values()].filter(function (thread) {
      return !resolved(thread) && decisionOf(thread)?.form.dataset.question === question;
    });
    var newest = threadList.latest(threads);
    if (!newest) {
      return null;
    }
    return {
      count: threads.length,
      standing: threadList.standing(newest),
      open: function () { reach(newest!, null, false); },
    };
  };

  api.open = function (thread) {
    shell.setOpen(true, true);
    threadList.expand(thread);
    thread.entry!.head.focus({ preventScroll: true });
  };

  // A live block's Comment: its section's form opens in the panel, else
  // in a popover under opener or in the sheet.
  api.write = function (box, opener) {
    if (api.wide) {
      shell.setOpen(true, true);
    } else {
      over.show({ box: box }, opener);
      // The same Comment again closes its popover.
      if (!over.peek().view) {
        return;
      }
    }
    threadList.compose(groups.get(box)!, true);
  };

  // A passage's composer: in its section's group, above the threads, with
  // the panel open.
  api.compose = function (box, holder) {
    shell.setOpen(true, true);
    var made = groups.get(box)!;
    made.node.insertBefore(holder, made.entries);
    threadList.tidy();
    threadList.reveal(holder);
  };

  // A thread was posted from a passage's composer: its entry opens, or
  // it opens in a popover under its words or in the sheet.
  api.started = function (thread, focused) {
    if (!thread) {
      return;
    }
    if (api.wide) {
      threadList.expand(thread);
      if (focused) {
        thread.entry!.head.focus({ preventScroll: true });
      }
      return;
    }
    over.started(thread, focused);
  };

  // A chip: the panel opens at its section's newest open thread, or at
  // its form for a new one, which an archived page has none of.
  function show(box: HTMLElement) {
    shell.setOpen(true, true);
    var newest = threadList.latest(threadList.unresolvedOf(box));
    if (newest) {
      threadList.expand(newest);
      newest.entry!.head.focus({ preventScroll: true });
    } else if (!page.archived) {
      threadList.compose(groups.get(box)!, true);
    }
  }

  // A chip opens its section's threads in the panel, a popover or the
  // sheet, never in its box.
  function chipped(box: HTMLElement) {
    if (api.wide) {
      show(box);
    } else {
      over.chip(box);
    }
  }

  // Show a thread where it belongs: its entry in its group, or in the
  // popover or sheet holding it, with its node in the entry; without
  // the panel, a thread on a section the page no longer has is in the
  // list at the end of the body unless it is held.
  api.put = function (thread) {
    var made = threadList.entry(thread);
    var keep = over.holds(thread);
    if (!api.wide && !thread.box && !keep) {
      var listed = changed();
      if (thread.node.parentNode !== listed) {
        listed.appendChild(thread.node);
      }
    } else if (thread.node.parentNode !== made.body) {
      made.body.appendChild(thread.node);
    }
    if (keep) {
      if (made.item.parentNode !== over.entries()) {
        over.entries()!.appendChild(made.item);
      }
    } else {
      var target = thread.box ? groups.get(thread.box)! : threadList.strays;
      if (made.item.parentNode !== target.entries) {
        target.entries.appendChild(made.item);
        threadList.sort(target);
      }
    }
    threadList.draw(thread);
    threadList.strays.node.hidden = !threadList.showing(threadList.strays);
  };

  // Without room for the panel, one thing at a time opens over the text,
  // in a popover or the bottom sheet (overText in js/narrow.js).
  var over = page.overText({
    comments: true, tabs: sheetTabs, panel: api, groups: groups, passages: passages, mute: chips.mute,
    compose: threadList.compose, threadsOf: threadsOf, unresolvedOf: threadList.unresolvedOf, resolved: resolved,
    ordered: threadList.ordered,
    latest: threadList.latest, standing: threadList.standing, routed: routed, asked: threadList.asked, said: threadList.said, tick: threadList.tick,
    title: threadList.title, opening: threadList.opening, anchorOf: anchorOf, unfold: unfold, barBottom: barBottom,
    decisionOf: decisionOf, standsFor: standsFor, blockOf: blockOf,
  });
  // The sheet's tabs follow the questions to answer.
  effect(() => {
    decisionsTab.asks.value;
    decisionsTab.count.value;
    untracked(over.sync);
  });
  api.show = over.show;
  api.passage = over.passage;
  api.dropped = function (mine) {
    over.dropped(mine);
    threadList.tidy();
  };

  // The box that now stands for box's section: box, the box a swap
  // replaced it with, or null when the page no longer has it.
  function standsFor(box: HTMLElement) {
    return groups.has(box) ? box : sections.get(box.dataset.section!) || null;
  }

  api.lit = function (thread) {
    return (api.wide && threadList.current === thread) || over.holds(thread);
  };

  // What the open panel shows, to open again in a popover or the sheet
  // (over.restore) when the window narrows: a section's form being
  // written in, else the open entry's thread. A passage's composer is
  // placed by its own (passages.place).
  function opened(): Taken {
    var none = { view: null, opener: null, anchor: null, writing: null };
    if (!shell.isOpen()) {
      return none;
    }
    var writing: Group | null = null;
    for (const made of groups.values()) {
      if (made.holder && !made.holder.hidden) {
        writing = made;
      }
    }
    if (writing) {
      var chipNode = writing.box!.querySelector("summary");
      return { view: { box: writing.box! }, opener: chipNode, anchor: chipNode, writing: writing };
    }
    if (threadList.current && (!resolved(threadList.current) || threadList.current === threadList.toRead)) {
      var anchor = anchorOf(threadList.current);
      return { view: { thread: threadList.current }, opener: anchor, anchor: anchor, writing: null };
    }
    return none;
  }

  // A box's form for a new thread lives in its group's holder, never in
  // the box, which stays closed.
  function house(box: HTMLElement) {
    (box as HTMLDetailsElement).open = false;
    var holder = groups.get(box)!.holder;
    holder.insertBefore(forms.get(box)!, holder.firstChild);
  }

  // Show the threads in the panel, or else open them in a popover or the
  // sheet, as the window allows. What is open moves to the new place.
  api.arrange = function () {
    var mode: Mode = modeOf(page);
    if (arranged && mode === api.mode) {
      over.refit();
      return;
    }
    if (!arranged) {
      boxes.forEach(house);
    }
    arranged = true;
    moving = true;
    // Moving a field takes its focus away: it is given back after.
    var focused = document.activeElement;
    var taken = api.wide ? opened() : over.take();
    var view = taken.view;
    var writing = taken.writing;
    api.mode = mode;
    api.wide = mode === "panel";
    shell.hidden(!api.wide);
    over.mode(mode);
    decisionsTab.opens.value = opensIn(api.wide, shell.decide, over.decisions);
    var old = document.querySelector<HTMLElement>(".artifact-comments-changed");
    if (old) {
      old.hidden = api.wide;
    }
    shown.forEach(api.put);
    refresh();
    if (!api.wide) {
      over.restore(taken);
    } else if (view && view.thread) {
      shell.setOpen(true, false);
      threadList.expand(view.thread);
    } else if (writing) {
      shell.setOpen(true, false);
    } else if (view && view.decisions) {
      shell.setOpen(true, false, "decisions");
    }
    if (writing) {
      threadList.compose(writing, true);
    }
    // In its new place, a thread opens or closes as it now stands.
    moving = false;
    refresh();
    passages.place();
    if (focused instanceof HTMLElement && focused !== document.body && focused.isConnected && document.activeElement !== focused) {
      focused.focus({ preventScroll: true });
    }
  };

  // What is open, to open again after a reload (api.reopen): a thread by
  // its first comment's id, or a section and whether its form is being
  // written in; null for nothing, or a passage's composer.
  api.held = function () {
    var taken = api.wide ? opened() : over.peek();
    var view = taken.view;
    if (view && view.thread) {
      return { thread: view.thread.root.id };
    }
    if (view && view.box) {
      return { section: view.box.dataset.section, writing: Boolean(taken.writing) };
    }
    return null;
  };

  api.reopen = function (kept) {
    var thread = kept.thread === undefined ? undefined : shown.get(kept.thread);
    var box = typeof kept.section === "string" ? sections.get(kept.section) : null;
    var view = thread && !resolved(thread) ? { thread: thread } : box ? { box: box } : null;
    if (!view) {
      return;
    }
    var writing = view.box && kept.writing && !page.archived ? groups.get(view.box)! : null;
    if (api.wide) {
      shell.setOpen(true, false);
      if (view.thread) {
        threadList.expand(view.thread);
      }
    } else {
      var anchor = view.thread ? anchorOf(view.thread) : view.box.querySelector("summary");
      over.restore({ view: view, opener: anchor, anchor: anchor, writing: writing });
    }
    if (writing) {
      threadList.compose(writing, true);
    }
  };

  // A swap is about to change the boxes olds: what a popover or the
  // sheet holds on one of them is taken (over.take), to open again once
  // they have changed (api.give). Until then no thread opens or closes.
  api.take = function (olds) {
    moving = true;
    if (api.wide) {
      return null;
    }
    var held = over.peek();
    var view = held.view;
    if (!view || view.passage) {
      return null;
    }
    var on = view.box || (view.thread && view.thread.box);
    var gone = held.anchor && !held.anchor.isConnected;
    return (on && olds.indexOf(on) >= 0) || gone ? over.take() : null;
  };

  // The swap has changed the boxes: what api.take took opens again where
  // it was (over.restore), on the box that replaced its own, and a form
  // being written in stays open.
  api.give = function (taken) {
    if (taken && taken.view) {
      taken.still = true;
      over.restore(taken);
      if (taken.writing && groups.get(taken.writing.box!) === taken.writing && over.peek().view) {
        threadList.compose(taken.writing, true);
      }
    }
    moving = false;
  };

  // The box old is replaced by box, which takes its place among the
  // boxes: old's group and option are box's, its title drawn from its
  // new heading.
  api.replace = function (old, box) {
    threadList.replace(old, box);
    chips.mount(box);
    shell.unlit();
  };

  api.unmount = function (old, at) {
    var made = groups.get(old)!;
    groups.delete(old);
    made.node.remove();
    threadList.shellSections();
    shell.unlit();
  };

  // A decision form a swap took away: its chip went with its section.
  api.forget = function (form) {
    chips.forget(form);
  };

  api.mount = function (box, at) {
    mount(box, at);
    shell.unlit();
  };

  // Once the boxes have changed: the groups in page order, and the box
  // for the whole page as it now stands.
  api.remounted = function () {
    var made = boxes.map(function (box) { return [box, groups.get(box)!] as const; });
    groups.clear();
    made.forEach(function (pair) { groups.set(pair[0], pair[1]); });
    threadList.shellSections();
  };

  window.addEventListener("resize", api.arrange);
  return api;
}

