import { render } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { effect, untracked } from "@preact/signals";
import { decisionsTab, store, type Asking } from "../../../comments/ts/index";
import { Answered } from "./panel-answered";
import { Context, Note, Options, type Desk } from "./panel-parts";
import { jump, sectionsOf } from "./sections";
import { label, words } from "./words";

export type { Desk } from "./panel-parts";

// How long an entry saved from the tab reads "✓ Saved · LABEL" before it
// leaves the list.
const SAVED_FOR = 1600;

// A question's own Ask, under its entry: the field's text posted as a
// question thread on the decision, as the card's Ask posts the note, which
// it leaves alone. Sent, the field empties and closes, and the panel stays
// on Decisions; a refused post keeps the text and says why.
function Ask({ form, asking, done }: { form: HTMLFormElement; asking: Asking; done(): void }) {
  const [text, setText] = useState("");
  const [said, setSaid] = useState("");
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => field.current?.focus({ preventScroll: true }), []);
  const number = words(form, ".artifact-decision-number");
  async function send(): Promise<void> {
    const question = text.trim();
    if (!question) {
      setSaid("Write your question first.");
      return;
    }
    setBusy(true);
    setSaid("Sending your question...");
    try {
      setSaid(await asking.ask(form.dataset.question!, question, () => {
        setText("");
        done();
      }, false));
    } catch {
      setSaid("Your question was not sent: the site did not answer. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div class="artifact-decisions-asking">
      <textarea rows={2} maxLength={4000} value={text} ref={field}
        aria-label={"Ask about decision " + (number || words(form, ".artifact-decision-text"))}
        onInput={(event) => setText(event.currentTarget.value)} />
      <div class="artifact-decisions-asking-foot">
        <button type="button" class="artifact-decisions-ask-send" disabled={busy} onClick={send}>Ask</button>
        <button type="button" class="artifact-decisions-cancel" onClick={done}>Cancel</button>
        <span class="artifact-decisions-ask-status" role="status">{said}</span>
      </div>
    </div>
  );
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
// context lines, its options (a checklist's items), its note, Save, its own
// Ask, "not saved" while the card differs from its saved answer, Show on
// page, and a link to its newest open thread.
function Entry({ desk, form, held, saving, saved }: EntryProps) {
  const question = form.dataset.question ?? "";
  const answer = desk.saved(form);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const askButton = useRef<HTMLButtonElement>(null);
  if (held && answer && !desk.dirty(form)) {
    return (
      <li class="artifact-decisions-entry artifact-decisions-entry--saved" data-question={question}>
        <p class="artifact-decisions-saved" tabIndex={-1}>
          <span class="artifact-decision-saved-mark"><span class="artifact-decision-check" aria-hidden="true">✓</span>{" Saved"}</span>
          {" · "}<strong>{label(form, answer)}</strong>
        </p>
      </li>
    );
  }
  const number = words(form, ".artifact-decision-number");
  const summary = words(form, "details.artifact-decision-note > summary") || "Add a note";
  const asker = store.asking.value;
  const threads = asker?.about(question) ?? null;
  async function save(): Promise<void> {
    setBusy(true);
    saving(form);
    const done = await desk.save(form);
    setBusy(false);
    saved(form, done);
  }
  function asked(): void {
    setAsking(false);
    askButton.current?.focus({ preventScroll: true });
  }
  return (
    <li class={"artifact-decisions-entry" + (desk.dirty(form) ? " artifact-decisions-entry--dirty" : "")}
      data-question={question}>
      <button type="button" class="artifact-decisions-question" onClick={() => jump(form)}>
        {number && <><span class="artifact-decision-number">{number}</span>{" "}</>}
        {words(form, ".artifact-decision-text")}
      </button>
      <Context form={form} />
      <Options form={form} name={"artifact-decisions-" + question} />
      <Note desk={desk} form={form} summary={summary} />
      <div class="artifact-decisions-foot">
        <button type="button" class="artifact-decisions-save" disabled={busy} onClick={save}>Save</button>
        {asker && <button ref={askButton} type="button" class="artifact-decisions-ask" aria-expanded={asking}
          onClick={() => setAsking(!asking)}>Ask</button>}
        <span class="artifact-decisions-unsaved" hidden={!desk.dirty(form)}>not saved</span>
        <button type="button" class="artifact-decisions-show" onClick={() => jump(form)}>Show on page</button>
      </div>
      {asker && asking && <Ask form={form} asking={asker} done={asked} />}
      {threads && (
        <button type="button" class="artifact-decisions-threads" onClick={threads.open}>
          <span class="artifact-decisions-threads-mark" aria-hidden="true">?</span>
          <span class="artifact-decisions-threads-count">{threads.count === 1 ? "1 thread" : threads.count + " threads"}</span>
          {" · "}<span class="artifact-decisions-threads-standing">{threads.standing}</span>
        </button>
      )}
    </li>
  );
}

// The questions with no saved answer, under one heading per section, as the
// Comments tab heads its groups; one just saved from the tab stays a moment,
// as saved, then leaves for the Answered list after them, and its heading
// with the last of its section. The list stays folded or open as the reader
// left it.
function Panel({ desk }: { desk: Desk }) {
  desk.marked.value;
  const [held, setHeld] = useState<ReadonlySet<HTMLFormElement>>(new Set());
  const kept = useRef(new Set<HTMLFormElement>());
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
  const [answeredOpen, setAnsweredOpen] = useState(false);
  if (!desk.ready.value) {
    return null;
  }
  // Each entry's thread link reads the store's threads.
  for (const id of store.threadIds.value) store.thread(id).value;
  // Whether a form is still the page's: a swap may replace one while its
  // save or its saved moment is pending, and a replaced form has no card.
  const asked = (form: HTMLFormElement) => desk.forms.includes(form);
  // A form saved from the tab while the reader changed it again stays listed,
  // not saved, until it is saved or put back: the confirmation would hide
  // what is still unsaved.
  for (const form of kept.current) {
    if (!asked(form) || !desk.dirty(form)) kept.current.delete(form);
  }
  const listed = desk.forms.filter((form) => desk.toAnswer(form) || held.has(form) || kept.current.has(form));
  // A dismissal is in neither list: its card and the Answered table show it.
  const answered = desk.forms.filter((form) => {
    const answer = desk.saved(form);
    return answer !== null && !answer.dismissed && !listed.includes(form);
  });
  function hold(form: HTMLFormElement, on: boolean): void {
    setHeld((was) => {
      const next = new Set(was);
      if (on) next.add(form); else next.delete(form);
      return next;
    });
  }
  function saved(form: HTMLFormElement, done: boolean): void {
    if (!asked(form)) {
      hold(form, false);
      return;
    }
    if (!done || desk.dirty(form)) {
      if (done) kept.current.add(form);
      hold(form, false);
      return;
    }
    setTimeout(() => {
      if (!asked(form)) {
        hold(form, false);
        return;
      }
      if (desk.dirty(form)) {
        kept.current.add(form);
        hold(form, false);
        return;
      }
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
      <Answered desk={desk} forms={answered} open={answeredOpen} toggled={setAnsweredOpen} />
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
