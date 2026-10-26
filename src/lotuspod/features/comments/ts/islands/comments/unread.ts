import { effect, signal } from "@preact/signals";
import type { CommentRow, Page, Thread } from "../bridge";
import type { Placement } from "./parts";
import { shared } from "./state";

// What the unread replies and the Ask reach the store by.
interface RepliesBridge {
  page: string;
  shown: Map<number, Thread>;
  rows(thread: Thread): CommentRow[];
  markUnread(thread: Thread): void;
  revision(): string | null;
  refresh(): void;
  add(entry: { root: CommentRow; replies: CommentRow[] }): boolean;
  posted(): void;
  owe(): void;
  placement(): Placement;
}

// A question about a decision as the comments route takes it.
interface Question { page: string; question: string; text: string; revision?: string }

const SEEN = "/api/seen";

// Replies to the reader: the ids the comments route last named `unread`,
// each thread's mark as this page last knew it, and the comments of each
// open thread that were unread as it opened, which stay marked while it
// stays open; threads by their first comment's id. A route that names none
// (signed out, the demo) marks nothing. The first two are the store's
// signals (comments/state.ts), which the tab's title and the header's badge
// are drawn from. With them, what each decision's Ask posts.
export function replies(page: Page, bridge: RepliesBridge) {
  const { shown, rows, markUnread } = bridge;
  const { unread, tracked, seenTo } = shared;
  const opening = new Map<number, Set<number>>();
  const tabTitle = signal(document.title);
  const dateLine = document.querySelector("header.artifact-header .artifact-meta");
  let newBadge: HTMLSpanElement | null = null;

  // Whether a comment counts as unread: the route named it, and neither a
  // mark this page posted nor the reader's own reply since has read it.
  function counted(thread: Thread, entry: CommentRow) {
    return unread.value.has(entry.id) && entry.id > (seenTo.value.get(thread.root.id) || 0);
  }

  // How many comments in some threads count as unread.
  function unreadIn(threads: Thread[]) {
    return threads.reduce((n, thread) => n + rows(thread).filter(entry => counted(thread, entry)).length, 0);
  }

  // The thread is read up to comment id: by a mark posted, or the reader's
  // own reply.
  function readTo(thread: Thread, id: number) {
    shared.write.readTo(thread.root.id, id);
  }

  // The badge ending the header's date line and the tab's title, drawn
  // again as the threads, the ids named unread or the seen marks change.
  effect(() => {
    let n = 0;
    for (const id of shared.threadIds.value) {
      const thread = shared.thread(id).value;
      if (!thread) continue;
      const seen = seenTo.value.get(id) || 0;
      for (const entry of [thread.root, ...thread.replies]) {
        if (unread.value.has(entry.id) && entry.id > seen) n += 1;
      }
    }
    document.title = n > 0 ? "(" + n + ") " + tabTitle.value : tabTitle.value;
    if (!dateLine) return;
    if (n > 0) {
      newBadge = newBadge || page.element("span", "artifact-unread");
      newBadge.textContent = (n === 1 ? "1 new reply" : n + " new replies") + " to you";
      if (dateLine.lastChild !== newBadge) dateLine.appendChild(newBadge);
    } else if (newBadge) {
      newBadge.remove();
    }
  });

  // Draw the replies to the reader on each thread's rows; the badge and
  // the title follow the signals.
  function showUnread() {
    shown.forEach(markUnread);
    shown.forEach(arrived);
  }

  // A thread open in view on a visible page took comments unread since it
  // opened: they are seen as on opening it, and stay marked while it stays
  // open. One that came while the page was hidden is seen once it shows.
  function arrived(thread: Thread) {
    if (!thread.lit || !tracked.value || document.visibilityState !== "visible") return;
    const held = opening.get(thread.root.id) || new Set<number>();
    const fresh = rows(thread).filter(entry => counted(thread, entry) && !held.has(entry.id));
    if (!fresh.length) return;
    fresh.forEach(entry => held.add(entry.id));
    opening.set(thread.root.id, held);
    markUnread(thread);
    void seeThread(thread);
  }
  document.addEventListener("visibilitychange", () => shown.forEach(arrived));

  // A thread opened or closed, in the panel, a popover or the sheet, all of
  // which draw it (the thread-list part's draw). Opened, it posts its newest
  // comment's id as seen, and keeps any comments unread marked while it
  // stays open; closed, it marks only what is still unread.
  function looked(thread: Thread, open: boolean) {
    if (!open) {
      if (opening.delete(thread.root.id)) markUnread(thread);
      return;
    }
    if (!tracked.value) return;
    const fresh = rows(thread).filter(entry => counted(thread, entry));
    if (fresh.length) {
      opening.set(thread.root.id, new Set(fresh.map(entry => entry.id)));
      markUnread(thread);
    }
    void seeThread(thread);
  }

  // A thread the reader resolved is seen up to its newest comment.
  function see(thread: Thread) {
    if (tracked.value) void seeThread(thread);
  }

  // Post that the reader has seen a thread up to its newest comment; the
  // counts drop once it is stored. A failure leaves them as they were.
  async function seeThread(thread: Thread) {
    const newest = rows(thread).reduce((n, entry) => Math.max(n, entry.id), 0);
    try {
      const response = await fetch(SEEN, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page: bridge.page, thread: thread.root.id, comment: newest }),
      });
      const payload = await page.json<{ comment?: unknown }>(response);
      if (response.status === 200 && payload && typeof payload.comment === "number") {
        readTo(thread, payload.comment);
        bridge.refresh();
      }
    } catch {
      // Still unread, as if never opened.
    }
  }

  // Why a question about a decision was not sent.
  function unasked(response: Response, payload: { error?: unknown } | null) {
    if (response.status === 401) return page.signedOut;
    if (response.status === 409 && payload && payload.error === "stale_page") return page.staleQuestion;
    const error = payload && payload.error ? String(payload.error) : "status " + response.status;
    return "Your question was not sent (" + error + "). Try again.";
  }

  // A question about a decision posted as a question thread on it, which
  // saves no answer: once it is sent, sent() runs, then the thread is added
  // and, unless opens is false, opens where the window has room for it. What
  // the form is to say comes back, "" once it is sent; a fetch that fails
  // throws.
  async function ask(question: string, text: string, sent: () => void, opens = true): Promise<string> {
    const body: Question = { page: bridge.page, question, text };
    const revision = bridge.revision();
    if (revision !== null) body.revision = revision;
    const response = await fetch(page.commentsURL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await page.json(response);
    if (response.status !== 201 || !payload) return unasked(response, payload);
    sent();
    bridge.add({ root: payload, replies: [] });
    bridge.posted();
    if (opens) bridge.placement().asked(shown.get(payload.id));
    return "";
  }

  return {
    opening, counted, unreadIn, readTo, showUnread, looked, see, ask,
    // A swap gave the tab the new revision's title.
    retitle() {
      tabTitle.value = document.title;
    },
  };
}
