import type { CommentRow, Page, Saved, Thread } from "../bridge";
import type { Placement } from "./parts";

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
// (signed out, the demo) marks nothing. With them, each decision's Ask.
export function replies(page: Page, bridge: RepliesBridge) {
  const { shown, rows, markUnread } = bridge;
  let unread = new Set<unknown>();
  // Whether the route named any: only then is a thread opened posted.
  let tracked = false;
  const seenTo = new Map<number, number>();
  const opening = new Map<number, Set<number>>();
  let tabTitle = document.title;
  const dateLine = document.querySelector("header.artifact-header .artifact-meta");
  let newBadge: HTMLSpanElement | null = null;

  // A read named the comments unread to the reader, or named none.
  function named(ids: unknown) {
    tracked = Array.isArray(ids);
    unread = new Set<unknown>(Array.isArray(ids) ? ids : []);
  }

  // Whether a comment counts as unread: the route named it, and neither a
  // mark this page posted nor the reader's own reply since has read it.
  function counted(thread: Thread, entry: CommentRow) {
    return unread.has(entry.id) && entry.id > (seenTo.get(thread.root.id) || 0);
  }

  // How many comments in some threads count as unread.
  function unreadIn(threads: Thread[]) {
    return threads.reduce((n, thread) => n + rows(thread).filter(entry => counted(thread, entry)).length, 0);
  }

  // The thread is read up to comment id: by a mark posted, or the reader's
  // own reply.
  function readTo(thread: Thread, id: number) {
    seenTo.set(thread.root.id, Math.max(seenTo.get(thread.root.id) || 0, id));
  }

  // Draw the replies to the reader outside the chips: each thread's marks,
  // the badge ending the header's date line and the tab's title.
  function showUnread() {
    const threads = [...shown.values()];
    threads.forEach(markUnread);
    const n = unreadIn(threads);
    document.title = n > 0 ? "(" + n + ") " + tabTitle : tabTitle;
    if (!dateLine) return;
    if (n > 0) {
      newBadge = newBadge || page.element("span", "artifact-unread");
      newBadge.textContent = (n === 1 ? "1 new reply" : n + " new replies") + " to you";
      if (dateLine.lastChild !== newBadge) dateLine.appendChild(newBadge);
    } else if (newBadge) {
      newBadge.remove();
    }
  }

  // A thread opened or closed, in the panel, a popover or the sheet, all of
  // which draw it (the thread-list part's draw). Opened, it posts its newest
  // comment's id as seen, and keeps any comments unread marked while it
  // stays open; closed, it marks only what is still unread.
  function looked(thread: Thread, open: boolean) {
    if (!open) {
      if (opening.delete(thread.root.id)) markUnread(thread);
      return;
    }
    if (!tracked) return;
    const fresh = rows(thread).filter(entry => counted(thread, entry));
    if (fresh.length) {
      opening.set(thread.root.id, new Set(fresh.map(entry => entry.id)));
      markUnread(thread);
    }
    void seeThread(thread);
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

  // An answer saved with a note opens a thread on its decision, or adds to
  // one: the threads are read again at once, so its chip shows it. A read
  // already in flight may have missed it, and is followed by another; one
  // that fails is tried again after the schedule's first gap.
  function noted(event: Event) {
    if (!(event as CustomEvent<Saved>).detail.comment) return;
    bridge.owe();
  }

  // Each decision's Ask, beside "Save answer": the note's text posted as a
  // question thread on the decision, which saves no answer. Sent, the note
  // is emptied and folded, so it is never saved as the answer's note, and
  // the thread opens where the window has room for it.
  function askAbout(form: HTMLFormElement) {
    form.addEventListener(page.events.saved, noted);
    const save = form.querySelector('button[type="submit"]');
    const note = form.elements.namedItem("note");
    if (!save || !(note instanceof HTMLTextAreaElement || note instanceof HTMLInputElement)) return;
    const button = page.element("button", "artifact-decision-ask", "Ask");
    button.type = "button";
    save.parentNode!.insertBefore(button, save.nextSibling);
    const status = form.querySelector(".artifact-decision-status");
    function say(text: string) {
      if (status) status.textContent = text;
    }
    button.addEventListener("click", async () => {
      const sent = note.value;
      const text = sent.trim();
      if (!text) {
        say(page.noQuestion);
        return;
      }
      const body: Question = { page: bridge.page, question: form.dataset.question!, text };
      const revision = bridge.revision();
      if (revision !== null) body.revision = revision;
      button.disabled = true;
      say("Sending your question...");
      try {
        const response = await fetch(page.commentsURL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const payload = await page.json(response);
        if (response.status !== 201 || !payload) {
          say(unasked(response, payload));
          return;
        }
        say("");
        // A note changed while the question was sending holds a question
        // not yet sent: it stays, open, and the card keeps it unsaved.
        if (note.value === sent) {
          note.value = "";
          const fold = note.closest("details");
          if (fold) fold.open = false;
          // The card marks itself as its note now reads.
          note.dispatchEvent(new Event("input", { bubbles: true }));
        }
        bridge.add({ root: payload, replies: [] });
        bridge.posted();
        bridge.placement().asked(shown.get(payload.id));
      } catch {
        say("Your question was not sent: the site did not answer. Try again.");
      } finally {
        button.disabled = false;
      }
    });
  }

  return {
    opening, named, counted, unreadIn, readTo, showUnread, looked, askAbout,
    // A swap gave the tab the new revision's title.
    retitle() {
      tabTitle = document.title;
    },
  };
}
