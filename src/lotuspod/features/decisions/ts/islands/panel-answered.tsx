import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { Context, Note, Options, type Desk } from "./panel-parts";
import { jump, sectionsOf } from "./sections";
import { label, noteOf, words } from "./words";

// One saved question. Collapsed: its number and question, which open it, its
// answer's label, who saved it and when as its card says, and "change",
// which opens it too. Open in place: its context lines, its options with the
// card's pick, its note, Save, Cancel, "not saved" while the card differs
// from its answer, and Show on page. A pick or a note opens the card on the
// page as its "change" does; Cancel puts the card back as saved. It is
// drawn again as the cards change.
function Row({ desk, form }: { desk: Desk; form: HTMLFormElement }) {
  desk.marked.value;
  const question = form.dataset.question ?? "";
  const answer = desk.saved(form);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const item = useRef<HTMLLIElement>(null);
  // What to focus once the row is drawn open or collapsed.
  const focus = useRef<"pick" | "title" | null>(null);
  useLayoutEffect(() => {
    const to = focus.current;
    focus.current = null;
    if (to === "pick") {
      const options = item.current?.querySelectorAll<HTMLInputElement>(".artifact-decisions-option input");
      const picked = Array.from(options ?? []).find((input) => input.checked) ?? options?.[0];
      picked?.focus({ preventScroll: true });
    } else if (to === "title") {
      item.current?.querySelector<HTMLElement>(".artifact-decisions-row-title")?.focus({ preventScroll: true });
    }
  });
  if (!answer) {
    return null;
  }
  const number = words(form, ".artifact-decision-number");
  const title = (number ? number + " · " : "") + words(form, ".artifact-decision-text");
  const changed = desk.dirty(form);
  const touched = () => desk.reopen(form);
  function show(on: boolean, to: "pick" | "title"): void {
    focus.current = to;
    setOpen(on);
  }
  async function save(): Promise<void> {
    setBusy(true);
    const done = await desk.save(form);
    setBusy(false);
    if (done && !desk.dirty(form)) show(false, "title");
  }
  function cancel(): void {
    desk.restore(form);
    show(false, "title");
  }
  return (
    <li ref={item} class={"artifact-decisions-row" + (open ? " artifact-decisions-row--open" : "") +
      (changed ? " artifact-decisions-row--dirty" : "")} data-question={question}>
      <button type="button" class="artifact-decisions-row-title" aria-expanded={open}
        onClick={() => show(!open, open ? "title" : "pick")}>{title}</button>
      {open ? (
        <>
          <Context form={form} />
          <Options form={form} name={"artifact-decisions-answered-" + question} touched={touched} />
          <Note desk={desk} form={form} summary={noteOf(answer) ? "Edit note" : "Add a note"} touched={touched} />
          <div class="artifact-decisions-foot">
            <button type="button" class="artifact-decisions-save" disabled={busy} onClick={save}>Save</button>
            <button type="button" class="artifact-decisions-cancel" onClick={cancel}>Cancel</button>
            <span class="artifact-decisions-unsaved" hidden={!changed}>not saved</span>
            <button type="button" class="artifact-decisions-show" onClick={() => jump(form)}>Show on page</button>
          </div>
        </>
      ) : (
        <p class="artifact-decisions-row-answer">
          <strong class="artifact-decisions-row-label">{label(form, answer)}</strong>
          {" "}<span class="artifact-decisions-row-by">{words(form, ".artifact-decision-saved-by")}</span>
          {" · "}
          <button type="button" class="artifact-decisions-change" onClick={() => show(true, "pick")}>change</button>
          {changed && <>{" "}<span class="artifact-decisions-unsaved">not saved</span></>}
        </p>
      )}
    </li>
  );
}

// The questions with a saved answer that is not a dismissal, folded under
// "Answered · N" until the reader opens it, under the open list's section
// headings in page order.
export function Answered({ desk, forms, open, toggled }: {
  desk: Desk;
  forms: readonly HTMLFormElement[];
  open: boolean;
  toggled(open: boolean): void;
}) {
  if (!forms.length) {
    return null;
  }
  return (
    <details class="artifact-decisions-answered" open={open}
      onToggle={(event) => toggled((event.currentTarget as HTMLDetailsElement).open)}>
      <summary>{"Answered · " + forms.length}</summary>
      {sectionsOf(forms).map((section) => (
        <section key={section.key} class="artifact-decisions-answered-group">
          <h3 class="artifact-decisions-answered-title">{section.title}</h3>
          <ol class="artifact-decisions-rows">
            {section.forms.map((form) => <Row key={form.dataset.question} desk={desk} form={form} />)}
          </ol>
        </section>
      ))}
    </details>
  );
}
