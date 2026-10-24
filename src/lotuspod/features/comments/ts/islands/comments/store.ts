import type { CommentRow, Decision, Page, StartComment, StoreBridge, Thread, Widget } from "../bridge";
import { anchorOf, blockTitle, frameOf } from "./anchor";
import type { Passages, Placement, Store } from "./parts";
import { composers } from "./composer";
import { passages as makePassages } from "./passages";
import { placement as makePlacement } from "./placement";
import { threadRows } from "./thread";
import { readThreads, SIGNED_OUT } from "./route";
import { shared, type Read } from "./state";
import { replies as makeReplies } from "./unread";

// A tick from serve's stream (js/live-events.js).
interface Tick { what?: string; page?: string }

// The comment threads (lotuspod.comments) and the reads that fill them. One
// per section, or one for the page. Threads come from the comments route;
// each is shown in its section's group, or, when the page no longer has
// that section, in a list at the end of the body. Each thread read or
// posted is written to its signal in the store's state (comments/state.ts).
// The replies to the reader and the decisions' Ask are the replies part's
// (comments/unread.ts).
// The drafts (comments/drafts.ts) keep drafts and swaps, and reach these
// through the part.
export function store(page: Page, bridge: StoreBridge): Store {
  const { boxes, decisions } = bridge;
  const name = boxes[0].dataset.page || "";
  const owner = document.querySelector<HTMLMetaElement>('meta[name="lotuspod:owner"]')?.content || "";
  // The revision the page shows now, which a swap moves on
  // (js/live-page.js); null on a page with none. While a swap's SWAPPED
  // is handled, live.revision() is still the one before it.
  let swappedTo = "";
  function revision() {
    return swappedTo || page.live.revision() || null;
  }
  const article = document.querySelector<HTMLElement>(".artifact-body");
  // Maps, not objects: a section id is the author's and may be any name,
  // "__proto__" included.
  const sections = new Map<string, HTMLElement>();
  const shown = new Map<number, Thread>();
  // Each box's form for a new thread, wherever it is shown.
  const forms = new Map<HTMLElement, HTMLFormElement>();
  // Each composer's attachments, by its form.
  const attached = new Map<HTMLFormElement, import("../bridge").Attachments>();
  const questions = new Map<string, HTMLFormElement>();

  // The checks for replies: while a thread waits, or the reader has a
  // thread in view (an agent may add to one it answered), and the page is
  // seen, read the threads again FIRST after the last read, each gap half
  // again as long as the one before up to LAST, and the first gap again
  // after any change or a comment the reader posts.
  const FIRST = 3000;
  const LAST = 30000;
  let gap = FIRST;
  let last = 0;
  let timer: number | undefined;
  let reading = false;
  // Until the first read has finished, a chip keeps its served line, so a
  // section with threads never says "No comments"; a read slower than
  // SLOW_MS draws the chips anyway, so the reader can still write.
  let settled = false;
  const SLOW_MS = 1000;
  // Set on the root element once the first read has ended and drawn the
  // chips (the SLOW_MS draw does not set it), so a check can wait for it.
  const READ = "data-lotuspod-comments-read";
  // A note's thread not read yet (owe), and how many notes were saved:
  // only a read begun after the newest finds its thread.
  let owed = false;
  let notes = 0;
  // The read in flight is followed by the first gap.
  let fresh = false;
  // False once a read finds the reader signed out.
  let checking = true;
  // Another read is owed once the one in flight ends (readNow).
  let again = false;
  // A tick from serve's stream while the page was hidden.
  let ticked = false;
  // Whether the first read has opened a #thread=ID link, and whether a
  // hashchange since asks for it again.
  let linked = false;
  let relink = false;

  let panel: Placement | null = null;
  let passages: Passages | null = null;

  const replies = makeReplies(page, {
    page: name, shown, revision, refresh, add, posted, owe,
    rows: thread => rows(thread), markUnread: thread => markUnread(thread),
    placement: () => panel!,
  });

  const threadPart = threadRows(page, {
    owner, page: name, checking: () => checking,
    counted: replies.counted, opening: replies.opening, label: (thread, row) => composer.label(thread, row),
  });
  const { agent, author, routed, rows, sync, markUnread } = threadPart;
  // Rows merged into a thread are its signal's too.
  function merge(thread: Thread, entries: (CommentRow | null)[]) {
    const drawn = threadPart.merge(thread, entries);
    shared.write.take({ root: thread.root, replies: thread.replies, resolution: thread.resolution });
    return drawn;
  }

  const composer = composers(page, {
    page: name, revision, attached, forms,
    sending: new Map(), boxWith: bridge.boxWith, rows, agent, routed,
    readTo: replies.readTo, merge, posted, add, shown,
    placement: () => panel!,
  });

  // A box joins the page's: by its section, and its form for a new thread.
  function enlist(box: HTMLElement) {
    sections.set(box.dataset.section!, box);
    forms.set(box, box.querySelector<HTMLFormElement>("form.artifact-comment-form")!);
  }
  boxes.forEach(enlist);
  // The page's decision forms by their question.
  function ask() {
    questions.clear();
    decisions.forEach(form => questions.set(form.dataset.question!, form));
  }
  ask();

  // The text of a form's part, its whitespace collapsed.
  function words(form: HTMLFormElement, selector: string) {
    const node = form.querySelector(selector);
    return node ? (node.textContent || "").replace(/\s+/g, " ").trim() : "";
  }

  // The decision a thread asks about: its form, its number ("" for none),
  // its question and what it is called; null for any other thread, and
  // for one on a decision the page no longer asks.
  function decisionOf(thread: Thread): (Decision & { number: string }) | null {
    const question = thread.root.question;
    const form = question !== undefined && question !== null ? questions.get(String(question)) : null;
    if (!form) return null;
    const number = words(form, ".artifact-decision-number");
    return {
      form, number, question: words(form, ".artifact-decision-text"),
      name: number ? "Decision " + number : "Decision",
    };
  }

  // A thread waits while any reader comment in it has no answer yet.
  function waits(thread: Thread) {
    return rows(thread).some(entry => !agent(entry) && (entry.state === "pending" || entry.state === "claimed"));
  }

  // The threads of a section's box, oldest first.
  function threadsOf(box: HTMLElement) {
    return [...shown.values()].filter(thread => thread.box === box).sort((a, b) => a.root.id - b.root.id);
  }

  // The list at the end of the body for threads on sections the page no
  // longer has.
  function changed() {
    let list = document.querySelector<HTMLElement>(".artifact-comments-changed");
    if (!list) {
      list = page.element("section", "artifact-comments-changed");
      list.appendChild(page.element("h2", "", page.changed));
      (document.querySelector(".artifact-body") || document.body).appendChild(list);
    }
    return list;
  }

  // Show a thread as read: a new one lands in its section's box, a known
  // one takes what it does not show yet. True when anything was drawn.
  function add(entry: Read): boolean {
    const root = entry.root;
    if (!root) return false;
    shared.write.take(entry);
    const known = shown.get(root.id);
    if (known) {
      const moved = Boolean(entry.resolution) && resolved(known) !== Boolean(entry.resolution!.resolved);
      if (entry.resolution) known.resolution = entry.resolution;
      return merge(known, [root, ...(entry.replies || [])]) || moved;
    }
    const list = page.element("ol", "artifact-comment-list");
    list.setAttribute("aria-live", "polite");
    const node = page.element("div", "artifact-comment-thread");
    node.dataset.thread = String(root.id);
    const box = boxFor(root);
    const thread: Thread = {
      root, replies: [], list, node, box,
      resolution: entry.resolution || null, entry: null,
      // Whether it is open.
      lit: false,
      // A passage thread's words: undefined until looked for, null when
      // not found; its highlights, its number node and its number.
      spot: undefined, marks: [], number: null, n: 0,
    };
    if (!box) node.appendChild(whereFrom(root));
    if (root.quote) {
      // Headed by its quote in a box; the panel's entry says it instead.
      thread.head = page.element("p", "artifact-passage-head");
      node.appendChild(thread.head);
    }
    node.appendChild(list);
    Object.assign(thread, composer.reply(thread, node));
    shown.set(root.id, thread);
    watch(node);
    merge(thread, entry.replies || []);
    put(thread);
    return true;
  }

  // The box a thread's first comment is on, or null when the page no
  // longer has its section, or the live block it is on. A thread on the
  // whole page of a page that has kept only its "page" box (republished
  // with fewer sections) is that box's, and a thread on that "page" box is
  // the whole page's once the page has sections.
  function boxFor(root: CommentRow) {
    const anchor = anchorOf(root);
    if (anchor.kind === "block") {
      // The section the block is in now, which a republish may have moved.
      const frame = frameOf(anchor.id);
      return frame ? boxOn(sectionOf(frame)) : null;
    }
    return boxOn(root.section);
  }

  function boxOn(section: string | undefined) {
    return (section !== undefined && sections.get(section)) ||
      (section === page.wholePage && sections.get("page")) ||
      (section === "page" && sections.get(page.wholePage)) || null;
  }

  // The section a live block's frame is in, else the whole page.
  function sectionOf(frame: HTMLIFrameElement) {
    return frame.closest<HTMLElement>(".artifact-section-body")?.dataset.section ?? page.wholePage;
  }

  // The line a thread on a section the page no longer has starts with.
  function whereFrom(root: CommentRow) {
    return page.element("p", "artifact-comment-section",
      "On " + String(root.sectionTitle || root.section || "an earlier section"));
  }

  function resolved(thread: Thread) {
    return Boolean(thread.resolution && thread.resolution.resolved);
  }

  // Show a thread in its entry, where the window has room for it.
  function put(thread: Thread) {
    panel!.put(thread);
  }

  // A swap may take away the live block a thread is on, or bring it back:
  // the thread goes to the list of those on what the page no longer has,
  // or back to its section's box.
  function rehome() {
    shown.forEach(thread => {
      if (anchorOf(thread.root).kind !== "block") return;
      const box = boxFor(thread.root);
      if (box === thread.box) return;
      thread.box = box;
      const line = thread.node.querySelector(":scope > .artifact-comment-section");
      if (!box && !line) thread.node.insertBefore(whereFrom(thread.root), thread.node.firstChild);
      if (box && line) line.remove();
      put(thread);
    });
  }

  // A live block's Comment: its section's form opens, on the block. A
  // draft kept over a reload opens the same way on the block it was on
  // (anchor: as it was then); the box, else null for a block the page has
  // no section for.
  function holdOn(anchor: Widget, restoring = false): HTMLElement | null {
    const frame = frameOf(anchor.id);
    const box = blockBox(anchor);
    if (!frame || !box) return null;
    composer.block(forms.get(box)!, anchor, blockTitle(anchor));
    // A narrow window shows one form at a time, and folding one takes it
    // off its block: a form given back is held, not opened, there.
    if (!restoring || panel!.wide) {
      const figure = frame.closest("figure");
      panel!.write(box, figure?.querySelector<HTMLElement>(".artifact-live-comment") || frame);
    }
    return box;
  }
  // The box of the section a live block's frame is in now, else null.
  function blockBox(anchor: Widget): HTMLElement | null {
    const frame = frameOf(anchor.id);
    return frame ? boxOn(sectionOf(frame)) : null;
  }
  const startOn: StartComment = ({ anchor }) => { holdOn(anchor); };

  // Draw what the threads say outside them: the passages' highlights, the
  // panel, the chips, what a popover or the sheet holds and the replies
  // to the reader.
  function refresh() {
    passages!.update();
    panel!.refresh();
    replies.showUnread();
  }

  // The thread nodes in view, in a box, the panel, a popover or the sheet.
  const viewed = new Set<Element>();
  const viewing = typeof IntersectionObserver === "function"
    ? new IntersectionObserver(changes => {
      changes.forEach(change => {
        if (change.isIntersecting) viewed.add(change.target);
        else viewed.delete(change.target);
      });
      plan();
    })
    : null;

  function watch(node: HTMLElement) {
    viewing?.observe(node);
  }

  // Whether anything calls for another read: a note saved with an
  // answer calls for one until a read finds its thread.
  function wanted() {
    return viewed.size > 0 || owed || Boolean(waiting());
  }

  function waiting() {
    for (const thread of shown.values()) {
      if (waits(thread)) return thread;
    }
    return null;
  }

  function hidden() {
    return document.visibilityState === "hidden";
  }

  function stop() {
    clearTimeout(timer);
    timer = undefined;
  }

  function plan() {
    stop();
    if (reading || !checking || hidden() || !wanted()) return;
    timer = window.setTimeout(read, Math.max(0, last + gap - Date.now()));
  }

  function signedOut() {
    checking = false;
    stop();
    const first = waiting();
    if (first) {
      // A box's form may be folded away: the thread says it.
      let status = first.node.querySelector(":scope > .artifact-comment-status");
      if (!status) {
        status = page.element("p", "artifact-comment-status");
        status.setAttribute("role", "status");
        first.node.appendChild(status);
      }
      status.textContent = page.signedOut;
    }
    shown.forEach(sync);
    refresh();
  }

  async function read() {
    timer = undefined;
    reading = true;
    last = Date.now();
    let touched = false;
    const asOf = notes;
    try {
      const payload = await readThreads(page, name);
      if (payload === SIGNED_OUT) {
        reading = false;
        settled = true;
        page.settleImageCap(null, page.signedOut);
        signedOut();
        document.documentElement.setAttribute(READ, "");
        bridge.restore();
        return;
      }
      if (payload && typeof payload.maxImageBytes === "number") {
        page.settleImageCap(payload.maxImageBytes);
      } else {
        page.settleImageCap(null, page.noCap);
      }
      if (payload) {
        owed = owed && asOf !== notes;
        (payload.threads || []).forEach(entry => {
          if (add(entry)) touched = true;
        });
        page.live.seen(payload.revision);
      }
    } catch {
      // A failed read keeps the schedule.
      page.settleImageCap(null, page.noCap);
    }
    reading = false;
    settled = true;
    refresh();
    document.documentElement.setAttribute(READ, "");
    bridge.restore();
    if (!linked || relink) {
      // A link followed before the first read is no reload's fragment.
      openLinked(!relink);
      linked = true;
      relink = false;
    }
    gap = touched || fresh ? FIRST : Math.min(gap * 1.5, LAST);
    fresh = false;
    if (again) {
      again = false;
      // A hidden page reads it once it is seen again.
      if (hidden()) {
        ticked = true;
      } else {
        fresh = true;
        read();
        return;
      }
    }
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

  // #thread=ID, a link from the index's Recent activity, opens the thread
  // whose first comment is ID (panel.reach) once the first read has drawn
  // the threads, and again on each hashchange after the threads are read
  // again, so a reply since is among what it marks seen; one before the
  // first read waits for it. An ID no thread here has, or not a number,
  // opens nothing.
  function openLinked(first: boolean) {
    const id = page.linkedTo("thread", first);
    const thread = id !== null && /^[1-9][0-9]*$/.test(id) ? shown.get(Number(id)) : undefined;
    if (thread) panel!.reach(thread);
  }
  window.addEventListener("hashchange", () => {
    if (page.linkedTo("thread") === null) return;
    relink = true;
    if (linked && !reading) {
      clearTimeout(timer);
      fresh = true;
      read();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (hidden()) {
      stop();
    } else if (ticked && checking) {
      ticked = false;
      readNow();
    } else if (!timer && !reading && checking && wanted()) {
      fresh = true;
      read();
    }
  });

  // Read the threads at once, or once more after the read in flight, which
  // may have missed what called for this one.
  function readNow() {
    if (reading) {
      again = true;
      return;
    }
    clearTimeout(timer);
    fresh = true;
    read();
  }

  // A tick from serve's stream (js/live-events.js) that this page's
  // threads or answers changed, or that the stream missed some, reads the
  // threads at once; one while the page is hidden is read once it is seen
  // again. Signed out, nothing is read.
  document.addEventListener("lotuspod:change", event => {
    const tick: Tick = (event as CustomEvent<Tick>).detail;
    if (!checking || !(tick.what === "resync" ||
        ((tick.what === "comment" || tick.what === "answer") && tick.page === name))) {
      return;
    }
    if (hidden()) {
      ticked = true;
      return;
    }
    readNow();
  });

  // An answer saved with a note opens a thread on its decision, or adds to
  // one: a read is called for at once, and until one begun after it finds it.
  function owe() {
    owed = true;
    notes += 1;
    readNow();
  }

  return {
    sections, shown, forms, attached, composer,
    get panel() { return panel!; },
    get passages() { return passages!; },
    swapped(to) { swappedTo = to; },
    retitle: replies.retitle,
    enlist, ask, boxFor, whereFrom, put, refresh, holdOn, blockBox,
    // Each decision's Ask (the decisions island's, through the store's
    // state), the passages and the panel, the threads arranged as the
    // window allows, and the first read.
    start() {
      shared.write.asking({ ask: replies.ask, owe });
      passages = makePassages(page, {
        article, boxes, shown, resolved, revision, attached, composer,
        placement: () => panel!,
      });
      panel = makePlacement(page, {
        all: page.all, boxes, shown, forms, decisions,
        rows, resolved, agent, routed, threadsOf, decisionOf, passages,
        imageWords: page.imageWords, looked: replies.looked, refresh, failure: composer.failure, json: page.json,
        page: name, sections, showUnread: replies.showUnread, changed, author, unreadIn: replies.unreadIn,
        unblock: box => composer.unblock(forms.get(box)), settled: () => settled,
        unsent: box => {
          const form = forms.get(box)!;
          return composer.fieldOf(form).value !== "" || Boolean(attached.get(form)?.held());
        },
      });
      panel.arrange();
      page.startComment(startOn);
      // After every listener of the swap has run, the drafts' and the live
      // blocks' chrome among them.
      document.addEventListener(page.events.swapped, () => queueMicrotask(() => {
        composer.swapped(frame => boxOn(sectionOf(frame)));
        rehome();
        refresh();
      }));
      window.setTimeout(() => {
        if (settled) return;
        settled = true;
        refresh();
      }, SLOW_MS);
      read();
    },
  };
}
