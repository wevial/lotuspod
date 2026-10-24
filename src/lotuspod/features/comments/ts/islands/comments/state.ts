import { batch, computed, signal, type ReadonlySignal, type Signal } from "@preact/signals";
import type { CommentRow, Resolution } from "../bridge";

// A thread as the comments route gives it, or as a post adds one.
export interface Read { root?: CommentRow | null; replies?: CommentRow[] | null; resolution?: Resolution | null }

// A thread as the store holds it: its first comment, its replies by id and
// whether it is resolved, never changed in place.
export interface ThreadState {
  readonly root: CommentRow;
  readonly replies: readonly CommentRow[];
  readonly resolution: Resolution | null;
}

// A stored answer to a decision, as the answers route gives it: a choice, a
// checklist's items checked, or a dismissal, who gave it and when.
export interface Answer {
  id: number;
  question?: string;
  version?: string;
  choice?: string;
  checked?: string[];
  note?: string;
  dismissed?: boolean;
  source?: string;
  supersedes?: unknown;
  createdAt?: string;
  actor?: CommentRow["actor"];
  // The words it was given in: a checklist's or an earlier wording's.
  asked?: { label?: unknown; text?: unknown } | null;
}

// What the drafts told a form: why a draft came to it.
export interface Mark { readonly why: string }

// A question's answers: the current one, if any, and those it replaced,
// newest first.
export interface Answers {
  readonly current: Answer | null;
  readonly earlier: readonly Answer[];
}

export const UNANSWERED: Answers = Object.freeze({ current: null, earlier: Object.freeze([]) as readonly Answer[] });

// A decision's open threads, as the Decisions tab links to them: how many,
// where the newest stands, as its chip reads it, and opening it as the
// decision's chip does.
export interface Asked {
  count: number;
  standing: "answered" | "writing" | "waiting" | "failed";
  open(): void;
}

// What the decisions' Ask reaches the threads by, once the store has
// started on a page with comment boxes: ask posts a question about a
// decision, runs sent() once it is sent and, unless opens is false, opens
// its thread, giving back what the form is to say ("" when it is sent); owe
// calls for a read of the threads at once, an answer's note having opened or
// added to one; about gives a question's open threads, null with none.
export interface Asking {
  ask(question: string, text: string, sent: () => void, opens?: boolean): Promise<string>;
  owe(): void;
  about(question: string): Asked | null;
}

// The store's state, in signals, so every island reads the same live state
// and re-renders only on what it reads: each thread by its first comment's
// id, the replies to the reader, the drafts' marks and each question's
// answers. The store's reads and posts write them; what reads them gets
// them read-only.
export function storeState() {
  const threads = new Map<number, Signal<ThreadState | null>>();
  const said = new Map<number, string>();
  const threadIds = signal<readonly number[]>([]);
  // The comment ids the comments route last named unread, whether it named
  // any, and each thread's seen mark as this page last knew it.
  const unread = signal<ReadonlySet<unknown>>(new Set());
  const tracked = signal(false);
  const seenTo = signal<ReadonlyMap<number, number>>(new Map());
  // What the drafts last told each form: why a draft's place is gone, a
  // new mark each time it is told, even in the same words.
  const marks = signal<ReadonlyMap<HTMLFormElement, Mark>>(new Map());
  const answers = new Map<string, Signal<Answers>>();
  const questions = signal<readonly string[]>([]);
  const asking = signal<Asking | null>(null);

  function threadSignal(id: number): Signal<ThreadState | null> {
    let found = threads.get(id);
    if (!found) {
      found = signal<ThreadState | null>(null);
      threads.set(id, found);
    }
    return found;
  }

  // A thread read or posted, merged into what is known of it as the list
  // merges it: its signal changes only when the thread does.
  function take(entry: Read): void {
    const root = entry.root;
    if (!root) return;
    const thread = threadSignal(root.id);
    const known = thread.peek();
    const replies = new Map((known ? known.replies : []).map(reply => [reply.id, reply]));
    for (const reply of entry.replies || []) {
      if (reply && reply.id !== root.id) replies.set(reply.id, reply);
    }
    const next: ThreadState = {
      root,
      replies: [...replies.values()].sort((a, b) => a.id - b.id),
      resolution: entry.resolution || (known ? known.resolution : null),
    };
    const text = JSON.stringify(next);
    if (said.get(root.id) === text) return;
    said.set(root.id, text);
    batch(() => {
      thread.value = next;
      if (!known) threadIds.value = [...threadIds.peek(), root.id];
    });
  }

  function answerSignal(question: string): Signal<Answers> {
    let found = answers.get(question);
    if (!found) {
      found = signal(UNANSWERED);
      answers.set(question, found);
      questions.value = [...questions.peek(), question];
    }
    return found;
  }

  // A question's answers as a read or a post gives them: its signal
  // changes only when they do.
  function answered(question: string, value: Answers): void {
    const answer = answerSignal(question);
    if (JSON.stringify(answer.peek()) !== JSON.stringify(value)) answer.value = value;
  }

  // Each question's current answer, newest first.
  const currents = computed(() => questions.value
    .map(question => answers.get(question)!.value.current)
    .filter((answer): answer is Answer => answer !== null)
    .sort((a, b) => b.id - a.id));

  return {
    // Read-only, for the islands.
    thread: (id: number): ReadonlySignal<ThreadState | null> => threadSignal(id),
    threadIds: threadIds as ReadonlySignal<readonly number[]>,
    unread: unread as ReadonlySignal<ReadonlySet<unknown>>,
    tracked: tracked as ReadonlySignal<boolean>,
    seenTo: seenTo as ReadonlySignal<ReadonlyMap<number, number>>,
    marks: marks as ReadonlySignal<ReadonlyMap<HTMLFormElement, Mark>>,
    answer: (question: string): ReadonlySignal<Answers> => answerSignal(question),
    currents: currents as ReadonlySignal<readonly Answer[]>,
    asking: asking as ReadonlySignal<Asking | null>,
    // The store's own writers.
    write: {
      take,
      answered,
      named(ids: unknown): void {
        batch(() => {
          tracked.value = Array.isArray(ids);
          unread.value = new Set<unknown>(Array.isArray(ids) ? ids : []);
        });
      },
      readTo(thread: number, id: number): void {
        const at = seenTo.peek().get(thread) || 0;
        if (id > at) seenTo.value = new Map(seenTo.peek()).set(thread, id);
      },
      mark(form: HTMLFormElement, why: string): void {
        marks.value = new Map(marks.peek()).set(form, { why });
      },
      asking(to: Asking | null): void {
        asking.value = to;
      },
    },
  };
}

export type StoreState = ReturnType<typeof storeState>;

// The page's one store state, shared by every island in the bundle.
export const shared: StoreState = storeState();
