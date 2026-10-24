import { batch } from "@preact/signals";
import type { Answer, Answers, StoreState } from "./state";
import { shared, UNANSWERED } from "./state";

// What the answers route gives for a page: each question asked on it, by
// its id, with its current answer and those it replaced.
interface Read { questions?: Record<string, { current?: Answer | null; earlier?: Answer[] | null } | null> | null }

// What a post to the answers route got: its response and its JSON, null
// when it is none.
export interface Posted<T> { response: Response; payload: T | null }

// What the answers part reaches the page by.
interface AnswersPage {
  answersURL: string;
  json<T>(response: Response): Promise<T | null>;
}

// The page's answers to its decisions, read from and posted to the answers
// route, held in the store's signals, one per question. A read writes each
// question it names, but not over a post on it that landed after the read
// began, which is newer; a post that is saved writes its question.
export function answerStore(page: AnswersPage, state: StoreState = shared) {
  // The newest read begun, by its turn, and each question's last post, by
  // the turn of the reads it followed.
  let reads = 0;
  let posts = 0;
  const postedAt = new Map<string, number>();

  // True once the page's answers are read and written; false when the read
  // failed; null for a read a newer one has replaced, which writes nothing.
  async function read(name: string): Promise<boolean | null> {
    const turn = ++reads;
    const since = posts;
    let questions: Read["questions"] = null;
    try {
      const response = await fetch(page.answersURL + "?page=" + encodeURIComponent(name));
      questions = response.ok ? ((await response.json()) as Read).questions || {} : null;
    } catch {
      questions = null;
    }
    if (turn !== reads) return null;
    if (!questions) return false;
    const given = questions;
    batch(() => {
      // A question answered before that the read no longer names has none
      // left.
      for (const question of new Set([...Object.keys(given), ...state.currents.peek().map(each => String(each.question))])) {
        if ((postedAt.get(question) ?? -1) >= since) continue;
        const entry = Object.prototype.hasOwnProperty.call(given, question) ? given[question] : null;
        state.write.answered(question, entry ?
          { current: entry.current || null, earlier: (entry.earlier || []).slice() } : UNANSWERED);
      }
    });
    return true;
  }

  async function post<T>(question: string, body: object, saved: number,
    then: (payload: T, was: Answers) => Answers): Promise<Posted<T>> {
    const response = await fetch(page.answersURL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await page.json<T>(response);
    if (response.status === saved && payload) {
      postedAt.set(question, posts++);
      state.write.answered(question, then(payload, state.answer(question).peek()));
    }
    return { response, payload };
  }

  // The answer replacing the current one, which goes first among those it
  // replaced.
  function replacing(answer: Answer, was: Answers): Answers {
    return { current: answer, earlier: was.current ? [was.current, ...was.earlier] : was.earlier.slice() };
  }

  return {
    read,
    // Post an answer (a choice or a checklist's items, with a note), 201
    // once saved; the comment its note opened goes with the payload, not
    // the answer.
    save(question: string, body: object): Promise<Posted<Answer & { comment?: unknown }>> {
      return post(question, body, 201, (payload: Answer & { comment?: unknown }, was) => {
        const answer: Answer & { comment?: unknown } = { ...payload };
        delete answer.comment;
        return replacing(answer, was);
      });
    },
    // Dismiss a decision, the reason given, 201 once dismissed.
    dismiss(question: string, body: object): Promise<Posted<Answer>> {
      return post(question, body, 201, (payload: Answer, was) => replacing(payload, was));
    },
    // Take a dismissal back, 200 with the answers left.
    undo(question: string, body: object): Promise<Posted<{ current: Answer | null; earlier: Answer[] }>> {
      return post(question, body, 200, (payload: { current: Answer | null; earlier: Answer[] }) =>
        ({ current: payload.current, earlier: payload.earlier.slice() }));
    },
  };
}

export type AnswerStore = ReturnType<typeof answerStore>;
