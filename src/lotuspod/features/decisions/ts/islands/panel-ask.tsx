import { useLayoutEffect, useRef } from "preact/hooks";
import type { Asking } from "../../../comments/ts/index";
import { words } from "./words";

// A question's unsent Ask, which the Decisions tab keeps for each question
// so it outlives the entry it was written in, a section swapped under it
// and a send still pending: whether its field is open, its text, what it
// last said and whether a send is pending. now() reads the text as last set.
export interface Draft {
  open: boolean;
  text: string;
  said: string;
  busy: boolean;
  show(open: boolean): void;
  set(text: string): void;
  tell(said: string): void;
  sending(busy: boolean): void;
  now(): string;
}

// A question's own Ask: the field's text posted as a question thread on the
// decision, as the card's Ask posts the note, which it leaves alone. Sent,
// the field empties and closes, and the panel stays on Decisions; a field
// changed while it was sending keeps what it holds, not yet sent. A refused
// post keeps the text and says why. The text is the tab's, so closing the
// field with the entry's Ask keeps it, and a question saved meanwhile
// carries it to its Answered row; Cancel empties it. Drawn where the reader
// opened it, it takes the focus.
export function Ask({ form, asking, draft, done, focused = true }: {
  form: HTMLFormElement;
  asking: Asking;
  draft: Draft;
  done(): void;
  focused?: boolean;
}) {
  const { text, said, busy } = draft;
  const field = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (focused) field.current?.focus({ preventScroll: true });
  }, []);
  const number = words(form, ".artifact-decision-number");
  async function send(): Promise<void> {
    const question = text.trim();
    if (!question) {
      draft.tell("Write your question first.");
      return;
    }
    draft.sending(true);
    draft.tell("Sending your question...");
    try {
      draft.tell(await asking.ask(form.dataset.question!, question, () => {
        if (draft.now() !== text) return;
        draft.set("");
        draft.show(false);
        done();
      }, false));
    } catch {
      draft.tell("Your question was not sent: the site did not answer. Try again.");
    } finally {
      draft.sending(false);
    }
  }
  return (
    <div class="artifact-decisions-asking">
      <textarea rows={2} maxLength={4000} value={text} ref={field}
        aria-label={"Ask about decision " + (number || words(form, ".artifact-decision-text"))}
        onInput={(event) => draft.set(event.currentTarget.value)} />
      <div class="artifact-decisions-asking-foot">
        <button type="button" class="artifact-decisions-ask-send" disabled={busy} onClick={send}>Ask</button>
        <button type="button" class="artifact-decisions-cancel" onClick={() => {
          draft.set("");
          draft.tell("");
          draft.show(false);
          done();
        }}>Cancel</button>
        <span class="artifact-decisions-ask-status" role="status">{said}</span>
      </div>
    </div>
  );
}
