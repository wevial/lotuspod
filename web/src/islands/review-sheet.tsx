// The review sheet over a page's decision forms (js/decisions.js), drawn
// once the page's answers are read, and again once each swap's read of
// them is (web/src/page-swap.ts sends ANSWERED after it). Each question's shown choice is its
// picked option, else its stored answer at its version, else its default
// (the form's data-default); it is Open with none, Default at its default
// (a checklist with every box at its default), else Changed, "was:" the
// default's label, or "was: open" with no default. A form with a default
// and no stored answer gets its default picked, so it shows "Not saved":
// on a swap, only a form the swap brought in.
// The title bar ends in "Next open: QUESTION ↓", which jumps to the next
// open question, and "N to answer · Respond", which opens the Respond
// panel: every question under its section's heading, its options as
// pressed buttons (a checklist's as checkboxes), its state, and one Save
// that posts each answer whose shown choice or note is not stored, in page
// order. A page whose answers could not be read gets no sheet, and nor
// does an archived one, which takes no answer.
// Each h2 whose section asks open questions, and its outline link, is
// marked "N open". The panel and the forms are one state: a pick in
// either moves the other. The sheet draws from the forms and the stored
// answers on every change to them; Preact keeps only what is the sheet's
// own, the panel open, a Save under way, what it did and the question Next
// open last jumped to, which a swap keeps.

import { createPortal, Fragment, render } from "preact";
import { useLayoutEffect, useReducer, useRef, useState } from "preact/hooks";
import type { Answering, Page } from "./bridge";

const MARKS = ".artifact-section-mark, .artifact-changed-tag, .artifact-review-open";

interface Question {
  form: HTMLFormElement;
  // The nearest h2 before the form, null before the first.
  heading: HTMLElement | null;
  checklist: boolean;
  text: string;
  number: string;
  // The form's default when it names one of its options, else "".
  fallback: string;
}

// Open, Default or Changed (or Dismissed), the "was" line, and whether the
// shown choice, or the note, differs from the stored answer.
interface Standing {
  name: "Open" | "Default" | "Changed" | "Dismissed";
  was: string;
  pending: boolean;
}

// Where a section's "N open" marks are drawn: a container the island adds
// to its h2, and one to its outline link, if it has one; key tells them
// apart across draws.
interface Marks {
  heading: HTMLElement;
  link: HTMLElement | null;
  key: number;
}

function all<T extends Element>(selector: string, root: ParentNode = document): T[] {
  return Array.from(root.querySelectorAll<T>(selector));
}

function words(node: Element | null): string {
  return node ? (node.textContent ?? "").replace(/\s+/g, " ").trim() : "";
}

// A heading's own words: its fold button's, without the marks in it.
function headingTitle(heading: HTMLElement): string {
  const copy = (heading.querySelector(".artifact-section-toggle") ?? heading).cloneNode(true) as Element;
  for (const mark of all(MARKS, copy)) mark.remove();
  return words(copy);
}

function radios(form: HTMLFormElement): HTMLInputElement[] {
  return all<HTMLInputElement>('input[type="radio"][name="choice"]', form);
}

function boxes(form: HTMLFormElement): HTMLInputElement[] {
  return all<HTMLInputElement>('input[type="checkbox"][name="item"]', form);
}

function radioOf(question: Question, value: string): HTMLInputElement | null {
  return radios(question.form).find((radio) => radio.value === value) ?? null;
}

function picked(form: HTMLFormElement): HTMLInputElement | null {
  return form.querySelector<HTMLInputElement>('input[name="choice"]:checked');
}

// The value of a decision's shown choice; "" when it has none.
function shown(the: Answering, question: Question): string {
  const choice = picked(question.form);
  if (choice) {
    return choice.value;
  }
  const answer = the.saved(question.form);
  return answer ? String(answer.choice) : question.fallback;
}

function label(the: Answering, question: Question, value: string): string {
  const radio = radioOf(question, value);
  return radio ? the.optionText(radio) : value;
}

// A question whose saved answer is a dismissal is Dismissed, never pending,
// so it is never counted nor jumped to as open.
function standing(the: Answering, question: Question): Standing {
  const form = question.form;
  const answer = the.saved(form);
  if (answer && answer.dismissed) {
    return { name: "Dismissed", was: "", pending: false };
  }
  if (question.checklist) {
    const now = the.ticked(form, "checked");
    const kept = the.same(now, the.ticked(form, "defaultChecked"));
    return {
      name: kept ? "Default" : "Changed", was: kept ? "" : the.summary(form, now),
      pending: !answer || the.dirty(form),
    };
  }
  const value = shown(the, question);
  const name = !value ? "Open" : value === question.fallback ? "Default" : "Changed";
  return {
    name,
    was: name !== "Changed" ? "" :
      "was: " + (question.fallback ? label(the, question, question.fallback) : "open"),
    pending: Boolean(value) && (!answer || String(answer.choice) !== value || the.dirty(form)),
  };
}

function opened(the: Answering, question: Question): boolean {
  return standing(the, question).name === "Open";
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// Tell the form a pick moved it, as the reader's own pick would.
function moved(input: HTMLInputElement): void {
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

// Where the title bar ends, in the window, as the comments panel reads it.
function barBottom(): number {
  const bar = document.querySelector(".artifact-topbar");
  return bar ? Math.max(0, bar.getBoundingClientRect().bottom) : 0;
}

// Open a form's section if it is folded, as a row's "change" does, and put
// the form just below the title bar.
function place(form: HTMLFormElement): void {
  const wrapper = form.closest("div.artifact-section-body");
  if (wrapper && wrapper.hasAttribute("hidden")) {
    wrapper.dispatchEvent(new Event("beforematch"));
  }
  window.scrollBy({ top: form.getBoundingClientRect().top - barBottom() - 16, left: 0, behavior: "instant" });
}

// Place a form, then focus its first option, or its "change" (a
// dismissal's Undo) when it is folded to its answer.
function jump(form: HTMLFormElement): void {
  place(form);
  const target = form.classList.contains("artifact-decision--saved") ?
    form.querySelector<HTMLElement>(".artifact-decision-saved :is(.artifact-decision-change, " +
      ".artifact-decision-undo)") :
    form.querySelector<HTMLElement>("input");
  target?.focus({ preventScroll: true });
}

interface Group {
  // The heading's id, "" for the questions before the first h2.
  key: string;
  title: string;
  questions: Question[];
}

interface SheetProps {
  page: Page;
  the: Answering;
  questions: Question[];
  // One group per section asking a question, in page order, under its
  // title; a question before the first h2 is under the page's title.
  groups: Group[];
  marks: Map<HTMLElement, Marks>;
}

function Sheet({ page, the, questions, groups, marks }: SheetProps) {
  // Each change to the forms or their answers draws the sheet again.
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState("");
  // The question Next open jumped to last, by its data-question, so a swap
  // adding or taking away one before it keeps the reader's place.
  const [last, setLast] = useState("");
  const count = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const isOpen = useRef(open);
  isOpen.current = open;
  // The questions as last drawn, for a Save a swap redraws under.
  const asked = useRef(questions);
  asked.current = questions;

  function shut(refocus: boolean): void {
    if (!isOpen.current) {
      return;
    }
    isOpen.current = false;
    setOpen(false);
    if (refocus) {
      count.current?.focus();
    }
  }

  // Layout effects, so they run as the sheet is drawn, before the
  // ANSWERED listener that draws it returns. The forms bound are the ones
  // the sheet is drawn from: a swap unbinds those it took out.
  useLayoutEffect(() => {
    for (const { form } of questions) {
      form.addEventListener("change", redraw);
      form.addEventListener("input", redraw);
      form.addEventListener(page.events.saved, redraw);
    }
    return () => {
      for (const { form } of questions) {
        form.removeEventListener("change", redraw);
        form.removeEventListener("input", redraw);
        form.removeEventListener(page.events.saved, redraw);
      }
    };
  }, [questions]);

  useLayoutEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && isOpen.current && !event.defaultPrevented) {
        shut(true);
      }
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, []);

  useLayoutEffect(() => {
    if (open) {
      close.current?.focus();
    }
  }, [open]);

  const states = questions.map((question) => standing(the, question));
  const opens = states.filter((s) => s.name === "Open").length;
  const changed = states.filter((s) => s.name === "Changed").length;
  const due = states.filter((s) => s.pending).length;

  // The first open question after the last one jumped to, wrapping round;
  // from the top when that one is no longer asked.
  function upcoming(): number {
    const from = questions.findIndex((question) => question.form.dataset.question === last);
    for (let step = 1; step <= questions.length; step += 1) {
      const index = (from + step) % questions.length;
      if (opened(the, questions[index]!)) {
        return index;
      }
    }
    return -1;
  }

  const index = upcoming();
  const tally = opens ? `${opens} to answer` : "All answered";

  function next(event: Event): void {
    event.preventDefault();
    const at = upcoming();
    if (at >= 0) {
      setLast(questions[at]!.form.dataset.question ?? "");
      jump(questions[at]!.form);
    }
  }

  function respond(): void {
    if (isOpen.current) {
      shut(true);
      return;
    }
    isOpen.current = true;
    setOpen(true);
  }

  // Post each answer not stored, in page order, as its form's own Save
  // does; an open question has nothing to post, nor has one dismissed or
  // saved on its form while the earlier ones were posting. Each is posted
  // through the form the page asks it on at its turn: a swap may have put
  // in a new one, and one it took away or reworded is not posted.
  async function save(): Promise<void> {
    const pending = questions.filter((question) => standing(the, question).pending);
    setSaving(true);
    setOutcome("");
    let failed = 0;
    let tried = 0;
    try {
      for (const was of pending) {
        const question = asked.current.find((each) => each.form.dataset.question === was.form.dataset.question);
        if (!question || question.form.dataset.version !== was.form.dataset.version ||
          !standing(the, question).pending) {
          continue;
        }
        tried += 1;
        if (!question.checklist && !picked(question.form)) {
          const radio = radioOf(question, shown(the, question));
          if (radio) {
            radio.checked = true;
          }
        }
        if (!(await the.save(question.form))) {
          failed += 1;
        }
      }
    } finally {
      setSaving(false);
    }
    const left = asked.current.filter((question) => opened(the, question)).length;
    const stay = plural(left, "question stays", "questions stay") + " open.";
    const time = new Date().toLocaleTimeString(undefined, { timeStyle: "short" });
    if (failed === tried) {
      setOutcome("Nothing was saved: see each question's form. " + stay);
    } else {
      setOutcome(`Saved at ${time}. ${stay}` +
        (failed ? " " + plural(failed, "answer was", "answers were") + " not saved." : ""));
    }
  }

  // The open questions in each section that has marks.
  const counts = new Map<HTMLElement, number>();
  questions.forEach((question, at) => {
    if (question.heading) {
      counts.set(question.heading, (counts.get(question.heading) ?? 0) + (states[at]!.name === "Open" ? 1 : 0));
    }
  });

  function entry(question: Question) {
    const at = questions.indexOf(question);
    const s = states[at]!;
    const value = question.checklist ? "" : shown(the, question);
    return (
      <li key={question.form.dataset.question} class="artifact-review-entry" data-question={question.form.dataset.question}>
        <p class="artifact-review-question">
          {question.number ? <><span class="artifact-review-number">{question.number}</span>{" "}</> : null}
          {question.text}
        </p>
        <div class="artifact-review-options">
          {question.checklist ?
            boxes(question.form).map((box) => (
              <label key={box.value} class="artifact-review-item">
                <input type="checkbox" data-value={box.value} checked={box.checked} onChange={(event) => {
                  box.checked = event.currentTarget.checked;
                  moved(box);
                }} />
                {" "}{the.optionText(box)}
              </label>
            )) :
            radios(question.form).map((radio) => (
              <button key={radio.value} data-value={radio.value} class="artifact-review-option" type="button"
                aria-pressed={radio.value === value ? "true" : "false"}
                onClick={() => {
                  radio.checked = true;
                  moved(radio);
                }}>
                {the.optionText(radio)}
              </button>
            ))}
        </div>
        <p class="artifact-review-standing">
          <span class={`artifact-review-state artifact-review-state--${s.name.toLowerCase()}`}>{s.name}</span>
          <span class="artifact-review-was" hidden={!s.was}>{s.was || null}</span>
          <span class="artifact-review-unsaved" hidden={!s.pending}>not saved</span>
          <a class="artifact-review-show" href="#" onClick={(event) => {
            event.preventDefault();
            shut(false);
            jump(question.form);
          }}>Show on page</a>
        </p>
      </li>
    );
  }

  // With no question whose answers were read there is nothing to count,
  // but an open panel stays open, empty, its Close holding the focus.
  return (
    <>
      <a class="artifact-review-next" href="#" hidden={index < 0} onClick={next}>
        <span class="artifact-review-next-text">
          Next open
          <span class="artifact-review-next-question">{index < 0 ? null : ": " + questions[index]!.text}</span>
        </span>
        <span class="artifact-review-next-arrow" aria-hidden="true">↓</span>
      </a>
      <button ref={count} hidden={!questions.length} class={opens ? "artifact-review-count" : "artifact-review-count artifact-review-count--done"}
        type="button" aria-expanded={open ? "true" : "false"} aria-controls="artifact-review-panel" onClick={respond}>
        <span class="artifact-review-dot" aria-hidden="true" />
        <span>{tally} · Respond</span>
      </button>
      {Array.from(marks, ([heading, mark]) => {
        const n = counts.get(heading) ?? 0;
        return (
          <Fragment key={mark.key}>
            {createPortal(<span class="artifact-review-open" hidden={!n}>{n ? `${n} open` : null}</span>, mark.heading)}
            {mark.link ? createPortal(
              <span class="artifact-review-outline" hidden={!n}>
                <span class="artifact-review-dot" aria-hidden="true" />
                <span class="artifact-review-outline-number">{n ? String(n) : null}</span>
                <span class="artifact-review-hidden"> open</span>
              </span>, mark.link) : null}
          </Fragment>
        );
      })}
      {createPortal(
        <div class="artifact-review-panel" id="artifact-review-panel" role="dialog"
          aria-labelledby="artifact-review-tally" hidden={!open}>
          <header class="artifact-review-head">
            <p class="artifact-review-tally" id="artifact-review-tally">
              {`${tally} · ${changed} changed · ${questions.length} in all`}
            </p>
            <button ref={close} class="artifact-review-close" type="button" aria-label="Close"
              onClick={() => shut(true)}>✕</button>
          </header>
          <div class="artifact-review-list">
            {groups.map((group) => (
              <section key={group.key} class="artifact-review-group">
                <h3 class="artifact-review-group-title">{group.title}</h3>
                <ol class="artifact-review-entries">{group.questions.map(entry)}</ol>
              </section>
            ))}
          </div>
          <footer class="artifact-review-foot">
            <button class="artifact-review-save" type="button" disabled={saving || !due} onClick={save}>
              {saving ? "Saving…" : due ? "Save " + plural(due, "answer", "answers") : "Nothing new to save"}
            </button>
            <p class="artifact-review-outcome" role="status">{outcome || null}</p>
          </footer>
        </div>,
        document.body,
      )}
    </>
  );
}

// Each question in page order, under the nearest h2 before its form, and
// one group per h2 asking one.
function questionsOf(page: Page, the: Answering,
  asks: (form: HTMLFormElement) => boolean): { questions: Question[]; groups: Group[] } {
  const headings = all<HTMLElement>("h2", document.querySelector("section.artifact-body")!);
  const questions = page.forms.filter(asks).map((form): Question => {
    let heading: HTMLElement | null = null;
    for (const h2 of headings) {
      if (h2.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING) {
        heading = h2;
      }
    }
    const question: Question = {
      form, heading, checklist: the.isChecklist(form),
      text: words(form.querySelector(".artifact-decision-text")),
      number: words(form.querySelector(".artifact-decision-number")),
      fallback: "",
    };
    const fallback = form.dataset.default ?? "";
    question.fallback = radioOf(question, fallback) ? fallback : "";
    return question;
  });

  const groups = new Map<HTMLElement | null, Group>();
  for (const question of questions) {
    let group = groups.get(question.heading);
    if (!group) {
      group = {
        key: question.heading?.id ?? "",
        title: question.heading ? headingTitle(question.heading) :
          words(document.querySelector(".artifact-title")),
        questions: [],
      };
      groups.set(question.heading, group);
    }
    group.questions.push(question);
  }
  return { questions, groups: Array.from(groups.values()) };
}

// The marks drawn so far, for their keys.
let drawn = 0;

// The marks' containers, added to each h2 asking a question and to its
// outline link, so the fold code's heading is never drawn again. A heading
// kept from the last draw keeps its own; one that asks none now, or that a
// swap took out, loses them, and a link a swap brought in gets one.
function markUp(marks: Map<HTMLElement, Marks>, questions: Question[]): void {
  const outline = document.querySelector("ol.artifact-outline-list");
  const asking = new Set(questions.map((question) => question.heading));
  for (const [heading, mark] of marks) {
    if (!asking.has(heading) || !heading.isConnected) {
      mark.heading.remove();
      mark.link?.remove();
      marks.delete(heading);
    }
  }
  for (const heading of asking) {
    if (!heading) {
      continue;
    }
    let mark = marks.get(heading);
    if (!mark) {
      mark = { heading: heading.appendChild(document.createElement("span")), link: null, key: ++drawn };
      marks.set(heading, mark);
    }
    const link = outline && heading.id ?
      outline.querySelector(`a[href="#${CSS.escape(heading.id)}"]`) : null;
    if (mark.link?.parentElement !== link) {
      mark.link?.remove();
      mark.link = link ? link.appendChild(document.createElement("span")) : null;
      mark.key = ++drawn;
    }
  }
}

// Draw the sheet over the page's forms, once their answers are read: into
// tools, the same container each time, so Preact keeps the sheet's own
// state. The forms in read are those an earlier draw picked defaults on.
function draw(page: Page, the: Answering, tools: HTMLElement, marks: Map<HTMLElement, Marks>,
  read: WeakSet<HTMLFormElement>): void {
  // A form brought in by a swap whose read failed has no answer read: it
  // stays out of the sheet, so no default is picked or saved over one,
  // until a later read.
  const { questions, groups } = questionsOf(page, the, (form) => the.read || read.has(form));
  markUp(marks, questions);

  // A default picked once the answers are read, so the read never takes
  // the form for one the reader touched: for each form with no answer to
  // the question as the page now asks it, one to an earlier wording too.
  // A form an earlier draw read keeps what the reader left it at.
  for (const question of questions) {
    if (read.has(question.form)) {
      continue;
    }
    read.add(question.form);
    if (question.fallback && !the.saved(question.form) && !picked(question.form)) {
      const radio = radioOf(question, question.fallback)!;
      radio.checked = true;
      moved(radio);
    }
  }

  // The focus on an entry the draw takes out goes to the same control in
  // the question's entry, as one moved to another section has it, or to
  // Close for a question no longer asked.
  const panel = document.querySelector<HTMLElement>(".artifact-review-panel");
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const focused = active?.closest<HTMLElement>(".artifact-review-entry")?.dataset.question;
  render(<Sheet page={page} the={the} questions={questions} groups={groups} marks={marks} />, tools);
  if (focused === undefined || !panel || panel.hidden || document.activeElement === active) {
    return;
  }
  const entry = all<HTMLElement>(".artifact-review-entry", panel).find((each) => each.dataset.question === focused);
  const value = active!.dataset.value;
  const target = !entry ? panel.querySelector<HTMLElement>(".artifact-review-close") :
    value === undefined ? entry.querySelector<HTMLElement>(".artifact-review-show") :
    all<HTMLElement>("[data-value]", entry).find((each) => each.dataset.value === value) ??
      entry.querySelector<HTMLElement>("button, input");
  target?.focus({ preventScroll: true });
}

// Without the page's answers there is no telling what is answered: no
// sheet, so no default is picked or saved over an answer.
//
// #question=ID, a link from the index's Recent activity: once the answers
// are drawn, an answered form folded to its saved line, and again on each
// hashchange, the form asking ID has its section opened if it is folded
// and lands just under the title bar, as jump() places it, with or without
// the sheet. A question the page does not ask leaves the page where it is.
// A link followed before the answers are drawn is no reload's fragment,
// and one after waits for every other hashchange listener, such as the
// versions view's (js/versions.js), which may still hide the text.
export function reviewSheet(page: Page): void {
  const the = page.answering;
  if (!the || !page.forms.length) {
    return;
  }
  function toQuestion(first: boolean): void {
    const id = page.linkedTo("question", first);
    const form = page.forms.find((each) => each.dataset.question === id);
    if (form) {
      place(form);
    }
  }
  let drawnAnswers = false;
  let followed = false;
  window.addEventListener("hashchange", () => {
    followed = true;
    if (drawnAnswers) {
      setTimeout(() => toQuestion(false), 0);
    }
  });
  document.addEventListener(page.events.answered, () => {
    if (the.read) {
      sheet(page, the);
    }
    drawnAnswers = true;
    toQuestion(!followed);
  }, { once: true });
}

// The sheet's first draw, and once it is drawn, a draw again after each
// swap's read of the answers: never before it, so no default is picked
// over an answer not read yet.
function sheet(page: Page, the: Answering): void {
  const bar = document.querySelector(".artifact-topbar");
  if (!bar || !document.querySelector("section.artifact-body") || page.archived || !page.forms.length) {
    return;
  }
  const tools = bar.appendChild(document.createElement("div"));
  tools.className = "artifact-review-bar";
  const marks = new Map<HTMLElement, Marks>();
  const read = new WeakSet<HTMLFormElement>();
  draw(page, the, tools, marks, read);
  document.addEventListener(page.events.answered, () => draw(page, the, tools, marks, read));
}
