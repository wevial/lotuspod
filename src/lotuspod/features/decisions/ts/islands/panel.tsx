import { render } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { effect, untracked, type ReadonlySignal } from "@preact/signals";
import { decisionsTab, type Answer } from "../../../comments/ts/index";
import { all, boxes, isChecklist, optionText } from "./checklist";
import { jump, sectionsOf } from "./sections";
import { label, noteField, radios, words } from "./words";

// How long an entry saved from the tab reads "✓ Saved · LABEL" before it
// leaves the list.
const SAVED_FOR = 1600;

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
}

// Tell the card an input moved, as the reader's own pick or typing would.
function moved(input: HTMLInputElement | HTMLTextAreaElement, type: "change" | "input"): void {
  input.dispatchEvent(new Event(type, { bubbles: true }));
}

interface EntryProps {
  desk: Desk;
  form: HTMLFormElement;
  // Saved from the tab a moment ago: shown as saved until it leaves.
  held: boolean;
  saving(form: HTMLFormElement): void;
  saved(form: HTMLFormElement, done: boolean): void;
}

// One question: its number and text, which jump to its card, the card's
// context lines, its options (a checklist's items), its note, Save, "not
// saved" while the card differs from its saved answer, and Show on page.
function Entry({ desk, form, held, saving, saved }: EntryProps) {
  const question = form.dataset.question ?? "";
  const answer = desk.saved(form);
  const note = noteField(form);
  const [noting, setNoting] = useState(() => Boolean(note.value));
  const [busy, setBusy] = useState(false);
  if (held && answer) {
    return (
      <li class="artifact-decisions-entry artifact-decisions-entry--saved" data-question={question}>
        <p class="artifact-decisions-saved" tabIndex={-1}>
          <span class="artifact-decision-saved-mark"><span class="artifact-decision-check" aria-hidden="true">✓</span>{" Saved"}</span>
          {" · "}<strong>{label(form, answer)}</strong>
        </p>
      </li>
    );
  }
  const checklist = isChecklist(form);
  const number = words(form, ".artifact-decision-number");
  const inputs = checklist ? boxes(form) : radios(form);
  const summary = words(form, "details.artifact-decision-note > summary") || "Add a note";
  async function save(): Promise<void> {
    setBusy(true);
    saving(form);
    const done = await desk.save(form);
    setBusy(false);
    saved(form, done);
  }
  return (
    <li class={"artifact-decisions-entry" + (desk.dirty(form) ? " artifact-decisions-entry--dirty" : "")}
      data-question={question}>
      <button type="button" class="artifact-decisions-question" onClick={() => jump(form)}>
        {number && <><span class="artifact-decision-number">{number}</span>{" "}</>}
        {words(form, ".artifact-decision-text")}
      </button>
      {all<HTMLParagraphElement>("p.artifact-decision-context", form).map((line, at) => (
        // The renderer's own markup, so a link in the context stays a link.
        <p key={at} class="artifact-decision-context" dangerouslySetInnerHTML={{ __html: line.innerHTML }} />
      ))}
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
                }} /> :
                <input type="radio" name={"artifact-decisions-" + question} value={input.value}
                  checked={input.checked} onChange={() => {
                    input.checked = true;
                    moved(input, "change");
                  }} />}
              {" "}<span class="artifact-decision-label">{optionText(input)}</span>
              {mark && <>{" "}<span class="artifact-decision-default">{(mark.textContent ?? "").trim()}</span></>}
            </label>
          );
        })}
      </div>
      <details class="artifact-decisions-note" open={noting}
        onToggle={(event) => setNoting((event.currentTarget as HTMLDetailsElement).open)}>
        <summary>{summary}</summary>
        <textarea rows={2} maxLength={4000} aria-label="Note" value={note.value} onInput={(event) => {
          note.value = event.currentTarget.value;
          const box = note.closest("details");
          if (box) box.open = true;
          moved(note, "input");
        }} />
      </details>
      <div class="artifact-decisions-foot">
        <button type="button" class="artifact-decisions-save" disabled={busy} onClick={save}>Save</button>
        <span class="artifact-decisions-unsaved" hidden={!desk.dirty(form)}>not saved</span>
        <button type="button" class="artifact-decisions-show" onClick={() => jump(form)}>Show on page</button>
      </div>
    </li>
  );
}

// The questions with no saved answer, under one heading per section, as the
// Comments tab heads its groups; one just saved from the tab stays a moment,
// as saved, then leaves, and its heading with the last of its section.
function Panel({ desk }: { desk: Desk }) {
  desk.marked.value;
  const [held, setHeld] = useState<ReadonlySet<HTMLFormElement>>(new Set());
  const root = useRef<HTMLDivElement>(null);
  // The question to give the focus to once a saved entry leaves.
  const after = useRef<string | null>(null);
  useLayoutEffect(() => {
    const flash = root.current?.querySelector<HTMLElement>(".artifact-decisions-saved");
    if (flash && document.activeElement === document.body) {
      flash.focus({ preventScroll: true });
    }
    if (after.current !== null && (document.activeElement === document.body || !document.activeElement)) {
      const next = Array.from(root.current?.querySelectorAll<HTMLElement>(".artifact-decisions-entry") ?? [])
        .find((item) => item.dataset.question === after.current);
      next?.querySelector<HTMLElement>(".artifact-decisions-question")?.focus({ preventScroll: true });
    }
    after.current = null;
  });
  if (!desk.ready.value) {
    return null;
  }
  const listed = desk.forms.filter((form) => desk.toAnswer(form) || held.has(form));
  function hold(form: HTMLFormElement, on: boolean): void {
    setHeld((was) => {
      const next = new Set(was);
      if (on) next.add(form); else next.delete(form);
      return next;
    });
  }
  function saved(form: HTMLFormElement, done: boolean): void {
    if (!done) {
      hold(form, false);
      return;
    }
    setTimeout(() => {
      const at = listed.indexOf(form);
      const rest = desk.forms.filter((each) => desk.toAnswer(each) && each !== form);
      const next = listed.slice(at + 1).find((each) => rest.includes(each)) ?? rest[0];
      const focused = root.current?.querySelector(".artifact-decisions-saved") === document.activeElement;
      after.current = focused && next ? next.dataset.question ?? null : null;
      hold(form, false);
    }, SAVED_FOR);
  }
  return (
    <div ref={root} class="artifact-decisions-panel">
      {listed.length ? sectionsOf(listed).map((section) => (
        <section key={section.key} class="artifact-decisions-group">
          <h3 class="artifact-decisions-group-title">{section.title}</h3>
          <ol class="artifact-decisions-entries">
            {section.forms.map((form) => (
              <Entry key={form.dataset.question} desk={desk} form={form} held={held.has(form)}
                saving={(each) => hold(each, true)} saved={saved} />
            ))}
          </ol>
        </section>
      )) : <p class="artifact-decisions-none">Nothing left to answer</p>}
    </div>
  );
}

// The Decisions tab, drawn into the node the comments panel gives it once
// it has one, and the count of questions to answer it and the rail show.
export function decisionsPanel(desk: Desk, asks: () => boolean): void {
  effect(() => {
    desk.marked.value;
    const ready = desk.ready.value;
    untracked(() => {
      decisionsTab.asks.value = asks();
      decisionsTab.count.value = ready && asks() ? desk.forms.filter(desk.toAnswer).length : null;
    });
  });
  effect(() => {
    const node = decisionsTab.node.value;
    if (node) untracked(() => render(<Panel desk={desk} />, node));
  });
}
