import { useState } from "preact/hooks";
import type { ReadonlySignal } from "@preact/signals";
import type { Answer } from "../../../comments/ts/index";
import { all, boxes, isChecklist, optionText } from "./checklist";
import { fold, noteField, radios, words } from "./words";

// What the Decisions tab reads the page's decision cards by: the forms and
// their inputs are the one state, the cards' own, so the tab never holds a
// pick or a note of its own.
export interface Desk {
  // The page's decision forms, in page order.
  readonly forms: HTMLFormElement[];
  // Counts each change to a card: a pick, a note or a draw.
  readonly marked: ReadonlySignal<number>;
  // True once the page's answers are read.
  readonly ready: ReadonlySignal<boolean>;
  saved(form: HTMLFormElement): Answer | null;
  dirty(form: HTMLFormElement): boolean;
  // Whether the question has no saved answer.
  toAnswer(form: HTMLFormElement): boolean;
  // Post the form's answer in its turn, as its "Save answer" does.
  save(form: HTMLFormElement): Promise<boolean>;
  // Open a card folded to its answer, as its "change" does, the focus and
  // the scroll left where they are.
  reopen(form: HTMLFormElement): void;
  // Open a collapsed card straight to its options, as an Answered row's
  // "change" does; a card not collapsed is left as it is.
  expand(form: HTMLFormElement): void;
  // Put back the card's saved pick and note, and fold it to its answer.
  restore(form: HTMLFormElement): void;
}

// Tell the card an input moved, as the reader's own pick or typing would.
function moved(input: HTMLInputElement | HTMLTextAreaElement, type: "change" | "input"): void {
  input.dispatchEvent(new Event(type, { bubbles: true }));
}

// The card's context lines.
export function Context({ form }: { form: HTMLFormElement }) {
  return (
    <>
      {all<HTMLParagraphElement>("p.artifact-decision-context", form).map((line, at) => (
        // The renderer's own markup, so a link in the context stays a link.
        <p key={at} class="artifact-decision-context" dangerouslySetInnerHTML={{ __html: line.innerHTML }} />
      ))}
    </>
  );
}

// The card's options as radio rows (a checklist's items as checkboxes), each
// the card's own input: a pick here picks it there, then touched() runs.
export function Options({ form, name, touched }: { form: HTMLFormElement; name: string; touched?: () => void }) {
  const checklist = isChecklist(form);
  const inputs = checklist ? boxes(form) : radios(form);
  return (
    <div class="artifact-decisions-options" role={checklist ? "group" : "radiogroup"}
      aria-label={words(form, ".artifact-decision-text")}>
      {inputs.map((input) => {
        const mark = input.parentNode!.querySelector(".artifact-decision-default");
        return (
          <label key={input.value} class="artifact-decisions-option">
            {checklist ?
              <input type="checkbox" value={input.value} checked={input.checked} onChange={(event) => {
                input.checked = event.currentTarget.checked;
                moved(input, "change");
                touched?.();
              }} /> :
              <input type="radio" name={name} value={input.value} checked={input.checked} onChange={() => {
                input.checked = true;
                moved(input, "change");
                touched?.();
              }} />}
            {" "}<span class="artifact-decision-label">{optionText(input)}</span>
            {mark && <>{" "}<span class="artifact-decision-default">{(mark.textContent ?? "").trim()}</span></>}
          </label>
        );
      })}
    </div>
  );
}

// The card's note, under summary: typing here writes the card's, opens it
// there, then touched() runs. It is drawn again as the cards change, as a
// note written on the card shows here.
export function Note({ desk, form, summary, touched }: {
  desk: Desk;
  form: HTMLFormElement;
  summary: string;
  touched?: () => void;
}) {
  desk.marked.value;
  const note = noteField(form);
  const [noting, setNoting] = useState(() => Boolean(note.value));
  return (
    <details class="artifact-decisions-note" open={noting}
      onToggle={(event) => setNoting((event.currentTarget as HTMLDetailsElement).open)}>
      <summary>{summary}</summary>
      <textarea rows={2} maxLength={4000} aria-label="Note" value={note.value} onInput={(event) => {
        note.value = event.currentTarget.value;
        fold(note, true);
        moved(note, "input");
        touched?.();
      }} />
    </details>
  );
}
