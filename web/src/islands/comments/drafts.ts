import type { Attachments, Page, Swapped, Widget } from "../bridge";
import { blockStanding } from "./anchor";
import type { Kept, PassageDraft, Store } from "./parts";
import { store as makeStore } from "./store";

// A composer's text and images not sent, as kept over a reload or a swap:
// its thread, or its section and where the section's box is among the
// page's; the live block a section's form was on; why its place is gone,
// once it is (what its form is to say). What a reload kept is the page's
// storage, so each field is checked as it is read.
interface Draft extends PassageDraft {
  thread?: unknown;
  widget?: unknown;
  why?: unknown;
}
// What save() keeps for a reload.
interface Saved { open?: unknown; passage?: unknown; texts?: unknown }
// A composer of a section's form or a thread's reply.
interface Composing {
  thread?: number;
  section?: string;
  index: number;
  widget?: Widget;
  field: HTMLTextAreaElement;
  images: Attachments;
}

// A page with section boxes also takes threads on the whole page, section
// WHOLE_PAGE. Its box is served under the title, first among the boxes so
// its threads are listed first. Older pages need a copy of the first box.
// A page whose only box is "page" has its box for the whole page already.
export function pageBox(page: Page, boxes: HTMLElement[]): HTMLElement[] {
  if (boxes[0].dataset.section === page.wholePage &&
      (boxes[0].parentNode as Element).matches("header.artifact-header")) {
    return boxes;
  }
  const meta = document.querySelector("header.artifact-header .artifact-meta");
  const sectioned = boxes.some(box => box.dataset.section !== "page");
  if (!meta || !sectioned) return boxes;
  const box = boxes[0].cloneNode(true) as HTMLDetailsElement;
  box.open = false;
  box.dataset.section = page.wholePage;
  box.querySelector(".artifact-comment-threads")!.replaceChildren();
  const form = box.querySelector<HTMLFormElement>("form.artifact-comment-form")!;
  form.reset();
  const field = form.elements.namedItem("text") as HTMLTextAreaElement;
  field.textContent = "";
  field.setAttribute("aria-label", "Comment on this page");
  box.querySelector(".artifact-comment-status")!.textContent = "";
  meta.parentNode!.insertBefore(box, meta.nextSibling);
  return [box, ...boxes];
}

// The comment boxes (lotuspod.comments): one per section, or one for the
// page. The threads, the reads that fill them, the replies to the reader
// and the decisions' Ask are the store's (comments/store.ts); this keeps
// what is kept over a reload and swaps, and reaches the threads through the
// store.
export function drafts(page: Page, boxes: HTMLElement[]): void {
  const { live } = page;
  // The page's decision forms, in page order.
  const decisions = page.all("form.artifact-decision[data-question]") as HTMLFormElement[];

  const store: Store = makeStore(page, { boxes, decisions, restore, boxWith });
  const { sections, shown, forms, attached, refresh } = store;
  const { fieldOf, handles, on, unblock } = store.composer;

  // Each composer of a section's form or a thread's reply, with what it
  // is kept by over a reload: its thread, its section and where the
  // section's box is among the page's (for a section a swap holds back
  // as it takes it away, where it was then, as a swap's Update keeps),
  // and the live block a section's form is on.
  function placeOf(box: HTMLElement): number {
    return takenAt.has(box) ? takenAt.get(box)! : boxes.indexOf(box);
  }
  function composers(): Composing[] {
    const found: Composing[] = [];
    forms.forEach((form, box) => {
      found.push({
        section: box.dataset.section, index: placeOf(box), widget: on(form), field: fieldOf(form),
        images: attached.get(form)!,
      });
    });
    shown.forEach(thread => {
      const reply = handles(thread);
      found.push({
        thread: thread.root.id, section: thread.root.section, index: placeOf(thread.box!),
        field: reply.field, images: attached.get(reply.form)!,
      });
    });
    return found;
  }

  // Whether a composer holds text or images not sent.
  function holding(each: { field: HTMLTextAreaElement; images: Attachments }) {
    return each.field.value.trim() !== "" || each.images.held();
  }

  // Kept over a reload of the page (js/live-page.js): what is open, and
  // the text and uploaded images not sent in each composer. An image
  // still uploading is unsent too, so a hidden page waits for the reader.
  live.keep({
    unsent() {
      const passage = store.passages.writing();
      return Boolean(passage && ((passage.text || "").trim() || passage.held)) || composers().some(holding) ||
        awaiting.size > 0 || pending().length > 0 || Boolean(kept && kept.passage);
    },
    // What the last reload kept and the threads' first read has not yet
    // given back is kept again, with what was written since.
    save(): Saved {
      return {
        open: store.panel.held() || (kept ? kept.open : null),
        passage: store.passages.writing() || (kept ? kept.passage : null),
        texts: [
          ...pending(),
          ...composers().filter(holding).map(each => ({
            thread: each.thread, section: each.section, index: each.index, widget: each.widget,
            text: each.field.value, images: each.images.kept(),
          })),
          ...Array.from(awaiting, each => ({
            section: each.section, index: each.index, widget: each.widget, text: String(each.text || ""),
            images: each.from ? each.from.kept() : each.images, quote: each.quote, why: each.why,
          })),
        ],
      };
    },
  });

  // What was kept before the page reloaded, given back once the threads
  // are first read: the text and images in each composer, then what was
  // open, then the scroll position the reader had (live.place: opening a
  // thread over the text may scroll the page to it). Text whose place the
  // new revision no longer has (a section renamed or gone, a passage's
  // words changed, a thread not read) is never lost: it goes to the form
  // for a new thread on its section, else on the box where its section
  // was, else on the page's first, which opens with the reason beside it.
  // Text begun on a live block opens again on it, as its Comment opens it,
  // in the form of the section the block is in now, still on the version
  // the reader saw (saying so, should it have changed since); where the
  // page no longer has the block, it goes to its section's form, saying so.
  // Images go with their text, up to MAX_IMAGES a composer.
  let kept = live.kept() as Saved | null;

  // The texts kept before the reload, until they are given back.
  function pending(): unknown[] {
    return kept && Array.isArray(kept.texts) ? kept.texts as unknown[] : [];
  }

  // Add each's text and images to form; why some images were not. Those
  // of a composer still on the page (each.from: its attachments, as a
  // swap takes it away) come as they are now, any still uploading too.
  function join(form: HTMLFormElement, each: Draft) {
    const field = fieldOf(form);
    const text = String(each.text || "");
    if (text.trim()) {
      field.value = field.value.trim() ? field.value + "\n\n" + text : text;
    }
    const images = attached.get(form)!;
    return each.from ? each.from.pass(images) : images.restore(each.images);
  }

  function told(form: HTMLFormElement, why: string) {
    if (why) {
      form.querySelector(".artifact-comment-status")!.textContent = why;
    }
  }

  // What rehome() keeps for a form until the post it is sending is saved:
  // held only here meanwhile, so kept over a reload too (why: what its
  // form is to say). Each leaves once it joins a form.
  const awaiting = new Set<Draft>();

  // Text whose place is gone goes to the form for a new thread on its
  // section, else on the box at its index, else on the page's first,
  // saying why; that box. A form sending a post empties once it is saved,
  // so what goes to one joins it after, opened for the reader (or goes on
  // to another form, should a swap take this one away meanwhile).
  function rehome(each: Draft, why: string): HTMLElement {
    const box = (typeof each.section === "string" && sections.get(each.section)) ||
      boxes[Number(each.index)] || boxes[0];
    const form = forms.get(box)!;
    const saving = sending.get(form);
    if (saving) {
      each.why = why;
      awaiting.add(each);
      saving.then(() => {
        awaiting.delete(each);
        let now = boxWith(form);
        if (!now) {
          now = rehome(each, why);
        } else {
          // A post not saved says why first.
          const said = form.querySelector(".artifact-comment-status")!.textContent;
          land(form, each, said ? said + " " + why : why);
        }
        store.panel.reopen({ section: now.dataset.section, writing: true });
      });
      return box;
    }
    land(form, each, why);
    return box;
  }

  // Join each to form, saying why. A form on a live block given text from
  // elsewhere is on no block: its texts are never sent as one on it.
  function land(form: HTMLFormElement, each: Draft, why: string) {
    unblock(form);
    const over = join(form, each);
    told(form, over ? why + " " + over : why);
  }

  // A kept draft's live block, read as untrusted storage: else undefined.
  function widgetOf(each: Draft): Widget | undefined {
    const found = each.widget as Partial<Widget> | null | undefined;
    if (!found || typeof found !== "object" || typeof found.id !== "string" || typeof found.state !== "string" ||
        typeof found.hash !== "string" || !/^[0-9a-f]{12}$/.test(found.hash)) {
      return undefined;
    }
    return { id: found.id, hash: found.hash, state: found.state };
  }

  // Join each to the form of the box its live block is in now, holding the
  // form on the block as it was; that box, else null. A form that already
  // holds a draft from another place (two blocks a republish put in one
  // section, or a section's own draft and a block's) is on no block: its
  // texts are never sent as one comment on one of them. A form sending a
  // post empties once it is saved, so the draft joins it after (kept over
  // a reload meanwhile), going where its block then is.
  function reblock(each: Draft, widget: Widget): HTMLElement | null {
    const box = store.blockBox(widget);
    if (!box) return null;
    const form = forms.get(box)!;
    const saving = sending.get(form);
    if (saving) {
      awaiting.add(each);
      saving.then(() => {
        awaiting.delete(each);
        if (blockStanding(widget) === "gone") rehome(each, page.blockGone);
        else if (!reblock(each, widget)) rehome(each, page.placeGone);
      });
      return box;
    }
    const filled = holding({ field: fieldOf(form), images: attached.get(form)! });
    const was = on(form);
    store.holdOn(widget, true);
    const over = join(form, each);
    if (filled && !(was && was.id === widget.id && was.hash === widget.hash && was.state === widget.state)) {
      unmix(form, over);
    } else {
      told(form, [blockStanding(widget) === "changed" ? page.blockChanged : "", over].filter(Boolean).join(" "));
    }
    return box;
  }

  // A form given back drafts from more than one place: on no block, saying
  // its text is kept here.
  function unmix(form: HTMLFormElement, over: string) {
    unblock(form);
    told(form, over ? page.placeGone + " " + over : page.placeGone);
  }

  function worth(each: Draft) {
    return String(each.text || "").trim() !== "" || (Array.isArray(each.images) && each.images.length > 0) ||
      Boolean(each.from && each.from.held());
  }

  function restore() {
    const was = kept;
    kept = null;
    if (!was) return;
    let moved: HTMLElement | null = null;
    // The section each block draft was written in, by the section its
    // block is in now: a form open where a draft was written opens where
    // it is now, so reopening the old one folds no form off its block.
    const reblocked = new Map<string, string>();
    (Array.isArray(was.texts) ? was.texts as unknown[] : []).forEach(found => {
      if (!found || typeof found !== "object" || !worth(found)) return;
      const each: Draft = found;
      const thread = each.thread ? shown.get(each.thread as number) : null;
      const box = !each.thread && typeof each.section === "string" ? sections.get(each.section) : null;
      const widget = each.thread ? undefined : widgetOf(each);
      let held: HTMLElement | null = null;
      if (each.why) {
        // Waiting for a post when the page reloaded: a passage's composer
        // opens again on its words where the page has them; else it goes
        // where it was to go, still to say why.
        if (!(each.quote && store.passages.reopen(each))) {
          moved = rehome(each, String(each.why));
        }
      } else if (thread) {
        const reply = handles(thread);
        reply.field.value = String(each.text || "");
        told(reply.form, attached.get(reply.form)!.restore(each.images));
        // On an archived page the text is kept, folded away, for a reload
        // once it takes replies again.
        if (!page.archived) {
          reply.unfold(true);
        }
      } else if (widget && blockStanding(widget) === "gone") {
        moved = rehome(each, page.blockGone);
      } else if (widget && (held = reblock(each, widget))) {
        if (typeof each.section === "string") reblocked.set(each.section, held.dataset.section!);
      } else if (box) {
        const form = forms.get(box)!;
        const over = join(form, each);
        if (on(form)) unmix(form, over);
        else told(form, over);
      } else {
        moved = rehome(each, page.placeGone);
      }
    });
    if (was.open && typeof was.open === "object") {
      const open = was.open as Kept;
      const now = typeof open.section === "string" ? reblocked.get(open.section) : undefined;
      store.panel.reopen(now === undefined ? open : { ...open, section: now });
    }
    const passage = was.passage && typeof was.passage === "object" ? was.passage as PassageDraft : null;
    if (passage && !store.passages.reopen(passage) && worth(passage)) {
      moved = rehome(passage, page.passageGone);
    }
    if (moved) {
      store.panel.reopen({ section: (moved as HTMLElement).dataset.section, writing: true });
    }
    live.place();
  }

  // The box whose form for a new thread form is: a swap gives a section's
  // new box the form of the box it replaced.
  function boxWith(form: HTMLFormElement): HTMLElement | null {
    let found: HTMLElement | null = null;
    forms.forEach((each, box) => {
      if (each === form) found = box;
    });
    return found;
  }

  // The post each form for a new thread is sending: its row, or null.
  const sending = store.composer.sending;
  const wire = (box: HTMLElement) => { store.composer.wire(box); };
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
  document.addEventListener(page.events.swapped, event => {
    const { revision, units } = (event as CustomEvent<Swapped>).detail;
    store.swapped(revision);
    const focused = document.activeElement as HTMLElement | null;
    const writing: Draft | null = store.passages.swept();
    if (writing && writing.box && takenAt.has(writing.box)) {
      writing.index = takenAt.get(writing.box);
    }
    store.passages.moved();
    const unsent: Draft[] = [];
    const olds: HTMLElement[] = [];
    const news: HTMLElement[] = [];
    const gone: HTMLFormElement[] = [];
    const fresh: HTMLFormElement[] = [];
    units.forEach(unit => {
      if (unit.kind === "header") {
        // The swap gave the tab the new revision's title.
        store.retitle();
      }
      olds.push(...boxesIn(unit.before).filter(box => boxes.indexOf(box) >= 0));
      news.push(...boxesIn(unit.after));
      gone.push(...decisionsIn(unit.before).filter(form => decisions.indexOf(form) >= 0));
      fresh.push(...decisionsIn(unit.after));
    });
    gone.forEach(form => {
      decisions.splice(decisions.indexOf(form), 1);
      store.panel.forget(form);
    });
    decisions.push(...fresh);
    decisions.sort(inOrder);
    store.ask();
    fresh.forEach(store.askAbout);
    if (olds.length || news.length) {
      remount(olds, news, unsent);
    } else {
      refresh();
    }
    let moved: HTMLElement | null = null;
    unsent.forEach(each => {
      if (!each.saving) {
        moved = rehome(each, page.placeGone);
        return;
      }
      // Sent already: kept only if it is not saved.
      const held = pend(each, page.placeGone);
      each.saving.then(row => {
        awaiting.delete(held);
        const box = row ? null : rehome(each, page.placeGone);
        if (box) {
          store.panel.reopen({ section: box.dataset.section, writing: true });
        }
      });
    });
    if (writing && writing.saving) {
      // Sent already: kept only if it is not saved.
      const held = pend(writing, page.passageGone);
      writing.saving.then(row => {
        awaiting.delete(held);
        const box = row ? null : rewrite(writing);
        if (box) {
          store.panel.reopen({ section: box.dataset.section, writing: true });
        }
      });
    } else if (writing) {
      moved = rewrite(writing) || moved;
    }
    if (moved) {
      store.panel.reopen({ section: (moved as HTMLElement).dataset.section, writing: true });
    }
    if (focused && focused !== document.body && focused.isConnected && document.activeElement !== focused) {
      focused.focus({ preventScroll: true });
    }
  });

  function inOrder(a: Node, b: Node) {
    return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  }

  // What a form or composer a swap took away holds while the post it is
  // sending is not yet saved, kept over a reload meanwhile (awaiting) to
  // go where rehome() would put it, saying why; that snapshot, for the
  // caller to let go of once the post settles.
  function pend(each: Draft, why: string): Draft {
    const held: Draft = {
      section: each.section, index: each.index, text: each.text, from: each.from, images: each.images,
      quote: each.quote, why,
    };
    awaiting.add(held);
    return held;
  }

  // A passage composer a swap took the words of opens again on them
  // where the page still has them and no other composer is open; else
  // what was written goes to a section's form, saying why: that box,
  // else null.
  function rewrite(writing: Draft): HTMLElement | null {
    if (store.passages.reopen(writing) || !worth(writing)) return null;
    return rehome(writing, page.passageGone);
  }

  // Mount the boxes a swap brought in (news) in place of those it took
  // out (olds): what was written in the form of each taken away for good
  // is added to unsent.
  function remount(olds: HTMLElement[], news: HTMLElement[], unsent: Draft[]) {
    news.sort(inOrder);
    const replaced: [HTMLElement, HTMLElement][] = [];
    const added: HTMLElement[] = [];
    news.forEach(box => {
      const old = olds.filter(each => each.dataset.section === box.dataset.section)[0];
      if (old) {
        olds.splice(olds.indexOf(old), 1);
        replaced.push([old, box]);
      } else {
        added.push(box);
      }
    });
    const taken = store.panel.take([...olds, ...replaced.map(pair => pair[0])]);
    replaced.forEach(pair => replaceBox(pair[0], pair[1]));
    olds.forEach(old => {
      const each = dropBox(old);
      if (each) unsent.push(each);
    });
    added.forEach(addBox);
    store.panel.remounted();
    const order = boxes.map(box => [box, forms.get(box)!] as const);
    forms.clear();
    order.forEach(pair => forms.set(pair[0], pair[1]));
    shown.forEach(store.put);
    refresh();
    store.panel.give(taken);
    refresh();
  }

  // The elements matching selector among some nodes and in them.
  function within<T extends HTMLElement>(nodes: Node[], selector: string): T[] {
    const found: T[] = [];
    nodes.forEach(node => {
      if (node instanceof Element) {
        if (node.matches(selector)) found.push(node as T);
        found.push(...page.all(selector, node as HTMLElement) as T[]);
      }
    });
    return found;
  }

  // The comment boxes among some nodes and in them.
  function boxesIn(nodes: Node[]) {
    return within<HTMLElement>(nodes, "details.artifact-comment");
  }

  // The decision forms among some nodes and in them.
  function decisionsIn(nodes: Node[]) {
    return within<HTMLFormElement>(nodes, "form.artifact-decision[data-question]");
  }

  // A section's new box takes the place of old: its threads, and its
  // form, which stays the section's wherever it is shown, the new box's
  // own taken out.
  function replaceBox(old: HTMLElement, box: HTMLElement) {
    boxes[boxes.indexOf(old)] = box;
    if (sections.get(old.dataset.section!) === old) {
      sections.set(box.dataset.section!, box);
    }
    const form = forms.get(old)!;
    const own = box.querySelector("form.artifact-comment-form");
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
    shown.forEach(thread => {
      if (thread.box === old) thread.box = box;
    });
    store.panel.replace(old, box);
  }

  // The index each section a swap took away had as it was taken away,
  // while it is held back: where a reload would put what its form holds.
  const takenAt = new Map<HTMLElement, number>();

  // A section taken away takes its box and form with it; its threads say
  // which section they were on. What its form holds not sent, to go where
  // the section was, as on a reload; else null.
  function dropBox(old: HTMLElement): Draft | null {
    const at = boxes.indexOf(old);
    const place = takenAt.has(old) ? takenAt.get(old) : at;
    takenAt.delete(old);
    const form = forms.get(old)!;
    const each = { field: fieldOf(form), images: attached.get(form)! };
    const unsent: Draft | null = holding(each) ? {
      section: old.dataset.section, index: place, text: each.field.value,
      images: each.images.kept(), from: each.images, saving: sending.get(form) || null,
    } : null;
    boxes.splice(at, 1);
    if (sections.get(old.dataset.section!) === old) {
      sections.delete(old.dataset.section!);
    }
    attached.delete(form);
    forms.delete(old);
    shown.forEach(thread => {
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
  function addBox(box: HTMLElement) {
    let at = boxes.findIndex(other => Boolean(box.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING));
    at = at < 0 ? boxes.length : at;
    boxes.splice(at, 0, box);
    store.enlist(box);
    wire(box);
    store.panel.mount(box, at);
    shown.forEach(thread => {
      if (!thread.box && store.boxFor(thread.root) === box) {
        thread.box = box;
        thread.node.querySelector(":scope > .artifact-comment-section")?.remove();
      }
    });
  }

  // A swap holds back a part holding the open passage composer's words,
  // and a section it would take away whose form holds text or images not
  // sent, until the reader's Update: then the SWAPPED handler above keeps
  // what was written.
  page.holdSwap((nodes, removed) => {
    // Its index from when a swap first takes it away; a section that is
    // only changed is not taken away.
    boxes.forEach((box, at) => {
      if (!nodes.some(node => node.contains(box))) return;
      if (!removed) {
        takenAt.delete(box);
      } else if (!takenAt.has(box)) {
        takenAt.set(box, at);
      }
    });
    if (store.passages.writes(nodes as HTMLElement[])) return true;
    return removed && boxes.some(box => {
      const form = forms.get(box)!;
      return nodes.some(node => node.contains(box)) &&
        holding({ field: fieldOf(form), images: attached.get(form)! });
    });
  });

  store.start();
}
